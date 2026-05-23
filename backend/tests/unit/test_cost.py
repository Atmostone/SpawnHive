"""Cost calculation unit tests — exercise app.utils.cost.calculate_cost.

The function now reads prices from per-task denormalized columns rather than a
global settings dict, so the tests use a lightweight stand-in for the Task row.
"""

from decimal import Decimal
from types import SimpleNamespace

from app.utils.cost import calculate_cost


def _task(input_price=None, output_price=None, token_usage=None, tid="t-test"):
    return SimpleNamespace(
        id=tid,
        input_price_per_1m_usd=input_price,
        output_price_per_1m_usd=output_price,
        token_usage=token_usage or {},
    )


def test_calculate_cost_no_prices_returns_zero():
    cost = calculate_cost(_task(), {"input_tokens": 1000, "output_tokens": 2000})
    assert cost == Decimal("0")


def test_calculate_cost_with_prices():
    # 1M input @ 0.30 + 1M output @ 1.20 = 1.5
    t = _task(input_price=Decimal("0.30"), output_price=Decimal("1.20"))
    cost = calculate_cost(t, {"input_tokens": 1_000_000, "output_tokens": 1_000_000})
    assert cost == Decimal("1.500000")


def test_calculate_cost_with_legacy_token_aliases():
    t = _task(input_price=Decimal("1.0"), output_price=Decimal("1.0"))
    # webhook payloads sometimes use shortened aliases.
    cost = calculate_cost(t, {"input": 500_000, "output": 0})
    assert cost == Decimal("0.500000")


def test_calculate_cost_uses_task_token_usage_when_arg_omitted():
    t = _task(
        input_price=Decimal("2.0"),
        output_price=Decimal("4.0"),
        token_usage={"input_tokens": 1_000_000, "output_tokens": 500_000},
    )
    cost = calculate_cost(t)
    # 1M @ 2 + 0.5M @ 4 = 2 + 2 = 4
    assert cost == Decimal("4.000000")
