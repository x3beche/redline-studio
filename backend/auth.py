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

COOKIE = "redline_session"
CSRF_HEADER = "x-redline-csrf"
SESSION_DAYS = 30

# The routes a signed-out page may call: to know whether sign-in is on,
# to sign in, and to make the first account.
OPEN = {"/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/setup"}

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
        if u and not u.get("disabled"):
            out = {"user": {"type": "user", "id": u["_id"], "name": u.get("name") or u["email"],
                            "email": u["email"]},
                   "workspace": s["workspace"]}
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
    return u, (m or {}).get("workspace") or "default"


_DUMMY: str | None = None


def _dummy() -> str:
    global _DUMMY
    if _DUMMY is None:
        _DUMMY = hash_password(secrets.token_hex(8))
    return _DUMMY


# ---------------------------------------------------------------- requests

def needs_session(method: str, path: str) -> bool:
    """Whether a request has to be signed in, when sign-in is on."""
    return path.startswith("/api/") and path not in OPEN


def csrf_ok(method: str, headers) -> bool:
    """A change must come from the app's own page: it carries the header."""
    if method in ("GET", "HEAD", "OPTIONS"):
        return True
    return headers.get(CSRF_HEADER) == "1"
