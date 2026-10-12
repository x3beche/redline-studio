"""The admin panel: the server's accounts, for the owner and the admins.

    GET    /api/admin/users                     everyone, with role, status, last sign-in
    POST   /api/admin/users                     add an account (there is no sign-up)
    PATCH  /api/admin/users/{id}                name, email, avatar colour, enabled/disabled, role (owner only)
    POST   /api/admin/users/{id}/password       a temporary password, changed at next sign-in
    POST   /api/admin/users/{id}/sign-out       end every session of the account
    PUT    /api/admin/users/{id}/avatar         a new picture (profile.py's square JPEG)
    DELETE /api/admin/users/{id}/avatar         no picture
    DELETE /api/admin/users/{id}[?with_data=1]  delete the account (owner only)
    GET    /api/admin/overview?span=            the dashboard: what is kept, who did what

The middleware lets only the owner and the admins in ("users",
backend/access.py). The rules past that are here:

  - the owner - the first account - cannot be disabled, demoted or deleted;
  - only the owner changes roles (to admin or user; ownership does not move)
    and deletes accounts;
  - an admin manages the users' accounts, not the owner's or another
    admin's;
  - nobody disables or deletes their own account here.

A disabled account cannot sign in, its sessions end at once and the agent
tokens it made stop working (backend/auth.py checks the maker). Each
account has a private space (backend/scope.py); deleting one that holds
data is refused unless the data is to go too. Every change is written to
the audit trail - the owner's (the server's) and, for an admin, their own.
"""

from __future__ import annotations

import os
import re
import secrets
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import access, actors, auth, profile, scope

router = APIRouter(prefix="/api/admin")


def _raw():
    from .main import db
    return db().raw


def _iso(v):
    return profile._iso(v)


def _me() -> tuple[dict, str]:
    who = actors.current()
    role = access.current() or ""
    if who.get("type") != "user" or who.get("page") or role not in ("owner", "admin"):
        raise HTTPException(403, "only the owner and the admins manage the accounts")
    return who, role


async def _target(user_id: str) -> dict:
    u = await _raw()[auth.USERS].find_one({"_id": user_id}, {"pw": 0, "avatar": 0})
    if not u:
        raise HTTPException(404, "no such account")
    return u


def _may_manage(me: dict, my_role: str, u: dict) -> None:
    """The owner manages everyone; an admin, the users and themselves."""
    if my_role == "owner" or u["_id"] == me.get("id"):
        return
    if auth.role_of(u) != auth.USER:
        raise HTTPException(403, f"an admin cannot change the {auth.role_of(u)}'s account - ask the owner")


async def _audit(action: str, target: str, detail: dict | None = None) -> None:
    """Into the server's trail (the owner's space) and the actor's own."""
    raw = _raw()
    await actors.audit(scope.ScopedDb(raw, scope.DEFAULT), action, target, detail)
    if scope.current() != scope.DEFAULT:
        await actors.audit(scope.ScopedDb(raw, scope.current()), action, target, detail)


async def _data_count(space: str) -> int:
    """How many documents a space holds - its audit trail aside. The
    owner's (default) space is never asked: it cannot be deleted."""
    raw = _raw()
    n = 0
    for name in sorted(scope.SCOPED - {"audit"}):
        n += await raw[name].count_documents({"workspace_id": space})
    return n


async def _out(u: dict) -> dict:
    raw = _raw()
    me = actors.current().get("id")
    last = u.get("last_sign_in")
    live = 0
    now = auth._now()
    newest = None
    async for s in raw[auth.SESSIONS].find({"user": u["_id"]}, {"kind": 1, "expires": 1, "created_at": 1}):
        exp = auth._aware(s.get("expires"))
        if s.get("kind") != auth.PAGE_KIND and exp and exp > now:
            live += 1
            made = auth._aware(s.get("created_at"))
            newest = max(newest, made) if newest and made else (made or newest)
    # From before sign-ins were written down: the newest session.
    last = last or newest
    tokens = await raw[auth.TOKENS].count_documents({"created_by.id": u["_id"], "revoked": {"$ne": True}})
    return {"id": u["_id"], "name": u.get("name") or u["email"], "email": u["email"],
            "role": auth.role_of(u), "disabled": bool(u.get("disabled")),
            "must_change_password": bool(u.get("must_change_password")),
            "created_at": _iso(u.get("created_at")), "last_sign_in": _iso(last),
            "sessions": live, "tokens": tokens, "me": u["_id"] == me, **profile.avatar_fields(u)}


@router.get("/users")
async def users() -> dict:
    who, role = _me()
    rows = [await _out(u) async for u in _raw()[auth.USERS].find({}, {"pw": 0, "avatar": 0})]
    rank = {r: i for i, r in enumerate(auth.SYSTEM_ROLES)}
    rows.sort(key=lambda r: (rank.get(r["role"], 9), (r["name"] or "").lower()))
    return {"users": rows, "me": who.get("id"), "my_role": role, "roles": list(auth.SYSTEM_ROLES),
            "about": {r: access.ABOUT[r] for r in auth.SYSTEM_ROLES}}


class NewUserIn(BaseModel):
    name: str = Field(default="", max_length=200)
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=400)
    must_change_password: bool = True


def _clean_name(name: str) -> str:
    name = re.sub(r"\s+", " ", name or "").strip()
    if len(name) > 80:
        raise HTTPException(400, "a name of at most 80 characters")
    return name


async def _clean_email(email: str, but: str | None = None) -> str:
    email = (email or "").strip().lower()
    if not auth.EMAIL.match(email):
        raise HTTPException(400, "that does not look like an email address")
    other = await _raw()[auth.USERS].find_one({"email": email}, {"_id": 1})
    if other and other["_id"] != but:
        raise HTTPException(409, "another account has that address")
    return email


@router.post("/users")
async def add_user(body: NewUserIn) -> dict:
    _me()
    email = await _clean_email(body.email)
    problem = auth.password_problem(body.password)
    if problem:
        raise HTTPException(400, problem)
    uid = secrets.token_hex(8)
    u = {"_id": uid, "email": email, "name": _clean_name(body.name) or email,
         "pw": auth.hash_password(body.password), "created_at": auth._now(),
         "role": auth.USER, "space": "u" + uid, "created_by": actors.current().get("id")}
    if body.must_change_password:
        u["must_change_password"] = True
    await _raw()[auth.USERS].insert_one(u)
    await _audit("user-add", email, {"id": uid, "must_change_password": body.must_change_password})
    return await _out(await _target(uid))


class UserPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=200)
    disabled: bool | None = None
    role: str | None = Field(default=None, max_length=20)
    # profile.COLOURS, or "auto".
    avatar_colour: str | None = Field(default=None, max_length=20)


@router.patch("/users/{user_id}")
async def change_user(user_id: str, body: UserPatch) -> dict:
    me, my_role = _me()
    u = await _target(user_id)
    _may_manage(me, my_role, u)
    change: dict = {}
    if body.name is not None:
        name = _clean_name(body.name)
        if not name:
            raise HTTPException(400, "give a name - it is what the others see")
        if name != u.get("name"):
            change["name"] = name
    if body.email is not None:
        email = await _clean_email(body.email, but=user_id)
        if email != u["email"]:
            change["email"] = email
    if body.role is not None and body.role != auth.role_of(u):
        if my_role != "owner":
            raise HTTPException(403, "only the owner changes roles")
        if auth.role_of(u) == auth.OWNER:
            raise HTTPException(403, "the owner stays the owner")
        if body.role not in (auth.ADMIN, auth.USER):
            raise HTTPException(400, "a role is admin or user - there is one owner")
        change["role"] = body.role
    if body.disabled is not None and body.disabled != bool(u.get("disabled")):
        if auth.role_of(u) == auth.OWNER:
            raise HTTPException(403, "the owner cannot be disabled")
        if user_id == me.get("id"):
            raise HTTPException(400, "you cannot disable your own account")
        change["disabled"] = body.disabled
    colour, recolour = profile.colour_change(u, body.avatar_colour) if body.avatar_colour is not None else ({}, False)
    if not change and not recolour:
        return await _out(u)
    raw = _raw()
    if recolour:
        await raw[auth.USERS].update_one({"_id": user_id}, colour)
    if change:
        await raw[auth.USERS].update_one({"_id": user_id}, {"$set": change})
    ended = 0
    if change.get("disabled"):
        # Out at once, everywhere; its tokens stop with it (auth._maker_ok).
        ended = await auth.end_sessions_of(raw, user_id)
    auth.forget_sessions()
    detail: dict = {"fields": sorted([*change, *(["avatar_colour"] if recolour else [])])}
    if "role" in change:
        detail.update(role=change["role"], was=auth.role_of(u))
    if "email" in change:
        detail["was_email"] = u["email"]
    if "disabled" in change:
        detail.update(disabled=change["disabled"], signed_out=ended)
    action = "user-disable" if change.get("disabled") is True else \
        "user-enable" if change.get("disabled") is False else \
        "user-role" if "role" in change else "user-edit"
    await _audit(action, change.get("email") or u["email"], detail)
    return await _out(await _target(user_id))


class PasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=400)
    must_change_password: bool = True


@router.post("/users/{user_id}/password")
async def reset_password(user_id: str, body: PasswordIn) -> dict:
    """A temporary password: every session of the account ends, and - unless
    told not to - the next sign-in asks for a new one."""
    me, my_role = _me()
    u = await _target(user_id)
    _may_manage(me, my_role, u)
    problem = auth.password_problem(body.password)
    if problem:
        raise HTTPException(400, problem)
    raw = _raw()
    update: dict = {"$set": {"pw": auth.hash_password(body.password)}}
    if body.must_change_password:
        update["$set"]["must_change_password"] = True
    else:
        update["$unset"] = {"must_change_password": ""}
    await raw[auth.USERS].update_one({"_id": user_id}, update)
    ended = await auth.end_sessions_of(raw, user_id)
    auth.cleared(u["email"])
    await _audit("user-password", u["email"], {"must_change_password": body.must_change_password,
                                               "signed_out": ended})
    return {**await _out(await _target(user_id)), "signed_out": ended}


@router.post("/users/{user_id}/sign-out")
async def sign_out(user_id: str) -> dict:
    me, my_role = _me()
    u = await _target(user_id)
    _may_manage(me, my_role, u)
    ended = await auth.end_sessions_of(_raw(), user_id)
    await _audit("user-sign-out", u["email"], {"signed_out": ended})
    return {**await _out(await _target(user_id)), "signed_out": ended}


@router.put("/users/{user_id}/avatar")
async def set_avatar(user_id: str, file: UploadFile = File(...)) -> dict:
    me, my_role = _me()
    u = await _target(user_id)
    _may_manage(me, my_role, u)
    raw_bytes = await file.read(profile.MAX_UPLOAD + 1)
    if len(raw_bytes) > profile.MAX_UPLOAD:
        raise HTTPException(413, "a picture of at most 5 MB")
    if not raw_bytes:
        raise HTTPException(400, "the file is empty")
    try:
        jpeg = profile.square_jpeg(raw_bytes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    v = int(time.time() * 1000)
    await _raw()[auth.USERS].update_one({"_id": user_id}, {"$set": {"avatar": jpeg, "avatar_v": v}})
    auth.forget_sessions()
    await _audit("user-avatar", u["email"], {"bytes": len(jpeg)})
    return await _out(await _target(user_id))


@router.delete("/users/{user_id}/avatar")
async def drop_avatar(user_id: str) -> dict:
    me, my_role = _me()
    u = await _target(user_id)
    _may_manage(me, my_role, u)
    await _raw()[auth.USERS].update_one({"_id": user_id}, {"$unset": {"avatar": "", "avatar_v": ""}})
    auth.forget_sessions()
    await _audit("user-avatar", u["email"], {"removed": True})
    return await _out(await _target(user_id))


# Collections outside the scoped ones that name a space in `workspace`.
_BY_SPACE = ("agent_tokens", "agent_token_usage", "build_jobs", "board_jobs", "cc_gens")


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, with_data: bool = False) -> dict:
    """The account gone for good, with its sessions, tokens and Telegram
    link. If its private space holds anything, only with ?with_data=1 -
    and then that goes too."""
    me, my_role = _me()
    if my_role != "owner":
        raise HTTPException(403, "only the owner deletes accounts")
    u = await _target(user_id)
    if auth.role_of(u) == auth.OWNER:
        raise HTTPException(403, "the owner's account cannot be deleted")
    if user_id == me.get("id"):
        raise HTTPException(400, "you cannot delete your own account")
    space = auth.space_of(u)
    if space == scope.DEFAULT:
        raise HTTPException(409, "this account works in the owner's space - change that first")
    held = await _data_count(space)
    if held and not with_data:
        raise HTTPException(409, f"their private space holds {held} items - delete them too, or disable the account instead")
    raw = _raw()
    removed = 0
    if with_data:
        for name in sorted(scope.SCOPED):
            res = await raw[name].delete_many({"workspace_id": space})
            removed += int(getattr(res, "deleted_count", 0) or 0)
    for name in _BY_SPACE:
        await raw[name].delete_many({"workspace": space})
    await raw[auth.TOKENS].delete_many({"created_by.id": user_id})
    await auth.end_sessions_of(raw, user_id)
    await raw[auth.RESETS].delete_many({"user": user_id})
    from .tgbot import core as tg
    await raw[tg.LINKS].delete_many({"_id": user_id})
    await raw[tg.CODES].delete_many({"user": user_id})
    await raw[auth.USERS].delete_one({"_id": user_id})
    auth.forget_sessions()
    await _audit("user-delete", u["email"], {"id": user_id, "with_data": with_data, "removed": removed})
    return {"deleted": user_id, "removed": removed}


# ---------------------------------------------------------------- the overview

# The overview's periods: the activity chart's buckets (cc_chat.USAGE_SPANS).
_SPANS = {"day": 3600, "week": 86400, "month": 86400}
# What a person does that is not a change: signing in. Switching between
# accounts already signed in on a browser is neither, so it counts as nothing.
_SIGN_INS = ("sign-in",)
_NOT_COUNTED = ("switch",)
# The trail's lines that are not anybody's doing: a page opened for an agent.
_NOT_ACTIONS = ("page-session",)
# Folders at the top that are not projects: the shared parts library.
_NOT_PROJECTS = ("components",)
_FEED = 12


def _at(v) -> datetime | None:
    """A moment as the collections keep it - a date or an ISO text - in UTC."""
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str) and v:
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return None


def _space(doc: dict) -> str:
    return doc.get("workspace_id") or doc.get("workspace") or scope.DEFAULT


def _bare(_id: str) -> str:
    """A scoped id without its "@space" ending (scope.key)."""
    return str(_id).split("@", 1)[0]


@router.get("/overview")
async def overview(span: str = "week") -> dict:
    """The server at a glance, for the dashboard beside the accounts: what
    is kept in every space (projects, models, boards, files, chats), and
    what the people did over `span` (day: by hour; week, month: by day) -
    sign-ins, changes, chat messages, tool uses, by bucket and by person,
    the projects that moved most, the model calls and what they cost, and
    the latest lines of the trail. People are named by account id: the
    names are in GET /users beside it."""
    _me()
    if span not in _SPANS:
        raise HTTPException(400, f"span is one of {', '.join(_SPANS)}")
    from .cc_chat import _buckets
    raw = _raw()
    now = datetime.now(timezone.utc)
    keys, key = _buckets(span, now)
    step = _SPANS[span]
    # The first bucket's start, in the app's time zone: the chart's t0.
    tz = ZoneInfo(os.environ.get("REDLINE_TZ", "Europe/Istanbul"))
    since = datetime.fromisoformat(keys[0] + (":00" if step == 3600 else "T00:00")).replace(tzinfo=tz)
    since_iso = since.astimezone(timezone.utc).isoformat()
    users = {u["_id"]: u async for u in raw[auth.USERS].find({}, {"_id": 1, "space": 1, "role": 1})}
    owner_of = {auth.space_of(u): uid for uid, u in users.items()}

    # What is kept, everywhere - and in whose space.
    per_user: dict[str, dict] = {uid: {"sign_ins": 0, "changes": 0, "messages": 0, "tools": 0,
                                       "projects": 0, "models": 0, "files": 0} for uid in users}
    projects: dict[tuple[str, str], dict] = {}
    async for f in raw["folders"].find({"parent": ""}, {"_id": 1, "name": 1, "workspace_id": 1}):
        name = f.get("name") or _bare(f["_id"])
        if name in _NOT_PROJECTS:
            continue
        ws = _space(f)
        projects[(ws, name)] = {"name": name, "user": owner_of.get(ws), "models": 0, "boards": 0, "moves": 0}
        if owner_of.get(ws) in per_user:
            per_user[owner_of[ws]]["projects"] += 1

    def project(ws: str, path: str | None) -> dict | None:
        return projects.get((ws, (path or "").split("/", 1)[0])) if path else None

    models = 0
    async for m in raw["models"].find({}, {"folder": 1, "workspace_id": 1, "updated_at": 1}):
        models += 1
        ws = _space(m)
        if owner_of.get(ws) in per_user:
            per_user[owner_of[ws]]["models"] += 1
        if p := project(ws, m.get("folder")):
            p["models"] += 1
    boards = 0
    async for b in raw["boards"].find({}, {"folder": 1, "workspace_id": 1}):
        boards += 1
        if p := project(_space(b), b.get("folder")):
            p["boards"] += 1
    files = 0
    async for f in raw["files"].find({}, {"workspace_id": 1}):
        files += 1
        if owner_of.get(_space(f)) in per_user:
            per_user[owner_of[_space(f)]]["files"] += 1
    chats = messages = 0
    async for c in raw["cc_chats"].find({"deleted_at": None}, {"messages.role": 1}):
        chats += 1
        messages += len(c.get("messages") or [])
    messages += await raw["dm_messages"].count_documents({})

    # What the people did, bucket by bucket.
    names = ("Sign-ins", "Changes", "Messages", "Tool uses", "Agents")
    series = {n: [0] * len(keys) for n in names}
    slot = {k: i for i, k in enumerate(keys)}

    def count(name: str, when: datetime | None, uid: str | None = None, field: str | None = None) -> None:
        i = slot.get(key(when.isoformat())) if when else None
        if i is None:
            return
        series[name][i] += 1
        if uid in per_user and field:
            per_user[uid][field] += 1

    feed: list[dict] = []
    async for a in raw["audit"].find({"at": {"$gte": since}}, {"at": 1, "actor": 1, "action": 1, "target": 1}):
        act, who = a.get("action"), a.get("actor") or {}
        if act in _NOT_ACTIONS or act in _NOT_COUNTED:
            continue
        when = _at(a.get("at"))
        if who.get("type") != "user":
            count("Agents", when)
            continue
        if act in _SIGN_INS:
            count("Sign-ins", when, who.get("id"), "sign_ins")
        else:
            count("Changes", when, who.get("id"), "changes")
        if when:
            feed.append({"at": when.isoformat(), "user": who.get("id"), "action": act,
                         "target": str(a.get("target") or "")[:120]})
    async for g in raw["cc_gens"].find({"at": {"$gte": since_iso}}, {"at": 1, "actor": 1}):
        count("Messages", _at(g.get("at")), (g.get("actor") or {}).get("id"), "messages")
    async for d in raw["dm_messages"].find({"at": {"$gte": since_iso}}, {"at": 1, "by": 1}):
        count("Messages", _at(d.get("at")), (d.get("by") or {}).get("id"), "messages")
    async for u in raw["tool_usage"].find({"at": {"$gte": since}}, {"at": 1, "by": 1}):
        who = u.get("by") or {}
        if who.get("type") == "user":
            count("Tool uses", _at(u.get("at")), who.get("id"), "tools")
        else:
            count("Agents", _at(u.get("at")))

    # The projects that moved: versions asked for, models rebuilt.
    async for r in raw["revisions"].find({"created_at": {"$gte": since_iso}}, {"model": 1, "workspace_id": 1}):
        if p := project(_space(r), r.get("model")):
            p["moves"] += 1
    async for h in raw["item_history"].find({"at": {"$gte": since_iso}}, {"item": 1, "workspace_id": 1}):
        if p := project(_space(h), h.get("item")):
            p["moves"] += 1

    # The models' calls and what they cost.
    llm = {"calls": 0, "tokens": 0, "cost_usd": 0.0}
    by_model: dict[str, list] = {}
    cost = [0.0] * len(keys)
    async for c in raw["llm_calls"].find({"at": {"$gte": since_iso}},
                                         {"at": 1, "input": 1, "output": 1, "cost_usd": 1, "model": 1}):
        usd = float(c.get("cost_usd") or 0)
        llm["calls"] += 1
        llm["tokens"] += int(c.get("input") or 0) + int(c.get("output") or 0)
        llm["cost_usd"] += usd
        m = str(c.get("model") or "?").rsplit("/", 1)[-1]
        row = by_model.setdefault(m, [0.0, 0])
        row[0] += usd
        row[1] += 1
        when = _at(c.get("at"))
        i = slot.get(key(when.isoformat())) if when else None
        if i is not None:
            cost[i] += usd
    llm["cost_usd"] = round(llm["cost_usd"], 6)

    feed.sort(key=lambda x: x["at"], reverse=True)
    active = sorted(projects.values(), key=lambda p: (-p["moves"], -p["models"], p["name"]))
    return {
        "span": span, "since": since_iso,
        "totals": {"users": len(users), "projects": len(projects), "models": models, "boards": boards,
                   "files": files, "chats": chats, "messages": messages},
        "activity": {"t0": int(since.timestamp()), "step": step, "n": len(keys),
                     "series": [{"name": n, "values": v} for n, v in series.items()]},
        "people": [{"id": uid, **row} for uid, row in per_user.items()],
        "projects": [p for p in active if p["moves"] or p["models"] or p["boards"]][:8],
        "llm": {**llm, "cost": cost,
                "by_model": [{"name": k, "cost_usd": round(v[0], 6), "calls": v[1]}
                             for k, v in sorted(by_model.items(), key=lambda x: (-x[1][0], -x[1][1]))[:6]]},
        "feed": feed[:_FEED],
    }
