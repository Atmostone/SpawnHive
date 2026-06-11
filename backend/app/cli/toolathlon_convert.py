"""Toolathlon-GYM → Benchmark Case Store converter (SPA-44, pre-E-23).

Converts ``tasks/finalpool/<task>`` directories from a local clone of
`eigent-ai/toolathlon_gym <https://github.com/eigent-ai/toolathlon_gym>`_ into
case YAMLs under ``backend/benchmarks/toolathlon/``. The dataset itself is NOT
vendored into git — the clone stays an external dependency; committed YAML refers
to it only via the ``${TOOLATHLON_GYM_PATH}`` placeholder.

    python -m app.cli.toolathlon_convert --gym-path ~/Work/toolathlon_gym \
        --tasks canvas-assignment-stats,wc-category-revenue --out backend/benchmarks/toolathlon/
    python -m app.cli.toolathlon_convert --gym-path ~/Work/toolathlon_gym \
        --families sf:3,woocommerce:3,canvas:3,terminal:3,yf:3,fetch:3

Mapping (see docs/research-toolathlon-gym.md):
  input.title        ← task slug humanized; input.description ← docs/task.md verbatim
  meta               ← family (prefix heuristic), needed_mcp_servers, max_steps (if present)
  gold.capability_spec.required_tools ← needed_mcp_servers (set-level E-13 signal, match=all)
  gold.external_eval ← command templates for preprocess/evaluation main.py + groundtruth path
  environment        ← {required_services: [toolathlon_pg], mcp_servers: needed_mcp_servers}

Eval contract: scripts take ``--agent_workspace --groundtruth_workspace --launch_time
--res_log_file`` (uniform across all 503 tasks; preprocess takes the first and last
of the workspace/time pair). The runner MUST pass the SAME ``--launch_time`` to both
preprocess and eval, and run them where ``toolathlon_pg`` is reachable via PG* env.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from app.quality.benchmark import BenchmarkCase

GYM_PLACEHOLDER = "${TOOLATHLON_GYM_PATH}"
DEFAULT_SUITE = "toolathlon"
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "benchmarks" / DEFAULT_SUITE
TASKS_SUBDIR = Path("tasks") / "finalpool"

# Task-name prefix → canonical family (checked against the real finalpool naming).
PREFIX_TO_FAMILY = {
    "sf": "snowflake",
    "wc": "woocommerce",
    "yf": "yahoo-finance",
    "yt": "youtube",
    "pw": "playwright",
}
# Accept canonical names and common aliases in --families.
FAMILY_ALIASES = {
    "snowflake": "snowflake", "sf": "snowflake",
    "woocommerce": "woocommerce", "wc": "woocommerce",
    "yahoo-finance": "yahoo-finance", "yf": "yahoo-finance",
    "youtube": "youtube", "yt": "youtube",
    "playwright": "playwright", "pw": "playwright",
}

PREPROCESS_ARGS = "--agent_workspace ${AGENT_WORKSPACE} --launch_time ${LAUNCH_TIME}"
EVAL_ARGS = (
    "--agent_workspace ${AGENT_WORKSPACE} --groundtruth_workspace ${GROUNDTRUTH_WORKSPACE}"
    " --launch_time ${LAUNCH_TIME} --res_log_file ${RES_LOG_FILE}"
)
EVAL_ARGS_NO_GT = (
    "--agent_workspace ${AGENT_WORKSPACE}"
    " --launch_time ${LAUNCH_TIME} --res_log_file ${RES_LOG_FILE}"
)


def family_of(task_name: str) -> str:
    """Family from the task-name prefix (first hyphen-separated token)."""
    prefix = task_name.split("-", 1)[0]
    return PREFIX_TO_FAMILY.get(prefix, prefix)


_ACRONYMS = {"sf": "SF", "wc": "WC", "yf": "YF", "yt": "YT", "pw": "PW"}


def humanize(task_name: str) -> str:
    """Slug → human title: ``wc-category-revenue`` → ``WC Category Revenue``."""
    words = task_name.split("-")
    out = []
    for i, w in enumerate(words):
        if i == 0 and w in _ACRONYMS:
            out.append(_ACRONYMS[w])
        elif w.isdigit():
            out.append(w)
        else:
            out.append(w.capitalize())
    return " ".join(out)


def convert_task(task_dir: Path, gym_path: Path, suite: str = DEFAULT_SUITE) -> dict:
    """Build a Benchmark Case Store dict for one Toolathlon task directory."""
    task_dir = task_dir.resolve()
    gym_path = gym_path.resolve()
    name = task_dir.name
    rel = task_dir.relative_to(gym_path)  # raises if task_dir is outside the gym

    config_path = task_dir / "task_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    mcp_servers = list(config.get("needed_mcp_servers") or [])

    task_md = task_dir / "docs" / "task.md"
    description = task_md.read_text(encoding="utf-8")  # obfuscated text — keep verbatim

    for script in ("preprocess/main.py", "evaluation/main.py"):
        if not (task_dir / script).is_file():
            raise FileNotFoundError(f"{name}: missing {script}")

    has_gt = (task_dir / "groundtruth_workspace").is_dir()
    base = f"{GYM_PLACEHOLDER}/{rel.as_posix()}"
    external_eval = {
        "preprocess_command": f"python {base}/preprocess/main.py {PREPROCESS_ARGS}",
        "eval_command": (
            f"python {base}/evaluation/main.py {EVAL_ARGS if has_gt else EVAL_ARGS_NO_GT}"
        ),
    }
    if has_gt:
        external_eval["groundtruth_path"] = f"{rel.as_posix()}/groundtruth_workspace"

    meta: dict = {
        "source": "toolathlon_gym",
        "family": family_of(name),
        "needed_mcp_servers": list(mcp_servers),
        "task_path": rel.as_posix(),
        "license": "Apache-2.0",
    }
    max_steps = config.get("max_steps") or (config.get("meta") or {}).get("max_steps")
    if max_steps is not None:
        meta["max_steps"] = max_steps

    case = {
        "id": name,
        "suite": suite,
        "input": {"title": humanize(name), "description": description},
        "gold": {
            # copies, not the shared list — keeps the YAML free of anchors/aliases
            "capability_spec": {"required_tools": list(mcp_servers), "match": "all"},
            "external_eval": external_eval,
        },
        "environment": {
            "required_services": ["toolathlon_pg"],
            "mcp_servers": list(mcp_servers),
        },
        "meta": meta,
    }
    BenchmarkCase(**case)  # validate against the store schema before writing
    return case


# --- YAML output (literal blocks for multiline text, no line wrapping) ------


class _CaseDumper(yaml.SafeDumper):
    pass


def _str_representer(dumper, data):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_CaseDumper.add_representer(str, _str_representer)


def dump_case_yaml(case: dict) -> str:
    return yaml.dump(
        case, Dumper=_CaseDumper, sort_keys=False, allow_unicode=True, width=10**6
    )


# --- task selection ---------------------------------------------------------


def parse_families(spec: str) -> dict[str, int]:
    """``sf:3,woocommerce:2`` → ``{"snowflake": 3, "woocommerce": 2}``."""
    out: dict[str, int] = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, count = part.partition(":")
        family = FAMILY_ALIASES.get(name.strip().lower(), name.strip().lower())
        n = int(count) if count else 1
        if n <= 0:
            raise ValueError(f"family count must be positive: '{part}'")
        out[family] = out.get(family, 0) + n
    if not out:
        raise ValueError("empty --families spec")
    return out


def select_tasks(pool_dir: Path, families: dict[str, int]) -> list[str]:
    """Deterministically pick the first N task dirs (sorted) of each family."""
    remaining = dict(families)
    picked: list[str] = []
    for entry in sorted(pool_dir.iterdir()):
        if not entry.is_dir():
            continue
        fam = family_of(entry.name)
        if remaining.get(fam, 0) > 0 and (entry / "task_config.json").is_file():
            picked.append(entry.name)
            remaining[fam] -= 1
    short = {f: n for f, n in remaining.items() if n > 0}
    if short:
        raise ValueError(f"not enough tasks in pool for families: {short}")
    return picked


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Toolathlon-GYM → benchmark case YAML converter")
    p.add_argument("--gym-path", required=True, help="path to the toolathlon_gym clone")
    sel = p.add_mutually_exclusive_group(required=True)
    sel.add_argument("--tasks", help="comma-separated task dir names from tasks/finalpool/")
    sel.add_argument("--families", help="per-family counts, e.g. sf:3,woocommerce:3,canvas:3")
    p.add_argument("--out", default=str(DEFAULT_OUT), help="output suite directory")
    p.add_argument("--suite", default=DEFAULT_SUITE, help="suite name written into cases")
    args = p.parse_args(argv)

    gym_path = Path(args.gym_path).expanduser().resolve()
    pool_dir = gym_path / TASKS_SUBDIR
    if not pool_dir.is_dir():
        print(f"error: no {TASKS_SUBDIR} under {gym_path}", file=sys.stderr)
        return 2

    if args.tasks:
        names = [t.strip() for t in args.tasks.split(",") if t.strip()]
    else:
        names = select_tasks(pool_dir, parse_families(args.families))

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        task_dir = pool_dir / name
        if not task_dir.is_dir():
            print(f"error: no such task: {name}", file=sys.stderr)
            return 2
        case = convert_task(task_dir, gym_path, suite=args.suite)
        out_path = out_dir / f"{name}.yaml"
        out_path.write_text(dump_case_yaml(case), encoding="utf-8")
        print(f"  {name} → {out_path} (family={case['meta']['family']}, "
              f"mcp={len(case['environment']['mcp_servers'])})")
    print(f"converted {len(names)} task(s) into suite '{args.suite}' at {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
