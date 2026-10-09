"""The next question, suggested: what the person is likely to ask next.

When an answer has ended in a conversation (or the agent has written in a
room's thread) and the composer has stayed empty for a while, the page
asks here for one short next question and shows it, dimmed, in the empty
composer; Tab takes it. Nothing is ever sent by itself.

It is a job in Settings > LLM settings ("suggest" in backend/llm.py
JOBS): a provider and a model like the others, plus a switch - off by
default, so nobody pays for it without choosing to - and the seconds of
quiet the page waits (`delay`).

What it costs is bounded: the last TURNS lines, each cut to TURN_CHARS,
an answer of a line, and at most one call per finished answer. The
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
TURNS = 6                      # lines of the conversation the model reads
TURN_CHARS = 1200              # each cut to this, its end kept
MAX_CHARS = 120                # the suggestion itself
MAX_TOKENS = 60
TIMEOUT = 20.0

PROMPT = (
    "You see the end of a conversation between a person and an assistant. Write the one "
    "next question or request the person is most likely to send now: short, concrete, "
    f"at most {MAX_CHARS} characters, written as the person would type it, in the language "
    "the person writes in (Turkish if they write Turkish). Reply with that line only: "
    "no quotes, no preamble, no explanation, no Markdown."
)


def _db():
    from .main import db
    return db()


def settings() -> dict:
    """Whether the feature is on, and how long the page waits before asking."""
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


def _cut(text: str) -> str:
    text = (text or "").strip()
    return text if len(text) <= TURN_CHARS else "…" + text[-TURN_CHARS:]


def transcript(turns: list[tuple[str, str]]) -> str:
    """The last TURNS lines, each cut short, as the model reads them."""
    rows = [(r, t) for r, t in turns if (t or "").strip()][-TURNS:]
    return "\n\n".join(f"{'Person' if r == 'user' else 'Assistant'}: {_cut(t)}" for r, t in rows)


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
        return lid, [(m.get("role") or "user", m.get("content") or "") for m in msgs[-TURNS * 2:]]
    if ref not in chat.ROOMS:
        raise HTTPException(404, ref)
    rows = await chat.history(db, TURNS * 2, ref)
    if not rows or rows[-1].get("role") != chat.AGENT:
        return None
    return rows[-1]["_id"], [("assistant" if d.get("role") == chat.AGENT else "user", chat.preview(d))
                             for d in rows]


_indexed = False


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
    try:
        await raw[COLL].insert_one({"_id": key, "at": datetime.now(timezone.utc), "state": "asking"})
    except Exception:                                  # noqa: BLE001 - a duplicate key: asked already
        doc = await raw[COLL].find_one({"_id": key}) or {}
        return doc.get("text") or None
    text, state = "", "failed"
    try:
        d = await asyncio.wait_for(llm.complete(
            [{"role": "system", "content": PROMPT}, {"role": "user", "content": transcript(turns)}],
            job=JOB, max_tokens=MAX_TOKENS, temperature=0.3, timeout=TIMEOUT), TIMEOUT + 5)
        text = clean(((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        state = "done" if text else "empty"
        await llm.record(db, provider=d.get("provider") or prov, model=d.get("model") or model,
                         surface="chat", kind="suggest", used=d.get("usage") or {})
    except Exception as exc:                           # noqa: BLE001 - no suggestion is fine
        llm.log.warning("suggestion failed: %s", type(exc).__name__)
    await raw[COLL].update_one({"_id": key}, {"$set": {"state": state, "text": text or None,
                                                       "provider": prov, "model": model}})
    return text or None


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
