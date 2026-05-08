"""Unit tests for app.orchestrator.docker_manager — all Docker SDK calls mocked.

These tests don't actually need Docker; they exercise the workspace-filtering
logic, label handling, and dispatch paths around the SDK.
"""

import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.orchestrator import docker_manager as dm


def _container_mock(*, cid: str, status: str = "running", labels: dict | None = None, name: str = "c"):
    c = MagicMock()
    c.id = cid
    c.status = status
    c.name = name
    c.labels = labels or {}
    c.attrs = {"Created": "2026-05-04T00:00:00Z"}
    c.stats.return_value = iter([{"memory_stats": {"usage": 1_000_000, "limit": 8_000_000}}])
    return c


def _client_with(containers):
    cli = MagicMock()
    cli.containers.list.return_value = containers
    cli.containers.get.side_effect = lambda cid: next((c for c in containers if c.id == cid), None) or _raise_not_found(cid)
    return cli


def _raise_not_found(cid):
    from docker.errors import NotFound
    raise NotFound(f"no such container {cid}")


def test_get_llm_env_vars_defaults():
    out = dm.get_llm_env_vars({})
    assert out["LLM_MODEL"] == "MiniMax-M2.7"
    assert out["OPENAI_API_KEY"] == ""
    assert out["OPENAI_BASE_URL"] == ""


def test_get_llm_env_vars_passthrough():
    out = dm.get_llm_env_vars({
        "llm_model": "M",
        "llm_api_key": "K",
        "llm_base_url": "http://x",
    })
    assert out == {"LLM_MODEL": "M", "OPENAI_API_KEY": "K", "OPENAI_BASE_URL": "http://x"}


def test_effective_llm_config_template_wins():
    tpl = SimpleNamespace(model="m", provider_url="u", provider_api_key="k")
    out = dm.effective_llm_config(tpl, {"llm_model": "GLOBAL"})
    assert out == {"llm_model": "m", "llm_base_url": "u", "llm_api_key": "k"}


def test_effective_llm_config_falls_back_to_global():
    tpl = SimpleNamespace(model=None, provider_url=None, provider_api_key=None)
    out = dm.effective_llm_config(tpl, {
        "llm_model": "g", "llm_base_url": "gu", "llm_api_key": "gk",
    })
    assert out == {"llm_model": "g", "llm_base_url": "gu", "llm_api_key": "gk"}


def test_container_in_workspace():
    c = _container_mock(cid="x", labels={"spawnhive.workspace_id": "ws-A"})
    assert dm._container_in_workspace(c, None) is True
    assert dm._container_in_workspace(c, "ws-A") is True
    assert dm._container_in_workspace(c, "ws-B") is False


def test_kill_agent_returns_true_on_success():
    c = _container_mock(cid="abc", labels={"spawnhive.workspace_id": "W"})
    cli = _client_with([c])
    with patch.object(dm, "get_docker_client", return_value=cli):
        ok = dm.kill_agent("abc", workspace_id="W")
    assert ok is True
    c.stop.assert_called_once()
    c.remove.assert_called_once()


def test_kill_agent_workspace_mismatch_returns_false():
    c = _container_mock(cid="abc", labels={"spawnhive.workspace_id": "OTHER"})
    cli = _client_with([c])
    with patch.object(dm, "get_docker_client", return_value=cli):
        ok = dm.kill_agent("abc", workspace_id="MINE")
    assert ok is False
    c.stop.assert_not_called()


def test_kill_agent_not_found_returns_false():
    cli = MagicMock()
    from docker.errors import NotFound
    cli.containers.get.side_effect = NotFound("missing")
    with patch.object(dm, "get_docker_client", return_value=cli):
        assert dm.kill_agent("zzz") is False


def test_kill_all_agents_counts_killed():
    cs = [
        _container_mock(cid="1", labels={"spawnhive.workspace_id": "W"}),
        _container_mock(cid="2", labels={"spawnhive.workspace_id": "W"}),
    ]
    cli = _client_with(cs)
    with patch.object(dm, "get_docker_client", return_value=cli):
        n = dm.kill_all_agents(workspace_id="W")
    assert n == 2
    for c in cs:
        c.stop.assert_called_once()
        c.remove.assert_called_once()


def test_kill_all_agents_filter_includes_workspace_label():
    cli = _client_with([])
    with patch.object(dm, "get_docker_client", return_value=cli):
        dm.kill_all_agents(workspace_id="abc")
    args, kwargs = cli.containers.list.call_args
    labels = kwargs["filters"]["label"]
    assert "spawnhive.task_id" in labels
    assert "spawnhive.workspace_id=abc" in labels


def test_list_agents_returns_dicts_per_container():
    cs = [
        _container_mock(
            cid="abcdef",
            labels={
                "spawnhive.task_id": "t1",
                "spawnhive.template_id": "tpl1",
                "spawnhive.template_name": "T",
                "spawnhive.workspace_id": "W",
            },
            name="spawnhive-x",
        ),
    ]
    cli = _client_with(cs)
    with patch.object(dm, "get_docker_client", return_value=cli):
        agents = dm.list_agents(workspace_id="W")
    assert len(agents) == 1
    a = agents[0]
    assert a["task_id"] == "t1"
    assert a["template_name"] == "T"
    assert a["workspace_id"] == "W"


def test_get_agent_stats_workspace_mismatch_returns_none():
    c = _container_mock(cid="x", labels={"spawnhive.workspace_id": "OTHER"})
    cli = _client_with([c])
    with patch.object(dm, "get_docker_client", return_value=cli):
        assert dm.get_agent_stats("x", workspace_id="MINE") is None


def test_get_agent_stats_returns_payload():
    c = _container_mock(
        cid="xyz",
        labels={
            "spawnhive.task_id": "t1",
            "spawnhive.template_id": "tpl",
            "spawnhive.template_name": "X",
            "spawnhive.workspace_id": "W",
        },
        name="spawnhive-xyz",
    )
    cli = _client_with([c])
    with patch.object(dm, "get_docker_client", return_value=cli):
        stats = dm.get_agent_stats("xyz", workspace_id="W")
    assert stats is not None
    assert stats["task_id"] == "t1"
    assert stats["template_name"] == "X"


def test_spawn_agent_passes_correct_labels_and_env(tmp_path, monkeypatch):
    # Steer the data dirs into tmp_path so spawn_agent's mkdir doesn't pollute /data.
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HOST_DATA_DIR", str(tmp_path))
    # Reset the cached settings singleton.
    from app import config as cfg
    cfg.get_settings.cache_clear()

    cli = MagicMock()
    cli.containers.run.return_value = SimpleNamespace(id="ctr-1234567890ab", labels={})

    tpl = SimpleNamespace(
        id="tpl-uuid",
        name="alpha",
        soul_md="# soul",
        tools=["x"],
        mcp_servers=[],
        max_ram="1g",
        max_cpu=50000,
    )
    with patch.object(dm, "get_docker_client", return_value=cli):
        cid = dm.spawn_agent(
            task_id="task-1",
            task_description="do work",
            template=tpl,
            llm_settings={"llm_api_key": "K", "llm_base_url": "U", "llm_model": "M"},
            workspace_id="ws-1",
            agent_token="TKN",
        )

    assert cid == "ctr-1234567890ab"
    _, kwargs = cli.containers.run.call_args
    labels = kwargs["labels"]
    assert labels["spawnhive.task_id"] == "task-1"
    assert labels["spawnhive.workspace_id"] == "ws-1"
    assert labels["spawnhive.template_name"] == "alpha"
    env = kwargs["environment"]
    assert env["SPAWNHIVE_AGENT_TOKEN"] == "TKN"
    assert env["LLM_MODEL"] == "M"
    assert env["AGENT_SOUL"] == "# soul"
    cfg.get_settings.cache_clear()
