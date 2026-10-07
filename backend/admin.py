"""The admin panel: the server's accounts, for the owner and the admins.

    GET    /api/admin/users                     everyone, with role, status, last sign-in
    POST   /api/admin/users                     add an account (there is no sign-up)
    PATCH  /api/admin/users/{id}                name, email, enabled/disabled, role (owner only)
    POST   /api/admin/users/{id}/password       a temporary password, changed at next sign-in
    POST   /api/admin/users/{id}/sign-out       end every session of the account
    PUT    /api/admin/users/{id}/avatar         a new picture (profile.py's square JPEG)
    DELETE /api/admin/users/{id}/avatar         no picture
    DELETE /api/admin/users/{id}[?with_data=1]  delete the account (owner only)

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

import re
import secrets
import time

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
    if not change:
        return await _out(u)
    raw = _raw()
    await raw[auth.USERS].update_one({"_id": user_id}, {"$set": change})
    ended = 0
    if change.get("disabled"):
        # Out at once, everywhere; its tokens stop with it (auth._maker_ok).
        ended = await auth.end_sessions_of(raw, user_id)
    auth.forget_sessions()
    detail: dict = {"fields": sorted(change)}
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
