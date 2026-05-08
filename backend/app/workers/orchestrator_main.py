"""Orchestrator worker entrypoint.

Holds a Postgres advisory lock so only one orchestrator instance ever
runs at a time. Other replicas sleep+retry until the lock-holder dies.

Run with: `python -m app.workers.orchestrator_main`
"""

import asyncio
import logging

from sqlalchemy import text

from app.database import async_session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("orchestrator-worker")

# Arbitrary 32-bit int. Distinct from scheduler lock.
LOCK_KEY = 8723451
RECHECK_SECONDS = 30


async def _try_lock(db, key: int) -> bool:
    return bool(await db.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": key}))


async def _unlock(db, key: int) -> None:
    await db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})


async def main() -> None:
    from app.orchestrator.engine import orchestrator_loop

    while True:
        async with async_session() as db:
            got = await _try_lock(db, LOCK_KEY)
            if not got:
                logger.info(
                    "orchestrator advisory lock not acquired — another instance is leader; "
                    f"rechecking in {RECHECK_SECONDS}s"
                )
                await db.commit()
            else:
                logger.info("orchestrator advisory lock acquired — starting loop")
                try:
                    await orchestrator_loop()  # never returns under normal use
                finally:
                    try:
                        await _unlock(db, LOCK_KEY)
                    except Exception as e:  # pragma: no cover
                        logger.warning(f"unlock failed: {e}")
                    await db.commit()

        await asyncio.sleep(RECHECK_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
