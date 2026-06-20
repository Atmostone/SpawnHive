"""Experiment report assembly (SPA-40).

Turns the settled matrix of an experiment into the report views: per-config
summary, quality-profile heatmap (configs × rubric dimensions), Pareto
frontier (quality ↑ × cost ↓ × time ↓), outcome × trajectory scatter, a
pairwise leaderboard derived from pointwise scores (E-19 ``build_matches`` +
``rank``), statistical significance per config pair (Welch primary,
Mann-Whitney as the non-parametric check), failure-mode breakdown, and the
orchestrator on/off comparison.

``build_report`` is pure given pre-loaded rows; ``compute_report`` is the
DB-bound convenience that loads them. The API caches the result into
``experiments.report`` once the experiment is terminal.
"""

from __future__ import annotations

import statistics
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.experiment import Experiment, ExperimentRun, ExperimentRunStatus
from app.models.quality_record import QualityRecord
from app.quality.aggregation import rank
from app.quality.ranking import build_matches
from app.quality.stats import mann_whitney_u, welch_t_test

SCHEMA_VERSION = 3  # v3: external (executable pass-rate) + rq2 (verdict × judge 2×2)
SIGNIFICANCE_ALPHA = 0.05
# Outcome-judge threshold splitting "high" vs "low" in the RQ2 verdict×judge 2×2.
RQ2_JUDGE_THRESHOLD = 5.0

_SETTLED = {
    ExperimentRunStatus.SUCCESS.value,
    ExperimentRunStatus.FAILED.value,
    ExperimentRunStatus.SKIPPED.value,
}


def _mean(values: list[float]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    return round(statistics.fmean(vals), 4) if vals else None


def _std(values: list[float]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    if len(vals) < 2:
        return None
    return round(statistics.pstdev(vals), 4)


def pareto_frontier(points: list[dict]) -> list[str]:
    """Config keys on the non-dominated frontier.

    ``points``: ``[{config_key, quality, cost, time}]`` — quality higher-better,
    cost/time lower-better. A point dominates another iff it is at least as
    good on all three and strictly better on one. Points without a quality
    value are excluded (nothing to trade off)."""
    valid = [p for p in points if p.get("quality") is not None]
    frontier: list[str] = []
    for p in valid:
        pq, pc, pt = p["quality"], p.get("cost") or 0.0, p.get("time") or 0.0
        dominated = False
        for q in valid:
            if q is p:
                continue
            qq, qc, qt = q["quality"], q.get("cost") or 0.0, q.get("time") or 0.0
            if qq >= pq and qc <= pc and qt <= pt and (qq > pq or qc < pc or qt < pt):
                dominated = True
                break
        if not dominated:
            frontier.append(p["config_key"])
    return frontier


def significance_matrix(
    samples_by_config: dict[str, dict[str, list[float]]],
) -> list[dict]:
    """Welch + Mann-Whitney for every config pair × metric with enough data.

    ``significant`` is judged on the Welch p (exact); Mann-Whitney rides along
    as the non-parametric cross-check (``approx: True``). Pairs/metrics where
    neither test can run are omitted entirely."""
    out: list[dict] = []
    keys = sorted(samples_by_config)
    metrics = sorted({m for v in samples_by_config.values() for m in v})
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a_key, b_key = keys[i], keys[j]
            for metric in metrics:
                a = samples_by_config[a_key].get(metric) or []
                b = samples_by_config[b_key].get(metric) or []
                welch = welch_t_test(a, b)
                mw = mann_whitney_u(a, b)
                if welch is None and mw is None:
                    continue
                p = welch["p"] if welch is not None else mw["p"]
                out.append(
                    {
                        "a": a_key,
                        "b": b_key,
                        "metric": metric,
                        "welch": welch,
                        "mann_whitney": mw,
                        "p": p,
                        "significant": p < SIGNIFICANCE_ALPHA,
                    }
                )
    return out


def _group_means(
    runs: list[ExperimentRun],
) -> dict:
    settled = [
        r
        for r in runs
        if r.status
        in (ExperimentRunStatus.SUCCESS.value, ExperimentRunStatus.FAILED.value)
    ]
    success = [r for r in runs if r.status == ExperimentRunStatus.SUCCESS.value]
    return {
        "n_runs": len(settled),
        "success_rate": round(len(success) / len(settled), 3) if settled else None,
        "quality_mean": _mean([r.weighted_score for r in success]),
        "trajectory_mean": _mean([r.trajectory_score for r in success]),
        "cost_mean": _mean([float(r.cost_usd or 0) for r in settled]),
        "duration_mean": _mean([r.duration_seconds for r in settled]),
    }


def build_report(
    exp: Experiment,
    runs: list[ExperimentRun],
    records_by_task: dict,
    *,
    method: str = "bt",
    partial: bool = False,
) -> dict:
    """Assemble the full report from pre-loaded rows (pure)."""
    configs = {c["config_key"]: c for c in exp.configurations}
    labels = {k: c.get("label") or k for k, c in configs.items()}
    by_config: dict[str, list[ExperimentRun]] = {k: [] for k in configs}
    for r in runs:
        by_config.setdefault(r.config_key, []).append(r)

    n_terminal = sum(1 for r in runs if r.status in _SETTLED)
    success_runs = [
        r for r in runs if r.status == ExperimentRunStatus.SUCCESS.value
    ]

    # --- summary -------------------------------------------------------------
    per_config = []
    for key in sorted(by_config):
        group = by_config[key]
        stats = _group_means(group)
        per_config.append({"config_key": key, "label": labels.get(key, key), **stats})
    summary = {
        "total_runs": len(runs),
        "success": len(success_runs),
        "failed": sum(
            1 for r in runs if r.status == ExperimentRunStatus.FAILED.value
        ),
        "skipped": sum(
            1 for r in runs if r.status == ExperimentRunStatus.SKIPPED.value
        ),
        "accumulated_cost_usd": float(exp.accumulated_cost_usd or 0),
        "budget_limit_usd": float(exp.budget_limit_usd)
        if exp.budget_limit_usd is not None
        else None,
        "per_config": per_config,
    }

    # --- heatmap: configs × rubric dimensions ---------------------------------
    dim_order: list[str] = []
    dim_samples: dict[str, dict[str, list[float]]] = {k: {} for k in configs}
    for r in success_runs:
        rec = records_by_task.get(r.task_id)
        profile = (rec.quality_profile or {}) if rec is not None else {}
        for dim in profile.get("dimensions") or []:
            key, score = dim.get("key"), dim.get("score")
            if key is None or score is None:
                continue
            if key not in dim_order:
                dim_order.append(key)
            dim_samples.setdefault(r.config_key, {}).setdefault(key, []).append(
                float(score)
            )
    heatmap_rows = []
    for key in sorted(configs):
        cells = {}
        for dim_key in dim_order:
            vals = dim_samples.get(key, {}).get(dim_key) or []
            cells[dim_key] = {
                "mean": _mean(vals),
                "std": _std(vals),
                "n": len(vals),
            }
        # Success-only, to match the per-dimension cells above (built from
        # success_runs) AND the Summary "quality" column (_group_means → success).
        # Averaging weighted over ALL settled runs while the dimension cells use
        # success-only made the row self-contradictory (e.g. all dims 6-8 but
        # weighted 1.6 for a low-success-rate config). Reliability is shown
        # separately via success_rate.
        scores = [
            r.weighted_score
            for r in by_config[key]
            if r.status == ExperimentRunStatus.SUCCESS.value
            and r.weighted_score is not None
        ]
        heatmap_rows.append(
            {
                "config_key": key,
                "label": labels.get(key, key),
                "cells": cells,
                "weighted_score": {"mean": _mean(scores), "n": len(scores)},
            }
        )
    heatmap = {"dimensions": dim_order, "rows": heatmap_rows}

    # --- trajectory heatmap: configs × E-07 axes ------------------------------
    # The process-judging analogue of the quality heatmap: per-config mean of each
    # of the six trajectory axes (efficiency / tool_selection / parameter_quality /
    # error_recovery / goal_alignment / loop_detection), privileging trajectory as
    # a first-class A/B comparison rather than a single scatter axis.
    axis_order: list[str] = []
    axis_labels: dict[str, str] = {}
    axis_samples: dict[str, dict[str, list[float]]] = {}
    for r in success_runs:
        rec = records_by_task.get(r.task_id)
        tprof = (rec.trajectory_profile or {}) if rec is not None else {}
        for ax in tprof.get("axes") or []:
            key, score = ax.get("key"), ax.get("score")
            if key is None or score is None:
                continue
            if key not in axis_order:
                axis_order.append(key)
                axis_labels[key] = ax.get("name") or key
            axis_samples.setdefault(r.config_key, {}).setdefault(key, []).append(float(score))
    trajectory_heatmap_rows = []
    for key in sorted(configs):
        cells = {}
        for ax_key in axis_order:
            vals = axis_samples.get(key, {}).get(ax_key) or []
            cells[ax_key] = {"mean": _mean(vals), "std": _std(vals), "n": len(vals)}
        # Success-only, consistent with the per-axis cells (success_runs) and the
        # Summary "trajectory" column — see the weighted_score note above.
        overall = [
            r.trajectory_score
            for r in by_config[key]
            if r.status == ExperimentRunStatus.SUCCESS.value
            and r.trajectory_score is not None
        ]
        trajectory_heatmap_rows.append(
            {
                "config_key": key,
                "label": labels.get(key, key),
                "cells": cells,
                "overall_score": {"mean": _mean(overall), "n": len(overall)},
            }
        )
    trajectory_heatmap = {
        "axes": axis_order,
        "axis_labels": axis_labels,
        "rows": trajectory_heatmap_rows,
    }

    # --- E-09 trajectory-match per config -------------------------------------
    # Match against the canonical (gold) trajectory — the strongest "judge the
    # process" signal — aggregated per config (only cases that carry a canonical
    # trajectory produce a scored match).
    trajectory_match_rows = []
    any_match = False
    for key in sorted(configs):
        scores: list[float] = []
        matched = 0
        scored = 0
        for r in by_config[key]:
            rec = records_by_task.get(r.task_id)
            tm = (rec.trajectory_match_profile or {}) if rec is not None else {}
            if tm.get("status") != "scored":
                continue
            scored += 1
            any_match = True
            if tm.get("score") is not None:
                scores.append(float(tm["score"]))
            if tm.get("matched"):
                matched += 1
        trajectory_match_rows.append(
            {
                "config_key": key,
                "label": labels.get(key, key),
                "n_scored": scored,
                "match_rate": round(matched / scored, 4) if scored else None,
                "score_mean": _mean(scores),
            }
        )
    trajectory_match = {"available": any_match, "per_config": trajectory_match_rows}

    # --- external executable verdict (Toolathlon gold.external_eval) -----------
    # The executable checker's pass-rate per config — the ground-truth outcome
    # signal RQ2 compares the judges against (independent of E-02/E-07).
    external_per_config = []
    any_external = False
    for key in sorted(configs):
        evaluated = [r for r in by_config[key] if r.external_verdict is not None]
        passed = [r for r in evaluated if r.external_verdict]
        if evaluated:
            any_external = True
        external_per_config.append(
            {
                "config_key": key,
                "label": labels.get(key, key),
                "n_evaluated": len(evaluated),
                "n_pass": len(passed),
                "pass_rate": round(len(passed) / len(evaluated), 4) if evaluated else None,
            }
        )
    external = {"available": any_external, "per_config": external_per_config}

    # --- RQ2: executable verdict × outcome judge (2×2) ------------------------
    # Does the outcome judge agree with the executable checker? Every run with
    # both an external verdict and a weighted score lands in one quadrant;
    # agreement = (pass∧high + fail∧low) / n. The crux of "judge the process".
    def _rq2_for(subset: list[ExperimentRun]) -> dict:
        cells = {"pass_high": 0, "pass_low": 0, "fail_high": 0, "fail_low": 0}
        n = 0
        for r in subset:
            if r.external_verdict is None or r.weighted_score is None:
                continue
            n += 1
            high = float(r.weighted_score) >= RQ2_JUDGE_THRESHOLD
            if r.external_verdict and high:
                cells["pass_high"] += 1
            elif r.external_verdict:
                cells["pass_low"] += 1
            elif high:
                cells["fail_high"] += 1
            else:
                cells["fail_low"] += 1
        agree = cells["pass_high"] + cells["fail_low"]
        return {"n": n, "cells": cells, "agreement": round(agree / n, 4) if n else None}

    rq2_overall = _rq2_for(runs)
    rq2 = {
        "available": rq2_overall["n"] > 0,
        "judge_threshold": RQ2_JUDGE_THRESHOLD,
        "overall": rq2_overall,
        "per_config": [
            {"config_key": key, "label": labels.get(key, key), **_rq2_for(by_config[key])}
            for key in sorted(configs)
        ],
    }

    # --- pareto ----------------------------------------------------------------
    points = []
    for entry in per_config:
        points.append(
            {
                "config_key": entry["config_key"],
                "label": entry["label"],
                "quality": entry["quality_mean"],
                "cost": entry["cost_mean"],
                "time": entry["duration_mean"],
            }
        )
    frontier = pareto_frontier(points)
    for p in points:
        p["on_frontier"] = p["config_key"] in frontier
    pareto = {"points": points, "frontier": frontier}

    # --- outcome × trajectory scatter -------------------------------------------
    # Include SETTLED runs (success + failed) that carry both scores, tagged with
    # status — the failed-but-scored runs (judge_incomplete_runs) are the canonical
    # RQ2 "good outcome despite an unclean finish" points and must be visible, not
    # silently dropped. The frontend renders them distinctly (grey crosses).
    scatter = [
        {
            "config_key": r.config_key,
            "label": labels.get(r.config_key, r.config_key),
            "case_key": r.case_key,
            "run_index": r.run_index,
            "status": r.status,
            "outcome": r.weighted_score,
            "trajectory": r.trajectory_score,
            "cost": float(r.cost_usd or 0),
            "duration": r.duration_seconds,
            "task_id": str(r.task_id) if r.task_id else None,
        }
        for r in runs
        if r.status in _SETTLED
        and r.weighted_score is not None
        and r.trajectory_score is not None
    ]

    # --- pairwise leaderboard (derived from pointwise scores, E-19) -------------
    scored = [
        {"case": r.case_key, "player": r.config_key, "score": r.weighted_score}
        for r in success_runs
        if r.weighted_score is not None
    ]
    matches, match_meta = build_matches(scored, subject="config")
    ranking = rank(matches, method=method)
    for player in ranking.get("players") or []:
        player["label"] = labels.get(player["player"], player["player"])
    leaderboard = {
        "source": "derived_pointwise",
        "derivation": match_meta,
        **ranking,
    }

    # --- significance ------------------------------------------------------------
    samples: dict[str, dict[str, list[float]]] = {}
    for key in configs:
        group_success = [
            r
            for r in by_config[key]
            if r.status == ExperimentRunStatus.SUCCESS.value
        ]
        cfg_samples: dict[str, list[float]] = {}
        weighted = [
            r.weighted_score for r in group_success if r.weighted_score is not None
        ]
        if weighted:
            cfg_samples["weighted_score"] = weighted
        trajectory = [
            r.trajectory_score
            for r in group_success
            if r.trajectory_score is not None
        ]
        if trajectory:
            cfg_samples["trajectory_score"] = trajectory
        for dim_key, vals in dim_samples.get(key, {}).items():
            if vals:
                cfg_samples[f"dim:{dim_key}"] = vals
        if cfg_samples:
            samples[key] = cfg_samples
    significance = significance_matrix(samples)

    # --- failure modes -------------------------------------------------------------
    failure_per_config = []
    for key in sorted(configs):
        group = by_config[key]
        classes: dict[str, int] = {}
        for r in group:
            rec = records_by_task.get(r.task_id)
            profile = (rec.failure_profile or {}) if rec is not None else {}
            for failure in profile.get("failures") or []:
                cls = failure.get("class")
                if cls:
                    classes[cls] = classes.get(cls, 0) + 1
        failure_per_config.append(
            {
                "config_key": key,
                "label": labels.get(key, key),
                "statuses": {
                    status: sum(1 for r in group if r.status == status)
                    for status in sorted({r.status for r in group})
                },
                "classes": classes,
            }
        )
    failure_modes = {"per_config": failure_per_config}

    # --- orchestrator on/off comparison ----------------------------------------------
    on_keys = [k for k, c in configs.items() if c.get("orchestrator")]
    off_keys = [k for k, c in configs.items() if not c.get("orchestrator")]

    def _side(keys: list[str]) -> Optional[dict]:
        group = [r for k in keys for r in by_config.get(k, [])]
        if not group:
            return None
        return {"configs": sorted(keys), **_group_means(group)}

    on_side, off_side = _side(on_keys), _side(off_keys)
    orchestrator: dict = {"on": on_side, "off": off_side, "delta": None}
    if on_side and off_side:
        delta = {}
        for metric in ("quality_mean", "trajectory_mean", "cost_mean",
                       "duration_mean", "success_rate"):
            a, b = on_side.get(metric), off_side.get(metric)
            delta[metric] = round(a - b, 4) if (a is not None and b is not None) else None
        orchestrator["delta"] = delta  # on minus off

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.utcnow().isoformat(),
        "partial": partial,
        "n_terminal_runs": n_terminal,
        "summary": summary,
        "heatmap": heatmap,
        "trajectory_heatmap": trajectory_heatmap,
        "trajectory_match": trajectory_match,
        "external": external,
        "rq2": rq2,
        "pareto": pareto,
        "scatter": scatter,
        "leaderboard": leaderboard,
        "significance": significance,
        "failure_modes": failure_modes,
        "orchestrator": orchestrator,
    }


async def compute_report(
    db: AsyncSession, exp: Experiment, *, method: str = "bt", partial: bool = False
) -> dict:
    """Load the experiment's runs + records and assemble the report."""
    runs = (
        (
            await db.execute(
                select(ExperimentRun)
                .where(ExperimentRun.experiment_id == exp.id)
                .order_by(
                    ExperimentRun.config_key,
                    ExperimentRun.case_key,
                    ExperimentRun.run_index,
                )
            )
        )
        .scalars()
        .all()
    )
    task_ids = [r.task_id for r in runs if r.task_id]
    records_by_task: dict[uuid.UUID, QualityRecord] = {}
    if task_ids:
        rows = (
            await db.execute(
                select(QualityRecord).where(QualityRecord.task_id.in_(task_ids))
            )
        ).scalars().all()
        records_by_task = {rec.task_id: rec for rec in rows}
    return build_report(
        exp, runs, records_by_task, method=method, partial=partial
    )
