"""Integration tests for the R1 auth + workspace scoping layer."""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_unauthenticated_tasks_returns_401(client: AsyncClient):
    r = await client.get("/api/tasks")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_returns_token_and_default_workspace(client: AsyncClient):
    email = f"login-{uuid.uuid4().hex[:8]}@example.com"
    pw = "password1234"
    reg = await client.post(
        "/api/auth/register",
        json={"email": email, "password": pw, "display_name": "L"},
    )
    assert reg.status_code == 200

    r = await client.post(
        "/api/auth/login", json={"email": email, "password": pw},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["default_workspace_id"]


@pytest.mark.asyncio
async def test_login_bad_credentials_returns_401(client: AsyncClient):
    r = await client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "wrong"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_register_duplicate_email_returns_409(client: AsyncClient):
    email = f"dup-{uuid.uuid4().hex[:8]}@example.com"
    r1 = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password1234"},
    )
    assert r1.status_code == 200
    r2 = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password1234"},
    )
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_me_without_auth_returns_401(client: AsyncClient):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_register_returns_token_and_default_workspace(client: AsyncClient):
    email = f"new-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/auth/register",
        json={"email": email, "password": "password1234", "display_name": "N"},
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["user"]["email"] == email
    assert payload["default_workspace_id"]
    assert payload["access_token"]


@pytest.mark.asyncio
async def test_cross_workspace_isolation(auth_client: AsyncClient):
    # auth_client is User A. Create a task.
    r = await auth_client.post(
        "/api/tasks",
        json={"title": "alice secret", "description": "a", "priority": "low"},
    )
    assert r.status_code == 201
    task_id = r.json()["id"]

    # User B with their own session.
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as bob:
        email = f"bob-{uuid.uuid4().hex[:8]}@example.com"
        rr = await bob.post(
            "/api/auth/register",
            json={"email": email, "password": "password1234", "display_name": "B"},
        )
        assert rr.status_code == 200
        token = rr.json()["access_token"]
        ws = rr.json()["default_workspace_id"]
        bob.headers["Authorization"] = f"Bearer {token}"
        bob.headers["X-Workspace-Id"] = ws

        # B's task list is empty (own workspace).
        list_resp = await bob.get("/api/tasks")
        assert list_resp.status_code == 200
        assert list_resp.json() == []

        # B can't read A's task by id.
        get_resp = await bob.get(f"/api/tasks/{task_id}")
        assert get_resp.status_code == 404
