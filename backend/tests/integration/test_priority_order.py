"""Verify orchestrator picks higher-priority tasks first.

We don't actually spawn agents in this test — we replicate just the SELECT used by
the orchestrator polling loop and check ordering.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import case, select

from app.models.task import Task, TaskStatus


@pytest.mark.asyncio
async def test_priority_ordering(auth_client: AsyncClient, db_session):
    # Create three tasks at different priorities through the API so workspace_id is set.
    prios = ["low", "high", "urgent"]
    titles = []
    for p in prios:
        r = await auth_client.post(
            "/api/tasks",
            json={"title": f"{p} task", "description": ".", "priority": p},
        )
        assert r.status_code == 201
        task_id = r.json()["id"]
        # Move to ready so the orchestrator query sees it.
        await auth_client.patch(f"/api/tasks/{task_id}", json={"status": "ready"})
        titles.append(r.json()["title"])

    priority_order = case(
        (Task.priority == "urgent", 1),
        (Task.priority == "high", 2),
        (Task.priority == "medium", 3),
        (Task.priority == "low", 4),
        else_=5,
    )
    rows = (
        await db_session.execute(
            select(Task)
            .where(Task.status == TaskStatus.READY.value)
            .order_by(priority_order, Task.created_at)
        )
    ).scalars().all()
    ordered = [t.priority for t in rows]
    # Urgent must come before high which must come before low.
    assert ordered.index("urgent") < ordered.index("high") < ordered.index("low")
