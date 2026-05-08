"""Integration tests for GET /api/events agent_container_id filter (foundations Wave 1)."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.database import async_session
from app.utils.events import log_event


@pytest.mark.asyncio
async def test_filter_by_agent_container_id_returns_only_matching(auth_client: AsyncClient):
    """Two events with different agent_container_id — filter narrows to one."""
    workspace_id = auth_client.headers["X-Workspace-Id"]

    async with async_session() as db:
        await log_event(
            db,
            event_type="agent_progress",
            source="agent",
            data={"current_step": "step-A"},
            agent_container_id="ctr-aaa",
            workspace_id=workspace_id,
        )
        await log_event(
            db,
            event_type="agent_progress",
            source="agent",
            data={"current_step": "step-B"},
            agent_container_id="ctr-bbb",
            workspace_id=workspace_id,
        )

    r = await auth_client.get("/api/events", params={"agent_container_id": "ctr-aaa"})
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["agent_container_id"] == "ctr-aaa"
    assert rows[0]["data"]["current_step"] == "step-A"


@pytest.mark.asyncio
async def test_filter_by_agent_container_id_no_match_returns_empty(auth_client: AsyncClient):
    """Filter with a container id no row uses → empty list (not error)."""
    workspace_id = auth_client.headers["X-Workspace-Id"]
    async with async_session() as db:
        await log_event(
            db,
            event_type="agent_health",
            source="orchestrator",
            data={},
            agent_container_id="ctr-only",
            workspace_id=workspace_id,
        )

    r = await auth_client.get("/api/events", params={"agent_container_id": "does-not-exist"})
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_filter_respects_workspace_isolation(client: AsyncClient):
    """Two workspaces, both with same agent_container_id — each user sees only their workspace."""
    # User A
    email_a = f"a-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/auth/register",
        json={"email": email_a, "password": "password1234", "display_name": "A"},
    )
    assert r.status_code == 200
    pa = r.json()
    ws_a = pa["default_workspace_id"]
    headers_a = {
        "Authorization": f"Bearer {pa['access_token']}",
        "X-Workspace-Id": ws_a,
    }

    # User B
    email_b = f"b-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/auth/register",
        json={"email": email_b, "password": "password1234", "display_name": "B"},
    )
    assert r.status_code == 200
    pb = r.json()
    ws_b = pb["default_workspace_id"]
    headers_b = {
        "Authorization": f"Bearer {pb['access_token']}",
        "X-Workspace-Id": ws_b,
    }

    shared_container = "ctr-shared-id"
    async with async_session() as db:
        await log_event(
            db,
            event_type="agent_progress",
            source="agent",
            data={"who": "A"},
            agent_container_id=shared_container,
            workspace_id=ws_a,
        )
        await log_event(
            db,
            event_type="agent_progress",
            source="agent",
            data={"who": "B"},
            agent_container_id=shared_container,
            workspace_id=ws_b,
        )

    r_a = await client.get(
        "/api/events",
        params={"agent_container_id": shared_container},
        headers=headers_a,
    )
    r_b = await client.get(
        "/api/events",
        params={"agent_container_id": shared_container},
        headers=headers_b,
    )
    assert r_a.status_code == 200
    assert r_b.status_code == 200
    rows_a = r_a.json()
    rows_b = r_b.json()
    assert len(rows_a) == 1 and rows_a[0]["data"]["who"] == "A"
    assert len(rows_b) == 1 and rows_b[0]["data"]["who"] == "B"


@pytest.mark.asyncio
async def test_filter_combines_with_event_type(auth_client: AsyncClient):
    """agent_container_id + event_type together: both must match."""
    workspace_id = auth_client.headers["X-Workspace-Id"]
    async with async_session() as db:
        await log_event(
            db, event_type="agent_progress", source="agent",
            data={"x": 1}, agent_container_id="ctr-xxx", workspace_id=workspace_id,
        )
        await log_event(
            db, event_type="agent_health", source="orchestrator",
            data={"y": 2}, agent_container_id="ctr-xxx", workspace_id=workspace_id,
        )

    r = await auth_client.get(
        "/api/events",
        params={"agent_container_id": "ctr-xxx", "event_type": "agent_health"},
    )
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["event_type"] == "agent_health"
    assert rows[0]["data"]["y"] == 2
