"""Toolathlon executable-eval helpers + case freezing (SPA-45 → runner).

Pure: no Docker, no DB. The container mechanics are stubbed at the boundary in
the lifecycle integration test; here we only check placeholder substitution, the
gym data-quirk detector, and that the benchmark freeze carries the new fields.
"""

from app.quality import external_eval as ext_eval
from app.quality.experiments import (
    _external_eval,
    _requires_toolathlon_pg,
    cases_from_suite,
)


def test_substitute_resolves_all_placeholders_and_python():
    cmd = (
        "python ${TOOLATHLON_GYM_PATH}/tasks/x/evaluation/main.py "
        "--agent_workspace ${AGENT_WORKSPACE} "
        "--groundtruth_workspace ${GROUNDTRUTH_WORKSPACE} "
        "--launch_time ${LAUNCH_TIME} --res_log_file ${RES_LOG_FILE}"
    )
    out = ext_eval.substitute(
        cmd,
        gt="/gym/tasks/x/groundtruth_workspace",
        launch_time="2026-06-14 10:00:00 Saturday",
        res_log="/agent_ws/.eval_log.json",
    )
    assert out.startswith("/opt/venv/bin/python /gym/tasks/x/evaluation/main.py")
    assert "--agent_workspace /agent_ws" in out
    assert "--groundtruth_workspace /gym/tasks/x/groundtruth_workspace" in out
    assert "--launch_time '2026-06-14 10:00:00 Saturday'" in out
    assert "--res_log_file /agent_ws/.eval_log.json" in out
    assert "${" not in out  # every placeholder resolved


def test_substitute_preprocess_without_groundtruth():
    cmd = (
        "python ${TOOLATHLON_GYM_PATH}/tasks/x/preprocess/main.py "
        "--agent_workspace ${AGENT_WORKSPACE} --launch_time ${LAUNCH_TIME}"
    )
    out = ext_eval.substitute(cmd, gt=None, launch_time="X", res_log="/agent_ws/.pre_log.json")
    assert out.startswith("/opt/venv/bin/python")
    assert "/gym/tasks/x/preprocess/main.py" in out
    assert "${" not in out


def test_has_unconverted_data_error():
    assert ext_eval.has_unconverted_data_error("ValueError: unconverted data remains:  Saturday")
    assert not ext_eval.has_unconverted_data_error("evaluation passed")
    assert not ext_eval.has_unconverted_data_error(None)


def test_launch_time_pair_short_is_prefix_of_long():
    long_lt, short_lt = ext_eval.launch_time_pair()
    assert long_lt.startswith(short_lt)  # long == short + " <weekday>"
    assert len(short_lt) == len("2026-06-14 10:00:00")
    assert len(long_lt) > len(short_lt)


def test_cases_from_suite_carries_external_eval_environment_meta():
    cases = cases_from_suite("toolathlon")
    assert cases, "toolathlon suite should contain cases"
    c = cases[0]
    ext = c.get("external_eval")
    assert ext and ext["preprocess_command"] and ext["eval_command"]
    assert c["environment"]["required_services"] == ["toolathlon_pg"]
    assert c["meta"]["task_path"]
    assert _external_eval(c) is not None
    assert _requires_toolathlon_pg(c) is True


def test_external_eval_helpers_on_plain_case():
    assert _external_eval(None) is None
    assert _external_eval({"case_key": "x"}) is None
    # incomplete external_eval (missing eval_command) is ignored
    assert _external_eval({"external_eval": {"preprocess_command": "p"}}) is None
    assert _requires_toolathlon_pg(None) is False
    assert _requires_toolathlon_pg({"environment": {"required_services": []}}) is False
