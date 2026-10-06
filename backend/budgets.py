"""Budgets for the month, and where the month is heading (Settings > Costs).

A budget is an amount a month - in any currency, like every other cost -
with a warning threshold (80% unless set). There is one for the total
spend and optional ones for the LLM work at list prices, the electricity
and the proxy traffic. They are kept in the costs document as typed
(`budgets`: {kind: {amount, currency, warn}}) and turned into dollars at
the latest rate when used.

The month is the calendar month in UTC - the server's clock is UTC too,
and every timestamp the app keeps is. Month to date runs from the 1st at
00:00 UTC to now.

What counts:
  * llm          - the LLM calls at API list prices (usage.py);
  * electricity  - the machine's measured energy times the price per kWh;
  * proxy        - the bytes the proxy carried times the price per GB;
  * total        - the subscriptions and the other recurring costs, each
                   prorated by the share of the month gone, plus the
                   electricity and the proxy - and the LLM work at list
                   prices only when no subscription covers LLM work (with
                   none, the tokens are what is paid).

The forecast for month end keeps the fixed costs at their full month and
runs the metered ones (LLM, electricity, proxy) on at a daily rate: the
month's own average, or the last seven days' when that is the better
guess - while the month is less than seven days old (its own average is
a few days of noise; the seven days reach back into the month before),
or when the last seven days run more than half again above the month's
average (spending has picked up, and a budget should hear of it early).
Each budget says which basis it used, and gives both.

Crossing the threshold, and crossing 100%, each write one line in the
activity log and one in the audit trail - once per budget per month.
"""

from __future__ import annotations

import asyncio
import calendar
import logging
import uuid
from datetime import datetime, timedelta, timezone

from . import fx, scope

log = logging.getLogger("redline.budgets")

KINDS = ("total", "llm", "electricity", "proxy")
NAMES = {"total": "Total spend", "llm": "LLM work at list prices",
         "electricity": "Electricity", "proxy": "Proxy traffic"}
WARN = 0.8
TZ = timezone.utc
RECENT_DAYS = 7
PICKED_UP = 1.5                    # the last 7 days this much above the month's average: use them
ALERTS = "budget_alerts"           # machine-wide; _id "<workspace>|<YYYY-MM>|<kind>|<warn|over>"
ACTOR = {"type": "system", "id": "budgets", "name": "budgets"}
EVERY_S = 900

_seen: set[str] = set()            # alerts already written, so a check costs no write


def _raw(db):
    return db.raw if getattr(type(db), "SCOPED", False) else db


# ---------------- what is kept ----------------

def clean(patch: dict | None) -> dict:
    """The budgets as given to PUT /api/costs: {kind: {amount, currency, warn} | None}."""
    out: dict = {}
    for kind, b in (patch or {}).items():
        if kind not in KINDS:
            raise ValueError(f"no such budget: {kind}")
        if not b or b.get("amount") in (None, ""):
            continue
        cur = (b.get("currency") or "").upper()
        if not fx.known(cur):
            raise ValueError(f"{NAMES[kind]} budget: no exchange rate for {cur or 'an empty currency'}")
        amount = float(b["amount"])
        if amount <= 0:
            raise ValueError(f"{NAMES[kind]} budget: the amount must be more than 0")
        warn = b.get("warn")
        warn = WARN if warn in (None, "") else float(warn)
        if not 0.05 <= warn <= 1:
            raise ValueError(f"{NAMES[kind]} budget: the warning threshold must be between 5% and 100%")
        out[kind] = {"amount": amount, "currency": cur, "warn": round(warn, 4)}
    return out


# ---------------- the month ----------------

def month_of(now: datetime) -> tuple[datetime, datetime]:
    """The calendar month `now` is in, in UTC: [the 1st 00:00, the next 1st 00:00)."""
    now = now.astimezone(TZ) if now.tzinfo else now.replace(tzinfo=TZ)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    days = calendar.monthrange(start.year, start.month)[1]
    return start, start + timedelta(days=days)


async def _llm_usd(db, since: datetime, until: datetime) -> float:
    """The LLM calls between two moments, at list prices. The call log is the
    machine's: a workspace other than the default one counts only the calls
    made during its own runs (as insights._llm_sums does)."""
    from . import usage
    lo, hi = since.isoformat(), until.isoformat()
    match: dict = {"at": {"$gte": lo, "$lte": hi}}
    if getattr(db, "workspace", scope.DEFAULT) != scope.DEFAULT:
        runs = [r async for r in db.runs.find(
            {"started_at": {"$lte": hi}, "$or": [{"finished_at": {"$gte": lo}}, {"finished_at": None}]},
            {"started_at": 1, "finished_at": 1})]
        spans = [{"at": {"$gte": r["started_at"], "$lte": r.get("finished_at") or hi}}
                 for r in runs if r.get("started_at")]
        if not spans:
            return 0.0
        match = {"$and": [match, {"$or": spans}]}
    rows = await db[usage.CALLS].aggregate([
        {"$match": match},
        {"$group": {"_id": None, "usd": {"$sum": {"$ifNull": ["$cost_usd", 0]}}}}]).to_list(1)
    return float((rows or [{}])[0].get("usd") or 0.0)


async def _kwh(db, since: datetime, until: datetime) -> float:
    """The machine's measured energy between two moments (the sampler's)."""
    from .insights import METRICS
    rows = await db[METRICS].aggregate([
        {"$match": {"at": {"$gte": since, "$lte": until}}},
        {"$group": {"_id": None, "wh": {"$sum": {"$ifNull": ["$wh", 0]}}}}]).to_list(1)
    return float((rows or [{}])[0].get("wh") or 0.0) / 1000


async def used(db, since: datetime, until: datetime) -> dict:
    """What was metered between two moments: LLM dollars, kWh, proxy GB."""
    from . import costs
    llm, kwh, b = await asyncio.gather(_llm_usd(db, since, until), _kwh(db, since, until),
                                       costs.proxy_bytes(db, since, until))
    return {"llm_usd": llm, "kwh": kwh, "proxy_gb": b / 1e9}


# ---------------- the figures ----------------

def forecast(spent_metered: float, recent_per_day: float, *, fixed_month: float, elapsed_days: float,
             days_in_month: int) -> dict:
    """Month end, from what the metered part spent so far and its last 7 days.

    `spent_metered` is the month to date of what is metered; the fixed part
    is the full month. Returns both forecasts and the one picked."""
    left = max(0.0, days_in_month - elapsed_days)
    month_rate = spent_metered / elapsed_days if elapsed_days > 0 else 0.0
    by_month = spent_metered + month_rate * left + fixed_month
    by_recent = spent_metered + recent_per_day * left + fixed_month
    young = elapsed_days < RECENT_DAYS
    picked_up = recent_per_day > PICKED_UP * month_rate and recent_per_day > 0
    basis = "last_7d" if young or picked_up else "month_avg"
    return {"forecast_usd": by_recent if basis == "last_7d" else by_month, "basis": basis,
            "basis_why": ("the month is under 7 days old" if young
                          else "the last 7 days run well above the month's average" if picked_up
                          else "the month's daily average"),
            "forecast_month_avg_usd": by_month, "forecast_last_7d_usd": by_recent,
            "rate_month_per_day_usd": month_rate, "rate_7d_per_day_usd": recent_per_day}


def state_of(ratio: float | None, warn: float) -> str:
    if ratio is None:
        return "ok"
    return "over" if ratio >= 1 else "warn" if ratio >= warn else "ok"


def _r(v: float | None, n: int = 4) -> float | None:
    return None if v is None else round(v, n)


async def status(db, doc: dict | None = None, *, now: datetime | None = None, alert: bool = True) -> dict:
    """Every budget's month to date, its forecast and its state - and the
    alerts, the first time a budget crosses its threshold or 100% this month."""
    from . import costs
    doc = doc if doc is not None else await costs.get(db)
    now = (now or datetime.now(TZ)).astimezone(TZ)
    start, end = month_of(now)
    dim = (end - start).days
    elapsed = max((now - start).total_seconds() / 86400, 1 / 1440)   # at least a minute
    out = {"month": start.strftime("%Y-%m"), "timezone": "UTC", "start": start.isoformat(), "end": end.isoformat(),
           "days_in_month": dim, "days_elapsed": round(elapsed, 3), "days_left": round(dim - elapsed, 3),
           "recent_days": RECENT_DAYS, "items": []}
    config = doc.get("budgets") or {}
    if not config:
        return out
    d = costs.derived(doc)
    month, recent = await asyncio.gather(used(db, start, now), used(db, now - timedelta(days=RECENT_DAYS), now))
    kwh_p, gb_p = d["electricity_per_kwh"], d["proxy_per_gb"]
    has_llm_plan = bool(d["llm_subscriptions_per_month"])
    fixed = (d["subscriptions_per_month"] or 0.0) + (d["other_per_month"] or 0.0)
    # each part: (month to date, last 7 days a day), metered
    parts = {
        "llm": (month["llm_usd"], recent["llm_usd"] / RECENT_DAYS),
        "electricity": (month["kwh"] * (kwh_p or 0), recent["kwh"] * (kwh_p or 0) / RECENT_DAYS),
        "proxy": (month["proxy_gb"] * (gb_p or 0), recent["proxy_gb"] * (gb_p or 0) / RECENT_DAYS),
    }
    in_total = ["electricity", "proxy"] + ([] if has_llm_plan else ["llm"])
    parts["total"] = (sum(parts[k][0] for k in in_total), sum(parts[k][1] for k in in_total))
    missing = {"electricity": None if kwh_p is not None else "no price per kWh set",
               "proxy": None if gb_p is not None else "no price per GB set", "llm": None, "total": None}
    for kind in KINDS:
        b = config.get(kind)
        if not b:
            continue
        try:
            budget_usd = fx.to_usd(b["amount"], b["currency"])
        except ValueError:
            out["items"].append({"kind": kind, "name": NAMES[kind], **b, "error": f"no rate for {b['currency']}"})
            continue
        metered, per_day = parts[kind]
        fixed_month = fixed if kind == "total" else 0.0
        spent = metered + fixed_month * elapsed / dim
        f = forecast(metered, per_day, fixed_month=fixed_month, elapsed_days=elapsed, days_in_month=dim)
        ratio = spent / budget_usd if budget_usd else None
        f_ratio = f["forecast_usd"] / budget_usd if budget_usd else None
        item = {"kind": kind, "name": NAMES[kind], "amount": b["amount"], "currency": b["currency"],
                "warn": b.get("warn", WARN), "budget_usd": _r(budget_usd, 2), "spent_usd": _r(spent),
                "forecast_usd": _r(f["forecast_usd"]), "ratio": _r(ratio), "forecast_ratio": _r(f_ratio),
                "state": state_of(ratio, b.get("warn", WARN)),
                "forecast_state": state_of(f_ratio, b.get("warn", WARN)),
                "basis": f["basis"], "basis_why": f["basis_why"],
                "forecast_month_avg_usd": _r(f["forecast_month_avg_usd"]),
                "forecast_last_7d_usd": _r(f["forecast_last_7d_usd"]),
                "rate_month_per_day_usd": _r(f["rate_month_per_day_usd"]),
                "rate_7d_per_day_usd": _r(f["rate_7d_per_day_usd"])}
        if kind == "total":
            item["fixed_month_usd"] = _r(fixed, 2)
            item["llm_included"] = not has_llm_plan
        if missing[kind]:
            item["missing"] = missing[kind]
        out["items"].append(item)
    states = [i["state"] for i in out["items"] if "state" in i]
    out["state"] = "over" if "over" in states else "warn" if "warn" in states else "ok"
    if alert:
        try:
            await alerts(db, out, now=now)
        except Exception as exc:                       # noqa: BLE001 - an alert must not take the figures down
            log.warning("budget alerts not written: %s", exc)
    return out


# ---------------- alerts ----------------

def _pct(v: float | None) -> str:
    return "–" if v is None else f"{v * 100:.0f}%"


async def alerts(db, st: dict, *, now: datetime | None = None) -> list[dict]:
    """One activity line and one audit line the first time each budget
    crosses its threshold, and again 100%, in a month. A budget that goes
    from under its threshold straight past 100% writes one, for 100%.
    Returns what was written."""
    from pymongo.errors import DuplicateKeyError
    from . import actors
    ws = getattr(db, "workspace", scope.DEFAULT)
    raw = _raw(db)
    now = now or datetime.now(TZ)
    written = []
    for it in st.get("items") or []:
        if it.get("state") not in ("warn", "over"):
            continue
        levels = ["warn", "over"] if it["state"] == "over" else ["warn"]
        new = []
        for level in levels:
            key = f"{ws}|{st['month']}|{it['kind']}|{level}"
            if key in _seen:
                continue
            try:
                await raw[ALERTS].insert_one({"_id": key, "at": now, "workspace_id": ws, "month": st["month"],
                                              "kind": it["kind"], "level": level, "ratio": it["ratio"]})
                new.append(level)
            except DuplicateKeyError:
                pass
            _seen.add(key)
        if not new:
            continue
        level = new[-1]
        b = f"{it['amount']:g} {it['currency']}"
        text = (f"Budget: {it['name']} is {'over' if level == 'over' else 'at'} {_pct(it['ratio'])} of its "
                f"{b} for {st['month']}" + ("" if level == "over" else f" (warning at {_pct(it['warn'])})")
                + f" - forecast {_pct(it['forecast_ratio'])} by month end")
        await db.activity.insert_one({"_id": uuid.uuid4().hex[:12], "at": now.isoformat(), "text": text,
                                      "level": "error" if level == "over" else "warn", "room": "cad"})
        detail = {"month": st["month"], "level": level, "ratio": it["ratio"], "spent_usd": it["spent_usd"],
                  "budget_usd": it["budget_usd"], "forecast_usd": it["forecast_usd"], "warn": it["warn"]}
        await actors.audit(db, "budget", it["kind"], detail, actor=ACTOR)
        written.append({"kind": it["kind"], "level": level, "text": text})
    return written


async def loop(raw_getter) -> None:
    """Every quarter of an hour: each workspace's budgets, so an alert is
    written when the line is crossed, not when someone next looks."""
    from . import costs
    while True:
        await asyncio.sleep(60)
        try:
            raw = raw_getter()
            async for doc in raw.settings.find({"_id": {"$regex": f"^{costs.DOC}(@.+)?$"},
                                                "budgets": {"$exists": True, "$ne": {}}}, {"_id": 1}):
                ws = doc["_id"].split("@", 1)[1] if "@" in doc["_id"] else scope.DEFAULT
                token = scope.WORKSPACE.set(ws)
                try:
                    await status(scope.ScopedDb(raw, ws))
                finally:
                    scope.WORKSPACE.reset(token)
        except Exception as exc:                       # noqa: BLE001 - try again next time
            log.warning("budgets not checked: %s", exc)
        await asyncio.sleep(EVERY_S - 60)


def rows(st: dict) -> list[dict]:
    """The budgets flat, one row each, for Grafana (Infinity) or a script."""
    out = []
    for it in st.get("items") or []:
        if "error" in it:
            continue
        cur = it["currency"]

        def own(usd):
            try:
                return round(fx.from_usd(usd, cur), 2)
            except (TypeError, ValueError):
                return None
        out.append({"month": st["month"], "timezone": st["timezone"], "kind": it["kind"], "name": it["name"],
                    "state": it["state"], "forecast_state": it["forecast_state"],
                    "ratio": it["ratio"], "forecast_ratio": it["forecast_ratio"], "warn": it["warn"],
                    "spent_usd": it["spent_usd"], "forecast_usd": it["forecast_usd"], "budget_usd": it["budget_usd"],
                    "currency": cur, "spent": own(it["spent_usd"]), "forecast": own(it["forecast_usd"]),
                    "budget": it["amount"], "basis": it["basis"],
                    "days_elapsed": st["days_elapsed"], "days_left": st["days_left"]})
    return out
