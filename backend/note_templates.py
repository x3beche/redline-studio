"""Note templates people keep for themselves: a starting text for a note or
a request they write often ("Change a dimension on [part] ...").

The ones everybody has are written by hand in the page
(frontend/src/app/rooms/note-tpl.ts), in English and Turkish. These are a
person's own: saved from the text in a composer - the Notes editor, the
Alt+N quick note, a room's agent thread - with a name and the room they
are for ("" for any), and offered in the same picker, the room's first.

Each belongs to whoever saved it, in the workspace it was saved in
(backend/scope.py): only they see it in their picker, and only they
rename, change or delete it - anyone else gets "no such template", not a
hint that it exists. Saving one takes the right to write a note (draw); a
viewer or a page session only looks. Saving is written in the audit trail
here; a change or a delete is written there by the middleware, as every
PATCH and DELETE is (backend/actors.py `audited`).
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import actors

COLL = "note_templates"
MAX_PER_PERSON = 100
NAME_MAX = 60
TEXT_MAX = 4000
ROOMS = ("", "cad", "pcb", "firmware", "notes")

router = APIRouter(prefix="/api/note-templates")


def _db():
    from .main import db
    return db()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _me() -> str:
    return str(actors.current().get("id") or "")


def clean(name: str | None, room: str | None, text: str | None) -> dict:
    """The template as it is kept, or a ValueError saying what is wrong."""
    name = " ".join(str(name or "").split())
    if not name:
        raise ValueError("a template needs a name")
    if len(name) > NAME_MAX:
        raise ValueError(f"a template's name is at most {NAME_MAX} characters")
    room = str(room or "").strip()
    if room not in ROOMS:
        raise ValueError(f"room is one of {', '.join(r or '(any)' for r in ROOMS)}")
    text = str(text or "").replace("\r\n", "\n").strip("\n")
    if not text.strip():
        raise ValueError("a template needs its text")
    if len(text) > TEXT_MAX:
        raise ValueError(f"a template's text is at most {TEXT_MAX} characters")
    return {"name": name, "room": room, "text": text}


def _out(doc: dict) -> dict:
    return {"id": doc["_id"], "name": doc["name"], "room": doc.get("room") or "", "text": doc["text"],
            "created_at": doc.get("created_at"), "updated_at": doc.get("updated_at")}


class TemplateIn(BaseModel):
    name: str = Field(max_length=200)
    room: str = Field(default="", max_length=20)
    text: str = Field(max_length=TEXT_MAX + 200)


class TemplatePatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    room: str | None = Field(default=None, max_length=20)
    text: str | None = Field(default=None, max_length=TEXT_MAX + 200)


@router.get("")
async def listing() -> list[dict]:
    """My own templates, oldest first."""
    rows = [d async for d in _db()[COLL].find({"by.id": _me()}).sort("created_at", 1).limit(MAX_PER_PERSON)]
    return [_out(d) for d in rows]


@router.post("")
async def create(body: TemplateIn) -> dict:
    try:
        doc = clean(body.name, body.room, body.text)
    except ValueError as e:
        raise HTTPException(422, str(e))
    me = _me()
    if not me:
        raise HTTPException(403, "only someone signed in keeps templates")
    d = _db()
    if await d[COLL].count_documents({"by.id": me}) >= MAX_PER_PERSON:
        raise HTTPException(409, f"you already have {MAX_PER_PERSON} templates - delete one first")
    who = actors.current()
    now = _now()
    doc = {"_id": secrets.token_hex(6), **doc, "by": {k: who.get(k) for k in ("type", "id", "name")},
           "created_at": now, "updated_at": now}
    await d[COLL].insert_one(doc)
    await actors.audit(d, "create", f"note template {doc['_id']}", {"name": doc["name"], "room": doc["room"]})
    return _out(doc)


async def _mine(tid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": tid, "by.id": _me()})
    if not doc:
        raise HTTPException(404, "no such template")
    return doc


@router.patch("/{tid}")
async def update(tid: str, body: TemplatePatch) -> dict:
    doc = await _mine(tid)
    try:
        patch = clean(body.name if body.name is not None else doc["name"],
                      body.room if body.room is not None else doc.get("room"),
                      body.text if body.text is not None else doc["text"])
    except ValueError as e:
        raise HTTPException(422, str(e))
    patch["updated_at"] = _now()
    await _db()[COLL].update_one({"_id": tid}, {"$set": patch})
    return _out({**doc, **patch})


@router.delete("/{tid}")
async def remove(tid: str) -> dict:
    await _mine(tid)
    await _db()[COLL].delete_one({"_id": tid})
    return {"ok": True}
