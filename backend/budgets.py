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

Besides those four, people add their own budget lines (`budget_lines`:
[{id, name, measure, ref, amount, currency, warn}]), each on one thing:
  * line         - one subscription or other cost (`ref` its row id),
                   prorated like the fixed costs in the total;
  * category     - all the subscriptions, or all the other costs;
  * llm_provider - the LLM calls of one provider at list prices (`ref`
                   the provider, as the call log names it);
  * llm_job      - the LLM calls of one job (`ref` the call log's kind:
                   chat, summary, translate...);
  * llm, electricity, proxy - as the built-in budgets.
A fixed measure's forecast is its full month; a metered one runs on as
the built-in budgets do.

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
MEASURES = ("line", "category", "llm_provider", "llm_job", "llm", "electricity", "proxy")
CATEGORIES = {"subscriptions": "Subscriptions", "other": "Other recurring costs"}
MAX_LINES = 40
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
        out[kind] = {"amount": amount, "currency": cur, "warn": _warn(b, NAMES[kind])}
    return out


def _warn(b: dict, what: str) -> float:
    warn = b.get("warn")
    warn = WARN if warn in (None, "") else float(warn)
    if not 0.05 <= warn <= 1:
        raise ValueError(f"{what} budget: the warning threshold must be between 5% and 100%")
    return round(warn, 4)


def clean_lines(rows: list[dict] | None, doc: dict) -> list[dict]:
    """People's own budget lines as given to PUT /api/costs (`budget_lines`).
    A line on one cost must name a subscription or other cost the costs
    document holds (`doc`, after the same PUT's own changes)."""
    ids = {r.get("id") for r in (doc.get("subscriptions") or []) + (doc.get("other") or [])}
    out: list[dict] = []
    for b in (rows or [])[:MAX_LINES]:
        name = (b.get("name") or "").strip()[:80]
        measure = b.get("measure")
        if measure not in MEASURES:
            raise ValueError(f"{name or 'a budget line'}: no such measure: {measure}")
        ref = (b.get("ref") or "").strip()[:80] or None
        if measure in ("line", "category", "llm_provider", "llm_job") and not ref:
            raise ValueError(f"{name or 'a budget line'}: say which {'cost' if measure == 'line' else measure.split('_')[-1]} it measures")
        if measure == "line" and ref not in ids:
            raise ValueError(f"{name or 'a budget line'}: the cost it measures is not in the costs any more")
        if measure == "category" and ref not in CATEGORIES:
            raise ValueError(f"{name or 'a budget line'}: no such category: {ref}")
        if measure in ("llm", "electricity", "proxy"):
            ref = None
        what = name or "A"
        if b.get("amount") in (None, ""):
            raise ValueError(f"{what} budget: give an amount")
        cur = (b.get("currency") or "").upper()
        if not fx.known(cur):
            raise ValueError(f"{what} budget: no exchange rate for {cur or 'an empty currency'}")
        amount = float(b["amount"])
        if amount <= 0:
            raise ValueError(f"{what} budget: the amount must be more than 0")
        out.append({"id": (b.get("id") or "").strip()[:40] or uuid.uuid4().hex[:8], "name": name or "Budget",
                    "measure": measure, "ref": ref, "amount": amount, "currency": cur, "warn": _warn(b, what)})
    return out


async def measures(db) -> dict:
    """What a budget line can measure besides the costs: the LLM providers
    and jobs the call log has seen in the last 90 days (for the page's list)."""
    from . import usage
    lo = (datetime.now(TZ) - timedelta(days=90)).isoformat()
    try:
        providers = await db[usage.CALLS].distinct("provider", {"at": {"$gte": lo}})
        jobs = await db[usage.CALLS].distinct("kind", {"at": {"$gte": lo}})
    except Exception:                                  # noqa: BLE001 - the page still opens
        providers, jobs = [], []
    return {"providers": sorted(p for p in providers if p), "jobs": sorted(j for j in jobs if j),
            "categories": CATEGORIES}


# ---------------- the month ----------------

def month_of(now: datetime) -> tuple[datetime, datetime]:
    """The calendar month `now` is in, in UTC: [the 1st 00:00, the next 1st 00:00)."""
    now = now.astimezone(TZ) if now.tzinfo else now.replace(tzinfo=TZ)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    days = calendar.monthrange(start.year, start.month)[1]
    return start, start + timedelta(days=days)


async def _llm_usd(db, since: datetime, until: datetime) -> dict:
    """The LLM calls between two moments, at list prices: in all, by
    provider and by job. The call log is the machine's: a space counts the
    calls made for it, and of the unstamped ones (the agents' transcripts,
    rows from before) the default space all, another only those made
    during its own runs - as insights._llm_sums."""
    from . import insights, usage
    lo, hi = since.isoformat(), until.isoformat()
    in_run = None if getattr(db, "workspace", scope.DEFAULT) == scope.DEFAULT \
        else await insights._in_runs(db, lo, hi)
    match = {"$and": [{"at": {"$gte": lo, "$lte": hi}}, insights._ws_match(db, in_run)]}
    usd = {"$sum": {"$ifNull": ["$cost_usd", 0]}}
    rows = await db[usage.CALLS].aggregate([
        {"$match": match},
        {"$group": {"_id": {"p": "$provider", "k": "$kind"}, "usd": usd}}]).to_list(None)
    out = {"usd": 0.0, "provider": {}, "job": {}}
    for r in rows:
        v = float(r.get("usd") or 0.0)
        out["usd"] += v
        for key, by in (("p", "provider"), ("k", "job")):
            name = (r.get("_id") or {}).get(key) or "?"
            out[by][name] = out[by].get(name, 0.0) + v
    return out


async def _kwh(db, since: datetime, until: datetime) -> float:
    """The machine's measured energy between two moments (the sampler's)."""
    from .insights import METRICS
    rows = await db[METRICS].aggregate([
        {"$match": {"at": {"$gte": since, "$lte": until}}},
        {"$group": {"_id": None, "wh": {"$sum": {"$ifNull": ["$wh", 0]}}}}]).to_list(1)
    return float((rows or [{}])[0].get("wh") or 0.0) / 1000


async def used(db, since: datetime, until: datetime) -> dict:
    """What was metered between two moments: LLM dollars (also by provider
    and by job), kWh, proxy GB."""
    from . import costs
    llm, kwh, b = await asyncio.gather(_llm_usd(db, since, until), _kwh(db, since, until),
                                       costs.proxy_bytes(db, since, until))
    return {"llm_usd": llm["usd"], "llm_by_provider": llm["provider"], "llm_by_job": llm["job"],
            "kwh": kwh, "proxy_gb": b / 1e9}


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
    # The month so far whether or not a budget is set: the costs page shows
    # where the month is heading, and what the LLM work would have cost
    # on the API next to the plan that covers it.
    f = forecast(parts["total"][0], parts["total"][1], fixed_month=fixed, elapsed_days=elapsed, days_in_month=dim)
    out["month_so_far"] = {
        "llm_usd": _r(month["llm_usd"]), "kwh": _r(month["kwh"]), "proxy_gb": _r(month["proxy_gb"]),
        "electricity_usd": _r(parts["electricity"][0]), "proxy_usd": _r(parts["proxy"][0]),
        "fixed_usd": _r(fixed * elapsed / dim), "fixed_month_usd": _r(fixed),
        "llm_in_total": not has_llm_plan,
        "total_usd": _r(parts["total"][0] + fixed * elapsed / dim),
        "forecast_usd": _r(f["forecast_usd"]), "basis": f["basis"],
        "llm_7d_per_day_usd": _r(recent["llm_usd"] / RECENT_DAYS),
        "llm_forecast_usd": _r(forecast(parts["llm"][0], parts["llm"][1], fixed_month=0.0,
                                        elapsed_days=elapsed, days_in_month=dim)["forecast_usd"]),
    }
    lines = doc.get("budget_lines") or []
    if not config and not lines:
        return out
    missing = {"electricity": None if kwh_p is not None else "no price per kWh set",
               "proxy": None if gb_p is not None else "no price per GB set", "llm": None, "total": None}
    def one(key: str, kind: str, name: str, b: dict, metered: float, per_day: float, fixed_month: float,
            extra: dict | None = None) -> dict | None:
        try:
            budget_usd = fx.to_usd(b["amount"], b["currency"])
        except ValueError:
            out["items"].append({"key": key, "kind": kind, "name": name, **b, **(extra or {}),
                                 "error": f"no rate for {b['currency']}"})
            return None
        spent = metered + fixed_month * elapsed / dim
        f = forecast(metered, per_day, fixed_month=fixed_month, elapsed_days=elapsed, days_in_month=dim)
        if fixed_month and not metered and not per_day:  # a fixed cost alone: its month, prorated
            f.update(basis="fixed", basis_why="a fixed cost: its full month")
        ratio = spent / budget_usd if budget_usd else None
        f_ratio = f["forecast_usd"] / budget_usd if budget_usd else None
        item = {"key": key, "kind": kind, "name": name, "amount": b["amount"], "currency": b["currency"],
                "warn": b.get("warn", WARN), "budget_usd": _r(budget_usd, 2), "spent_usd": _r(spent),
                "forecast_usd": _r(f["forecast_usd"]), "ratio": _r(ratio), "forecast_ratio": _r(f_ratio),
                "state": state_of(ratio, b.get("warn", WARN)),
                "forecast_state": state_of(f_ratio, b.get("warn", WARN)),
                "basis": f["basis"], "basis_why": f["basis_why"],
                "forecast_month_avg_usd": _r(f["forecast_month_avg_usd"]),
                "forecast_last_7d_usd": _r(f["forecast_last_7d_usd"]),
                "rate_month_per_day_usd": _r(f["rate_month_per_day_usd"]),
                "rate_7d_per_day_usd": _r(f["rate_7d_per_day_usd"]), **(extra or {})}
        out["items"].append(item)
        return item

    for kind in KINDS:
        b = config.get(kind)
        if not b:
            continue
        item = one(kind, kind, NAMES[kind], b, *parts[kind], fixed if kind == "total" else 0.0)
        if item is None:
            continue
        if kind == "total":
            item["fixed_month_usd"] = _r(fixed, 2)
            item["llm_included"] = not has_llm_plan
        if missing[kind]:
            item["missing"] = missing[kind]

    # People's own lines
    rows_by_id = {r.get("id"): r for r in (doc.get("subscriptions") or []) + (doc.get("other") or [])}

    def month_usd(rows: list[dict]) -> float:
        total = 0.0
        for r in rows:
            try:
                total += costs._per_month(r)
            except ValueError:                         # a currency with no rate today
                pass
        return total

    for ln in lines:
        m, ref = ln.get("measure"), ln.get("ref")
        extra = {"measure": m, "ref": ref, "id": ln.get("id")}
        metered = per_day = fixed_month = 0.0
        gone = None
        if m == "line":
            row = rows_by_id.get(ref)
            if row is None:
                gone = "the cost it measures is no longer in the costs"
            else:
                fixed_month = month_usd([row])
                extra["ref_name"] = row.get("name")
        elif m == "category":
            fixed_month = month_usd(doc.get("subscriptions") or [] if ref == "subscriptions" else doc.get("other") or [])
            extra["ref_name"] = CATEGORIES.get(ref, ref)
        elif m in ("llm_provider", "llm_job"):
            by = "llm_by_provider" if m == "llm_provider" else "llm_by_job"
            metered = float((month.get(by) or {}).get(ref) or 0.0)
            per_day = float((recent.get(by) or {}).get(ref) or 0.0) / RECENT_DAYS
        elif m in parts:
            metered, per_day = parts[m]
            if missing.get(m):
                gone = missing[m]
        item = one(f"line:{ln.get('id')}", "line", ln.get("name") or "Budget", ln, metered, per_day, fixed_month, extra)
        if item is not None and gone:
            item["missing"] = gone
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
            key = f"{ws}|{st['month']}|{it.get('key') or it['kind']}|{level}"
            if key in _seen:
                continue
            try:
                await raw[ALERTS].insert_one({"_id": key, "at": now, "workspace_id": ws, "month": st["month"],
                                              "kind": it.get("key") or it["kind"], "level": level, "ratio": it["ratio"]})
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
        await actors.audit(db, "budget", it.get("key") or it["kind"], detail, actor=ACTOR)
        written.append({"kind": it["kind"], "key": it.get("key") or it["kind"], "level": level, "text": text})
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
                                                "$or": [{"budgets": {"$exists": True, "$ne": {}}},
                                                        {"budget_lines": {"$exists": True, "$ne": []}}]}, {"_id": 1}):
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
        out.append({"month": st["month"], "timezone": st["timezone"], "kind": it["kind"],
                    "key": it.get("key") or it["kind"], "measure": it.get("measure"), "ref": it.get("ref"), "name": it["name"],
                    "state": it["state"], "forecast_state": it["forecast_state"],
                    "ratio": it["ratio"], "forecast_ratio": it["forecast_ratio"], "warn": it["warn"],
                    "spent_usd": it["spent_usd"], "forecast_usd": it["forecast_usd"], "budget_usd": it["budget_usd"],
                    "currency": cur, "spent": own(it["spent_usd"]), "forecast": own(it["forecast_usd"]),
                    "budget": it["amount"], "basis": it["basis"],
                    "days_elapsed": st["days_elapsed"], "days_left": st["days_left"]})
    return out
