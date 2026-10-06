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
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import access, actors, llm

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

SYSTEM = (
    "You are a helpful assistant in Redline Studio, a workshop app for 3D CAD models, "
    "circuit boards and firmware. Several people may share this conversation; a line "
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


def _mid() -> str:
    return secrets.token_hex(5)


def _out(doc: dict, full: bool = True) -> dict:
    o = {k: v for k, v in doc.items() if k not in ("_id", "workspace_id", "messages")}
    o["id"] = doc["_id"]
    o["pinned"] = bool(doc.get("pinned"))
    o["archived"] = bool(doc.get("archived"))
    msgs = doc.get("messages") or []
    o["count"] = len(msgs)
    if full:
        o["messages"] = msgs
    elif msgs:
        last = msgs[-1]
        o["last"] = {"role": last["role"], "text": (last.get("content") or "")[:140],
                     "by": (last.get("by") or {}).get("name")}
    return o


def history(msgs: list[dict]) -> list[dict]:
    """What the model is sent: the system line, then the conversation -
    newest first until the budget, then put back in order. Names on the
    people's lines once there is more than one person."""
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


# ---- conversations ----------------------------------------------------------

@router.get("/chats")
async def list_chats(q: str = "", archived: str = "0") -> list[dict]:
    """`archived`: 0 (default) leaves the archived ones out, 1 is only
    them, all is both."""
    query: dict = {}
    if q:
        query = {"$or": [{"title": {"$regex": re.escape(q), "$options": "i"}},
                         {"messages.content": {"$regex": re.escape(q), "$options": "i"}}]}
    if archived in ("1", "true"):
        query["archived"] = True
    elif archived != "all":
        query["archived"] = {"$ne": True}
    cur = _db()[COLL].find(query, {"messages": {"$slice": -1}}).sort(
        [("pinned", -1), ("updated_at", -1)]).limit(300)
    rows = [d async for d in cur]
    # $slice keeps the last one; the count needs the length.
    counts = {d["_id"]: d["n"] async for d in _db()[COLL].aggregate(
        [{"$project": {"n": {"$size": {"$ifNull": ["$messages", []]}}}}])}
    out = []
    for d in rows:
        o = _out(d, full=False)
        o["count"] = counts.get(d["_id"], o["count"])
        out.append(o)
    return out


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


def _mine(doc: dict) -> bool:
    return (doc.get("by") or {}).get("id") == actors.current().get("id")


def _can_delete() -> bool:
    return access.allowed(access.current(), "delete")


@router.post("/chats/bulk-delete")
async def bulk_delete(body: BulkIn) -> dict:
    """Several conversations at once: each one as DELETE /chats/{id} would -
    one's own always, anyone else's only with the "delete" right. The ones
    refused are named, the rest go."""
    db = _db()
    deleted: list[str] = []
    refused: list[str] = []
    missing: list[str] = []
    can = _can_delete()
    for cid in dict.fromkeys(body.ids):
        doc = await db[COLL].find_one({"_id": cid}, {"by": 1, "title": 1})
        if not doc:
            missing.append(cid)
        elif not _mine(doc) and not can:
            refused.append(cid)
        else:
            await db[COLL].delete_one({"_id": cid})
            deleted.append(cid)
            # A POST is not in the trail by itself; a delete must be.
            await actors.audit(db, "delete", f"/api/cc/chats/{cid}", {"how": "bulk", "title": doc.get("title")})
    return {"deleted": deleted, "refused": refused, "missing": missing}


@router.get("/chats/{cid}")
async def get_chat(cid: str) -> dict:
    db = _db()
    doc = await db[COLL].find_one({"_id": cid})
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
        res = await _db()[COLL].update_one({"_id": cid}, {"$set": patch})
        if not getattr(res, "matched_count", 1):
            raise HTTPException(404, cid)
    return await get_chat(cid)


@router.delete("/chats/{cid}")
async def delete_chat(cid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": cid}, {"by": 1})
    if not doc:
        raise HTTPException(404, cid)
    # Your own, always; someone else's, only if you may delete (as notes).
    if not _mine(doc) and not _can_delete():
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await _db()[COLL].delete_one({"_id": cid})
    return {"deleted": cid}


@router.delete("/chats/{cid}/messages/{ref}")
async def delete_message(cid: str, ref: str) -> dict:
    """One line out of a conversation: one's own (or an answer to it)
    always, anyone else's only with the "delete" right."""
    db = _db()
    doc = await db[COLL].find_one({"_id": cid})
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

class SayIn(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)
    # Edit: this line (one's own) is replaced by `text`, and everything
    # after it goes before the answer is written again.
    edit: str | None = Field(default=None, max_length=40)


class RegenIn(BaseModel):
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


async def _load(cid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": cid})
    if not doc:
        raise HTTPException(404, cid)
    return doc


def _pick(doc: dict, provider: str | None, model: str | None) -> tuple[str, str]:
    provider = provider or doc.get("provider") or llm.route("chat")[0]
    model = model or doc.get("model") or llm.route("chat")[1]
    if provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {provider!r}")
    if not llm.key(provider):
        raise HTTPException(503, f"no {llm.PROVIDERS[provider]['name']} API key - Preferences > LLM settings")
    return provider, model


async def _cut(db, cid: str, msgs: list[dict], keep: int, tail: list[dict], sets: dict) -> None:
    """The conversation becomes msgs[:keep] + tail - only if nobody added a
    line meanwhile (otherwise 409, and nothing changed)."""
    res = await db[COLL].update_one({"_id": cid, "messages": {"$size": len(msgs)}},
                                    {"$set": {"messages": msgs[:keep] + tail, **sets}})
    if not getattr(res, "matched_count", 1):
        raise HTTPException(409, "the conversation changed meanwhile - read it again and retry")


def _stream(db, doc: dict, msgs: list[dict], provider: str, model: str, first: dict) -> StreamingResponse:
    """Write the answer to `msgs` and keep it. Events: the first one
    ({type: user, message, keep}: the conversation is its first `keep`
    lines, then `message` if any), then thinking|text|error, done, and a
    title when the conversation was named by this answer."""
    cid = doc["_id"]
    want_title = doc.get("title") in ("", DEFAULT_TITLE, None)

    async def events():
        yield _sse(first)
        answer = {"id": _mid(), "role": "assistant", "content": "", "at": _now(),
                  "provider": provider, "model": model}
        t0 = time.monotonic()
        thought = 0.0
        used: dict = {}
        try:
            first_text = None
            async for piece in llm.stream(history(msgs), provider=provider, model=model, max_tokens=MAX_ANSWER):
                if "thinking" in piece:
                    thought = time.monotonic() - t0
                    yield _sse({"type": "thinking", "text": piece["thinking"]})
                elif "text" in piece:
                    first_text = first_text or time.monotonic()
                    answer["content"] += piece["text"]
                    yield _sse({"type": "text", "text": piece["text"]})
                elif "usage" in piece:
                    used = piece["usage"] or {}
        except (asyncio.CancelledError, GeneratorExit):
            # Stop pressed (or the tab closed): kept as far as it got.
            answer["stopped"] = True
            raise
        except Exception as exc:                       # noqa: BLE001
            answer["error"] = str(exc)[:500]
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

            async def keep():
                await db[COLL].update_one({"_id": cid}, {"$push": {"messages": answer},
                                                         "$set": {"updated_at": _now()}})
                if used:
                    await llm.record(db, provider=provider, model=model, surface="chat", kind="cc-chat", used=used)
            # Shielded: a closed tab cancels this generator, not the saving.
            await asyncio.shield(keep())
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
    return _stream(db, doc, convo, provider, model, {"type": "user", "message": mine, "keep": keep})


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
    return _stream(db, doc, msgs[:keep], provider, model, {"type": "user", "message": None, "keep": keep})
