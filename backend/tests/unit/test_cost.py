"""Cost calculation unit tests — exercise app.utils.cost.calculate_cost."""

from decimal import Decimal

import pytest

from app.utils.cost import calculate_cost


class _FakeSession:
    """Minimal stand-in for AsyncSession.get(Setting, key)."""

    def __init__(self, pricing: dict | None):
        self._pricing = pricing

    async def get(self, _model, key):
        if key != "model_pricing":
            return None

        class _Row:
            value = self._pricing

        return _Row() if self._pricing is not None else None


@pytest.mark.asyncio
async def test_calculate_cost_no_pricing_returns_zero():
    db = _FakeSession(None)
    cost = await calculate_cost(db, "MiniMax-M2.7", {"input_tokens": 1000, "output_tokens": 2000})
    assert cost == Decimal("0")


@pytest.mark.asyncio
async def test_calculate_cost_unknown_model_returns_zero():
    db = _FakeSession({"OtherModel": {"input_per_1m_usd": 1.0, "output_per_1m_usd": 2.0}})
    cost = await calculate_cost(db, "MiniMax-M2.7", {"input_tokens": 1_000_000, "output_tokens": 1_000_000})
    assert cost == Decimal("0")


@pytest.mark.asyncio
async def test_calculate_cost_with_pricing():
    pricing = {"MiniMax-M2.7": {"input_per_1m_usd": 0.30, "output_per_1m_usd": 1.20}}
    db = _FakeSession(pricing)
    # 1M input @ 0.30 + 1M output @ 1.20 = 1.5
    cost = await calculate_cost(db, "MiniMax-M2.7", {"input_tokens": 1_000_000, "output_tokens": 1_000_000})
    assert cost == Decimal("1.500000")


@pytest.mark.asyncio
async def test_calculate_cost_with_legacy_token_aliases():
    pricing = {"M": {"input_per_1m_usd": 1.0, "output_per_1m_usd": 1.0}}
    db = _FakeSession(pricing)
    # The webhook schema accepts input/output aliases — calculate_cost reads whichever key the dict has.
    cost = await calculate_cost(db, "M", {"input": 500_000, "output": 0})
    # 500k @ 1.0 = 0.5
    assert cost == Decimal("0.500000")
