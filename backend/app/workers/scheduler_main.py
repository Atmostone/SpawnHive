"""Scheduler worker entrypoint.

Mirrors orchestrator_main but holds a different advisory lock and runs APScheduler.

Run with: `python -m app.workers.scheduler_main`
"""

import asyncio
import logging

from sqlalchemy import text

from app.database import async_session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("scheduler-worker")

LOCK_KEY = 8723452
RECHECK_SECONDS = 30


async def _try_lock(db, key: int) -> bool:
    return bool(await db.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}))


async def _unlock(db, key: int) -> None:
    await db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})


async def main() -> None:
    from app.scheduler import start_scheduler, stop_scheduler

    while True:
        async with async_session() as db:
            got = await _try_lock(db, LOCK_KEY)
            if not got:
                logger.info(
                    "scheduler advisory lock not acquired — another instance is leader; "
                    f"rechecking in {RECHECK_SECONDS}s"
                )
                await db.commit()
                await asyncio.sleep(RECHECK_SECONDS)
                continue

            logger.info("scheduler advisory lock acquired — starting APScheduler")
            try:
                await start_scheduler()
                # Park forever — APScheduler runs in its own threads.
                while True:
                    await asyncio.sleep(3600)
            finally:
                stop_scheduler()
                try:
                    await _unlock(db, LOCK_KEY)
                except Exception as e:  # pragma: no cover
                    logger.warning(f"unlock failed: {e}")
                await db.commit()


if __name__ == "__main__":
    asyncio.run(main())
