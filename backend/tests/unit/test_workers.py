"""Unit tests for the orchestrator/scheduler worker entrypoints.

We don't run the actual main() loops — we exercise the lock helpers and
verify behavior under (1) lock acquired, (2) lock not acquired.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.workers import orchestrator_main as orch_worker
from app.workers import scheduler_main as sched_worker


@pytest.mark.asyncio
async def test_orchestrator_try_lock_returns_bool():
    db = MagicMock()
    db.scalar = AsyncMock(return_value=True)
    assert await orch_worker._try_lock(db, 1) is True
    db.scalar.return_value = False
    assert await orch_worker._try_lock(db, 1) is False


@pytest.mark.asyncio
async def test_orchestrator_unlock_executes():
    db = MagicMock()
    db.execute = AsyncMock()
    await orch_worker._unlock(db, 1)
    db.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduler_try_lock_returns_bool():
    db = MagicMock()
    db.scalar = AsyncMock(return_value=True)
    assert await sched_worker._try_lock(db, 1) is True


@pytest.mark.asyncio
async def test_scheduler_unlock_executes():
    db = MagicMock()
    db.execute = AsyncMock()
    await sched_worker._unlock(db, 9)
    db.execute.assert_awaited_once()


def test_orchestrator_lock_keys_are_distinct():
    """Different keys per worker prevents accidentally serializing both behind one lock."""
    assert orch_worker.LOCK_KEY != sched_worker.LOCK_KEY
