"""Budgets people add themselves (Settings > Costs > Budgets): a line on one
cost, a category of costs, the LLM calls of one provider or job, the
electricity or the proxy - kept as typed, checked against the costs, in
the month's status, the alerts and the Chat's analytics_read like the
built-in four. And the built-in budgets take what the page sends."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from backend import budgets, costs, fx
from backend.chat_tools.analytics_read import Fmt, s_budget
from tests.test_budgets import DB

UTC = timezone.utc


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(fx, "_latest", {**fx._latest, "rates": {"USD": 1.0, "TRY": 40.0, "EUR": 0.5}})
    monkeypatch.setattr(budgets, "_seen", set())

    async def empty(db):
        return {"display_currency": "USD", "subscriptions": [], "electricity": None, "proxy": None, "other": []}
    monkeypatch.setattr(costs, "_legacy", empty)
    import backend.insights as ins
    monkeypatch.setattr(ins, "forget", lambda: None)

    async def used(db, since, until):              # the same every day
        days = (until - since).total_seconds() / 86400
        return {"llm_usd": 10 * days, "kwh": 2 * days, "proxy_gb": 0.0,
                "llm_by_provider": {"openrouter": 6 * days, "claude": 4 * days},
                "llm_by_job": {"chat": 7 * days, "summary": 3 * days}}
    monkeypatch.setattr(budgets, "used", used)


def run(c):
    return asyncio.run(c)


SUBS = [{"id": "s1", "name": "Claude Max", "amount": 300, "currency": "USD", "covers": "llm"},
        {"id": "s2", "name": "Hosting", "amount": 1200, "currency": "TRY"}]           # 30 USD


def test_what_the_page_sends_for_the_built_in_budgets_is_kept():
    """The Budgets card sends every kind, the empty ones as null, through
    the route's model: the set ones are kept, edited again and cleared."""
    db = DB()
    body = costs.CostsIn.model_validate({"budgets": {"total": {"amount": 500, "currency": "TRY", "warn": 0.9},
                                                     "llm": None, "electricity": None, "proxy": None}})
    out = run(costs.put(db, body.model_dump(exclude_unset=True)))
    assert out["budgets"] == {"total": {"amount": 500.0, "currency": "TRY", "warn": 0.9}}
    out = run(costs.put(db, {"budgets": {"total": {"amount": 750, "currency": "TRY", "warn": 0.9},
                                         "llm": {"amount": 20, "currency": "USD", "warn": None}}}))
    assert out["budgets"]["total"]["amount"] == 750 and out["budgets"]["llm"]["warn"] == 0.8
    out = run(costs.put(db, {"budgets": {"total": None, "llm": None}}))
    assert out["budgets"] == {}


def test_lines_are_kept_as_typed_and_checked():
    db = DB()
    run(costs.put(db, {"subscriptions": SUBS}))
    out = run(costs.put(db, {"budget_lines": [
        {"name": "Hosting", "measure": "line", "ref": "s2", "amount": 1500, "currency": "try"},
        {"name": "OpenRouter", "measure": "llm_provider", "ref": "openrouter", "amount": 100, "currency": "USD", "warn": 0.5},
        {"name": "Power", "measure": "electricity", "ref": "ignored", "amount": 20, "currency": "EUR"}]}))
    lines = out["budget_lines"]
    assert [x["measure"] for x in lines] == ["line", "llm_provider", "electricity"]
    assert lines[0]["currency"] == "TRY" and lines[0]["warn"] == 0.8 and lines[0]["id"]
    assert lines[2]["ref"] is None
    for bad in ({"measure": "line", "ref": "nope", "amount": 1, "currency": "USD"},          # no such cost
                {"measure": "category", "ref": "food", "amount": 1, "currency": "USD"},
                {"measure": "llm_job", "amount": 1, "currency": "USD"},                    # which job?
                {"measure": "llm", "amount": 0, "currency": "USD"},
                {"measure": "llm", "amount": 5, "currency": "XXX"},
                {"measure": "llm", "amount": 5, "currency": "USD", "warn": 3},
                {"measure": "coffee", "amount": 5, "currency": "USD"}):
        with pytest.raises(ValueError):
            run(costs.put(db, {"budget_lines": [bad]}))


def test_a_costs_document_from_before_has_no_lines():
    db = DB()
    db.settings.docs[costs._id()] = {"_id": costs._id(), "display_currency": "USD", "subscriptions": SUBS,
                                     "other": [], "electricity": None, "proxy": None,
                                     "budgets": {"total": {"amount": 500, "currency": "USD", "warn": 0.8}}}
    doc = run(costs.get(db))
    assert doc["budget_lines"] == [] and doc["budgets"]["total"]["amount"] == 500
    st = run(budgets.status(db, doc, now=datetime(2026, 9, 11, tzinfo=UTC), alert=False))
    assert [i["key"] for i in st["items"]] == ["total"]


def test_lines_in_the_months_status(monkeypatch):
    db = DB()
    run(costs.put(db, {"subscriptions": SUBS, "electricity": {"amount": 0.5, "currency": "USD"},
                       "other": [{"id": "o1", "name": "Domain", "amount": 12, "currency": "USD", "period": "year"}]}))
    run(costs.put(db, {"budget_lines": [
        {"id": "a", "name": "Hosting", "measure": "line", "ref": "s2", "amount": 40, "currency": "USD"},
        {"id": "b", "name": "Plans", "measure": "category", "ref": "subscriptions", "amount": 1000, "currency": "USD"},
        {"id": "c", "name": "OpenRouter", "measure": "llm_provider", "ref": "openrouter", "amount": 100, "currency": "USD"},
        {"id": "d", "name": "Chat", "measure": "llm_job", "ref": "chat", "amount": 50, "currency": "USD"},
        {"id": "e", "name": "Power", "measure": "electricity", "amount": 40, "currency": "USD"}]}))
    st = run(budgets.status(db, now=datetime(2026, 9, 11, tzinfo=UTC), alert=False))      # 10 of 30 days
    by = {i["key"]: i for i in st["items"]}
    a = by["line:a"]
    assert a["kind"] == "line" and a["name"] == "Hosting" and a["ref_name"] == "Hosting"
    assert a["spent_usd"] == pytest.approx(10) and a["forecast_usd"] == pytest.approx(30) and a["basis"] == "fixed"
    assert by["line:b"]["spent_usd"] == pytest.approx(110) and by["line:b"]["forecast_usd"] == pytest.approx(330)
    assert by["line:c"]["spent_usd"] == pytest.approx(60) and by["line:c"]["forecast_usd"] == pytest.approx(180)
    assert by["line:d"]["spent_usd"] == pytest.approx(70) and by["line:d"]["state"] == "over"
    assert by["line:e"]["spent_usd"] == pytest.approx(10)                       # 20 kWh at 0.5
    assert st["state"] == "over"                                               # the top bar's colour
    rows = {r["key"]: r for r in budgets.rows(st)}
    assert rows["line:c"]["measure"] == "llm_provider" and rows["line:c"]["ref"] == "openrouter"
    # The subscription it measured goes: the line says so instead of counting nothing silently.
    run(costs.put(db, {"subscriptions": SUBS[:1]}))
    st = run(budgets.status(db, now=datetime(2026, 9, 11, tzinfo=UTC), alert=False))
    assert "no longer" in next(i for i in st["items"] if i["key"] == "line:a")["missing"]


def test_a_line_alerts_once_on_its_own_key():
    db = DB()
    run(costs.put(db, {"budget_lines": [{"id": "d", "name": "Chat", "measure": "llm_job", "ref": "chat",
                                         "amount": 50, "currency": "USD"}]}))
    db.activity.docs.clear(); db.audit.docs.clear(); db.alerts.docs.clear(); budgets._seen.clear()
    run(budgets.status(db, now=datetime(2026, 9, 11, tzinfo=UTC)))
    run(budgets.status(db, now=datetime(2026, 9, 12, tzinfo=UTC)))
    texts = [x["text"] for x in db.activity.docs.values()]
    assert len(texts) == 1 and texts[0].startswith("Budget: Chat is over")
    assert any("|line:d|over" in k for k in db.alerts.docs)


def test_the_llm_split_by_provider_and_job():
    class Agg:
        def __init__(self, rows):
            self.rows = rows

        async def to_list(self, n):
            return self.rows

    class Calls:
        def aggregate(self, pipeline):
            assert pipeline[-1]["$group"]["_id"] == {"p": "$provider", "k": "$kind"}
            return Agg([{"_id": {"p": "openrouter", "k": "chat"}, "usd": 3.0},
                        {"_id": {"p": "openrouter", "k": "summary"}, "usd": 1.0},
                        {"_id": {"p": "claude", "k": "chat"}, "usd": 2.0},
                        {"_id": {}, "usd": 0.5}])

    class D:
        def __getitem__(self, name):
            return Calls()
    got = run(budgets._llm_usd(D(), datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 2, tzinfo=UTC)))
    assert got["usd"] == pytest.approx(6.5)
    assert got["provider"] == {"openrouter": 4.0, "claude": 2.0, "?": 0.5}
    assert got["job"] == {"chat": 5.0, "summary": 1.0, "?": 0.5}


def test_the_chat_tool_names_what_a_line_measures():
    st = {"month": "2026-09", "days_elapsed": 10, "days_in_month": 30, "state": "warn", "month_so_far": {},
          "items": [{"key": "total", "kind": "total", "name": "Total spend", "budget_usd": 500, "spent_usd": 100,
                     "ratio": 0.2, "state": "ok", "forecast_usd": 300, "forecast_ratio": 0.6, "forecast_state": "ok"},
                    {"key": "line:c", "kind": "line", "name": "OpenRouter", "measure": "llm_provider", "ref": "openrouter",
                     "budget_usd": 100, "spent_usd": 85, "ratio": 0.85, "state": "warn",
                     "forecast_usd": 250, "forecast_ratio": 2.5, "forecast_state": "over"}]}
    text = "\n".join(s_budget({"budget_status": st}, Fmt({})))
    assert "Total spend budget" in text
    assert "OpenRouter (LLM calls via openrouter) budget 100 USD" in text and "85.0%, warn" in text
