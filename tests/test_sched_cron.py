"""Schedules (backend/sched/cron.py): the friendly forms, cron, words and the
next times - in Istanbul (+03:00 all year since 2016, so exact instants) and
in a zone with summer time, for its skipped and repeated hours."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.sched import cron

UTC = timezone.utc


def nxt(c, tz, after, n=5):
    return [t.isoformat() for t in cron.next_after(c, tz, after, n)]


def test_every_monday_at_nine_in_istanbul_is_six_utc():
    after = datetime(2026, 10, 14, 21, 0, tzinfo=UTC)          # a Wednesday night
    assert nxt("0 9 * * 1", "Europe/Istanbul", after, 3) == [
        "2026-10-19T06:00:00+00:00", "2026-10-26T06:00:00+00:00", "2026-11-02T06:00:00+00:00"]


def test_istanbul_has_no_summer_time_the_offset_stays_three_hours():
    # Late March and late October, where Europe changes its clocks: Istanbul does not.
    for day in (datetime(2027, 3, 27, 12, tzinfo=UTC), datetime(2026, 10, 24, 12, tzinfo=UTC)):
        got = cron.next_after("30 2 * * *", "Europe/Istanbul", day, 3)
        assert [t.hour for t in got] == [23, 23, 23] and [t.minute for t in got] == [30, 30, 30]


def test_strictly_after_and_the_same_minute_is_not_again():
    at = datetime(2026, 10, 19, 6, 0, tzinfo=UTC)
    assert nxt("0 9 * * 1", "Europe/Istanbul", at, 1) == ["2026-10-26T06:00:00+00:00"]


def test_weekdays_skip_the_weekend():
    fri = datetime(2026, 10, 16, 7, 0, tzinfo=UTC)               # Friday 10:00 in Istanbul
    got = cron.next_after("0 9 * * 1-5", "Europe/Istanbul", fri, 2)
    assert [t.astimezone(cron.zone("Europe/Istanbul")).strftime("%a %H:%M") for t in got] == ["Mon 09:00", "Tue 09:00"]


def test_every_six_hours_and_steps_and_lists():
    at = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    assert [t.hour for t in cron.next_after("15 */6 * * *", "UTC", at, 4)] == [0, 6, 12, 18]
    assert [t.minute for t in cron.next_after("*/20 8 * * *", "UTC", at, 3)] == [0, 20, 40]
    assert [t.hour for t in cron.next_after("0 8-18/5 * * *", "UTC", at, 3)] == [8, 13, 18]


def test_month_days_31_skips_short_months_and_L_is_the_last_day():
    at = datetime(2027, 1, 31, 12, tzinfo=UTC)
    assert [t.month for t in cron.next_after("0 9 31 * *", "UTC", at, 3)] == [3, 5, 7]
    assert [t.day for t in cron.next_after("0 9 L * *", "UTC", at, 3)] == [28, 31, 30]


def test_day_of_month_and_week_both_set_is_either():
    at = datetime(2026, 10, 1, 0, tzinfo=UTC)                     # 1 Oct 2026 is a Thursday
    days = [t.day for t in cron.next_after("0 9 13 * 5", "UTC", at, 4)]
    assert days == [2, 9, 13, 16]                                  # Fridays, and the 13th


def test_names_and_sunday_as_seven():
    at = datetime(2026, 10, 14, tzinfo=UTC)
    assert cron.next_after("0 9 * * sun", "UTC", at)[0] == cron.next_after("0 9 * * 7", "UTC", at)[0] \
        == cron.next_after("0 9 * * 0", "UTC", at)[0] == datetime(2026, 10, 18, 9, tzinfo=UTC)
    assert cron.next_after("0 0 1 feb *", "UTC", at)[0] == datetime(2027, 2, 1, tzinfo=UTC)


def test_a_summer_time_gap_is_skipped_and_a_repeated_hour_runs_once():
    berlin = "Europe/Berlin"
    # 2027-03-28: 02:00 -> 03:00 in Berlin; 02:30 does not exist that day.
    got = cron.next_after("30 2 * * *", berlin, datetime(2027, 3, 27, 12, tzinfo=UTC), 2)
    assert [t.astimezone(cron.zone(berlin)).strftime("%m-%d %H:%M") for t in got] == ["03-29 02:30", "03-30 02:30"]
    # 2026-10-25: 03:00 -> 02:00; 02:30 happens twice - run once, the first time (00:30 UTC).
    got = cron.next_after("30 2 * * *", berlin, datetime(2026, 10, 24, 12, tzinfo=UTC), 2)
    assert got[0] == datetime(2026, 10, 25, 0, 30, tzinfo=UTC)
    assert got[1].astimezone(cron.zone(berlin)).day == 26


@pytest.mark.parametrize("bad", ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "5-1 * * * *",
                                 "*/0 * * * *", "x * * * *", "* * 31 2 *"])
def test_bad_cron_says_why(bad):
    with pytest.raises(cron.Bad):
        cron.next_after(bad, "UTC", datetime(2026, 1, 1, tzinfo=UTC))


def test_unknown_zone():
    with pytest.raises(cron.Bad):
        cron.zone("Mars/Olympus")


@pytest.mark.parametrize("s,c,w", [
    ({"kind": "daily", "at": "9:05"}, "5 9 * * *", "Every day 09:05"),
    ({"kind": "weekdays", "at": "08:00"}, "0 8 * * 1-5", "Weekdays 08:00"),
    ({"kind": "weekly", "days": [1], "at": "09:00"}, "0 9 * * 1", "Every Monday 09:00"),
    ({"kind": "weekly", "days": [3, 1, 3], "at": "09:00"}, "0 9 * * 1,3", "Mon, Wed 09:00"),
    ({"kind": "weekly", "days": [7, 6], "at": "10:00"}, "0 10 * * 6,0", "Weekends 10:00"),
    ({"kind": "monthly", "day": 1, "at": "07:30"}, "30 7 1 * *", "Monthly on the 1st 07:30"),
    ({"kind": "monthly", "day": -1, "at": "18:00"}, "0 18 L * *", "Monthly on the last day 18:00"),
    ({"kind": "hours", "every": 6, "minute": 15}, "15 */6 * * *", "Every 6 hours at :15"),
    ({"kind": "hours", "every": 1, "minute": 0}, "0 * * * *", "Every hour at :00"),
    ({"kind": "cron", "cron": "  0   3 * *  *"}, "0 3 * * *", "cron 0 3 * * *"),
])
def test_friendly_forms(s, c, w):
    clean = cron.clean(s)
    assert cron.to_cron(clean) == c and cron.words(clean) == w
    cron.next_after(c, "Europe/Istanbul", datetime(2026, 10, 14, tzinfo=UTC))


@pytest.mark.parametrize("s", [{"kind": "yearly"}, {"kind": "daily", "at": "25:00"}, {"kind": "weekly", "days": []},
                               {"kind": "weekly", "days": [8]}, {"kind": "monthly", "day": 32},
                               {"kind": "hours", "every": 0}, {"kind": "cron", "cron": "nope"}])
def test_friendly_forms_refused(s):
    with pytest.raises(cron.Bad):
        cron.clean(s)


def test_describe_gives_the_next_five_in_the_zone():
    d = cron.describe({"kind": "weekly", "days": [1], "at": "09:00"}, None, datetime(2026, 10, 14, 21, tzinfo=UTC))
    assert d["tz"] == "Europe/Istanbul" and d["cron"] == "0 9 * * 1" and len(d["next"]) == 5
    assert d["next"][0] == {"at": "2026-10-19T06:00:00+00:00", "local": "2026-10-19 09:00", "dow": 1}
