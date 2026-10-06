"""What the work costs besides the tokens: subscriptions, electricity, the
proxy's traffic, anything else paid each month (Settings > Costs & currency).

People write their costs the way they pay them - $200 a month for a plan,
3 TL per kWh, $4 per GB of proxy traffic - each in its own currency. They
are kept that way, and turned into dollars only when used, at the latest
rate (fx.py), so changing a rate never rewrites what someone typed. Every
other figure in the app is in dollars already; the page shows them in the
display currency.

A subscription that pays for model work (covers "llm") is what Analytics
sets against the work at list prices. The costs belong to the workspace.
"""

from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import fx, scope, store

DOC = "costs"
MONTH_DAYS = 30.44


def _id() -> str:
    return scope.key(DOC)


async def _legacy(db) -> dict:
    """The costs as they were kept before this page: the Analytics room's
    plan and kWh price (in dollars), and the proxy's price per GB."""
    s = await db.settings.find_one({"_id": scope.key(store.SETTINGS_ID)},
                                   {"kwh_price": 1, "plan_usd_month": 1, "plan_name": 1}) or {}
    subs = []
    if s.get("plan_usd_month") is not None:
        subs.append({"id": secrets.token_hex(4), "name": s.get("plan_name") or "Subscription",
                     "amount": float(s["plan_usd_month"]), "currency": "USD", "period": "month",
                     "covers": "llm", "note": ""})
    from . import netproxy
    price = (netproxy._conf or {}).get("price_per_gb")
    return {"display_currency": "USD", "subscriptions": subs,
            "electricity": ({"amount": float(s["kwh_price"]), "currency": "USD"}
                            if s.get("kwh_price") is not None else None),
            "proxy": {"amount": float(price), "currency": "USD"} if price is not None else None,
            "other": []}


async def get(db) -> dict:
    """The workspace's costs, as typed; made from the old settings the first time."""
    doc = await db.settings.find_one({"_id": _id()})
    if not doc:
        doc = await _legacy(db)
        await db.settings.replace_one({"_id": _id()}, {"_id": _id(), **doc}, upsert=True)
    doc = {k: v for k, v in doc.items() if k not in ("_id", "workspace_id")}
    doc.setdefault("display_currency", "USD")
    doc.setdefault("subscriptions", [])
    doc.setdefault("other", [])
    doc.setdefault("electricity", None)
    doc.setdefault("proxy", None)
    return doc


def _per_month(row: dict) -> float | None:
    usd = fx.to_usd(row.get("amount") or 0, row.get("currency"))
    return usd / 12 if row.get("period") == "year" else usd


def derived(doc: dict) -> dict:
    """The same costs in dollars: per kWh, per GB, per month."""
    def safe(f):
        try:
            return f()
        except ValueError:                             # a currency with no rate today
            return None
    subs = doc.get("subscriptions") or []
    llm = [r for r in subs if r.get("covers") == "llm"]
    e, p = doc.get("electricity"), doc.get("proxy")
    return {
        "electricity_per_kwh": safe(lambda: fx.to_usd(e["amount"], e["currency"])) if e else None,
        "proxy_per_gb": safe(lambda: fx.to_usd(p["amount"], p["currency"])) if p else None,
        "llm_subscriptions_per_month": safe(lambda: sum(_per_month(r) for r in llm)) if llm else None,
        "subscriptions_per_month": safe(lambda: sum(_per_month(r) for r in subs)) if subs else 0.0,
        "other_per_month": safe(lambda: sum(_per_month(r) for r in doc.get("other") or [])) or 0.0,
        "llm_plan_names": ", ".join(r.get("name") or "" for r in llm) or None,
    }


async def public(db) -> dict:
    doc = await get(db)
    return {**doc, "usd": derived(doc), "fx": {"date": fx.public()["date"], "fetched_at": fx.public()["fetched_at"]}}


def _clean_rows(rows: list[dict], *, covers: bool) -> list[dict]:
    out = []
    for r in rows:
        cur = (r.get("currency") or "").upper()
        if not fx.known(cur):
            raise ValueError(f"{r.get('name') or 'a row'}: no exchange rate for {cur or 'an empty currency'}")
        amount = float(r.get("amount") or 0)
        if amount < 0:
            raise ValueError(f"{r.get('name') or 'a row'}: the amount cannot be negative")
        period = r.get("period") if r.get("period") in ("month", "year") else "month"
        row = {"id": r.get("id") or secrets.token_hex(4), "name": (r.get("name") or "").strip()[:80] or "Untitled",
               "amount": amount, "currency": cur, "period": period, "note": (r.get("note") or "")[:200]}
        if covers:
            row["covers"] = "llm" if r.get("covers") == "llm" else "other"
        out.append(row)
    return out


def _clean_price(p: dict | None, what: str) -> dict | None:
    if not p or p.get("amount") in (None, ""):
        return None
    cur = (p.get("currency") or "").upper()
    if not fx.known(cur):
        raise ValueError(f"{what}: no exchange rate for {cur or 'an empty currency'}")
    amount = float(p["amount"])
    if amount < 0:
        raise ValueError(f"{what}: the price cannot be negative")
    return {"amount": amount, "currency": cur}


async def put(db, patch: dict) -> dict:
    doc = await get(db)
    if "display_currency" in patch:
        cur = (patch["display_currency"] or "USD").upper()
        if not fx.known(cur):
            raise ValueError(f"no exchange rate for {cur}")
        doc["display_currency"] = cur
    if "subscriptions" in patch:
        doc["subscriptions"] = _clean_rows(patch["subscriptions"] or [], covers=True)
    if "other" in patch:
        doc["other"] = _clean_rows(patch["other"] or [], covers=False)
    if "electricity" in patch:
        doc["electricity"] = _clean_price(patch["electricity"], "Electricity")
    if "proxy" in patch:
        doc["proxy"] = _clean_price(patch["proxy"], "Proxy traffic")
    await db.settings.replace_one({"_id": _id()}, {"_id": _id(), **doc}, upsert=True)
    from . import insights
    insights.forget()                                  # the figures change with the costs
    return await public(db)


async def proxy_bytes(db, since: datetime, until: datetime) -> int:
    """Bytes on the wire through the proxy between two moments (netmeter's hourly totals)."""
    from . import netmeter
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    lo, hi = since.strftime("%Y-%m-%dT%H"), until.strftime("%Y-%m-%dT%H")
    total = 0
    async for h in raw[netmeter.TRAFFIC].find({"_id": {"$gte": lo, "$lte": hi}}, {"up": 1, "down": 1}):
        total += (h.get("up") or 0) + (h.get("down") or 0)
    return total


async def summary(db, since: datetime, until: datetime, *, llm_list_usd: float,
                  machine_kwh: float) -> dict:
    """What the range cost, in dollars: subscriptions and other costs for the
    share of a month the range is, electricity for the energy measured, the
    proxy for the bytes it carried - and the model work at list prices."""
    doc = await get(db)
    d = derived(doc)
    months = max(0.0, (until - since).total_seconds() / (MONTH_DAYS * 86400))
    items: list[dict] = []

    def per_row(rows, kind):
        total = 0.0
        for r in rows:
            try:
                usd = _per_month(r) * months
            except ValueError:
                continue
            total += usd
            items.append({"name": r.get("name"), "kind": kind, "usd": round(usd, 4),
                          "detail": f"{r['amount']:g} {r['currency']} a {r.get('period') or 'month'}"})
        return total

    subs_usd = per_row(doc.get("subscriptions") or [], "subscription")
    other_usd = per_row(doc.get("other") or [], "other")
    elec_usd = machine_kwh * d["electricity_per_kwh"] if d["electricity_per_kwh"] is not None else None
    if elec_usd is not None:
        e = doc["electricity"]
        items.append({"name": "Electricity", "kind": "electricity", "usd": round(elec_usd, 4),
                      "detail": f"{machine_kwh:.2f} kWh at {e['amount']:g} {e['currency']} per kWh"})
    gb = (await proxy_bytes(db, since, until)) / 1e9
    proxy_usd = gb * d["proxy_per_gb"] if d["proxy_per_gb"] is not None else None
    if proxy_usd is not None:
        p = doc["proxy"]
        items.append({"name": "Proxy traffic", "kind": "proxy", "usd": round(proxy_usd, 6),
                      "detail": f"{gb * 1000:.2f} MB at {p['amount']:g} {p['currency']} per GB"})
    total = subs_usd + other_usd + (elec_usd or 0) + (proxy_usd or 0)
    return {"months": round(months, 3), "items": sorted(items, key=lambda x: -x["usd"]),
            "subscriptions_usd": round(subs_usd, 2), "other_usd": round(other_usd, 2),
            "electricity_usd": round(elec_usd, 4) if elec_usd is not None else None,
            "proxy_usd": round(proxy_usd, 6) if proxy_usd is not None else None,
            "proxy_gb": round(gb, 6), "total_usd": round(total, 2),
            "llm_list_usd": round(llm_list_usd, 2), "display_currency": doc["display_currency"]}


# ---------------- the API ----------------

router = APIRouter(prefix="/api/costs")


def _db():
    from .main import db
    return db()


@router.get("")
async def get_costs() -> dict:
    return await public(_db())


class Row(BaseModel):
    id: str | None = Field(default=None, max_length=40)
    name: str = Field(default="", max_length=80)
    amount: float = Field(ge=0, le=1e9)
    currency: str = Field(min_length=3, max_length=3)
    period: str = Field(default="month", pattern="^(month|year)$")
    covers: str | None = Field(default=None, pattern="^(llm|other)$")
    note: str = Field(default="", max_length=200)


class Price(BaseModel):
    amount: float | None = Field(default=None, ge=0, le=1e9)
    currency: str = Field(default="USD", min_length=3, max_length=3)


class CostsIn(BaseModel):
    display_currency: str | None = Field(default=None, min_length=3, max_length=3)
    subscriptions: list[Row] | None = None
    other: list[Row] | None = None
    electricity: Price | None = None
    proxy: Price | None = None


@router.put("")
async def put_costs(body: CostsIn) -> dict:
    from . import actors
    patch = body.model_dump(exclude_unset=True)
    try:
        out = await put(_db(), patch)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await actors.audit(_db(), "settings", "costs", {"changed": sorted(patch)})
    return out
