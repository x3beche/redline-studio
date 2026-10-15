"""The way back from a change made to many things at once in Parts - the
selection bar's "Edit" over products (backend/manufacturers.py
`bulk_edit`) or stock lines (backend/inventory.py `bulk_edit`).

A single edit is a form the person reads before saving; a bulk one changes
forty products with one click, so it can be taken back. What each thing
was before is kept here, on the server (`parts_undo`, the workspace's -
backend/scope.py) for KEEP_HOURS, under an id the page holds for its Undo:
the page never sends the old values itself, so an undo can only put back
what was there. Each thing is put back only while it is still as the bulk
edit left it (`stamp`); one changed since is left alone and said
(`conflict`), as the Chat's undo does (backend/chat_undo.py).

Taking a record back is its maker's, or anyone's with the right to delete.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from . import access, actors

COLL = "parts_undo"
KEEP_HOURS = 24


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def keep(db, kind: str, rows: list[dict], what: str = "") -> str | None:
    """The things' before, kept: [{key..., before, stamp}]; the id to undo
    with, None when nothing changed. Old records are dropped as one is kept."""
    if not rows:
        return None
    now = _now()
    await db[COLL].delete_many({"at": {"$lt": (now - timedelta(hours=KEEP_HOURS)).isoformat()}})
    who = actors.current() or {}
    uid = "u" + secrets.token_hex(6)
    await db[COLL].insert_one({"_id": uid, "kind": kind, "at": now.isoformat(), "what": what[:200],
                               "by": {"id": who.get("id"), "name": who.get("name")}, "rows": rows})
    return uid


async def take(db, uid: str, kind: str) -> dict:
    """The record to undo, dropped from the kept ones: LookupError when it is
    not here (undone already, or older than KEEP_HOURS), PermissionError when
    it is someone else's and the right to delete is missing."""
    doc = await db[COLL].find_one({"_id": str(uid or ""), "kind": kind})
    if not doc or doc.get("at", "") < (_now() - timedelta(hours=KEEP_HOURS)).isoformat():
        raise LookupError("that change cannot be undone any more")
    mine = (doc.get("by") or {}).get("id") == (actors.current() or {}).get("id")
    if not mine and not access.allowed(access.current(), "delete"):
        raise PermissionError(access.refusal(access.current() or "nobody", "delete"))
    await db[COLL].delete_one({"_id": doc["_id"]})
    return doc
