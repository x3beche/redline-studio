"""Who a Telegram chat is: each app user links their own chat, once.

The person asks for a code in Settings > Telegram (POST /api/telegram/link)
and gets it with a t.me deep link and a QR code. The code is good for ten
minutes and once; the database keeps only its SHA-256. Telegram sends it
back to us as `/start <code>` when they open the link, and the chat is
bound to that person - in their own private space.

From then on whatever comes from that chat is that person, with their
system role as it is *now* (looked up on every message): a disabled or
deleted account is no one to the bot. `/stop`, or
"Unlink" in the app, ends it.
"""

from __future__ import annotations

import contextlib
import secrets
from datetime import timedelta

from .. import access, actors, auth, scope
from . import core, languages

# What a person may be told about, and whether it is on by default.
PREFS = {
    "question": True,     # an agent asked a question
    "note": True,         # a note was applied or failed
    "run": False,         # a run started
    "budget": False,      # a budget crossed its warning or 100%
    "build": False,       # a build failed
    "digest": False,      # once a day, what happened
    "ccusage": True,      # the Command Code weekly window at 90%, or used up (owner and admins)
}

# Told only to those who may change the server's settings.
SERVER_PREFS = {"ccusage"}

# The languages a question can be read in: every ISO 639-1 code
# (languages.py; backend/reading.py does the work). None is the agents' own
# English.

_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"     # no 0/O, 1/I: it may be typed


def new_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(8))


async def make_code(db, user: dict, workspace: str) -> dict:
    """A fresh one-time code for this person (any older one is dropped)."""
    raw = core.raw_of(db)
    code = new_code()
    expires = core.now() + timedelta(minutes=core.CODE_MINUTES)
    await raw[core.CODES].delete_many({"user": user["id"]})
    await raw[core.CODES].insert_one({"_id": core.digest(code), "user": user["id"],
                                      "name": user.get("name"), "workspace": workspace,
                                      "expires": expires, "at": core.now()})
    return {"code": code, "expires": expires}


async def use_code(db, code: str, chat: int, tg_user: dict) -> dict | None:
    """Bind the chat to the code's person. None if the code is unknown,
    used or past its ten minutes. One chat is one person, and one person
    one chat: an older link of either is replaced."""
    raw = core.raw_of(db)
    code = (code or "").strip().upper()
    if not code:
        return None
    doc = await raw[core.CODES].find_one_and_delete({"_id": core.digest(code)})
    if not doc:
        return None
    exp = core.aware(doc.get("expires"))
    if not exp or exp <= core.now():
        return None
    await raw[core.LINKS].delete_many({"chat": chat, "_id": {"$ne": doc["user"]}})
    old = await raw[core.LINKS].find_one({"_id": doc["user"]}) or {}
    link = {"_id": doc["user"], "name": doc.get("name"), "workspace": doc["workspace"], "chat": chat,
            "tg": {k: tg_user.get(k) for k in ("id", "username", "first_name", "last_name", "language_code")},
            "linked_at": core.now(), "prefs": {**PREFS, **(old.get("prefs") or {})},
            "lang": old.get("lang"), "blocked": False}
    await raw[core.LINKS].replace_one({"_id": doc["user"]}, link, upsert=True)
    return link


async def unlink(db, user_id: str) -> bool:
    res = await core.raw_of(db)[core.LINKS].delete_one({"_id": user_id})
    return bool(getattr(res, "deleted_count", 0))


async def by_chat(db, chat: int) -> dict | None:
    return await core.raw_of(db)[core.LINKS].find_one({"chat": chat})


async def of_user(db, user_id: str) -> dict | None:
    return await core.raw_of(db)[core.LINKS].find_one({"_id": user_id})


def prefs_of(link: dict) -> dict:
    return {**PREFS, **(link.get("prefs") or {})}


async def set_prefs(db, user_id: str, prefs: dict | None = None, lang: str | None = "",
                    ) -> dict | None:
    """Change what a person hears about, and the language questions come in.
    `lang` "" leaves it; None (or "en") is the original English."""
    raw = core.raw_of(db)
    link = await raw[core.LINKS].find_one({"_id": user_id})
    if not link:
        return None
    patch: dict = {}
    for k, v in (prefs or {}).items():
        if k not in PREFS:
            raise ValueError(f"no such notification: {k}")
        patch[f"prefs.{k}"] = bool(v)
    if lang != "":
        lang = (lang or "").strip().lower() or None
        if lang == "en":
            lang = None
        if lang is not None and not languages.known(lang):
            raise ValueError("language: an ISO 639-1 code, like tr, de or ja - or en for the original")
        patch["lang"] = lang
    if patch:
        await raw[core.LINKS].update_one({"_id": user_id}, {"$set": patch})
    return await raw[core.LINKS].find_one({"_id": user_id})


async def role_of(db, link: dict) -> str | None:
    """The person's system role now - None if their account is disabled or
    gone, or no longer works in the link's space. Local mode: the owner."""
    if not auth.enabled():
        return "owner"
    raw = core.raw_of(db)
    u = await raw[auth.USERS].find_one({"_id": link["_id"]}, {"pw": 0, "avatar": 0})
    if not u or u.get("disabled") or auth.space_of(u) != ws_of(link):
        return None
    return auth.role_of(u)


def can(role: str | None, act: str) -> bool:
    return bool(role) and access.allowed(role, act)


def actor(link: dict) -> dict:
    """Who did it, as the app records it: the person, by way of Telegram."""
    if not auth.enabled() and link["_id"] == "local":
        who = actors.local_user()
    else:
        who = {"type": "user", "id": link["_id"], "name": link.get("name") or link["_id"]}
    return {**who, "via": "telegram"}


def ws_of(link: dict) -> str:
    return link.get("workspace") or scope.DEFAULT


@contextlib.contextmanager
def acting(link: dict, role: str):
    """Run app code as this person, in their space, with their role -
    exactly as a request from their browser would."""
    t1 = actors.CURRENT.set(actor(link))
    t2 = scope.WORKSPACE.set(ws_of(link))
    t3 = access.ROLE.set(role)
    try:
        yield scope.ScopedDb(core.raw(), ws_of(link))
    finally:
        actors.CURRENT.reset(t1)
        scope.WORKSPACE.reset(t2)
        access.ROLE.reset(t3)


async def recipients(db, workspace: str, pref: str) -> list[tuple[dict, str]]:
    """The linked people of a space (its one person) who want to hear about `pref`, with
    their role now."""
    raw = core.raw_of(db)
    out = []
    q = {"workspace": workspace} if workspace != scope.DEFAULT else \
        {"$or": [{"workspace": scope.DEFAULT}, {"workspace": None}]}
    async for link in raw[core.LINKS].find(q):
        if link.get("blocked") or not prefs_of(link).get(pref):
            continue
        role = await role_of(raw, link)
        if role and access.allowed(role, "view"):
            out.append((link, role))
    return out


async def server_recipients(db, pref: str, act: str = "settings") -> list[tuple[dict, str]]:
    """The linked people, in any space, who want to hear about `pref` and
    whose role now allows `act` - the server's own news (the Command Code
    account is the server's, not a space's)."""
    raw = core.raw_of(db)
    out = []
    async for link in raw[core.LINKS].find({}):
        if link.get("blocked") or not prefs_of(link).get(pref):
            continue
        role = await role_of(raw, link)
        if role and access.allowed(role, act):
            out.append((link, role))
    return out
