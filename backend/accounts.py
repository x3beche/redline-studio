"""Accounts saved on this browser, and switching between them.

Signing in with "Remember me" keeps the account on this browser: a remember
token of its own (backend/auth.py, remembered accounts) goes into one
HttpOnly cookie that holds every account the browser remembers. The page
lists them - in the menu under one's name, and as the account chooser a
signed-out browser opens on - and switches between them without a password.

- **Switching** (POST /api/auth/switch) trades the remember token for the
  named account for a new session of that account, in its own space; the
  session the browser had ends. The account is what the token's record
  says, never what the request says: a token for one account cannot sign
  in another.
- **Signing out** ends the session and keeps the remembered accounts.
- **Removing one** (POST /api/auth/forget) revokes its token on the server
  and drops it from the browser; **forget-all** does it for every one, and
  signs out.

None of these needs a session - a signed-out browser is where the chooser
is - so each checks the CSRF header itself, as the middleware does for
everything signed in. Switching is counted like signing in (auth.too_fast,
auth.locked_out). Each remember, switch and removal goes into the audit
trail of the account's space, and the server's.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import actors, auth, profile, scope

router = APIRouter()


def _raw():
    from .main import db
    return db().raw


def _csrf(request: Request) -> None:
    if not auth.csrf_ok(request.method, request.headers):
        raise HTTPException(403, "that change did not come from the app")


def _on() -> None:
    if not auth.enabled():
        raise HTTPException(400, "sign-in is off (REDLINE_REQUIRE_SIGNIN): there are no accounts to switch")


def _agent(request: Request) -> tuple[str, str]:
    return request.headers.get("user-agent", ""), request.client.host if request.client else ""


def _rows(request: Request) -> list[dict]:
    return auth.read_device(request.cookies.get(auth.DEVICE_COOKIE))


def _set_device(response: Response, request: Request, rows: list[dict]) -> None:
    """The browser's list of remembered accounts: only the API reads it, and
    only from this site's own pages (SameSite=Strict)."""
    if rows:
        response.set_cookie(auth.DEVICE_COOKIE, auth.write_device(rows), max_age=auth.REMEMBER_DAYS * 86400,
                            httponly=True, samesite="strict", secure=request.url.scheme == "https", path="/api")
    else:
        response.delete_cookie(auth.DEVICE_COOKIE, path="/api")


def _who(u: dict) -> dict:
    return {"type": "user", "id": u["_id"], "name": u.get("name") or u["email"]}


async def _audit(u: dict, action: str, detail: dict | None = None) -> None:
    """Into the account's own trail, and the server's (the owner's space),
    as signing in is."""
    raw = _raw()
    space = auth.space_of(u)
    for ws in dict.fromkeys((space, scope.DEFAULT)):
        await actors.audit(scope.ScopedDb(raw, ws), action, u["email"], detail, actor=_who(u))


def _row(u: dict, token: str) -> dict:
    return {"t": token, "u": u["_id"], "e": u["email"], "n": u.get("name") or ""}


async def remember_here(request: Request, response: Response, u: dict) -> bool:
    """Remember an account on this browser: a new token, in place of any
    the browser had for it (that one is revoked). False when the browser
    already keeps DEVICE_MAX others."""
    raw = _raw()
    rows = _rows(request)
    at = next((i for i, r in enumerate(rows) if r["u"] == u["_id"]), None)
    if at is None and len(rows) >= auth.DEVICE_MAX:
        return False
    if at is not None:
        await auth.forget_remember(raw, rows[at]["t"], u["_id"])
    agent, ip = _agent(request)
    row = _row(u, await auth.create_remember(raw, u, agent, ip))
    if at is None:
        rows.append(row)
    else:
        rows[at] = row
    _set_device(response, request, rows)
    await _audit(u, "remember", {"device": profile.device(agent)})
    return True


# ---------------------------------------------------------------- the list

@router.get("/api/auth/accounts")
async def accounts(request: Request):
    """The accounts this browser remembers, in the order they were added,
    and which one is signed in. A row whose token is gone (revoked,
    expired, the account disabled) says only what the browser kept - the
    address and name - and `live: false`: it signs in with a password."""
    if not auth.enabled():
        return {"accounts": [], "current": None}
    raw = _raw()
    got = await auth.session_user(raw, request.cookies.get(auth.COOKIE))
    current = got["user"]["id"] if got and not got.get("page") else None
    out = []
    for r in _rows(request):
        u = await auth.remembered(raw, r["t"], r["u"])
        if u:
            out.append({"id": u["_id"], "name": u.get("name") or u["email"], "email": u["email"],
                        **profile.avatar_fields(u), "live": True, "current": u["_id"] == current})
        else:
            out.append({"id": r["u"], "name": r["n"] or r["e"], "email": r["e"], "has_avatar": False,
                        "avatar_v": None, "avatar_colour": profile.AUTO, "live": False,
                        "current": r["u"] == current})
    return JSONResponse({"accounts": out, "current": current}, headers={"Cache-Control": "no-store"})


@router.get("/api/auth/accounts/{user_id}/avatar")
async def account_avatar(user_id: str, request: Request, v: str | None = None):
    """A remembered account's picture, for the chooser a signed-out browser
    shows: only while this browser holds a good token for that account."""
    raw = _raw()
    row = next((r for r in _rows(request) if r["u"] == user_id), None)
    u = await auth.remembered(raw, row["t"], user_id) if row and auth.enabled() else None
    pic = await raw[auth.USERS].find_one({"_id": u["_id"]}, {"avatar": 1, "avatar_v": 1}) if u else None
    if not pic or not pic.get("avatar"):
        raise HTTPException(404, "no picture")
    keep = "private, max-age=31536000, immutable" if v and str(v) == str(pic.get("avatar_v")) else "private, no-cache"
    return Response(bytes(pic["avatar"]), media_type="image/jpeg", headers={"Cache-Control": keep})


# ---------------------------------------------------------------- remembering

@router.post("/api/auth/remember")
async def remember(request: Request, response: Response):
    """Remember the signed-in account on this browser (before adding another,
    or after its token was revoked). Its session is unchanged."""
    _on()
    _csrf(request)
    who = actors.current()
    if who.get("type") != "user" or who.get("page") or who.get("id") in (None, "local"):
        raise HTTPException(403, "only a signed-in person is remembered")
    raw = _raw()
    u = await raw[auth.USERS].find_one({"_id": who["id"]}, {"pw": 0, "avatar": 0})
    if not u or u.get("disabled"):
        raise HTTPException(403, "no such account")
    rows = _rows(request)
    mine = next((r for r in rows if r["u"] == u["_id"]), None)
    if mine and await auth.remembered(raw, mine["t"], u["_id"]):
        # Already: the address and name brought up to date, nothing new made.
        mine.update(e=u["email"], n=u.get("name") or "")
        _set_device(response, request, rows)
        return {"remembered": True, "new": False}
    if not await remember_here(request, response, u):
        raise HTTPException(409, f"this browser keeps {auth.DEVICE_MAX} accounts - remove one first")
    return {"remembered": True, "new": True}


# ---------------------------------------------------------------- switching

class AccountIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)


@router.post("/api/auth/switch")
async def switch(body: AccountIn, request: Request, response: Response):
    """Sign in to a remembered account, no password: a new session in its
    own space, and the browser's old session ends."""
    _on()
    _csrf(request)
    from .main import _set_cookie
    agent, ip = _agent(request)
    if auth.too_fast("switch:" + ip) or auth.locked_out("switch:" + body.id):
        raise HTTPException(429, "too many tries - wait a little")
    raw = _raw()
    row = next((r for r in _rows(request) if r["u"] == body.id), None)
    # The account is the token's record's, and it must be the one asked for.
    u = await auth.remembered(raw, row["t"], body.id) if row else None
    if not u:
        auth.failed("switch:" + body.id)
        raise HTTPException(401, "sign in to this account again - it is no longer remembered here")
    old = request.cookies.get(auth.COOKIE)
    was = await auth.session_user(raw, old)
    await auth.end_session(raw, old)
    token = await auth.create_session(raw, u, auth.space_of(u), agent, ip)
    await auth.used_remember(raw, row["t"])
    _set_cookie(response, request, token)
    frm = was["user"].get("email") if was and not was.get("page") else None
    await _audit(u, "switch", {"from": frm, "device": profile.device(agent)} if frm else
                 {"device": profile.device(agent)})
    return {"user": {"id": u["_id"], "name": u.get("name"), "email": u["email"]}}


# ---------------------------------------------------------------- removing

@router.post("/api/auth/forget")
async def forget(body: AccountIn, request: Request, response: Response):
    """Remove an account from this browser: its token revoked on the
    server, its row dropped, and - if it is the one signed in - signed out."""
    _on()
    _csrf(request)
    raw = _raw()
    rows = _rows(request)
    row = next((r for r in rows if r["u"] == body.id), None)
    revoked = bool(row) and await auth.forget_remember(raw, row["t"], body.id)
    _set_device(response, request, [r for r in rows if r["u"] != body.id])
    got = await auth.session_user(raw, request.cookies.get(auth.COOKIE))
    if got and not got.get("page") and got["user"].get("id") == body.id:
        await auth.end_session(raw, request.cookies.get(auth.COOKIE))
        response.delete_cookie(auth.COOKIE, path="/")
    if revoked:
        u = await raw[auth.USERS].find_one({"_id": body.id}, {"pw": 0, "avatar": 0})
        if u:
            await _audit(u, "forget", {"device": profile.device(_agent(request)[0])})
    return {"forgotten": bool(row), "revoked": revoked}


@router.post("/api/auth/forget-all")
async def forget_all(request: Request, response: Response):
    """Every account off this browser, each token revoked, and signed out."""
    _on()
    _csrf(request)
    raw = _raw()
    agent = _agent(request)[0]
    n = 0
    for r in _rows(request):
        if await auth.forget_remember(raw, r["t"], r["u"]):
            n += 1
            u = await raw[auth.USERS].find_one({"_id": r["u"]}, {"pw": 0, "avatar": 0})
            if u:
                await _audit(u, "forget", {"device": profile.device(agent), "all": True})
    await auth.end_session(raw, request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE, path="/")
    _set_device(response, request, [])
    return {"revoked": n}
