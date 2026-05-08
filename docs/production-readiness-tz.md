# ТЗ: Production / Open-Source Readiness

**Статус:** черновик принят 2026-05-03. Исполнение — до старта работ из `BACKLOG.md`.

**Прогресс:** R1 ✅ (2026-05-03) · R2 ✅ (2026-05-03) · R3 ✅ (2026-05-03) · R4 ✅ (2026-05-03, 22/22 pass, coverage 41% — критичные пути закрыты, добивка до 60% — отдельный трек) · R5 ✅ (2026-05-03, 5 ABC + impl, LLM call-sites переведены, остальное — incremental)

**Контекст:** к моменту написания этого документа закрыты все 15 блоков `PRE-BACKLOG.md` (P0–P14). Проект функционально соответствует MVP+, но архитектурно сырой для публичного развёртывания и open-source. Этот документ — фиксирует, что именно надо привести в порядок, прежде чем брать фичи из основного `BACKLOG.md`.

**Принцип отбора:** в этот документ попадает только то, что:
1. дешевле сделать сейчас, чем рефакторить потом, ИЛИ
2. блокирует публичное развёртывание (security/auth), ИЛИ
3. блокирует горизонтальное масштабирование на этапе фичей.

Эстетика, документация, удобство — не сюда.

---

## Порядок исполнения

Линейный: **R1 → R2 → R3 → R4 → R5**.

Между блоками: коммит, прогон `/tmp/e2e.sh` (актуализированный), запись в CHANGELOG.

После R1–R5 — открыто работать с `BACKLOG.md` без архитектурных переделок.

---

## R1. Identity & multi-tenancy (auth + workspace scoping)

### R1.1. Модель данных

Alembic-миграция `users_workspaces`:

- Таблица `users`:
  - `id UUID PK`
  - `email VARCHAR(255) UNIQUE NOT NULL`
  - `password_hash VARCHAR(255) NULL` (NULL для OAuth-пользователей)
  - `display_name VARCHAR(200)`
  - `is_active BOOL DEFAULT true`
  - `created_at`, `updated_at`
- Таблица `workspaces`:
  - `id UUID PK`
  - `name VARCHAR(200) NOT NULL`
  - `slug VARCHAR(100) UNIQUE NOT NULL`
  - `created_by UUID FK→users.id`
  - `created_at`, `updated_at`
- Таблица `workspace_members`:
  - `id UUID PK`
  - `user_id UUID FK→users.id ON DELETE CASCADE`
  - `workspace_id UUID FK→workspaces.id ON DELETE CASCADE`
  - `role VARCHAR(20) NOT NULL` ∈ `owner`/`admin`/`member`/`viewer`
  - `created_at`
  - UNIQUE `(user_id, workspace_id)`
- Backfill: создать `users(email='admin@local')` + `workspaces(slug='default')` + membership `owner`. Все существующие строки с `workspace_id IS NULL` → апдейт на default. После — `ALTER COLUMN workspace_id SET NOT NULL` во всех 5 таблицах из P11 (+ knowledge_documents/scheduled_jobs/template_versions/memory_entities/memory_relations — итого 10).

### R1.2. Service tokens

Отдельная таблица `service_tokens`:
- `id UUID PK`
- `kind VARCHAR(20)` ∈ `agent`/`webhook`/`api`
- `token_hash VARCHAR(255)` (sha256 от plaintext, plaintext не хранится)
- `task_id UUID NULL` (для kind=agent — привязка к таску)
- `workspace_id UUID FK→workspaces`
- `expires_at TIMESTAMP NULL`
- `created_at`

Per-task agent-token генерируется при `spawn_agent` и передаётся в env агента как `SPAWNHIVE_AGENT_TOKEN`. Webhook валидирует `Authorization: Bearer <token>` и отвергает 401 без него.

### R1.3. Auth endpoints

Новый модуль `app/auth/`:
- `app/auth/security.py` — bcrypt/argon2 hash, JWT encode/decode (HS256, секрет из env `JWT_SECRET`).
- `app/auth/dependencies.py`:
  - `get_current_user(request)` — читает `Authorization: Bearer`, валидирует JWT, грузит User из БД.
  - `get_current_workspace(user, header X-Workspace-Id)` — проверяет membership.
  - `require_role(role: str)` — фабрика depends-зависимостей.
- Endpoints в `app/api/auth.py`:
  - `POST /api/auth/register` — body `{email, password, display_name}` → создаёт user + auto-creates personal workspace + owner membership.
  - `POST /api/auth/login` → `{access_token, token_type, expires_in, user, default_workspace_id}`.
  - `POST /api/auth/refresh` (опционально, в MVP можно пропустить, выдавать access_token на 24h).
  - `GET /api/auth/me` → текущий user + список workspace.

### R1.4. Scoping всех CRUD

В `app/api/dependencies.py` (новый):
```python
async def scoped_query(model, ws=Depends(get_current_workspace)):
    return select(model).where(model.workspace_id == ws.id)
```

Применить ко **всем** существующим endpoints:
- `tasks.py`, `templates.py`, `memory.py`, `analytics.py`, `scheduled_jobs.py`, `chat.py`, `knowledge.py`, `events.py`, `agents.py`.
- При создании — автоматически проставлять `workspace_id` из контекста.
- При spawn_agent — Docker label `spawnhive.workspace_id` пишется реальным workspace_id, не `shared`.

### R1.5. Agent isolation

`list_agents()`, `kill_agent()`, `kill_all_agents()` — добавить `workspace_id` параметр, фильтровать через Docker label `spawnhive.workspace_id == workspace_id`.

### R1.6. Frontend

- Страницы `/login`, `/register`.
- HTTP interceptor: 401 → redirect на `/login`, 403 → toast "no permission".
- Workspace switcher в верхнем баре (даже если workspace один — заглушка готова).
- Permission-aware UI: `kill all agents`, удаление шаблонов, аналитика — только `owner`/`admin`.

### Acceptance R1

- Пользователь A не видит задачи/шаблоны/события пользователя B (тест: 2 user через API).
- `GET /api/tasks` без токена → 401.
- Webhook без `Authorization` или с подделанным — 401, реальный таск не меняется.
- В Docker labels `spawnhive.workspace_id` совпадает с workspace создателя задачи.
- `kill-all` admin'а workspace A не убивает агентов workspace B.

---

## R2. Webhook hardening (auth + idempotency + versioning)

### R2.1. Versioning URL

Все существующие endpoints перенести под `/api/v1/`. Корневой алиас оставить с deprecation header `Sunset: <дата>`. На старте достаточно для webhook: `/api/v1/agent-webhook/{task_id}`.

### R2.2. Auth для webhook

В `agent_webhook` добавить:
```python
auth = request.headers.get("Authorization", "")
if not auth.startswith("Bearer "):
    raise HTTPException(401)
token_plain = auth[7:]
token_hash = hashlib.sha256(token_plain.encode()).hexdigest()
row = await db.execute(
    select(ServiceToken).where(
        ServiceToken.token_hash == token_hash,
        ServiceToken.kind == "agent",
        ServiceToken.task_id == task_id,
    )
)
if not row.scalar_one_or_none():
    raise HTTPException(401)
```

Агент: `entrypoint.py:report_webhook` и `agent.py:_send_progress` читают `SPAWNHIVE_AGENT_TOKEN` из env и кладут в `Authorization: Bearer …`.

### R2.3. Idempotency

В webhook payload добавить опциональный `idempotency_key: str` (уникальный ID попытки доставки на стороне агента, например UUIDv4).

Таблица `webhook_deliveries`:
- `id UUID PK`
- `task_id UUID`
- `event_type VARCHAR`
- `idempotency_key VARCHAR(64) NOT NULL`
- `received_at TIMESTAMP`
- UNIQUE `(task_id, idempotency_key)`

В `agent_webhook` перед обработкой — попытка вставить delivery row. Если IntegrityError — вернуть 200 с `{"status": "duplicate"}` без обработки.

### R2.4. Retry на стороне агента

`agent-image/entrypoint.py:report_webhook` и `agent-image/agent.py:_send_progress` — обернуть в retry с экспоненциалом (3 попытки, 2s/4s/8s). При финальном fail — log + persist в локальный файл `/tmp/failed_webhooks.json` (для post-mortem, не для гарантии доставки).

### Acceptance R2

- Webhook без токена / с чужим токеном → 401.
- Двойная доставка одного `(task_id, idempotency_key)` → второй запрос не меняет состояние, не списывает cost дважды.
- Все agent'ы шлют webhook'и с `Authorization` header.
- `/api/v1/agent-webhook/{id}` существует и работает; OpenAPI spec версионирован.

---

## R3. Orchestrator splitting + scaling foundations

### R3.1. Разделение процессов

Сейчас в `lifespan` FastAPI стартует `orchestrator_loop` + `start_scheduler`. Вынести в отдельные сервисы.

Новые файлы:
- `backend/app/workers/orchestrator_main.py` — entrypoint:
  ```python
  if __name__ == "__main__":
      asyncio.run(orchestrator_loop_with_lock())
  ```
- `backend/app/workers/scheduler_main.py` — аналогично для APScheduler.

`docker-compose.yml`:
```yaml
api:
  command: uvicorn app.main:app --host 0.0.0.0 --port 8000
orchestrator:
  build: ./backend
  command: python -m app.workers.orchestrator_main
  depends_on: [postgres, qdrant]
  environment: […]
  volumes: [/var/run/docker.sock:/var/run/docker.sock]
scheduler:
  build: ./backend
  command: python -m app.workers.scheduler_main
  depends_on: [postgres]
```

API больше **не** запускает orchestrator/scheduler в lifespan.

### R3.2. Leader election через Postgres advisory lock

`orchestrator_loop_with_lock`:
```python
LOCK_KEY = 8723451   # arbitrary int
async with async_session() as db:
    got = await db.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": LOCK_KEY})
    if not got:
        logger.info("orchestrator already running elsewhere; sleeping")
        await asyncio.sleep(30)
        return
    try:
        await orchestrator_loop()
    finally:
        await db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
```

Аналогично для scheduler с другим LOCK_KEY.

### R3.3. SKIP LOCKED для polling

В `orchestrator_loop`:
```python
SELECT * FROM tasks
WHERE status='ready' AND (deps satisfied …)
ORDER BY priority, created_at
LIMIT 1
FOR UPDATE SKIP LOCKED
```

Это страховка на случай race при горизонтальной репликации (R3.5).

### R3.4. WS broadcasting

- `app/utils/events.py:_broadcast_event` сейчас рассылает в process-local `_event_clients`. Добавить публикацию в Redis Pub/Sub (или Postgres `LISTEN/NOTIFY` для MVP).
- Каждый api-инстанс подписывается, при получении — рассылает по своим WS-клиентам.

В compose добавить `redis:7-alpine`. Опциональный сервис, если не запущен — fallback на process-local (для local-dev).

### R3.5. Готовность к multiple replicas

После R3.1–R3.4 запуск `docker compose up -d --scale api=3` работает: load balancer (nginx) перед api, WS поддерживает sticky session или Redis-фанаут (он у нас уже есть из R3.4).

Orchestrator/scheduler — singleton по advisory lock, реплицировать без вреда.

### Acceptance R3

- `docker compose ps` показывает 3 сервиса: api, orchestrator, scheduler.
- Убийство `orchestrator`-контейнера не валит api; через 30s другой инстанс (если есть) подхватывает lock.
- 2 api-реплики → WS broadcast события доходят на оба.
- При параллельном insert 10 ready-задач orchestrator берёт их по одной, дублей контейнеров нет.

---

## R4. Test infrastructure

### R4.1. pytest setup

- `backend/requirements-dev.txt`:
  ```
  pytest
  pytest-asyncio
  httpx
  testcontainers[postgres]
  ```
- `backend/pytest.ini`:
  ```ini
  [pytest]
  asyncio_mode = auto
  testpaths = tests
  ```
- `backend/tests/conftest.py`:
  - Фикстура `pg_container` (session-scoped) — testcontainers.PostgresContainer.
  - Фикстура `db_session` (function-scoped) — applies migrations, transaction rollback после теста.
  - Фикстура `client` — `httpx.AsyncClient(app=app, base_url="http://test")`.
  - Фикстура `auth_client` — pre-authenticated as test user.

### R4.2. Покрытие критичных путей (минимум)

Файл `tests/unit/test_cost.py`:
- `calculate_cost` для модели без pricing → 0.
- `calculate_cost` для модели с pricing → корректный Decimal.
- input/output_tokens vs input/output aliases.

Файл `tests/unit/test_effective_llm_config.py`:
- Per-template все три поля → возвращает per-template.
- Любое из трёх пустое → возвращает global.

Файл `tests/integration/test_webhook_validation.py`:
- Valid completed → 200 + task updated.
- Invalid event → 422.
- Missing required field в `data` → 422.
- Idempotency: дубль не меняет состояние.

Файл `tests/integration/test_workspace_scoping.py`:
- User A не видит tasks user B.
- Cross-workspace kill → 403.

Файл `tests/integration/test_priority_order.py`:
- low → high → urgent: orchestrator берёт urgent первым.

### R4.3. Migration tests

`tests/integration/test_migrations.py`:
- `alembic upgrade head` на пустой БД → ОК.
- Для каждой миграции из `versions/`: `alembic upgrade <rev> && alembic downgrade -1 && alembic upgrade <rev>`.

### R4.4. CI

`.github/workflows/ci.yml`:
- Triggers: push, PR.
- Steps: checkout, setup python 3.12, install deps, ruff check, pytest.
- Postgres-сервис в job (через github-actions service container).

`.github/workflows/migrations.yml`:
- Только migration tests, отдельно (быстрый сигнал).

### R4.5. Линтеры

- `pyproject.toml`: `[tool.ruff]` с правилами.
- `pre-commit-config.yaml`: ruff, black, isort, prettier (для frontend).
- README → инструкция `pre-commit install`.

### Acceptance R4

- `pytest` локально проходит 100%.
- CI зелёный на `main`.
- Покрытие ≥60% по `app/` (`pytest --cov=app`).
- Любая попытка испортить миграцию (ломаемый downgrade) ловится в `migrations.yml`.

---

## R5. Plugin interfaces

Цель: подложить ABC под существующие реализации, чтобы будущая замена не трогала 30 мест.

### R5.1. LLM provider

`app/plugins/llm.py`:
```python
class LLMProvider(ABC):
    @abstractmethod
    async def acompletion(
        self, model: str, messages: list, tools: list = None,
        tool_choice = None, stream: bool = False, **kwargs,
    ) -> Any: ...

class LiteLLMProvider(LLMProvider):
    async def acompletion(self, model, messages, **kw):
        return await litellm.acompletion(f"openai/{model}", messages=messages, **kw)
```

Все вызовы `litellm.acompletion(...)` в `orchestrator/llm.py`, `api/chat.py`, `api/settings.py:test_llm`, `memory/extractor.py`, `agent.py` (via separate config) — переписать через `get_llm_provider().acompletion(...)`.

`get_llm_provider()` возвращает singleton, выбираемый по env `LLM_PROVIDER=litellm` (default).

### R5.2. Embedding provider

`app/plugins/embeddings.py`:
```python
class EmbeddingProvider(ABC):
    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]: ...
    @property
    @abstractmethod
    def dim(self) -> int: ...

class FastembedProvider(EmbeddingProvider): ...
class OpenAICompatibleEmbeddingProvider(EmbeddingProvider): ...
```

`knowledge/rag.py:get_embeddings` → переписать на `get_embedding_provider().embed(texts)`.

### R5.3. Agent runtime

`app/plugins/runtime.py`:
```python
class AgentRuntime(ABC):
    @abstractmethod
    async def spawn(self, spec: AgentSpec) -> str: ...  # returns container_id
    @abstractmethod
    async def kill(self, container_id: str) -> bool: ...
    @abstractmethod
    async def list_active(self, workspace_id: UUID | None) -> list[AgentInfo]: ...
    @abstractmethod
    async def health(self, container_id: str) -> dict | None: ...
    @abstractmethod
    async def send_command(
        self, container_id: str, kind: str, payload: dict
    ) -> bool: ...

class DockerRuntime(AgentRuntime): ...  # текущая реализация
```

`AgentSpec` — dataclass с task_id, env, volumes, labels, limits.

Все вызовы `docker_manager.spawn_agent / kill_agent / list_agents / send_feedback / abort_agent / switch_agent_model` — заменить на `get_runtime().spawn(...)` и т.д.

### R5.4. Notifier (опционально, на ноль сейчас)

`app/plugins/notifier.py`:
```python
class Notifier(ABC):
    @abstractmethod
    async def notify(self, event_type: str, data: dict, workspace_id: UUID): ...

class NoopNotifier(Notifier): pass
class WebhookNotifier(Notifier): ...
```

Подключить хотя бы NoopNotifier в `log_event` (после broadcast). Чтобы потом легко добавить Slack/Discord без модификации бизнес-логики.

### R5.5. Secrets provider

`app/plugins/secrets.py`:
```python
class SecretsProvider(ABC):
    @abstractmethod
    async def get(self, key: str) -> str | None: ...
    @abstractmethod
    async def set(self, key: str, value: str) -> None: ...

class DBSecretsProvider(SecretsProvider): ...   # текущая реализация (settings table)
class EnvSecretsProvider(SecretsProvider): ...
```

`provider_api_key`, `llm_api_key`, `minio_secret_key` — все секреты идут через эту абстракцию. На MVP — DBSecretsProvider; production — EnvSecretsProvider (с возможностью подключить Vault).

### Acceptance R5

- `app/plugins/` существует с 5 ABC.
- Все прямые импорты `litellm`, `docker.from_env`, fastembed — только внутри implementations.
- `LLM_PROVIDER=litellm`, `EMBEDDING_PROVIDER=fastembed`, `AGENT_RUNTIME=docker`, `SECRETS_PROVIDER=db` — env-переменные подхватываются.
- Существующие тесты (R4) проходят без изменений.

---

## Что НЕ входит в этот ТЗ (намеренно)

Эти пункты делаем **после** R1-R5, параллельно с фичами BACKLOG:

- **Observability** (structured logging, Prometheus, OpenTelemetry) — отдельный документ когда понадобится.
- **Storage scaling** (events partitioning, retention, ClickHouse) — упрётся через 6+ месяцев эксплуатации, рано.
- **Sandbox для Docker-агентов** (rootless, network policy) — security hardening, отдельным треком.
- **Repo-гигиена** (LICENSE, CONTRIBUTING, SECURITY.md, README) — параллельно, не блокирующе.
- **OAuth/SSO** — расширение R1, не входит в R1 минимум (только email+password).
- **Frontend e2e** (Playwright) — после стабилизации UI.

---

## Верификация в конце R1-R5

1. **Multi-user smoke**: 2 user, 2 workspace, кросс-видимости нет, кросс-control нет.
2. **Webhook hardening**: попытка POST без auth → 401, дубликат → 200 без побочек, версионированный URL отвечает.
3. **Orchestrator failover**: убить orchestrator-контейнер, через 30s pickup'ит реплика; убить scheduler — same.
4. **CI**: открыть PR, увидеть зелёные `ci.yml` + `migrations.yml`, покрытие ≥60%.
5. **Plugin smoke**: `LLM_PROVIDER=litellm` (default) работает; подменить на NoopProvider в тесте — все LLM-вызовы возвращают мок без сетевых походов.

После этой пятёрки — открыть `BACKLOG.md` и работать с фичами в плановом режиме.

---

## Оценка трудозатрат

| Блок | Срок (1 человек) | Параллелизуемо |
|------|------------------|----------------|
| R1 | 5-7 дней | Frontend и Backend параллельно |
| R2 | 1-2 дня | После R1 |
| R3 | 3-4 дня | Параллельно с R4 |
| R4 | 3 дня | Параллельно с R3 |
| R5 | 3-4 дня | Последним (упрощается тестами из R4) |

**Итого:** ~3 рабочие недели до точки готовности к работе с основным backlog'ом.
