"""The Chat's analytics_read tool (backend/chat_tools/analytics_read.py).

What matters: it reads the very answer GET /api/insights gives the
Analytics page (the same kept answer per workspace and range), so its
figures are the page's; it sees only the asker's workspace; and it needs
the right the page's GET needs. insights.overview is replaced by a small
one that sums the workspace's llm_calls, so the figures come from the
tests' fake database through the workspace's scope; no model is reached.
"""

from __future__ import annotations

import pytest

from backend import chat_tools, insights, main
from backend.chat_tools import Ctx, ToolError
from backend.chat_tools.analytics_read import Fmt, TOOL
from tests.test_cc_mentions_live_search import env  # noqa: F401 - a fixture
from tests.test_chat_tools import run


async def _overview(db, since, until):
    """The shape of insights.overview, made from the workspace's llm_calls."""
    calls = [r async for r in db["llm_calls"].find(insights._ws_match(db, None))]   # as _llm_sums picks them
    by_model: dict[str, dict] = {}
    for c in calls:
        m = by_model.setdefault(c["model"], {"name": c["model"], "calls": 0, "cost_usd": 0.0, "tokens": 0})
        m["calls"] += 1; m["cost_usd"] += c["usd"]; m["tokens"] += c["tokens"]
    cost = sum(c["usd"] for c in calls)
    tokens = sum(c["tokens"] for c in calls)
    return {
        "range": {"since": since.isoformat(), "until": until.isoformat(), "step": 3600},
        "llm": {"calls": len(calls), "cost_usd": cost, "unpriced_calls": 0,
                "tokens": {"input": tokens, "output": 0, "cache_read": 0, "cache_write": 0, "thinking": 0},
                "by_model": sorted(by_model.values(), key=lambda m: -m["cost_usd"]),
                "by_provider": [], "by_surface": [], "by_room": [], "by_project": [],
                "top_notes": [{"id": c["note"], "title": c["title"], "cost_usd": c["usd"], "calls": 1,
                               "tokens": c["tokens"], "room": "cad", "project": c.get("project")}
                              for c in sorted(calls, key=lambda c: -c["usd"])]},
        "cache": {"saved_usd": 2.5, "hit_ratio": 0.9, "by_model": []},
        "costs": {"total_usd": 3.0, "items": [], "display_currency": "TRY"},
        "fx": {"display_currency": "TRY", "rates": {"USD": 1.0, "TRY": 40.0}, "date": "2026-10-12"},
        "compute": {"count": 4, "failed": 1, "cpu_s": 7200},
        "builds": {"by_kind": [{"name": "build", "jobs": 4, "failed": 1, "fail_rate": 0.25, "median_s": 90, "max_s": 300}],
                   "by_model": []},
        "work": {"status": {"applied": 2}, "runs_by_room": []},
        "api": {"requests": 1200, "errors": 3, "routes": []},
        "now_totals": {"llm_usd": cost, "tokens": tokens, "notes": 2, "runs": 2},
        "previous": {"llm_usd": cost / 2}, "change": {"llm_usd": 100.0},
        "project_detail": {p: {"name": p, "items": [], "spend_usd": sum(c["usd"] for c in calls if c.get("project") == p)}
                           for p in {c.get("project") for c in calls if c.get("project")}},
    }


@pytest.fixture
def figures(env, monkeypatch, tmp_path):
    raw, state = env
    monkeypatch.setattr(insights, "overview", _overview)
    monkeypatch.setattr(insights, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(insights, "_CACHE", {})
    monkeypatch.setattr(main, "_raw_db", lambda: raw)

    def call(ws, cid, model, usd, tokens, title, project=None):
        raw["llm_calls"].rows[cid] = {"_id": cid, "workspace_id": ws, "model": model, "usd": usd, "tokens": tokens,
                                      "note": "n-" + cid, "title": title, "project": project}
    call("default", "a", "claude-opus", 10.0, 1000, "Split the lid", "iot-fan")
    call("default", "b", "claude-sonnet", 2.5, 4000, "Fan curve")
    call("team2", "c", "secret-model", 99.0, 7, "Their secret note", "their-project")
    return raw, state


def test_it_is_a_general_read_tool_on_by_default_and_the_chat_is_told_of_it():
    t = chat_tools.tools()["analytics_read"]
    assert (t.package, t.level, t.default) == ("general", "read", True)
    assert "analytics_read" in chat_tools.SYSTEM_NOTE
    assert t.schema["properties"]["range"]["enum"] == ["1h", "6h", "24h", "7d", "30d", "90d", "all"]


def test_the_figures_are_the_pages_own(figures):
    raw, state = figures
    page = run(main.get_insights("7d"))                       # what GET /api/insights gives the page
    got = run(TOOL.run(Ctx(db=main.db()), {}))
    f = Fmt(page["fx"])
    assert f.cur == "TRY" and f.money(12.5) == "500 TRY"
    assert f"LLM spend (API list prices): {f.money(page['llm']['cost_usd'], True)}" in got.text
    assert "LLM spend (API list prices): 500 TRY ($12.50)" in got.text
    assert "+100.0% vs the period before: 250 TRY" in got.text
    top = page["llm"]["by_model"][0]
    assert f"Top models: {top['name']} {f.money(top['cost_usd'])}" in got.text
    assert "Cache saved: 100 TRY" in got.text and "hit ratio 90.0%" in got.text
    assert "Open Analytics: ?ws=analyze&range=7d" in got.text
    assert got.vars == {"range": "7d", "section": "overview", "project": ""}
    assert got.say == "Read Analytics: {section}, {range}"
    assert len(got.text) < chat_tools.MAX_TEXT

    llm = run(TOOL.run(Ctx(db=main.db()), {"section": "llm", "range": "30d"}))
    assert "1. claude-opus: 400 TRY (80%) · 1 calls · 1,000 tokens" in llm.text
    assert "2. claude-sonnet: 100 TRY (20%)" in llm.text and "range=30d" in llm.text
    notes = run(TOOL.run(Ctx(db=main.db()), {"section": "notes"}))
    assert notes.text.index("Split the lid") < notes.text.index("Fan curve")
    builds = run(TOOL.run(Ctx(db=main.db()), {"section": "builds"}))   # builds is runs
    assert "build: 4 jobs, 1 failed (25.0%), median 90 s, longest 5.0 min" in builds.text


def test_a_project_is_its_own_and_an_unknown_one_says_which_there_are(figures):
    got = run(TOOL.run(Ctx(db=main.db()), {"project": "IOT-FAN"}))
    assert "Project iot-fan: LLM spend on its notes 400 TRY ($10.00)" in got.text
    assert "Split the lid" in got.text and "Fan curve" not in got.text
    assert got.text.rstrip().endswith("?ws=analyze&range=7d&project=iot-fan")
    with pytest.raises(ToolError, match="no project 'gearbox'; the projects are: iot-fan"):
        run(TOOL.run(Ctx(db=main.db()), {"project": "gearbox"}))
    with pytest.raises(ToolError, match="range is one of"):
        run(TOOL.run(Ctx(db=main.db()), {"range": "2y"}))


def test_another_workspace_is_not_seen(figures):
    raw, state = figures
    mine = run(TOOL.run(Ctx(db=main.db()), {"section": "llm"}))
    assert "secret-model" not in mine.text and "their-project" not in mine.text
    state["ws"] = "team2"
    theirs = run(TOOL.run(Ctx(db=main.db()), {"section": "llm"}))
    assert "secret-model: 3,960 TRY" in theirs.text and "claude-opus" not in theirs.text
    assert run(main.get_insights("7d"))["llm"]["cost_usd"] == 99.0      # the page in team2 says the same


def test_it_needs_the_right_the_page_needs(figures):
    raw, state = figures
    state["role"] = None                                        # signed in, no role in this workspace
    with pytest.raises(ToolError, match="cannot look at it"):
        run(TOOL.run(Ctx(db=main.db()), {}))
    state["role"] = "viewer"                                    # the page is a viewer's, so is the tool
    assert run(TOOL.run(Ctx(db=main.db()), {})).vars["section"] == "overview"
