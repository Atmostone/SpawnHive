# Architecture

> Snapshot as of 2026-05-04. Any PR that changes components or data flows must update this file.

## Services (docker compose)

```
                     ┌──────────────────────────────────┐
                     │           frontend (Vite)        │ :3002
                     └──────────────┬───────────────────┘
                                    │ /api/* + /ws/* via vite proxy → nginx
                                    ▼
                     ┌──────────────────────────────────┐
                     │           nginx (LB)             │ :8001 → :8000
                     │  • REST: round-robin (DNS-resolved per request)
                     │  • WS:   sticky-ish (Upgrade headers, 1h timeout)
                     └──────────────┬───────────────────┘
                                    │ proxy → api:8000
                  ┌─────────────────┼─────────────────┐
                  ▼                 ▼                 ▼
            ┌───────────┐    ┌───────────┐    ┌───────────┐
            │  api-1    │    │  api-2    │ …  │  api-N    │  (replicas)
            │  FastAPI  │    │  FastAPI  │    │  FastAPI  │
            └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
                  └─────────────┬──┴────────────────┘
                                │
        ┌──────────────┐   ┌────▼─────┐   ┌─────────────┐
        │ orchestrator │   │ postgres │   │  scheduler  │
        │ (advisory    │   │   :5432  │   │ (advisory   │
        │  lock 8723451)│  └──────────┘   │ lock 8723452)│
        └──────┬───────┘   ┌──────────┐   └──────┬──────┘
               │ docker.sock│  qdrant  │          │
               │            │  :6333   │          │
        ┌──────▼─────────┐  └──────────┘   ┌──────────┐
        │ spawnhive-agent│  ┌──────────┐   │  redis   │ pubsub
        │  containers    │  │  minio   │   │  :6379   │  spawnhive.events
        │  (per task)    │  │  :9000   │   └──────────┘
        └────────────────┘  └──────────┘
```

WS fan-out across api replicas goes through Redis pub/sub (`spawnhive.events`); when `REDIS_URL` is unset the broadcast falls back to in-process delivery (single-replica mode).

api containers still mount `docker.sock` — they use the in-process `DockerRuntime`. This is the transitional workaround #13 until a `RemoteAgentRuntime` (RPC to orchestrator) lands; the call-site migration onto the `AgentRuntime` ABC is already done, what remains is the process split.

## Main flows

### Creating and running a task

```
user (UI) ──POST /api/tasks──▶ api
                                  │ insert tasks(status=backlog)
                                  ▼
user moves to ready ── PATCH ──▶ api ── insert agent_events ──▶ /ws/events
                                                                   │
                                                                   ▼
                            orchestrator_loop polls tasks ─── select template via LLM
                                  │ (decide_decomposition)
                                  │ (select_template_for_task)
                                  ▼
                            spawn_agent(template, env)
                                  │
                                  ▼
                       docker run spawnhive-agent
                            │  ENV: TASK_DESCRIPTION, AGENT_TOOLS, MCP_SERVERS,
                            │       AGENT_MEMORY_CONTEXT, OPENAI_API_KEY, …
                            │
                            ▼
                       agent: LLM tool loop
                            ├─▶ bash / file_read / file_write / search_knowledge
                            ├─▶ MCP servers (stdio subprocess)
                            └─▶ webhooks: progress (rate-limited 5s), completed, failed, aborted
                                  │
                                  ▼
                       POST /api/v1/agent-webhook/{task_id}
                            │ Pydantic AgentWebhookEvent (discriminated)
                            ▼
                       webhooks.py:
                            - log_event
                            - calc cost_usd
                            - upload files to MinIO
                            - LLM evaluate_agent_result
                            - status → review → awaiting_approval | retry | failed
                            - (memory_mode=structured) bg extract_memory(task_id)
                                  │
                                  ▼
                       user: approve/reject  → status=done/failed
```

### Bidirectional control

```
user / dashboard ──▶ POST /api/agents/{cid}/feedback
                          │
                          ▼
                 docker_manager.send_feedback ── httpx ──▶ http://<container_name>:8080/feedback
                                                                  │
                                                                  ▼
                                                       feedback_server queues a command
                                                                  │
                              agent.py loop ◀── drains the queue between tool_calls
                                   │
                                   ├─ feedback → injects a "user feedback" message
                                   ├─ switch_model → updates model/api_base/api_key
                                   └─ abort → exits the loop with event=aborted
```

### Memory pipeline (P0)

```
task.status → done (auto-review approved)
        │
        ▼
asyncio.create_task(extract_memory(task_id))
        │
        ▼
LLM extract_memory_facts(task_summary, result_summary)
        │
        ▼
For each entity:
    embed("type:name attrs") ──▶ Qdrant memory_entities collection
    cosine ≥ 0.92 with existing? ─▶ merge attrs (dedup)
                                   ─▶ else insert a new entity
For each relation: insert if both ends resolve.
        │
        ▼
log_event memory_extracted

       …later, when a new task is spawned…
        │
        ▼
build_memory_context(task.title + description):
    - find_relevant_entities (top-K=10, threshold=0.7)
    - 1-hop graph traversal
    - serialise into compact markdown ≤ 2000 tokens
    - inject as the AGENT_MEMORY_CONTEXT env var
```

## Backend components

| Module | Responsibility |
|--------|-----------------|
| `app/main.py` | FastAPI app, lifespan, seed_settings, seed_templates, audit middleware |
| `app/api/*` | REST + WS endpoints |
| `app/orchestrator/engine.py` | Polling loop, decomposition, template selection, spawn, timeout check |
| `app/orchestrator/llm.py` | LLM-powered orchestrator decisions + reasoning trail |
| `app/orchestrator/docker_manager.py` | Docker SDK wrapper: spawn/kill/list/health/feedback/abort/switch (low-level — go through `app.plugins.runtime`) |
| `app/plugins/runtime.py` | `AgentRuntime` ABC + `DockerRuntime` impl. Every call-site (engine, api/agents, api/chat, api/events, scheduler) goes through this. |
| `app/plugins/embeddings.py` | `EmbeddingProvider` ABC + `FastembedProvider`/`OpenAIEmbeddingProvider`/`SettingsDispatchProvider`. `fastembed`/`httpx` are imported ONLY inside the plugin |
| `app/plugins/llm.py` | `LLMProvider` ABC + `LiteLLMProvider`. Every `acompletion(...)` call goes through it |
| `app/plugins/secrets.py` | `SecretsProvider` ABC + `DBSecretsProvider`/`EnvSecretsProvider`. `llm_api_key` is read through it |
| `app/plugins/notifier.py` | `Notifier` ABC + `NoopNotifier` (default). `log_event` invokes `notify(...)` after broadcast |
| `app/memory/store.py` | Memory entities CRUD with embedding-based dedup |
| `app/memory/extractor.py` | LLM extraction of facts from task results |
| `app/knowledge/rag.py` | Document upload, chunking, embedding, Qdrant search; reset_collection |
| `app/scheduler.py` | APScheduler wrapper, jobs reload from DB |
| `app/utils/cost.py` | Token-usage → USD via the model_pricing setting |
| `app/utils/events.py` | log_event, broadcast to WS clients with filter matching |
| `app/schemas/webhooks.py` | Pydantic discriminated union for agent → orchestrator events |

## Agent components (container)

| File | What it does |
|------|--------------|
| `entrypoint.py` | Runs feedback_server alongside run_agent, sends the final webhook |
| `agent.py` | LLM tool-calling loop, MCP integration, periodic progress, control-queue drain |
| `feedback_server.py` | FastAPI on :8080 — health/feedback/switch_model/abort |
| `time_server.py` | Sample MCP server (used to verify the MCP integration) |

## Plugin layer (R5 + R6 wiring)

```
                ┌────────────────────────────────────────────────┐
                │              app.plugins.<*>                   │
                │  get_*_provider() singleton, env-driven select │
                └─────┬──────────┬──────────┬──────────┬─────────┘
                      │          │          │          │
                  LLMProvider EmbeddingProvider   AgentRuntime  Notifier
                      │          │          │          │
                LiteLLMProvider Fastembed/  DockerRuntime  Noop
                                OpenAI/Settings
                      │          │          │
                 (litellm)   (fastembed/    (docker SDK)
                              httpx)
                                            │
                                       SecretsProvider
                                            │
                                     DBSecretsProvider
                                       (settings table) | EnvSecretsProvider (env)
```

Production call-sites (as of 2026-05-04) all go through these plugins. The `LLM_PROVIDER`/`EMBEDDING_PROVIDER`/`AGENT_RUNTIME`/`NOTIFIER`/`SECRETS_PROVIDER` env vars pick the concrete implementation. Tests swap impls via `set_*_provider(impl|None)`.

## Database (as of 2026-05-04, post-R1)

15 tables + 9 migrations. Full field/invariant description — see `data-model.md` (TODO).

| Table | Why |
|-------|-----|
| `users` | (R1) User identity: email, password_hash, display_name |
| `workspaces` | (R1) Container for all data of one customer/project; slug is unique |
| `workspace_members` | (R1) Many-to-many user↔workspace + role (owner/admin/member/viewer) |
| `service_tokens` | (R1) Per-task agent tokens (kind=agent), verified by sha256(plain) |
| `tasks` | The core entity; lifecycle backlog → done. Fields: depends_on UUID[], cost_usd, model_used, workspace_id |
| `templates` | Agent roles. `model` nullable + provider_url/api_key for per-template routing |
| `template_versions` | Template versioning with rollback support (P14) |
| `agent_events` | Append-only event log; source for analytics + WS broadcast |
| `chat_messages` | Chat history with the orchestrator |
| `knowledge_documents` | RAG document metadata (files in MinIO, chunks in Qdrant) |
| `settings` | Runtime config (LLM, embedding, pricing, memory_mode, …) — global |
| `memory_entities` | Structured memory — nodes (P0); workspace-scoped |
| `memory_relations` | Structured memory — edges (P0); workspace-scoped |
| `scheduled_jobs` | APScheduler persistent storage (P8); workspace-scoped (built-in jobs live in the default workspace) |

After R1 every table except `users`/`workspaces`/`workspace_members`/`settings` has a NOT NULL `workspace_id` with an FK to `workspaces.id ON DELETE CASCADE`. Old rows are backfilled by the `c9d0e1f2a3b4_users_workspaces_scoping` migration — every NULL → the default workspace `00000000-0000-0000-0000-000000000002` (admin@local).

## Authentication and authorisation (R1)

```
   POST /api/auth/register {email,password,display_name}
   POST /api/auth/login    {email,password}            ──▶ {access_token, default_workspace_id, user, …}
                                                             access_token = JWT(HS256, ttl=24h, sub=user_id, ws=default_workspace_id)

   Authenticated request:
     Authorization: Bearer <jwt>
     X-Workspace-Id: <uuid>            (optional; falls back to JWT.ws or first membership)

   FastAPI deps:
     get_current_user           — validates the JWT, loads User
     get_current_workspace      — resolves workspace + checks membership; writes request.state.workspace
     require_role(*allowed)     — for admin-only handlers (settings PATCH, test-llm, export-all, kill-all, …)

   WebSocket auth:
     /ws/events?token=<jwt>&workspace_id=<uuid>
     /ws/chat?token=<jwt>&workspace_id=<uuid>
     /ws/agents/{cid}?token=<jwt>&workspace_id=<uuid>
     On failure the connection is closed with code 4401 / 4404.

   Agent token:
     Before spawn_agent the orchestrator issues a per-task token (kind=agent) and stores its sha256.
     The plaintext goes to the container via the SPAWNHIVE_AGENT_TOKEN env var.
     The agent uses it in Authorization for /api/knowledge/search and (post-R2) for /api/v1/agent-webhook.
```

### Agent isolation

`docker_manager.spawn_agent` sets the labels:
- `spawnhive.task_id`, `spawnhive.template_id`, `spawnhive.template_name`
- `spawnhive.workspace_id` — the real workspace UUID (post-R1; previously it was `shared`).

`list_agents(workspace_id)` / `kill_agent(... workspace_id)` / `kill_all_agents(workspace_id)` filter by that label. Cross-workspace `kill-all` is not allowed.

## Known architectural limitations

See `workarounds.md` (migrated from the legacy root `WORKAROUNDS.md`) and `production-readiness-tz.md`.
