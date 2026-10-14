"""The workspace's memory: a short pinned list of what is known here.

Printer settings, the screws they prefer, the projects, the conventions -
a few lines the people pin once instead of saying them in every
conversation. Every conversation of the workspace is sent them with its
system line (backend/ccgen.py, `block`), and the model reads and changes
them with the chat tools memory_read and memory_write (removing asks
first). The Chat's "Workspace memory" panel edits them by hand
(rooms/cc-memory.ts, the routes below).

One document per workspace in `cc_memory` (named by scope.key: `memory`,
`memory@<space>`), so each space has its own. Each item says who pinned it and when, and who changed it
last. Bounded: MAX_ITEMS items of at most MAX_CHARS characters, MAX_TOTAL
in all - it goes with every line. Never a secret: a line that looks like a
key, a token or a password is refused (`secretish`).
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import BaseModel, Field

from . import actors, scope

COLL = "cc_memory"
DOC = "memory"
MAX_ITEMS = 40
MAX_CHARS = 300
MAX_TOTAL = 4000

# What a secret looks like: a provider's key, a token, a private key, or a
# password written out after its name.
_SECRET = [re.compile(p, re.I) for p in (
    r"\bsk-[a-z0-9_\-]{12,}", r"\b(ghp|gho|ghs|github_pat)_[a-z0-9_]{16,}", r"\bxox[abpr]-[a-z0-9\-]{10,}",
    r"\bAKIA[0-9A-Z]{16}\b", r"\bAIza[0-9a-z_\-]{30,}", r"-----BEGIN [A-Z ]*PRIVATE KEY",
    r"\beyJ[a-z0-9_\-]{8,}\.[a-z0-9_\-]{8,}\.[a-z0-9_\-]{8,}", r"\bbearer\s+[a-z0-9._\-]{12,}",
    r"\b(password|passwd|pwd|pass|parola\w*|şifre\w*|sifre\w*|secret|token|api[ _\-]?key|apikey|anahtar\w*)"
    r"\s*(?:[:=]|\bis\b|\bşu\b|\bolarak\b)\s*\S{3,}",
    r"\b(password|passwd|pwd|parola\w*|şifre\w*|sifre\w*)\s+\S*\d\S*",
)]
_LONG = re.compile(r"[A-Za-z0-9_\-+/=]{32,}")


def secretish(text: str) -> bool:
    """Whether a line looks like it holds a key, a token or a password."""
    if any(rx.search(text) for rx in _SECRET):
        return True
    # a long run of letters and digits mixed is a key more often than not
    return any(re.search(r"[A-Za-z]", m) and re.search(r"\d", m) for m in _LONG.findall(text))


class Refused(ValueError):
    """Said to the person (or the model) as it is."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _who() -> dict:
    a = actors.current() or {}
    return {"id": a.get("id"), "name": a.get("name") or "someone"}


def _coll(db):
    raw = getattr(db, "raw", None)                     # the database itself: the id says the space
    return (db if raw is None else raw)[COLL]


async def items(db) -> list[dict]:
    doc = await _coll(db).find_one({"_id": scope.key(DOC)}) or {}
    return list(doc.get("items") or [])


async def _put(db, rows: list[dict]) -> None:
    await _coll(db).update_one({"_id": scope.key(DOC)}, {"$set": {"items": rows, "updated_at": _now()}}, upsert=True)


def _clean(text: str) -> str:
    text = " ".join(str(text or "").split())
    if not text:
        raise Refused("say what to remember")
    if len(text) > MAX_CHARS:
        raise Refused(f"one item is at most {MAX_CHARS} characters - this one is {len(text)}; say it shorter")
    if secretish(text):
        raise Refused("that looks like a key, a token or a password - the memory never keeps secrets "
                          "(they go to every conversation); keep them in Settings instead")
    return text


def _fits(rows: list[dict]) -> None:
    if len(rows) > MAX_ITEMS:
        raise Refused(f"the memory holds at most {MAX_ITEMS} items - remove or merge some first")
    total = sum(len(r["text"]) for r in rows)
    if total > MAX_TOTAL:
        raise Refused(f"the memory holds at most {MAX_TOTAL} characters in all ({total} with this) - "
                          "remove or shorten some first")


async def add(db, text: str) -> dict:
    text = _clean(text)
    rows = await items(db)
    if any(r["text"].casefold() == text.casefold() for r in rows):
        raise Refused("that is already in the memory")
    item = {"id": secrets.token_hex(4), "text": text, "by": _who(), "at": _now()}
    rows.append(item)
    _fits(rows)
    await _put(db, rows)
    return item


async def edit(db, iid: str, text: str) -> dict:
    text = _clean(text)
    rows = await items(db)
    for r in rows:
        if r["id"] == iid:
            r.update(text=text, edited_by=_who(), edited_at=_now())
            _fits(rows)
            await _put(db, rows)
            return r
    raise Refused(f"no memory item {iid!r}")


async def remove(db, iid: str) -> dict:
    rows = await items(db)
    gone = next((r for r in rows if r["id"] == iid), None)
    if gone is None:
        raise Refused(f"no memory item {iid!r}")
    await _put(db, [r for r in rows if r["id"] != iid])
    return gone


def line(r: dict) -> str:
    """'- [id] text (Emir, 2026-10-14)' - as the model reads an item."""
    who = (r.get("edited_by") or r.get("by") or {}).get("name") or "someone"
    when = (r.get("edited_at") or r.get("at") or "")[:10]
    return f"- [{r['id']}] {r['text']} ({who}, {when})"


async def block(db, tools: bool) -> str:
    """The memory as the system line ends with; empty when there is none and
    the model could not add to it either."""
    try:
        rows = await items(db)
    except Exception:                                  # noqa: BLE001 - a conversation without it
        rows = []
    how = (" Keep to these unless the person says otherwise. When the person asks you to remember something "
           "for this workspace (a setting, a preference, a convention), save it with memory_write; never save "
           "keys, tokens or passwords.") if tools else " Keep to these unless the person says otherwise."
    if not rows:
        return ("\n\nWorkspace memory: nothing pinned yet." + how) if tools else ""
    return ("\n\nWorkspace memory - what the people of this workspace pinned for every conversation:\n"
            + "\n".join(line(r) for r in rows) + "\n" + how.strip())


# ---------------------------------------------------------------- routes
# (/api/cc/memory - cc_chat.py adds them to its router, `ROUTES`; writing
# is the "edit" right, as any route not listed in backend/access.py)

def _db():
    from .main import db
    return db()


def public(rows: list[dict]) -> dict:
    return {"items": rows, "max_items": MAX_ITEMS, "max_chars": MAX_CHARS, "max_total": MAX_TOTAL,
            "used": sum(len(r["text"]) for r in rows)}


class ItemIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


async def get_memory() -> dict:
    return public(await items(_db()))


async def _do(coro) -> dict:
    try:
        await coro
    except Refused as exc:
        raise HTTPException(400, str(exc)) from exc
    return public(await items(_db()))


async def add_item(body: ItemIn) -> dict:
    return await _do(add(_db(), body.text))


async def edit_item(iid: str, body: ItemIn) -> dict:
    return await _do(edit(_db(), iid, body.text))


async def remove_item(iid: str) -> dict:
    return await _do(remove(_db(), iid))


ROUTES = (("GET", "/memory", get_memory), ("POST", "/memory", add_item),
          ("PATCH", "/memory/{iid}", edit_item), ("DELETE", "/memory/{iid}", remove_item))
