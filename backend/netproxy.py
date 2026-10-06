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
