"""Settings > Proxy & Data's "Data traffic" (backend/netoverview.py): the
proxy log, the LCSC journal, the Jina log, the catalog runs and the proxy's
meter merged into the same buckets, in the app's time zone. Rows of the
tests' own; nothing is asked of any network."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from backend import access, jina, manufacturers, netmeter, netoverview, netproxy
from test_users_admin import db, person  # noqa: F401 - db is a fixture

IST = ZoneInfo("Europe/Istanbul")
NOW = datetime(2026, 10, 12, 12, 30, tzinfo=timezone.utc)          # 15:30 in Istanbul


def run(c):
    return asyncio.run(c)


def test_the_buckets_are_local_hours_and_local_days():
    b = netoverview.buckets(1, NOW, IST)
    assert (b["step"], b["n"]) == (3600, 24)
    assert datetime.fromtimestamp(b["edges"][-1], IST).hour == 16                  # to the end of this hour
    b = netoverview.buckets(7, NOW, IST)
    assert (b["step"], b["n"]) == (86400, 7)
    first = datetime.fromtimestamp(b["t0"], IST)
    assert (first.day, first.hour) == (6, 0)                                      # local midnight, six days back
    assert datetime.fromtimestamp(b["edges"][-1], IST).day == 13


def merged(**kw):
    base = {"days": 7, "now": NOW, "zone": IST, "proxy_log": [], "journal": [], "jina_log": [], "runs": [],
            "hours": [], "price_per_gb": 4.0}
    return netoverview.merge(**{**base, **kw})


def test_every_source_lands_in_the_same_buckets():
    today = datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc)
    # 22:30 UTC on the 10th is already the 11th in Istanbul.
    late = datetime(2026, 10, 10, 22, 30)                                         # naive, as Mongo answers
    plog = [
        {"at": today, "kind": "component", "via": "direct", "status": 403, "ms": 300, "attempt": "first"},
        {"at": today, "kind": "component", "via": "proxy", "status": 200, "ms": 900, "bytes": 2000, "attempt": "fallback"},
        {"at": late, "kind": "search", "via": "direct", "status": 200, "ms": 200, "bytes": 500, "attempt": "first"},
        {"at": today, "kind": "manufacturer", "via": "proxy", "status": 200, "ms": 1200, "attempt": "first"},
        {"at": today, "kind": "health", "via": "proxy", "status": 200, "ms": 700, "attempt": "health"},
        {"at": today - timedelta(days=30), "kind": "component", "via": "direct", "status": 200},   # outside
    ]
    journal = [{"at": today.isoformat(), "source": "disk"}, {"at": today.isoformat(), "source": "refused"},
               {"at": today.isoformat(), "source": "net", "via": "direct", "status": 200}]   # in the proxy log already
    jlog = [{"at": today, "api": "reader", "ok": True, "ms": 1500, "tokens": 800, "who": "manufacturers"},
            {"at": today, "api": "search", "ok": True, "ms": 1000, "tokens": 10000, "who": "chat"},
            {"at": today, "api": "reader", "ok": False, "status": 429, "ms": 100, "tokens": 0, "who": "chat"}]
    runs = [{"started_at": "2026-10-12T08:00:00+00:00",
             "totals": {"requests_direct": 30, "refused_direct": 2, "bytes_direct": 10_000, "rescued_jina": 1}},
            {"started_at": "2026-10-11T08:00:00+00:00",                           # an old run: refused together
             "totals": {"requests_direct": 5, "refused": 1, "requests_proxy": 0}}]
    hours = [{"_id": "2026-10-12T09", "up": 1_000_000, "down": 249_000_000},
             {"_id": "2026-10-01T09", "up": 5, "down": 5}]                         # outside
    out = merged(proxy_log=plog, journal=journal, jina_log=jlog, runs=runs, hours=hours)

    r = out["routes"]
    assert r["local"]["requests"] == 2 + 35 and r["local"]["ok"] == 1 + 28 + 4 and r["local"]["refused"] == 1 + 3
    assert r["proxy"]["requests"] == 3 and r["proxy"]["ok"] == 3 and r["proxy"]["p50_ms"] == 900
    assert r["jina"]["requests"] == 3 and r["jina"]["ok"] == 2 and r["jina"]["tokens"] == 10_800
    assert r["local"]["p50_ms"] == 200                                            # only the timed ones
    t = out["totals"]
    assert t["requests"] == 43 and t["held"] == 1 and t["disk"] == 1
    assert t["rescued"] == 2 and t["rescued_by"] == {"parts": 1, "catalog": 1}
    c = {x["id"]: x for x in out["consumers"]}
    assert c["parts"]["requests"] == 3 and c["parts"]["proxy"] == 1
    assert c["catalog"]["requests"] == 1 + 35 + 1 and c["catalog"]["jina"] == 1
    assert c["chat"]["requests"] == 2 and c["checks"]["requests"] == 1
    # The same buckets for every series: the last is today, the one before the 11th (local).
    req = {s["name"]: s["values"] for s in out["requests"]["series"]}
    assert all(len(v) == 7 for v in req.values())
    assert req["local"][-1] == 1 + 30 and req["local"][-2] == 1 + 5
    assert req["proxy"][-1] == 3 and req["jina"][-1] == 3
    # The bill: 250 MB on the wire at 4 USD a GB.
    assert out["cost"]["proxy_bytes"] == 250_000_000 and out["cost"]["proxy_usd"] == 1.0
    assert out["proxy_usd"]["series"][0]["values"][-1] == 1.0
    assert out["jina_tokens"]["series"][0]["values"][-1] == 10_800
    assert out["tz"] == "Europe/Istanbul"


def test_a_day_is_counted_by_the_hour():
    plog = [{"at": NOW - timedelta(minutes=10), "kind": "search", "via": "proxy", "status": 200, "ms": 100},
            {"at": NOW - timedelta(hours=5), "kind": "search", "via": "direct", "status": 200, "ms": 100}]
    out = merged(days=1, proxy_log=plog)
    req = {s["name"]: s["values"] for s in out["requests"]["series"]}
    assert out["step"] == 3600 and len(req["proxy"]) == 24
    assert req["proxy"][-1] == 1 and req["local"][-6] == 1


def test_the_route_reads_the_logs_and_is_for_anyone_who_may_look(db, monkeypatch):  # noqa: F811
    from backend import main
    assert access.action("GET", "/api/proxy/overview") == "view" and access.page_allowed("GET", "/api/proxy/overview")
    monkeypatch.setattr(netmeter, "_db_getter", None)
    monkeypatch.setattr(netproxy, "_conf", {"price_per_gb": 2.0})
    now = datetime.now(timezone.utc)
    run(db[netproxy.LOG].insert_one({"_id": "p1", "at": now, "kind": "component", "via": "proxy", "status": 200,
                                     "ms": 500, "attempt": "first", "ws": "default"}))
    run(db[netproxy.LOG].insert_one({"_id": "p2", "at": now, "kind": "component", "via": "direct", "status": 200,
                                     "ms": 500, "attempt": "first", "ws": "elsewhere"}))   # another space's
    run(db[jina.LOG].insert_one({"_id": "j1", "at": now, "api": "search", "ok": True, "ms": 900, "tokens": 10_000,
                                 "who": "chat", "ws": "default"}))
    run(main.db()[manufacturers.JOBS].insert_one({"_id": "r1", "started_at": now.isoformat(),
                                                  "totals": {"requests_direct": 4, "refused_direct": 0}}))
    got = person(db, "o").get("/api/proxy/overview?days=30")
    assert got.status_code == 200
    out = got.json()
    assert out["days"] == 30 and out["n"] == 30
    assert out["routes"]["proxy"]["requests"] == 1 and out["routes"]["local"]["requests"] == 4
    assert out["routes"]["jina"]["tokens"] == 10_000
    assert person(db, "o").get("/api/proxy/overview?days=500").json()["days"] == 90
    assert person(db, "a").get("/api/proxy/overview?days=1").status_code == 200   # a user may look too
