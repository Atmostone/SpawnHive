"""Aggregated analytics over tasks (per-template, per-model, timeline)."""

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_workspace
from app.database import get_db
from app.models.task import Task, TaskStatus
from app.models.template import Template
from app.models.workspace import Workspace

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _resolve_period(period: str) -> Optional[datetime]:
    if period == "all":
        return None
    now = datetime.utcnow()
    return {
        "day": now - timedelta(days=1),
        "week": now - timedelta(days=7),
        "month": now - timedelta(days=30),
    }.get(period, now - timedelta(days=7))


def _duration_seconds_expr():
    return func.coalesce(
        func.extract("epoch", Task.completed_at - Task.started_at),
        0,
    )


@router.get("/templates")
async def template_analytics(
    period: str = Query(default="week"),
    from_dt: Optional[str] = None,
    to_dt: Optional[str] = None,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    cutoff = _resolve_period(period)

    where_clauses = [Template.workspace_id == workspace.id]
    if from_dt:
        where_clauses.append(Task.created_at >= datetime.fromisoformat(from_dt))
    elif cutoff is not None:
        where_clauses.append(Task.created_at >= cutoff)
    if to_dt:
        where_clauses.append(Task.created_at <= datetime.fromisoformat(to_dt))

    approved = case((Task.status == TaskStatus.DONE.value, 1), else_=0)
    failed = case((Task.status == TaskStatus.FAILED.value, 1), else_=0)
    inp = func.coalesce(Task.token_usage["input_tokens"].as_integer(), 0)
    out = func.coalesce(Task.token_usage["output_tokens"].as_integer(), 0)

    stmt = (
        select(
            Template.id,
            Template.name,
            func.count(Task.id).label("task_count"),
            func.avg(approved).label("approval_rate"),
            func.avg(case((Task.retry_count > 0, 1), else_=0)).label("retry_rate"),
            func.avg(failed).label("failure_rate"),
            func.avg(_duration_seconds_expr()).label("avg_time_seconds"),
            func.avg(inp).label("avg_input_tokens"),
            func.avg(out).label("avg_output_tokens"),
            func.coalesce(func.sum(Task.cost_usd), 0).label("total_cost_usd"),
        )
        .join(Task, Task.template_id == Template.id, isouter=True)
        .group_by(Template.id, Template.name)
    )
    if where_clauses:
        stmt = stmt.where(*where_clauses)

    rows = (await db.execute(stmt)).all()
    out_list = []
    for r in rows:
        count = int(r.task_count or 0)
        out_list.append({
            "template_id": str(r.id),
            "template_name": r.name,
            "task_count": count,
            "approval_rate": float(r.approval_rate or 0),
            "retry_rate": float(r.retry_rate or 0),
            "failure_rate": float(r.failure_rate or 0),
            "avg_time_seconds": float(r.avg_time_seconds or 0),
            "avg_input_tokens": float(r.avg_input_tokens or 0),
            "avg_output_tokens": float(r.avg_output_tokens or 0),
            "total_cost_usd": float(r.total_cost_usd or 0),
            "cost_per_task_usd": (float(r.total_cost_usd or 0) / count) if count else 0,
        })
    return out_list


@router.get("/timeline")
async def timeline(
    days: int = Query(default=30, ge=1, le=365),
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.utcnow() - timedelta(days=days)
    inp = func.coalesce(Task.token_usage["input_tokens"].as_integer(), 0)
    out = func.coalesce(Task.token_usage["output_tokens"].as_integer(), 0)
    bucket = func.date_trunc("day", Task.created_at).label("day")
    stmt = (
        select(
            bucket,
            func.count(Task.id).label("task_count"),
            func.coalesce(func.sum(Task.cost_usd), 0).label("total_cost_usd"),
            func.coalesce(func.sum(inp + out), 0).label("total_tokens"),
        )
        .where(
            Task.created_at >= since,
            Task.workspace_id == workspace.id,
        )
        .group_by(bucket)
        .order_by(bucket)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {
            "date": r.day.date().isoformat() if r.day else None,
            "task_count": int(r.task_count),
            "total_cost_usd": float(r.total_cost_usd),
            "total_tokens": int(r.total_tokens or 0),
        }
        for r in rows
    ]


@router.get("/models")
async def model_analytics(
    period: str = Query(default="week"),
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    cutoff = _resolve_period(period)
    inp = func.coalesce(Task.token_usage["input_tokens"].as_integer(), 0)
    out = func.coalesce(Task.token_usage["output_tokens"].as_integer(), 0)
    stmt = (
        select(
            Task.model_used,
            func.count(Task.id).label("task_count"),
            func.coalesce(func.sum(Task.cost_usd), 0).label("total_cost_usd"),
            func.avg(inp).label("avg_input_tokens"),
            func.avg(out).label("avg_output_tokens"),
        )
        .where(Task.workspace_id == workspace.id)
        .group_by(Task.model_used)
    )
    if cutoff is not None:
        stmt = stmt.where(Task.created_at >= cutoff)
    rows = (await db.execute(stmt)).all()
    return [
        {
            "model": r.model_used or "unknown",
            "task_count": int(r.task_count),
            "total_cost_usd": float(r.total_cost_usd),
            "avg_input_tokens": float(r.avg_input_tokens or 0),
            "avg_output_tokens": float(r.avg_output_tokens or 0),
        }
        for r in rows
    ]
