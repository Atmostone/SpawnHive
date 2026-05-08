"""APScheduler integration: load enabled scheduled_jobs into AsyncIOScheduler."""

import logging
import uuid
from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select

from app.database import async_session
from app.models.scheduled_job import ScheduledJob
from app.models.workspace import DEFAULT_WORKSPACE_ID

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler | None:
    return _scheduler


async def _job_runner(job_id: str):
    """Execute a job by id: dispatch on its kind/payload, log to agent_events."""
    from app.utils.events import log_event
    from app.plugins.runtime import get_agent_runtime
    from sqlalchemy import func

    async with async_session() as db:
        job = await db.get(ScheduledJob, uuid.UUID(job_id))
        if not job or not job.enabled:
            return
        action = (job.payload or {}).get("action", "noop")

        if action == "daily_cost_rollup":
            from app.models.task import Task

            since = datetime.utcnow() - timedelta(days=1)
            row = (
                await db.execute(
                    select(
                        func.coalesce(func.sum(Task.cost_usd), 0),
                        func.count(Task.id),
                    ).where(
                        Task.completed_at >= since,
                        Task.workspace_id == job.workspace_id,
                    )
                )
            ).first()
            await log_event(
                db, "daily_cost_summary", "system",
                {"total_cost_usd": float(row[0] or 0), "task_count": int(row[1] or 0)},
                workspace_id=job.workspace_id,
            )

        elif action == "agent_progress_check":
            runtime = get_agent_runtime()
            for a in runtime.list_active(workspace_id=str(job.workspace_id)):
                cid = a.get("container_id")
                if not cid:
                    continue
                health = await runtime.health(cid)
                if health is not None:
                    await log_event(
                        db, "agent_health", "system",
                        {"current_step": health.get("current_step"),
                         "iteration": health.get("iteration")},
                        agent_container_id=cid,
                        workspace_id=job.workspace_id,
                    )
        else:
            await log_event(
                db, "scheduled_job_fired", "system",
                {"name": job.name, "action": action, "payload": job.payload},
                workspace_id=job.workspace_id,
            )

        job.last_fired_at = datetime.utcnow()
        if job.kind == "once":
            job.enabled = False
        await db.commit()


def _trigger_for(job: ScheduledJob):
    if job.kind == "cron" and job.cron_expr:
        return CronTrigger.from_crontab(job.cron_expr)
    if job.kind == "interval" and job.interval_seconds:
        return IntervalTrigger(seconds=int(job.interval_seconds))
    if job.kind == "once" and job.fire_at:
        return DateTrigger(run_date=job.fire_at)
    return None


def _add_job(scheduler: AsyncIOScheduler, job: ScheduledJob) -> bool:
    trigger = _trigger_for(job)
    if trigger is None:
        logger.warning(f"job {job.id} has no valid trigger ({job.kind})")
        return False
    scheduler.add_job(
        _job_runner,
        trigger=trigger,
        id=str(job.id),
        args=[str(job.id)],
        replace_existing=True,
    )
    return True


async def reload_jobs() -> int:
    if _scheduler is None:
        return 0
    async with async_session() as db:
        rows = (await db.execute(select(ScheduledJob).where(ScheduledJob.enabled.is_(True)))).scalars().all()
    for j in list(_scheduler.get_jobs()):
        _scheduler.remove_job(j.id)
    count = sum(1 for j in rows if _add_job(_scheduler, j))
    logger.info(f"scheduler: loaded {count} job(s)")
    return count


async def seed_default_jobs():
    """Create the two built-in jobs if missing (attached to default workspace)."""
    async with async_session() as db:
        rows = (await db.execute(select(ScheduledJob))).scalars().all()
        names = {r.name for r in rows}
        if "daily_cost_rollup" not in names:
            db.add(ScheduledJob(
                name="daily_cost_rollup", kind="cron", cron_expr="0 0 * * *",
                payload={"action": "daily_cost_rollup"},
                workspace_id=DEFAULT_WORKSPACE_ID,
            ))
        if "agent_progress_check" not in names:
            db.add(ScheduledJob(
                name="agent_progress_check", kind="interval", interval_seconds=60,
                payload={"action": "agent_progress_check"},
                workspace_id=DEFAULT_WORKSPACE_ID,
            ))
        await db.commit()


async def start_scheduler():
    global _scheduler
    _scheduler = AsyncIOScheduler()
    _scheduler.start()
    await seed_default_jobs()
    await reload_jobs()


def stop_scheduler():
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
