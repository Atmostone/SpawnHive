"""Unit tests for the deterministic loop detector (E-07 anchor)."""

from app.quality.trace_loops import detect_loops


def _tool(tool_name, content="", seq=0):
    return {"kind": "tool", "tool_name": tool_name, "content": content, "seq": seq}


def test_no_tool_steps_is_no_loop():
    out = detect_loops([{"kind": "reasoning", "content": "thinking"}])
    assert out["n_actions"] == 0
    assert out["loop_detected"] is False
    assert out["max_repeat_run"] == 0
    assert out["loop_score"] == 10.0


def test_empty_and_none():
    for arg in ([], None):
        out = detect_loops(arg)
        assert out["loop_detected"] is False
        assert out["n_actions"] == 0


def test_distinct_actions_no_loop():
    steps = [_tool("search", "a"), _tool("read", "b"), _tool("write", "c")]
    out = detect_loops(steps)
    assert out["n_actions"] == 3
    assert out["max_repeat_run"] == 1
    assert out["max_cycle_repeats"] == 0
    assert out["repeated_action_ratio"] == 0.0
    assert out["loop_detected"] is False
    assert out["loop_score"] == 10.0


def test_exact_stuck_repeat_flagged():
    # same tool + identical content three times in a row → stuck
    steps = [_tool("api_call", "ERROR: timeout")] * 3 + [_tool("write", "done")]
    out = detect_loops(steps)
    assert out["max_repeat_run"] == 3
    assert out["loop_detected"] is True
    # 2 of the 3 api_call actions are exact duplicates of the first → 2/4
    assert out["repeated_action_ratio"] == 0.5
    assert out["loop_score"] < 10.0


def test_same_tool_different_content_is_not_a_stuck_loop():
    # paginating: same tool, DIFFERENT content each time — genuine progress
    steps = [_tool("fetch_page", f"page {i}") for i in range(5)]
    out = detect_loops(steps)
    assert out["max_repeat_run"] == 1  # never identical consecutively
    assert out["max_same_tool_run"] == 5  # but same tool throughout (context)
    assert out["max_cycle_repeats"] == 0
    # conservative: a same-tool run with varying content is NOT flagged as a loop
    assert out["loop_detected"] is False
    # …but it is no longer a perfect 10.0 — a long same-tool run softly dents the score
    assert out["loop_score"] == 8.0  # (5 - 3) * 1.0 penalty


def test_deep_same_tool_run_penalizes_score_without_flagging():
    # 8-deep same-tool hammering, content varies → still not a hard loop, but the
    # score must reflect it (was a misleading perfect 10.0 before the fix)
    steps = [_tool("api", f"attempt {i} failed") for i in range(8)]
    out = detect_loops(steps)
    assert out["max_same_tool_run"] == 8
    assert out["max_repeat_run"] == 1 and out["max_cycle_repeats"] == 0
    assert out["loop_detected"] is False
    assert out["loop_score"] == 5.0  # (8 - 3) * 1.0


def test_phase_shifted_cycle_is_detected():
    # [x,y] prefix then xyz×3 — a greedy left-anchored scan misses this (reports 2);
    # the phase-aware scan must find xyz repeated 3× → loop. (review regression)
    tools = ["x", "y"] + ["x", "y", "z"] * 3
    steps = [_tool(t, f"{t}{i}") for i, t in enumerate(tools)]
    out = detect_loops(steps)
    assert out["max_cycle_repeats"] >= 3
    assert out["loop_detected"] is True


def test_realistic_exploration_then_loop():
    # one exploratory search→click, then a stuck search→click→read cycle ×3
    tools = ["search", "click"] + ["search", "click", "read"] * 3
    steps = [_tool(t, f"{t}{i}") for i, t in enumerate(tools)]
    out = detect_loops(steps)
    assert out["max_cycle_repeats"] >= 3
    assert out["loop_detected"] is True


def test_multi_step_tandem_cycle_flagged():
    # search → click repeated 3× (content differs each time)
    steps = []
    for i in range(3):
        steps.append(_tool("search", f"q{i}"))
        steps.append(_tool("click", f"r{i}"))
    out = detect_loops(steps)
    assert out["max_repeat_run"] == 1  # no identical-consecutive
    assert out["max_cycle_repeats"] == 3
    assert out["loop_detected"] is True
    top = out["cycles"][0]
    assert top["pattern"] == ["search", "click"]
    assert top["period"] == 2 and top["repeats"] == 3


def test_two_iterations_of_a_cycle_is_not_yet_flagged():
    # one A→B→A→B (2 repeats) is recorded but below the loop threshold (3)
    steps = [_tool("a", "1"), _tool("b", "2"), _tool("a", "3"), _tool("b", "4")]
    out = detect_loops(steps)
    assert out["max_cycle_repeats"] == 2
    assert out["loop_detected"] is False  # 2 < _MIN_CYCLE_REPEATS


def test_normalization_ignores_whitespace_and_case():
    steps = [_tool("t", "Same  Output\n"), _tool("t", "same output")]
    out = detect_loops(steps)
    # normalized identical → counts as a consecutive identical repeat
    assert out["max_repeat_run"] == 2
    assert out["repeated_action_ratio"] == 0.5


def test_malformed_steps_do_not_crash():
    steps = [_tool("ok", "x"), {"kind": "tool"}, {"kind": "tool", "tool_name": None}, 42]
    out = detect_loops(steps)
    # only the one valid tool step counts; no crash
    assert out["n_actions"] == 1
    assert out["loop_detected"] is False


def test_loop_score_decreases_with_severity():
    clean = detect_loops([_tool("a", "1"), _tool("b", "2")])
    loopy = detect_loops([_tool("a", "x")] * 6)
    assert clean["loop_score"] == 10.0
    assert loopy["loop_score"] == 0.0  # run of 6 → full penalty
    assert loopy["loop_detected"] is True
