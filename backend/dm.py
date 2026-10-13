"""Direct messages: people writing to each other in the Chat tab.

Each account works in a private space of its own (backend/scope.py), so a
conversation between two people belongs to neither space: it lives in
collections of the server's (`dm_chats`, `dm_messages`, not in
scope.SCOPED), and who may read it is its `members` list - nothing else.
A conversation is between two people, one per pair. Group conversations
were made here once and are gone from the app: their documents stay in
the database untouched, but no route lists, reads or writes them (`_mine`
asks for `direct` ones only).
Every route below finds a conversation by its id *and* the asker among its
members; anyone else gets the same 404 as for an id that never existed.
The AI conversations (backend/cc_chat.py), their search and the Chat tools
(chat_list, chat_read) read `cc_chats` only, so a direct conversation never
shows up there.

Only people: an agent (a token's actor), local mode (sign-in off) and a
headless browser's page session that came from a token have no account to
write from. A person's page session may read (the middleware keeps it to
GET), never write.

Nothing here calls a model: a line is stored, and goes out at once on each
member's live stream (GET /api/dm/live, one per person, through the Chat's
HUB) - which also says who is online: someone with the stream open.

Unread: each member's `read` moment on the conversation; what others wrote
after it counts. Opening a conversation (POST .../read) clears it.

A line can carry things of the sender's space (`items`): a 3D model, a
board, a project (a catalog folder), a taste palette, a Product Catalog
product, an inventory item, a note, a file, a firmware. What the card shows
- the name and a line of facts - is read when it is sent, through the
sender's space, so only what the sender can see can be sent.

A thing sent is data, not a pointer into the sender's space: its snapshot
(see "what was sent" below) is what it was at that moment, owned by its
line and read only by the conversation's members; "Add to my ..." makes a
new one in the reader's own space from it.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import actors, auth, profile, scope

router = APIRouter(prefix="/api/dm")

CHATS = "dm_chats"
MSGS = "dm_messages"
MAX_TEXT = 20_000          # characters of one line
MAX_ITEMS = 8              # things sent with one line
PAGE = 200                 # lines read at once
KINDS = ("model", "board", "project", "taste", "product", "inventory", "note", "file", "firmware")
# What a reader can add to their own space from what was sent.
ADDABLE = ("model", "taste", "product", "inventory", "note", "file")
ITEMS = "dm_items"         # what was sent: each thing's data as it was, owned by its line
BLOBS = "dm_blobs"         # and its bytes (a file, a model's 3D view), in pieces
PIECE = 4 * 1024 * 1024    # bytes of one piece (a document holds 16 MB at most)
MAX_BLOB = 20 * 1024 * 1024    # one file or 3D view sent
MAX_DATA = 2 * 1024 * 1024     # the rest of one thing's data, as JSON
MAX_MODELS = 30            # a model and the models it imports, sent at once
LIVE_PING = 10.0
LIVE_MAX = 300.0


def _raw():
    from .main import db
    return db().raw


def _space_db(space: str):
    """The database as one space sees it."""
    from .main import db
    return scope.ScopedDb(db().raw, space)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clip(s, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


# ---- who is asking ----------------------------------------------------------

def me(write: bool = False) -> dict:
    """The person asking, or a refusal: only signed-in people write to each other."""
    if not auth.enabled():
        raise HTTPException(403, "direct messages need sign-in (REDLINE_REQUIRE_SIGNIN)")
    who = actors.current()
    if who.get("type") != "user" or who.get("id") in (None, "local"):
        raise HTTPException(403, "direct messages are between people, not agents")
    if write and who.get("page"):
        raise HTTPException(403, "a page session only looks")
    return who


def key(uid: str) -> str:
    """A person's live stream on the Chat's hub."""
    return f"dm:{uid}"


def _hub():
    from .cc_chat import HUB
    return HUB


def online(uid: str) -> bool:
    return _hub().watchers(key(uid)) > 0


async def _people(ids) -> dict[str, dict]:
    """The accounts asked for, by id: name and picture fields, never the address."""
    ids = [i for i in dict.fromkeys(ids) if i]
    out: dict[str, dict] = {}
    if not ids:
        return out
    async for u in _raw()[auth.USERS].find({"_id": {"$in": ids}}, {"pw": 0, "avatar": 0}):
        out[u["_id"]] = u
    return out


def person(u: dict, picture: bool = True) -> dict:
    """Someone as the page draws them. `picture`: whether the asker may see
    their picture (profile.py: once they share a conversation) - else the
    initials, without a request that would only be refused."""
    av = profile.avatar_fields(u)
    if not picture:
        av = {**av, "has_avatar": False, "avatar_v": None}
    return {"id": u["_id"], "name": u.get("name") or "?", **av,
            "online": online(u["_id"]), "disabled": bool(u.get("disabled"))}


async def together(who: dict, uid: str) -> bool:
    """Whether the person asking shares a conversation with `uid`."""
    if not auth.enabled() or who.get("type") != "user" or who.get("id") in (None, "local"):
        return False
    doc = await _raw()[CHATS].find_one({"pair": _pair(who["id"], uid), "direct": True}, {"_id": 1})
    return bool(doc)


def _mine(uid: str) -> dict:
    """The asker's conversations: the direct ones with them in it (old group ones stay hidden)."""
    return {"members": uid, "direct": True}


def _by(who: dict) -> dict:
    return {"id": who.get("id"), "name": who.get("name"), "type": "user"}


# ---- conversations ----------------------------------------------------------

async def _chat(cid: str, uid: str) -> dict:
    """The conversation, if the asker is in it; the same 404 otherwise."""
    doc = await _raw()[CHATS].find_one({"_id": str(cid), **_mine(uid)})
    if not doc or uid not in (doc.get("members") or []):
        raise HTTPException(404, "no such conversation")
    return doc


async def _unread(doc: dict, uid: str) -> list[dict]:
    """The lines others wrote since `uid` last read it: {by, at}."""
    since = (doc.get("read") or {}).get(uid) or ""
    return [{"by": (m.get("by") or {}).get("id"), "at": m.get("at")}
            async for m in _raw()[MSGS].find({"chat": doc["_id"], "at": {"$gt": since}, "by.id": {"$ne": uid}},
                                              {"by.id": 1, "at": 1})]


async def summary(doc: dict, uid: str, folks: dict[str, dict] | None = None) -> dict:
    folks = folks if folks is not None else await _people(doc.get("members") or [])
    others = [person(folks[m]) for m in doc.get("members") or [] if m != uid and m in folks]
    unread = await _unread(doc, uid)
    return {"id": doc["_id"], "members": others, "created_at": doc.get("created_at"), "updated_at": doc.get("updated_at"),
            "last": doc.get("last"), "unread": len(unread),
            # When each of the others last read it: "seen" under one's own last line.
            "read": {m: at for m, at in (doc.get("read") or {}).items() if m != uid}}


def _pair(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


@router.get("/state")
async def state() -> dict:
    """Everything the page keeps: the people, my conversations, and what is unread - in total and by sender."""
    if not auth.enabled():
        return {"enabled": False, "people": [], "chats": [], "unread": {"total": 0, "senders": []}}
    who = me()
    uid = who["id"]
    users = [u async for u in _raw()[auth.USERS].find({}, {"pw": 0, "avatar": 0})]
    folks = {u["_id"]: u for u in users}
    chats = [d async for d in _raw()[CHATS].find(_mine(uid)).sort("updated_at", -1).limit(300)
             if uid in (d.get("members") or [])]
    rows = [await summary(d, uid, folks) for d in chats]
    direct = {next((m for m in d.get("members") or [] if m != uid), None): d["_id"] for d in chats}
    known = {m for d in chats for m in d.get("members") or []}
    unread_by: dict[str, int] = {}
    last_at: dict[str, str] = {}
    for d in chats:
        for u in await _unread(d, uid):
            if u["by"]:
                unread_by[u["by"]] = unread_by.get(u["by"], 0) + 1
                last_at[u["by"]] = max(last_at.get(u["by"], ""), u["at"] or "")
    by_chat = {r["id"]: r["unread"] for r in rows}
    people = []
    for u in users:
        if u["_id"] == uid or u.get("disabled"):
            continue
        cid = direct.get(u["_id"])
        people.append({**person(u, u["_id"] in known), "chat": cid, "unread": by_chat.get(cid, 0) if cid else 0})
    people.sort(key=lambda p: (-p["unread"], not p["online"], (p["name"] or "").lower()))
    senders = sorted(({**person(folks[s]), "n": n} for s, n in unread_by.items() if s in folks),
                     key=lambda s: last_at.get(s["id"], ""), reverse=True)
    return {"enabled": True, "me": uid, "people": people, "chats": rows,
            "unread": {"total": sum(unread_by.values()), "senders": senders}}


class ChatIn(BaseModel):
    people: list[str] = Field(min_length=1, max_length=1)     # the one person to write to


@router.post("/chats")
async def open_chat(body: ChatIn) -> dict:
    """The conversation with this person: one per pair, made the first time."""
    who = me(write=True)
    uid = who["id"]
    other = str(body.people[0] or "")
    if not other or other == uid:
        raise HTTPException(400, "say who to write to")
    folks = await _people([other, uid])
    if other not in folks or folks[other].get("disabled"):
        raise HTTPException(404, "no such person")
    raw = _raw()
    pair = _pair(uid, other)
    doc = await raw[CHATS].find_one({"pair": pair})
    if doc:
        return await summary(doc, uid, folks)
    now = _now()
    doc = {"_id": "dm-" + secrets.token_hex(6), "members": sorted([uid, other]), "direct": True, "pair": pair,
           "created_by": _by(who), "created_at": now, "updated_at": now, "last": None, "read": {uid: now}}
    try:
        await raw[CHATS].insert_one(doc)
    except Exception:                                  # noqa: BLE001 - the other one opened it at the same moment
        got = await raw[CHATS].find_one({"pair": pair})
        if not got:
            raise
        doc = got
    await _tell(doc, lambda m: {"type": "chat", "chat": doc["_id"]})
    return await summary(doc, uid, folks)


@router.get("/chats/{cid}")
async def get_chat(cid: str, before: str = "", limit: int = PAGE) -> dict:
    """The conversation and its lines, oldest first: the last `limit`, or those before `before`."""
    who = me()
    doc = await _chat(cid, who["id"])
    q: dict = {"chat": doc["_id"]}
    if before:
        q["at"] = {"$lt": before}
    rows = [m async for m in _raw()[MSGS].find(q).sort("at", -1).limit(max(1, min(int(limit or PAGE), PAGE)) + 1)]
    more = len(rows) > min(int(limit or PAGE), PAGE)
    rows = rows[: min(int(limit or PAGE), PAGE)]
    rows.reverse()
    for m in rows:
        await _backfill(m)
    return {**await summary(doc, who["id"]), "messages": [line(m) for m in rows], "more": more}


async def _backfill(m: dict) -> None:
    """A line sent before things went as data (they pointed into the
    sender's space): each thing still there is taken as data now, once."""
    items = m.get("items") or []
    if not any(not it.get("snap") and not it.get("revoked") for it in items):
        return
    for it in items:
        if it.get("snap") or it.get("revoked") or not it.get("space"):
            continue
        try:
            it["snap"] = await snapshot(it, m["chat"], m["_id"], m.get("by") or {}, m.get("at") or _now())
        except HTTPException:
            it["revoked"] = True                       # gone from the sender's space, or too big
    await _raw()[MSGS].update_one({"_id": m["_id"]}, {"$set": {"items": items}})


@router.post("/chats/{cid}/read")
async def mark_read(cid: str) -> dict:
    who = me()
    doc = await _chat(cid, who["id"])
    if who.get("page"):
        return {"ok": False}
    at = _now()
    await _raw()[CHATS].update_one({"_id": doc["_id"]}, {"$set": {f"read.{who['id']}": at}})
    await _tell(doc, lambda m: {"type": "read", "chat": doc["_id"], "user": who["id"], "at": at})
    return {"ok": True, "at": at}


# ---- lines ------------------------------------------------------------------

def line(m: dict, space: str | None = None) -> dict:
    """A line as a reader gets it: the things it carries as that reader may see them."""
    space = space or scope.current()
    out = {k: v for k, v in m.items() if k not in ("_id", "chat", "items")}
    out["id"] = m["_id"]
    if m.get("items"):
        out["items"] = [card(it, space) for it in m["items"]]
    return out


def card(it: dict, space: str) -> dict:
    """A sent thing, for a reader in `space`: its card, and its snapshot
    (`snap`) - the data it was sent as, which every member views and adds
    to their own space. In the space it came from it also opens in its tab
    (`own`, with its id). Taken back since: its kind and name only."""
    if it.get("revoked") or not it.get("snap"):
        return {"kind": it.get("kind"), "label": it.get("label"), "revoked": True}
    own = it.get("space") == space
    out = {"kind": it.get("kind"), "label": it.get("label"), "facts": it.get("facts") or [], "snap": it["snap"],
           "own": own, "add": it.get("kind") in ADDABLE}
    if own:
        out["id"] = it.get("id")
        if it.get("open"):
            out["open"] = it["open"]
    if it.get("note"):
        out["note"] = it["note"]
    return out


class ItemRef(BaseModel):
    kind: str = Field(max_length=20)
    id: str = Field(min_length=1, max_length=400)


class SayIn(BaseModel):
    text: str = Field(default="", max_length=MAX_TEXT)
    items: list[ItemRef] = Field(default_factory=list, max_length=MAX_ITEMS)


async def _spaces(members: list[str]) -> dict[str, str]:
    return {u["_id"]: auth.space_of(u) for u in (await _people(members)).values()}


async def _tell(doc: dict, ev) -> None:
    """Something happened in a conversation: on each member's live stream.
    `ev(member_space)` builds the event, so what a line carries is cut to
    what that member may see."""
    hub = _hub()
    spaces = await _spaces(doc.get("members") or [])
    for m in doc.get("members") or []:
        if hub.watchers(key(m)):
            hub.publish(key(m), ev(spaces.get(m, "")))


@router.post("/chats/{cid}/messages")
async def say(cid: str, body: SayIn) -> dict:
    """A line to the others: kept, and on their pages at once. No model answers."""
    who = me(write=True)
    doc = await _chat(cid, who["id"])
    text = (body.text or "").strip()
    items = []
    seen = set()
    for ref in body.items:
        k = (ref.kind, ref.id)
        if k in seen:
            continue
        seen.add(k)
        items.append(await describe(ref.kind, ref.id))
    if not text and not items:
        raise HTTPException(400, "nothing to send")
    now = _now()
    m = {"_id": secrets.token_hex(6), "chat": doc["_id"], "by": _by(who), "at": now, "text": text}
    raw = _raw()
    if items:
        # Each thing as data, as it is now: what it was when it was sent,
        # whatever becomes of it in the sender's space.
        made: list[str] = []
        try:
            for it in items:
                it["snap"] = await snapshot(it, doc["_id"], m["_id"], _by(who), now)
                made.append(it["snap"])
        except BaseException:
            for sid in made:
                await _drop_snap(sid)
            raise
        m["items"] = items
    await raw[MSGS].insert_one(m)
    last = {"by": who.get("name"), "by_id": who["id"], "text": _clip(text or ", ".join(i["label"] for i in items), 140),
            "at": now, **({"items": len(items)} if items else {})}
    await raw[CHATS].update_one({"_id": doc["_id"]},
                                {"$set": {"updated_at": now, "last": last, f"read.{who['id']}": now}})
    await _tell(doc, lambda sp: {"type": "message", "chat": doc["_id"], "message": line(m, sp)})
    return line(m)


class EditIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)


async def _own(cid: str, mid: str, who: dict) -> tuple[dict, dict]:
    doc = await _chat(cid, who["id"])
    m = await _raw()[MSGS].find_one({"_id": str(mid), "chat": doc["_id"]})
    if not m:
        raise HTTPException(404, "no such line")
    if (m.get("by") or {}).get("id") != who["id"]:
        raise HTTPException(403, "only your own lines")
    return doc, m


@router.patch("/chats/{cid}/messages/{mid}")
async def edit(cid: str, mid: str, body: EditIn) -> dict:
    who = me(write=True)
    doc, m = await _own(cid, mid, who)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "nothing to send")
    at = _now()
    await _raw()[MSGS].update_one({"_id": m["_id"]}, {"$set": {"text": text, "edited_at": at}})
    m = {**m, "text": text, "edited_at": at}
    await _relast(doc)
    await _tell(doc, lambda sp: {"type": "edit", "chat": doc["_id"], "message": line(m, sp)})
    return line(m)


@router.delete("/chats/{cid}/messages/{mid}")
async def delete(cid: str, mid: str) -> dict:
    who = me(write=True)
    doc, m = await _own(cid, mid, who)
    await _raw()[MSGS].delete_one({"_id": m["_id"]})
    for it in m.get("items") or []:                    # what it sent goes with it
        if it.get("snap"):
            await _drop_snap(it["snap"])
    await _relast(doc)
    from .main import db
    await actors.audit(db(), "delete", f"dm {doc['_id']}/{m['_id']}")
    await _tell(doc, lambda sp: {"type": "delete", "chat": doc["_id"], "id": m["_id"]})
    return {"deleted": m["_id"]}


async def _relast(doc: dict) -> None:
    """The list's last line, after the last one changed or went."""
    rows = [x async for x in _raw()[MSGS].find({"chat": doc["_id"]}).sort("at", -1).limit(1)]
    last = None
    if rows:
        x = rows[0]
        last = {"by": (x.get("by") or {}).get("name"), "by_id": (x.get("by") or {}).get("id"),
                "text": _clip(x.get("text") or ", ".join(i.get("label") or "" for i in x.get("items") or []), 140),
                "at": x.get("at"), **({"items": len(x["items"])} if x.get("items") else {})}
    await _raw()[CHATS].update_one({"_id": doc["_id"]}, {"$set": {"last": last}})


@router.get("/search")
async def search(q: str = "", limit: int = 30) -> dict:
    """My direct conversations' lines holding every word of `q` - only mine."""
    who = me()
    words = [w for w in q.lower().split() if w][:8]
    if not words:
        return {"q": q, "results": []}
    raw = _raw()
    chats = {d["_id"]: d async for d in raw[CHATS].find(_mine(who["id"]))
             if who["id"] in (d.get("members") or [])}
    if not chats:
        return {"q": q, "results": []}
    folks = await _people({m for d in chats.values() for m in d.get("members") or []})
    rx = re.escape(words[0])
    out = []
    async for m in raw[MSGS].find({"chat": {"$in": list(chats)}, "text": {"$regex": rx, "$options": "i"}}).sort("at", -1):
        if m.get("chat") not in chats:
            continue
        low = (m.get("text") or "").lower()
        if not all(w in low for w in words):
            continue
        d = chats[m["chat"]]
        names = [folks[x].get("name") for x in d.get("members") or [] if x != who["id"] and x in folks]
        i = low.find(words[0])
        snip = _clip((m.get("text") or "")[max(0, i - 60): i + 140], 200)
        out.append({"chat_id": d["_id"], "title": ", ".join(n or "?" for n in names),
                    "message_id": m["_id"], "at": m.get("at"), "by": (m.get("by") or {}).get("name"), "snippet": snip})
        if len(out) >= max(1, min(limit, 100)):
            break
    return {"q": q, "results": out}


# ---- the live stream --------------------------------------------------------

def _sse(obj: dict) -> bytes:
    import json
    return ("data: " + json.dumps(obj, ensure_ascii=False, default=str) + "\n\n").encode()


@router.get("/live")
async def live(request: Request):
    """My conversations as they change: {type: hello} first, then message,
    edit, delete, read and chat events, each naming its conversation; {type:
    bye} after LIVE_MAX seconds, and the page opens it again. While it is
    open, the others see me online."""
    who = me()
    hub = _hub()
    k = key(who["id"])
    q = hub.subscribe(k)

    async def events():
        try:
            yield _sse({"type": "hello"})
            opened = time.monotonic()
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), LIVE_PING)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        return
                    if time.monotonic() - opened > LIVE_MAX:
                        yield _sse({"type": "bye"})
                        return
                    yield b": ping\n\n"
                    continue
                if ev is None:
                    yield _sse({"type": "bye", "why": "behind"})
                    return
                yield _sse(ev)
        finally:
            hub.unsubscribe(k, q)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- things to send ---------------------------------------------------------

def _size(n) -> str:
    from .cc_context import _size as size
    return size(n)


async def describe(kind: str, ref: str, db=None) -> dict:
    """One thing of the asker's space, as its card: {kind, id, label,
    facts, space, open}. A 404 when it is not there - or not this space's,
    which is the same thing to the person asking."""
    if kind not in KINDS:
        raise HTTPException(400, f"cannot send a {kind!r}")
    db = db or _space_db(scope.current())
    ref = str(ref)
    got = await _LOOK[kind](db, ref)
    if not got:
        raise HTTPException(404, f"no {kind} {ref!r} in your space")
    label, facts, open_ = got
    return {"kind": kind, "id": ref, "label": _clip(label, 120) or ref,
            "facts": [_clip(f, 80) for f in facts if f][:5], "space": scope.current(),
            **({"open": open_} if open_ else {})}


async def _model(db, ref):
    d = await db["models"].find_one({"_id": ref})
    if not d:
        return None
    built = d.get("built") or {}
    return (d.get("title") or d.get("name") or ref,
            [ref + ".3d", f"v{d['version']}" if d.get("version") is not None else "",
             ("built" if built else "not built") + (" · changed since" if built and d.get("stale") else "")], None)


async def _board(db, ref):
    d = await db["boards"].find_one({"_id": ref})
    if not d:
        return None
    ver = (d.get("component") or {}).get("version")
    return (d.get("title") or ref, [ref + ".pcb", d.get("folder") or "", f"v{ver}" if ver is not None else ""], None)


async def _project(db, ref):
    ref = ref.strip("/")
    pre = "^" + re.escape(ref) + "/"
    models = await db["models"].count_documents({"$or": [{"folder": ref}, {"_id": {"$regex": pre}}]})
    boards = await db["boards"].count_documents({"folder": ref})
    folder = await db["folders"].find_one({"_id": ref})
    if not (folder or models or boards):
        return None
    first = [x async for x in db["models"].find({"$or": [{"folder": ref}, {"_id": {"$regex": pre}}]}, {"_id": 1})
             .sort("_id", 1).limit(1)]
    return (ref.rsplit("/", 1)[-1], [ref + "/", f"{models} models", f"{boards} boards"],
            {"model": first[0]["_id"]} if first else None)


async def _taste(db, ref):
    d = await db["taste_palettes"].find_one({"_id": ref})
    if not d:
        return None
    return (d.get("name") or ref, [f"{len(d.get('items') or [])} statements", _clip(d.get("description"), 70)], None)


async def _product(db, ref):
    mid, _, pid = ref.partition(":")
    d = await db["manufacturers"].find_one({"_id": mid}) if pid else None
    p = next((x for x in (d or {}).get("products") or [] if str(x.get("id")) == pid), None)
    if not p:
        return None
    from .chat_tools import _catalog
    return (p.get("name") or pid, [d.get("name") or mid, p.get("sku") or "", _catalog.price(p).split(": ", 1)[-1],
                                    _catalog.stock(p), p.get("category") or ""],
            {"maker": mid, "name": p.get("name") or ""})


async def _inventory(db, ref):
    from . import inventory as inv
    d = await db[inv.COLL].find_one({"_id": ref})
    if not d:
        return None
    return (d.get("name") or ref, [f"{inv.qty(d.get('quantity'))} {d.get('unit') or 'pcs'}", d.get("location") or "",
                                    d.get("category") or "", d.get("mpn") or ""], None)


async def _note(db, ref):
    d = await db["notes"].find_one({"_id": ref})
    if not d:
        return None
    return (d.get("title") or _clip(d.get("text"), 60) or ref,
            [" ".join("#" + t for t in d.get("tags") or []), (d.get("updated_at") or "")[:10]
             if isinstance(d.get("updated_at"), str) else ""], None)


async def _file(db, ref):
    d = await db["files"].find_one({"_id": ref})
    if not d:
        return None
    return (d.get("name") or ref, [d.get("kind") or "file", _size(d.get("bytes"))], None)


async def _firmware(db, ref):
    d = await db["firmware"].find_one({"_id": ref})
    if not d:
        return None
    return (d.get("title") or d.get("name") or ref, [d.get("board") or "", d.get("mcu_title") or d.get("mcu") or "",
                                                     d.get("platform") or ""], None)


_LOOK = {"model": _model, "board": _board, "project": _project, "taste": _taste, "product": _product,
         "inventory": _inventory, "note": _note, "file": _file, "firmware": _firmware}


@router.get("/shareables")
async def shareables(q: str = "", kind: str = "", limit: int = 40) -> list[dict]:
    """What I can send, from my own space, matching every word of `q`: {kind, id, label, sub}."""
    me()
    db = _space_db(scope.current())
    words = [w for w in q.lower().split() if w]
    kinds = [kind] if kind in KINDS else list(KINDS)
    per = limit if (words or len(kinds) == 1) else max(3, limit // len(kinds))
    out: list[dict] = []

    def take(k, rows):
        n = 0
        for r in rows:
            hay = f"{r['label']} {r['id']} {r.get('sub') or ''}".lower()
            if all(w in hay for w in words):
                out.append({"kind": k, **r})
                n += 1
                if n >= per:
                    return

    if "model" in kinds:
        take("model", [{"id": d["_id"], "label": d.get("title") or d.get("name") or d["_id"], "sub": d["_id"] + ".3d"}
                       async for d in db["models"].find({}, {"title": 1, "name": 1, "folder": 1}).sort("_id", 1)])
    if "board" in kinds:
        take("board", [{"id": d["_id"], "label": d.get("title") or d["_id"], "sub": d["_id"] + ".pcb"}
                       async for d in db["boards"].find({}, {"title": 1}).sort("_id", 1)])
    if "project" in kinds:
        names = {d["_id"] async for d in db["folders"].find({}, {"_id": 1})}
        names |= {d["_id"].split("/", 1)[0] async for d in db["models"].find({}, {"_id": 1}) if "/" in d["_id"]}
        take("project", [{"id": n, "label": n.rsplit("/", 1)[-1], "sub": n + "/"} for n in sorted(names) if n])
    if "taste" in kinds:
        take("taste", [{"id": d["_id"], "label": d.get("name") or d["_id"], "sub": f"{len(d.get('items') or [])} statements"}
                       async for d in db["taste_palettes"].find({}, {"name": 1, "items": 1})])
    if "product" in kinds:
        rows = []
        async for d in db["manufacturers"].find({}, {"name": 1, "products": 1}):
            for p in d.get("products") or []:
                if p.get("id") is not None:
                    rows.append({"id": f"{d['_id']}:{p['id']}", "label": p.get("name") or str(p["id"]),
                                 "sub": " · ".join(x for x in (d.get("name"), p.get("sku")) if x)})
                if len(rows) > 3000:
                    break
        take("product", rows)
    if "inventory" in kinds:
        take("inventory", [{"id": d["_id"], "label": d.get("name") or d["_id"],
                            "sub": " · ".join(x for x in (d.get("location"), d.get("category")) if x)}
                           async for d in db["inventory"].find({}, {"name": 1, "location": 1, "category": 1}).limit(3000)])
    if "note" in kinds:
        take("note", [{"id": d["_id"], "label": d.get("title") or _clip(d.get("text"), 60) or d["_id"], "sub": ""}
                      async for d in db["notes"].find({}, {"title": 1, "text": 1}).sort("updated_at", -1).limit(500)])
    if "file" in kinds:
        take("file", [{"id": d["_id"], "label": d.get("name") or d["_id"], "sub": f"{d.get('kind') or 'file'} · {_size(d.get('bytes'))}"}
                      async for d in db["files"].find({}, {"name": 1, "kind": 1, "bytes": 1}).sort("created_at", -1).limit(500)])
    if "firmware" in kinds:
        take("firmware", [{"id": d["_id"], "label": d.get("title") or d["_id"], "sub": d.get("board") or ""}
                          async for d in db["firmware"].find({}, {"title": 1, "board": 1})])
    if words:
        w = words[0]
        out.sort(key=lambda r: 0 if str(r["label"]).lower().startswith(w) else 1)
    return out[:limit]


@router.get("/item")
async def item(kind: str, id: str) -> dict:
    """One thing of my space as its card would show it - for "Send to..." before it is sent."""
    me()
    d = await describe(kind, id)
    return {k: v for k, v in d.items() if k != "space"}


# ---- what was sent: snapshots ---------------------------------------------
#
# A thing sent is data, not a pointer: its snapshot (`dm_items`) holds what
# it was when it was sent - a palette's statements, a product's fields, a
# note's text, a model's sources with those of the models it imports - and
# its bytes (`dm_blobs`, in pieces): a file, a model's built 3D view, a
# board's layout. It belongs to its line: only the conversation's members
# read it, deleting the line (or the sender taking it back) deletes it, and
# nothing the sender does to the original afterwards changes it. "Add to
# my ..." makes a new thing in the reader's own space from it.

async def _blob_put(data: bytes) -> dict:
    bid = secrets.token_hex(8)
    raw = _raw()
    for i in range(0, max(1, -(-len(data) // PIECE))):
        await raw[BLOBS].insert_one({"_id": f"{bid}:{i}", "blob": bid, "i": i, "data": data[i * PIECE:(i + 1) * PIECE]})
    return {"id": bid, "bytes": len(data)}


async def _blob_get(bid: str) -> bytes:
    rows = [r async for r in _raw()[BLOBS].find({"blob": bid})]
    rows.sort(key=lambda r: r["i"])
    return b"".join(bytes(r["data"]) for r in rows)


async def _drop_snap(sid: str) -> None:
    raw = _raw()
    d = await raw[ITEMS].find_one({"_id": sid})
    for b in ((d or {}).get("blobs") or {}).values():
        await raw[BLOBS].delete_many({"blob": b["id"]})
    await raw[ITEMS].delete_one({"_id": sid})


def _too_big(what: str) -> HTTPException:
    return HTTPException(413, f"{what} is too big to send (over {MAX_BLOB // (1024 * 1024)} MB)")


async def snapshot(it: dict, chat: str, mid: str, by: dict, at: str) -> str:
    """The thing as data, kept with the line; its id."""
    import json
    db = _space_db(it["space"])
    got = await _SNAP[it["kind"]](db, it["id"])
    if got is None:
        raise HTTPException(404, f"no {it['kind']} {it['id']!r} in your space")
    data, blobs, note = got
    if len(json.dumps(data, default=str)) > MAX_DATA:
        raise HTTPException(413, f"{it['label']} is too big to send")
    stored = {}
    for label, (raw_bytes, meta) in blobs.items():
        stored[label] = {**await _blob_put(raw_bytes), **meta}
    sid = "s" + secrets.token_hex(7)
    await _raw()[ITEMS].insert_one({"_id": sid, "chat": chat, "msg": mid, "kind": it["kind"], "label": it["label"],
                                    "facts": it.get("facts") or [], "data": data, "blobs": stored, "by": by, "at": at})
    if note:
        it["note"] = note
    return sid


async def _snap_taste(db, ref):
    """A palette as sent: everything its export file holds - each statement
    with its scope, exception, example and layer, the priority rule, where
    it came from, the measurements - and its reference renders, copied so
    the sent palette keeps them whatever happens to the sender's."""
    from . import store, taste
    d = await db["taste_palettes"].find_one({"_id": ref})
    if not d:
        return None
    data = await taste.export_doc(db, d)
    refs = []
    for r in data.pop("references", []):
        try:
            import base64
            shot = await store.put_shot(db, base64.b64decode(r.pop("png")))
        except Exception:                               # noqa: BLE001 - a lost picture is left out
            continue
        refs.append({**r, "gridfs_id": str(shot["gridfs_id"])})      # kept as text: the line is sent as JSON
    data["references"] = refs
    return (data, {}, "")


async def _snap_note(db, ref):
    d = await db["notes"].find_one({"_id": ref})
    return (_plain(d, ("title", "text", "tags", "created_at", "updated_at")), {}, "") if d else None


async def _snap_product(db, ref):
    mid, _, pid = ref.partition(":")
    d = await db["manufacturers"].find_one({"_id": mid}) if pid else None
    p = next((x for x in (d or {}).get("products") or [] if str(x.get("id")) == pid), None)
    if not p:
        return None
    from .chat_tools import _catalog
    return ({"product": p, "price_label": _catalog.price(p).split(": ", 1)[-1],
             "maker": _plain(d, ("name", "domain", "url"))}, {}, "")


INV_FIELDS = ("name", "quantity", "unit", "location", "category", "mpn", "lcsc", "manufacturer", "board", "notes",
              "tags", "price", "currency")


async def _snap_inventory(db, ref):
    d = await db["inventory"].find_one({"_id": ref})
    if not d:
        return None
    # What it is, and - for the viewer only - its minimum, its link and how
    # its quantity went (the log); "Add to my stock" takes INV_FIELDS alone.
    out = _plain(d, INV_FIELDS + ("min_stock", "type", "subtype", "created_at", "updated_at"))
    cat = d.get("catalog") or {}
    if cat:
        out["catalog"] = _plain(cat, ("manufacturer_name", "product_name", "sku", "url"))
    out["log"] = [{**_plain(x, ("at", "kind", "delta", "after", "reason")), "by": (x.get("by") or {}).get("name") or ""}
                  for x in (d.get("log") or [])[-60:]]
    return out, {}, ""


async def _snap_file(db, ref):
    from . import files
    d = await db[files.COLL].find_one({"_id": ref})
    if not d:
        return None
    if (d.get("bytes") or 0) > MAX_BLOB:
        raise _too_big(d.get("name") or "the file")
    try:
        _, data = await files.get(db, ref)
    except KeyError:
        return None
    meta = _plain(d, ("name", "kind", "bytes", "content_type", "note", "created_at"))
    preview = files.preview_of(d.get("name") or "", d.get("kind") or "", d.get("content_type") or "")
    meta["preview"] = preview
    low = (d.get("name") or "").lower()
    if (d.get("kind") in ("text", "table", "bom", "pick-place") or preview in ("text", "markdown")
            or low.endswith((".csv", ".tsv"))) and len(data) <= 400_000:
        meta["text"] = files._decode(data)
    blobs = {"file": (data, {"type": d.get("content_type") or "application/octet-stream"})}
    if preview == "step":
        # Its 3D, as the Files tab shows a STEP: the kept mesh, or one made now (a few seconds at most).
        from . import filemesh
        try:
            got = await filemesh.cached(db, d) or await filemesh.mesh(db, d, 15)
        except Exception:                              # noqa: BLE001 - sent without its 3D
            got = None
        if got and len(got[1]) <= MAX_BLOB:
            blobs["mesh"] = (got[1], {"type": "model/gltf-binary", "gzip": True})
    return meta, blobs, ""


async def _snap_model(db, ref):
    from . import cc_context, store
    got = await cc_context.model_parts(db, ref)
    if not got:
        return None
    d = got["doc"]
    # Its source, and those of the models it imports - enough to build it again elsewhere.
    sources: dict[str, dict] = {}
    todo = [ref]
    while todo and len(sources) < MAX_MODELS:
        mid = todo.pop(0)
        if mid in sources:
            continue
        x = d if mid == ref else await db["models"].find_one({"_id": mid}, {"source": 1, "title": 1, "uses": 1})
        if not x:
            continue
        sources[mid] = {"title": x.get("title") or mid, "source": x.get("source") or ""}
        todo += [u.get("id") for u in x.get("uses") or [] if u.get("kind") == "model" and u.get("id")]
    data = {"title": d.get("title") or d.get("name") or ref, "id": ref, "version": d.get("version"),
            "lines": got["lines"], "models": sources}
    # Its figures, for the viewer's tiles: the build, its sizes, what it uses.
    built = d.get("built") or {}
    if built:
        data["built"] = {"version": built.get("version"), "at": built.get("at"), "secs": d.get("build_secs")}
    data["uses"] = [{"kind": u.get("kind"), "id": u.get("id")} for u in (d.get("uses") or [])[:60] if u.get("id")]
    try:
        sizes = await cc_context._viewer_sizes(db, ref, (d.get("artifacts") or {}).get("viewer") or {})
    except Exception:                                  # noqa: BLE001 - sizes are a nicety
        sizes = None
    if sizes and sizes.get("overall"):
        data["sizes"] = {"overall": sizes["overall"].get("size_mm"),
                         "parts": [{"part": x.get("part"), "size": x.get("size_mm")} for x in (sizes.get("parts") or [])[:200]]}
    blobs, note = {}, ""
    meta = (d.get("artifacts") or {}).get("viewer")
    if meta:
        try:
            packed = await store.get_artifact_gz(db, ref, "viewer")
        except Exception:                              # noqa: BLE001 - sent without its 3D view
            packed = None
        if packed and len(packed) <= MAX_BLOB:
            blobs["viewer"] = (packed, {"type": "application/json", "gzip": True})
        elif packed:
            note = "3D view too big to send"
    return data, blobs, note


async def _snap_board(db, ref):
    from . import cc_context, store
    got = await cc_context.board_parts(db, ref)
    if not got:
        return None
    d = got["doc"]
    blobs, note = {}, ""
    # Its pictures: the layout from the top (and the bottom), and the schematic.
    for art, label in (("layout", "layout"), ("bottom", "bottom"), ("schematic_svg", "schematic")):
        try:
            svg = await store.get_artifact(db, ref, art, "boards")
        except Exception:                              # noqa: BLE001 - not laid out (or drawn) yet
            continue
        if len(svg) <= MAX_BLOB:
            blobs[label] = (svg, {"type": "image/svg+xml"})
        elif label == "layout":
            note = "layout too big to send"
    # The schematic's own sheets, as the PCB tab draws them.
    for sh in ((d.get("schematic") or {}).get("sheets") or [])[:12]:
        key = str(sh.get("key") or "")
        if not re.fullmatch(r"[\w.-]+", key):
            continue
        try:
            svg = await store.get_artifact(db, ref, f"schematic_sheet_{key}", "boards")
        except Exception:                              # noqa: BLE001 - not drawn
            continue
        if len(svg) <= MAX_BLOB:
            blobs[f"sheet-{key}"] = (svg, {"type": "image/svg+xml"})
    # Its 3D (the PCB tab's GLB), packed: a board's runs to 20 MB and more as it is.
    try:
        glb = await store.get_artifact(db, ref, "model3d", "boards")
    except Exception:                                  # noqa: BLE001 - no 3D yet
        glb = None
    if glb:
        import gzip
        packed = await asyncio.to_thread(gzip.compress, glb, 6)
        if len(packed) <= MAX_BLOB:
            blobs["board3d"] = (packed, {"type": "model/gltf-binary", "gzip": True})
    return {"title": d.get("title") or ref, "id": ref, "lines": [t for _, t in got["lines"]][:400],
            "facts": _board_facts(d, got.get("graph")), **await _board_source(db, ref)}, blobs, note


async def _board_source(db, ref) -> dict:
    """The board's atopile source, for the viewer's Code tab (board_parts leaves it out)."""
    from . import ato
    d = await db[ato.BOARDS].find_one({"_id": ref}, {"source": 1})
    src = (d or {}).get("source") or ""
    return {"sources": {f"{ref}.ato": src}} if src and len(src) <= 400_000 else {}


def _board_facts(d: dict, graph: dict | None) -> dict:
    """A board's figures, for the viewer's tiles and its BOM: size, parts,
    routing, checks, the netlist's counts and largest nets, and the BOM."""
    lay, route, drc = d.get("layout") or {}, d.get("route") or {}, d.get("drc") or {}
    sch = d.get("schematic") or {}
    erc = sch.get("erc") or {}
    comp = d.get("component") or {}
    rules = d.get("rules") or {}
    out: dict = {"version": comp.get("version"), "folder": d.get("folder") or "", "kind": d.get("kind") or "",
                 "saved_at": d.get("saved_at"), "imported": bool(d.get("imported"))}
    if (comp.get("summary") or {}).get("thickness"):
        out["thickness"] = comp["summary"]["thickness"]
    if lay:
        out["layout"] = {"placed": lay.get("placed"), "size_mm": lay.get("size_mm"), "holes": len(lay.get("holes") or []),
                         "at": lay.get("at")}
    if route:
        out["route"] = {k: route.get(k) for k in ("tracks", "vias", "length_mm", "zones", "unrouted", "engine", "route_s")}
    if drc:
        out["drc"] = {k: drc.get(k) for k in ("error_count", "warning_count", "unconnected", "errors", "warnings",
                                              "in_footprints", "at")}
        out["drc"]["examples"] = [str(x)[:300] for x in (drc.get("examples") or [])[:20]]
    if sch:
        out["schematic"] = {k: sch.get(k) for k in ("parts", "wires", "labels", "symbols", "no_connects")}
        out["schematic"]["sheets"] = [{"key": x.get("key"), "name": x.get("name"), "parts": x.get("parts")} for x in sch.get("sheets") or []]
    if erc:
        out["erc"] = {k: erc.get(k) for k in ("error_count", "warning_count", "errors", "warnings")}
        out["erc"]["examples"] = [str(x)[:300] for x in (erc.get("examples") or [])[:20]]
    if rules:
        out["rules"] = {"classes": [{k: c.get(k) for k in ("name", "track", "clearance", "via", "drill", "nets", "patterns")}
                                    for c in (rules.get("classes") or [])[:40]],
                        "board": rules.get("board") or {},
                        "pours": [{k: x.get(k) for k in ("net", "layers", "clearance")} for x in (rules.get("pours") or [])[:10]],
                        "pairs": len(rules.get("pairs") or [])}
    if graph:
        nets = graph.get("nets") or []
        out["counts"] = graph.get("counts") or {}
        out["nets"] = [{"name": n.get("name"), "pins": len(n.get("nodes") or [])}
                       for n in sorted(nets, key=lambda n: -len(n.get("nodes") or []))[:24]]
        out["net_count"] = len(nets)
        out["single"] = [n.get("name") for n in nets if len(n.get("nodes") or []) == 1][:200]
        bom = graph.get("bom") or []
        out["bom"] = ([{"ref": b.get("designator"), "value": b.get("comment"), "footprint": b.get("footprint"),
                        "lcsc": b.get("lcsc") or ""} for b in bom] if bom else
                      [{"ref": c.get("ref"), "value": c.get("value"), "footprint": c.get("footprint"),
                        "lcsc": c.get("part") or ""} for c in graph.get("components") or []])[:600]
    return out


async def _snap_firmware(db, ref):
    from . import firmware
    d = await db["firmware"].find_one({"_id": ref})
    if not d:
        return None
    out = _plain(d, ("title", "name", "board", "board_title", "mcu", "mcu_title", "mcu_part", "sheet_name", "platform",
                     "framework", "pio_board", "version", "updated_at"))
    b = d.get("build") or {}
    if b:
        out["build"] = {k: b.get(k) for k in ("state", "at", "seconds", "version", "error_count", "warning_count",
                                              "flash", "ram")}
    if isinstance(d.get("pins"), dict):
        out["pins"] = dict(list(d["pins"].items())[:120])
    # Its files, and their text when it is small enough to send along.
    try:
        tree = await firmware.tree(db, ref)
        texts = await firmware.contents(db, ref)
    except Exception:                                  # noqa: BLE001 - sent without its files
        tree, texts = [], {}
    out["files"] = [{"path": f["path"], "bytes": f.get("bytes") or 0, "generated": f.get("generated") or False}
                    for f in tree[:200]]
    if sum(len(x) for x in texts.values()) <= 400_000:
        out["sources"] = texts
    return out, {}, ""


async def _snap_project(db, ref):
    ref = ref.strip("/")
    pre = "^" + re.escape(ref) + "/"
    # Each model and board with its state, for the viewer's tiles and table.
    models = [{"id": x["_id"], "title": x.get("title") or x["_id"], "version": x.get("version"),
               "built": (x.get("built") or {}).get("version"), "stale": bool(x.get("stale")), "error": bool(x.get("error")),
               "uses": len(x.get("uses") or []), "updated_at": x.get("updated_at")}
              async for x in db["models"].find({"$or": [{"folder": ref}, {"_id": {"$regex": pre}}]},
                                                {"title": 1, "version": 1, "built.version": 1, "stale": 1, "error": 1, "uses": 1,
                                                 "updated_at": 1}).sort("_id", 1)]
    boards = [{"id": x["_id"], "title": x.get("title") or x["_id"], "version": (x.get("component") or {}).get("version"),
               "size_mm": (x.get("layout") or {}).get("size_mm"), "parts": (x.get("layout") or {}).get("placed"),
               "drc": (x.get("drc") or {}).get("error_count"), "folder": x.get("folder")}
              async for x in db["boards"].find({"$or": [{"folder": ref}, {"folder": {"$regex": pre[:-1] + "(/|$)"}}]},
                                               {"title": 1, "component.version": 1, "layout.size_mm": 1,
                                                                 "layout.placed": 1, "drc.error_count": 1, "folder": 1})]
    if not (models or boards or await db["folders"].find_one({"_id": ref})):
        return None
    return {"name": ref, "models": models[:300], "boards": boards[:300]}, {}, ""


def _plain(d: dict, keys) -> dict:
    return {k: d.get(k) for k in keys if d.get(k) not in (None, "", [], {})}


_SNAP = {"taste": _snap_taste, "note": _snap_note, "product": _snap_product, "inventory": _snap_inventory,
         "file": _snap_file, "model": _snap_model, "board": _snap_board, "firmware": _snap_firmware,
         "project": _snap_project}


async def _snap(sid: str) -> tuple[dict, dict]:
    """A snapshot, if the asker is in its conversation; the same 404 for anything else."""
    who = me()
    d = await _raw()[ITEMS].find_one({"_id": str(sid)})
    if not d:
        raise HTTPException(404, "nothing sent here")
    await _chat(d["chat"], who["id"])
    return who, d


@router.get("/items/{sid}")
async def item_data(sid: str) -> dict:
    """What was sent, as it was sent."""
    _, d = await _snap(sid)
    data = d.get("data") or {}
    if d["kind"] == "file" and "preview" not in data:
        # How the Files tab would show it - worked out on reading, so a file sent before says it too.
        from . import files
        typ = ((d.get("blobs") or {}).get("file") or {}).get("type") or data.get("content_type") or ""
        data = {**data, "preview": files.preview_of(data.get("name") or d["label"], data.get("kind") or "", typ)}
    if d["kind"] == "file" and data.get("preview") in ("archive", "table") and "text" not in data:
        # What is inside an archive, a spreadsheet's rows: read from the bytes sent, never unpacked to disk.
        data = {**data, **await _file_inside(d, data)}
    return {"snap": d["_id"], "kind": d["kind"], "label": d["label"], "facts": d.get("facts") or [], "by": d.get("by"),
            "at": d.get("at"), "add": d["kind"] in ADDABLE, "data": data,
            "blobs": {k: {"bytes": v.get("bytes"), "type": v.get("type")} for k, v in (d.get("blobs") or {}).items()}}


async def _file_inside(d: dict, data: dict) -> dict:
    from . import files
    b = (d.get("blobs") or {}).get("file")
    if not b:
        return {}
    raw = await _blob_get(b["id"])
    name = data.get("name") or d["label"]
    try:
        if data.get("preview") == "archive":
            got = files.entries_of(name, raw)
            return {"entries": {**got, "entries": (got.get("entries") or [])[:1000]}}
        got = files.table_of(name, raw)
        return {"table": {**got, "rows": (got.get("rows") or [])[:500]}}
    except Exception:                                  # noqa: BLE001 - shown as a file to download
        return {}


@router.get("/items/{sid}/blob/{label}")
async def item_blob(sid: str, label: str, download: str = "0"):
    """A sent thing's bytes: a file, a model's 3D view, a board's layout."""
    from fastapi.responses import Response
    _, d = await _snap(sid)
    b = (d.get("blobs") or {}).get(label)
    if not b:
        raise HTTPException(404, "not sent with it")
    data = await _blob_get(b["id"])
    headers = {"Cache-Control": "private, max-age=31536000, immutable"}
    if b.get("gzip"):
        headers["Content-Encoding"] = "gzip"
    if download in ("1", "true"):
        name = (d.get("data") or {}).get("name") or d["label"]
        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{_quote(name)}"
    return Response(data, media_type=b.get("type") or "application/octet-stream", headers=headers)


def _quote(name: str) -> str:
    import urllib.parse
    return urllib.parse.quote(str(name), safe="")


@router.post("/items/{sid}/add")
async def add(sid: str) -> dict:
    """A new thing in my own space, made from what was sent: {kind, id, label, ...} of it."""
    who, d = await _snap(sid)
    if d["kind"] not in ADDABLE:
        raise HTTPException(400, f"a {d['kind']} cannot be added to your space yet - view it instead")
    dst = _space_db(scope.current())
    from_who = (d.get("by") or {}).get("name") or "someone"
    got = await _ADD[d["kind"]](dst, d, _by(who), from_who)
    from .main import db
    await actors.audit(db(), "dm-add", f"{d['kind']} {got['id']}", {"from": sid})
    return {"kind": d["kind"], **got}


async def _free(taken, name: str, sep: str = " ") -> str:
    """`name`, or with a number after it when it is taken: Name (2), base_2."""
    if not await taken(name):
        return name
    for n in range(2, 200):
        cand = f"{name} ({n})" if sep == " " else f"{name}{sep}{n}"
        if not await taken(cand):
            return cand
    return f"{name}{sep}{secrets.token_hex(2)}"


async def _add_taste(dst, d, by, from_who):
    from . import taste
    data = d.get("data") or {}

    async def taken(n):
        return bool(await dst[taste.COLL].find_one({"name": n}, {"_id": 1}))
    name = await _free(taken, data.get("name") or d["label"])
    # Made as a palette file is imported: scopes, layers, examples, the
    # priority rule and the renders come along (a message from before has
    # only the statements, and reads as it always did).
    from . import store
    import base64
    pics = []
    for r in data.get("references") or []:
        try:
            from bson import ObjectId
            gid = r["gridfs_id"]
            png = await store.get_shot(dst, ObjectId(gid) if isinstance(gid, str) and ObjectId.is_valid(gid) else gid)
        except Exception:                               # noqa: BLE001 - a lost picture is left out
            continue
        pics.append({k: v for k, v in r.items() if k != "gridfs_id"} | {"png": base64.b64encode(png).decode()})
    # The sender's project is not in this space: where a statement came from reads as given by hand.
    items = [{k: v for k, v in i.items() if k != "source"} for i in data.get("items") or [] if isinstance(i, dict)]
    doc = await taste.import_doc(dst, {"format": taste.FORMAT, "version": 2, **{k: v for k, v in data.items()
                                                                                 if k not in ("format", "version")},
                                       "items": items,
                                       "name": name, "references": pics, "by": from_who or ""}, by)
    return {"id": doc["_id"], "label": doc["name"]}


async def _add_note(dst, d, by, from_who):
    from . import notes
    doc = await notes.create(dst, (d.get("data") or {}).get("text") or d["label"], {"shared_by": from_who}, by)
    return {"id": doc["_id"], "label": doc.get("title") or d["label"]}


async def _add_inventory(dst, d, by, from_who):
    from . import inventory as inv
    data = d.get("data") or {}
    # What it is, not how many the sender had: none on hand here yet.
    raw = {k: data[k] for k in INV_FIELDS if k not in ("quantity", "location", "board") and data.get(k) not in (None, "", [])}
    try:
        doc = await inv.create(dst, {**raw, "quantity": 0}, by, reason=f"sent by {from_who}")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"id": doc["_id"], "label": doc.get("name")}


async def _add_file(dst, d, by, from_who):
    from . import files
    data = d.get("data") or {}
    b = (d.get("blobs") or {}).get("file")
    if not b:
        raise HTTPException(404, "the file was not sent with it")
    blob = await _blob_get(b["id"])

    async def taken(n):
        return bool(await dst[files.COLL].find_one({"name": n, "folder": {"$in": ["", None]}}, {"_id": 1}))
    orig = data.get("name") or d["label"]
    stem, dot, ext = orig.rpartition(".")
    if not dot or not stem:
        stem, ext = orig, ""
    tail = "." + ext if ext else ""

    async def taken_stem(st):
        return await taken(st + tail)
    name = await _free(taken_stem, stem) + tail
    try:
        doc = await files.put(dst, name, blob, data.get("content_type"), {}, by, note=f"sent by {from_who}")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"id": doc["_id"], "label": doc["name"], "folder": doc.get("folder") or ""}


async def _add_product(dst, d, by, from_who):
    from . import manufacturers as mf
    data = d.get("data") or {}
    p, maker = dict(data.get("product") or {}), data.get("maker") or {}
    # Into my maker of the same site, or a new one for it (not explored).
    have = await dst[mf.COLL].find_one({"domain": maker.get("domain")}) if maker.get("domain") else None
    if not have:
        try:
            have = await mf.create(dst, maker.get("url") or ("https://" + (maker.get("domain") or "example.com")),
                                   maker.get("name") or "", by=by)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    prods = list(have.get("products") or [])
    key = mf.product_key(p)
    same = next((x for x in prods if mf.product_key(x) == key), None)
    if same:
        return {"id": f"{have['_id']}:{same.get('id')}", "label": same.get("name"), "maker": have["_id"], "already": True}
    if any(str(x.get("id")) == str(p.get("id")) for x in prods):
        p["id"] = secrets.token_hex(4)
    prods.append(p)
    await dst[mf.COLL].update_one({"_id": have["_id"]}, {"$set": {"products": prods, "updated_at": _now()}})
    return {"id": f"{have['_id']}:{p.get('id')}", "label": p.get("name"), "maker": have["_id"]}


async def _add_model(dst, d, by, from_who):
    """Its source under its own name - or a free one beside it - and the
    models it imports that I do not have, under theirs (so its imports
    still work). Built here afresh."""
    from . import store
    data = d.get("data") or {}
    ref, sources = data.get("id") or d["label"], data.get("models") or {}
    if ref not in sources:
        raise HTTPException(404, "its source was not sent with it")

    async def taken(n):
        return bool(await dst["models"].find_one({"_id": n}, {"_id": 1}))
    target = await _free(taken, ref, "_")
    made, kept = [], []
    for mid, x in sources.items():
        to = target if mid == ref else mid
        if mid != ref and await taken(mid):
            kept.append(mid)
            continue
        try:
            await store.save_model(dst, to, x.get("source") or "")
        except Exception as exc:                       # noqa: BLE001 - said, with what was made so far
            raise HTTPException(400, f"could not add {mid}: {exc}") from exc
        made.append(to)
    return {"id": target, "label": data.get("title") or target, "models": made, "kept": kept}


_ADD = {"taste": _add_taste, "note": _add_note, "inventory": _add_inventory, "file": _add_file,
        "product": _add_product, "model": _add_model}


@router.post("/items/{sid}/unshare")
async def unshare(sid: str) -> dict:
    """The sender takes a sent thing back: the line stays, the snapshot goes."""
    who, d = await _snap(sid)
    if (d.get("by") or {}).get("id") != who["id"]:
        raise HTTPException(403, "only whoever sent it can take it back")
    m = await _raw()[MSGS].find_one({"_id": d["msg"]})
    await _drop_snap(sid)
    if m:
        items = [{**it, "revoked": True} if it.get("snap") == sid else it for it in m.get("items") or []]
        await _raw()[MSGS].update_one({"_id": m["_id"]}, {"$set": {"items": items}})
        doc = await _raw()[CHATS].find_one({"_id": m["chat"]})
        m = {**m, "items": items}
        await _tell(doc, lambda sp: {"type": "edit", "chat": doc["_id"], "message": line(m, sp)})
    return {"unshared": sid}


# ---- indexes ----------------------------------------------------------------

async def ensure_indexes(raw) -> None:
    await raw[CHATS].create_index("members")
    await raw[CHATS].create_index("pair", unique=True, partialFilterExpression={"pair": {"$type": "string"}})
    await raw[MSGS].create_index([("chat", 1), ("at", -1)])
    await raw[ITEMS].create_index("msg")
    await raw[BLOBS].create_index([("blob", 1), ("i", 1)])
