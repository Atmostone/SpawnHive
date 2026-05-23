"""Integration tests for /api/workspaces/me/system-models."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_get_system_models_returns_assigned_ids(auth_client: AsyncClient):
    """Newly registered users inherit the default workspace's system model assignments."""
    r = await auth_client.get("/api/workspaces/me/system-models")
    assert r.status_code == 200
    body = r.json()
    # All three FKs are set to the same cloned model (from env bootstrap).
    assert set(body.keys()) == {
        "orchestrator_model_id", "chat_model_id", "memory_extractor_model_id"
    }


@pytest.mark.asyncio
async def test_patch_system_models_assigns_and_clears(auth_client: AsyncClient):
    # Seed provider + 2 models in *this* workspace
    r = await auth_client.post(
        "/api/providers", json={"name": "p-test", "api_key": "k", "endpoint": "http://e"}
    )
    pid = r.json()["id"]
    m1 = (await auth_client.post(
        f"/api/providers/{pid}/models",
        json={"display_name": "M1", "api_name": "m1"},
    )).json()["id"]
    m2 = (await auth_client.post(
        f"/api/providers/{pid}/models",
        json={"display_name": "M2", "api_name": "m2"},
    )).json()["id"]

    # Assign orchestrator → m1, chat → m2 (memory_extractor untouched)
    r = await auth_client.patch(
        "/api/workspaces/me/system-models",
        json={"orchestrator_model_id": m1, "chat_model_id": m2},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["orchestrator_model_id"] == m1
    assert body["chat_model_id"] == m2

    # Clear by passing null
    r = await auth_client.patch(
        "/api/workspaces/me/system-models",
        json={"orchestrator_model_id": None},
    )
    assert r.status_code == 200
    assert r.json()["orchestrator_model_id"] is None
    # other fields untouched
    assert r.json()["chat_model_id"] == m2


@pytest.mark.asyncio
async def test_patch_rejects_model_from_another_workspace(client: AsyncClient):
    """A model belonging to workspace B cannot be assigned to workspace A's system roles."""
    rA = await client.post(
        "/api/auth/register",
        json={"email": "x@test.dev", "password": "secret1234", "display_name": "X"},
    )
    tokA, wsA = rA.json()["access_token"], rA.json()["default_workspace_id"]
    rB = await client.post(
        "/api/auth/register",
        json={"email": "y@test.dev", "password": "secret1234", "display_name": "Y"},
    )
    tokB, wsB = rB.json()["access_token"], rB.json()["default_workspace_id"]

    # B creates a provider + model
    r = await client.post(
        "/api/providers",
        json={"name": "ppp", "api_key": "k", "endpoint": "http://e"},
        headers={"Authorization": f"Bearer {tokB}", "X-Workspace-Id": wsB},
    )
    pid = r.json()["id"]
    r = await client.post(
        f"/api/providers/{pid}/models",
        json={"display_name": "M", "api_name": "m"},
        headers={"Authorization": f"Bearer {tokB}", "X-Workspace-Id": wsB},
    )
    foreign_model_id = r.json()["id"]

    # A tries to assign it as their orchestrator → 400
    r = await client.patch(
        "/api/workspaces/me/system-models",
        json={"orchestrator_model_id": foreign_model_id},
        headers={"Authorization": f"Bearer {tokA}", "X-Workspace-Id": wsA},
    )
    assert r.status_code == 400
