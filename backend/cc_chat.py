"""The Command Code room: people talking with a model, in the open.

A conversation belongs to the workspace, not to whoever started it: anyone
there can read it and add to it, and each line says who wrote it. The
answer is streamed as it is written (server-sent events) and kept when it
is done - or as far as it got, if someone pressed stop. A conversation
remembers its model; it starts with the one chosen for the "chat" job in
Preferences > LLM settings (backend/llm.py), and can be switched at any
line.

A conversation can be pinned (it stays on top of the list) and archived
(it leaves the list for the "Archived" filter). A line can be deleted, the
last line of one's own edited and sent again (everything after it goes),
and the last answer written again, with the same model or another. Who may
drop what: one's own lines, and the answers to them, always; anyone else's
only with the "delete" right - as deleting a conversation.

The first answer names the conversation: the "summary" job's model is
asked for a short title, and the first line, cut short, is the fallback.
Only while the title is still the default one.

A deleted conversation goes to the trash, not away: it is marked
(`deleted_at`, `deleted_by`) and left out of everything else - the list,
the search, reading it, talking in it - and can be brought back for
TRASH_DAYS days. After that the database drops it by itself (a TTL index
that holds only the trashed ones, see `ensure_indexes`). "Delete forever"
and "Empty trash" drop it at once. Who may: as deleting - one's own
always, anyone else's only with the "delete" right.

A line can carry @-mentions (backend/cc_context.py): models, boards, files,
notes, drawn notes and parts, read through the workspace and handed to the
model as a bounded context block that stays on the line (`context`, never
sent to the page - the chips are, as `mentions`).

Everyone with a conversation open sees an answer as it is written, not
only the one who asked: GET /chats/{id}/live is a server-sent stream fed
by the request writing the answer (`HUB`).

Search (GET /search) reads every line, not only the titles, through a text
index (`ensure_search_index`), and answers with the line it found, a
snippet and where the words are in it.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import access, actors, cc_context, llm, scope

router = APIRouter(prefix="/api/cc")

COLL = "cc_chats"
MAX_MESSAGES = 400               # in one conversation
CONTEXT_CHARS = 400_000          # history sent with a new line, newest kept
MAX_ANSWER = 16_000              # tokens
DEFAULT_TITLE = "New conversation"
TITLE_WORDS = 6
TITLE_CHARS = 60
TITLE_TIMEOUT = 20.0             # seconds the summary model gets to name it
MAX_BULK = 200
TRASH_DAYS = 30                  # a deleted conversation can be restored for this long
TRASH_TTL = "cc_trash_ttl"       # the index that drops it afterwards
# Mongo's {field: None} matches a missing field, too: every conversation
# kept before there was a trash is a live one.
LIVE = {"deleted_at": None}
TRASHED = {"deleted_at": {"$ne": None}}
CHAT_CONTEXT = 4_000_000         # characters of mentioned context one conversation may hold

SYSTEM = (
    "You are a helpful assistant in Redline Studio, a workshop app for 3D CAD models, "
    "circuit boards. Several people may share this conversation; a line "
    "written by someone is prefixed with their name in brackets when there is more than "
    "one of them. Answer in the language you are asked in. Use Markdown where it helps."
)

TITLE_PROMPT = (
    "Write a title for a conversation that begins with the message below. At most "
    f"{TITLE_WORDS} words, in the language of the message. Reply with the title only: "
    "no quotes, no Markdown, no full stop at the end."
)


def _db():
    from .main import db
    return db()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc(v) -> datetime | None:
    """A stored time as an aware UTC datetime (Mongo hands back naive UTC)."""
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return None
    if not isinstance(v, datetime):
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def purge_at(doc: dict) -> datetime | None:
    """When a trashed conversation is dropped for good."""
    at = _utc(doc.get("deleted_at"))
    return at + timedelta(days=TRASH_DAYS) if at else None


def _mid() -> str:
    return secrets.token_hex(5)


def _out(doc: dict, full: bool = True) -> dict:
    o = {k: v for k, v in doc.items() if k not in ("_id", "workspace_id", "messages")}
    o["id"] = doc["_id"]
    o["pinned"] = bool(doc.get("pinned"))
    o["archived"] = bool(doc.get("archived"))
    gone = purge_at(doc)
    if gone:
        o["deleted_at"] = _utc(doc["deleted_at"]).isoformat()
        o["purge_at"] = gone.isoformat()
        # Whole days left, counted up: "deletes for good in 30 days" on the day.
        left = (gone - datetime.now(timezone.utc)).total_seconds() / 86400
        o["days_left"] = max(0, int(-(-left // 1)))
    else:
        o.pop("deleted_at", None)
        o.pop("deleted_by", None)
    msgs = doc.get("messages") or []
    o["count"] = len(msgs)
    if full:
        o["messages"] = [public(m) for m in msgs]
    elif msgs:
        last = msgs[-1]
        o["last"] = {"role": last["role"], "text": (last.get("content") or "")[:140],
                     "by": (last.get("by") or {}).get("name")}
    return o


def public(m: dict) -> dict:
    """A line as the page gets it: the context block its mentions were
    expanded into stays here; its size goes instead."""
    if "context" not in m and "attach" not in m:
        return m
    o = {k: v for k, v in m.items() if k not in ("context", "attach")}
    o["context_chars"] = len(m.get("context") or "")
    return o


def history(msgs: list[dict], images: list[dict] | None = None) -> list[dict]:
    """What the model is sent: the system line, then the conversation -
    newest first until the budget, then put back in order. Names on the
    people's lines once there is more than one person; a line's mentions,
    as their context block, before it. `images` (OpenAI image parts) go
    with the last line."""
    people = {(m.get("by") or {}).get("id") for m in msgs if m["role"] == "user"}
    named = len(people) > 1
    out: list[dict] = []
    used = 0
    for m in reversed(msgs):
        if not (m.get("content") or "").strip():
            continue                                   # failed, or stopped before a word
        text = m.get("content") or ""
        if named and m["role"] == "user":
            text = f"[{(m.get('by') or {}).get('name') or 'someone'}] {text}"
        if m["role"] == "user" and m.get("context"):
            text = m["context"] + "\n\n" + text
        used += len(text)
        if used > CONTEXT_CHARS and out:
            break
        out.append({"role": m["role"], "content": text})
    # The API wants the turns to alternate and to start with the person;
    # two lines in a row from people (two people, or an answer that failed)
    # are joined into one.
    merged: list[dict] = []
    for m in reversed(out):
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n\n" + m["content"]
        else:
            merged.append(dict(m))
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    if images and merged and merged[-1]["role"] == "user":
        merged[-1]["content"] = [{"type": "text", "text": merged[-1]["content"]}, *images]
    return [{"role": "system", "content": SYSTEM}] + merged


# ---- lines: finding them, and whose they are -------------------------------

def find(msgs: list[dict], ref: str) -> int:
    """A line by its id; a line kept before lines had ids, by its place.
    -1 when there is no such line."""
    for i, m in enumerate(msgs):
        if m.get("id") == ref:
            return i
    if ref.isdigit() and int(ref) < len(msgs) and not msgs[int(ref)].get("id"):
        return int(ref)
    return -1


def owners(msgs: list[dict]) -> list[str | None]:
    """Whose each line is: a person's line is theirs, an answer belongs to
    whoever asked the question it answers."""
    out: list[str | None] = []
    asker: str | None = None
    for m in msgs:
        if m["role"] == "user":
            asker = (m.get("by") or {}).get("id")
            out.append(asker)
        else:
            out.append(asker)
    return out


def may_drop(msgs: list[dict], idx: list[int], me: str | None, can_delete: bool) -> bool:
    """Lines at `idx` may go: all of them are mine, or I may delete."""
    if can_delete:
        return True
    own = owners(msgs)
    return all(own[i] == me for i in idx)


def with_ids(msgs: list[dict]) -> tuple[list[dict], bool]:
    """Every line with an id - the ones kept before there were ids get one.
    Says whether any was given."""
    changed = False
    out = []
    for m in msgs:
        if not m.get("id"):
            m = {**m, "id": _mid()}
            changed = True
        out.append(m)
    return out, changed


def regen_cut(msgs: list[dict]) -> int:
    """Where the conversation is cut to answer its last question again:
    after the last person's line (the answers after it go)."""
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i]["role"] == "user":
            return i + 1
    return -1


def clean_title(raw: str) -> str:
    """The summary model's answer as a title: one line, no quotes or
    Markdown, at most TITLE_WORDS words."""
    line = next((ln for ln in (raw or "").splitlines() if ln.strip()), "")
    line = re.sub(r"^\s*(title|başlık)\s*:\s*", "", line, flags=re.I)
    line = line.strip().strip("#*_`\"'“”‘’«» ").rstrip(".。!").strip()
    words = line.split()
    return " ".join(words[:TITLE_WORDS])[:TITLE_CHARS].strip()


def fallback_title(text: str) -> str:
    return " ".join((text or "").split())[:TITLE_CHARS] or DEFAULT_TITLE


async def make_title(first: str, answer: str = "") -> tuple[str, dict]:
    """A short title from the summary model, or the first line cut short.
    Returns the title and what the call used (empty when there was none)."""
    prov, model = llm.route("summary")
    if first.strip() and llm.key(prov):
        try:
            prompt = first[:2000] + (f"\n\n(The answer began: {answer[:600]})" if answer else "")
            d = await asyncio.wait_for(llm.complete(
                [{"role": "system", "content": TITLE_PROMPT}, {"role": "user", "content": prompt}],
                job="summary", max_tokens=40, temperature=0.2), TITLE_TIMEOUT)
            got = clean_title(((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
            if got:
                return got, {**(d.get("usage") or {}), "provider": d.get("provider") or prov,
                             "model": d.get("model") or model}
        except Exception:                              # noqa: BLE001 - the fallback is fine
            pass
    return fallback_title(first), {}


# ---- the trash: kept TRASH_DAYS days, then dropped by the database -----------

async def ensure_indexes(raw) -> None:
    """The index that empties the trash: a TTL on `deleted_at` that holds
    only the trashed conversations (a partial index - the live ones have no
    `deleted_at` and are never in it). One for the collection, so for every
    workspace alike: the time is all it asks. Safe to call at every start;
    one left with other options (another TTL) is replaced."""
    coll = raw[COLL]
    spec = {"name": TRASH_TTL, "expireAfterSeconds": TRASH_DAYS * 86400,
            "partialFilterExpression": {"deleted_at": {"$type": "date"}}}
    try:
        await coll.create_index([("deleted_at", 1)], **spec)
    except Exception as exc:                           # noqa: BLE001
        if getattr(exc, "code", None) not in (85, 86):  # IndexOptionsConflict, IndexKeySpecsConflict
            raise
        for old in (TRASH_TTL, [("deleted_at", 1)]):
            try:
                await coll.drop_index(old)
            except Exception:                          # noqa: BLE001 - not there by that name
                pass
        await coll.create_index([("deleted_at", 1)], **spec)


SEARCH_INDEX = "cc_text"         # the titles and every line, for GET /search


async def ensure_search_index(raw) -> None:
    """The text index search reads: the titles (weighted up) and every
    line's text - never the mentioned context, which is the workspace's
    things, not the conversation. No stemming ("none"): the room speaks
    Turkish and English in one breath. One for the collection, like the
    trash's: the workspace is in every query (backend/scope.py), as are
    the trash and the archive. A collection has one text index at most, so
    one made with other fields or options is replaced. Safe at every start."""
    coll = raw[COLL]
    keys = [("title", "text"), ("messages.content", "text")]
    spec = {"name": SEARCH_INDEX, "weights": {"title": 5, "messages.content": 1}, "default_language": "none"}
    try:
        await coll.create_index(keys, **spec)
    except Exception as exc:                           # noqa: BLE001
        if getattr(exc, "code", None) not in (85, 86):  # IndexOptionsConflict, IndexKeySpecsConflict
            raise
        info = await coll.index_information()
        for name, ix in info.items():
            if name == SEARCH_INDEX or any(k == "_fts" for k, _ in ix.get("key") or []):
                await coll.drop_index(name)
        await coll.create_index(keys, **spec)


def _gone_by() -> dict:
    who = actors.current() or {}
    return {"id": who.get("id"), "name": who.get("name"), "type": who.get("type")}


async def _trash(db, cid: str) -> bool:
    """Into the trash; False when it was not (any more) a live one."""
    res = await db[COLL].update_one({"_id": cid, **LIVE},
                                    {"$set": {"deleted_at": datetime.now(timezone.utc), "deleted_by": _gone_by()}})
    return bool(getattr(res, "matched_count", 1))


# ---- conversations ----------------------------------------------------------

@router.get("/chats")
async def list_chats(q: str = "", archived: str = "0", trash: str = "0") -> list[dict]:
    """`archived`: 0 (default) leaves the archived ones out, 1 is only
    them, all is both. `trash=1` is the trash instead - archived or not,
    newest deleted first - and nothing else ever shows a trashed one."""
    in_trash = trash in ("1", "true")
    query: dict = dict(TRASHED if in_trash else LIVE)
    if q:
        query["$or"] = [{"title": {"$regex": re.escape(q), "$options": "i"}},
                        {"messages.content": {"$regex": re.escape(q), "$options": "i"}}]
    if not in_trash and archived in ("1", "true"):
        query["archived"] = True
    elif not in_trash and archived != "all":
        query["archived"] = {"$ne": True}
    order = [("deleted_at", -1)] if in_trash else [("pinned", -1), ("updated_at", -1)]
    cur = _db()[COLL].find(query, {"messages": {"$slice": -1}}).sort(order).limit(300)
    rows = [d async for d in cur]
    if in_trash:
        # The TTL monitor runs once a minute or so: past its day, it is gone.
        now = datetime.now(timezone.utc)
        rows = [d for d in rows if (purge_at(d) or now) > now]
    # $slice keeps the last one; the count needs the length.
    counts = {d["_id"]: d["n"] async for d in _db()[COLL].aggregate(
        [{"$project": {"n": {"$size": {"$ifNull": ["$messages", []]}}}}])}
    out = []
    for d in rows:
        o = _out(d, full=False)
        o["count"] = counts.get(d["_id"], o["count"])
        out.append(o)
    return out


SNIPPET = 200                    # characters of a line around what was found
PER_CHAT = 3                     # lines shown from one conversation


def terms(q: str) -> list[str]:
    """The words a search looks for, as the text index splits them: quoted
    phrases kept whole, "-word" (left out by the index) not highlighted."""
    out: list[str] = []
    for phrase, word in re.findall(r'"([^"]+)"|(\S+)', q):
        t = (phrase or word).strip().lower()
        if t and not t.startswith("-"):
            t = t.strip(".,;:!?()[]{}'\"")
            if t and t not in out:
                out.append(t)
    return out


def snippet(text: str, words: list[str], width: int = SNIPPET) -> tuple[str, list[list[int]]] | None:
    """The part of a line around the first word found, and where every word
    found is in it ([start, end] in the snippet). None when none is in it."""
    flat = " ".join((text or "").split())
    low = flat.lower()
    found = [(m.start(), m.end()) for w in words for m in re.finditer(re.escape(w), low)]
    if not found:
        return None
    found.sort()
    first = found[0][0]
    start = max(0, min(first - width // 3, len(flat) - width))
    end = min(len(flat), start + width)
    pre = "…" if start > 0 else ""
    post = "…" if end < len(flat) else ""
    hits = [[s - start + len(pre), e - start + len(pre)] for s, e in found if s >= start and e <= end]
    return pre + flat[start:end] + post, hits


@router.get("/search")
async def search(q: str = "", archived: str = "0", trash: str = "0", limit: int = 30) -> dict:
    """Every conversation's title and lines, through the text index: the
    lines found (up to PER_CHAT a conversation), each with its time, a
    snippet and where the words are in it. `archived` and `trash` as for
    the list: 0 leaves the archived out, all takes them too; trash=1 looks
    only in the trash. Without the index (not made yet) it reads them all."""
    q = q.strip()[:200]
    words = terms(q)
    if not words:
        return {"q": q, "how": "none", "results": []}
    in_trash = trash in ("1", "true")
    query: dict = dict(TRASHED if in_trash else LIVE)
    if not in_trash and archived in ("1", "true"):
        query["archived"] = True
    elif not in_trash and archived != "all":
        query["archived"] = {"$ne": True}
    limit = max(1, min(limit, 100))
    fields = {"title": 1, "messages.id": 1, "messages.role": 1, "messages.content": 1, "messages.at": 1,
              "messages.by": 1, "archived": 1, "pinned": 1, "updated_at": 1, "deleted_at": 1}
    coll = _db()[COLL]
    how = "index"
    try:
        cur = coll.find({**query, "$text": {"$search": q}}, {**fields, "score": {"$meta": "textScore"}}) \
            .sort([("score", {"$meta": "textScore"})]).limit(limit)
        rows = [d async for d in cur]
    except Exception as exc:                           # noqa: BLE001
        if getattr(exc, "code", None) != 27:            # IndexNotFound: read them all instead
            raise
        how = "scan"
        rx = "|".join(re.escape(w) for w in words)
        query["$or"] = [{"title": {"$regex": rx, "$options": "i"}},
                        {"messages.content": {"$regex": rx, "$options": "i"}}]
        cur = coll.find(query, fields).sort([("updated_at", -1)]).limit(limit)
        rows = [d async for d in cur]
    results: list[dict] = []
    for d in rows:
        chat = {"chat_id": d["_id"], "title": d.get("title") or DEFAULT_TITLE, "archived": bool(d.get("archived")),
                "pinned": bool(d.get("pinned")), "score": round(d.get("score") or 0, 3),
                "trashed": bool(d.get("deleted_at"))}
        shown = 0
        for m in reversed(d.get("messages") or []):    # newest first
            got = snippet(m.get("content") or "", words)
            if not got:
                continue
            results.append({**chat, "message_id": m.get("id"), "role": m.get("role"), "at": m.get("at"),
                            "by": (m.get("by") or {}).get("name"), "snippet": got[0], "hits": got[1]})
            shown += 1
            if shown >= PER_CHAT:
                break
        if not shown:
            got = snippet(chat["title"], words) or (chat["title"], [])
            results.append({**chat, "message_id": None, "role": None, "at": d.get("updated_at"), "by": None,
                            "snippet": got[0], "hits": got[1]})
    return {"q": q, "how": how, "results": results}


@router.get("/mentions")
async def mentions(q: str = "", kind: str = "", limit: int = 40) -> list[dict]:
    """What `@` offers in the composer: models, boards, files, notes, drawn
    notes and parts matching `q` - this workspace's, for whoever may look."""
    return await cc_context.candidates(_db(), q[:200], kind, max(1, min(limit, 100)))


class ChatIn(BaseModel):
    title: str = Field(default="", max_length=120)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)


@router.post("/chats")
async def create_chat(body: ChatIn) -> dict:
    prov, model = llm.route("chat")
    if body.provider:
        if body.provider not in llm.PROVIDERS:
            raise HTTPException(400, f"unknown provider {body.provider!r}")
        if body.provider != prov and not body.model:
            # another provider and no model named: its cheap one, or a choice
            if body.provider != llm.CHEAP[0]:
                raise HTTPException(400, f"choose a {llm.PROVIDERS[body.provider]['name']} model")
            model = llm.CHEAP[1]
        prov = body.provider
    model = body.model or model
    now = _now()
    doc = {"_id": secrets.token_hex(6), "title": body.title.strip() or DEFAULT_TITLE,
           "provider": prov, "model": model, "by": actors.current(),
           "created_at": now, "updated_at": now, "messages": []}
    await _db()[COLL].insert_one(doc)
    return _out(doc)


class BulkIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=MAX_BULK)
    # Dropped at once instead of going to the trash (from the trash).
    forever: bool = False


def _mine(doc: dict) -> bool:
    return (doc.get("by") or {}).get("id") == actors.current().get("id")


def _can_delete() -> bool:
    return access.allowed(access.current(), "delete")


@router.post("/chats/bulk-delete")
async def bulk_delete(body: BulkIn) -> dict:
    """Several conversations at once: each one as DELETE /chats/{id} would -
    one's own always, anyone else's only with the "delete" right. The ones
    refused are named, the rest go - to the trash, or with `forever` (from
    the trash) for good."""
    db = _db()
    deleted: list[str] = []
    refused: list[str] = []
    missing: list[str] = []
    can = _can_delete()
    for cid in dict.fromkeys(body.ids):
        doc = await db[COLL].find_one({"_id": cid} if body.forever else {"_id": cid, **LIVE}, {"by": 1, "title": 1})
        if not doc:
            missing.append(cid)
        elif not _mine(doc) and not can:
            refused.append(cid)
        else:
            if body.forever:
                await db[COLL].delete_one({"_id": cid})
            elif not await _trash(db, cid):
                missing.append(cid)
                continue
            deleted.append(cid)
            # A POST is not in the trail by itself; a delete must be.
            await actors.audit(db, "delete", f"/api/cc/chats/{cid}",
                               {"how": "bulk", "title": doc.get("title"),
                                **({"forever": True} if body.forever else {"trash": True})})
    return {"deleted": deleted, "refused": refused, "missing": missing}


async def _restore(db, cid: str) -> str:
    """"restored", "refused" or "missing"."""
    doc = await db[COLL].find_one({"_id": cid, **TRASHED}, {"by": 1, "title": 1})
    if not doc:
        return "missing"
    if not _mine(doc) and not _can_delete():
        return "refused"
    res = await db[COLL].update_one({"_id": cid, **TRASHED}, {"$unset": {"deleted_at": "", "deleted_by": ""}})
    if not getattr(res, "matched_count", 1):
        return "missing"
    await actors.audit(db, "restore", f"/api/cc/chats/{cid}", {"title": doc.get("title")})
    return "restored"


@router.post("/chats/bulk-restore")
async def bulk_restore(body: BulkIn) -> dict:
    """Several out of the trash at once, as POST /chats/{id}/restore would."""
    db = _db()
    out: dict[str, list[str]] = {"restored": [], "refused": [], "missing": []}
    for cid in dict.fromkeys(body.ids):
        out[await _restore(db, cid)].append(cid)
    return out


@router.post("/chats/empty-trash")
async def empty_trash() -> dict:
    """Everything in the trash dropped for good - with the "delete" right;
    without it, one's own only (the rest stay, counted in `kept`)."""
    db = _db()
    can = _can_delete()
    mine, kept = [], 0
    async for d in db[COLL].find(TRASHED, {"by": 1}):
        if can or _mine(d):
            mine.append(d["_id"])
        else:
            kept += 1
    n = 0
    if mine:
        res = await db[COLL].delete_many({"_id": {"$in": mine}, **TRASHED})
        n = getattr(res, "deleted_count", len(mine))
        await actors.audit(db, "delete", "/api/cc/chats/empty-trash", {"how": "empty-trash", "count": n})
    return {"deleted": n, "kept": kept}


@router.get("/chats/{cid}")
async def get_chat(cid: str) -> dict:
    db = _db()
    doc = await db[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, cid)
    msgs = doc.get("messages") or []
    # Lines kept before lines had ids get one, once, so they can be named.
    fixed, changed = with_ids(msgs)
    if changed:
        res = await db[COLL].update_one({"_id": cid, "messages": {"$size": len(msgs)}},
                                        {"$set": {"messages": fixed}})
        if getattr(res, "matched_count", 1):
            doc["messages"] = fixed
    return _out(doc)


class ChatPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None
    archived: bool | None = None


@router.patch("/chats/{cid}")
async def patch_chat(cid: str, body: ChatPatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "provider" in patch and patch["provider"] not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {patch['provider']!r}")
    if "title" in patch:
        patch["title"] = patch["title"].strip() or DEFAULT_TITLE
    if patch:
        res = await _db()[COLL].update_one({"_id": cid, **LIVE}, {"$set": patch})
        if not getattr(res, "matched_count", 1):
            raise HTTPException(404, cid)
    return await get_chat(cid)


@router.delete("/chats/{cid}")
async def delete_chat(cid: str, forever: str = "0") -> dict:
    """Into the trash; `forever=1` drops it for good (from the trash, or
    straight away). The trail has it as every DELETE (main.py)."""
    db = _db()
    for_good = forever in ("1", "true")
    doc = await db[COLL].find_one({"_id": cid} if for_good else {"_id": cid, **LIVE}, {"by": 1})
    if not doc:
        raise HTTPException(404, cid)
    # Your own, always; someone else's, only if you may delete (as notes).
    if not _mine(doc) and not _can_delete():
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    if for_good:
        await db[COLL].delete_one({"_id": cid})
        return {"deleted": cid, "forever": True}
    if not await _trash(db, cid):
        raise HTTPException(404, cid)
    return {"deleted": cid, "trash": True, "days": TRASH_DAYS}


@router.post("/chats/{cid}/restore")
async def restore_chat(cid: str) -> dict:
    """Out of the trash, as it was (pinned, archived, every line)."""
    got = await _restore(_db(), cid)
    if got == "missing":
        raise HTTPException(404, f"{cid} is not in the trash")
    if got == "refused":
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    return await get_chat(cid)


@router.delete("/chats/{cid}/messages/{ref}")
async def delete_message(cid: str, ref: str) -> dict:
    """One line out of a conversation: one's own (or an answer to it)
    always, anyone else's only with the "delete" right."""
    db = _db()
    doc = await db[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, cid)
    msgs = doc.get("messages") or []
    i = find(msgs, ref)
    if i < 0:
        raise HTTPException(404, f"no line {ref!r} in this conversation")
    if not may_drop(msgs, [i], actors.current().get("id"), _can_delete()):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    if msgs[i].get("id"):
        await db[COLL].update_one({"_id": cid}, {"$pull": {"messages": {"id": msgs[i]["id"]}}})
    else:
        rest = msgs[:i] + msgs[i + 1:]
        res = await db[COLL].update_one({"_id": cid, "messages": {"$size": len(msgs)}},
                                        {"$set": {"messages": rest}})
        if not getattr(res, "matched_count", 1):
            raise HTTPException(409, "the conversation changed meanwhile - try again")
    return await get_chat(cid)


# ---- talking ----------------------------------------------------------------

class MentionIn(BaseModel):
    kind: str = Field(max_length=20)
    id: str = Field(min_length=1, max_length=300)


class SayIn(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)
    # Edit: this line (one's own) is replaced by `text`, and everything
    # after it goes before the answer is written again.
    edit: str | None = Field(default=None, max_length=40)
    # @-mentions: read here, through the workspace (backend/cc_context.py).
    mentions: list[MentionIn] = Field(default_factory=list, max_length=cc_context.MAX_MENTIONS)
    # The page that asked, so it can tell its own answer from someone
    # else's on the live stream.
    client: str | None = Field(default=None, max_length=40)


class RegenIn(BaseModel):
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)
    client: str | None = Field(default=None, max_length=40)


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


async def _load(cid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, cid)
    return doc


def _pick(doc: dict, provider: str | None, model: str | None) -> tuple[str, str]:
    provider = provider or doc.get("provider") or llm.route("chat")[0]
    if provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {provider!r}")
    if not model:
        # The conversation's own model, or the chat job's, only on their own
        # provider; else the cheap one. Never a dearer model nobody chose.
        jp, jm = llm.route("chat")
        if provider == (doc.get("provider") or jp) and doc.get("model"):
            model = doc["model"]
        elif provider == jp:
            model = jm
        elif provider == llm.CHEAP[0]:
            model = llm.CHEAP[1]
        else:
            raise HTTPException(400, f"choose a {llm.PROVIDERS[provider]['name']} model")
    if not llm.key(provider):
        raise HTTPException(503, llm.no_key(provider, "chat"))
    return provider, model


async def _cut(db, cid: str, msgs: list[dict], keep: int, tail: list[dict], sets: dict) -> None:
    """The conversation becomes msgs[:keep] + tail - only if nobody added a
    line meanwhile (otherwise 409, and nothing changed)."""
    res = await db[COLL].update_one({"_id": cid, "messages": {"$size": len(msgs)}},
                                    {"$set": {"messages": msgs[:keep] + tail, **sets}})
    if not getattr(res, "matched_count", 1):
        raise HTTPException(409, "the conversation changed meanwhile - read it again and retry")


# ---- watching an answer being written --------------------------------------

class Hub:
    """Who is watching which conversation, and the answers being written in
    it. One per API process (the room runs in one): the request writing an
    answer publishes each piece here, and every page with the conversation
    open has a queue on GET /chats/{id}/live that the pieces are copied to.
    A page that cannot keep up (its queue full) is let go - it reconnects
    and starts again from the state, which holds the answer so far."""

    QUEUE = 2000

    def __init__(self):
        self.subs: dict[str, set[asyncio.Queue]] = {}
        self.live: dict[str, dict[str, dict]] = {}     # key -> gen -> state

    def subscribe(self, key: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(self.QUEUE)
        self.subs.setdefault(key, set()).add(q)
        return q

    def unsubscribe(self, key: str, q: asyncio.Queue) -> None:
        got = self.subs.get(key)
        if got is not None:
            got.discard(q)
            if not got:
                self.subs.pop(key, None)

    def watchers(self, key: str) -> int:
        return len(self.subs.get(key) or ())

    def publish(self, key: str, ev: dict) -> None:
        for q in list(self.subs.get(key) or ()):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                self.unsubscribe(key, q)
                try:
                    q.get_nowait()                     # room for the goodbye
                    q.put_nowait(None)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def snapshot(self, key: str) -> list[dict]:
        return [dict(v) for v in (self.live.get(key) or {}).values()]

    def busy(self, key: str) -> bool:
        return bool(self.live.get(key))

    def begin(self, key: str, state: dict) -> None:
        self.live.setdefault(key, {})[state["gen"]] = state
        self.publish(key, {"type": "start", **state})

    def piece(self, key: str, gen: str, kind: str, text: str) -> None:
        st = (self.live.get(key) or {}).get(gen)
        if st is not None:
            if kind == "text":
                st["text"] += text
            else:
                st["thinking"] = (st["thinking"] + text)[-4000:]
        self.publish(key, {"type": kind, "gen": gen, "text": text})

    def end(self, key: str, gen: str, ev: dict) -> None:
        got = self.live.get(key) or {}
        got.pop(gen, None)
        if not got:
            self.live.pop(key, None)
        self.publish(key, {**ev, "gen": gen})
        self.publish(key, {"type": "end", "gen": gen})


HUB = Hub()
LIVE_PING = 10.0                 # seconds between keep-alive comments (the page gives up after 25 s of nothing)
LIVE_MAX = 300.0                 # an idle stream is closed (and reopened by the page) after this


def live_key(cid: str) -> str:
    return f"{scope.current()}:{cid}"


@router.get("/chats/{cid}/live")
async def live(cid: str, request: Request):
    """The answers being written in this conversation, as they are written,
    for everyone who has it open. Events: {type: hello, live: [...]} first
    (the answers already under way, as far as they got), then start, text,
    thinking, done, error, end and title, each with the `gen` it belongs
    to. Closed after LIVE_MAX seconds with nothing under way ({type: bye});
    the page opens it again."""
    await _load(cid)                                   # this workspace's, and not in the trash
    key = live_key(cid)
    q = HUB.subscribe(key)

    async def events():
        try:
            yield _sse({"type": "hello", "live": HUB.snapshot(key), "watchers": HUB.watchers(key)})
            opened = time.monotonic()
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), LIVE_PING)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        return
                    if time.monotonic() - opened > LIVE_MAX and not HUB.busy(key):
                        yield _sse({"type": "bye"})
                        return
                    yield b": ping\n\n"
                    continue
                if ev is None:                         # let go: too slow
                    yield _sse({"type": "bye", "why": "behind"})
                    return
                yield _sse(ev)
        finally:
            HUB.unsubscribe(key, q)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _stream(db, doc: dict, msgs: list[dict], provider: str, model: str, first: dict,
            key: str | None = None, client: str | None = None, images: list[dict] | None = None) -> StreamingResponse:
    """Write the answer to `msgs` and keep it. Events: the first one
    ({type: user, message, keep, gen}: the conversation is its first `keep`
    lines, then `message` if any), then thinking|text|error, done, and a
    title when the conversation was named by this answer. The same goes to
    everyone watching the conversation (`HUB`, under `key`)."""
    cid = doc["_id"]
    want_title = doc.get("title") in ("", DEFAULT_TITLE, None)
    key = key or live_key(cid)
    gen = _mid()
    who = actors.current() or {}
    first = dict(first)
    if first.get("message"):
        first["message"] = public(first["message"])

    async def events():
        HUB.begin(key, {"gen": gen, "client": client, "by": {"id": who.get("id"), "name": who.get("name")},
                        "provider": provider, "model": model, "message": first.get("message"),
                        "keep": first.get("keep"), "text": "", "thinking": "", "at": _now()})
        yield _sse(first)
        answer = {"id": _mid(), "role": "assistant", "content": "", "at": _now(),
                  "provider": provider, "model": model}
        t0 = time.monotonic()
        thought = 0.0
        used: dict = {}
        try:
            first_text = None
            async for piece in llm.stream(history(msgs, images), provider=provider, model=model, max_tokens=MAX_ANSWER):
                if "thinking" in piece:
                    thought = time.monotonic() - t0
                    HUB.piece(key, gen, "thinking", piece["thinking"])
                    yield _sse({"type": "thinking", "text": piece["thinking"]})
                elif "text" in piece:
                    first_text = first_text or time.monotonic()
                    answer["content"] += piece["text"]
                    HUB.piece(key, gen, "text", piece["text"])
                    yield _sse({"type": "text", "text": piece["text"]})
                elif "usage" in piece:
                    used = piece["usage"] or {}
        except (asyncio.CancelledError, GeneratorExit):
            # Stop pressed (or the tab closed): kept as far as it got.
            answer["stopped"] = True
            raise
        except Exception as exc:                       # noqa: BLE001
            answer["error"] = str(exc)[:500]
            HUB.publish(key, {"type": "error", "gen": gen, "error": answer["error"]})
            yield _sse({"type": "error", "error": answer["error"]})
        finally:
            if answer.get("stopped") and not answer["content"]:
                answer["error"] = "stopped before the answer began"
            # Kept whatever happened: a stopped answer stays as far as it got.
            answer["ms"] = round((time.monotonic() - t0) * 1000)
            if thought:
                answer["thinking_ms"] = round(thought * 1000)
            answer["usage"] = {k: used.get(k) for k in ("prompt_tokens", "completion_tokens", "cost")}
            # Its own task, started before anything can be cancelled: a
            # closed tab does not leave the conversation unnamed.
            naming = asyncio.ensure_future(_name(db, cid, msgs, answer)) if want_title else None
            if naming:
                def told(f, key=key, gen=gen):
                    if not f.cancelled() and not f.exception() and f.result():
                        HUB.publish(key, {"type": "title", "gen": gen, "title": f.result()})
                naming.add_done_callback(told)

            async def keep():
                await db[COLL].update_one({"_id": cid}, {"$push": {"messages": answer},
                                                         "$set": {"updated_at": _now()}})
                if used:
                    await llm.record(db, provider=provider, model=model, surface="chat", kind="cc-chat", used=used)
            # Shielded: a closed tab cancels this generator, not the saving.
            try:
                await asyncio.shield(keep())
            finally:
                # Watchers hear it is done once it is kept, so a page that
                # reads the conversation then finds the answer in it.
                HUB.end(key, gen, {"type": "done", "message": answer})
        yield _sse({"type": "done", "message": answer})
        if naming:
            title = await asyncio.shield(naming)
            if title:
                yield _sse({"type": "title", "title": title})

    # X-Accel-Buffering: nginx (NPM) would otherwise hold the stream back
    # and hand it over in one piece at the end.
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _name(db, cid: str, msgs: list[dict], answer: dict) -> str | None:
    """Name the conversation after its first line, if nobody has yet."""
    first = next((m.get("content") or "" for m in msgs if m["role"] == "user"), "")
    if not first:
        return None
    title, used = await make_title(first, "" if answer.get("error") else answer.get("content") or "")
    # Only over the default: someone may have renamed it meanwhile.
    res = await db[COLL].update_one({"_id": cid, "title": {"$in": ["", DEFAULT_TITLE]}},
                                    {"$set": {"title": title}})
    if used:
        await llm.record(db, provider=used.pop("provider"), model=used.pop("model"),
                         surface="chat", kind="cc-title", used=used)
    return title if getattr(res, "matched_count", 1) else None


@router.post("/chats/{cid}/messages")
async def say(cid: str, body: SayIn):
    """Add a line (or, with `edit`, replace one's own line and drop what
    followed it) and stream the answer: events {type: user|thinking|text|
    done|error|title}."""
    db = _db()
    doc = await _load(cid)
    msgs = doc.get("messages") or []
    provider, model = _pick(doc, body.provider, body.model)
    who = actors.current()
    mine = {"id": _mid(), "role": "user", "content": body.text, "at": _now(),
            "by": {"id": who.get("id"), "name": who.get("name"), "type": who.get("type")}}
    sets: dict = {"updated_at": mine["at"], "provider": provider, "model": model}
    pics: list[dict] = []
    if body.mentions:
        # Read now, through this workspace: what cannot be seen is refused.
        context, chips, pics = await cc_context.expand(db, [m.model_dump() for m in body.mentions],
                                                       await _vision(provider, model))
        if context:
            held = sum(len(m.get("context") or "") for m in msgs)
            if held + len(context) > CHAT_CONTEXT:
                raise HTTPException(400, "this conversation holds too much mentioned context already - "
                                         "start a new one")
            mine.update({"context": context, "mentions": chips})
            if pics:
                mine["attach"] = pics

    if body.edit is not None:
        i = find(msgs, body.edit)
        if i < 0:
            raise HTTPException(404, f"no line {body.edit!r} in this conversation")
        if msgs[i]["role"] != "user" or (msgs[i].get("by") or {}).get("id") != who.get("id"):
            raise HTTPException(403, "only your own line can be edited")
        if not may_drop(msgs, list(range(i + 1, len(msgs))), who.get("id"), _can_delete()):
            raise HTTPException(403, "someone else wrote after this line - "
                                + access.refusal(access.current() or "nobody", "delete"))
        mine["edited_at"] = mine["at"]
        mine["at"] = msgs[i].get("at") or mine["at"]
        await _cut(db, cid, msgs, i, [mine], sets)
        keep = i
    else:
        if len(msgs) >= MAX_MESSAGES:
            raise HTTPException(400, f"this conversation has {MAX_MESSAGES} lines; start a new one")
        await db[COLL].update_one({"_id": cid}, {"$push": {"messages": mine}, "$set": sets})
        keep = len(msgs)
    convo = msgs[:keep] + [mine]
    images = await cc_context.images(db, pics) if pics else None
    return _stream(db, doc, convo, provider, model, {"type": "user", "message": mine, "keep": keep},
                   key=live_key(cid), client=body.client, images=images)


@router.post("/chats/{cid}/regenerate")
async def regenerate(cid: str, body: RegenIn | None = None):
    """Answer the last question again - with the conversation's model, or
    another one, which the conversation then keeps. The answers after the
    last question go; someone else's only with the "delete" right."""
    body = body or RegenIn()
    db = _db()
    doc = await _load(cid)
    msgs = doc.get("messages") or []
    keep = regen_cut(msgs)
    if keep < 0:
        raise HTTPException(400, "nothing to answer yet")
    provider, model = _pick(doc, body.provider, body.model)
    if not may_drop(msgs, list(range(keep, len(msgs))), actors.current().get("id"), _can_delete()):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    if keep < len(msgs) or body.provider or body.model:
        await _cut(db, cid, msgs, keep, [], {"updated_at": _now(), "provider": provider, "model": model})
    # The question's pictures go again, if this model reads them.
    pics = msgs[keep - 1].get("attach") or []
    images = await cc_context.images(db, pics) if pics and await _vision(provider, model) else None
    return _stream(db, doc, msgs[:keep], provider, model, {"type": "user", "message": None, "keep": keep},
                   key=live_key(cid), client=body.client, images=images)


async def _vision(provider: str, model: str) -> bool:
    """Whether the model reads images: its row in the provider's list, else
    its name (backend/llm.py `vision`)."""
    try:
        for m in await llm.models(provider):
            if m["id"] == model:
                return bool(m["vision"]) if "vision" in m else llm.vision(m)
    except Exception:                                  # noqa: BLE001 - the list is a nicety
        pass
    return llm.vision({"id": model})
