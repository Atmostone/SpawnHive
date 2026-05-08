"""Role-based access control on destructive endpoints."""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.main import app


async def _register(client: AsyncClient, prefix: str) -> tuple[str, str, str]:
    email = f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password1234", "display_name": prefix},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    return body["access_token"], body["default_workspace_id"], body["user"]["id"]


@pytest.mark.asyncio
async def test_member_cannot_kill_all_or_delete_template(_engine, _truncate):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as alice:
        owner_token, owner_ws, owner_uid = await _register(alice, "alice-owner")
        alice.headers["Authorization"] = f"Bearer {owner_token}"
        alice.headers["X-Workspace-Id"] = owner_ws

        # Owner creates a template in their workspace.
        r = await alice.post(
            "/api/templates",
            json={
                "name": "doomed",
                "description": "destined for delete attempt",
                "soul_md": "# Soul",
            },
        )
        assert r.status_code == 201, r.text
        tpl_id = r.json()["id"]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as bob:
        member_token, _, member_uid = await _register(bob, "bob-member")
        # Inject Bob as a `member` of Alice's workspace via direct SQL (no invite endpoint yet).
        async with _engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO workspace_members (id, user_id, workspace_id, role) "
                "VALUES (:id, :uid, :wid, 'member')"
            ), {"id": uuid.uuid4(), "uid": uuid.UUID(member_uid), "wid": uuid.UUID(owner_ws)})

        bob.headers["Authorization"] = f"Bearer {member_token}"
        bob.headers["X-Workspace-Id"] = owner_ws  # acting in Alice's workspace as member

        # Reading is allowed.
        r_list = await bob.get("/api/templates")
        assert r_list.status_code == 200
        assert any(t["id"] == tpl_id for t in r_list.json())

        # Destructive — DELETE template — must 403.
        r_del = await bob.delete(f"/api/templates/{tpl_id}")
        assert r_del.status_code == 403, r_del.text

        # Destructive — kill-all — must 403.
        r_kill = await bob.post("/api/agents/kill-all")
        assert r_kill.status_code == 403, r_kill.text


@pytest.mark.asyncio
async def test_viewer_cannot_create_template(_engine, _truncate):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as alice:
        owner_token, owner_ws, _ = await _register(alice, "alice2")
        alice.headers["Authorization"] = f"Bearer {owner_token}"
        alice.headers["X-Workspace-Id"] = owner_ws

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as carol:
        viewer_token, _, viewer_uid = await _register(carol, "carol-viewer")
        async with _engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO workspace_members (id, user_id, workspace_id, role) "
                "VALUES (:id, :uid, :wid, 'viewer')"
            ), {"id": uuid.uuid4(), "uid": uuid.UUID(viewer_uid), "wid": uuid.UUID(owner_ws)})

        carol.headers["Authorization"] = f"Bearer {viewer_token}"
        carol.headers["X-Workspace-Id"] = owner_ws

        # Viewer can read.
        r_list = await carol.get("/api/templates")
        assert r_list.status_code == 200

        # Viewer cannot create.
        r_post = await carol.post(
            "/api/templates",
            json={"name": "vmiss", "description": "x", "soul_md": "# x"},
        )
        assert r_post.status_code == 403, r_post.text
