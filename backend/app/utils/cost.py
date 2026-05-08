"""Cost calculation from token usage and model_pricing setting."""

import logging
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.api.settings import get_setting

logger = logging.getLogger(__name__)

_warned_models: set[str] = set()


async def calculate_cost(
    db: AsyncSession,
    model_name: str | None,
    token_usage: dict | None,
) -> Decimal:
    if not model_name:
        return Decimal("0")
    pricing = await get_setting(db, "model_pricing", {}) or {}
    rates = pricing.get(model_name)
    if not rates:
        if model_name not in _warned_models:
            _warned_models.add(model_name)
            logger.warning(f"No pricing for model {model_name}; cost=0")
        return Decimal("0")

    tu = token_usage or {}
    inp = int(tu.get("input_tokens") or tu.get("input") or 0)
    out = int(tu.get("output_tokens") or tu.get("output") or 0)
    in_rate = Decimal(str(rates.get("input_per_1m_usd", 0)))
    out_rate = Decimal(str(rates.get("output_per_1m_usd", 0)))
    cost = (Decimal(inp) / Decimal(1_000_000)) * in_rate + (
        Decimal(out) / Decimal(1_000_000)
    ) * out_rate
    return cost.quantize(Decimal("0.000001"))
