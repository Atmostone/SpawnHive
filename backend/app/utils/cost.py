"""Cost calculation from token usage and per-task denormalized prices."""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

from app.models.task import Task

logger = logging.getLogger(__name__)

_warned_tasks: set[str] = set()


def calculate_cost(task: Task, token_usage: Optional[dict] = None) -> Decimal:
    """Compute USD cost from the task's denormalized per-1M token prices.

    Prices are captured on the Task row at agent spawn time so the cost is
    stable even if the underlying LLMModel row is later edited or deleted.
    """
    if task.input_price_per_1m_usd is None and task.output_price_per_1m_usd is None:
        key = str(task.id)
        if key not in _warned_tasks:
            _warned_tasks.add(key)
            logger.warning(f"No price denorm for task {task.id}; cost=0")
        return Decimal("0")

    in_rate = Decimal(task.input_price_per_1m_usd or 0)
    out_rate = Decimal(task.output_price_per_1m_usd or 0)
    tu = token_usage if token_usage is not None else (task.token_usage or {})
    inp = int(tu.get("input_tokens") or tu.get("input") or 0)
    out = int(tu.get("output_tokens") or tu.get("output") or 0)
    cost = (Decimal(inp) / Decimal(1_000_000)) * in_rate + (
        Decimal(out) / Decimal(1_000_000)
    ) * out_rate
    return cost.quantize(Decimal("0.000001"))
