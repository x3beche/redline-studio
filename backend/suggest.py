"""The next question, suggested: what the person is likely to ask next.

When an answer has ended in a conversation (or the agent has written in a
room's thread) and the composer has stayed empty for a while, the page
asks here for one short next question and shows it, dimmed, in the empty
composer; Tab takes it. Nothing is ever sent by itself.

It is a job in Settings > LLM settings ("suggest" in backend/llm.py
JOBS): a provider and a model like the others, plus a switch - off by
default, so nobody pays for it without choosing to - and the seconds of
quiet the page waits (`delay`).

What it costs is bounded: the conversation's end up to the job's context
(`ctx`, in tokens, set beside the switch - counted as CHARS_PER_TOKEN
characters each, so a Turkish text, which takes more tokens per
character than English, stays under it), an answer of a line, and at
most one call per finished answer. The
suggestion is kept against the answer it follows (`COLL`, keyed by
workspace, conversation and that line's id): asked again - another tab,
another person, a reload - it is the kept one, and a call that failed is
not tried again for the same answer. Every call goes in the usage log
like the other jobs' (kind "suggest").
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import cc_chat, chat, llm, scope

router = APIRouter(prefix="/api/suggest")

JOB = "suggest"
COLL = "suggestions"           # the machine's: the key carries the workspace
KEEP_DAYS = 7                  # a kept suggestion goes after this (TTL index)
# A token is counted as this many characters. Low on purpose: Turkish
# and code take about 3, English about 4, so the context is not overrun.
CHARS_PER_TOKEN = 3
# Lines read back from a room's thread to fill the context from.
ROOM_ROWS = 400
MAX_CHARS = 120                # the suggestion itself
MAX_TOKENS = 60
TIMEOUT = 20.0

PROMPT = (
    "You see the end of a conversation between a person and their assistant. Write the one "
    "message the PERSON is most likely to send next - in the person's own voice, first "
    "person, as they would type it to the assistant: a request or a question TO the "
    "assistant about their own work, the next step of what was just done (the shape of "
    "\"Aynısını diğerleri için de yap\" or \"Can you compare it with the last version?\" - "
    "shapes only, never copy them). Never write as the assistant: never "
    "ask the person about their plans, never offer help, never thank or answer them "
    "(not \"Bu mili ne için kullanacaksın?\", not \"Başka bir şey ister misin?\"). If the "
    "conversation ended with thanks or a goodbye, suggest the natural next request for "
    "the work it was about. Short and concrete, "
    f"at most {MAX_CHARS} characters, in the language the person writes in (Turkish if they "
    "write Turkish). Reply with that line only: no quotes, no preamble, no explanation, no Markdown."
)


def _db():
    from .main import db
    return db()


def settings() -> dict:
    """Whether the feature is on, how long the page waits before asking,
    and how many tokens of the conversation are sent."""
    return llm.job_switch(JOB)


@router.get("")
async def get_settings() -> dict:
    """For the composer: on/off and the delay (no model, no key)."""
    return settings()


class SuggestIn(BaseModel):
    kind: Literal["cc", "room"]
    id: str = Field(min_length=1, max_length=80)


def clean(raw: str) -> str:
    """The model's answer as one suggestion line: no quotes, no label, no
    Markdown, at most MAX_CHARS characters."""
    line = next((ln for ln in (raw or "").splitlines() if ln.strip()), "")
    line = re.sub(r"^\s*(suggestion|question|öneri|soru)\s*:\s*", "", line, flags=re.I)
    line = re.sub(r"^\s*([-*>]|\d+[.)])\s+", "", line)
    line = line.strip().strip("#*_`\"'“”‘’«» ").strip()
    if len(line) > MAX_CHARS:
        cut = line[:MAX_CHARS]
        line = (cut.rsplit(" ", 1)[0] if " " in cut else cut).rstrip(" ,;:") + "…"
    return line


def transcript(turns: list[tuple[str, str]], ctx: int) -> str:
    """The conversation's end, as the model reads it: whole lines from the
    newest back while they fit in `ctx` tokens, and the line that no
    longer fits cut at its start - its end, the part nearest what follows,
    kept."""
    budget = max(1, ctx) * CHARS_PER_TOKEN
    tail = "\n\nPerson (the next message, to the assistant):"
    budget -= len(tail)
    rows: list[str] = []
    for r, t in reversed([(r, (t or "").strip()) for r, t in turns if (t or "").strip()]):
        head = f"{'Person' if r == 'user' else 'Assistant'}: "
        room = budget - len(head) - (2 if rows else 0)
        if room <= 0:
            break
        if len(t) > room:
            rows.append(head + "…" + t[-(room - 1):] if room > 1 else head + "…")
            break
        rows.append(head + t)
        budget = room - len(t)
    return "\n\n".join(reversed(rows)) + tail


async def _turns(db, kind: str, ref: str) -> tuple[str, list[tuple[str, str]]] | None:
    """(the id of the answer last written, the conversation's lines) - or
    None when there is nothing to follow: no lines, the last one the
    person's, an answer still being written or one that failed."""
    if kind == "cc":
        doc = await db[cc_chat.COLL].find_one({"_id": ref, **cc_chat.LIVE})
        if not doc:
            raise HTTPException(404, ref)
        if doc.get("gen"):
            return None                                # an answer is being written
        msgs = doc.get("messages") or []
        if not msgs:
            return None
        last = msgs[-1]
        if last.get("role") != "assistant" or last.get("error") or not (last.get("content") or "").strip():
            return None
        lid = last.get("id") or f"#{len(msgs) - 1}"
        return lid, [(m.get("role") or "user", m.get("content") or "") for m in msgs]
    if ref not in chat.ROOMS:
        raise HTTPException(404, ref)
    rows = await chat.history(db, ROOM_ROWS, ref)
    if not rows or rows[-1].get("role") != chat.AGENT:
        return None
    return rows[-1]["_id"], [("assistant" if d.get("role") == chat.AGENT else "user", chat.preview(d))
                             for d in rows]


_indexed = False
RETRY_S = 300                      # a failed call is asked again after this long


async def _ensure_index(raw) -> None:
    global _indexed
    if _indexed:
        return
    _indexed = True
    try:
        await raw[COLL].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400, name="suggest_ttl")
    except Exception:                                  # noqa: BLE001 - kept a little longer, no harm
        llm.log.warning("suggestions: TTL index not made")


async def suggest(db, kind: str, ref: str) -> str | None:
    """One suggestion for what follows the conversation's last answer, or
    None (off, nothing to follow, no key, already asked and failed)."""
    s = settings()
    if not s["on"]:
        return None
    got = await _turns(db, kind, ref)
    if not got:
        return None
    lid, turns = got
    prov, model = llm.route(JOB)
    if not llm.key(prov):
        return None
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    await _ensure_index(raw)
    key = f"{scope.current()}:{kind}:{ref}:{lid}"
    # One call per answer: whoever claims the key asks; everyone else gets
    # what was kept (or nothing while it is being asked, or if it failed).
    now = datetime.now(timezone.utc)
    try:
        await raw[COLL].insert_one({"_id": key, "at": now, "state": "asking"})
    except Exception:                                  # noqa: BLE001 - a duplicate key: asked already
        doc = await raw[COLL].find_one({"_id": key}) or {}
        if doc.get("text") or doc.get("state") != "failed":
            return doc.get("text") or None
        # A call that failed (the provider down, a model it refused) is
        # tried again after a while, not never: claimed again, by one.
        at = doc.get("at")
        if at and at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if at and (now - at).total_seconds() < RETRY_S:
            return None
        got = await raw[COLL].update_one({"_id": key, "state": "failed", "at": doc.get("at")},
                                         {"$set": {"state": "asking", "at": now}})
        if not got.modified_count:
            return None
    text, state = "", "failed"
    try:
        d = await asyncio.wait_for(llm.complete(
            [{"role": "system", "content": PROMPT}, {"role": "user", "content": transcript(turns, s["ctx"])}],
            job=JOB, max_tokens=MAX_TOKENS, temperature=0.3, timeout=TIMEOUT), TIMEOUT + 5)
        text = clean(((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        state = "done" if text else "empty"
        await llm.record(db, provider=d.get("provider") or prov, model=d.get("model") or model,
                         surface="chat", kind="suggest", used=d.get("usage") or {})
    except Exception as exc:                           # noqa: BLE001 - no suggestion is fine
        error = f"{type(exc).__name__}: {exc}"[:300]
        llm.log.warning("suggestion failed (%s %s): %s", prov, model, error)
    else:
        error = None
    await raw[COLL].update_one({"_id": key}, {"$set": {"state": state, "text": text or None,
                                                       "provider": prov, "model": model, "error": error}})
    return text or None


async def peek(db, kind: str, ref: str) -> str | None:
    """The suggestion already made for the conversation's last answer, if
    any - never a new call. A reload, or another tab, shows it again."""
    if not settings()["on"]:
        return None
    got = await _turns(db, kind, ref)
    if not got:
        return None
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    doc = await raw[COLL].find_one({"_id": f"{scope.current()}:{kind}:{ref}:{got[0]}"}) or {}
    return doc.get("text") or None


@router.get("/peek")
async def get_peek(kind: Literal["cc", "room"], id: str):
    """{text} when a suggestion was made for the last answer, else 204."""
    text = await peek(_db(), kind, id)
    if not text:
        return Response(status_code=204)
    return {"text": text}


@router.post("")
async def post_suggest(body: SuggestIn):
    """{text} - the suggestion - or 204 when
    there is none (the feature off, an answer being written, nothing to
    follow)."""
    db = _db()
    text = await suggest(db, body.kind, body.id)
    if not text:
        return Response(status_code=204)
    return {"text": text}
