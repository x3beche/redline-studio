"""Signing in: accounts, passwords and sessions.

Off by default. `X3_AUTH=off` (or unset) is local mode: nobody signs in,
every request is the local user in the default workspace - the app as it
has always been on this machine. `X3_AUTH=on` asks every API request for a
session, except the few that sign in.

Passwords are hashed with scrypt from the standard library (no new
dependency), salted per account. A session is a random token held by the
browser in an HttpOnly cookie; the database keeps only its SHA-256, so a
copy of the database does not sign anyone in. Sessions are looked up
through a short in-memory cache - the database is far away, and every
request would otherwise pay a round trip. Changes must carry the
X-Redline-CSRF header, which only the app's own page sends: a page on
another site can make the browser send the cookie, but not that header.

The first account, made while there is none, owns the default workspace.
Invitations and roles are phase 5 (docs/USERS-PLAN.md).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

USERS = "users"
SESSIONS = "sessions"
WORKSPACES = "workspaces"
MEMBERS = "memberships"
INVITES = "invites"
INVITE_DAYS = 7

COOKIE = "redline_session"
CSRF_HEADER = "x-redline-csrf"
SESSION_DAYS = 30

# The routes a signed-out page may call: to know whether sign-in is on,
# to sign in, and to make the first account.
OPEN = {"/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/setup"}
# ... and an invitation's page, and accepting it: the link is the key.
OPEN_PREFIX = ("/api/invite/",)

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def enabled() -> bool:
    return os.environ.get("X3_AUTH", "off").strip().lower() in ("on", "1", "true", "yes")


# ---------------------------------------------------------------- passwords

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    n, r, p = 2 ** 15, 8, 1
    key = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt${n}${r}${p}${salt.hex()}${key.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, key = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r),
                             p=int(p), maxmem=64 * 1024 * 1024, dklen=len(bytes.fromhex(key)))
        return hmac.compare_digest(got, bytes.fromhex(key))
    except (ValueError, TypeError):
        return False


def password_problem(password: str) -> str | None:
    if len(password) < 10:
        return "use at least 10 characters"
    if len(password) > 200:
        return "that is longer than a password needs to be"
    return None


# ---------------------------------------------------------------- slowing guessing

# Failed sign-ins per address, in memory: five in fifteen minutes and that
# address waits. Enough to make guessing slow on a small, private server.
_FAILS: dict[str, list[float]] = {}
FAIL_WINDOW, FAIL_LIMIT = 15 * 60, 5


def locked_out(email: str) -> bool:
    now = time.time()
    recent = [t for t in _FAILS.get(email, []) if now - t < FAIL_WINDOW]
    _FAILS[email] = recent
    return len(recent) >= FAIL_LIMIT


def failed(email: str) -> None:
    _FAILS.setdefault(email, []).append(time.time())


def cleared(email: str) -> None:
    _FAILS.pop(email, None)


# ---------------------------------------------------------------- sessions

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


_CACHE: dict[str, tuple[float, dict | None]] = {}
CACHE_S = 60


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create_session(raw_db, user: dict, workspace: str, agent: str = "", ip: str = "") -> str:
    token = secrets.token_urlsafe(32)
    await raw_db[SESSIONS].insert_one({
        "_id": _digest(token), "user": user["_id"], "workspace": workspace,
        "created_at": _now(), "last_seen": _now(),
        "expires": _now() + timedelta(days=SESSION_DAYS),
        "agent": agent[:200], "ip": ip})
    return token


async def session_user(raw_db, token: str | None) -> dict | None:
    """The signed-in user and workspace for a token, or None."""
    if not token:
        return None
    key = _digest(token)
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    s = await raw_db[SESSIONS].find_one({"_id": key})
    out = None
    if s and s["expires"].replace(tzinfo=timezone.utc) > _now():
        u = await raw_db[USERS].find_one({"_id": s["user"]}, {"pw": 0})
        # Still a member, and in which role: a person taken out of the
        # workspace is signed out of it.
        m = await raw_db[MEMBERS].find_one({"user": s["user"], "workspace": s["workspace"]})
        if u and not u.get("disabled") and m:
            out = {"user": {"type": "user", "id": u["_id"], "name": u.get("name") or u["email"],
                            "email": u["email"]},
                   "workspace": s["workspace"], "role": m.get("role") or "viewer"}
            await raw_db[SESSIONS].update_one({"_id": key}, {"$set": {"last_seen": _now()}})
    _CACHE[key] = (time.time(), out)
    return out


async def end_session(raw_db, token: str | None) -> None:
    if token:
        _CACHE.pop(_digest(token), None)
        await raw_db[SESSIONS].delete_one({"_id": _digest(token)})


# ---------------------------------------------------------------- accounts

async def any_user(raw_db) -> bool:
    return bool(await raw_db[USERS].find_one({}, {"_id": 1}))


async def make_first_user(raw_db, email: str, name: str, password: str) -> dict:
    """The first account: it owns the default workspace. Refused once any
    account exists - after that, people are invited (phase 5)."""
    from . import scope
    email = email.strip().lower()
    if not EMAIL.match(email):
        raise ValueError("that does not look like an email address")
    problem = password_problem(password)
    if problem:
        raise ValueError(problem)
    if await any_user(raw_db):
        raise PermissionError("there is already an account - ask its owner for an invitation")
    user = {"_id": secrets.token_hex(8), "email": email, "name": (name or "").strip()[:80] or email,
            "pw": hash_password(password), "created_at": _now()}
    await raw_db[USERS].insert_one(user)
    await raw_db[WORKSPACES].update_one(
        {"_id": scope.DEFAULT},
        {"$setOnInsert": {"name": "Redline", "created_at": _now(), "created_by": user["_id"]}},
        upsert=True)
    await raw_db[MEMBERS].update_one(
        {"_id": f"{user['_id']}:{scope.DEFAULT}"},
        {"$set": {"user": user["_id"], "workspace": scope.DEFAULT, "role": "owner", "joined": _now()}},
        upsert=True)
    return user


async def check_login(raw_db, email: str, password: str) -> tuple[dict, str] | None:
    """The user and their workspace if the password is right, else None."""
    email = (email or "").strip().lower()
    u = await raw_db[USERS].find_one({"email": email})
    if not u:
        # Hash something anyway, so a wrong address takes as long as a
        # wrong password and does not say which it was.
        check_password(password or "", _dummy())
        return None
    if not check_password(password or "", u["pw"]) or u.get("disabled"):
        return None
    m = await raw_db[MEMBERS].find_one({"user": u["_id"]})
    if not m:
        return None          # taken out of every workspace: nothing to sign in to
    return u, m["workspace"]


_DUMMY: str | None = None


def _dummy() -> str:
    global _DUMMY
    if _DUMMY is None:
        _DUMMY = hash_password(secrets.token_hex(8))
    return _DUMMY


# ---------------------------------------------------------------- requests

def needs_session(method: str, path: str) -> bool:
    """Whether a request has to be signed in, when sign-in is on."""
    return path.startswith("/api/") and path not in OPEN and not path.startswith(OPEN_PREFIX)


def csrf_ok(method: str, headers) -> bool:
    """A change must come from the app's own page: it carries the header."""
    if method in ("GET", "HEAD", "OPTIONS"):
        return True
    return headers.get(CSRF_HEADER) == "1"


# ---------------------------------------------------------------- agent tokens

TOKENS = "agent_tokens"
TOKEN_PREFIX = "rlat_"
_TOKEN_CACHE: dict[str, tuple[float, dict | None]] = {}


async def create_agent_token(raw_db, name: str, workspace: str, room: str | None,
                             created_by: dict, role: str = "editor") -> tuple[str, dict]:
    """A token for one agent, in one workspace (and room, if given), with
    a role no higher than editor. The token itself is returned once and
    kept only as its SHA-256."""
    from . import access
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("give the agent a name - it is what the person sees")
    if role not in access.TOKEN_ROLES:
        raise ValueError("an agent is an editor, a reviewer or a viewer")
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    doc = {"_id": _digest(token), "id": secrets.token_hex(6), "name": name, "workspace": workspace,
           "room": room or None, "role": role, "created_by": created_by, "created_at": _now(),
           "last_used": None, "revoked": False}
    await raw_db[TOKENS].insert_one(doc)
    return token, {k: v for k, v in doc.items() if k != "_id"}


async def token_agent(raw_db, token: str) -> dict | None:
    """The agent a bearer token belongs to, or None if it is unknown or
    revoked."""
    if not token.startswith(TOKEN_PREFIX):
        return None
    key = _digest(token)
    hit = _TOKEN_CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    doc = await raw_db[TOKENS].find_one({"_id": key})
    out = None
    if doc and not doc.get("revoked"):
        out = {"actor": {"type": "agent", "id": doc["name"], "name": doc["name"], "token": doc["id"]},
               "workspace": doc["workspace"], "room": doc.get("room"),
               # Tokens from before roles were editors.
               "role": doc.get("role") or "editor"}
        await raw_db[TOKENS].update_one({"_id": key}, {"$set": {"last_used": _now()}})
    _TOKEN_CACHE[key] = (time.time(), out)
    return out


async def list_agent_tokens(raw_db, workspace: str) -> list[dict]:
    rows = [d async for d in raw_db[TOKENS].find({"workspace": workspace}, {"_id": 0})]
    rows.sort(key=lambda d: d.get("created_at") or _now(), reverse=True)
    return rows


async def revoke_agent_token(raw_db, token_id: str, workspace: str) -> bool:
    res = await raw_db[TOKENS].update_one({"id": token_id, "workspace": workspace},
                                          {"$set": {"revoked": True, "revoked_at": _now()}})
    _TOKEN_CACHE.clear()
    return bool(getattr(res, "matched_count", 0))


def bearer(headers) -> str | None:
    value = headers.get("authorization") or ""
    return value[7:].strip() if value.lower().startswith("bearer ") else None


# ---------------------------------------------------------------- members and invitations

def forget_sessions() -> None:
    """After a role change or a removal: look everyone up again."""
    _CACHE.clear()


async def members(raw_db, workspace: str) -> list[dict]:
    rows = []
    async for m in raw_db[MEMBERS].find({"workspace": workspace}):
        u = await raw_db[USERS].find_one({"_id": m["user"]}, {"pw": 0}) or {}
        rows.append({"id": m["user"], "name": u.get("name") or u.get("email") or m["user"],
                     "email": u.get("email"), "role": m.get("role") or "viewer",
                     "joined": m.get("joined"), "invited_by": m.get("invited_by")})
    from . import access
    rows.sort(key=lambda r: (access.rank(r["role"]), (r["name"] or "").lower()))
    return rows


async def set_role(raw_db, workspace: str, user_id: str, role: str, by_role: str) -> dict:
    """Change someone's role. Only an owner makes or unmakes owners, nobody
    gives a role above their own, and the last owner stays one."""
    from . import access
    if role not in access.ROLES:
        raise ValueError("roles: " + ", ".join(access.ROLES))
    m = await raw_db[MEMBERS].find_one({"user": user_id, "workspace": workspace})
    if not m:
        raise LookupError("not a member of this workspace")
    old = m.get("role") or "viewer"
    if access.rank(role) < access.rank(by_role) or access.rank(old) < access.rank(by_role):
        higher = min(role, old, key=access.rank)
        raise PermissionError(f"as {by_role} you cannot make or change an {higher}")
    if old == "owner" and role != "owner" and await _owners(raw_db, workspace) <= 1:
        raise PermissionError("the workspace needs an owner - make someone else owner first")
    await raw_db[MEMBERS].update_one({"_id": m["_id"]}, {"$set": {"role": role}})
    forget_sessions()
    return {"id": user_id, "role": role, "was": old}


async def remove_member(raw_db, workspace: str, user_id: str, by_role: str) -> None:
    from . import access
    m = await raw_db[MEMBERS].find_one({"user": user_id, "workspace": workspace})
    if not m:
        raise LookupError("not a member of this workspace")
    role = m.get("role") or "viewer"
    if access.rank(role) < access.rank(by_role):
        raise PermissionError(f"only an owner can take an {role} out")
    if role == "owner" and await _owners(raw_db, workspace) <= 1:
        raise PermissionError("the workspace needs an owner - make someone else owner first")
    await raw_db[MEMBERS].delete_one({"_id": m["_id"]})
    await raw_db[SESSIONS].delete_many({"user": user_id, "workspace": workspace})
    forget_sessions()


async def _owners(raw_db, workspace: str) -> int:
    return await raw_db[MEMBERS].count_documents({"workspace": workspace, "role": "owner"})


async def create_invite(raw_db, workspace: str, email: str, role: str, by: dict, by_role: str) -> tuple[str, dict]:
    """An invitation for one address, to one role, for a week. Returns the
    key for the link once; the database keeps its SHA-256."""
    from . import access
    email = (email or "").strip().lower()
    if not EMAIL.match(email):
        raise ValueError("that does not look like an email address")
    if role not in access.ROLES or role == "owner":
        raise ValueError("invite as admin, editor, reviewer or viewer - make an owner from the members list")
    if access.rank(role) < access.rank(by_role):
        raise PermissionError(f"as {by_role} you cannot invite an {role}")
    u = await raw_db[USERS].find_one({"email": email}, {"_id": 1})
    if u and await raw_db[MEMBERS].find_one({"user": u["_id"], "workspace": workspace}):
        raise ValueError("they are already a member")
    key = secrets.token_urlsafe(24)
    doc = {"_id": _digest(key), "id": secrets.token_hex(6), "workspace": workspace, "email": email,
           "role": role, "by": by, "created_at": _now(), "expires": _now() + timedelta(days=INVITE_DAYS)}
    await raw_db[INVITES].delete_many({"workspace": workspace, "email": email})     # one per address
    await raw_db[INVITES].insert_one(doc)
    return key, {k: v for k, v in doc.items() if k != "_id"}


async def invites(raw_db, workspace: str) -> list[dict]:
    rows = [d async for d in raw_db[INVITES].find({"workspace": workspace, "expires": {"$gt": _now()}},
                                                   {"_id": 0})]
    rows.sort(key=lambda d: d["created_at"], reverse=True)
    return rows


async def cancel_invite(raw_db, workspace: str, invite_id: str) -> bool:
    res = await raw_db[INVITES].delete_one({"workspace": workspace, "id": invite_id})
    return bool(res.deleted_count)


async def invite_info(raw_db, key: str) -> dict | None:
    """What the invitation's page shows: who asked, for which address and
    role, and whether that address has an account already."""
    inv = await raw_db[INVITES].find_one({"_id": _digest(key or "")})
    if not inv or inv["expires"].replace(tzinfo=timezone.utc) <= _now():
        return None
    ws = await raw_db[WORKSPACES].find_one({"_id": inv["workspace"]}) or {}
    return {"email": inv["email"], "role": inv["role"], "by": (inv.get("by") or {}).get("name"),
            "workspace": ws.get("name") or inv["workspace"],
            "has_account": bool(await raw_db[USERS].find_one({"email": inv["email"]}, {"_id": 1}))}


async def accept_invite(raw_db, key: str, name: str, password: str) -> tuple[dict, str, str]:
    """Join: a new account with the invited address, or - if it has one -
    the right password for it. Returns the user, workspace and role."""
    inv = await raw_db[INVITES].find_one({"_id": _digest(key or "")})
    if not inv or inv["expires"].replace(tzinfo=timezone.utc) <= _now():
        raise LookupError("this invitation has expired or was taken back - ask for a new one")
    u = await raw_db[USERS].find_one({"email": inv["email"]})
    if u:
        if locked_out(inv["email"]):
            raise PermissionError("too many tries - wait a few minutes")
        if not check_password(password or "", u["pw"]) or u.get("disabled"):
            failed(inv["email"])
            raise PermissionError("that is not the password for " + inv["email"])
    else:
        problem = password_problem(password or "")
        if problem:
            raise ValueError(problem)
        u = {"_id": secrets.token_hex(8), "email": inv["email"],
             "name": (name or "").strip()[:80] or inv["email"], "pw": hash_password(password),
             "created_at": _now()}
        await raw_db[USERS].insert_one(u)
    await raw_db[MEMBERS].update_one(
        {"_id": f"{u['_id']}:{inv['workspace']}"},
        {"$set": {"user": u["_id"], "workspace": inv["workspace"], "role": inv["role"],
                  "joined": _now(), "invited_by": inv.get("by")}},
        upsert=True)
    await raw_db[INVITES].delete_one({"_id": inv["_id"]})
    return u, inv["workspace"], inv["role"]
