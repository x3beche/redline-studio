"""Analytics' comparison: this period against the one before it.

    GET /api/insights/compare?period=month|week|7d|30d|custom &from=YYYY-MM-DD &to=YYYY-MM-DD

A period and the one before it of the same length:

    month   the 1st of this month (UTC) until now, against last month's
            1st until the same day and hour - so a half month is weighed
            against a half month
    week    Monday 00:00 (UTC) until now, against the week before as far
    7d/30d  today and the 6 or 29 days before it, against the 7 or 30
            days before them, as far into the last of them
    custom  from..to (whole days, UTC; to is cut at now), against the same
            number of days right before `from`

For each, the figures the Analytics room shows - LLM spend, calls and
tokens; compute time and jobs; energy; notes, runs and the agents'
questions; what running Workbench cost (backend/costs.py) - as totals,
and the drawable ones per bucket (a day, or an hour for a period under
three days), the two periods' buckets lined up from their starts so the
page can lay one over the other. The LLM-call log is read with the
overview's own rule for which calls are this space's (insights._ws_match).
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

from . import compute, insights, scope, usage

router = APIRouter(prefix="/api/insights")

PERIODS = ("month", "week", "7d", "30d", "custom")
MAX_DAYS = 366
TOKENS = insights.TOKEN_KINDS


def _day(s: str, what: str) -> datetime:
    try:
        return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{what}: a date as YYYY-MM-DD") from None


def month_back(t: datetime) -> datetime:
    """The same day and time a month earlier, the day cut to that month's last."""
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    last = (datetime(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return t.replace(year=y, month=m, day=min(t.day, last))


def spans(period: str, frm: str = "", to: str = "", now: datetime | None = None):
    """((since, until), (prev_since, prev_until)) for a period."""
    now = now or datetime.now(timezone.utc)
    if period == "month":
        a0 = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        b0 = month_back(a0)
        return (a0, now), (b0, min(b0 + (now - a0), a0))
    if period == "week":
        a0 = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        return (a0, now), (a0 - timedelta(days=7), now - timedelta(days=7))
    if period in ("7d", "30d"):
        # Whole days: today so far and the days before it, so the buckets are days.
        d = timedelta(days=int(period[:-1]))
        a0 = now.replace(hour=0, minute=0, second=0, microsecond=0) - d + timedelta(days=1)
        return (a0, now), (a0 - d, now - d)
    if period == "custom":
        a0, a1 = _day(frm, "from"), _day(to, "to") + timedelta(days=1)
        if a1 <= a0:
            raise HTTPException(400, "to: on or after from")
        if (a1 - a0).days > MAX_DAYS:
            raise HTTPException(400, f"at most {MAX_DAYS} days")
        if a0 >= now:
            raise HTTPException(400, "from: a day that has begun")
        a1 = min(a1, now)
        return (a0, a1), (a0 - (a1 - a0), a0)
    raise HTTPException(400, "period: " + ", ".join(PERIODS))


def step_for(length: timedelta) -> int:
    return 3600 if length < timedelta(days=3) else 86400


class _Buckets:
    def __init__(self, since: datetime, n: int, size: int):
        self.t0, self.n, self.size = since.timestamp(), n, size
        self.v = [0.0] * n

    def add(self, at, value: float) -> None:
        t = insights._dt(at) if not isinstance(at, datetime) else at
        if t is None:
            return
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        i = int((t.timestamp() - self.t0) // self.size)
        if 0 <= i < self.n:
            self.v[i] += value

    def out(self) -> list[float]:
        return [round(x, 6) for x in self.v]


async def figures(db, since: datetime, until: datetime, n: int, size: int) -> tuple[dict, dict]:
    """The totals and the per-bucket series of one period."""
    lo, hi = since.isoformat(), until.isoformat()
    mine = insights._ws_match(db, None if getattr(db, "workspace", scope.DEFAULT) == scope.DEFAULT
                              else await insights._in_runs(db, lo, hi))
    B = lambda: _Buckets(since, n, size)  # noqa: E731
    usd, calls, toks, cpu, jobs, wh, notes, runs, asked = B(), B(), B(), B(), B(), B(), B(), B(), B()
    tok = {k: 0 for k in TOKENS}
    failed = 0

    async def llm():
        async for r in db[usage.CALLS].find({"$and": [{"at": {"$gte": lo, "$lt": hi}}, mine]},
                                            {"at": 1, "cost_usd": 1, **{k: 1 for k in TOKENS}}):
            usd.add(r.get("at"), float(r.get("cost_usd") or 0))
            calls.add(r.get("at"), 1)
            t = 0
            for k in TOKENS:
                v = int(r.get(k) or 0)
                tok[k] += v
                t += v
            toks.add(r.get("at"), t)

    async def work():
        nonlocal failed
        async for j in db[compute.JOBS].find({"at": {"$gte": lo, "$lt": hi}}, {"at": 1, "cpu_s": 1, "rc": 1}):
            cpu.add(j.get("at"), float(j.get("cpu_s") or 0))
            jobs.add(j.get("at"), 1)
            failed += 1 if (j.get("rc") or 0) != 0 else 0

    async def machine():
        async for m in db[insights.METRICS].find({"at": {"$gte": since, "$lt": until}}, {"at": 1, "wh": 1}):
            wh.add(m.get("at"), float(m.get("wh") or 0))

    async def people():
        async for r in db.revisions.find({"created_at": {"$gte": lo, "$lt": hi}}, {"created_at": 1}):
            notes.add(r.get("created_at"), 1)
        async for r in db.runs.find({"started_at": {"$gte": lo, "$lt": hi}}, {"started_at": 1}):
            runs.add(r.get("started_at"), 1)
        async for q in db["questions"].find({"at": {"$gte": lo, "$lt": hi}}, {"at": 1}):
            asked.add(q.get("at"), 1)

    await asyncio.gather(llm(), work(), machine(), people())
    total = lambda b: round(sum(b.v), 6)  # noqa: E731
    cost = None
    try:
        from . import costs as costs_mod
        c = await costs_mod.summary(db, since, until, llm_list_usd=total(usd), machine_kwh=total(wh) / 1000)
        cost = round(float(c.get("total_usd") or 0), 6)
    except Exception:                                            # noqa: BLE001 - no costs set: the row says so
        cost = None
    totals = {"llm_usd": total(usd), "llm_calls": int(total(calls)), "tokens": int(total(toks)),
              **{f"tokens_{k}": tok[k] for k in ("input", "output", "cache_read")},
              "cpu_s": total(cpu), "jobs": int(total(jobs)), "failed": failed, "wh": total(wh),
              "notes": int(total(notes)), "runs": int(total(runs)), "questions": int(total(asked)), "cost_usd": cost}
    series = {"llm_usd": usd.out(), "tokens": toks.out(), "llm_calls": calls.out(), "cpu_s": cpu.out(),
              "jobs": jobs.out(), "wh": wh.out(), "notes": notes.out(), "runs": runs.out()}
    return totals, series


@router.get("/compare")
async def compare(period: str = "month", frm: str = Query("", alias="from"), to: str = ""):
    """This period against the one before it (see the module's doc)."""
    from .main import db
    (a0, a1), (b0, b1) = spans(period, frm, to)
    size = step_for(a1 - a0)
    n = max(1, math.ceil(max((a1 - a0).total_seconds(), (b1 - b0).total_seconds()) / size))
    d = db()
    (ta, sa), (tb, sb) = await asyncio.gather(figures(d, a0, a1, n, size), figures(d, b0, b1, n, size))
    return {"period": period, "step": size, "n": n,
            "now": {"since": a0.isoformat(), "until": a1.isoformat(), "t0": a0.timestamp(), "totals": ta, "series": sa},
            "before": {"since": b0.isoformat(), "until": b1.isoformat(), "t0": b0.timestamp(), "totals": tb, "series": sb}}
