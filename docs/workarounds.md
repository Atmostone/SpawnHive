# Workarounds

> This file tracks deliberate shortcuts — things that are **not** "the right thing", but acceptable at the current stage. Each entry has a reason and an exit criterion. Remove the entry once it's resolved.

The legacy root `WORKAROUNDS.md` was migrated here.

## 1. MinIO settings — read-only in the UI

**What:** in the Settings UI, the `minio_endpoint/access_key/secret_key/bucket` fields are disabled with a "set via .env, restart required" hint.

**Why:** `app/config.py:Settings` (BaseSettings) reads MinIO config from env vars, not the DB. Switching at runtime would require refactoring `get_minio_client()` to read from the DB plus invalidating, at minimum, every active upload.

**Exit:** R3 or earlier, if anyone needs to swap MinIO without a restart.

## 2. RAG search inside the agent — via httpx, not MCP

**What:** the agent calls `search_knowledge_base` directly with `httpx.post('http://api:8000/api/knowledge/search')` instead of going through an MCP server.

**Why:** the original spec §6.3 assumed an MCP wrapper. For the MVP that's an extra layer — we don't need a stdio MCP server in every container for a single built-in feature.

**Exit:** if RAG ever becomes externalised or we need multiple knowledge sources with different semantics — wrap it in MCP.

## 3. test-llm with max_tokens=5

**What:** `POST /api/settings/test-llm` sends a "ping" prompt with `max_tokens=5`. It does not validate tool-calling, structured output, etc.

**Why:** cheap, fast, catches 90% of issues (auth/url/network).

**Exit:** if a deeper diagnosis (rate limits, function-calling support) becomes needed — add a separate endpoint instead of replacing test-llm.

## 4. /api/settings/export-all capped at 10k events

**What:** the ZIP only includes the most recent 10000 events (by created_at desc).

**Why:** with a long history the file becomes hundreds of MB and is held in memory (BytesIO).

**Exit:** once a retention policy is in place (see R3 in production-readiness-tz) — old events get cleaned up, the cap can be lifted.

## 5. provider_api_key plaintext in DB (P4) — partially closed in R6

**What:** `templates.provider_api_key` is stored as a plain string.

**Why:** it's a column-level secret, not a key/value pair. The current `SecretsProvider` is optimised for key/value access (`get(db, key, default)` calls).

**Closed in R6:** `llm_api_key` is now read through `get_secrets_provider().get(db, "llm_api_key")` in `get_llm_settings` and `test_llm`. `EnvSecretsProvider` (selected via `SECRETS_PROVIDER=env`) immediately gives a vault-like read from environment variables.

**Full exit:** move `templates.provider_api_key` and `minio_secret_key` behind the same facade. Becomes useful when a SOPS/Vault impl appears.

## 6. workspace_id="shared" label on the container (P11) — RESOLVED in R1

**Done:** R1 `spawn_agent` sets `spawnhive.workspace_id=<uuid>`; `list_agents/kill_*` filter on it.

## 7. Audit middleware writes without user_id (P10) — RESOLVED in R1

**Done:** R1 middleware reads `request.state.user` and writes user_id/email into the event `data`.

## 8. Webhook without auth — RESOLVED in R2

**Done:** R2 — `/api/v1/agent-webhook` requires `Authorization: Bearer <SPAWNHIVE_AGENT_TOKEN>` + `idempotency_key`. The legacy `/api/agent-webhook` is kept as an alias with `Sunset: 2026-08-01` headers and the same requirements.

## 9. Orchestrator/scheduler inside the API lifespan — RESOLVED in R3

**Done:** R3 — orchestrator/scheduler are separate docker-compose services (`app/workers/orchestrator_main.py` / `scheduler_main.py`), each holding a Postgres advisory lock. The API lifespan no longer spawns them.

## 13. api container still mounts docker.sock — partially closed in R6

**What:** every call-site (`app/api/agents.py`, `app/api/chat.py`, `app/api/events.py`, `app/orchestrator/engine.py`, `app/scheduler.py`) now goes through `get_agent_runtime()`. But the default `DockerRuntime` is an in-process impl that hits the Docker SDK directly via `app.orchestrator.docker_manager.*`. So the api container *still* mounts `/var/run/docker.sock`.

**Closed:** direct `from app.orchestrator.docker_manager import …` lines disappeared from every call-site; the only remaining direct import is `effective_llm_config` (a pure config function, not a Docker call). Swapping the runtime via env (`AGENT_RUNTIME=...`) genuinely swaps everything.

**Remaining:** write a `RemoteAgentRuntime` impl that talks RPC to the orchestrator (a separate service). After that, the api volume with docker.sock can go away entirely. Tracked separately.

**Risk:** with `--scale api=N`, every replica still has docker.sock access. Real safety only lands once `RemoteAgentRuntime` is in place and the volume is removed from compose.

## 11. /api/knowledge/search dual authentication

**What:** the endpoint accepts either a user JWT + `X-Workspace-Id`, or an agent service token + `task_id` in the body. The workspace is resolved via the task.

**Why:** the agent calls `search` from inside its container and has no user JWT. A unified model is part of R2 + R5 (treating `agent_token` as a scoped service identity).

**Exit:** R5 — a unified interface through `SecretsProvider` / the identity layer.

## 12. Bcrypt 72-byte truncation

**What:** `app/auth/security.py` truncates the password to 72 bytes (UTF-8) before calling `bcrypt.hashpw`.

**Why:** bcrypt v5 raises `ValueError` for passwords > 72 bytes. The phase-out is argon2id or scrypt.

**Exit:** R5 — `SecretsProvider` will define the canonical password hashing.

## 10. Agent bash tool without a sandbox

**What:** the built-in bash tool runs arbitrary commands via `subprocess.run` inside the container.

**Why:** the container is itself a sandbox. Tightening it further (read-only rootfs, no-new-privileges, drop caps) is a separate security task and does not block the MVP.

**Exit:** part of the security-hardening track (after R1–R5).
