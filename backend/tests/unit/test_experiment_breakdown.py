"""Per-cell rubric/axis breakdown helper for the SPA-73 progress matrix (pure)."""

from app.api.experiments import _top_bottom


def test_top_bottom_sorts_worst_first_and_rounds():
    rows = _top_bottom(
        {
            "Efficiency": [8.0, 8.0],
            "Loop detection": [3.0, 4.0],
            "Tool selection": [7.0],
        }
    )
    # Worst-first so the dragging axis reads off the head.
    assert [r["name"] for r in rows] == ["Loop detection", "Tool selection", "Efficiency"]
    assert rows[0]["mean"] == 3.5  # (3 + 4) / 2
    assert rows[-1]["mean"] == 8.0


def test_top_bottom_skips_empty_and_handles_none():
    assert _top_bottom({}) == []
    assert _top_bottom({"a": []}) == []
