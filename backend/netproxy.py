"""A proxy for EasyEDA's API, and nothing else (Settings > Proxy).

EasyEDA turns a burst of requests away for a while, by address (see
lcsc.py). A proxy gives the part lookups another way out: either every
ask goes through it ("always"), or only the one that was just turned away
is asked again through it ("fallback") before the cool-off starts. A
rotating residential proxy with no country set comes out somewhere new in
the world each time.

Only the LCSC/EasyEDA traffic uses it - the model providers, MongoDB and
everything else go out directly. The budget and the spacing in lcsc.py
stay as they are: the proxy is a second door, not a licence to ask more.

Machine-wide (like the LLM keys), kept in `server_settings`; the password
is never sent back to a page.
"""

from __future__ import annotations

import time
import urllib.parse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

COLL = "server_settings"
DOC_ID = "proxy"
MODES = ("always", "fallback")

_conf: dict = {}


async def load(db) -> dict:
    global _conf
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    _conf = dict(await raw[COLL].find_one({"_id": DOC_ID}) or {})
    _conf.pop("_id", None)
    from . import netmeter
    netmeter.set_upstream(_conf.get("host"), _conf.get("port"), (_conf.get("scheme") or "http") == "https")
    return _conf


def new_session() -> str | None:
    """A session of its own for one lookup: a new exit address, held while it
    lasts - so the address it went out from can be looked up afterwards.
    None when sticky sessions are off (the provider rotates on its own)."""
    import secrets
    return ("rl" + secrets.token_hex(5)) if _conf.get("sticky", True) else None


def username(conf: dict | None = None, session: str | None = None) -> str:
    """The provider's username with its options: a country (-region-xx) and
    a sticky session (-session-<id>), the way 2Captcha and most residential
    providers read them. Empty country: anywhere in the world."""
    c = _conf if conf is None else conf
    u = c.get("username") or ""
    if not u:
        return ""
    if c.get("country"):
        u += f"-region-{c['country'].lower()}"
    if session:
        u += f"-session-{session}"
    return u


def url(conf: dict | None = None, session: str | None = None) -> str | None:
    """http://user:pass@host:port, or None when there is no proxy to use."""
    c = _conf if conf is None else conf
    if not c.get("host") or not c.get("port"):
        return None
    auth = ""
    if c.get("username"):
        auth = urllib.parse.quote(username(c, session), safe="") + ":" + urllib.parse.quote(c.get("password") or "", safe="") + "@"
    return f"{c.get('scheme') or 'http'}://{auth}{c['host']}:{int(c['port'])}"


def client_url(session: str | None = None) -> str | None:
    """Where this machine's clients send proxied traffic: the meter on
    127.0.0.1 (netmeter.py), which hands every byte on to the proxy and
    counts it - with the proxy's own credentials, which go through as they
    are. Without the meter (a command line, a test): the proxy itself."""
    from . import netmeter
    direct = url(session=session)
    if not direct or not netmeter.port():
        return direct
    auth = direct.split("://", 1)[1].rsplit("@", 1)[0] + "@" if "@" in direct else ""
    return f"http://{auth}127.0.0.1:{netmeter.port()}"


def mode() -> str | None:
    """"always", "fallback", or None when off."""
    if not _conf.get("enabled") or not url():
        return None
    return _conf.get("mode") if _conf.get("mode") in MODES else "fallback"


def opener(via: bool, session: str | None = None):
    """A urllib opener that goes through the proxy when `via`, else directly."""
    import urllib.request
    p = client_url(session) if via else None
    if not p:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(urllib.request.ProxyHandler({"http": p, "https": p}))


def env(via: bool, session: str | None = None, base: dict | None = None) -> dict:
    """The environment for a tool that asks EasyEDA itself (easyeda2kicad)."""
    import os
    out = dict(base if base is not None else os.environ)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        out.pop(k, None)
    p = client_url(session) if via else None
    if p:
        out.update({"HTTP_PROXY": p, "HTTPS_PROXY": p, "http_proxy": p, "https_proxy": p})
    return out


EXIT_URL = "https://ipinfo.io/json"


def exit_info(session: str | None, timeout: float = 15) -> dict | None:
    """Where a session comes out: ip, country, city, region, org (the ISP),
    and how long the look took. One small request through the proxy (about
    1 kB), made only when the lookup went through it and only when asked."""
    import json
    if not session or not _conf.get("identify_exit", True) or not url():
        return None
    t0 = time.monotonic()
    try:
        d = json.loads(opener(True, session).open(EXIT_URL, timeout=timeout).read())
    except Exception as exc:                           # noqa: BLE001 - the lookup itself is what matters
        return {"error": str(exc)[:160], "ms": round((time.monotonic() - t0) * 1000)}
    return {"ip": d.get("ip"), "country": d.get("country"), "city": d.get("city"),
            "region": d.get("region"), "org": d.get("org"), "timezone": d.get("timezone"),
            "ms": round((time.monotonic() - t0) * 1000)}


# ---------------- the log: every ask, kept for the analytics ----------------
#
# The request journal (lcsc.py) is a short file for the board room's list;
# this keeps every ask for half a year, with where a proxied one came out,
# for Settings > Proxy. Written from the server only - an agent's command
# line has no database handle here, and its asks go direct.

LOG = "proxy_log"
KEEP_DAYS = 180
_db_getter = None
_indexed = False


def bind(db_getter) -> None:
    """The server hands over its database; until then nothing is logged."""
    global _db_getter
    _db_getter = db_getter


def log(row: dict) -> None:
    """Keep one ask. Never waits for, and never fails, the ask it describes."""
    import asyncio
    from datetime import datetime, timezone
    if _db_getter is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    from . import scope
    doc = {**row, "at": datetime.now(timezone.utc), "mode": mode() or "off",
           "country_pref": _conf.get("country") or None, "ws": scope.current()}

    async def write():
        global _indexed
        if doc.get("via") == "proxy" and doc.get("session"):
            # The tunnel closes a moment after the answer is read: wait for
            # the meter to close its books on this session.
            await asyncio.sleep(2.0)
            doc["wire"] = _split_wire(doc["session"])
        try:
            db = _db_getter()
            raw = db.raw if getattr(type(db), "SCOPED", False) else db
            if not _indexed:
                await raw[LOG].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400)
                _indexed = True
            await raw[LOG].insert_one(doc)
        except Exception:                              # noqa: BLE001
            pass
    loop.create_task(write())


def _split_wire(session: str) -> dict | None:
    """The metered bytes of one session: the lookup itself, and the look at
    where it came out (the exit host), apart."""
    from . import netmeter
    got = netmeter.session_bytes(session)
    if not got:
        return None
    exit_host = urllib.parse.urlparse(EXIT_URL).hostname
    out = {"up": 0, "down": 0, "conns": 0, "exit_up": 0, "exit_down": 0}
    for host, v in got.items():
        if host == exit_host:
            out["exit_up"] += v["up"]
            out["exit_down"] += v["down"]
        else:
            out["up"] += v["up"]
            out["down"] += v["down"]
            out["conns"] += v["conns"]
    return out


async def health_loop() -> None:
    """Every `health_minutes`, one look through the proxy at where it comes
    out - so the page can say whether the proxy is up, and how fast."""
    import asyncio
    while True:
        minutes = int(_conf.get("health_minutes", 30) or 0)
        if mode() and minutes > 0:
            t0 = time.monotonic()
            got = await asyncio.get_running_loop().run_in_executor(None, exit_info, new_session() or "health")
            ok = bool(got and got.get("ip"))
            log({"kind": "health", "target": EXIT_URL, "via": "proxy", "status": 200 if ok else None,
                 "ms": round((time.monotonic() - t0) * 1000), "bytes": 0,
                 "error": None if ok else (got or {}).get("error"), "attempt": "health", "who": "server",
                 "session": None, "exit": got})
        await asyncio.sleep(max(minutes, 5) * 60)


def public() -> dict:
    c = _conf
    return {"enabled": bool(c.get("enabled")), "mode": c.get("mode") or "fallback",
            "scheme": c.get("scheme") or "http", "host": c.get("host") or "",
            "port": c.get("port") or None, "username": c.get("username") or "",
            "password_set": bool(c.get("password")), "active": mode(),
            "sticky": c.get("sticky", True), "identify_exit": c.get("identify_exit", True),
            "country": c.get("country") or "", "price_per_gb": c.get("price_per_gb", 3.99),
            "health_minutes": c.get("health_minutes", 30), "meter_port": _meter_port()}


def _meter_port() -> int | None:
    from . import netmeter
    return netmeter.port()


# ---------------- the API ----------------

router = APIRouter(prefix="/api/proxy")


def _db():
    from .main import db
    return db()


@router.get("/settings")
async def get_settings() -> dict:
    return public()


class ProxyIn(BaseModel):
    enabled: bool | None = None
    mode: str | None = Field(default=None, pattern="^(always|fallback)$")
    scheme: str | None = Field(default=None, pattern="^(http|https)$")
    host: str | None = Field(default=None, max_length=200)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = Field(default=None, max_length=300)
    # Left out: unchanged. "" clears it.
    password: str | None = Field(default=None, max_length=300)
    sticky: bool | None = None                     # a session (exit address) per lookup
    identify_exit: bool | None = None              # look up where each proxied lookup came out
    country: str | None = Field(default=None, pattern="^([A-Za-z]{2})?$")   # "" = anywhere
    price_per_gb: float | None = Field(default=None, ge=0, le=1000)         # USD, for the estimate
    health_minutes: int | None = Field(default=None, ge=0, le=1440)         # 0 = no health checks


@router.put("/settings")
async def put_settings(body: ProxyIn) -> dict:
    from . import actors
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "host" in patch:
        h = patch["host"].strip()
        if h and ("/" in h or " " in h or "@" in h):
            raise HTTPException(400, "the host is a name or an address only - no scheme, path or user")
        patch["host"] = h
    raw = _db().raw if getattr(type(_db()), "SCOPED", False) else _db()
    if patch:
        await raw[COLL].update_one({"_id": DOC_ID}, {"$set": patch}, upsert=True)
    await load(_db())
    changed = [k if k != "password" else "password" for k in patch]
    if changed:
        await actors.audit(_db(), "settings", "proxy", {"changed": changed})
    return public()


@router.post("/test")
async def test() -> dict:
    """Ask, through the proxy, where we come out - twice, to show whether
    the address rotates."""
    import json

    if not url():
        raise HTTPException(400, "set the host and the port first")
    import asyncio
    out = []
    for _ in range(2):
        session = new_session()
        t0 = time.monotonic()
        try:
            raw = await asyncio.get_running_loop().run_in_executor(
                None, lambda: opener(True, session).open(EXIT_URL, timeout=25).read())
            d = json.loads(raw)
            got = {"ok": True, "ip": d.get("ip"), "country": d.get("country"), "city": d.get("city"),
                   "org": d.get("org"), "ms": round((time.monotonic() - t0) * 1000)}
        except Exception as exc:                       # noqa: BLE001
            got = {"ok": False, "error": str(exc)[:300], "ms": round((time.monotonic() - t0) * 1000)}
        out.append(got)
        log({"kind": "test", "target": EXIT_URL, "via": "proxy", "status": 200 if got["ok"] else None,
             "ms": got["ms"], "bytes": 0, "error": got.get("error"), "attempt": "test", "who": "settings",
             "session": session, "exit": {k: got.get(k) for k in ("ip", "country", "city", "org")} if got["ok"] else None})
    return {"exits": out, "rotates": len({e.get("ip") for e in out if e.get("ok")}) > 1}


@router.get("/usage")
async def usage(days: int = 7) -> dict:
    """The EasyEDA lookups over time - direct, through the proxy, refused,
    failed - and the bytes each way (what a proxy provider bills), from the
    request journal lcsc.py keeps."""
    import math
    from datetime import datetime

    from . import lcsc

    days = max(1, min(days, 30))
    step = 3600 if days <= 2 else 86400
    now = time.time()
    t0 = int((now - days * 86400) // step * step)
    n = max(1, math.ceil((now - t0) / step))
    names = ("direct", "proxy", "refused", "failed")
    lookups = {k: [0] * n for k in names}
    traffic = {k: [0] * n for k in ("direct", "proxy")}
    totals = {"lookups": 0, "direct": 0, "proxy": 0, "refused": 0, "failed": 0, "disk": 0,
              "bytes_direct": 0, "bytes_proxy": 0}
    kinds: dict[str, int] = {}
    # The asks this space made; the budget, the state and the bytes on the
    # wire stay the machine's.
    rows = [r for r in lcsc.journal(100_000) if lcsc.mine(r)]
    for r in rows:
        try:
            ts = datetime.fromisoformat(r["at"]).timestamp()
        except (KeyError, ValueError, TypeError):
            continue
        if ts < t0:
            continue
        i = min(n - 1, int((ts - t0) // step))
        src = r.get("source")
        if src == "disk":
            totals["disk"] += 1
            continue
        if src not in ("net", "refused"):
            continue                                   # "wait" lines are not asks
        totals["lookups"] += 1
        kinds[r.get("kind") or "?"] = kinds.get(r.get("kind") or "?", 0) + 1
        via = r.get("via") or "direct"
        status = r.get("status")
        if src == "refused" or status in (403, 429):
            what = "refused"
        elif status == 200:
            what = via
        else:
            what = "failed"
        lookups[what][i] += 1
        totals[what] += 1
        if src == "net":
            traffic[via][i] += r.get("bytes") or 0
            totals[f"bytes_{via}"] += r.get("bytes") or 0

    def td(series: dict) -> dict:
        return {"t0": t0, "step": step, "n": n, "series": [{"name": k, "values": v} for k, v in series.items()]}

    st = lcsc.state()
    log_part = await _log_usage(days, t0, step, n)
    return {**log_part, "days": days, "step": step, "totals": totals, "lookups": td(lookups), "bytes": td(traffic),
            "by_kind": sorted(({"name": k, "n": v} for k, v in kinds.items()), key=lambda x: -x["n"]),
            "recent": [{k: r.get(k) for k in ("at", "who", "kind", "target", "source", "status", "via", "ms", "bytes", "error")}
                       for r in rows[:30]],
            "state": {**st, "asks_in_window": st.get("used")}}


def _pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))])


async def _log_usage(days: int, t0: int, step: int, n: int) -> dict:
    """The analytics only the log can give: where the proxy came out, how
    fast each way was, how often it worked, the health checks, the bill."""
    from datetime import datetime, timezone

    from . import lcsc
    if _db_getter is None:
        return {"exits": None, "latency": None, "health": None, "cost": None, "log": []}
    db = _db_getter()
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    since = datetime.fromtimestamp(t0, timezone.utc)
    # This space's asks and tests; the health checks are the machine's.
    rows = [r async for r in raw[LOG].find({"at": {"$gte": since}}, {"_id": 0}).sort("at", -1).limit(20000)
            if r.get("kind") == "health" or lcsc.mine(r)]

    def count(key) -> list[dict]:
        c: dict[str, int] = {}
        for r in rows:
            v = key(r)
            if v:
                c[v] = c.get(v, 0) + 1
        return sorted(({"name": k, "n": v} for k, v in c.items()), key=lambda x: -x["n"])

    proxied = [r for r in rows if r.get("via") == "proxy" and r.get("exit") and r["exit"].get("ip")]
    exits = {"by_country": count(lambda r: (r.get("exit") or {}).get("country") if r in proxied else None),
             "by_org": count(lambda r: (r.get("exit") or {}).get("org") if r in proxied else None),
             "by_city": count(lambda r: ", ".join(x for x in ((r.get("exit") or {}).get("city"),
                                                               (r.get("exit") or {}).get("country")) if x)
                              if r in proxied else None)[:20],
             "distinct_ips": len({r["exit"]["ip"] for r in proxied}),
             "identified": len(proxied)}

    asks = [r for r in rows if r.get("kind") not in ("health", "test")]
    latency: dict = {"series": None}
    ms_series = {k: [None] * n for k in ("direct", "proxy")}
    sums = {k: [[0, 0] for _ in range(n)] for k in ("direct", "proxy")}
    for via in ("direct", "proxy"):
        mine = [r for r in asks if (r.get("via") or "direct") == via]
        ok = [r for r in mine if r.get("status") == 200]
        latency[via] = {"asks": len(mine), "ok": len(ok),
                        "success_rate": round(len(ok) / len(mine), 4) if mine else None,
                        "p50_ms": _pct([r.get("ms") or 0 for r in ok], .5),
                        "p95_ms": _pct([r.get("ms") or 0 for r in ok], .95),
                        "bytes": sum(r.get("bytes") or 0 for r in ok)}
        for r in ok:
            i = min(n - 1, max(0, int((r["at"].replace(tzinfo=timezone.utc).timestamp() - t0) // step)))
            sums[via][i][0] += r.get("ms") or 0
            sums[via][i][1] += 1
        ms_series[via] = [round(a / b) if b else None for a, b in sums[via]]
    latency["series"] = {"t0": t0, "step": step, "n": n,
                         "series": [{"name": k, "values": v} for k, v in ms_series.items()]}

    checks = [r for r in rows if r.get("kind") == "health"]
    up = [r for r in checks if r.get("status") == 200]
    health = {"every_minutes": _conf.get("health_minutes", 30), "checks": len(checks), "ok": len(up),
              "uptime": round(len(up) / len(checks), 4) if checks else None,
              "p50_ms": _pct([r.get("ms") or 0 for r in up], .5),
              "last": ({"at": checks[0]["at"].isoformat(), "ok": checks[0].get("status") == 200,
                        **(checks[0].get("exit") or {})} if checks else None)}

    # The bill: bytes on the wire to and from the proxy, counted by the
    # meter (netmeter.py) - CONNECT, TLS, headers and bodies, both ways.
    from . import netmeter
    hours = await netmeter.hourly(datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%dT%H"))
    up_s, down_s = [0] * n, [0] * n
    hosts: dict[str, dict] = {}
    m_up = m_down = m_conns = 0
    for h in hours:
        ts = datetime.strptime(h["_id"], "%Y-%m-%dT%H").replace(tzinfo=timezone.utc).timestamp()
        i = min(n - 1, max(0, int((ts - t0) // step)))
        up_s[i] += h.get("up", 0)
        down_s[i] += h.get("down", 0)
        m_up += h.get("up", 0)
        m_down += h.get("down", 0)
        m_conns += h.get("conns", 0)
        for name, v in (h.get("hosts") or {}).items():
            row = hosts.setdefault(name, {"name": name.replace("_", "."), "up": 0, "down": 0, "conns": 0})
            row["up"] += v.get("up", 0)
            row["down"] += v.get("down", 0)
            row["conns"] += v.get("conns", 0)
    metered = {"up": m_up, "down": m_down, "total": m_up + m_down, "conns": m_conns,
               "by_host": sorted(hosts.values(), key=lambda x: -(x["up"] + x["down"])),
               "series": {"t0": t0, "step": step, "n": n,
                          "series": [{"name": "sent", "values": up_s}, {"name": "received", "values": down_s}]},
               "since": hours[0]["_id"] if hours else None,
               "payload_bytes": latency["proxy"]["bytes"]}
    price = float(_conf.get("price_per_gb", 3.99) or 0)
    if _db_getter is not None:                         # Settings > Costs, in whatever currency it was typed
        try:
            from . import costs
            got = costs.derived(await costs.get(_db_getter()))["proxy_per_gb"]
            price = got if got is not None else price
        except Exception:                              # noqa: BLE001
            pass
    gb = (m_up + m_down) / 1e9
    cost = {"gb": round(gb, 9), "bytes": m_up + m_down, "price_per_gb": price, "usd": round(gb * price, 6),
            "note": "measured on the wire between this machine and the proxy (both directions, TLS and "
                    "headers included); the provider's dashboard remains the bill of record"}

    def out(r: dict) -> dict:
        e = r.get("exit") or {}
        return {"at": r["at"].isoformat(), "kind": r.get("kind"), "target": r.get("target"), "via": r.get("via"),
                "status": r.get("status"), "ms": r.get("ms"), "bytes": r.get("bytes"), "attempt": r.get("attempt"),
                "error": r.get("error"), "ip": e.get("ip"), "country": e.get("country"), "city": e.get("city"),
                "org": e.get("org"), "exit_ms": e.get("ms"),
                "wire_up": (r.get("wire") or {}).get("up"), "wire_down": (r.get("wire") or {}).get("down"),
                "exit_wire": ((r.get("wire") or {}).get("exit_up") or 0) + ((r.get("wire") or {}).get("exit_down") or 0)
                if r.get("wire") else None}
    return {"exits": exits, "latency": latency, "health": health, "cost": cost, "metered": metered,
            "log": [out(r) for r in rows[:50]]}


@router.get("/sessions/{session}")
async def session_traffic(session: str) -> dict:
    """What one session moved through the proxy, by destination, as the
    meter counted it on the wire (kept for a quarter of an hour)."""
    from . import netmeter
    got = netmeter.session_bytes(session)
    if got is None:
        raise HTTPException(404, "no traffic recorded for that session (or it is older than 15 minutes)")
    return {"session": session, "by_host": got,
            "up": sum(v["up"] for v in got.values()), "down": sum(v["down"] for v in got.values())}
