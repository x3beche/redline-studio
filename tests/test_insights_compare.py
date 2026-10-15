"""Analytics' comparison (backend/insights_compare.py): which two periods
are weighed against each other, and how a period's figures fall into
buckets lined up from its start."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from backend import access
from backend.insights_compare import _Buckets, month_back, spans, step_for

UTC = timezone.utc
NOW = datetime(2026, 10, 15, 13, 30, tzinfo=UTC)          # a Thursday


def test_month_is_this_month_so_far_against_last_month_as_far():
    (a0, a1), (b0, b1) = spans("month", now=NOW)
    assert a0 == datetime(2026, 10, 1, tzinfo=UTC) and a1 == NOW
    assert b0 == datetime(2026, 9, 1, tzinfo=UTC) and b1 == datetime(2026, 9, 15, 13, 30, tzinfo=UTC)
    # the 31st against a 30-day month: the month before, never past its end
    (a0, a1), (b0, b1) = spans("month", now=datetime(2026, 10, 31, 23, 0, tzinfo=UTC))
    assert b1 == datetime(2026, 10, 1, tzinfo=UTC)
    assert month_back(datetime(2026, 3, 31, tzinfo=UTC)) == datetime(2026, 2, 28, tzinfo=UTC)
    assert month_back(datetime(2026, 1, 10, tzinfo=UTC)) == datetime(2025, 12, 10, tzinfo=UTC)


def test_week_and_rolling_days_are_the_same_length_before():
    (a0, a1), (b0, b1) = spans("week", now=NOW)
    assert a0 == datetime(2026, 10, 12, tzinfo=UTC) and b0 == a0 - timedelta(days=7) and b1 - b0 == a1 - a0
    (a0, a1), (b0, b1) = spans("7d", now=NOW)
    assert a0 == datetime(2026, 10, 9, tzinfo=UTC) and a1 == NOW and b1 == NOW - timedelta(days=7) and b0 == a0 - timedelta(days=7)


def test_custom_days_and_their_limits():
    (a0, a1), (b0, b1) = spans("custom", "2026-09-01", "2026-09-30", now=NOW)
    assert a0 == datetime(2026, 9, 1, tzinfo=UTC) and a1 == datetime(2026, 10, 1, tzinfo=UTC)
    assert b1 == a0 and b0 == datetime(2026, 8, 2, tzinfo=UTC)
    (a0, a1), _ = spans("custom", "2026-10-10", "2026-10-20", now=NOW)
    assert a1 == NOW                                                        # cut at now
    for bad in (("custom", "2026-10-02", "2026-10-01"), ("custom", "x", "2026-10-01"), ("custom", "2026-11-01", "2026-11-02"),
                ("custom", "2020-01-01", "2026-01-01"), ("year", "", "")):
        with pytest.raises(HTTPException):
            spans(*bad, now=NOW)


def test_buckets_line_up_from_the_start():
    assert step_for(timedelta(days=2)) == 3600 and step_for(timedelta(days=14)) == 86400
    b = _Buckets(datetime(2026, 10, 1, tzinfo=UTC), 3, 86400)
    b.add("2026-10-01T05:00:00+00:00", 1)
    b.add(datetime(2026, 10, 3, 23, tzinfo=UTC), 2)
    b.add("2026-10-04T00:00:00+00:00", 5)                                   # past the end: not counted
    b.add("2026-09-30T23:00:00", 5)                                         # before the start
    assert b.out() == [1, 0, 2]


def test_reading_it_is_a_look():
    assert access.action("GET", "/api/insights/compare") == "view"
