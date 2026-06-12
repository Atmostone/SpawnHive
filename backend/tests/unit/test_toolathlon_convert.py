"""Unit tests for the Toolathlon → Benchmark Case Store adapter (SPA-44).

Covers: external_eval / environment schema validation, the converter on the
synthetic fixture task (tests/fixtures/toolathlon_task/), CLI selection helpers,
and a suite round-trip of a generated YAML through load_cases.
"""

import shutil
from pathlib import Path

import pytest
import yaml

from app.cli.toolathlon_convert import (
    GYM_PLACEHOLDER,
    convert_task,
    dump_case_yaml,
    family_of,
    humanize,
    main as convert_main,
    parse_families,
    select_tasks,
)
from app.quality import benchmark
from app.quality.benchmark import BenchmarkCase, CaseExternalEval, load_cases

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
FIXTURE_TASK = FIXTURES / "toolathlon_task"


# --- schema: gold.external_eval + environment -------------------------------


def _case_dict(**gold):
    return {
        "id": "t1",
        "suite": "toolathlon",
        "input": {"title": "T", "description": "d"},
        "gold": gold,
    }


def test_external_eval_good_shape():
    case = BenchmarkCase(**_case_dict(external_eval={
        "preprocess_command": "python pre.py --launch_time ${LAUNCH_TIME}",
        "eval_command": "python eval.py --agent_workspace ${AGENT_WORKSPACE}",
        "groundtruth_path": "tasks/finalpool/t1/groundtruth_workspace",
    }))
    assert case.gold.external_eval.groundtruth_path.endswith("groundtruth_workspace")


def test_external_eval_groundtruth_optional():
    case = BenchmarkCase(**_case_dict(external_eval={
        "preprocess_command": "python pre.py",
        "eval_command": "python eval.py",
    }))
    assert case.gold.external_eval.groundtruth_path is None


@pytest.mark.parametrize("bad", [
    {"preprocess_command": "", "eval_command": "python eval.py"},
    {"preprocess_command": "python pre.py", "eval_command": "   "},
    {"eval_command": "python eval.py"},          # missing preprocess_command
    {"preprocess_command": "python pre.py"},     # missing eval_command
])
def test_external_eval_bad_shapes_rejected(bad):
    with pytest.raises(Exception):
        CaseExternalEval(**bad)


def test_environment_block_parses_and_defaults():
    case = BenchmarkCase(
        **_case_dict(),
        environment={"required_services": ["toolathlon_pg"], "mcp_servers": ["canvas"]},
    )
    assert case.environment.required_services == ["toolathlon_pg"]
    assert case.environment.mcp_servers == ["canvas"]
    # absent environment stays None — existing cases are untouched
    assert BenchmarkCase(**_case_dict()).environment is None


# --- converter on the synthetic fixture task --------------------------------


def test_convert_task_fixture():
    case = convert_task(FIXTURE_TASK, FIXTURES, suite="toolathlon")
    assert case["id"] == "toolathlon_task"
    assert case["suite"] == "toolathlon"
    assert case["input"]["title"] == "Toolathlon_task"  # slug has no hyphens
    # description is docs/task.md verbatim
    assert case["input"]["description"] == (FIXTURE_TASK / "docs" / "task.md").read_text()
    assert case["gold"]["capability_spec"] == {
        "required_tools": ["canvas", "excel", "filesystem"], "match": "all",
    }
    ee = case["gold"]["external_eval"]
    assert ee["preprocess_command"] == (
        f"python {GYM_PLACEHOLDER}/toolathlon_task/preprocess/main.py"
        " --agent_workspace ${AGENT_WORKSPACE} --launch_time ${LAUNCH_TIME}"
    )
    assert ee["eval_command"] == (
        f"python {GYM_PLACEHOLDER}/toolathlon_task/evaluation/main.py"
        " --agent_workspace ${AGENT_WORKSPACE} --groundtruth_workspace ${GROUNDTRUTH_WORKSPACE}"
        " --launch_time ${LAUNCH_TIME} --res_log_file ${RES_LOG_FILE}"
    )
    assert ee["groundtruth_path"] == "toolathlon_task/groundtruth_workspace"
    assert case["environment"] == {
        "required_services": ["toolathlon_pg"],
        "mcp_servers": ["canvas", "excel", "filesystem"],
    }
    assert case["meta"]["source"] == "toolathlon_gym"
    assert case["meta"]["needed_mcp_servers"] == ["canvas", "excel", "filesystem"]
    assert "max_steps" not in case["meta"]  # absent in the fixture config
    BenchmarkCase(**case)  # validates against the store schema


def test_convert_task_without_groundtruth(tmp_path):
    task = tmp_path / "no-gt-task"
    shutil.copytree(FIXTURE_TASK, task)
    shutil.rmtree(task / "groundtruth_workspace")
    case = convert_task(task, tmp_path)
    ee = case["gold"]["external_eval"]
    assert "groundtruth_path" not in ee
    assert "--groundtruth_workspace" not in ee["eval_command"]


# --- selection helpers -------------------------------------------------------


def test_family_heuristics():
    assert family_of("sf-deal-pipeline-review") == "snowflake"
    assert family_of("wc-category-revenue") == "woocommerce"
    assert family_of("yf-dividend-tracker-gcal") == "yahoo-finance"
    assert family_of("canvas-assignment-stats") == "canvas"
    assert family_of("terminal-log-rotation") == "terminal"
    assert humanize("canvas-assignment-stats") == "Canvas Assignment Stats"


def test_parse_families_aliases_and_validation():
    assert parse_families("sf:2,woocommerce:1,fetch:3") == {
        "snowflake": 2, "woocommerce": 1, "fetch": 3,
    }
    with pytest.raises(ValueError):
        parse_families("sf:0")
    with pytest.raises(ValueError):
        parse_families("   ")


def _mk_task(pool: Path, name: str):
    shutil.copytree(FIXTURE_TASK, pool / name)


def test_select_tasks_deterministic_and_short_pool(tmp_path):
    pool = tmp_path / "tasks" / "finalpool"
    pool.mkdir(parents=True)
    for n in ("wc-b", "wc-a", "canvas-x"):
        _mk_task(pool, n)
    assert select_tasks(pool, {"woocommerce": 2, "canvas": 1}) == ["canvas-x", "wc-a", "wc-b"]
    with pytest.raises(ValueError, match="not enough tasks"):
        select_tasks(pool, {"snowflake": 1})


# --- CLI end-to-end + suite round-trip ---------------------------------------


def test_cli_generates_yaml_and_suite_round_trips(tmp_path, monkeypatch):
    gym = tmp_path / "gym"
    pool = gym / "tasks" / "finalpool"
    pool.mkdir(parents=True)
    _mk_task(pool, "canvas-mini-stats")

    suites_root = tmp_path / "benchmarks"
    out_dir = suites_root / "toolathlon"
    rc = convert_main([
        "--gym-path", str(gym),
        "--tasks", "canvas-mini-stats",
        "--out", str(out_dir),
    ])
    assert rc == 0
    out_file = out_dir / "canvas-mini-stats.yaml"
    assert out_file.is_file()

    # YAML is loadable standalone and carries the placeholder, not a real path
    raw = yaml.safe_load(out_file.read_text())
    assert GYM_PLACEHOLDER in raw["gold"]["external_eval"]["eval_command"]
    assert str(gym) not in out_file.read_text()

    # round-trip through the store loader
    monkeypatch.setattr(benchmark, "BENCHMARKS_DIR", suites_root)
    cases = load_cases("toolathlon")
    assert [c.id for c in cases] == ["canvas-mini-stats"]
    c = cases[0]
    assert c.gold.external_eval.groundtruth_path == (
        "tasks/finalpool/canvas-mini-stats/groundtruth_workspace"
    )
    assert c.environment.required_services == ["toolathlon_pg"]
    assert c.input.description == (FIXTURE_TASK / "docs" / "task.md").read_text()


def test_dump_case_yaml_multiline_literal_block():
    text = dump_case_yaml({"input": {"description": "line one\nline two\n"}})
    assert "description: |" in text
