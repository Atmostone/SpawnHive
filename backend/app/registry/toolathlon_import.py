"""Pure Toolathlon-GYM → Registry import logic (SPA-43). No DB access here.

Translates Toolathlon's stdio MCP server configs (``configs/mcp_servers/*.yaml``,
shape ``{type: stdio, name, params: {command, args, env?, cwd?}, ...}``) into our
registry-entry payloads: name ``toolathlon-<server-name>``, kind=mcp,
``config={command, args, cwd?}``, ``secrets`` = their env map.

Their template variables are resolved at import time:

- ``${local_servers_paths}`` → ``/opt/local_servers`` (pre-built servers baked into
  the toolathlon agent image);
- ``${agent_workspace}`` → ``/workspace``;
- ``${task_dir}`` → ``/workspace`` — in our containers task_dir == agent workspace:
  the agent gets a single ``/workspace`` dir that serves as both the task input dir
  and the working dir.

PostgreSQL-backed servers (snowflake, youtube, rail_12306, …) reach the task DB via
``PG_*`` env keys; :func:`build_entry_payload` overrides those with the
``toolathlon_pg`` coordinates passed by the CLI so every entry points at one DB.
Upstream has no real tokens (their ``token_key_session.py`` is a stub; notion ships a
placeholder Bearer) — placeholder values are imported verbatim.

The DB upsert lives in ``app.cli.toolathlon_import``; :func:`plan_upsert` keeps the
idempotency shaping (create vs update by registry name) unit-testable without a DB.
"""

from __future__ import annotations

from pathlib import Path

import yaml

#: Default substitutions for Toolathlon's ``${var}`` config placeholders.
DEFAULT_TEMPLATE_VARS = {
    "local_servers_paths": "/opt/local_servers",
    "agent_workspace": "/workspace",
    # task_dir == agent workspace in our containers (single /workspace dir).
    "task_dir": "/workspace",
}

#: The standard PostgreSQL env keys Toolathlon's PG-backed servers consume.
PG_ENV_KEYS = ("PG_HOST", "PG_PORT", "PG_USER", "PG_PASSWORD", "PG_DATABASE")

#: Registry-entry name prefix; the import owns the ``toolathlon-*`` namespace.
NAME_PREFIX = "toolathlon-"


def resolve_template_vars(value, variables: dict | None = None):
    """Recursively substitute ``${var}`` occurrences in strings, lists and dicts.

    Substitution is substring-based, so placeholders nested inside larger strings
    (e.g. ``"${agent_workspace}/emails_download"`` or a ``python -c`` one-liner)
    resolve too. Non-string scalars pass through untouched. ``variables`` extends or
    overrides :data:`DEFAULT_TEMPLATE_VARS`; unknown placeholders are left as-is.
    """
    merged = {**DEFAULT_TEMPLATE_VARS, **(variables or {})}
    if isinstance(value, str):
        for name, sub in merged.items():
            value = value.replace("${" + name + "}", sub)
        return value
    if isinstance(value, list):
        return [resolve_template_vars(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: resolve_template_vars(v, variables) for k, v in value.items()}
    return value


def build_entry_payload(
    doc: dict,
    *,
    variables: dict | None = None,
    pg_env: dict | None = None,
    source: str | None = None,
) -> dict:
    """One parsed Toolathlon yaml doc → a registry-entry payload (no DB ids).

    Returns ``{name, kind, config, secrets, description}`` with template vars
    resolved in command/args/env/cwd. ``config.cwd`` is only present when the yaml
    carries it (several configs omit cwd deliberately "for compatibility").

    If ``pg_env`` is given and the server's env references postgres (any ``PG_*``
    key), the standard :data:`PG_ENV_KEYS` are overridden with the ``pg_env``
    values; all other env keys (placeholder tokens included) stay as-is.

    Raises ``ValueError`` for non-stdio or malformed docs.
    """
    if not isinstance(doc, dict):
        raise ValueError("config is not a mapping")
    if (doc.get("type") or "stdio") != "stdio":
        raise ValueError(f"unsupported transport type: {doc.get('type')!r} (only stdio)")
    server_name = str(doc.get("name") or "").strip()
    if not server_name:
        raise ValueError("config has no server name")
    params = doc.get("params") or {}
    command = params.get("command")
    if not command:
        raise ValueError(f"server '{server_name}' has no command")

    config: dict = {
        "command": resolve_template_vars(str(command), variables),
        "args": [resolve_template_vars(str(a), variables) for a in (params.get("args") or [])],
    }
    cwd = params.get("cwd")
    if cwd:
        config["cwd"] = resolve_template_vars(str(cwd), variables)

    env = {str(k): resolve_template_vars(str(v), variables) for k, v in (params.get("env") or {}).items()}
    if pg_env and any(k.startswith("PG_") for k in env):
        env.update({k: str(pg_env[k]) for k in PG_ENV_KEYS if pg_env.get(k) is not None})

    description = f"Toolathlon MCP server '{server_name}'"
    if source:
        description += f" (imported from {source})"
    return {
        "name": f"{NAME_PREFIX}{server_name}",
        "kind": "mcp",
        "config": config,
        "secrets": env,
        "description": description,
    }


def load_config_files(configs_dir: str | Path) -> list[tuple[str, dict]]:
    """Load every ``*.yaml`` in ``configs_dir`` (sorted) as ``(filename, doc)``."""
    root = Path(configs_dir)
    if not root.is_dir():
        raise ValueError(f"configs dir not found: {root}")
    out: list[tuple[str, dict]] = []
    for path in sorted(root.glob("*.yaml")):
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
        out.append((path.name, doc if isinstance(doc, dict) else {}))
    return out


def plan_upsert(payloads: list[dict], existing_names: set[str]) -> dict:
    """Pure idempotency shaping for the upsert by unique ``(workspace, name)``.

    Splits ``payloads`` into ``{"create": [...], "update": [...], "duplicates":
    [name, ...]}``: a payload whose name already exists in the workspace becomes an
    update; a name repeated *within the batch* keeps the first payload and reports
    the rest under ``duplicates``. Re-running the same import therefore lands
    everything in ``update`` and changes nothing it doesn't own.
    """
    create: list[dict] = []
    update: list[dict] = []
    duplicates: list[str] = []
    seen: set[str] = set()
    for p in payloads:
        name = p["name"]
        if name in seen:
            duplicates.append(name)
            continue
        seen.add(name)
        (update if name in existing_names else create).append(p)
    return {"create": create, "update": update, "duplicates": duplicates}
