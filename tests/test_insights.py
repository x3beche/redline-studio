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


def test_median():
    assert insights._median([]) is None
    assert insights._median([3, 1, 2]) == 2
    assert insights._median([4, 1, 3, 2]) == 2.5


def test_requests_are_summed_per_minute_and_route():
    insights._timing.clear()
    for ms in (10, 30, 400):
        insights.record_request("GET", "/api/x", 200, ms)
    insights.record_request("GET", "/api/x", 503, 12000)
    (key, row), = insights._timing.items()
    assert key[1:] == ("GET", "/api/x")
    assert row["count"] == 4 and row["errors"] == 1 and row["max_ms"] == 12000
    assert sum(row["hist"]) == 4 and row["hist"][-1] == 1      # the 12 s one is past the last edge
    insights._timing.clear()


def test_p95_reads_the_histogram():
    hist = [0] * (len(insights.LATENCY_EDGES) + 1)
    hist[0] = 95          # <= 25 ms
    hist[5] = 5           # <= 1000 ms
    assert insights.p95(hist) == 25
    hist[0] = 90
    assert insights.p95(hist) == 1000
    assert insights.p95([0] * len(hist)) is None


def test_only_one_server_holds_the_sampler_lease():
    import asyncio

    class Coll:
        def __init__(self):
            self.doc = None

        async def find_one_and_update(self, query, update, upsert, return_document):
            from pymongo.errors import DuplicateKeyError
            me = update["$set"]["owner"]
            free = (self.doc is None or self.doc["owner"] == me
                    or self.doc["until"] < update["$set"]["until"] - timedelta(seconds=insights.LEASE_S)
                    or self.doc.get("version", 0) < update["$set"]["version"])
            if not free:
                raise DuplicateKeyError("held")
            self.doc = dict(update["$set"])
            return self.doc

    coll = Coll()
    db = {insights.METRICS + "_lease": coll}
    assert asyncio.run(insights._hold_lease(db)) is True
    insights_me = insights._ME
    try:
        insights._ME = "other:1"
        assert asyncio.run(insights._hold_lease(db)) is False
    finally:
        insights._ME = insights_me
    assert asyncio.run(insights._hold_lease(db)) is True


def test_newer_sampler_code_takes_the_lease_from_older():
    import asyncio
    from datetime import datetime, timezone

    class Coll:
        doc = {"_id": "sampler", "owner": "old:1", "version": 1,
               "until": datetime.now(timezone.utc) + timedelta(seconds=60)}

        async def find_one_and_update(self, query, update, upsert, return_document):
            ors = query["$or"]
            ok = (self.doc["owner"] == update["$set"]["owner"]
                  or any("version" in o and o["version"].get("$lt", -1) > self.doc.get("version", 0)
                         for o in ors))
            if not ok:
                from pymongo.errors import DuplicateKeyError
                raise DuplicateKeyError("held")
            self.doc = dict(update["$set"])
            return self.doc

    assert asyncio.run(insights._hold_lease({insights.METRICS + "_lease": Coll()})) is True
