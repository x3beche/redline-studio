"""Budgets: the calendar month in UTC, the forecast for its end, the
budget's own currency, the warning threshold, and an alert once a month."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from pymongo.errors import DuplicateKeyError

from backend import actors, budgets, costs, fx

UTC = timezone.utc


class Coll:
    def __init__(self):
        self.docs = {}

    async def find_one(self, q, proj=None):
        d = self.docs.get(q["_id"])
        return dict(d) if d else None

    async def replace_one(self, q, doc, upsert=False):
        self.docs[q["_id"]] = dict(doc)

    async def insert_one(self, doc):
        key = doc.get("_id") or len(self.docs)
        if key in self.docs:
            raise DuplicateKeyError("dup")
        self.docs[key] = dict(doc)


class DB:
    def __init__(self):
        self.settings, self.activity, self.alerts, self.audit = Coll(), Coll(), Coll(), Coll()

    def __getitem__(self, name):
        return {budgets.ALERTS: self.alerts, actors.AUDIT: self.audit}[name]


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(fx, "_latest", {**fx._latest, "rates": {"USD": 1.0, "TRY": 40.0, "EUR": 0.5}})
    monkeypatch.setattr(budgets, "_seen", set())

    async def empty(db):
        return {"display_currency": "USD", "subscriptions": [], "electricity": None, "proxy": None, "other": []}
    monkeypatch.setattr(costs, "_legacy", empty)
    import backend.insights as ins
    monkeypatch.setattr(ins, "forget", lambda: None)


def metered(monkeypatch, per_day: dict):
    """LLM dollars, kWh and proxy GB a day, the same every day."""
    async def used(db, since, until):
        days = (until - since).total_seconds() / 86400
        return {k: v * days for k, v in per_day.items()}
    monkeypatch.setattr(budgets, "used", used)


def run(c):
    return asyncio.run(c)


# ---- the month

def test_the_month_is_the_calendar_month_in_utc():
    s, e = budgets.month_of(datetime(2026, 10, 31, 23, 59, tzinfo=UTC))
    assert (s, e) == (datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 11, 1, tzinfo=UTC))
    # Istanbul's 1 November 01:30 is still October in UTC
    ist = timezone(timedelta(hours=3))
    s, _ = budgets.month_of(datetime(2026, 11, 1, 1, 30, tzinfo=ist))
    assert s.month == 10
    s, e = budgets.month_of(datetime(2026, 12, 15, tzinfo=UTC))
    assert e == datetime(2027, 1, 1, tzinfo=UTC)
    s, e = budgets.month_of(datetime(2028, 2, 10, tzinfo=UTC))
    assert (e - s).days == 29                                    # a leap year


def test_month_to_date_starts_on_the_first(monkeypatch):
    db = DB()
    metered(monkeypatch, {"llm_usd": 10, "kwh": 0, "proxy_gb": 0})
    run(costs.put(db, {"budgets": {"llm": {"amount": 1000, "currency": "USD"}}}))
    st = run(budgets.status(db, now=datetime(2026, 10, 11, tzinfo=UTC)))
    assert st["month"] == "2026-10" and st["timezone"] == "UTC"
    assert st["days_elapsed"] == 10 and st["days_left"] == 21
    it = st["items"][0]
    assert it["spent_usd"] == pytest.approx(100)


# ---- the forecast

def test_forecast_runs_on_the_months_average():
    f = budgets.forecast(100, 10, fixed_month=0, elapsed_days=10, days_in_month=30)
    assert f["basis"] == "month_avg"
    assert f["forecast_usd"] == pytest.approx(300)


def test_forecast_uses_the_last_7_days_while_the_month_is_young():
    # two days in, 4 a day so far; the last seven days ran at 10 a day
    f = budgets.forecast(8, 10, fixed_month=0, elapsed_days=2, days_in_month=30)
    assert f["basis"] == "last_7d"
    assert f["forecast_usd"] == pytest.approx(8 + 10 * 28)
    assert f["forecast_month_avg_usd"] == pytest.approx(120)


def test_forecast_uses_the_last_7_days_when_spending_picks_up():
    f = budgets.forecast(100, 20, fixed_month=0, elapsed_days=20, days_in_month=30)   # 5 a day, lately 20
    assert f["basis"] == "last_7d" and f["forecast_usd"] == pytest.approx(300)
    f = budgets.forecast(100, 6, fixed_month=0, elapsed_days=20, days_in_month=30)    # a little above: average
    assert f["basis"] == "month_avg" and f["forecast_usd"] == pytest.approx(150)


def test_fixed_costs_are_prorated_to_date_and_full_at_month_end(monkeypatch):
    db = DB()
    metered(monkeypatch, {"llm_usd": 0, "kwh": 0, "proxy_gb": 0})
    run(costs.put(db, {"subscriptions": [{"name": "Plan", "amount": 300, "currency": "USD", "covers": "llm"}],
                       "budgets": {"total": {"amount": 600, "currency": "USD"}}}))
    st = run(budgets.status(db, now=datetime(2026, 9, 11, tzinfo=UTC)))            # 10 of 30 days
    it = st["items"][0]
    assert it["spent_usd"] == pytest.approx(100)
    assert it["forecast_usd"] == pytest.approx(300)
    assert it["llm_included"] is False                                           # the plan pays for it


# ---- currencies

def test_budgets_and_prices_in_their_own_currencies(monkeypatch):
    db = DB()
    metered(monkeypatch, {"llm_usd": 1, "kwh": 10, "proxy_gb": 0.5})
    run(costs.put(db, {"electricity": {"amount": 4, "currency": "TRY"},       # 0.10 USD a kWh
                       "proxy": {"amount": 2, "currency": "EUR"},             # 4 USD a GB
                       "budgets": {"electricity": {"amount": 1200, "currency": "TRY"},   # 30 USD
                                   "proxy": {"amount": 50, "currency": "EUR"},           # 100 USD
                                   "total": {"amount": 200, "currency": "USD", "warn": 0.5}}}))
    st = run(budgets.status(db, now=datetime(2026, 9, 16, tzinfo=UTC)))            # 15 days
    by = {i["kind"]: i for i in st["items"]}
    assert by["electricity"]["budget_usd"] == 30
    assert by["electricity"]["spent_usd"] == pytest.approx(15)                     # 150 kWh at 0.10
    assert by["electricity"]["ratio"] == pytest.approx(0.5)
    assert by["proxy"]["spent_usd"] == pytest.approx(30)                           # 7.5 GB at 4
    # no plan covers LLM work, so the total pays it at list prices
    assert by["total"]["llm_included"] is True
    assert by["total"]["spent_usd"] == pytest.approx(15 + 30 + 15)
    assert by["total"]["state"] == "ok" and by["total"]["forecast_state"] == "warn"
    rows = budgets.rows(st)
    e = next(r for r in rows if r["kind"] == "electricity")
    assert e["currency"] == "TRY" and e["spent"] == pytest.approx(600) and e["budget"] == 1200


def test_an_unknown_budget_currency_or_kind_is_refused():
    with pytest.raises(ValueError):
        run(costs.put(DB(), {"budgets": {"total": {"amount": 10, "currency": "XXX"}}}))
    with pytest.raises(ValueError):
        run(costs.put(DB(), {"budgets": {"coffee": {"amount": 10, "currency": "USD"}}}))
    with pytest.raises(ValueError):
        run(costs.put(DB(), {"budgets": {"total": {"amount": 10, "currency": "USD", "warn": 2}}}))


def test_a_budget_is_kept_as_typed_with_the_default_threshold():
    out = run(costs.put(DB(), {"budgets": {"total": {"amount": 500, "currency": "try"}, "llm": None}}))
    assert out["budgets"] == {"total": {"amount": 500.0, "currency": "TRY", "warn": 0.8}}


# ---- thresholds

def test_states():
    assert budgets.state_of(0.79, 0.8) == "ok"
    assert budgets.state_of(0.8, 0.8) == "warn"
    assert budgets.state_of(1.0, 0.8) == "over"
    assert budgets.state_of(None, 0.8) == "ok"


# ---- alerts

def test_an_alert_is_written_once_a_month_per_level(monkeypatch):
    db = DB()
    rate = {"llm_usd": 9, "kwh": 0, "proxy_gb": 0}
    metered(monkeypatch, rate)
    run(costs.put(db, {"budgets": {"llm": {"amount": 100, "currency": "USD"}}}))
    db.activity.docs.clear(); db.audit.docs.clear()            # the save checked today's month
    day = lambda d: datetime(2026, 9, d, tzinfo=UTC)  # noqa: E731
    run(budgets.status(db, now=day(5)))                     # 36: nothing
    assert not db.activity.docs
    run(budgets.status(db, now=day(10)))                    # 81: past 80%
    run(budgets.status(db, now=day(10)))
    budgets._seen.clear()                                    # a restart: the database remembers
    run(budgets.status(db, now=day(11)))
    lines = list(db.activity.docs.values())
    assert len(lines) == 1 and lines[0]["level"] == "warn" and "81%" in lines[0]["text"]
    run(budgets.status(db, now=day(12)))                    # 99
    assert len(db.activity.docs) == 1
    run(budgets.status(db, now=day(13)))                    # 108: over
    run(budgets.status(db, now=day(20)))
    lines = list(db.activity.docs.values())
    assert [x["level"] for x in lines] == ["warn", "error"]
    audit = list(db.audit.docs.values())
    assert [(a["action"], a["target"], a["detail"]["level"]) for a in audit] == [
        ("budget", "llm", "warn"), ("budget", "llm", "over")]
    assert audit[0]["actor"]["type"] == "system"
    # a new month starts over
    run(budgets.status(db, now=datetime(2026, 10, 25, tzinfo=UTC)))
    assert len(db.activity.docs) == 3


def test_straight_past_100_writes_one_alert(monkeypatch):
    db = DB()
    metered(monkeypatch, {"llm_usd": 50, "kwh": 0, "proxy_gb": 0})
    run(costs.put(db, {"budgets": {"llm": {"amount": 100, "currency": "USD"}}}))
    db.activity.docs.clear(); db.alerts.docs.clear()           # the save checked today's month
    run(budgets.status(db, now=datetime(2026, 9, 3, tzinfo=UTC)))
    run(budgets.status(db, now=datetime(2026, 9, 4, tzinfo=UTC)))
    assert [x["level"] for x in db.activity.docs.values()] == ["error"]
    assert sorted(db.alerts.docs) == ["default|2026-09|llm|over", "default|2026-09|llm|warn"]


def test_the_month_so_far_is_there_without_a_budget(monkeypatch):
    """The costs page shows where the month is heading even with no budget set."""
    db = DB()
    metered(monkeypatch, {"llm_usd": 6, "kwh": 2, "proxy_gb": 0.5})
    run(costs.put(db, {"subscriptions": [{"name": "Plan", "amount": 300, "currency": "USD", "covers": "llm"}],
                       "electricity": {"amount": 0.25, "currency": "USD"},
                       "proxy": {"amount": 4, "currency": "USD"}}))
    st = run(budgets.status(db, now=datetime(2026, 9, 11, tzinfo=UTC)))            # 10 of 30 days
    assert st["items"] == []
    m = st["month_so_far"]
    assert m["llm_usd"] == pytest.approx(60)                    # what the plan's work would cost on the API
    assert m["electricity_usd"] == pytest.approx(5)
    assert m["proxy_usd"] == pytest.approx(20)
    assert m["fixed_usd"] == pytest.approx(100)
    assert m["llm_in_total"] is False                           # the plan pays for it
    assert m["total_usd"] == pytest.approx(125)
    assert m["forecast_usd"] == pytest.approx(300 + 75)         # fixed in full, metered run on
    assert m["llm_forecast_usd"] == pytest.approx(180)
