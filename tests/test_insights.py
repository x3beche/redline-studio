"""The Analytics room's arithmetic: ranges, buckets, the kept answer."""
from datetime import datetime, timedelta, timezone

from backend import insights

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


def test_ranges_parse_and_fall_back():
    since, until = insights.parse_range("7d", NOW)
    assert until == NOW and until - since == timedelta(days=7)
    assert insights.parse_range("6h", NOW)[0] == NOW - timedelta(hours=6)
    assert insights.parse_range("nonsense", NOW)[0] == NOW - timedelta(hours=24)


def test_bucket_size_follows_the_range():
    assert insights.bucket_for(3600) == 300
    assert insights.bucket_for(86400) == 3600
    assert insights.bucket_for(30 * 86400) == 86400
    assert insights.bucket_for(365 * 86400) == 7 * 86400


def test_buckets_sum_per_series_and_fold_the_tail_into_other():
    b = insights.Buckets(NOW - timedelta(hours=3), NOW, 3600)
    b.add("a", NOW - timedelta(hours=2, minutes=30), 2)
    b.add("a", NOW - timedelta(hours=2, minutes=10), 3)
    b.add("b", NOW - timedelta(minutes=5), 1)
    b.add("c", NOW - timedelta(minutes=5), 0.5)
    b.add("a", NOW - timedelta(days=2), 99)          # outside: ignored
    out = b.out(top=1)
    assert out["n"] == 4 and out["step"] == 3600
    names = [s["name"] for s in out["series"]]
    assert names == ["a", "other"]
    assert out["series"][0]["values"][0] == 5
    assert sum(out["series"][1]["values"]) == 1.5


def test_the_kept_answer_survives_on_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(insights, "CACHE_DIR", tmp_path)
    insights._CACHE.clear()
    insights._remember("7d", {"llm": {"calls": 3}})
    insights._CACHE.clear()                            # a server restart
    at, data = insights._recall("7d")
    assert data["llm"]["calls"] == 3
    insights.forget()
    assert insights._recall("7d") is None
