"""Unit tests for the Toolathlon → Registry import logic (SPA-43).

No DB, no network. Covers template-variable resolution (all three vars, nested in
args/env), PG env injection for postgres-backed servers, idempotency/name-collision
shaping for the upsert, payload shapes against real upstream yaml fixtures
(tests/fixtures/toolathlon/, Apache-2.0 files from eigent-ai/toolathlon_gym), and
the cwd passthrough in the spawn-time resolver.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest
from app.registry.resolver import _materialize
from app.registry.toolathlon_import import (
    NAME_PREFIX,
    PG_ENV_KEYS,
    build_entry_payload,
    load_config_files,
    plan_upsert,
    resolve_template_vars,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "toolathlon"

PG_ENV = {
    "PG_HOST": "toolathlon_pg",
    "PG_PORT": "5432",
    "PG_USER": "eigent",
    "PG_PASSWORD": "camel",
    "PG_DATABASE": "toolathlon_gym",
}


def _doc(name="srv", command="node", args=None, env=None, cwd=None, type_="stdio"):
    params = {"command": command, "args": args or []}
    if env is not None:
        params["env"] = env
    if cwd is not None:
        params["cwd"] = cwd
    return {"type": type_, "name": name, "params": params}


# --------------------------------------------------------------------------- #
# Template-variable resolution
# --------------------------------------------------------------------------- #
def test_resolve_all_three_vars():
    s = "${local_servers_paths}/x ${agent_workspace}/y ${task_dir}/z"
    assert resolve_template_vars(s) == "/opt/local_servers/x /workspace/y /workspace/z"


def test_resolve_nested_in_args_and_env():
    value = {
        "args": ["--directory", "${local_servers_paths}/emails-mcp", "${task_dir}/email_config.json"],
        "env": {"MEMORY_FILE_PATH": "${agent_workspace}/memory/memory.json"},
    }
    out = resolve_template_vars(value)
    assert out["args"] == [
        "--directory", "/opt/local_servers/emails-mcp", "/workspace/email_config.json",
    ]
    assert out["env"] == {"MEMORY_FILE_PATH": "/workspace/memory/memory.json"}


def test_resolve_embedded_in_larger_string():
    # e.g. youtube_transcript runs a python -c one-liner containing the placeholder
    s = "import os; os.chdir('${local_servers_paths}/mcp-youtube-transcript')"
    assert resolve_template_vars(s) == "import os; os.chdir('/opt/local_servers/mcp-youtube-transcript')"


def test_resolve_leaves_unknown_placeholders_and_non_strings():
    assert resolve_template_vars("${config.proxy}") == "${config.proxy}"
    assert resolve_template_vars(120) == 120
    assert resolve_template_vars(None) is None


def test_resolve_variables_override():
    assert (
        resolve_template_vars("${agent_workspace}", {"agent_workspace": "/tmp/ws"}) == "/tmp/ws"
    )


# --------------------------------------------------------------------------- #
# Payload shaping
# --------------------------------------------------------------------------- #
def test_build_payload_shape_with_cwd():
    doc = _doc(
        name="excel", command="uv",
        args=["--directory", "${local_servers_paths}/excel-mcp-server", "run"],
        cwd="${agent_workspace}",
    )
    p = build_entry_payload(doc, source="excel.yaml")
    assert p["name"] == f"{NAME_PREFIX}excel"
    assert p["kind"] == "mcp"
    assert p["config"] == {
        "command": "uv",
        "args": ["--directory", "/opt/local_servers/excel-mcp-server", "run"],
        "cwd": "/workspace",
    }
    assert p["secrets"] == {}
    assert "excel.yaml" in p["description"]


def test_build_payload_omits_cwd_when_absent():
    # several upstream configs deliberately omit cwd "for compatibility"
    p = build_entry_payload(_doc(name="emails"))
    assert "cwd" not in p["config"]


def test_build_payload_rejects_bad_docs():
    with pytest.raises(ValueError):
        build_entry_payload(_doc(type_="http"))
    with pytest.raises(ValueError):
        build_entry_payload({"type": "stdio", "params": {"command": "x"}})  # no name
    with pytest.raises(ValueError):
        build_entry_payload(_doc(command=None))  # no command


# --------------------------------------------------------------------------- #
# PG env injection
# --------------------------------------------------------------------------- #
def test_pg_injection_overrides_pg_keys_only():
    doc = _doc(
        name="youtube",
        env={
            "PG_HOST": "postgres", "PG_PORT": "5432", "PG_DATABASE": "toolathlon",
            "PG_USER": "postgres", "PG_PASSWORD": "postgres",
            "OTHER_TOKEN": "placeholder",
        },
    )
    p = build_entry_payload(doc, pg_env=PG_ENV)
    assert {k: p["secrets"][k] for k in PG_ENV_KEYS} == PG_ENV
    assert p["secrets"]["OTHER_TOKEN"] == "placeholder"  # untouched


def test_pg_injection_skipped_without_pg_reference():
    doc = _doc(name="canvas", env={"CANVAS_API_TOKEN": "placeholder"})
    p = build_entry_payload(doc, pg_env=PG_ENV)
    assert p["secrets"] == {"CANVAS_API_TOKEN": "placeholder"}  # no PG keys injected


def test_placeholder_tokens_imported_verbatim():
    header = '{"Authorization": "Bearer ntn-placeholder"}'
    p = build_entry_payload(_doc(name="notion", env={"OPENAPI_MCP_HEADERS": header}))
    assert p["secrets"]["OPENAPI_MCP_HEADERS"] == header


# --------------------------------------------------------------------------- #
# Idempotency / name-collision shaping
# --------------------------------------------------------------------------- #
def test_plan_upsert_splits_create_update_and_batch_duplicates():
    payloads = [{"name": "toolathlon-a"}, {"name": "toolathlon-b"}, {"name": "toolathlon-a"}]
    plan = plan_upsert(payloads, existing_names={"toolathlon-b"})
    assert [p["name"] for p in plan["create"]] == ["toolathlon-a"]
    assert [p["name"] for p in plan["update"]] == ["toolathlon-b"]
    assert plan["duplicates"] == ["toolathlon-a"]


def test_plan_upsert_rerun_is_all_updates():
    payloads = [{"name": "toolathlon-a"}, {"name": "toolathlon-b"}]
    first = plan_upsert(payloads, existing_names=set())
    assert len(first["create"]) == 2 and first["update"] == []
    rerun = plan_upsert(payloads, existing_names={p["name"] for p in payloads})
    assert rerun["create"] == [] and len(rerun["update"]) == 2


# --------------------------------------------------------------------------- #
# Real upstream yaml fixtures
# --------------------------------------------------------------------------- #
def test_fixture_filesystem_yaml():
    docs = dict(load_config_files(FIXTURES))
    p = build_entry_payload(docs["filesystem.yaml"], source="filesystem.yaml")
    assert p["name"] == "toolathlon-filesystem"
    assert p["config"] == {
        "command": "node",
        "args": ["/opt/local_servers/filesystem/dist/index.js", "/workspace"],
        "cwd": "/workspace",
    }
    assert p["secrets"] == {}


def test_fixture_snowflake_yaml_gets_pg_env():
    docs = dict(load_config_files(FIXTURES))
    p = build_entry_payload(docs["snowflake.yaml"], pg_env=PG_ENV, source="snowflake.yaml")
    assert p["name"] == "toolathlon-snowflake"
    assert p["config"]["command"] == "uv"
    assert p["config"]["args"][:2] == ["--directory", "/opt/local_servers/mcp-snowflake-server"]
    assert p["config"]["cwd"] == "/workspace"
    assert p["secrets"] == PG_ENV  # the five PG_* keys, overridden from the CLI flags


# --------------------------------------------------------------------------- #
# Spawn-time resolver carries cwd into the agent's MCP_SERVERS dict
# --------------------------------------------------------------------------- #
def test_materialize_mcp_includes_cwd():
    entry = SimpleNamespace(
        kind="mcp", name="toolathlon-excel",
        config={"command": "uv", "args": ["run"], "cwd": "/workspace"},
        secrets={},
    )
    assert _materialize(entry) == {
        "name": "toolathlon-excel", "command": "uv", "args": ["run"],
        "env": {}, "cwd": "/workspace",
    }


def test_materialize_mcp_omits_cwd_when_absent():
    entry = SimpleNamespace(kind="mcp", name="gh", config={"command": "npx"}, secrets={})
    assert "cwd" not in _materialize(entry)
