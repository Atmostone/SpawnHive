# Data Model

> Schema snapshot as of 2026-05-04 (after migration `d0e1f2a3b4c5`).
> Whenever the model changes, update this file in the same PR.

## Migrations

Revision chain:

```
819cd4ea6d24  initial_schema
     ↓
a1b2c3d4e5f6  rename_skills_to_tools
     ↓
b2c3d4e5f6a7  memory_entities + memory_relations (P0)
     ↓
c3d4e5f6a7b8  per_template_model: templates.model nullable, provider_url/api_key, tasks.model_used (P4)
     ↓
d4e5f6a7b8c9  tasks.cost_usd (P5)
     ↓
e5f6a7b8c9d0  scheduled_jobs (P8)
     ↓
f6a7b8c9d0e1  tasks.depends_on UUID[] (P9)
     ↓
a7b8c9d0e1f2  workspace_id columns (P11)
     ↓
b8c9d0e1f2a3  template_versions (P14)
     ↓
c9d0e1f2a3b4  users + workspaces + workspace_members + service_tokens; NOT NULL workspace_id everywhere (R1)
     ↓
d0e1f2a3b4c5  webhook_deliveries (R2)
     ↓
e1f2a3b4c5d6  agent_log_chunks + agent_log_deliveries + tasks.log_archive_s3_path
```

## Tables

### tasks

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| id | UUID PK | uuid4 | |
| parent_id | UUID FK→tasks.id | NULL | for decomposition |
| title | VARCHAR(500) | required | |
| description | TEXT | NULL | |
| status | VARCHAR(50) | 'backlog' | TaskStatus enum |
| priority | VARCHAR(20) | 'medium' | TaskPriority enum |
| template_id | UUID FK→templates.id | NULL | chosen by the orchestrator |
| agent_container_id | VARCHAR(255) | NULL | active container; cleared on kill |
| result_summary | TEXT | NULL | from the agent (event=completed) |
| result_files | JSONB | [] | list of MinIO paths |
| token_usage | JSONB | {} | `{input_tokens, output_tokens}` |
| retry_count / max_retries | int | 0 / 1 | |
| user_feedback | TEXT | NULL | on reject |
| orchestrator_feedback | TEXT | NULL | from auto-review |
| model_used | VARCHAR(255) | NULL | which model was actually used (P4) |
| cost_usd | NUMERIC(10,6) | 0 | computed cost (P5) |
| depends_on | UUID[] | {} | ids of dependency tasks (P9) |
| workspace_id | UUID NOT NULL | | scoping (post-R1, FK CASCADE) |
| created_at / updated_at / started_at / completed_at | TIMESTAMP | now() / onupdate | |

Indexes: `status`, `parent_id`, `workspace_id`.

### templates

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| id | UUID PK | uuid4 | |
| name / description / soul_md | string/text | required | |
| model | VARCHAR(255) | NULL | nullable after P4 — empty means "inherit global" |
| provider_url / provider_api_key | VARCHAR(500) | NULL | per-template override (P4) |
| tools | JSONB | [] | list of built-in tools |
| mcp_servers | JSONB | [] | list of `{name, command, args, env}` |
| max_ram / max_cpu / timeout_minutes | string/int | "2g" / 100000 / 60 | docker limits |
| tags | TEXT[] | {} | |
| workspace_id | UUID NOT NULL | | (post-R1) |
| created_at / updated_at | TIMESTAMP | now() / onupdate | |

### template_versions (P14)

A snapshot is taken before every PUT, enabling rollback.

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| template_id | UUID FK→templates.id ON DELETE CASCADE | |
| version | int | UNIQUE (template_id, version) |
| snapshot | JSONB | full Template copy at snapshot time |
| commit_message | TEXT | auto-generated ("auto: pre-update", "rollback to v1") |
| created_by | VARCHAR(50) | "user" |
| created_at | TIMESTAMP | now() |

### agent_events

Append-only event log. Source of truth for analytics and WS broadcast.

| Column | Type | |
|--------|------|--|
| id | BIGINT PK auto | |
| task_id | UUID FK→tasks.id NULL | |
| agent_container_id | VARCHAR(255) NULL | |
| event_type | VARCHAR(50) | see the catalogue below |
| source | VARCHAR(50) | 'agent' / 'orchestrator' / 'user' / 'system' |
| data | JSONB | arbitrary payload |
| workspace_id | UUID NOT NULL | (post-R1) |
| created_at | TIMESTAMP | now() |

Indexes: `created_at`, `task_id`, `event_type`, `workspace_id`.

**Known event_type values** (extensible):
`task_created`, `task_status_changed`, `orchestrator_decision`, `orchestrator_reasoning`,
`orchestrator_feedback`, `agent_spawned`, `agent_message`, `agent_progress`, `agent_completed`,
`agent_failed`, `agent_aborted`, `agent_killed`, `agent_health`, `agent_feedback_sent`,
`agent_abort_signaled`, `agent_model_switched`, `task_retry`, `task_timeout`,
`memory_updated`, `memory_extracted`, `webhook_received`, `webhook_validation_failed`,
`scheduled_job_fired`, `daily_cost_summary`, `kill_all_agents`, `user_action`,
`decomposition_failed_cycle`.

### chat_messages

| Column | Type | |
|--------|------|--|
| id | BIGINT PK auto | |
| role | VARCHAR(20) | 'user' / 'assistant' / 'tool' |
| content | TEXT | |
| related_task_id | UUID FK→tasks.id NULL | |
| token_usage | JSONB | |
| workspace_id | UUID NOT NULL | (post-R1) |
| created_at | TIMESTAMP | now() |

### knowledge_documents

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| filename | VARCHAR(500) | |
| s3_path | VARCHAR(1000) | path inside the MinIO bucket `spawnhive` |
| chunk_count | int | how many chunks landed in Qdrant |
| workspace_id | UUID NOT NULL | (post-R1) |
| created_at | TIMESTAMP | |

The matching chunks live in the Qdrant collection `spawnhive_docs`.

### memory_entities (P0)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| type | VARCHAR(50) | "person" / "project" / "decision" / any extensible value |
| name | VARCHAR(500) | |
| attributes | JSONB | arbitrary scalar key-values |
| embedding_id | UUID NULL | == id, link into the Qdrant `memory_entities` collection |
| created_by | VARCHAR(50) | 'orchestrator' / 'user' / 'agent' |
| workspace_id | UUID NOT NULL | (post-R1) |
| created_at / updated_at | TIMESTAMP | |

Indexes: `type`, `name`, `workspace_id`.
Qdrant: collection `memory_entities` (dim derived from the active embedding provider).

### memory_relations (P0)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| from_id / to_id | UUID FK→memory_entities ON DELETE CASCADE | |
| relation_type | VARCHAR(100) | free-form |
| attributes | JSONB | |
| workspace_id | UUID NOT NULL | (post-R1) |
| created_at | TIMESTAMP | |

Indexes: `from_id`, `to_id`, `workspace_id`.

### settings

| Column | Type | |
|--------|------|--|
| key | VARCHAR(255) PK | |
| value | JSONB | arbitrary |
| updated_at | TIMESTAMP | |

**Seeded keys** (seed_settings):
`llm_base_url`, `llm_api_key`, `llm_model`,
`max_concurrent_agents` (3), `task_timeout_minutes` (60), `max_retries` (1),
`embedding_provider` ('fastembed'), `embedding_model_local` ('BAAI/bge-small-en-v1.5'),
`embedding_api_url`, `embedding_api_key`, `embedding_model_api`,
`minio_endpoint`, `minio_access_key`, `minio_secret_key`,
`memory_mode` ('flat' | 'structured', default 'flat'),
`model_pricing` ({}, shape `{model: {input_per_1m_usd, output_per_1m_usd}}`).

### scheduled_jobs (P8)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| name | VARCHAR(200) | |
| kind | VARCHAR(20) | 'cron' / 'interval' / 'once' |
| cron_expr | VARCHAR(200) NULL | for kind=cron |
| interval_seconds | int NULL | for kind=interval |
| fire_at | TIMESTAMP NULL | for kind=once |
| payload | JSONB | `{action: ..., ...}` |
| enabled | BOOL | default true |
| last_fired_at | TIMESTAMP NULL | |
| workspace_id | UUID NOT NULL | (post-R1) |
| created_at | TIMESTAMP | |

Index: `enabled`.

**Built-in jobs** (seed_default_jobs in `app/scheduler.py`):
- `daily_cost_rollup` — cron `0 0 * * *`, action `daily_cost_rollup`.
- `agent_progress_check` — interval 60s, action `agent_progress_check`.

### users (R1)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| email | VARCHAR(320) UNIQUE | |
| password_hash | VARCHAR(255) NULL | bcrypt; NULL for the seeded admin@local until first login |
| display_name | VARCHAR(200) NULL | |
| is_active | BOOL | default true |
| created_at | TIMESTAMP | |

### workspaces (R1)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| name | VARCHAR(200) | |
| slug | VARCHAR(120) UNIQUE | URL-safe identifier |
| created_by | UUID FK→users.id | |
| created_at | TIMESTAMP | |

### workspace_members (R1)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| user_id | UUID FK→users.id ON DELETE CASCADE | |
| workspace_id | UUID FK→workspaces.id ON DELETE CASCADE | |
| role | VARCHAR(20) | 'owner' / 'admin' / 'member' / 'viewer' |
| created_at | TIMESTAMP | |

Unique: `(user_id, workspace_id)`.

### service_tokens (R1)

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| kind | VARCHAR(20) | 'agent' for the per-task agent token |
| token_hash | VARCHAR(128) | sha256 hex of the plaintext |
| task_id | UUID FK→tasks.id ON DELETE CASCADE | |
| workspace_id | UUID FK→workspaces.id ON DELETE CASCADE | |
| expires_at | TIMESTAMP | naive UTC |
| created_at | TIMESTAMP | |

### webhook_deliveries (R2)

Stores the `(task_id, idempotency_key)` pairs that have already been processed; lets a replay return `{"status":"duplicate"}` cleanly.

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| task_id | UUID FK→tasks.id ON DELETE CASCADE | |
| event_type | VARCHAR(50) | |
| idempotency_key | VARCHAR(80) | |
| received_at | TIMESTAMP | |

Unique: `(task_id, idempotency_key)`.

### agent_log_chunks (Foundations Этап 1)

Append-only stream of full agent stdout/stderr per tool call. Replaces the 500-char `recent_output` ticker for browseable history.

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| task_id | UUID FK→tasks.id ON DELETE CASCADE | |
| workspace_id | UUID FK→workspaces.id ON DELETE CASCADE | |
| chunk_seq | int | per-task monotonically increasing, UNIQUE `(task_id, chunk_seq)` |
| content | TEXT | ≤256 KB per row (Pydantic-enforced) |
| tool_name | VARCHAR(255) NULL | bash / file_read / mcp tool name |
| created_at | TIMESTAMP | |

Indexes: `(task_id, chunk_seq)`, `workspace_id`. After event=completed/failed/aborted the orchestrator concatenates rows → MinIO blob `s3://spawnhive/logs/<task_id>.log`, sets `tasks.log_archive_s3_path`, and DELETEs all chunks (best-effort, atomic).

### agent_log_deliveries (Foundations Этап 1)

Per-chunk idempotency table. Mirror of `webhook_deliveries`.

| Column | Type | |
|--------|------|--|
| id | UUID PK | |
| task_id | UUID FK→tasks.id ON DELETE CASCADE | |
| idempotency_key | VARCHAR(64) | |
| received_at | TIMESTAMP | |

Unique: `(task_id, idempotency_key)`.

### tasks.log_archive_s3_path (Foundations Этап 2)

Added to `tasks`: `VARCHAR(500) NULL`. NULL while task is active or never had any chunks; populated to `logs/<task_id>.log` after compaction. GET `/api/tasks/{id}/log` branches on this column.

## Invariants

- `tasks.status` ∈ {backlog, ready, decomposing, in_progress, review, awaiting_approval, done, failed}.
- `tasks.priority` ∈ {low, medium, high, urgent}.
- During decomposition: parent → in_progress, children are created with status=ready (or with `depends_on` filled in).
- `agent_events` is append-only — rows are never modified.
- `template_versions.version` grows monotonically per template; rollback creates a **new** version from the old one, never overwrites.
- `memory_entities.embedding_id` ≡ `id` after a successful Qdrant upsert. It may be NULL when Qdrant was unavailable at creation time.
- After R1, every workspace-scoped table has a NOT NULL `workspace_id` with FK CASCADE — deleting a workspace deletes everything inside.
