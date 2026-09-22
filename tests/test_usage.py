"""The analytics have to be right or the card lies about money.

The one that matters: Claude Code writes one transcript line per content
block and every line of a request repeats the SAME usage. Counting lines
instead of requests trebles the bill.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import usage


def entry(req, at, model="claude-opus-5", out=100, cr=1000, cw=10, block=0):
    return {"type": "assistant", "requestId": req, "timestamp": at,
            "apiBlockIndex": block, "sessionId": "s1",
            "message": {"model": model,
                        "usage": {"input_tokens": 2, "output_tokens": out,
                                  "cache_read_input_tokens": cr,
                                  "cache_creation_input_tokens": cw,
                                  "output_tokens_details": {"thinking_tokens": 5},
                                  "service_tier": "standard"}}}


def test_row_keyed_by_request_so_blocks_cannot_double_count():
    a = usage._row(entry("req_1", "2026-09-22T08:00:00Z", block=0))
    b = usage._row(entry("req_1", "2026-09-22T08:00:00Z", block=1))
    assert a["_id"] == b["_id"] == "cc:req_1"


def test_rows_without_usage_or_request_are_skipped():
    assert usage._row({"type": "assistant", "message": {}}) is None
    assert usage._row({"type": "user", "message": {"usage": {}}}) is None
    e = entry("req_1", "2026-09-22T08:00:00Z")
    e["requestId"] = None
    assert usage._row(e) is None


def test_price_uses_every_token_class():
    r = usage.PRICES["claude-opus-5"]
    got, basis = usage.price("claude-opus-5", 1_000_000, 1_000_000,
                             1_000_000, 1_000_000)
    assert got == pytest.approx(r["input"] + r["output"] +
                                r["cache_read"] + r["cache_write"])
    assert basis == r["basis"]


def test_unknown_model_reports_tokens_but_no_invented_price():
    assert usage.price("some-other-llm", 1000, 1000, 0, 0) == (None, None)


def test_dated_build_of_a_known_model_still_prices():
    got, _ = usage.price("claude-opus-5-20260101", 1_000_000, 0, 0, 0)
    assert got == pytest.approx(usage.PRICES["claude-opus-5"]["input"])


def _rows(n, start, step_s=30, out=100):
    t = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)
    return [{"at": (t + timedelta(seconds=start + i * step_s)).isoformat(),
             "model": "claude-opus-5", "provider": "anthropic",
             "input": 2, "output": out, "cache_read": 1000, "cache_write": 10,
             "thinking": 5, "cost_usd": 0.5, "cost_basis": "assumed"}
            for i in range(n)]


def test_totals_and_rate():
    rows = _rows(4, 0)
    out = usage.summarise(rows, "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:02:00+00:00")
    assert out["seconds"] == 120.0
    assert out["totals"]["calls"] == 4
    assert out["totals"]["output"] == 400
    assert out["totals"]["billed_tokens"] == 4 * (2 + 100 + 1000 + 10)
    assert out["totals"]["cost_usd"] == pytest.approx(2.0)
    assert out["rate"]["output_per_s"] == pytest.approx(400 / 120, abs=0.01)


def test_one_unpriced_call_marks_the_total_incomplete():
    rows = _rows(2, 0)
    rows[1]["cost_usd"] = None
    rows[1]["model"] = "mystery-1"
    out = usage.summarise(rows, "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:01:00+00:00")
    assert out["totals"]["complete"] is False
    assert out["totals"]["unpriced_models"] == ["mystery-1"]
    # the part we do know is still reported, not thrown away
    assert out["totals"]["cost_usd"] == pytest.approx(0.5)


def test_two_providers_are_split():
    rows = _rows(2, 0) + [{**_rows(1, 0)[0], "provider": "openrouter",
                           "model": "deepseek/deepseek-v4.1-flash",
                           "cost_usd": 0.0002, "cost_basis": "billed"}]
    out = usage.summarise(rows, "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:01:00+00:00")
    assert {p["provider"] for p in out["providers"]} == {"anthropic", "openrouter"}
    assert len(out["models"]) == 2


def test_series_buckets_by_thirty_seconds():
    out = usage.summarise(_rows(3, 0, step_s=30),
                          "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:01:30+00:00")
    assert out["series"]["bucket_s"] == 30
    assert out["series"]["output"] == [100, 100, 100]


def test_calls_before_the_window_do_not_land_in_the_chart():
    # A row can predate the window when the clock skews; it must not become
    # a negative bucket index and wrap to the end of the list.
    out = usage.summarise(_rows(1, -300), "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:01:00+00:00")
    assert out["series"]["output"] == []
    assert out["totals"]["calls"] == 1


def test_empty_window_does_not_divide_by_zero():
    out = usage.summarise([], "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:00:00+00:00")
    assert out["seconds"] == 0.0
    assert out["rate"]["output_per_s"] is None
    assert out["totals"]["cost_usd"] == 0.0


def test_a_running_run_is_measured_up_to_now():
    start = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
    out = usage.summarise([], start, None)
    assert out["seconds"] >= 59


def test_surface_split_separates_the_agent_from_the_summariser():
    rows = _rows(2, 0)
    for r in rows:
        r["surface"] = "claude-code"
    rows.append({**_rows(1, 0)[0], "surface": "card-summary",
                 "provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash",
                 "output": 12, "cost_usd": 0.0002})
    out = usage.summarise(rows, "2026-09-22T08:00:00+00:00",
                          "2026-09-22T08:01:00+00:00")
    by = {s["surface"]: s for s in out["surfaces"]}
    assert by["claude-code"]["calls"] == 2
    assert by["card-summary"]["calls"] == 1
    assert by["card-summary"]["provider"] == "openrouter"
    # the summariser's cost is in the total, not off to one side
    assert out["totals"]["cost_usd"] == pytest.approx(1.0002)
