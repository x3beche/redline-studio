"""Shared links: one model, board or technical drawing, read-only, for a
while, to someone without an account - a customer, a manufacturer.

A share is an unguessable token (secrets.token_urlsafe, 32 bytes) of which
only the SHA-256 is kept, so the database alone cannot open a link. It names
one thing in one space - a model, a board, or a model's drawing - and what
the link may do with it: until when (a day, a week, a month or a date, never
more than 90 days), whether the files may be downloaded (STEP, STL, the
drawing's PDF) or only looked at, and an optional password, kept as a scrypt
hash like an account's. "This version" copies what the link shows aside when
it is made (the bucket `share_files`), so a rebuild later does not change
what the customer was sent; "the latest" always shows what is built now.

Made, listed and turned off by people signed in to the space the thing is
in (/api/shares). Opened by anyone holding the link, under /api/public/s/
<token>/..., which the auth middleware lets through without a session
(auth.OPEN_PREFIX, access "none"). Those routes answer only what the share
names: its title and dates, and the few files of that one thing - no id of
it or of anything else, no listing, no person, no space. An unknown token is
404, an expired or turned-off one 410, the password is checked here, and
every address is rate-limited. Who made a link, and in which space, never
leaves through the public routes.

The collection `shares` is deliberately not scoped (scope.SCOPED): a link
is looked up by its hash from outside every space. Each document carries its
`workspace`, and every signed-in route filters by it, like build_jobs.
Making, turning off and the first look of each visitor in half an hour go
into the space's audit trail.
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hashlib
import hmac
import ipaddress
import re
import secrets
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import actors, auth, scope, store

COLL = "shares"
FILES = "share_files"                 # GridFS bucket: what "this version" links show
KINDS = ("model", "board", "drawing")
MAX_DAYS = 90
SPANS = {"1d": 1, "7d": 7, "30d": 30}
# Links still open in one space at once: past this, old ones must go first.
MAX_ACTIVE = 200
# A link that ended this long ago is forgotten (its audit lines stay).
FORGET_DAYS = 90
COOKIE = "redline_share"
VISITOR = {"type": "visitor", "id": "public", "name": "visitor"}
# What a token looks like (token_urlsafe(32) is 43 characters).
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")

# What each kind of link shows, and what it lets one download: the name in
# the public address -> (catalog, artifact) or a drawing of the model.
VIEWS = {
    "model": {"model.json": ("models", "viewer")},
    "board": {"layout.svg": ("boards", "layout"), "bottom.svg": ("boards", "bottom"),
              "schematic.svg": ("boards", "schematic_svg"), "board.glb": ("boards", "model3d")},
    "drawing": {"sheet.png": "sheet"},
}
DOWNLOADS = {
    "model": {"step": ("models", "step"), "stl": ("models", "stl"), "pdf": "pdf"},
    "board": {"step": ("boards", "step"), "stl": ("boards", "stl")},
    "drawing": {"pdf": "pdf"},
}
TYPES = {"model.json": "application/json", "layout.svg": "image/svg+xml", "bottom.svg": "image/svg+xml",
         "schematic.svg": "image/svg+xml", "board.glb": "model/gltf-binary", "sheet.png": "image/png",
         "step": "model/step", "stl": "model/stl", "pdf": "application/pdf"}

# Every public answer: not kept by shared caches, not indexed, no referrer
# carrying the token anywhere, and a file never run as a page of this site.
PUBLIC = {"X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff"}
SANDBOX = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"


def _db():
    from .main import db
    return db()


def now() -> datetime:
    return datetime.now(timezone.utc)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _iso(t: datetime) -> str:
    return t.isoformat()


def _when(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def state(doc: dict, at: datetime | None = None) -> str:
    """active, expired or revoked."""
    if doc.get("revoked_at"):
        return "revoked"
    end = _when(doc.get("expires_at"))
    return "expired" if end is None or end <= (at or now()) else "active"


@contextlib.contextmanager
def _in(ws: str):
    """The database as the share's own space sees it, for one public request."""
    tok = scope.WORKSPACE.set(ws)
    try:
        yield
    finally:
        scope.WORKSPACE.reset(tok)


# ---------------------------------------------------------------- the files a link shows

async def _put(db, name: str, packed: bytes):
    return await store.bucket(db, FILES).upload_from_stream(name, packed)


async def _get(db, fid) -> bytes:
    stream = await store.bucket(db, FILES).open_download_stream(fid)
    return await stream.read()


async def _drop(db, fid) -> None:
    try:
        await store.bucket(db, FILES).delete(fid)
    except Exception:                                  # noqa: BLE001 - gone already is fine
        pass


async def _drawing(db, model_id: str, what: str) -> bytes | None:
    """The model's drawing as it is made now - the PDF, or the sheet as a
    picture - or None when it is not made. Never made here: a link shows
    what there is, and making one is minutes of a container."""
    from . import release
    st = await release.drawing_status(db, model_id)
    if not st.get("made"):
        return None
    if what == "pdf":
        return await release.model_drawing(db, model_id)
    return await release.model_drawing_sheet(db, model_id)


async def _source(db, kind: str, target: str, name: str, *, gz: bool) -> bytes | None:
    """One file of the thing as it is now (gzipped when `gz`), or None."""
    where = {**VIEWS[kind], **DOWNLOADS[kind]}.get(name)
    if where is None:
        return None
    if isinstance(where, tuple):
        coll, label = where
        try:
            packed = await store.get_artifact_gz(db, target, label, coll)
        except KeyError:
            return None
        return packed if gz else gzip.decompress(packed)
    data = await _drawing(db, target, "pdf" if where == "pdf" else "sheet")
    if data is None:
        return None
    return gzip.compress(data, compresslevel=6) if gz else data


def _offered(kind: str, downloads: bool) -> list[str]:
    return [*VIEWS[kind], *(DOWNLOADS[kind] if downloads else ())]


async def present(db, kind: str, target: str) -> set[str]:
    """Which of the files a link of `kind` could show are there now - read
    from the catalog and the drawing's state, without fetching any."""
    coll = "boards" if kind == "board" else "models"
    doc = await db[coll].find_one({"_id": target}, {"artifacts": 1})
    if not doc:
        return set()
    labels = set((doc.get("artifacts") or {}).keys())
    out = {n for n, w in {**VIEWS[kind], **DOWNLOADS[kind]}.items() if isinstance(w, tuple) and w[1] in labels}
    if kind != "board" and "step" in labels:
        from . import release
        try:
            made = bool((await release.drawing_status(db, target)).get("made"))
        except KeyError:
            made = False
        if made:
            out |= {"pdf"} | ({"sheet.png"} if kind == "drawing" else set())
    return out


# ---------------------------------------------------------------- nothing about anyone

_STEP_NAME = re.compile(rb"FILE_NAME\s*\(", re.I)


def _step_args(text: bytes, start: int) -> tuple[list[tuple[int, int]], int] | None:
    """The top-level arguments of a STEP header entity from just after its
    "(": their spans, and where the closing ")" is."""
    spans, depth, i, s = [], 0, start, start
    while i < len(text):
        c = text[i:i + 1]
        if c == b"'":
            i += 1
            while i < len(text):
                if text[i:i + 1] == b"'":
                    if text[i + 1:i + 2] == b"'":
                        i += 2
                        continue
                    break
                i += 1
        elif c == b"(":
            depth += 1
        elif c == b")":
            if depth == 0:
                spans.append((s, i))
                return spans, i
            depth -= 1
        elif c == b"," and depth == 0:
            spans.append((s, i))
            s = i + 1
        i += 1
    return None


def clean_step(data: bytes) -> bytes:
    """A STEP file without the people in its header: FILE_NAME's author
    and organisation (a file brought in from someone's CAD carries their
    name there) become empty. The geometry is untouched."""
    head_end = data.find(b"ENDSEC;")
    m = _STEP_NAME.search(data, 0, head_end if head_end > 0 else 4096)
    if not m:
        return data
    got = _step_args(data, m.end())
    if not got or len(got[0]) < 4:
        return data
    (a0, a1), (o0, o1) = got[0][2], got[0][3]
    return data[:a0] + b"('')" + data[a1:o0] + b"('')" + data[o1:]


def clean_svg(data: bytes) -> bytes:
    """An SVG without comments and <metadata> (where a creator would be)."""
    data = re.sub(rb"<!--.*?-->", b"", data, flags=re.S)
    return re.sub(rb"<metadata\b.*?</metadata>", b"", data, flags=re.S | re.I)


def clean_png(data: bytes) -> bytes:
    """A PNG with only the chunks that draw it: no text, time or EXIF."""
    sig = b"\x89PNG\r\n\x1a\n"
    if not data.startswith(sig):
        return data
    keep = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"gAMA", b"sRGB", b"pHYs", b"cHRM"}
    out, i = [sig], 8
    while i + 8 <= len(data):
        n = int.from_bytes(data[i:i + 4], "big")
        kind = data[i + 4:i + 8]
        end = i + 12 + n
        if kind in keep:
            out.append(data[i:end])
        i = end
    return b"".join(out)


def _clean(name: str, data: bytes) -> bytes:
    if name == "step":
        return clean_step(data)
    if name.endswith(".svg"):
        return clean_svg(data)
    if name.endswith(".png"):
        return clean_png(data)
    return data


# ---------------------------------------------------------------- rate limits

class Window:
    """At most `limit` events per key in `seconds`, in this process's memory
    (a reload of the API starts every count afresh, like sign-in's)."""

    def __init__(self, limit: int, seconds: float):
        self.limit, self.seconds = limit, seconds
        self.seen: dict[str, deque] = {}

    def _trim(self, key: str, t: float) -> deque:
        q = self.seen.setdefault(key, deque())
        while q and q[0] <= t - self.seconds:
            q.popleft()
        return q

    def full(self, key: str) -> bool:
        return len(self._trim(key, time.monotonic())) >= self.limit

    def hit(self, key: str) -> bool:
        """Count one; False when the key was already at its limit."""
        t = time.monotonic()
        q = self._trim(key, t)
        if len(q) >= self.limit:
            return False
        q.append(t)
        if len(self.seen) > 20000:                    # a flood of addresses: forget the idle ones
            for k in [k for k, v in self.seen.items() if not v or v[-1] <= t - self.seconds]:
                self.seen.pop(k, None)
        return True

    def clear(self) -> None:
        self.seen.clear()


# Requests to the public routes, per address; tokens that are wrong, per
# address; passwords that are wrong, per link and address, and per link.
HITS = Window(300, 60)
MISSES = Window(20, 600)
WRONG = Window(8, 900)
WRONG_LINK = Window(40, 3600)
# One look per visitor and link in this window is one view (and one audit line).
LOOKED = 1800
_looked: dict[tuple[str, str], float] = {}


def client(request: Request) -> str:
    """Who is asking, as an address. Behind the site's own proxy (the
    connection comes from this machine or the private network) it is the
    last address the proxy added to X-Forwarded-For - not the first, which
    the visitor may write themselves."""
    peer = request.client.host if request.client else ""
    try:
        local = ipaddress.ip_address(peer).is_private or ipaddress.ip_address(peer).is_loopback
    except ValueError:
        local = peer in ("", "testclient")
    if local:
        fwd = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if fwd:
            return fwd[-1]
        real = request.headers.get("x-real-ip", "").strip()
        if real:
            return real
    return peer


def _refuse(code: int, detail: str) -> HTTPException:
    return HTTPException(code, detail, headers={**PUBLIC, "Cache-Control": "no-store"})


async def _open(request: Request, token: str) -> dict:
    """The share a public request names, while it is open; refused
    otherwise. An unknown token and a malformed one cost the same lookup."""
    who = client(request)
    if not HITS.hit(who) or MISSES.full(who):
        raise _refuse(429, "too many requests - wait a minute")
    good = bool(TOKEN_RE.match(token or ""))
    key = digest(token if good else "-" * 43)
    doc = await _db()[COLL].find_one({"_id": key})
    if not good or not doc or not hmac.compare_digest(doc["_id"], key):
        MISSES.hit(who)
        raise _refuse(404, "there is no such link")
    st = state(doc)
    if st == "revoked":
        raise _refuse(410, "this link was turned off")
    if st == "expired":
        raise _refuse(410, "this link has expired")
    return doc


def _proof(doc: dict) -> str:
    """What the unlock cookie holds: a MAC of the link under its password's
    hash, so it is good for this link and this password only, and cannot be
    made without the database."""
    return hmac.new(str(doc.get("password") or "").encode(), b"share-unlock:" + doc["_id"].encode(),
                    hashlib.sha256).hexdigest()


def _unlocked(request: Request, doc: dict) -> bool:
    if not doc.get("password"):
        return True
    got = request.cookies.get(COOKIE, "")
    return bool(got) and hmac.compare_digest(got, _proof(doc))


def _need_unlocked(request: Request, doc: dict) -> None:
    if not _unlocked(request, doc):
        raise _refuse(401, "this link has a password")


# ---------------------------------------------------------------- what is said about a share

def _version(doc: dict) -> dict:
    pin = doc.get("pin") or {}
    return {"pinned": bool(pin), "label": pin.get("label"), "at": pin.get("at")}


def public_view(doc: dict, there: set[str]) -> dict:
    """What a visitor is told: the thing's title and kind, until when, the
    files on offer (of those `there`). Never who made it, where it lives,
    or any id."""
    offered = [n for n in _offered(doc["kind"], bool(doc.get("downloads"))) if n in there]
    return {"kind": doc["kind"], "title": doc.get("title") or "", "expires_at": doc.get("expires_at"),
            "version": _version(doc),
            "views": [n for n in offered if n in VIEWS[doc["kind"]]],
            "downloads": [n for n in offered if n in DOWNLOADS[doc["kind"]]],
            "locked": False}


async def _there(doc: dict) -> set[str]:
    """The files a share can serve: what it kept aside, or what its thing has now."""
    if doc.get("pin"):
        return set(doc.get("files") or {})
    with _in(doc["workspace"]):
        return await present(_db(), doc["kind"], doc["target"])


def row(doc: dict) -> dict:
    """A share as its space's people see it in the app (no token, no hash)."""
    by = doc.get("created_by") or {}
    return {"id": doc["id"], "kind": doc["kind"], "target": doc["target"], "title": doc.get("title") or "",
            "state": state(doc), "expires_at": doc.get("expires_at"), "downloads": bool(doc.get("downloads")),
            "password": bool(doc.get("password")), "version": _version(doc),
            "created_at": doc.get("created_at"), "created_by": {"id": by.get("id"), "name": by.get("name")},
            "views": doc.get("views", 0), "last_viewed_at": doc.get("last_viewed_at"),
            "revoked_at": doc.get("revoked_at")}


# ---------------------------------------------------------------- making one

class ShareIn(BaseModel):
    kind: str = Field(pattern="^(model|board|drawing)$")
    target: str = Field(min_length=1, max_length=300)
    # "pinned": what is built now, kept as it is; "latest": whatever is built when it is opened.
    version: str = Field(default="pinned", pattern="^(pinned|latest)$")
    expires: str = Field(default="7d", pattern="^(1d|7d|30d|custom)$")
    until: str | None = Field(default=None, max_length=40)
    downloads: bool = False
    password: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=120)


async def _thing(db, kind: str, target: str) -> dict:
    """The model or board a share would name, in the caller's space - 404
    when it is not there (or not theirs: another space's is not there)."""
    coll = "boards" if kind == "board" else "models"
    doc = await db[coll].find_one({"_id": target}, {"title": 1, "name": 1, "version": 1, "built": 1,
                                                     "component": 1, "artifacts": 1})
    if not doc:
        raise HTTPException(404, f"no {'board' if kind == 'board' else 'model'} {target}")
    return doc


def _expiry(body: ShareIn, at: datetime) -> datetime:
    if body.expires != "custom":
        return at + timedelta(days=SPANS[body.expires])
    end = _when(body.until)
    if end is None:
        raise HTTPException(400, "give the last day as a date")
    end = end.astimezone(timezone.utc)
    if end <= at + timedelta(minutes=5):
        raise HTTPException(400, "the last day has to be in the future")
    if end > at + timedelta(days=MAX_DAYS, minutes=1):
        raise HTTPException(400, f"a link lasts {MAX_DAYS} days at most")
    return end


async def create(body: ShareIn) -> dict:
    who = actors.current()
    if who.get("type") != "user":
        # A public link is a person's decision; an agent's token does not make one.
        raise HTTPException(403, "only a person signed in can share a link")
    db = _db()
    ws = scope.current()
    target = body.target.strip().strip("/")
    thing = await _thing(db, body.kind, target)
    at = now()
    expires = _expiry(body, at)
    password = (body.password or "").strip("\n")
    if password and len(password) < 4:
        raise HTTPException(400, "a password needs 4 characters at least")
    await sweep(db)
    if await db[COLL].count_documents({"workspace": ws, "revoked_at": None,
                                       "expires_at": {"$gt": _iso(at)}}) >= MAX_ACTIVE:
        raise HTTPException(409, f"{MAX_ACTIVE} links are open already - turn some off first")
    # What there is to show now: a drawing link needs the drawing made.
    there = await present(db, body.kind, target)
    offered = [n for n in _offered(body.kind, body.downloads) if n in there]
    files: dict = {}
    sid = secrets.token_hex(6)
    if body.version == "pinned":
        for name in offered:
            packed = await _source(db, body.kind, target, name, gz=True)
            if packed is not None:
                files[name] = await _put(db, f"{sid}:{name}", packed)
        offered = list(files)
    if not [n for n in offered if n in VIEWS[body.kind]]:
        for fid in files.values():
            await _drop(db, fid)
        raise HTTPException(409, "nothing to show yet - make the drawing first" if body.kind == "drawing"
                            else "nothing to show yet - build it first")
    token = secrets.token_urlsafe(32)
    if body.kind == "board":
        label = f"v{(thing.get('component') or {}).get('version') or 1}"
    else:
        label = f"v{(thing.get('built') or {}).get('version') or thing.get('version') or 1}"
    viewer = ((thing.get("artifacts") or {}).get("viewer" if body.kind != "board" else "layout") or {})
    doc = {"_id": digest(token), "id": sid, "kind": body.kind, "target": target, "workspace": ws,
           "title": (body.title or "").strip() or thing.get("title") or thing.get("name") or target.split("/")[-1],
           "downloads": body.downloads, "password": auth.hash_password(password) if password else None,
           "expires_at": _iso(expires), "created_at": _iso(at), "created_by": who,
           "revoked_at": None, "views": 0, "last_viewed_at": None,
           "pin": {"label": label, "at": viewer.get("at") or _iso(at),
                   "sha": (viewer.get("sha256") or "")[:12]} if body.version == "pinned" else None,
           "files": files or None}
    await db[COLL].insert_one(doc)
    await actors.audit(db, "share", f"{body.kind} {target}",
                       {"share": sid, "expires_at": doc["expires_at"], "downloads": body.downloads,
                        "password": bool(password), "version": body.version})
    return {"share": row(doc), "token": token, "path": f"/s/{token}"}


async def sweep(db) -> None:
    """Drop what ended links kept aside, and forget links long over."""
    at = now()
    coll = db[COLL]
    ended = {"$or": [{"revoked_at": {"$ne": None}}, {"expires_at": {"$lte": _iso(at)}}]}
    async for doc in coll.find({"$and": [ended, {"files": {"$ne": None}}]}, {"files": 1}):
        for fid in (doc.get("files") or {}).values():
            await _drop(db, fid)
        await coll.update_one({"_id": doc["_id"]}, {"$set": {"files": None}})
    old = _iso(at - timedelta(days=FORGET_DAYS))
    await coll.delete_many({"$or": [{"revoked_at": {"$ne": None, "$lt": old}}, {"expires_at": {"$lt": old}}]})


# ---------------------------------------------------------------- the app's routes

router = APIRouter()


@router.post("/api/shares")
async def make_share(body: ShareIn):
    """A read-only link to a model, a board or a model's drawing, for
    someone without an account. The link is in the answer once: only its
    hash is kept."""
    return await create(body)


@router.get("/api/shares")
async def list_shares(kind: str = "", target: str = "", mine: bool = False, ended: bool = False):
    """The links open in this space: one thing's (kind and target), or the
    ones the caller made (mine=1). ended=1 lists the expired and turned-off
    ones too."""
    db = _db()
    await sweep(db)
    q: dict = {"workspace": scope.current()}
    if kind:
        q["kind"] = kind
    if target:
        q["target"] = target.strip().strip("/")
    if mine:
        q["created_by.id"] = actors.current().get("id")
    rows = [row(d) async for d in db[COLL].find(q)]
    if not ended:
        rows = [r for r in rows if r["state"] == "active"]
    rows.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return rows


@router.post("/api/shares/{sid}/revoke")
async def revoke_share(sid: str):
    """Turn a link off for good: its maker may, and the owner and the
    admins. What it kept aside is dropped at once."""
    db = _db()
    doc = await db[COLL].find_one({"id": sid, "workspace": scope.current()})
    if not doc:
        raise HTTPException(404, "no such link")
    from . import access
    me = actors.current()
    mine = (doc.get("created_by") or {}).get("id") == me.get("id") and me.get("type") == "user"
    if not mine and access.current() not in ("owner", "admin"):
        raise HTTPException(403, "only the one who made the link, or an admin, can turn it off")
    if doc.get("revoked_at"):
        return row(doc)
    at = _iso(now())
    for fid in (doc.get("files") or {}).values():
        await _drop(db, fid)
    await db[COLL].update_one({"_id": doc["_id"]},
                              {"$set": {"revoked_at": at, "revoked_by": me, "files": None}})
    await actors.audit(db, "share-revoke", f"{doc['kind']} {doc['target']}", {"share": sid})
    doc.update(revoked_at=at, files=None)
    return row(doc)


# ---------------------------------------------------------------- the public routes

class UnlockIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


def _public(data: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers={**PUBLIC, "Cache-Control": "no-store"})


async def _looked_at(request: Request, doc: dict) -> None:
    """A visitor opened the link: counted once per address in half an hour,
    and written into the space's audit trail."""
    key = (doc["_id"], client(request))
    t = time.monotonic()
    if t - _looked.get(key, -LOOKED - 1) < LOOKED:
        return
    _looked[key] = t
    if len(_looked) > 20000:
        for k in [k for k, v in _looked.items() if t - v >= LOOKED]:
            _looked.pop(k, None)
    db = _db()
    await db[COLL].update_one({"_id": doc["_id"]},
                              {"$inc": {"views": 1}, "$set": {"last_viewed_at": _iso(now())}})
    with _in(doc["workspace"]):
        await actors.audit(_db(), "share-view", f"{doc['kind']} {doc['target']}", {"share": doc["id"]},
                           actor=VISITOR)


@router.get("/api/public/s/{token}")
async def public_share(token: str, request: Request):
    """What a shared link shows: the title, until when, the files on offer.
    With a password not given yet, only that it wants one."""
    doc = await _open(request, token)
    if not _unlocked(request, doc):
        return _public({"kind": doc["kind"], "locked": True, "expires_at": doc.get("expires_at")})
    await _looked_at(request, doc)
    return _public(public_view(doc, await _there(doc)))


@router.post("/api/public/s/{token}/unlock")
async def public_unlock(token: str, body: UnlockIn, request: Request):
    """The link's password: right, and a cookie for this link alone lets
    the page in; wrong too often, and it waits."""
    doc = await _open(request, token)
    if not doc.get("password"):
        return _public(public_view(doc, await _there(doc)))
    who = client(request)
    pair = f"{doc['_id']}:{who}"
    if WRONG.full(pair) or WRONG_LINK.full(doc["_id"]):
        raise _refuse(429, "too many wrong passwords - try again later")
    ok = await asyncio.to_thread(auth.check_password, body.password, doc["password"])
    if not ok:
        WRONG.hit(pair)
        WRONG_LINK.hit(doc["_id"])
        raise _refuse(403, "that is not the password")
    end = _when(doc.get("expires_at")) or now()
    res = _public(public_view(doc, await _there(doc)))
    res.set_cookie(COOKIE, _proof(doc), max_age=max(60, int((end - now()).total_seconds())),
                   httponly=True, samesite="strict", secure=request.url.scheme == "https"
                   or request.headers.get("x-forwarded-proto") == "https",
                   path=f"/api/public/s/{token}")
    await _looked_at(request, doc)
    return res


def _filename(title: str, ext: str) -> str:
    base = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", " ", title).strip()[:80] or "shared"
    ascii_ = re.sub(r"[^A-Za-z0-9 ._-]+", "_", base).strip() or "shared"
    return f"attachment; filename=\"{ascii_}.{ext}\"; filename*=UTF-8''{quote(base + '.' + ext)}"


async def _file(request: Request, token: str, name: str, download: bool, light: bool = False) -> Response:
    doc = await _open(request, token)
    _need_unlocked(request, doc)
    kind = doc["kind"]
    if download:
        if not doc.get("downloads") or name not in DOWNLOADS[kind]:
            raise _refuse(404, "nothing to download here")
    elif name not in VIEWS[kind]:
        raise _refuse(404, "no such view")
    files = doc.get("files")
    with _in(doc["workspace"]):
        db = _db()
        if files is not None:
            fid = files.get(name)
            packed = await _get(db, fid) if fid is not None else None
        else:
            packed = await _source(db, kind, doc["target"], name, gz=True)
    if packed is None:
        raise _refuse(404, "not there yet")
    headers = {**PUBLIC, "Cache-Control": "private, max-age=600", "Content-Security-Policy": SANDBOX}
    if name == "model.json":
        # Sent still packed, as the app's own viewer payload is.
        return Response(packed, media_type=TYPES[name], headers={**headers, "Content-Encoding": "gzip"})
    data = _clean(name, gzip.decompress(packed))
    if light and name.endswith(".svg"):
        from .main import _light
        data = _light(data)
    if download:
        headers["Content-Disposition"] = _filename(doc.get("title") or "", name)
    return Response(data, media_type=TYPES[name], headers=headers)


@router.get("/api/public/s/{token}/view/{name}")
async def public_view_file(token: str, name: str, request: Request, light: bool = False):
    """One of the views the link shows: the model, a board's drawings and
    3D, the drawing's sheet."""
    return await _file(request, token, name, False, light)


@router.get("/api/public/s/{token}/download/{name}")
async def public_download(token: str, name: str, request: Request):
    """A file to take away (STEP, STL, the drawing's PDF), when the link allows it."""
    return await _file(request, token, name, True)
