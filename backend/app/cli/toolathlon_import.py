"""CLI: import Toolathlon-GYM MCP server configs into the workspace Registry (SPA-43).

Run inside the api container:

    docker compose exec api python -m app.cli.toolathlon_import \\
        --configs-dir /path/to/toolathlon_gym/configs/mcp_servers \\
        [--workspace-id <uuid>] \\
        [--pg-host toolathlon_pg --pg-port 5432 --pg-user eigent \\
         --pg-password camel --pg-db toolathlon_gym] \\
        [--dry-run]

Each yaml becomes a kind=mcp registry entry named ``toolathlon-<server-name>`` with
``config={command, args, cwd?}`` and ``secrets`` = their env map. Template variables
are resolved at import time (``${local_servers_paths}`` → /opt/local_servers,
``${agent_workspace}``/``${task_dir}`` → /workspace — task_dir == agent workspace in
our containers). Where a server's env references postgres (``PG_*`` keys), the
standard PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE values are overridden from
the --pg-* flags (defaults match the toolathlon_pg compose service). Upstream has no
real tokens — placeholder values are imported as-is.

Idempotent: re-running updates existing entries by unique (workspace, name).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import uuid

from sqlalchemy import select

from app.database import async_session
from app.models.registry_entry import RegistryEntry
from app.models.workspace import DEFAULT_WORKSPACE_ID
from app.registry.toolathlon_import import (
    build_entry_payload,
    load_config_files,
    plan_upsert,
)


def _build_payloads(args) -> tuple[list[dict], list[tuple[str, str]]]:
    pg_env = {
        "PG_HOST": args.pg_host,
        "PG_PORT": str(args.pg_port),
        "PG_USER": args.pg_user,
        "PG_PASSWORD": args.pg_password,
        "PG_DATABASE": args.pg_db,
    }
    payloads: list[dict] = []
    errors: list[tuple[str, str]] = []
    for filename, doc in load_config_files(args.configs_dir):
        try:
            payloads.append(build_entry_payload(doc, pg_env=pg_env, source=filename))
        except ValueError as e:
            errors.append((filename, str(e)))
    return payloads, errors


async def _import(args) -> None:
    workspace_id = uuid.UUID(args.workspace_id) if args.workspace_id else DEFAULT_WORKSPACE_ID
    payloads, errors = _build_payloads(args)
    for filename, msg in errors:
        print(f"SKIP {filename}: {msg}")
    if args.dry_run:
        print(json.dumps(payloads, indent=2, ensure_ascii=False))
        print(f"dry-run: {len(payloads)} entr(ies) would be upserted, {len(errors)} skipped")
        return

    async with async_session() as db:
        existing_rows = (
            await db.execute(
                select(RegistryEntry).where(
                    RegistryEntry.workspace_id == workspace_id,
                    RegistryEntry.name.in_([p["name"] for p in payloads]),
                )
            )
        ).scalars().all()
        by_name = {e.name: e for e in existing_rows}
        plan = plan_upsert(payloads, set(by_name))

        for p in plan["create"]:
            db.add(
                RegistryEntry(
                    workspace_id=workspace_id,
                    name=p["name"],
                    kind=p["kind"],
                    config=p["config"],
                    secrets=p["secrets"],
                    description=p["description"],
                    created_by="cli",
                )
            )
        for p in plan["update"]:
            entry = by_name[p["name"]]
            entry.config = p["config"]
            entry.secrets = p["secrets"]
            entry.description = p["description"]
        await db.commit()

    for name in plan["duplicates"]:
        print(f"DUPLICATE in batch (kept first): {name}")
    print(
        f"imported {len(payloads)} server(s) into workspace {workspace_id}: "
        f"{len(plan['create'])} created, {len(plan['update'])} updated, "
        f"{len(errors)} skipped"
    )


def main() -> None:
    p = argparse.ArgumentParser(
        description="Import Toolathlon-GYM MCP server yaml configs into the Registry (SPA-43)",
        epilog=(
            "Example: python -m app.cli.toolathlon_import "
            "--configs-dir /opt/toolathlon_gym/configs/mcp_servers"
        ),
    )
    p.add_argument(
        "--configs-dir", required=True,
        help="directory with Toolathlon mcp_servers/*.yaml configs",
    )
    p.add_argument("--workspace-id", default=None, help="defaults to the default workspace")
    p.add_argument(
        "--pg-host", default="toolathlon_pg",
        help="PG_HOST for PG-backed servers (default: toolathlon_pg)",
    )
    p.add_argument("--pg-port", default="5432", help="PG_PORT (default: 5432)")
    p.add_argument("--pg-user", default="eigent", help="PG_USER (default: eigent)")
    p.add_argument("--pg-password", default="camel", help="PG_PASSWORD (default: camel)")
    p.add_argument(
        "--pg-db", default="toolathlon_gym", help="PG_DATABASE (default: toolathlon_gym)"
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="print the resolved registry payloads without touching the DB",
    )
    args = p.parse_args()
    asyncio.run(_import(args))


if __name__ == "__main__":
    main()
