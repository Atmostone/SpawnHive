# API

> As of 2026-05-04 (R1 + R2 + R6) — 50+ paths in OpenAPI. Source of truth — `/openapi.json` from the live API. This file is a topical map.

## Auth & multi-tenancy (R1)

After R1, every REST endpoint (except `/api/auth/*`, `/api/health`, `/api/v1/agent-webhook/*`, `/api/agent-webhook/*`) requires:

```
Authorization: Bearer <jwt>
X-Workspace-Id: <uuid>          # optional; falls back to the `ws` claim from the JWT
```

WebSocket endpoints (`/ws/events`, `/ws/chat`, `/ws/agents/{cid}`) accept auth via query string: `?token=<jwt>&workspace_id=<uuid>`. Invalid auth closes the socket with code 4401.

`/api/knowledge/search` is special: it accepts either a user JWT (regular CRUD style), or an agent service token (`Authorization: Bearer $SPAWNHIVE_AGENT_TOKEN`) plus `task_id` in the body — the workspace is then resolved from the task.

### Auth endpoints

| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| POST  | `/api/auth/register` | `{email,password,display_name?}` | `{access_token, token_type, expires_in, user, default_workspace_id}` |
| POST  | `/api/auth/login` | `{email,password}` | same shape |
| GET   | `/api/auth/me` | — | `{user, workspaces:[{id,name,slug,role}]}` |

Token: HS256, ttl=24h, payload `{sub: user_id, ws: default_workspace_id, iat, exp}`. Secret is read from env `JWT_SECRET`. On register, a personal workspace is created (slug derived from `display_name`, with a numeric suffix on collision) and the default workspace's templates are copied over.

### Role-aware endpoints

`require_role("owner","admin")` is enforced on:
- `PATCH /api/settings`
- `POST /api/settings/test-llm`
- `GET /api/settings/export-all`
- `POST /api/agents/{cid}/kill`, `/abort`, `/switch_model`
- `POST /api/agents/kill-all`
- `DELETE /api/templates/{id}`, `POST /api/templates/{id}/rollback/{v}`
- `DELETE /api/knowledge/documents/{id}`, `POST /api/knowledge/reset`, `PUT /api/knowledge/rules`
- `DELETE /api/scheduled-jobs/{id}`

`require_role("owner","admin","member")` (mutating, non-destructive):
- `POST /api/templates`, `PUT /api/templates/{id}`
- `POST /api/agents/{cid}/feedback`
- `POST /api/knowledge/documents`, `PUT /api/knowledge/memory`
- `POST /api/scheduled-jobs`, `PATCH /api/scheduled-jobs/{id}`

## Conventions

- All REST is under `/api/`. WS is under `/ws/`.
- Returns: JSON (REST) or JSON messages (WS).
- Time — ISO-8601, UTC.
- 200 — success; 201 — created; 204 — no content; 400 — bad request; 401 — auth; 403 — forbidden (role gate); 404 — not found; 422 — validation; 502 — agent unreachable.

## Endpoint groups

### Tasks (`/api/tasks`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks?status=&parent_id=` | List tasks |
| POST | `/api/tasks` | Create a task in backlog |
| GET | `/api/tasks/{id}` | Single task + subtasks |
| PATCH | `/api/tasks/{id}` | title/description/status/priority |
| PATCH | `/api/tasks/{id}/approve` | From `awaiting_approval` → `done` |
| PATCH | `/api/tasks/{id}/reject` | Body `{feedback}`; sets `ready`, bumps `retry_count` |
| DELETE | `/api/tasks/{id}` | Delete the task |
| GET | `/api/tasks/{id}/decomposition` | Tree + per-attempt timeline for a parent task. Returns `{parent, subtasks: [{id, title, template_name, status, retry_count, max_retries, depends_on, started_at, completed_at, cost_usd, result_files_count, attempts: [{agent_container_id, spawned_at, finished_at, outcome, error}]}]}`. Attempts are grouped by `agent_container_id` from `agent_events` (`agent_spawned`/`agent_completed`/`agent_failed`/`agent_aborted`); outcome is the last terminal event or `running` if only spawned. Used by the Decomposition view (`/graph` → Decomposition tab). |

### Templates (`/api/templates`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/templates` | List |
| POST | `/api/templates` | Create. Fields: name/description/soul_md/model/provider_url/provider_api_key/tools/mcp_servers/limits/tags |
| GET | `/api/templates/{id}` | Single (api_key is masked as `***`) |
| PUT | `/api/templates/{id}` | Update (creates a version snapshot before applying changes) |
| DELETE | `/api/templates/{id}` | |
| GET | `/api/templates/{id}/versions` | List versions |
| GET | `/api/templates/{id}/versions/{v}` | Snapshot v |
| POST | `/api/templates/{id}/rollback/{v}` | Apply snapshot v as the current state (creates two new versions: pre-rollback + post-rollback) |

### Agents (`/api/agents`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List active containers |
| GET | `/api/agents/{cid}` | Stats |
| POST | `/api/agents/{cid}/kill` | |
| POST | `/api/agents/kill-all` | Kill switch |
| GET | `/api/agents/{cid}/health` | Forwarded from the agent's `:8080/health` (uptime/iteration/tokens) |
| POST | `/api/agents/{cid}/feedback` | Body `{message}` → injected as a user message into the agent loop |
| POST | `/api/agents/{cid}/switch_model` | Body `{model?, base_url?, api_key?}` |
| POST | `/api/agents/{cid}/abort` | Body `{reason}` → the agent finishes its loop with `event=aborted` |

### Webhooks (`/api/v1/agent-webhook`, legacy `/api/agent-webhook`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/agent-webhook/{task_id}` | Canonical. Pydantic validation (see `webhooks.md`). 422 on invalid event/data. Requires `Authorization: Bearer $SPAWNHIVE_AGENT_TOKEN` and `idempotency_key`. |
| POST | `/api/agent-webhook/{task_id}` | Legacy alias. Adds `Sunset: Sat, 01 Aug 2026 00:00:00 GMT`, `Deprecation: true`, `Link: rel="successor-version"` headers (even on 401/422 responses). |

### Events (`/api/events`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events?task_id=&event_type=&source=&agent_container_id=&from_dt=&to_dt=&limit=&offset=` | Append-only log. `agent_container_id` filter narrows to a single agent (added for live agent-card and graph history-replay). |
| GET | `/api/events/export/{task_id}` | JSON download covering the entire task lifecycle |
| WS | `/ws/events` | Real-time. The client sends JSON `{task_id?, source?, event_type?, agent_container_id?}` to set filters. |
| WS | `/ws/agents/{container_id}` | Events for a single container only (P12) |

### Agent terminal logs (`/api/v1/agent-log`, `/api/tasks/{id}/log`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/agent-log/{task_id}` | Agent → orchestrator chunk ingest. Bearer agent_token + idempotency. Body: `{chunk_seq, content (≤256 KB), tool_name?, idempotency_key}`. Returns `{status: ok\|duplicate, chunk_seq}`. Auto-remap of chunk_seq on retry collision. |
| GET | `/api/tasks/{task_id}/log?from_seq=&limit=` | Workspace-scoped paginated log. Branches by `tasks.log_archive_s3_path`: live → DB chunks; archived → MinIO blob. Returns `{archived, archive_path, chunks: [{id, chunk_seq, content, tool_name, created_at}]}`. |
| WS | `/ws/tasks/{task_id}/log` | Live broadcast of new chunks. Filter `_kind=log_chunk`; payload mirrors GET-chunk shape with wire `type: "log_chunk"`. |

### Chat (`/api/chat`, `/ws/chat`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chat/history?limit=` | |
| WS | `/ws/chat` | Streaming. Slash commands (`/help`, `/status`, `/spawn …`, `/kill …`, `/templates`, `/tasks`, `/board`) are handled without an LLM; otherwise the request goes to the LLM with CHAT_TOOLS (`create_task` / `update_memory` / `search_knowledge`). |

### Knowledge (`/api/knowledge`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge/rules`, `/memory` | content of rules.md / memory.md |
| PUT | `/api/knowledge/rules`, `/memory` | replace content |
| GET | `/api/knowledge/documents` | List |
| POST | `/api/knowledge/documents` | multipart upload (.pdf/.docx/.md/.txt) |
| DELETE | `/api/knowledge/documents/{id}` | |
| POST | `/api/knowledge/search` | body `{query, limit}` |
| POST | `/api/knowledge/reset` | drop Qdrant collections (docs + memory_entities) + delete docs/entities |

### Memory (`/api/memory`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memory/entities?type=&search=&limit=` | List entities |
| GET | `/api/memory/entities/{id}` | Detail + relations |
| POST | `/api/memory/entities` | Create (with dedup ≥ 0.92) |
| PATCH | `/api/memory/entities/{id}` | Update fields |
| DELETE | `/api/memory/entities/{id}` | |
| GET | `/api/memory/relations?from_id=&to_id=` | List |
| POST | `/api/memory/relations` | |
| DELETE | `/api/memory/relations/{id}` | |
| POST | `/api/memory/extract?task_id=` | Manually trigger LLM extraction for an existing task |

### Analytics (`/api/analytics`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/templates?period=day\|week\|month\|all&from_dt=&to_dt=` | Per-template aggregates |
| GET | `/api/analytics/timeline?days=` | Daily roll-up |
| GET | `/api/analytics/models?period=` | Per-model |

### Scheduled jobs (`/api/scheduled-jobs`)

| Method | Path | |
|--------|------|--|
| GET | `/api/scheduled-jobs` | List |
| POST | `/api/scheduled-jobs` | Create. Body: `{name, kind, cron_expr?, interval_seconds?, fire_at?, payload, enabled}` |
| PATCH | `/api/scheduled-jobs/{id}` | |
| DELETE | `/api/scheduled-jobs/{id}` | |

### Settings (`/api/settings`)

| Method | Path | |
|--------|------|--|
| GET | `/api/settings` | All keys → JSONB values |
| PATCH | `/api/settings` | Body — partial dict. Known keys: `llm_*`, `embedding_*`, `max_concurrent_agents`, `task_timeout_minutes`, `max_retries`, `memory_mode` (`flat`\|`structured`), `decomposition_enabled` (bool, default `true`) |
| GET | `/api/settings/health` | Alias for `/api/health` (per spec §4.7) |
| POST | `/api/settings/test-llm` | Probe the LLM configuration |
| GET | `/api/settings/export-all` | ZIP containing tasks/templates/events/settings/rules.md/memory.md/documents.json (capped at 10k events) |

### Health

| Method | Path | |
|--------|------|--|
| GET | `/api/health` | postgres/qdrant/minio liveness |

## Future evolution

See `production-readiness-tz.md`. In short:
- All endpoints will be reached primarily under `/api/v1/`.
- Auth: `/api/v1/auth/{register,login,refresh,me}`.
- Workspace: `X-Workspace-Id` header, scoping for every resource.
