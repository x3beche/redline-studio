"""Settings > Proxy & Data, at the foot of the page: the data traffic of
every outside lookup together - the Drawer's LCSC / EasyEDA part lookups,
the Parts page's crawler and the Chat's web tools - by the route each
request took (Local = directly, Proxy, Jina), in one set of buckets.

It merges what is already written down, without asking anybody anything:

- the proxy log (netproxy.LOG): every LCSC ask, direct or through the
  proxy, with its attempt (first, fallback, a retry from another exit); the
  crawler's requests through the proxy; the proxy's health checks and tests;
- the LCSC request journal (lcsc.journal): the lookups answered from disk
  and those held back while EasyEDA cools off - never sent, so not counted
  as requests;
- the Jina log (jina.LOG): every Reader and Search call, with its tokens;
- the catalog runs (manufacturers.JOBS): the crawler's direct requests,
  which are counted per run (its `totals`), not one by one - bucketed at
  the run's start;
- the proxy meter's hourly totals (netmeter): the bytes on the wire to and
  from the proxy - what the provider bills - priced from Settings > Costs.

The buckets are the app's time zone's (REDLINE_TZ, Europe/Istanbul by
default): hours for a day, local days otherwise.
"""

from __future__ import annotations

import bisect
import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROUTES = ("local", "proxy", "jina")
CONSUMERS = ("parts", "catalog", "chat", "checks")
REFUSED = (403, 429)
MAX_DAYS = 90


def tz() -> ZoneInfo:
    try:
        return ZoneInfo(os.environ.get("REDLINE_TZ", "Europe/Istanbul") or "Europe/Istanbul")
    except Exception:                                   # noqa: BLE001 - a bad name: UTC
        return ZoneInfo("UTC")


def buckets(days: int, now: datetime, zone: ZoneInfo) -> dict:
    """The period's buckets: {t0, step, n, edges} - edges[i] is where
    bucket i starts (epoch seconds), edges[n] where the last one ends.
    A day is 24 hours to this hour; more is whole local days to today."""
    local = now.astimezone(zone)
    if days <= 1:
        top = local.replace(minute=0, second=0, microsecond=0)
        start = top - timedelta(hours=23)
        edges = [start.timestamp() + 3600 * i for i in range(25)]
        return {"t0": int(edges[0]), "step": 3600, "n": 24, "edges": edges}
    first = (local - timedelta(days=days - 1)).date()
    edges = [datetime(d.year, d.month, d.day, tzinfo=zone).timestamp()
             for d in (first + timedelta(days=i) for i in range(days + 1))]
    return {"t0": int(edges[0]), "step": 86400, "n": days, "edges": edges}


def _ts(v) -> float | None:
    """A row's time as epoch seconds: a datetime (naive is UTC, as Mongo
    gives it back) or an ISO string."""
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).timestamp()
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v)
        except ValueError:
            return None
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()
    return None


def _pct(xs: list[float], q: float) -> int | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))])


def _jina_consumer(who: str | None) -> str:
    return {"manufacturers": "catalog", "chat": "chat", "settings": "checks"}.get(who or "", "chat")


def _proxy_log_consumer(kind: str | None) -> str:
    return "catalog" if kind == "manufacturer" else "checks" if kind in ("health", "test") else "parts"


def merge(*, days: int, now: datetime, zone: ZoneInfo, proxy_log: list[dict], journal: list[dict],
          jina_log: list[dict], runs: list[dict], hours: list[dict], price_per_gb: float) -> dict:
    """Everything into the same buckets. Pure: the rows come in, the
    figures go out (the tests hand it rows of their own)."""
    b = buckets(days, now, zone)
    edges, n = b["edges"], b["n"]

    def at(v) -> int | None:
        ts = _ts(v)
        if ts is None or ts < edges[0] or ts >= edges[-1]:
            return None
        return bisect.bisect_right(edges, ts) - 1

    by_route = {r: [0] * n for r in ROUTES}
    by_consumer = {c: [0] * n for c in CONSUMERS}
    wire = [0] * n
    tokens = [0] * n
    route = {r: {"requests": 0, "ok": 0, "refused": 0, "bytes": 0, "_ms": []} for r in ROUTES}
    route["jina"]["tokens"] = 0
    consumer = {c: {"requests": 0, "ok": 0, **{r: 0 for r in ROUTES}} for c in CONSUMERS}
    rescued = {"parts": 0, "catalog": 0}
    held = disk = 0

    def count(i: int, r: str, c: str, *, n_req: int = 1, ok: int = 0, refused: int = 0, size: int = 0,
              ms: float | None = None) -> None:
        by_route[r][i] += n_req
        by_consumer[c][i] += n_req
        x = route[r]
        x["requests"] += n_req
        x["ok"] += ok
        x["refused"] += refused
        x["bytes"] += size
        if ms is not None and ok:
            x["_ms"].append(ms)
        consumer[c]["requests"] += n_req
        consumer[c]["ok"] += ok
        consumer[c][r] += n_req

    # The proxy log: the LCSC asks either way, the crawler through the proxy, the checks.
    for row in proxy_log:
        i = at(row.get("at"))
        if i is None:
            continue
        r = "proxy" if row.get("via") == "proxy" else "local"
        c = _proxy_log_consumer(row.get("kind"))
        ok = row.get("status") == 200 and not row.get("error")
        count(i, r, c, ok=int(ok), refused=int(row.get("status") in REFUSED), size=int(row.get("bytes") or 0),
              ms=row.get("ms"))
        attempt = str(row.get("attempt") or "first")
        if ok and attempt not in ("first", "health", "test") and c in rescued:
            rescued[c] += 1                             # a fallback, or another exit, answered

    # The journal: what never went out.
    for row in journal:
        if at(row.get("at")) is None:
            continue
        if row.get("source") == "disk":
            disk += 1
        elif row.get("source") == "refused":
            held += 1

    # Jina, every call.
    for row in jina_log:
        i = at(row.get("at"))
        if i is None:
            continue
        ok = bool(row.get("ok"))
        tk = int(row.get("tokens") or 0)
        count(i, "jina", _jina_consumer(row.get("who")), ok=int(ok), refused=int(row.get("status") in REFUSED),
              size=int(row.get("chars") or 0), ms=row.get("ms"))
        tokens[i] += tk
        route["jina"]["tokens"] += tk

    # The crawler's direct requests, a run at a time.
    for run in runs:
        i = at(run.get("started_at"))
        t = run.get("totals") or {}
        req = int(t.get("requests_direct") or 0)
        if i is None or not req:
            if i is not None:
                rescued["catalog"] += int(t.get("rescued_jina") or 0)
            continue
        if "refused_direct" in t:
            ref = int(t["refused_direct"] or 0)
        else:                                           # a run from before it was kept apart
            ref = int(t.get("refused") or 0) if not (t.get("requests_proxy") or t.get("requests_jina")) else 0
        ref = min(ref, req)
        count(i, "local", "catalog", n_req=req, ok=req - ref, refused=ref, size=int(t.get("bytes_direct") or 0))
        rescued["catalog"] += int(t.get("rescued_jina") or 0)

    # The proxy's meter: bytes on the wire, by the hour (UTC).
    for h in hours:
        try:
            ts = datetime.strptime(h["_id"], "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError, TypeError):
            continue
        i = at(ts)
        if i is not None:
            wire[i] += int(h.get("up", 0) or 0) + int(h.get("down", 0) or 0)

    def td(series: dict) -> dict:
        return {"t0": b["t0"], "step": b["step"], "n": n,
                "series": [{"name": k, "values": v} for k, v in series.items()]}

    usd = [round(w / 1e9 * price_per_gb, 6) for w in wire]
    routes_out = {}
    for r, x in route.items():
        ms = x.pop("_ms")
        routes_out[r] = {**x, "failed": x["requests"] - x["ok"],
                         "success_rate": round(x["ok"] / x["requests"], 4) if x["requests"] else None,
                         "p50_ms": _pct(ms, .5), "p95_ms": _pct(ms, .95), "timed": len(ms)}
    routes_out["proxy"].update(wire_bytes=sum(wire), usd=round(sum(usd), 6))
    total = sum(x["requests"] for x in route.values())
    ok = sum(x["ok"] for x in route.values())
    return {
        "days": days, "step": b["step"], "t0": b["t0"], "n": n, "tz": getattr(zone, "key", str(zone)),
        "totals": {"requests": total, "ok": ok, "failed": total - ok,
                   "success_rate": round(ok / total, 4) if total else None,
                   "refused": sum(x["refused"] for x in route.values()),
                   "rescued": rescued["parts"] + rescued["catalog"], "rescued_by": rescued,
                   "held": held, "disk": disk},
        "routes": routes_out,
        "consumers": [{"id": c, **v} for c, v in consumer.items()],
        "cost": {"price_per_gb": price_per_gb, "proxy_bytes": sum(wire), "proxy_usd": round(sum(usd), 6),
                 "jina_tokens": route["jina"]["tokens"]},
        "requests": td(by_route),
        "by_consumer": td(by_consumer),
        "proxy_usd": td({"proxy": usd}),
        "jina_tokens": td({"jina": tokens}),
    }


async def overview(days: int) -> dict:
    """The merge, from the database and the journal: this space's rows,
    the machine's checks and meter."""
    from . import jina, lcsc, manufacturers, netmeter, netproxy
    days = max(1, min(int(days), MAX_DAYS))
    now = datetime.now(timezone.utc)
    zone = tz()
    since = datetime.fromtimestamp(buckets(days, now, zone)["t0"], timezone.utc)
    proxy_rows: list[dict] = []
    jina_rows: list[dict] = []
    runs: list[dict] = []
    price = float(netproxy._conf.get("price_per_gb", 3.99) or 0)
    try:
        from .main import db as main_db
        db = main_db()
    except Exception:                                   # noqa: BLE001 - no server: nothing kept
        db = None
    if db is not None:
        raw = db.raw if getattr(type(db), "SCOPED", False) else db
        fields = {"_id": 0, "at": 1, "kind": 1, "via": 1, "status": 1, "ms": 1, "bytes": 1, "attempt": 1,
                  "error": 1, "ws": 1}
        proxy_rows = [r async for r in raw[netproxy.LOG].find({"at": {"$gte": since}}, fields).limit(200_000)
                      if r.get("kind") == "health" or lcsc.mine(r)]
        jina_rows = [r async for r in raw[jina.LOG].find({"at": {"$gte": since}},
                                                         {"_id": 0, "at": 1, "ok": 1, "status": 1, "ms": 1,
                                                          "tokens": 1, "chars": 1, "who": 1, "ws": 1}).limit(200_000)
                     if lcsc.mine(r)]
        # The runs are this space's by the scoped database itself.
        runs = [r async for r in db[manufacturers.JOBS].find({"started_at": {"$gte": since.isoformat()[:19]}},
                                                             {"started_at": 1, "totals": 1})]
        try:
            from . import costs
            got = costs.derived(await costs.get(db))["proxy_per_gb"]
            price = got if got is not None else price
        except Exception:                               # noqa: BLE001
            pass
    hours = await netmeter.hourly(since.strftime("%Y-%m-%dT%H"))
    journal = [r for r in lcsc.journal(100_000) if lcsc.mine(r)]
    return merge(days=days, now=now, zone=zone, proxy_log=proxy_rows, journal=journal, jina_log=jina_rows,
                 runs=runs, hours=hours, price_per_gb=price)
