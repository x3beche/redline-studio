"""Schedules: the friendly forms the page offers, as cron, in words, and
when they come next.

A schedule is kept twice on a task: as the person gave it ("weekly, Monday,
09:00") and as five cron fields (`0 9 * * 1`) in a time zone. The friendly
form is what the page edits; the cron is what the scheduler counts with, and
any cron typed by hand is a schedule too (kind `cron`).

    daily     at HH:MM                     M H * * *
    weekdays  at HH:MM                     M H * * 1-5
    weekly    days [1..7, Monday 1], at    M H * * 1,3
    monthly   day 1..31 or -1 (the last)   M H D * *     (-1: M H L * *)
    hours     every N (1..24), minute      M */N * * *
    cron      five fields                  as typed

The fields take `*`, lists, ranges and steps (`1-5`, `*/15`, `8-18/2`), month
and day names (jan..dec, mon..sun), day of week 0 or 7 for Sunday, and `L`
alone in the day of month for its last day. As in Vixie cron, when both the
day of month and the day of week are restricted a day matching either runs.

Times are wall-clock times in the schedule's zone (zoneinfo). Europe/Istanbul,
the default, has kept +03:00 all year since 2016. Elsewhere, a time that does
not exist (the hour skipped in spring) is skipped, and a time that happens
twice (the hour repeated in autumn) runs once, the first time.

Pure functions: tests/test_sched_cron.py checks them.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = os.environ.get("REDLINE_TZ", "Europe/Istanbul") or "Europe/Istanbul"
KINDS = ("daily", "weekdays", "weekly", "monthly", "hours", "cron")
DAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
DAY_SHORT = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
DOWS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
# (low, high) of each field; day of week 0..7, 7 being Sunday again.
BOUNDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
FIELD_NAMES = ("minute", "hour", "day of month", "month", "day of week")
LOOK_DAYS = 366 * 5                 # how far ahead a next time is looked for (Feb 29 on a Monday: 28 years - not offered)


class Bad(ValueError):
    """A schedule that cannot be: the message says which part, in words."""


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo((name or DEFAULT_TZ).strip())
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
        raise Bad(f"unknown time zone: {name}") from exc


# ---------------------------------------------------------------- cron

def _num(tok: str, i: int) -> int:
    t = tok.lower()
    if i == 3 and t in MONTHS:
        return MONTHS.index(t) + 1
    if i == 4 and t in DOWS:
        return DOWS.index(t)
    if not t.isdigit():
        raise Bad(f"{FIELD_NAMES[i]}: '{tok}' is not a number")
    return int(t)


def _field(text: str, i: int) -> frozenset[int] | None:
    """The values a field allows, or None for `*` (any)."""
    lo, hi = BOUNDS[i]
    if text == "*":
        return None
    out: set[int] = set()
    for part in text.split(","):
        if not part:
            raise Bad(f"{FIELD_NAMES[i]}: an empty item")
        rng, _, step = part.partition("/")
        if step:
            if not step.isdigit() or int(step) < 1:
                raise Bad(f"{FIELD_NAMES[i]}: the step '{step}' must be a whole number from 1")
        if rng == "*":
            a, b = lo, hi
        elif "-" in rng:
            x, _, y = rng.partition("-")
            a, b = _num(x, i), _num(y, i)
        else:
            a = b = _num(rng, i)
            if step:
                b = hi
        if not (lo <= a <= hi and lo <= b <= hi):
            raise Bad(f"{FIELD_NAMES[i]}: {rng} is outside {lo}-{hi}")
        if a > b:
            raise Bad(f"{FIELD_NAMES[i]}: {rng} runs backwards")
        out.update(range(a, b + 1, int(step or 1)))
    if i == 4 and 7 in out:                      # Sunday is 0 and 7
        out.discard(7)
        out.add(0)
    return frozenset(out)


class Cron:
    """Five parsed fields."""

    def __init__(self, text: str):
        parts = (text or "").split()
        if len(parts) != 5:
            raise Bad("a cron line has five fields: minute hour day-of-month month day-of-week")
        self.text = " ".join(parts)
        self.last_day = parts[2].upper() == "L"
        self.minute, self.hour = _field(parts[0], 0), _field(parts[1], 1)
        self.dom = None if self.last_day else _field(parts[2], 2)
        self.month, self.dow = _field(parts[3], 3), _field(parts[4], 4)
        if self.minute is not None and not self.minute or self.hour is not None and not self.hour:
            raise Bad("no time of day matches")

    def day_ok(self, d) -> bool:
        if self.month is not None and d.month not in self.month:
            return False
        dow = (d.weekday() + 1) % 7               # Sunday 0
        if self.last_day:
            dom_ok = (d + timedelta(days=1)).month != d.month
            return dom_ok if self.dow is None else (dom_ok or dow in self.dow)
        if self.dom is None and self.dow is None:
            return True
        if self.dom is None:
            return dow in self.dow
        if self.dow is None:
            return d.day in self.dom
        return d.day in self.dom or dow in self.dow

    def times(self) -> list[tuple[int, int]]:
        hours = sorted(self.hour) if self.hour is not None else list(range(24))
        mins = sorted(self.minute) if self.minute is not None else list(range(60))
        return [(h, m) for h in hours for m in mins]


def parse(text: str) -> Cron:
    return Cron(text)


def next_after(cron: str | Cron, tz: str | None, after: datetime, count: int = 1) -> list[datetime]:
    """The next `count` run times strictly after `after` (aware, any zone), as
    aware UTC datetimes."""
    c = cron if isinstance(cron, Cron) else Cron(cron)
    z = zone(tz)
    if after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    after = after.astimezone(timezone.utc)
    local = after.astimezone(z)
    day = local.date()
    times = c.times()
    out: list[datetime] = []
    seen: set[datetime] = set()
    for _ in range(LOOK_DAYS):
        if c.day_ok(day):
            for h, m in times:
                wall = datetime(day.year, day.month, day.day, h, m, tzinfo=z)          # fold=0: the first of two
                utc = wall.astimezone(timezone.utc)
                # A wall time that does not exist comes back from UTC as another: skipped.
                if utc.astimezone(z).replace(tzinfo=None) != wall.replace(tzinfo=None):
                    continue
                if utc <= after or utc in seen:
                    continue
                seen.add(utc)
                out.append(utc)
                if len(out) >= count:
                    return out
        day += timedelta(days=1)
    if not out:
        raise Bad("this schedule never comes")
    return out


# ---------------------------------------------------------------- the friendly forms

_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _at(v) -> tuple[int, int]:
    m = _HHMM.match(str(v or "").strip())
    if not m:
        raise Bad("the time is HH:MM, from 00:00 to 23:59")
    return int(m.group(1)), int(m.group(2))


def _int(v, lo: int, hi: int, what: str) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise Bad(f"{what}: a whole number from {lo} to {hi}") from None
    if not lo <= n <= hi:
        raise Bad(f"{what}: a whole number from {lo} to {hi}")
    return n


def clean(s: dict | None) -> dict:
    """A friendly schedule checked and put in its one shape; Bad if it cannot be."""
    s = dict(s or {})
    kind = s.get("kind")
    if kind not in KINDS:
        raise Bad("the schedule's kind is one of: " + ", ".join(KINDS))
    if kind == "cron":
        text = " ".join(str(s.get("cron") or "").split())
        Cron(text)
        return {"kind": "cron", "cron": text}
    if kind == "hours":
        return {"kind": "hours", "every": _int(s.get("every", 1), 1, 24, "every N hours"),
                "minute": _int(s.get("minute", 0), 0, 59, "minute")}
    h, m = _at(s.get("at", "09:00"))
    at = f"{h:02d}:{m:02d}"
    if kind in ("daily", "weekdays"):
        return {"kind": kind, "at": at}
    if kind == "weekly":
        days = s.get("days") or []
        if not isinstance(days, list) or not days:
            raise Bad("weekly: at least one day")
        days = sorted({_int(d, 1, 7, "day of the week (Monday 1 - Sunday 7)") for d in days})
        return {"kind": "weekly", "days": days, "at": at}
    day = s.get("day", 1)
    day = -1 if str(day).strip().upper() in ("L", "-1", "LAST") else _int(day, 1, 31, "day of the month")
    return {"kind": "monthly", "day": day, "at": at}


def to_cron(s: dict) -> str:
    """A clean friendly schedule as five cron fields."""
    kind = s["kind"]
    if kind == "cron":
        return s["cron"]
    if kind == "hours":
        n = s["every"]
        return f"{s['minute']} {'*' if n == 1 else '0' if n == 24 else '*/' + str(n)} * * *"
    h, m = _at(s["at"])
    if kind == "daily":
        return f"{m} {h} * * *"
    if kind == "weekdays":
        return f"{m} {h} * * 1-5"
    if kind == "weekly":
        return f"{m} {h} * * " + ",".join(str(d % 7) for d in s["days"])
    return f"{m} {h} {'L' if s['day'] == -1 else s['day']} * *"


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def words(s: dict) -> str:
    """The schedule in a few English words ("Every Monday 09:00"); the page has
    them in Turkish (i18n.ts), piece by piece - see parts()."""
    kind = s["kind"]
    if kind == "cron":
        return f"cron {s['cron']}"
    if kind == "hours":
        n = s["every"]
        return ("Every hour" if n == 1 else f"Every {n} hours") + f" at :{s['minute']:02d}"
    if kind == "daily":
        return f"Every day {s['at']}"
    if kind == "weekdays":
        return f"Weekdays {s['at']}"
    if kind == "weekly":
        days = s["days"]
        if len(days) == 1:
            return f"Every {DAY_NAMES[days[0] - 1]} {s['at']}"
        if days == [6, 7]:
            return f"Weekends {s['at']}"
        return ", ".join(DAY_SHORT[d - 1] for d in days) + f" {s['at']}"
    return ("Monthly on the last day" if s["day"] == -1 else f"Monthly on the {_ordinal(s['day'])}") + f" {s['at']}"


def describe(schedule: dict | None, tz: str | None, now: datetime | None = None, count: int = 5) -> dict:
    """What the page shows beside the editor: the clean schedule, its cron, its
    words and the next `count` times (UTC ISO and the wall time in its zone)."""
    s = clean(schedule)
    z = zone(tz)
    cron = to_cron(s)
    nxt = next_after(cron, z.key, now or datetime.now(timezone.utc), count)
    return {"schedule": s, "cron": cron, "tz": z.key, "words": words(s),
            "next": [{"at": t.isoformat(), "local": t.astimezone(z).strftime("%Y-%m-%d %H:%M"),
                      "dow": t.astimezone(z).isoweekday()} for t in nxt]}
