"""Settings > Costs: people's costs kept in their own currency, turned into
dollars at the latest rate only when used."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend import costs, fx


class Coll:
    def __init__(self):
        self.docs = {}

    async def find_one(self, q, proj=None):
        d = self.docs.get(q["_id"])
        return dict(d) if d else None

    async def replace_one(self, q, doc, upsert=False):
        self.docs[q["_id"]] = dict(doc)

    def find(self, q, proj=None):
        lo, hi = q["_id"]["$gte"], q["_id"]["$lte"]
        rows = [d for k, d in self.docs.items() if lo <= k <= hi]

        async def gen():
            for r in rows:
                yield r
        return gen()


class DB:
    def __init__(self):
        self.settings = Coll()
        self.traffic = Coll()

    def __getitem__(self, name):
        return self.traffic


@pytest.fixture(autouse=True)
def rates(monkeypatch):
    monkeypatch.setattr(fx, "_latest", {**fx._latest, "rates": {"USD": 1.0, "TRY": 50.0, "EUR": 0.5}})
    monkeypatch.setattr(costs, "_legacy", lambda db: _empty())
    import backend.insights as ins
    monkeypatch.setattr(ins, "forget", lambda: None)


async def _empty():
    return {"display_currency": "USD", "subscriptions": [], "electricity": None, "proxy": None, "other": []}


def test_costs_are_kept_as_typed_and_derived_in_dollars():
    db = DB()

    async def go():
        out = await costs.put(db, {
            "display_currency": "try",
            "subscriptions": [{"name": "Claude Max", "amount": 200, "currency": "USD", "covers": "llm"},
                              {"name": "Hosting", "amount": 120, "currency": "EUR", "period": "year"}],
            "electricity": {"amount": 3, "currency": "TRY"},
            "proxy": {"amount": 4, "currency": "USD"}})
        return out
    out = asyncio.run(go())
    assert out["display_currency"] == "TRY"
    assert out["electricity"] == {"amount": 3.0, "currency": "TRY"}
    u = out["usd"]
    assert u["electricity_per_kwh"] == pytest.approx(0.06)
    assert u["proxy_per_gb"] == 4
    assert u["llm_subscriptions_per_month"] == 200
    assert u["subscriptions_per_month"] == pytest.approx(200 + 240 / 12)
    assert u["llm_plan_names"] == "Claude Max"


def test_an_unknown_currency_is_refused():
    with pytest.raises(ValueError):
        asyncio.run(costs.put(DB(), {"electricity": {"amount": 3, "currency": "XXX"}}))


def test_the_range_is_charged_its_share_of_a_month_and_what_it_used():
    db = DB()
    until = datetime(2026, 10, 6, 12, tzinfo=timezone.utc)
    since = until - timedelta(days=costs.MONTH_DAYS)
    db.traffic.docs["2026-10-06T10"] = {"up": 200_000_000, "down": 300_000_000}

    async def go():
        await costs.put(db, {"subscriptions": [{"name": "Plan", "amount": 200, "currency": "USD", "covers": "llm"}],
                             "electricity": {"amount": 3, "currency": "TRY"},
                             "proxy": {"amount": 4, "currency": "USD"}})
        return await costs.summary(db, since, until, llm_list_usd=500, machine_kwh=100)
    s = asyncio.run(go())
    assert s["months"] == 1
    assert s["subscriptions_usd"] == 200
    assert s["electricity_usd"] == pytest.approx(6)
    assert s["proxy_gb"] == pytest.approx(0.5)
    assert s["proxy_usd"] == pytest.approx(2)
    assert s["total_usd"] == pytest.approx(208)
