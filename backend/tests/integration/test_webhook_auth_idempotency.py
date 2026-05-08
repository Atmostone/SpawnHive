"""End-to-end webhook flow: auth + idempotency."""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.auth.tokens import issue_agent_token
from app.models.task import Task, TaskStatus
from app.models.webhook_delivery import WebhookDelivery


@pytest.mark.asyncio
async def test_webhook_rejects_without_bearer(client: AsyncClient):
    r = await client.post(
        "/api/v1/agent-webhook/00000000-0000-0000-0000-000000000000",
        json={"event": "progress", "data": {}},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_body_with_422(client: AsyncClient):
    r = await client.post(
        "/api/v1/agent-webhook/00000000-0000-0000-0000-000000000000",
        headers={"Authorization": "Bearer x"},
        json={"event": "junk"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_webhook_rejects_unknown_token(client: AsyncClient):
    r = await client.post(
        "/api/v1/agent-webhook/00000000-0000-0000-0000-000000000000",
        headers={"Authorization": "Bearer bogus-token"},
        json={"event": "progress", "data": {}},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_webhook_accepts_valid_token_and_dedupes(
    auth_client: AsyncClient, db_session
):
    # Create a task in our workspace via the API (gets workspace_id automatically).
    create = await auth_client.post(
        "/api/tasks", json={"title": "wh test", "description": "x", "priority": "low"}
    )
    assert create.status_code == 201
    task_id = uuid.UUID(create.json()["id"])

    # Issue a real agent token for this task by calling the same helper the orchestrator uses.
    task = await db_session.get(Task, task_id)
    plain = await issue_agent_token(
        db_session, task_id=task_id, workspace_id=task.workspace_id
    )
    await db_session.commit()

    body = {
        "event": "progress",
        "task_id": str(task_id),
        "idempotency_key": "k-1",
        "data": {"current_step": "first"},
    }
    headers = {"Authorization": f"Bearer {plain}"}

    r1 = await auth_client.post(
        f"/api/v1/agent-webhook/{task_id}", headers=headers, json=body
    )
    assert r1.status_code == 200, r1.text
    assert r1.json() == {"status": "ok"}

    # Second post with the same idempotency_key returns "duplicate" without side effects.
    r2 = await auth_client.post(
        f"/api/v1/agent-webhook/{task_id}", headers=headers, json=body
    )
    assert r2.status_code == 200
    assert r2.json() == {"status": "duplicate"}


@pytest.mark.asyncio
async def test_webhook_atomic_rollback_on_processing_failure(
    auth_client: AsyncClient, db_session, monkeypatch
):
    """If processing crashes mid-way, the delivery row must NOT persist —
    otherwise the retry would be (incorrectly) marked duplicate while the
    task state is still pristine. Simulate a crash inside calculate_cost."""
    create = await auth_client.post(
        "/api/tasks", json={"title": "atomic test", "description": "x", "priority": "low"}
    )
    assert create.status_code == 201
    task_id = uuid.UUID(create.json()["id"])

    task = await db_session.get(Task, task_id)
    plain = await issue_agent_token(
        db_session, task_id=task_id, workspace_id=task.workspace_id
    )
    await db_session.commit()

    body = {
        "event": "completed",
        "task_id": str(task_id),
        "idempotency_key": "atomic-1",
        "data": {
            "result_summary": "done",
            "files": [],
            "token_usage": {"input": 10, "output": 5},
        },
    }
    headers = {"Authorization": f"Bearer {plain}"}

    # Force calculate_cost (called inside the transaction) to raise — the
    # entire transaction must roll back, including the delivery row.
    import app.api.webhooks as webhooks_mod
    from app.utils import cost as cost_mod

    async def boom(*a, **kw):
        raise RuntimeError("simulated crash mid-processing")

    monkeypatch.setattr(cost_mod, "calculate_cost", boom)
    # webhooks.py does `from app.utils.cost import calculate_cost` inside the function,
    # so patching the module attribute is sufficient.

    # In httpx ASGI mode, unhandled exceptions bubble up directly. In production
    # FastAPI converts them to 500. Either way: the rollback path must run.
    with pytest.raises(RuntimeError, match="simulated crash"):
        await auth_client.post(
            f"/api/v1/agent-webhook/{task_id}", headers=headers, json=body
        )

    # After the crash, NO delivery row should exist for atomic-1.
    rows = (await db_session.execute(
        select(WebhookDelivery).where(WebhookDelivery.idempotency_key == "atomic-1")
    )).scalars().all()
    assert rows == [], "delivery row leaked despite rolled-back transaction"

    # And the retry must succeed (not be marked duplicate). Restore cost calc.
    monkeypatch.undo()

    r2 = await auth_client.post(
        f"/api/v1/agent-webhook/{task_id}", headers=headers, json=body
    )
    assert r2.status_code == 200, r2.text
    assert r2.json() == {"status": "ok"}

    # And now exactly one delivery row should exist (from the successful retry).
    rows2 = (await db_session.execute(
        select(WebhookDelivery).where(WebhookDelivery.idempotency_key == "atomic-1")
    )).scalars().all()
    assert len(rows2) == 1


@pytest.mark.asyncio
async def test_webhook_progress_event_logs_without_status_change(
    auth_client: AsyncClient, db_session
):
    create = await auth_client.post(
        "/api/tasks", json={"title": "p", "description": "x", "priority": "low"}
    )
    tid = uuid.UUID(create.json()["id"])
    task = await db_session.get(Task, tid)
    plain = await issue_agent_token(db_session, task_id=tid, workspace_id=task.workspace_id)
    await db_session.commit()

    r = await auth_client.post(
        f"/api/v1/agent-webhook/{tid}",
        headers={"Authorization": f"Bearer {plain}"},
        json={
            "event": "progress",
            "task_id": str(tid),
            "idempotency_key": "p-1",
            "data": {"current_step": "step 1", "iteration": 1},
        },
    )
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_webhook_aborted_event_marks_failed(auth_client: AsyncClient, db_session):
    create = await auth_client.post(
        "/api/tasks", json={"title": "a", "description": "x", "priority": "low"}
    )
    tid = uuid.UUID(create.json()["id"])
    task = await db_session.get(Task, tid)
    plain = await issue_agent_token(db_session, task_id=tid, workspace_id=task.workspace_id)
    await db_session.commit()

    r = await auth_client.post(
        f"/api/v1/agent-webhook/{tid}",
        headers={"Authorization": f"Bearer {plain}"},
        json={
            "event": "aborted",
            "task_id": str(tid),
            "idempotency_key": "a-1",
            "data": {"reason": "user pressed stop", "token_usage": {"input": 1, "output": 1}},
        },
    )
    assert r.status_code == 200
    await db_session.refresh(task)
    assert task.status == TaskStatus.FAILED.value


@pytest.mark.asyncio
async def test_webhook_failed_event_retries_when_under_limit(
    auth_client: AsyncClient, db_session
):
    create = await auth_client.post(
        "/api/tasks", json={"title": "f", "description": "x", "priority": "low"}
    )
    tid = uuid.UUID(create.json()["id"])
    task = await db_session.get(Task, tid)
    task.max_retries = 2
    await db_session.commit()
    plain = await issue_agent_token(db_session, task_id=tid, workspace_id=task.workspace_id)
    await db_session.commit()

    r = await auth_client.post(
        f"/api/v1/agent-webhook/{tid}",
        headers={"Authorization": f"Bearer {plain}"},
        json={
            "event": "failed",
            "task_id": str(tid),
            "idempotency_key": "f-1",
            "data": {"error": "boom", "token_usage": {"input": 1, "output": 1}},
        },
    )
    assert r.status_code == 200
    await db_session.refresh(task)
    # Under-limit failure → retry, status flips back to READY.
    assert task.status == TaskStatus.READY.value
    assert task.retry_count == 1


@pytest.mark.asyncio
async def test_legacy_webhook_emits_sunset_header(client: AsyncClient):
    r = await client.post(
        "/api/agent-webhook/00000000-0000-0000-0000-000000000000",
        headers={"Authorization": "Bearer x"},
        json={"event": "progress", "data": {}},
    )
    assert r.status_code == 401
    assert r.headers.get("sunset")
    assert r.headers.get("deprecation") == "true"
