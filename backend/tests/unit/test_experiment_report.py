"""Report assembly for SPA-40 experiments (pure build_report + helpers)."""

import uuid
from decimal import Decimal
from types import SimpleNamespace

from app.models.experiment import Experiment, ExperimentRun
from app.quality.experiment_report import (
    build_report,
    pareto_frontier,
    significance_matrix,
)


class TestParetoFrontier:
    def test_dominated_point_excluded(self):
        points = [
            {"config_key": "a", "quality": 8.0, "cost": 0.1, "time": 100},
            {"config_key": "b", "quality": 7.0, "cost": 0.2, "time": 200},  # dominated by a
            {"config_key": "c", "quality": 9.0, "cost": 0.5, "time": 300},  # better quality
        ]
        assert pareto_frontier(points) == ["a", "c"]

    def test_identical_points_both_on_frontier(self):
        points = [
            {"config_key": "a", "quality": 5.0, "cost": 0.1, "time": 10},
            {"config_key": "b", "quality": 5.0, "cost": 0.1, "time": 10},
        ]
        assert pareto_frontier(points) == ["a", "b"]

    def test_missing_quality_excluded(self):
        points = [
            {"config_key": "a", "quality": None, "cost": 0.0, "time": 0},
            {"config_key": "b", "quality": 1.0, "cost": 9.9, "time": 999},
        ]
        assert pareto_frontier(points) == ["b"]

    def test_empty(self):
        assert pareto_frontier([]) == []


class TestSignificanceMatrix:
    def test_separated_groups_significant(self):
        samples = {
            "cfg-01": {"weighted_score": [8.0, 8.2, 8.1, 7.9, 8.3]},
            "cfg-02": {"weighted_score": [5.0, 5.2, 5.1, 4.9, 5.3]},
        }
        entries = significance_matrix(samples)
        assert len(entries) == 1
        entry = entries[0]
        assert (entry["a"], entry["b"]) == ("cfg-01", "cfg-02")
        assert entry["significant"] is True
        assert entry["welch"]["p"] < 0.05
        assert entry["mann_whitney"]["approx"] is True

    def test_identical_distributions_not_significant(self):
        same = [6.0, 7.0, 8.0, 7.5, 6.5]
        entries = significance_matrix(
            {"cfg-01": {"weighted_score": same}, "cfg-02": {"weighted_score": list(same)}}
        )
        assert entries[0]["significant"] is False

    def test_insufficient_data_omitted(self):
        entries = significance_matrix(
            {"cfg-01": {"weighted_score": [1.0]}, "cfg-02": {"weighted_score": [2.0]}}
        )
        assert entries == []


def _exp(configs):
    return Experiment(
        configurations=configs,
        accumulated_cost_usd=Decimal("0.5"),
        budget_limit_usd=None,
    )


def _run(config_key, case_key, idx, *, status="success", score=None, traj=None,
         cost="0.01", duration=60, task_id=None, external_verdict=None):
    return ExperimentRun(
        config_key=config_key,
        case_key=case_key,
        run_index=idx,
        status=status,
        weighted_score=score,
        trajectory_score=traj,
        cost_usd=Decimal(cost),
        duration_seconds=duration,
        task_id=task_id or uuid.uuid4(),
        external_verdict=external_verdict,
    )


def _record(dimensions=None, failures=None, trajectory_axes=None, trajectory_match=None,
            human_feedback=None, cost_usd="0", quality_cost=0.0, trajectory_cost=0.0):
    return SimpleNamespace(
        cost_usd=Decimal(str(cost_usd)),
        quality_profile=(
            {"dimensions": dimensions or [], "judge_cost_usd": quality_cost}
            if (dimensions or quality_cost) else None
        ),
        failure_profile={"failures": failures} if failures else None,
        trajectory_profile=(
            {"status": "scored", "axes": trajectory_axes, "judge_cost_usd": trajectory_cost}
            if trajectory_axes else None
        ),
        trajectory_match_profile=trajectory_match,
        trajectory_evidence_profile=None,
        hallucination_profile=None,
        human_feedback=human_feedback,
    )


CONFIGS = [
    {"config_key": "cfg-01", "label": "fast", "orchestrator": False},
    {"config_key": "cfg-02", "label": "orch", "orchestrator": True},
]


def test_build_report_full_shape():
    runs, records = [], {}
    # cfg-01: strong scores; cfg-02: weaker + one failure.
    for case in ("case-a", "case-b"):
        for idx in range(3):
            r1 = _run("cfg-01", case, idx, score=8.0 + idx * 0.1, traj=7.5, cost="0.01")
            runs.append(r1)
            records[r1.task_id] = _record(
                dimensions=[
                    {"key": "correctness", "score": 8.0 + idx * 0.1},
                    {"key": "completeness", "score": 7.0},
                ],
                trajectory_axes=[
                    {"key": "efficiency", "name": "Efficiency", "score": 7.0},
                    {"key": "tool_selection", "name": "Tool selection", "score": 8.0},
                ],
            )
            r2 = _run("cfg-02", case, idx, score=5.0 + idx * 0.1, traj=5.5,
                      cost="0.05", duration=240)
            runs.append(r2)
            records[r2.task_id] = _record(
                dimensions=[{"key": "correctness", "score": 5.0 + idx * 0.1}]
            )
    failed = _run("cfg-02", "case-a", 3, status="failed", cost="0.02")
    runs.append(failed)
    records[failed.task_id] = _record(failures=[{"class": "tool_misuse"}])

    report = build_report(_exp(CONFIGS), runs, records, partial=False)

    assert report["schema_version"] == 4
    assert report["partial"] is False
    assert report["n_terminal_runs"] == 13
    # No executable verdicts here → external/rq2 present but unavailable.
    assert report["external"]["available"] is False
    assert report["rq2"]["available"] is False
    # v2: trajectory heatmap (E-07 axes) + trajectory match (E-09) blocks present
    assert "axes" in report["trajectory_heatmap"]
    assert "per_config" in report["trajectory_match"]
    assert report["trajectory_match"]["available"] is False  # no canonical trajectories here

    summary = report["summary"]
    assert summary["total_runs"] == 13
    assert summary["success"] == 12
    assert summary["failed"] == 1
    per_config = {c["config_key"]: c for c in summary["per_config"]}
    assert per_config["cfg-01"]["success_rate"] == 1.0
    assert per_config["cfg-01"]["quality_mean"] > per_config["cfg-02"]["quality_mean"]

    heatmap = report["heatmap"]
    assert heatmap["dimensions"] == ["correctness", "completeness"]
    row1 = next(r for r in heatmap["rows"] if r["config_key"] == "cfg-01")
    assert row1["cells"]["correctness"]["n"] == 6
    assert row1["cells"]["correctness"]["mean"] == 8.1
    row2 = next(r for r in heatmap["rows"] if r["config_key"] == "cfg-02")
    assert row2["cells"]["completeness"]["n"] == 0

    traj_hm = report["trajectory_heatmap"]
    assert "efficiency" in traj_hm["axes"] and "tool_selection" in traj_hm["axes"]
    row1t = next(r for r in traj_hm["rows"] if r["config_key"] == "cfg-01")
    assert row1t["cells"]["efficiency"]["n"] == 6
    assert row1t["cells"]["efficiency"]["mean"] == 7.0
    assert row1t["overall_score"]["mean"] is not None

    pareto = report["pareto"]
    assert pareto["frontier"] == ["cfg-01"]  # better quality AND cheaper AND faster
    assert all("on_frontier" in p for p in pareto["points"])

    assert len(report["scatter"]) == 12
    assert {p["config_key"] for p in report["scatter"]} == {"cfg-01", "cfg-02"}

    leaderboard = report["leaderboard"]
    assert leaderboard["source"] == "derived_pointwise"
    assert leaderboard["status"] == "ok"
    assert leaderboard["players"][0]["player"] == "cfg-01"
    assert leaderboard["players"][0]["label"] == "fast"
    assert leaderboard["players"][0]["rank"] == 1

    sig = {(e["a"], e["b"], e["metric"]): e for e in report["significance"]}
    weighted = sig[("cfg-01", "cfg-02", "weighted_score")]
    assert weighted["significant"] is True

    failure = report["failure_modes"]["per_config"]
    cfg2 = next(f for f in failure if f["config_key"] == "cfg-02")
    assert cfg2["classes"] == {"tool_misuse": 1}
    assert cfg2["statuses"]["failed"] == 1

    orch = report["orchestrator"]
    assert orch["on"]["configs"] == ["cfg-02"]
    assert orch["off"]["configs"] == ["cfg-01"]
    assert orch["delta"]["quality_mean"] < 0  # orchestrator side scored lower
    assert orch["delta"]["cost_mean"] > 0


def test_build_report_empty_runs():
    report = build_report(_exp(CONFIGS), [], {}, partial=True)
    assert report["partial"] is True
    assert report["n_terminal_runs"] == 0
    assert report["summary"]["total_runs"] == 0
    assert report["pareto"]["frontier"] == []
    assert report["leaderboard"]["status"] == "empty"
    assert report["significance"] == []
    assert report["orchestrator"]["delta"] is None


def test_build_report_external_pass_rate_and_rq2():
    # cfg-01: checker passes all 3; judge high on 2, low on 1 (pass_high=2, pass_low=1).
    # cfg-02: checker fails both; judge high on 1 (over-credit), low on 1.
    runs = [
        _run("cfg-01", "case-a", 0, score=8.0, external_verdict=True),
        _run("cfg-01", "case-a", 1, score=7.0, external_verdict=True),
        _run("cfg-01", "case-b", 0, score=3.0, external_verdict=True),
        _run("cfg-02", "case-a", 0, score=8.0, external_verdict=False),
        _run("cfg-02", "case-b", 0, score=2.0, external_verdict=False),
        # No verdict / no score → excluded from both views.
        _run("cfg-01", "case-c", 0, score=9.0, external_verdict=None),
        _run("cfg-02", "case-c", 0, score=None, external_verdict=True),
    ]
    report = build_report(_exp(CONFIGS), runs, {}, partial=False)
    assert report["schema_version"] == 4

    ext = report["external"]
    assert ext["available"] is True
    by = {c["config_key"]: c for c in ext["per_config"]}
    assert (by["cfg-01"]["n_evaluated"], by["cfg-01"]["n_pass"], by["cfg-01"]["pass_rate"]) == (3, 3, 1.0)
    # cfg-02 has 2 fails + 1 pass-without-score → 3 evaluated, 1 passed.
    assert (by["cfg-02"]["n_evaluated"], by["cfg-02"]["n_pass"]) == (3, 1)

    rq2 = report["rq2"]
    assert rq2["available"] is True
    assert rq2["judge_threshold"] == 5.0
    # Only runs with BOTH verdict and score count (5 of them).
    assert rq2["overall"]["cells"] == {"pass_high": 2, "pass_low": 1, "fail_high": 1, "fail_low": 1}
    assert rq2["overall"]["n"] == 5
    assert rq2["overall"]["agreement"] == 0.6  # (pass_high + fail_low) / n = 3/5


def test_build_report_human_feedback_aggregate():
    # cfg-01: two annotated runs — one SUCCESS/approve, one FAILED/reject. The
    # reject must be counted: human aggregation is NOT success-only (else the
    # verdict distribution would drop exactly the rejects it is about).
    r1 = _run("cfg-01", "case-a", 0, status="success", score=8.0)
    r2 = _run("cfg-01", "case-a", 1, status="failed", score=None)
    r3 = _run("cfg-02", "case-a", 0, status="success", score=5.0)
    runs = [r1, r2, r3]
    records = {
        r1.task_id: _record(human_feedback={
            "verdict": "approve",
            "dimensions": [
                {"key": "accuracy", "name": "Accuracy", "score": 9},
                {"key": "clarity", "name": "Clarity", "score": 7},
            ],
        }),
        r2.task_id: _record(human_feedback={
            "verdict": "reject",
            "dimensions": [{"key": "accuracy", "name": "Accuracy", "score": 3}],
        }),
        r3.task_id: _record(),  # no human feedback
    }
    report = build_report(_exp(CONFIGS), runs, records, partial=False)
    hf = report["human_feedback"]
    assert hf["available"] is True
    assert hf["dimensions"] == ["accuracy", "clarity"]
    assert hf["dimension_labels"]["accuracy"] == "Accuracy"
    row1 = next(r for r in hf["rows"] if r["config_key"] == "cfg-01")
    # accuracy averaged over BOTH runs (9, 3) → mean 6.0, n 2, σ 3.0
    assert row1["cells"]["accuracy"]["n"] == 2
    assert row1["cells"]["accuracy"]["mean"] == 6.0
    assert row1["cells"]["accuracy"]["std"] == 3.0
    # clarity only on the success run
    assert row1["cells"]["clarity"]["n"] == 1
    # per-run overall = mean of that run's dims: (9+7)/2=8.0 and 3.0 → config 5.5
    assert row1["overall_score"]["mean"] == 5.5
    assert row1["overall_score"]["n"] == 2
    assert row1["n_rated"] == 2
    assert row1["verdicts"] == {"approve": 1, "reject": 1, "none": 0}
    # cfg-02 had no human feedback → empty row, still present
    row2 = next(r for r in hf["rows"] if r["config_key"] == "cfg-02")
    assert row2["n_rated"] == 0
    assert row2["cells"]["accuracy"]["n"] == 0


def test_build_report_cost_breakdown():
    r1 = _run("cfg-01", "case-a", 0, status="success", cost="0.10")
    r2 = _run("cfg-02", "case-a", 0, status="success", cost="0.20")
    runs = [r1, r2]
    records = {
        r1.task_id: _record(cost_usd="0.10", quality_cost=0.02, trajectory_cost=0.01,
                            dimensions=[{"key": "a", "score": 8}],
                            trajectory_axes=[{"key": "efficiency", "name": "Efficiency", "score": 7}]),
        r2.task_id: _record(cost_usd="0.20", quality_cost=0.05, trajectory_cost=0.03,
                            dimensions=[{"key": "a", "score": 5}],
                            trajectory_axes=[{"key": "efficiency", "name": "Efficiency", "score": 5}]),
    }
    report = build_report(_exp(CONFIGS), runs, records, partial=False)
    cb = report["cost_breakdown"]
    assert cb["available"] is True
    by = {c["config_key"]: c for c in cb["per_config"]}
    assert by["cfg-01"]["agent"] == 0.10
    assert by["cfg-01"]["judge_outcome"] == 0.02
    assert by["cfg-01"]["judge_trajectory"] == 0.01
    assert by["cfg-01"]["judge_total"] == 0.03
    assert by["cfg-01"]["total"] == 0.13
    assert by["cfg-02"]["judge_evidence"] == 0.0  # E-08 off → zero (column hidden in UI)
    totals = cb["totals"]
    assert totals["agent"] == 0.30
    assert totals["judge_outcome"] == 0.07
    assert totals["judge_trajectory"] == 0.04
    assert totals["total"] == 0.41


def test_build_report_no_human_no_cost():
    report = build_report(_exp(CONFIGS), [], {}, partial=True)
    assert report["human_feedback"]["available"] is False
    assert report["human_feedback"]["dimensions"] == []
    assert report["human_feedback"]["rows"][0]["n_rated"] == 0
    assert report["cost_breakdown"]["available"] is False
    assert report["cost_breakdown"]["totals"]["total"] == 0
