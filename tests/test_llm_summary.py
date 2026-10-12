"""The Chat room's Models card (GET /api/llm/summary): every provider
together - this month, today, the last days by day, and how the answers
came - and only the asking space's."""
from datetime import datetime, timedelta, timezone

from backend import cc_chat, llm_api, scope, usage
from tests.test_space_leaks import Coll, Raw, in_space


def iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat()


def answer(at: datetime, tps=None, ttft=None) -> dict:
    tm = {"finished_at": iso(at)}
    if tps is not None:
        tm["tps"] = tps
    if ttft is not None:
        tm["ttft_ms"] = ttft
    return {"role": "assistant", "timing": tm}


def setup(monkeypatch, ws="u1"):
    raw = Raw()
    now = datetime.now(timezone.utc)
    raw[usage.CALLS] = Coll([
        {"_id": 1, "provider": "commandcode", "at": iso(now), "workspace_id": ws, "input": 100, "output": 20, "cost_usd": None},
        {"_id": 2, "provider": "openrouter", "at": iso(now), "workspace_id": ws, "input": 50, "output": 30, "cost_usd": 0.01},
        {"_id": 3, "provider": "claude", "at": iso(now - timedelta(days=3)), "workspace_id": ws, "input": 1000,
         "output": 0, "cost_usd": 0.5},
        {"_id": 4, "provider": "claude", "at": iso(now - timedelta(days=40)), "workspace_id": ws, "input": 9, "output": 9},
        {"_id": 5, "provider": "openrouter", "at": iso(now), "workspace_id": "someone-else", "input": 7777, "output": 1},
        # An agent's own transcript (usage.py): not one of the app's providers, so not counted.
        {"_id": 6, "provider": "anthropic", "at": iso(now), "workspace_id": ws, "input": 5555, "output": 5, "cost_usd": 9.0},
    ])
    raw[cc_chat.COLL] = Coll([
        {"_id": "c1", "workspace_id": ws, "messages": [
            {"role": "user", "text": "?"}, answer(now, tps=40, ttft=800),
            {"role": "user", "text": "?"}, answer(now - timedelta(days=2), tps=20, ttft=1200),
            {"role": "user", "text": "?"}, answer(now - timedelta(days=30), tps=999),
            {"role": "user", "text": "?"}, {"role": "assistant", "text": "old, untimed"}]},
        {"_id": "c2", "workspace_id": "someone-else", "messages": [answer(now, tps=1)]},
    ])
    monkeypatch.setattr(llm_api, "_db", lambda: scope.ScopedDb(raw, ws))
    return now


def test_summary_adds_every_provider_up_and_keeps_to_the_space(monkeypatch):
    now = setup(monkeypatch)
    got = in_space("u1", lambda: llm_api.summary(14))
    assert got["days"] == 14 and len(got["by_day"]) == 14 and got["step"] == 86400
    assert got["today"]["calls"] == 2 and got["today"]["tokens"] == 200 and got["today"]["answers"] == 1
    assert got["by_day"][-1]["calls"] == 2 and abs(got["by_day"][-1]["cost_usd"] - 0.01) < 1e-9
    assert sum(d["calls"] for d in got["by_day"]) == 3              # the 40-day-old call is outside
    # The month: whatever of the three calls fell in this calendar month.
    m = got["month"]
    assert m["tokens"] == m["input"] + m["output"] and m["calls"] in (2, 3)
    assert 7777 not in (m["input"], got["today"]["tokens"] - 200)
    assert m["unpriced_calls"] == 1 and m["providers"] == m["calls"]  # one call each provider
    # Answers: the two within the 14 days, their median speed and first-token time.
    assert got["answers"] == {"n": 2, "tps_median": 30.0, "ttft_ms_median": 1000}
    assert got["t0"] <= (now - timedelta(days=13)).timestamp()


def test_summary_clamps_the_days_and_copes_with_nothing(monkeypatch):
    raw = Raw()
    monkeypatch.setattr(llm_api, "_db", lambda: scope.ScopedDb(raw, "u1"))
    got = in_space("u1", lambda: llm_api.summary(1000))
    assert got["days"] == 60 and len(got["by_day"]) == 60
    assert got["month"]["calls"] == 0 and got["month"]["cost_usd"] is None
    assert got["answers"] == {"n": 0, "tps_median": None, "ttft_ms_median": None}
    assert len(in_space("u1", lambda: llm_api.summary(1))["by_day"]) == 7
