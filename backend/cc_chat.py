"""The Command Code room: people talking with a model, in the open.

A conversation belongs to the workspace, not to whoever started it: anyone
there can read it and add to it, and each line says who wrote it. The
answer is streamed as it is written (server-sent events) and kept when it
is done - or as far as it got, if someone pressed stop. A conversation
remembers its model; it starts with the one chosen for the "chat" job in
Preferences > LLM settings (backend/llm.py), and can be switched at any
line.
"""

from __future__ import annotations

import asyncio
import json
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

SYSTEM = (
    "You are a helpful assistant in Redline Studio, a workshop app for 3D CAD models, "
    "circuit boards and firmware. Several people may share this conversation; a line "
    "written by someone is prefixed with their name in brackets when there is more than "
    "one of them. Answer in the language you are asked in. Use Markdown where it helps."
)


def _db():
    from .main import db
    return db()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _out(doc: dict, full: bool = True) -> dict:
    o = {k: v for k, v in doc.items() if k not in ("_id", "workspace_id", "messages")}
    o["id"] = doc["_id"]
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
        if m.get("error") and not m.get("content"):
            continue
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


@router.get("/chats")
async def list_chats(q: str = "") -> list[dict]:
    query: dict = {}
    if q:
        import re
        query = {"$or": [{"title": {"$regex": re.escape(q), "$options": "i"}},
                         {"messages.content": {"$regex": re.escape(q), "$options": "i"}}]}
    cur = _db()[COLL].find(query, {"messages": {"$slice": -1}}).sort("updated_at", -1).limit(300)
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
    doc = {"_id": secrets.token_hex(6), "title": body.title.strip() or "New conversation",
           "provider": prov, "model": model, "by": actors.current(),
           "created_at": now, "updated_at": now, "messages": []}
    await _db()[COLL].insert_one(doc)
    return _out(doc)


@router.get("/chats/{cid}")
async def get_chat(cid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": cid})
    if not doc:
        raise HTTPException(404, cid)
    return _out(doc)


class ChatPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, min_length=1, max_length=200)


@router.patch("/chats/{cid}")
async def patch_chat(cid: str, body: ChatPatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "provider" in patch and patch["provider"] not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {patch['provider']!r}")
    if patch:
        await _db()[COLL].update_one({"_id": cid}, {"$set": patch})
    return await get_chat(cid)


@router.delete("/chats/{cid}")
async def delete_chat(cid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": cid}, {"by": 1})
    if not doc:
        raise HTTPException(404, cid)
    # Your own, always; someone else's, only if you may delete (as notes).
    if (doc.get("by") or {}).get("id") != actors.current().get("id") and not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await _db()[COLL].delete_one({"_id": cid})
    return {"deleted": cid}


class SayIn(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


@router.post("/chats/{cid}/messages")
async def say(cid: str, body: SayIn):
    """Add a line and stream the answer: events {type: user|thinking|text|done|error}."""
    db = _db()
    doc = await db[COLL].find_one({"_id": cid})
    if not doc:
        raise HTTPException(404, cid)
    if len(doc.get("messages") or []) >= MAX_MESSAGES:
        raise HTTPException(400, f"this conversation has {MAX_MESSAGES} lines; start a new one")
    provider = body.provider or doc.get("provider") or llm.route("chat")[0]
    model = body.model or doc.get("model") or llm.route("chat")[1]
    if provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {provider!r}")
    if not llm.key(provider):
        raise HTTPException(503, f"no {llm.PROVIDERS[provider]['name']} API key - Preferences > LLM settings")

    who = actors.current()
    mine = {"id": secrets.token_hex(5), "role": "user", "content": body.text, "at": _now(),
            "by": {"id": who.get("id"), "name": who.get("name"), "type": who.get("type")}}
    sets: dict = {"updated_at": mine["at"], "provider": provider, "model": model}
    if not doc.get("messages") and doc.get("title") in ("", "New conversation"):
        sets["title"] = " ".join(body.text.split())[:60] or "New conversation"
    await db[COLL].update_one({"_id": cid}, {"$push": {"messages": mine}, "$set": sets})
    msgs = (doc.get("messages") or []) + [mine]

    async def events():
        yield _sse({"type": "user", "message": mine, "title": sets.get("title")})
        answer = {"id": secrets.token_hex(5), "role": "assistant", "content": "", "at": _now(),
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
        except Exception as exc:                       # noqa: BLE001
            answer["error"] = str(exc)[:500]
            yield _sse({"type": "error", "error": answer["error"]})
        finally:
            # Kept whatever happened: a stopped answer stays as far as it got.
            answer["ms"] = round((time.monotonic() - t0) * 1000)
            if thought:
                answer["thinking_ms"] = round(thought * 1000)
            answer["usage"] = {k: used.get(k) for k in ("prompt_tokens", "completion_tokens", "cost")}
            async def keep():
                await db[COLL].update_one({"_id": cid}, {"$push": {"messages": answer},
                                                         "$set": {"updated_at": _now()}})
                if used:
                    await llm.record(db, provider=provider, model=model, surface="chat", kind="cc-chat", used=used)
            # Shielded: a closed tab cancels this generator, not the saving.
            await asyncio.shield(keep())
        yield _sse({"type": "done", "message": answer})

    # X-Accel-Buffering: nginx (NPM) would otherwise hold the stream back
    # and hand it over in one piece at the end.
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
