"""SPA-69: unit tests for the Toolathlon parallel-lane helpers (pure functions).

Covers the scheduler's lane allocation/pin primitives in
``app.quality.experiments``: which lane a newly claimed run takes, the per-lane PG
host override, and the opt-in gate. No DB and no Docker — just the pure logic that
the audit flagged as untested."""

from types import SimpleNamespace

from app.quality.experiments import (
    MAX_TOOLATHLON_LANES,
    _first_free_lane,
    _lanes_enabled,
    _pg_host_for_lane,
)


def test_first_free_lane_picks_smallest_unused():
    assert _first_free_lane(set(), 4) == 0
    assert _first_free_lane({0}, 4) == 1
    assert _first_free_lane({0, 1}, 4) == 2
    # a freed lane in the middle is reused before higher indices
    assert _first_free_lane({0, 2}, 4) == 1


def test_first_free_lane_none_when_all_busy():
    assert _first_free_lane({0, 1}, 2) is None
    assert _first_free_lane({0, 1, 2, 3}, 4) is None


def test_first_free_lane_zero_lanes_is_none():
    assert _first_free_lane(set(), 0) is None


def test_pg_host_for_lane():
    assert _pg_host_for_lane(0) == "toolathlon_pg_lane_0"
    assert _pg_host_for_lane(3) == "toolathlon_pg_lane_3"
    # None → fall back to the shared default host (serial / non-lane runs)
    assert _pg_host_for_lane(None) is None


def test_lanes_enabled_is_opt_in():
    # an explicit >=1 enables; None/0 stay on the legacy serial path (None)
    assert _lanes_enabled(SimpleNamespace(n_toolathlon_lanes=2)) == 2
    assert _lanes_enabled(SimpleNamespace(n_toolathlon_lanes=1)) == 1
    assert _lanes_enabled(SimpleNamespace(n_toolathlon_lanes=None)) is None
    assert _lanes_enabled(SimpleNamespace(n_toolathlon_lanes=0)) is None


def test_max_lanes_matches_provisioned_containers():
    # the create-time cap must equal the number of toolathlon_pg_lane_<i>
    # containers in docker-compose (profile "toolathlon-lanes").
    assert MAX_TOOLATHLON_LANES == 4
