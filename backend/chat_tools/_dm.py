"""What the direct-message tools share (dm_read, dm_send): the DM tab's
conversations (backend/dm.py) as the asker sees them - only people, only
signed in, only their own direct conversations, the same refusals the DM
routes give - and a person or a conversation named the way someone says it."""

from __future__ import annotations

from fastapi import HTTPException

from .. import auth, dm
from .. import manufacturers as mf
from . import ToolError

SHOW = 20                  # people a "which one?" names


def me(write: bool = False) -> dict:
    """The asker, as dm.me sees them, or a ToolError with its refusal."""
    try:
        return dm.me(write)
    except HTTPException as exc:
        raise ToolError(str(exc.detail)) from None


async def people(uid: str) -> list[dict]:
    """Everyone the asker may write to: the other accounts, not disabled (as the DM tab's People)."""
    return [u async for u in dm._raw()[auth.USERS].find({}, {"pw": 0, "avatar": 0})
            if u["_id"] != uid and not u.get("disabled")]


async def person(uid: str, ref: str) -> dict:
    """The one person `ref` names: their account id, or their name (whole, or words of it)."""
    ref = str(ref or "").strip()
    if not ref:
        raise ToolError("say who: a person's name (dm_read without a person lists the conversations)")
    every = await people(uid)
    by_id = [u for u in every if u["_id"] == ref]
    if by_id:
        return by_id[0]
    want = mf.fold(ref)
    whole = [u for u in every if mf.fold(u.get("name")) == want]
    if len(whole) == 1:
        return whole[0]
    words = want.split()
    hits = [u for u in every if words and all(w in mf.fold(u.get("name")) for w in words)]
    if len(hits) == 1:
        return hits[0]
    names = ", ".join(f"{u.get('name')} ({u['_id']})" for u in (hits or every)[:SHOW])
    if hits:
        raise ToolError(f"{len(hits)} people match {ref!r}: {names}. Ask which one, then call again with their id.")
    raise ToolError(f"nobody here is called {ref!r}" + (f". The people: {names}" if every else " - there is nobody else"))


async def thread(uid: str, ref: str) -> tuple[dict | None, dict | None]:
    """(the conversation, the other person) `ref` names: a conversation's id
    (dm-...), or a person - whose conversation may not exist yet (None)."""
    ref = str(ref or "").strip()
    if ref.startswith("dm-"):
        try:
            doc = await dm._chat(ref, uid)
        except HTTPException as exc:
            raise ToolError(f"{ref}: {exc.detail}") from None
        other = next((m for m in doc.get("members") or [] if m != uid), None)
        folks = await dm._people([other]) if other else {}
        return doc, folks.get(other)
    who = await person(uid, ref)
    doc = await dm._raw()[dm.CHATS].find_one({"pair": dm._pair(uid, who["_id"]), "direct": True})
    return doc, who
