"""The costs page's rate history: Frankfurter's range answer, per currency."""
from backend import fx


def test_a_range_becomes_one_series_per_currency():
    raw = {"rates": {"2026-09-10": {"TRY": 40.0, "EUR": 0.9},
                     "2026-09-09": {"TRY": 39.0, "EUR": 0.92},
                     "2026-09-11": {"TRY": 42.0}}}
    s = fx._series(raw, ["TRY", "EUR", "GBP"])
    assert [d for d, _ in s["TRY"]["points"]] == ["2026-09-09", "2026-09-10", "2026-09-11"]
    assert s["TRY"]["first"] == 39.0 and s["TRY"]["last"] == 42.0
    assert abs(s["TRY"]["change"] - 3 / 39) < 1e-9
    assert (s["TRY"]["low"], s["TRY"]["high"]) == (39.0, 42.0)
    assert len(s["EUR"]["points"]) == 2              # a day without the currency is skipped
    assert "GBP" not in s
