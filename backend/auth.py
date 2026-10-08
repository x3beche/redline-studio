"""Signing in: accounts, passwords and sessions.

Off by default. `REDLINE_REQUIRE_SIGNIN=false` (or unset) is local mode:
nobody signs in, every request is the local user in the default workspace -
for one person on their own machine. `REDLINE_REQUIRE_SIGNIN=true` asks
every API request for a session, except the few that sign in. (The old
name, `REDLINE_REQUIRE_SIGNIN=true`, still works.)

Passwords are hashed with scrypt from the standard library (no new
dependency), salted per account. A session is a random token held by the
browser in an HttpOnly cookie; the database keeps only its SHA-256, so a
copy of the database does not sign anyone in. Sessions are looked up
through a short in-memory cache - the database is far away, and every
request would otherwise pay a round trip. Changes must carry the
X-Redline-CSRF header, which only the app's own page sends: a page on
another site can make the browser send the cookie, but not that header.

Accounts have a system role (`users.role`): the **owner** - the first
account, made at setup; there is one and it cannot be demoted, disabled or
deleted - **admin**s, who run the server's settings and the accounts, and
**user**s. Nobody signs themselves up: the owner and the admins add
accounts (backend/admin.py). Each account works in a private space of its
own (`users.space`, backend/scope.py): the owner's is "default", where the
data from before accounts lives; anyone else starts with an empty one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

USERS = "users"
SESSIONS = "sessions"
RESETS = "password_resets"
RESET_MINUTES = 60

COOKIE = "redline_session"
CSRF_HEADER = "x-redline-csrf"
SESSION_DAYS = 30

# The routes a signed-out page may call: to know whether sign-in is on,
# to sign in, and to make the first account.
OPEN = {"/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/setup",
        # the accounts this browser remembers: the chooser a signed-out page
        # shows, switching to one and removing them (backend/accounts.py,
        # which checks the CSRF header itself)
        "/api/auth/accounts", "/api/auth/switch", "/api/auth/forget", "/api/auth/forget-all",
        # Telegram's updates: no session, but the webhook's secret header (backend/tgbot/api.py)
        "/api/telegram/webhook"}
# ... and a password-reset link's page: the link is the key.
OPEN_PREFIX = ("/api/reset/", "/api/auth/accounts/")

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def enabled() -> bool:
    return os.environ.get("REDLINE_REQUIRE_SIGNIN", "false").strip().lower() in ("on", "1", "true", "yes")


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
    # When they last signed in, for their profile (backend/profile.py).
    await raw_db[USERS].update_one({"_id": user["_id"]}, {"$set": {"last_sign_in": _now()}})
    return token


async def session_user(raw_db, token: str | None) -> dict | None:
    """The signed-in user, their private space and system role for a
    token, or None. A disabled account signs nobody in."""
    if not token:
        return None
    key = _digest(token)
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        # A page session is minutes long: the cache must not outlive it.
        if hit[1] and hit[1].get("until") and hit[1]["until"] <= time.time():
            return None
        return hit[1]
    s = await raw_db[SESSIONS].find_one({"_id": key})
    out = None
    if s and s.get("kind") == PAGE_KIND:
        out = await _page_session(raw_db, s)
    # Only a plain session signs in here: a remembered account's token
    # (below) is not one, even put in this cookie by hand.
    elif s and not s.get("kind") and s["expires"].replace(tzinfo=timezone.utc) > _now():
        u = await raw_db[USERS].find_one({"_id": s["user"]}, {"pw": 0, "avatar": 0})
        # The account as it is now: its role and space are read from it,
        # not from the session, so a change takes effect at once.
        if u and not u.get("disabled"):
            out = {"user": {"type": "user", "id": u["_id"], "name": u.get("name") or u["email"],
                            "email": u["email"], "has_avatar": bool(u.get("avatar_v")),
                            "avatar_v": u.get("avatar_v"), "avatar_colour": u.get("avatar_colour") or "auto"},
                   "workspace": space_of(u), "role": role_of(u),
                   "must_change_password": bool(u.get("must_change_password"))}
            await raw_db[SESSIONS].update_one({"_id": key}, {"$set": {"last_seen": _now()}})
    _CACHE[key] = (time.time(), out)
    return out


# ---------------------------------------------------------------- page sessions

# A headless browser photographing the app (tools/render.py)
# is no person and has no password. It gets a page session: minted from an
# agent's token (POST /api/auth/page-session) or by the server for the
# person or agent who asked for the shot, and it is
#   - short: PAGE_MINUTES, after which it signs nobody in,
#   - read-only: a viewer, and on top of that GET/HEAD only
#     (access.page_allowed), so not even a viewer's few POSTs,
#   - in the space (and room) of whoever it came from, and only while
#     that source is good: a revoked token, or a disabled account, ends it
#     at once.
# Like every session, only its SHA-256 is stored.
PAGE_KIND = "page"
PAGE_MINUTES = 10
PAGE_ROLE = "viewer"


async def create_page_session(raw_db, workspace: str, actor: dict, *, token_id: str | None = None,
                              user_id: str | None = None, room: str | None = None,
                              minutes: int = PAGE_MINUTES) -> tuple[str, datetime]:
    """A short read-only session for a headless browser. Exactly one source:
    the agent token's id, or the user's id. Returns the cookie's value and
    when it expires."""
    if bool(token_id) == bool(user_id):
        raise ValueError("a page session comes from one agent token or one person")
    minutes = max(1, min(int(minutes), PAGE_MINUTES))
    token = secrets.token_urlsafe(32)
    expires = _now() + timedelta(minutes=minutes)
    await raw_db[SESSIONS].insert_one({
        "_id": _digest(token), "kind": PAGE_KIND, "workspace": workspace, "room": room or None,
        "actor": {k: actor.get(k) for k in ("type", "id", "name", "token") if actor.get(k)},
        "via_token": token_id, "user": user_id, "role": PAGE_ROLE,
        "created_at": _now(), "last_seen": _now(), "expires": expires})
    return token, expires


async def page_session_for_request(raw_db) -> dict | None:
    """A page session for whoever is asking right now, so the server's own
    headless browser can show them one of this app's pages. None with
    sign-in off: the page needs none.
    Returns {name, value} for the browser's cookie jar."""
    if not enabled():
        return None
    from . import actors, scope
    who = actors.current()
    if who.get("page"):
        raise PermissionError("a page session does not make page sessions")
    if who.get("type") == "agent" and who.get("token"):
        value, _ = await create_page_session(raw_db, scope.current(), who, token_id=who["token"])
    elif who.get("type") == "user" and who.get("id") not in (None, "local"):
        value, _ = await create_page_session(raw_db, scope.current(), who, user_id=who["id"])
    else:
        raise PermissionError("nobody signed in to make a page session for")
    return {"name": COOKIE, "value": value}


async def _page_session(raw_db, s: dict) -> dict | None:
    """Who a page session is, if it is still good."""
    expires = s["expires"].replace(tzinfo=timezone.utc)
    if expires <= _now():
        return None
    if s.get("via_token"):
        t = await raw_db[TOKENS].find_one({"id": s["via_token"]})
        if not t or t.get("revoked") or token_expired(t) or t.get("workspace") != s["workspace"] \
                or not await _maker_ok(raw_db, t):
            return None
    elif s.get("user"):
        u = await raw_db[USERS].find_one({"_id": s["user"]}, {"pw": 0, "avatar": 0})
        if not u or u.get("disabled") or space_of(u) != s["workspace"]:
            return None
    else:
        return None
    return {"user": {**s.get("actor", {}), "page": True}, "workspace": s["workspace"],
            "room": s.get("room"), "role": PAGE_ROLE, "page": True, "until": expires.timestamp()}


async def end_session(raw_db, token: str | None) -> None:
    if token:
        _CACHE.pop(_digest(token), None)
        await raw_db[SESSIONS].delete_one({"_id": _digest(token)})


# ---------------------------------------------------------------- remembered accounts

# "Remember me" keeps an account on this browser, so the person can switch
# between several without a password (backend/accounts.py). Each one is a
# token of its own, kept with the sessions as kind "remember" and, like
# them, only as its SHA-256: everything that signs an account out
# everywhere (a new password, a reset link, disabling or deleting it) ends
# these too, because they are found by `user` like any session. A remember
# token is never a session itself: it only buys one, for the account it was
# made for, while that account is enabled and the token is neither revoked
# nor past REMEMBER_DAYS. It is looked up afresh every time - no cache - so
# a revoked one is refused at once.
#
# The browser holds its tokens in one HttpOnly cookie, DEVICE_COOKIE: a
# short list of {t: token, u: account id, e: email, n: name}. The address
# and name are there only so a row whose token has died can still say whose
# it was ("sign in again"); a live row is drawn from the account itself.
REMEMBER_KIND = "remember"
REMEMBER_DAYS = 90
DEVICE_COOKIE = "redline_device"
DEVICE_MAX = 8


def read_device(value: str | None) -> list[dict]:
    """The rows of a device cookie; anything malformed is dropped, never
    trusted - an account is only ever what its token's record says."""
    if not value:
        return []
    try:
        rows = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    except (ValueError, TypeError):
        return []
    out: list[dict] = []
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict) or not all(isinstance(r.get(k), str) and r.get(k) for k in ("t", "u", "e")):
            continue
        if len(r["t"]) > 64 or any(x["u"] == r["u"] for x in out):
            continue
        out.append({"t": r["t"], "u": r["u"][:40], "e": r["e"][:120], "n": str(r.get("n") or "")[:60]})
        if len(out) >= DEVICE_MAX:
            break
    return out


def write_device(rows: list[dict]) -> str:
    rows = [{k: r[k] for k in ("t", "u", "e", "n")} for r in rows[:DEVICE_MAX]]
    return base64.urlsafe_b64encode(json.dumps(rows, separators=(",", ":")).encode()).decode().rstrip("=")


async def create_remember(raw_db, user: dict, agent: str = "", ip: str = "") -> str:
    token = secrets.token_urlsafe(32)
    await raw_db[SESSIONS].insert_one({
        "_id": _digest(token), "kind": REMEMBER_KIND, "user": user["_id"],
        "created_at": _now(), "last_seen": _now(),
        "expires": _now() + timedelta(days=REMEMBER_DAYS), "agent": agent[:200], "ip": ip})
    return token


async def remembered(raw_db, token: str | None, user_id: str | None = None) -> dict | None:
    """The account a remember token is for, if it still is: the token known,
    of that kind, in date, and - when `user_id` is given - for that very
    account; the account there and enabled. None otherwise."""
    if not token or len(token) > 64:
        return None
    s = await raw_db[SESSIONS].find_one({"_id": _digest(token)})
    if not s or s.get("kind") != REMEMBER_KIND or (user_id is not None and s.get("user") != user_id):
        return None
    if _aware(s.get("expires")) is None or _aware(s["expires"]) <= _now():
        return None
    u = await raw_db[USERS].find_one({"_id": s["user"]}, {"pw": 0, "avatar": 0})
    if not u or u.get("disabled"):
        return None
    return u


async def used_remember(raw_db, token: str) -> None:
    """A remembered account was switched to: it lasts REMEMBER_DAYS from now."""
    await raw_db[SESSIONS].update_one({"_id": _digest(token), "kind": REMEMBER_KIND},
                                      {"$set": {"last_seen": _now(),
                                                "expires": _now() + timedelta(days=REMEMBER_DAYS)}})


async def forget_remember(raw_db, token: str | None, user_id: str) -> bool:
    """Revoke one remember token, only if it is that account's."""
    if not token:
        return False
    res = await raw_db[SESSIONS].delete_one({"_id": _digest(token), "kind": REMEMBER_KIND, "user": user_id})
    return bool(getattr(res, "deleted_count", 0))


def device_digests(value: str | None) -> list[str]:
    """The stored keys of a device cookie's tokens: what "this device" is
    when an account signs out everywhere else."""
    return [_digest(r["t"]) for r in read_device(value)]


# Switching is cheap to try, so it is counted like signing in: per address
# (the browser), at most SWITCH_LIMIT in a minute; and a token refused for
# an account five times in fifteen minutes (failed/locked_out above, keyed
# "switch:<id>") locks switching to that account for a while.
SWITCH_LIMIT, SWITCH_WINDOW = 30, 60
_HITS: dict[str, list[float]] = {}


def too_fast(key: str, limit: int = SWITCH_LIMIT, window: float = SWITCH_WINDOW) -> bool:
    """Counts one try for `key`; True once there were `limit` in `window`."""
    now = time.time()
    recent = [t for t in _HITS.get(key, []) if now - t < window]
    recent.append(now)
    _HITS[key] = recent
    return len(recent) > limit


# ---------------------------------------------------------------- accounts

async def any_user(raw_db) -> bool:
    return bool(await raw_db[USERS].find_one({}, {"_id": 1}))


async def make_first_user(raw_db, email: str, name: str, password: str) -> dict:
    """The first account: the owner, in the default space. Refused once any
    account exists - after that, the owner and the admins add accounts."""
    from . import scope
    email = email.strip().lower()
    if not EMAIL.match(email):
        raise ValueError("that does not look like an email address")
    problem = password_problem(password)
    if problem:
        raise ValueError(problem)
    if await any_user(raw_db):
        raise PermissionError("there is already an account - ask the owner or an admin to add yours")
    user = {"_id": secrets.token_hex(8), "email": email, "name": (name or "").strip()[:80] or email,
            "pw": hash_password(password), "created_at": _now(), "role": OWNER, "space": scope.DEFAULT}
    await raw_db[USERS].insert_one(user)
    return user


async def check_login(raw_db, email: str, password: str) -> tuple[dict, str] | None:
    """The user and their space if the password is right, else None."""
    email = (email or "").strip().lower()
    u = await raw_db[USERS].find_one({"email": email})
    if not u:
        # Hash something anyway, so a wrong address takes as long as a
        # wrong password and does not say which it was.
        check_password(password or "", _dummy())
        return None
    if not check_password(password or "", u["pw"]) or u.get("disabled"):
        return None
    return u, space_of(u)


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
                             created_by: dict, role: str = "editor",
                             expires_days: int | None = None) -> tuple[str, dict]:
    """A token for one agent, in one account's space (and room, if given), with
    a role no higher than editor, and - if asked - a last day. The token
    itself is returned once and kept only as its SHA-256."""
    from . import access
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("give the agent a name - it is what the person sees")
    if role not in access.TOKEN_ROLES:
        raise ValueError("an agent is an editor, a reviewer or a viewer")
    if expires_days is not None and not 1 <= int(expires_days) <= 3650:
        raise ValueError("a token lasts from 1 to 3650 days, or for good")
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = _now()
    doc = {"_id": _digest(token), "id": secrets.token_hex(6), "name": name, "workspace": workspace,
           "room": room or None, "role": role, "created_by": created_by, "created_at": now,
           "expires_at": now + timedelta(days=int(expires_days)) if expires_days else None,
           "last_used": None, "revoked": False}
    await raw_db[TOKENS].insert_one(doc)
    out = {k: v for k, v in doc.items() if k != "_id"}
    return token, {**out, "status": token_status(out)}


def _aware(d: datetime | None) -> datetime | None:
    """Mongo hands datetimes back naive; they are UTC."""
    return d.replace(tzinfo=timezone.utc) if d is not None and d.tzinfo is None else d


def token_expired(doc: dict) -> bool:
    exp = _aware(doc.get("expires_at"))
    return bool(exp and exp <= _now())


def token_status(doc: dict) -> str:
    """active, revoked or expired - what the settings page shows."""
    if doc.get("revoked"):
        return "revoked"
    return "expired" if token_expired(doc) else "active"


async def token_agent(raw_db, token: str) -> dict | None:
    """The agent a bearer token belongs to, or None if it is unknown or
    revoked."""
    if not token.startswith(TOKEN_PREFIX):
        return None
    key = _digest(token)
    hit = _TOKEN_CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        out = hit[1]
        # A token that ran out while it was remembered is refused all the same.
        return None if out and out.get("expires_at") and _aware(out["expires_at"]) <= _now() else out
    doc = await raw_db[TOKENS].find_one({"_id": key})
    out = None
    if doc and not doc.get("revoked") and not token_expired(doc) and await _maker_ok(raw_db, doc):
        out = {"actor": {"type": "agent", "id": doc["name"], "name": doc["name"], "token": doc["id"]},
               "workspace": doc["workspace"], "room": doc.get("room"),
               # Tokens from before roles were editors.
               "role": doc.get("role") or "editor", "expires_at": doc.get("expires_at")}
        await raw_db[TOKENS].update_one({"_id": key}, {"$set": {"last_used": _now()}})
    _TOKEN_CACHE[key] = (time.time(), out)
    return out


async def _maker_ok(raw_db, doc: dict) -> bool:
    """A token works only while the account that made it is enabled: a
    disabled account's tokens stop (a deleted one's are deleted with it,
    backend/admin.py). Tokens made in local mode, or by no one, have no
    account to ask."""
    by = doc.get("created_by") or {}
    if by.get("type") != "user" or by.get("id") in (None, "", "local"):
        return True
    u = await raw_db[USERS].find_one({"_id": by["id"]}, {"disabled": 1})
    return not (u and u.get("disabled"))


async def list_agent_tokens(raw_db, workspace: str) -> list[dict]:
    """A space's tokens, newest first - never the token or its hash."""
    rows = [{k: v for k, v in d.items() if k != "_id"}
            async for d in raw_db[TOKENS].find({"workspace": workspace}, {"_id": 0})]
    for r in rows:
        r["status"] = token_status(r)
    rows.sort(key=lambda d: _aware(d.get("created_at")) or _now(), reverse=True)
    return rows


async def revoke_agent_token(raw_db, token_id: str, workspace: str) -> bool:
    res = await raw_db[TOKENS].update_one({"id": token_id, "workspace": workspace},
                                          {"$set": {"revoked": True, "revoked_at": _now()}})
    _TOKEN_CACHE.clear()
    # The page sessions it minted go with it.
    await raw_db[SESSIONS].delete_many({"kind": PAGE_KIND, "via_token": token_id})
    forget_sessions()
    return bool(getattr(res, "matched_count", 0))


async def delete_agent_token(raw_db, token_id: str, workspace: str) -> dict | None:
    """Gone for good: taken back first (its page sessions end with it),
    then the record and its usage counts removed. The audit trail keeps
    what it did. Returns the record it was, or None if there was none."""
    doc = await raw_db[TOKENS].find_one({"id": token_id, "workspace": workspace}, {"_id": 0})
    if not doc:
        return None
    await revoke_agent_token(raw_db, token_id, workspace)
    await raw_db[TOKENS].delete_one({"id": token_id, "workspace": workspace})
    await raw_db[TOKEN_USAGE].delete_many({"token": token_id})
    _TOKEN_CACHE.clear()
    return doc


# ---------------------------------------------------------------- agent token usage
#
# Every request an agent makes with its token is counted, per token and
# day: how many, reads against writes, and by what the request was
# (backend/access.py's actions). Counting must not slow the request, so the
# middleware only adds to a tally in memory; a task writes the tally out a
# few seconds later as one $inc per token and day. The days are kept half
# a year (a TTL index on `at`).

TOKEN_USAGE = "agent_token_usage"
USAGE_KEEP_DAYS = 180
USAGE_FLUSH_S = 5.0
_USAGE: dict[tuple[str, str, str], dict[str, int]] = {}
_USAGE_DB = None
_USAGE_TASK = None
_USAGE_INDEXED = False


def count_usage(raw_db, token_id: str, workspace: str, method: str, act: str | None = None) -> None:
    """One request by a token: into the tally, and a write-out scheduled.
    No awaiting, no database: cheap enough for every request."""
    import asyncio
    global _USAGE_DB, _USAGE_TASK
    day = _now().strftime("%Y-%m-%d")
    row = _USAGE.setdefault((token_id, workspace, day), {})
    kind = "read" if method in ("GET", "HEAD", "OPTIONS") else "write"
    for k in ("n", kind) + ((f"acts.{act}",) if act else ()):
        row[k] = row.get(k, 0) + 1
    _USAGE_DB = raw_db
    if _USAGE_TASK is None or _USAGE_TASK.done():
        try:
            _USAGE_TASK = asyncio.get_running_loop().create_task(_flush_later())
        except RuntimeError:                       # no loop: the next flush takes it
            _USAGE_TASK = None


async def _flush_later() -> None:
    import asyncio
    await asyncio.sleep(USAGE_FLUSH_S)
    await flush_usage()


async def flush_usage(raw_db=None) -> int:
    """Write the tally out: one upsert per token and day. Never raises."""
    global _USAGE_INDEXED
    db = raw_db if raw_db is not None else _USAGE_DB
    if db is None or not _USAGE:
        return 0
    rows = list(_USAGE.items())
    _USAGE.clear()
    coll = db[TOKEN_USAGE]
    if not _USAGE_INDEXED:
        _USAGE_INDEXED = True
        try:
            await coll.create_index("at", expireAfterSeconds=USAGE_KEEP_DAYS * 86400)
            await coll.create_index([("workspace", 1), ("day", 1)])
        except Exception:                            # noqa: BLE001 - counting matters more
            pass
    for (token_id, ws, day), inc in rows:
        try:
            await coll.update_one(
                {"_id": f"{token_id}:{day}"},
                {"$inc": inc, "$set": {"token": token_id, "workspace": ws, "day": day,
                                        "at": datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)}},
                upsert=True)
        except Exception:                            # noqa: BLE001
            pass
    return len(rows)


def bearer(headers) -> str | None:
    value = headers.get("authorization") or ""
    return value[7:].strip() if value.lower().startswith("bearer ") else None


# ---------------------------------------------------------------- system roles and spaces

def forget_sessions() -> None:
    """After a role change, a disabled account or a removal: look everyone
    (and every agent token) up again."""
    _CACHE.clear()
    _TOKEN_CACHE.clear()


OWNER, ADMIN, USER = "owner", "admin", "user"
SYSTEM_ROLES = (OWNER, ADMIN, USER)


def role_of(u: dict | None) -> str:
    """An account's system role; one from before roles is a user (the
    migration makes the first account the owner)."""
    r = (u or {}).get("role")
    return r if r in SYSTEM_ROLES else USER


def space_of(u: dict) -> str:
    """The private space an account works in (backend/scope.py): the
    owner's is the default one, everyone else's their own."""
    from . import scope
    if u.get("space"):
        return u["space"]
    return scope.DEFAULT if u.get("role") == OWNER else "u" + str(u["_id"])


async def migrate(raw_db) -> dict:
    """From workspaces and members to system roles - idempotent, run at
    start-up. The owner is the account that owned the default workspace
    (else the oldest account); it keeps the default space and its data.
    Every other account gets a role (an admin of the default workspace
    stays an admin, anyone else is a user) and a private space of its own.
    The old `memberships`, `workspaces` and `invites` collections are left
    as they were and no longer read."""
    from . import scope
    done = {"owner": None, "updated": 0}
    users = [u async for u in raw_db[USERS].find({}, {"pw": 0, "avatar": 0})]
    if not users:
        return done
    owner = next((u for u in users if u.get("role") == OWNER), None)
    old_roles: dict[str, str] = {}
    try:
        async for m in raw_db["memberships"].find({"workspace": scope.DEFAULT}):
            old_roles[m.get("user")] = m.get("role") or ""
    except Exception:                                   # noqa: BLE001 - no memberships is fine
        pass
    if owner is None:
        owned = [u for u in users if old_roles.get(u["_id"]) == "owner"]
        pool = owned or users
        owner = min(pool, key=lambda u: (_aware(u.get("created_at")) or _now(), str(u["_id"])))
    for u in users:
        patch: dict = {}
        if u["_id"] == owner["_id"]:
            if u.get("role") != OWNER:
                patch["role"] = OWNER
            if u.get("space") != scope.DEFAULT:
                patch["space"] = scope.DEFAULT
        else:
            if u.get("role") not in (ADMIN, USER):
                patch["role"] = ADMIN if old_roles.get(u["_id"]) in ("owner", "admin") else USER
            if not u.get("space") or u.get("space") == scope.DEFAULT:
                patch["space"] = "u" + str(u["_id"])
        if patch:
            await raw_db[USERS].update_one({"_id": u["_id"]}, {"$set": patch})
            done["updated"] += 1
    done["owner"] = owner["_id"]
    if done["updated"]:
        forget_sessions()
    return done


# What a session that must choose a new password may still ask for: to
# choose it, to know who it is, and to leave.
BEFORE_NEW_PASSWORD = frozenset({"/api/auth/new-password", "/api/auth/logout", "/api/auth/state",
                                 "/api/me", "/api/health"})


async def set_own_new_password(raw_db, user_id: str, password: str, keep_token: str | None,
                               device: str | None = None) -> int:
    """The person's own password in place of the one an admin set. Only
    while the account is asked to change it; it must differ from that one.
    Every other session ends - all but this one and, if this browser
    remembers the account, its remember token (`device`, the cookie).
    Returns how many."""
    u = await raw_db[USERS].find_one({"_id": user_id})
    if not u or u.get("disabled"):
        raise PermissionError("no such account")
    if not u.get("must_change_password"):
        raise PermissionError("your password does not need changing here - use Settings > Profile")
    problem = password_problem(password or "")
    if problem:
        raise ValueError(problem)
    if check_password(password, u.get("pw") or ""):
        raise ValueError("choose a password other than the one you were given")
    await raw_db[USERS].update_one({"_id": user_id}, {"$set": {"pw": hash_password(password)},
                                                      "$unset": {"must_change_password": ""}})
    keep = [_digest(keep_token or ""), *device_digests(device)]
    res = await raw_db[SESSIONS].delete_many({"user": user_id, "_id": {"$nin": keep}})
    forget_sessions()
    return int(getattr(res, "deleted_count", 0) or 0)


async def end_sessions_of(raw_db, user_id: str) -> int:
    """Sign an account out everywhere, page sessions included."""
    res = await raw_db[SESSIONS].delete_many({"user": user_id})
    forget_sessions()
    return int(getattr(res, "deleted_count", 0) or 0)


# ---------------------------------------------------------------- forgotten passwords

async def create_reset(raw_db, email: str) -> tuple[str, dict]:
    """A one-use link, good for an hour, that sets a new password for one
    account. Made on the machine itself (tools/account.py): whoever can run
    that can reach the database anyway. The key is kept as its SHA-256."""
    email = (email or "").strip().lower()
    u = await raw_db[USERS].find_one({"email": email}, {"_id": 1, "email": 1})
    if not u:
        raise LookupError(f"no account for {email}")
    key = secrets.token_urlsafe(24)
    await raw_db[RESETS].delete_many({"user": u["_id"]})          # one at a time
    doc = {"_id": _digest(key), "user": u["_id"], "email": u["email"], "created_at": _now(),
           "expires": _now() + timedelta(minutes=RESET_MINUTES)}
    await raw_db[RESETS].insert_one(doc)
    return key, doc


async def reset_info(raw_db, key: str) -> dict | None:
    r = await raw_db[RESETS].find_one({"_id": _digest(key or "")})
    if not r or r["expires"].replace(tzinfo=timezone.utc) <= _now():
        return None
    return {"email": r["email"]}


async def use_reset(raw_db, key: str, password: str) -> tuple[dict, str]:
    """Set the new password; every other session of the account ends.
    Returns the user and the space to sign in to."""
    r = await raw_db[RESETS].find_one({"_id": _digest(key or "")})
    if not r or r["expires"].replace(tzinfo=timezone.utc) <= _now():
        raise LookupError("this link has expired or was used - make a new one")
    problem = password_problem(password or "")
    if problem:
        raise ValueError(problem)
    await raw_db[USERS].update_one({"_id": r["user"]}, {"$set": {"pw": hash_password(password)}})
    await raw_db[SESSIONS].delete_many({"user": r["user"]})
    await raw_db[RESETS].delete_one({"_id": r["_id"]})
    forget_sessions()
    cleared(r["email"])
    u = await raw_db[USERS].find_one({"_id": r["user"]})
    if not u or u.get("disabled"):
        raise PermissionError("the password is set, but the account is disabled")
    await raw_db[USERS].update_one({"_id": u["_id"]}, {"$unset": {"must_change_password": ""}})
    return u, space_of(u)
