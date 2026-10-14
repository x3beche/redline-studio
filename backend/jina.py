"""Jina AI: its Reader and its Search, with the key kept on the server
(Settings > Proxy & Data).

Reader (https://r.jina.ai/<url>) reads a web page on Jina's side - a real
browser, the page's script run there, not here - and answers with the page
as Markdown: its title, its text, its links and pictures. So a page that
needs JavaScript, or that turns a plain fetch away, can still be read. The
Product Catalog's crawler uses it where its order of routes has the `jina`
route (backend/netroutes.py, backend/manufacturers.py: first, or after a
site refuses or a page comes back empty without its script), and the
Chat's `web_read` tool reads one page with it.

Search (https://s.jina.ai/search?q=...) is a web search: the top results'
titles, addresses and snippets. The Chat's `web_search` tool uses it.

Both take the same API key, which is Workbench's, not a person's: machine-wide
like the LLM keys (backend/llm.py), kept in `server_settings`, changed only
by the owner or an admin, and never sent back to a page - only its last
four characters. It goes to Jina in the Authorization header (and to Jina's
dashboard for the balance), never into a log line.

Every call is written down (`jina_log`, half a year): which API, what was
asked, how long it took, the characters and tokens that came back, whether
it worked - the page's analytics, Reader's and Search's apart. The key's
balance comes from Jina's own dashboard API (`BALANCE_URL`, the one
jina.ai's key manager reads): what is left, the free trial's tokens and
the paid ones apart.

Docs: https://jina.ai/reader (Reader and Search), https://r.jina.ai/docs,
https://s.jina.ai/docs.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import secretbox

COLL = "server_settings"
DOC_ID = "jina"
LOG = "jina_log"
KEEP_DAYS = 180
READER = "https://r.jina.ai/"
SEARCH = "https://s.jina.ai/search"
BALANCE_URL = "https://embeddings-dashboard-api.jina.ai/api/v1/api_key/user"
CHECK_URL = "https://example.com/"           # what the key check reads when the balance does not say
TIMEOUT = 30.0                               # one call, Jina's rendering included
PAGE_TIMEOUT = 20                            # what Jina is told to wait for a page (X-Timeout)
MAX_CHARS = 400_000                          # of one answer; the rest is not kept
SEARCH_MAX = 10                              # results of one search
CHARS_PER_TOKEN = 4                          # an estimate, when Jina does not say
APIS = ("reader", "search")

_conf: dict = {}
_db_getter = None
_indexed = False
_account: dict = {}                           # {"at": monotonic, "out": {...}}


# ---------------------------------------------------------------- the key

# Like the LLM settings (backend/llm.py): a process that never read the
# key - or whose read failed - is told so when it asks, rather than taken
# for one where no key is saved.
_loaded = False
_load_error: str | None = None


async def load(db) -> dict:
    global _conf, _loaded, _load_error
    try:
        raw = db.raw if getattr(type(db), "SCOPED", False) else db
        doc = await raw[COLL].find_one({"_id": DOC_ID})
    except Exception as exc:
        if not _loaded:
            _load_error = f"{type(exc).__name__}: {str(exc)[:200]}"
        raise
    _conf = dict(doc or {})
    _conf.pop("_id", None)
    _loaded, _load_error = True, None
    return _conf


def _ready() -> None:
    if _loaded:
        return
    from .llm import NotLoaded
    why = f"reading it failed ({_load_error})" if _load_error else "it was never read in this process"
    raise NotLoaded(f"Jina settings not loaded: whether a Jina API key is saved is not known because {why} - "
                    "the process must await jina.load(db) first")


def bind(db_getter) -> None:
    """The server hands over its database; until then nothing is logged."""
    global _db_getter
    _db_getter = db_getter


def key() -> str:
    _ready()
    return (secretbox.reveal(_conf.get("key"), "the Jina API key") or "").strip()


def configured() -> bool:
    return bool(key())


def public() -> dict:
    """What a page may see: whether the key is set and its last four characters."""
    k = key()
    return {"set": bool(k), "hint": ("…" + k[-4:]) if k else None,
            "set_at": _conf.get("set_at"), "check": _conf.get("check"),
            "reader": READER, "search": SEARCH}


async def save_key(db, value: str | None) -> dict:
    """A string sets the key; "" or None forgets it."""
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    v = (value or "").strip()
    if v:
        if len(v) > 400 or any(c.isspace() for c in v):
            raise ValueError("that does not look like a Jina API key")
        await raw[COLL].update_one({"_id": DOC_ID}, {"$set": {"key": secretbox.seal(v), "set_at": _now()},
                                                     "$unset": {"check": ""}}, upsert=True)
    else:
        await raw[COLL].update_one({"_id": DOC_ID}, {"$unset": {"key": "", "set_at": "", "check": ""}}, upsert=True)
    _account.clear()
    await load(db)
    return public()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _headers(extra: dict | None = None) -> dict:
    return {"Authorization": f"Bearer {key()}", **(extra or {})}


def _client(timeout: float = TIMEOUT):
    """The HTTP client of one call (the tests hand their own transport in here)."""
    import httpx
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0), follow_redirects=True)


def _err(status: int | None, body: str) -> str:
    """Jina's own reason, short; never the request (it carries the key)."""
    msg = ""
    try:
        import json
        d = json.loads(body)
        msg = str(d.get("readableMessage") or d.get("message") or d.get("detail") or d.get("name") or "")
    except Exception:                                   # noqa: BLE001
        msg = (body or "").strip().splitlines()[0] if (body or "").strip() else ""
    known = {401: "the key was not accepted", 402: "the key's balance is used up",
             403: "refused", 429: "rate limited - too many calls at once", 422: "the page could not be read",
             451: "the site does not allow being read"}
    why = known.get(status or 0, "")
    out = f"Jina {status}" + (f": {why}" if why else "") + (f" ({msg[:160]})" if msg and msg not in why else "")
    return out


# ---------------------------------------------------------------- Reader

_IMG = re.compile(r"!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
_LINK = re.compile(r"(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")


def parse_text(body: str) -> dict:
    """Reader's plain-text answer: `Title: ...`, `URL Source: ...`, then
    `Markdown Content:` and the page."""
    head, _, rest = body.partition("Markdown Content:")
    if not _:
        return {"title": "", "url": "", "description": "", "content": body}
    meta = {}
    for ln in head.splitlines():
        k, sep, v = ln.partition(":")
        if sep:
            meta[k.strip().lower()] = v.strip()
    return {"title": meta.get("title", ""), "url": meta.get("url source", ""),
            "description": meta.get("description", ""), "content": rest.strip("\n"),
            "published": meta.get("published time")}


def markdown_parts(md: str) -> tuple[str, list[tuple[str, str]], list[tuple[str, str]]]:
    """The page's text for reading - the pictures left out, a link kept as
    its words - and its links and pictures, each (address, words)."""
    images = [(u, alt.strip()) for alt, u in _IMG.findall(md)]
    no_img = _IMG.sub(lambda m: "", md)
    links = [(u, re.sub(r"\s+", " ", w).strip()) for w, u in _LINK.findall(no_img)]
    text = _LINK.sub(lambda m: m.group(1), no_img)
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", text)).strip()
    return text, links, images


async def read(url: str, *, who: str = "", crawl: bool = True, timeout: float = TIMEOUT) -> dict:
    """One page through Reader: {ok, status (the site's, as Jina saw it),
    url (where it ended), title, description, text, links, images, chars,
    tokens, ms, error}. The address must already be checked (public,
    http(s)) - manufacturers.check(); this does not ask Jina for anything
    else. `crawl`: the whole page, menus and all (the crawler follows its
    links); otherwise headers, menus and footers are left out (a read for
    the Chat)."""
    out: dict = {"ok": False, "status": None, "url": url, "title": "", "description": "", "text": "",
                 "links": [], "images": [], "chars": 0, "tokens": 0, "ms": 0, "error": None}
    if not configured():
        out["error"] = "Jina is not set up (Settings > Proxy & Data: the API key)"
        return out
    from .manufacturers import USER_AGENT
    h = {"Accept": "application/json", "X-Return-Format": "markdown", "X-Timeout": str(PAGE_TIMEOUT),
         "X-Robots-Txt": USER_AGENT}
    if not crawl:
        h["X-Remove-Selector"] = "header, nav, footer"
    t0 = time.monotonic()
    import httpx
    try:
        async with _client(timeout) as c:
            r = await c.get(READER + url, headers=_headers(h))
        body = r.text[:MAX_CHARS]
        if r.status_code != 200:
            out["error"] = _err(r.status_code, body)
            out["jina_status"] = r.status_code
        else:
            got = _reader_body(body, r.headers.get("content-type", ""))
            out.update(title=got.get("title") or "", description=got.get("description") or "",
                       url=got.get("url") or url, status=got.get("status") or 200)
            text, links, images = markdown_parts(got.get("content") or "")
            for extra, into in ((got.get("links"), links), (got.get("images"), images)):
                if isinstance(extra, dict):
                    into.extend((u, w) for w, u in extra.items() if isinstance(u, str))
            out.update(text=text, links=links, images=images, chars=len(got.get("content") or ""),
                       tokens=int(got.get("tokens") or 0) or round(len(got.get("content") or "") / CHARS_PER_TOKEN),
                       tokens_counted=bool(got.get("tokens")))
            if out["status"] != 200:
                out["error"] = f"the site answered HTTP {out['status']} (through Jina)"
            elif not text.strip():
                out["error"] = "Jina read nothing on the page"
            else:
                out["ok"] = True
    except (httpx.TimeoutException, asyncio.TimeoutError):
        out["error"] = f"Jina did not answer within {timeout:.0f} s"
    except httpx.HTTPError as exc:
        out["error"] = f"Jina: {type(exc).__name__}"
    out["ms"] = round((time.monotonic() - t0) * 1000)
    log({"api": "reader", "target": url[:300], "ok": out["ok"], "status": out["status"],
         "jina_status": out.get("jina_status"), "ms": out["ms"], "chars": out["chars"], "tokens": out["tokens"],
         "error": out["error"], "who": who})
    return out


def _reader_body(body: str, ctype: str) -> dict:
    """Reader's answer, JSON ({data: {title, url, content, usage}}) or the
    plain text one - whichever came."""
    if "json" in ctype or body.lstrip().startswith("{"):
        try:
            import json
            d = json.loads(body)
            data = d.get("data") or {}
            usage = data.get("usage") or (d.get("meta") or {}).get("usage") or {}
            return {"title": data.get("title"), "url": data.get("url"), "description": data.get("description"),
                    "content": data.get("content") or data.get("text") or "", "links": data.get("links"),
                    "images": data.get("images"), "status": data.get("httpStatus"),
                    "tokens": usage.get("tokens")}
        except (ValueError, AttributeError):
            pass
    return parse_text(body)


# ---------------------------------------------------------------- Search

async def search(q: str, *, site: str = "", num: int = 5, who: str = "") -> dict:
    """The web's top results for `q` ({title, url, description} each), from
    Jina Search; only the snippets, not the pages (X-Respond-With:
    no-content), which keeps it cheap. `site` keeps it to one site."""
    q = (q or "").strip()
    num = max(1, min(int(num or 5), SEARCH_MAX))
    out: dict = {"ok": False, "results": [], "tokens": 0, "chars": 0, "ms": 0, "error": None}
    if not configured():
        out["error"] = "Jina is not set up (Settings > Proxy & Data: the API key)"
        return out
    params = {"q": q, "num": str(num)}
    if site:
        params["site"] = site
    t0 = time.monotonic()
    import httpx
    try:
        async with _client() as c:
            r = await c.get(SEARCH, params=params,
                            headers=_headers({"Accept": "application/json", "X-Respond-With": "no-content"}))
        body = r.text[:MAX_CHARS]
        if r.status_code != 200:
            out["error"] = _err(r.status_code, body)
        else:
            import json
            d = json.loads(body)
            rows = d.get("data") or []
            res = [{"title": str(x.get("title") or "")[:300], "url": str(x.get("url") or ""),
                    "description": str(x.get("description") or x.get("content") or "")[:600]}
                   for x in rows if isinstance(x, dict) and x.get("url")][:num]
            usage = (d.get("meta") or {}).get("usage") or {}
            tokens = usage.get("tokens") or sum(int((x.get("usage") or {}).get("tokens") or 0)
                                                for x in rows if isinstance(x, dict))
            out.update(ok=True, results=res, tokens=int(tokens or 0), chars=len(body))
    except (httpx.TimeoutException, asyncio.TimeoutError):
        out["error"] = f"Jina did not answer within {TIMEOUT:.0f} s"
    except httpx.HTTPError as exc:
        out["error"] = f"Jina: {type(exc).__name__}"
    except ValueError:
        out["error"] = "Jina's answer could not be read"
    out["ms"] = round((time.monotonic() - t0) * 1000)
    log({"api": "search", "target": (q + (f" site:{site}" if site else ""))[:300], "ok": out["ok"],
         "status": 200 if out["ok"] else None, "ms": out["ms"], "chars": out["chars"], "tokens": out["tokens"],
         "results": len(out["results"]), "error": out["error"], "who": who})
    return out


# ---------------------------------------------------------------- the balance

def parse_balance(d) -> dict | None:
    """Jina's dashboard answer for a key: what is left, in tokens."""
    if not isinstance(d, dict):
        return None
    w = d.get("wallet")
    if not isinstance(w, dict):
        return None

    def num(v):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None
    out = {"total": num(w.get("total_balance")), "trial": num(w.get("trial_balance")),
           "regular": num(w.get("regular_balance"))}
    if out["total"] is None:
        parts = [v for v in (out["trial"], out["regular"]) if v is not None]
        out["total"] = sum(parts) if parts else None
    return out if out["total"] is not None else None


async def balance(refresh: bool = False) -> dict:
    """{ok, balance: {total, trial, regular}, at, error}, kept a minute.
    Every reading is kept by the day (the page's balance line)."""
    hit = _account.get("v")
    if hit and not refresh and time.monotonic() - hit[0] < 60:
        return hit[1]
    if refresh and hit and time.monotonic() - hit[0] < 5:
        return hit[1]
    out: dict = {"ok": False, "balance": None, "at": _now(), "error": None, "status": None}
    if not configured():
        out["error"] = "no key"
        return out
    import httpx
    try:
        async with _client(15) as c:
            r = await c.get(BALANCE_URL, params={"api_key": key()}, headers={"Accept": "application/json"})
        out["status"] = r.status_code
        if r.status_code == 200:
            b = parse_balance(r.json())
            if b:
                out.update(ok=True, balance=b)
            else:
                out["error"] = "Jina's answer had no balance in it"
        else:
            out["error"] = _err(r.status_code, r.text[:2000])
    except (httpx.TimeoutException, asyncio.TimeoutError):
        out["error"] = "Jina's dashboard did not answer"
    except (httpx.HTTPError, ValueError) as exc:
        out["error"] = f"Jina's dashboard: {type(exc).__name__}"
    _account["v"] = (time.monotonic(), out)
    if out["ok"]:
        await _keep_balance(out["balance"])
    return out


BALANCES = "jina_balance"


async def _keep_balance(b: dict) -> None:
    """One row a day: the first and the last reading of it."""
    if _db_getter is None:
        return
    try:
        db = _db_getter()
        raw = db.raw if getattr(type(db), "SCOPED", False) else db
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        was = await raw[BALANCES].find_one({"_id": day})
        sets = {"last": b["total"], "trial": b.get("trial"), "regular": b.get("regular"), "at": _now()}
        if not was:
            sets["first"] = b["total"]
        await raw[BALANCES].update_one({"_id": day}, {"$set": sets}, upsert=True)
    except Exception:                                   # noqa: BLE001 - the figure is shown anyway
        pass


async def check_key() -> dict:
    """Whether the key works: its balance first (free); when that does not
    say, one small Reader call (a few hundred tokens)."""
    _account.clear()
    got = await balance(refresh=True)
    if got["ok"]:
        res = {"valid": True, "how": "balance", "balance": got["balance"], "at": _now()}
    elif got.get("status") in (401, 403):
        res = {"valid": False, "how": "balance", "error": got["error"], "at": _now()}
    else:
        r = await read(CHECK_URL, who="settings")
        js = r.get("jina_status")
        if r["ok"]:
            res = {"valid": True, "how": "reader", "at": _now()}
        elif js == 402:
            res = {"valid": True, "how": "reader", "error": r["error"], "empty": True, "at": _now()}
        elif js in (401, 403):
            res = {"valid": False, "how": "reader", "error": r["error"], "at": _now()}
        else:
            res = {"valid": None, "how": "reader", "error": r["error"], "at": _now()}
    if _db_getter is not None:
        try:
            db = _db_getter()
            raw = db.raw if getattr(type(db), "SCOPED", False) else db
            await raw[COLL].update_one({"_id": DOC_ID}, {"$set": {"check": res}}, upsert=True)
            _conf["check"] = res
        except Exception:                               # noqa: BLE001
            pass
    return res


# ---------------------------------------------------------------- the log

def log(row: dict) -> None:
    """Keep one call. Never waits for, and never fails, the call it describes."""
    if _db_getter is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    from . import scope
    doc = {**row, "at": datetime.now(timezone.utc), "ws": scope.current()}

    async def write():
        global _indexed
        try:
            db = _db_getter()
            raw = db.raw if getattr(type(db), "SCOPED", False) else db
            if not _indexed:
                await raw[LOG].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400)
                _indexed = True
            await raw[LOG].insert_one(doc)
        except Exception:                               # noqa: BLE001
            pass
    loop.create_task(write())


def _pct(xs: list[float], q: float) -> int | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))])


def summarise(rows: list[dict], days: int, now: datetime | None = None) -> dict:
    """The calls of `rows` (this space's), Reader's and Search's apart: the
    totals, and by day."""
    now = now or datetime.now(timezone.utc)
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    t0 = int(start.timestamp())
    out: dict = {"days": days, "t0": t0, "step": 86400}
    for api in APIS:
        mine = [r for r in rows if r.get("api") == api]
        ok = [r for r in mine if r.get("ok")]
        series = {k: [0] * days for k in ("ok", "failed", "tokens", "chars")}
        for r in mine:
            at = r["at"] if r["at"].tzinfo else r["at"].replace(tzinfo=timezone.utc)
            i = int((at.timestamp() - t0) // 86400)
            if not 0 <= i < days:
                continue
            series["ok" if r.get("ok") else "failed"][i] += 1
            series["tokens"][i] += int(r.get("tokens") or 0)
            series["chars"][i] += int(r.get("chars") or 0)
        out[api] = {
            "requests": len(mine), "ok": len(ok), "failed": len(mine) - len(ok),
            "success_rate": round(len(ok) / len(mine), 4) if mine else None,
            "tokens": sum(int(r.get("tokens") or 0) for r in mine),
            "chars": sum(int(r.get("chars") or 0) for r in mine),
            "p50_ms": _pct([r.get("ms") or 0 for r in ok], .5), "p95_ms": _pct([r.get("ms") or 0 for r in ok], .95),
            "by_who": sorted(({"name": k, "n": v} for k, v in _count(mine, "who").items()), key=lambda x: -x["n"]),
            "calls": {"t0": t0, "step": 86400, "n": days,
                      "series": [{"name": "ok", "values": series["ok"]}, {"name": "failed", "values": series["failed"]}]},
            "tokens_series": {"t0": t0, "step": 86400, "n": days,
                              "series": [{"name": "tokens", "values": series["tokens"]}]},
        }
    return out


def _count(rows: list[dict], k: str) -> dict[str, int]:
    c: dict[str, int] = {}
    for r in rows:
        v = r.get(k) or "?"
        c[v] = c.get(v, 0) + 1
    return c


# ---------------------------------------------------------------- the API

router = APIRouter(prefix="/api/jina")


def _db():
    from .main import db
    return db()


def _raw():
    d = _db()
    return d.raw if getattr(type(d), "SCOPED", False) else d


@router.get("/settings")
async def get_settings() -> dict:
    return public()


class JinaIn(BaseModel):
    # The key: a string sets it, "" forgets it. Left out: unchanged.
    key: str | None = Field(default=None, max_length=400)


@router.put("/settings")
async def put_settings(body: JinaIn) -> dict:
    from . import actors
    if body.key is None:
        return public()
    try:
        out = await save_key(_db(), body.key)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await actors.audit(_db(), "settings", "jina", {"changed": ["key set" if body.key.strip() else "key cleared"]})
    return out


@router.post("/test")
async def test() -> dict:
    if not configured():
        raise HTTPException(400, "paste the API key first")
    return await check_key()


@router.get("/account")
async def account(refresh: bool = False) -> dict:
    """The key's balance from Jina, and its readings by day over two weeks."""
    if not configured():
        return {"ok": False, "set": False, "balance": None, "history": []}
    got = await balance(refresh)
    since = (datetime.now(timezone.utc) - timedelta(days=13)).strftime("%Y-%m-%d")
    hist = [{"day": d["_id"], "first": d.get("first"), "last": d.get("last")}
            async for d in _raw()[BALANCES].find({"_id": {"$gte": since}})]
    hist.sort(key=lambda x: x["day"])
    return {**got, "set": True, "history": hist}


@router.get("/usage")
async def usage(days: int = 14) -> dict:
    """Workbench's own count of its Jina calls - Reader's and Search's apart,
    by day - and the latest of them."""
    from . import lcsc
    days = max(1, min(int(days), 90))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = [r async for r in _raw()[LOG].find({"at": {"$gte": since}}, {"_id": 0}).sort("at", -1).limit(20000)
            if lcsc.mine(r)]
    out = summarise(rows, days)
    out["log"] = [{"at": r["at"].isoformat(), "api": r.get("api"), "target": r.get("target"), "ok": r.get("ok"),
                   "status": r.get("status"), "ms": r.get("ms"), "chars": r.get("chars"), "tokens": r.get("tokens"),
                   "who": r.get("who"), "error": r.get("error")} for r in rows[:50]]
    return out

