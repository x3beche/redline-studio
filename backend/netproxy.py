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
    return _conf


def url(conf: dict | None = None) -> str | None:
    """http://user:pass@host:port, or None when there is no proxy to use."""
    c = _conf if conf is None else conf
    if not c.get("host") or not c.get("port"):
        return None
    auth = ""
    if c.get("username"):
        auth = urllib.parse.quote(c["username"], safe="") + ":" + urllib.parse.quote(c.get("password") or "", safe="") + "@"
    return f"{c.get('scheme') or 'http'}://{auth}{c['host']}:{int(c['port'])}"


def mode() -> str | None:
    """"always", "fallback", or None when off."""
    if not _conf.get("enabled") or not url():
        return None
    return _conf.get("mode") if _conf.get("mode") in MODES else "fallback"


def opener(via: bool):
    """A urllib opener that goes through the proxy when `via`, else directly."""
    import urllib.request
    p = url() if via else None
    if not p:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(urllib.request.ProxyHandler({"http": p, "https": p}))


def env(via: bool, base: dict | None = None) -> dict:
    """The environment for a tool that asks EasyEDA itself (easyeda2kicad)."""
    import os
    out = dict(base if base is not None else os.environ)
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        out.pop(k, None)
    p = url() if via else None
    if p:
        out.update({"HTTP_PROXY": p, "HTTPS_PROXY": p, "http_proxy": p, "https_proxy": p})
    return out


def public() -> dict:
    c = _conf
    return {"enabled": bool(c.get("enabled")), "mode": c.get("mode") or "fallback",
            "scheme": c.get("scheme") or "http", "host": c.get("host") or "",
            "port": c.get("port") or None, "username": c.get("username") or "",
            "password_set": bool(c.get("password")), "active": mode()}


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
    out = []
    for _ in range(2):
        t0 = time.monotonic()
        try:
            import asyncio
            raw = await asyncio.get_running_loop().run_in_executor(
                None, lambda: opener(True).open("https://ipinfo.io/json", timeout=25).read())
            d = json.loads(raw)
            out.append({"ok": True, "ip": d.get("ip"), "country": d.get("country"), "city": d.get("city"),
                        "org": d.get("org"), "ms": round((time.monotonic() - t0) * 1000)})
        except Exception as exc:                       # noqa: BLE001
            out.append({"ok": False, "error": str(exc)[:300], "ms": round((time.monotonic() - t0) * 1000)})
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
    rows = lcsc.journal(100_000)
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
    return {"days": days, "step": step, "totals": totals, "lookups": td(lookups), "bytes": td(traffic),
            "by_kind": sorted(({"name": k, "n": v} for k, v in kinds.items()), key=lambda x: -x["n"]),
            "recent": [{k: r.get(k) for k in ("at", "who", "kind", "target", "source", "status", "via", "ms", "bytes", "error")}
                       for r in rows[:30]],
            "state": {**st, "asks_in_window": st.get("used")}}
