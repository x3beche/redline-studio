"""The person's own account: their name, address, picture, password and
sessions - the Profile page at the top of Settings (preferences.ts).

Everyone signed in may manage themselves and nobody else: every route here
works on the account of the session that asks, never on an id it is given
(access.py: /api/me is "view"). The one route that takes an id is the
picture: one's own, the person whose space is being looked at (an agent
working there shows its notes' author), and - for the admin panel - anyone's
to the owner and the admins. It is a picture and nothing else. The owner
and the admins change other people's accounts in backend/admin.py.

Who has no account gets a read-only page: local mode (sign-in off), an
agent's token and a headless browser's page session. They have no
password and no sessions to show.

A picture is cut to a centred square, made 256 x 256 and kept as a JPEG on
the user's document (`avatar`, with `avatar_v` the moment it changed, for
the URL so a browser may keep it). Lists of people carry `has_avatar` and
`avatar_v`, so a page can show the picture without asking first.

The colour around someone (their ring, and the ground of their initials) is
`avatar_colour`: one of the theme's tokens in COLOURS, or "auto" - a series
colour picked from the name (frontend avatar.ts), which is what nobody's
choice means. It travels with the picture fields; a page drawing other
people (the Chat's lines) asks GET /api/me/colours?ids=... for theirs.
"""

from __future__ import annotations

import hashlib
import io
import re
import time

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from . import access, actors, auth, scope

router = APIRouter()

MAX_UPLOAD = 5 * 1024 * 1024
SIDE = 256
FORMATS = {"PNG", "JPEG", "WEBP"}
MAX_PIXELS = 50_000_000            # a 7000 x 7000 picture; more is a bomb, not a face


def _db():
    from .main import db
    return db()


def _kind() -> str:
    """Whose page this is: a signed-in person, or someone without an account."""
    if not auth.enabled():
        return "local"
    who = actors.current()
    if who.get("page"):
        return "page"
    if who.get("type") != "user" or who.get("id") in (None, "local"):
        return "agent"
    return "user"


def _person() -> dict:
    """The signed-in person, or a refusal for anyone without an account."""
    kind = _kind()
    if kind == "local":
        raise HTTPException(400, "sign-in is off (REDLINE_REQUIRE_SIGNIN): there is no account to change")
    if kind != "user":
        raise HTTPException(403, "only a signed-in person has a profile to change")
    return actors.current()


def _iso(v):
    """A moment for the page, in UTC - Mongo hands dates back without a zone."""
    if not hasattr(v, "isoformat"):
        return v
    from datetime import timezone
    return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).isoformat()


# The colours one may wear: theme tokens (styles.css), never a raw value.
COLOURS = tuple(f"series-{i}" for i in range(1, 9)) + ("accent",)
AUTO = "auto"


def colour_of(u: dict | None) -> str:
    """Someone's avatar colour: their choice, or "auto"."""
    c = (u or {}).get("avatar_colour")
    return c if c in COLOURS else AUTO


def clean_colour(c: str) -> str | None:
    """A colour to keep: a token from COLOURS, or None for "auto" (unset).
    Anything else is refused."""
    c = (c or "").strip()
    if c == AUTO:
        return None
    if c not in COLOURS:
        raise HTTPException(400, f"a colour is one of {', '.join(COLOURS)} or {AUTO}")
    return c


def colour_change(u: dict, c: str) -> tuple[dict, bool]:
    """The update for a new colour (a $set or an $unset), and whether it changes."""
    want = clean_colour(c)
    if want == u.get("avatar_colour"):
        return {}, False
    return ({"$set": {"avatar_colour": want}} if want else {"$unset": {"avatar_colour": ""}}), True


def avatar_fields(u: dict) -> dict:
    """What a list of people says about someone's picture and colour."""
    v = u.get("avatar_v")
    return {"has_avatar": bool(v), "avatar_v": v or None, "avatar_colour": colour_of(u)}


async def _user(uid: str) -> dict:
    u = await _db()[auth.USERS].find_one({"_id": uid}, {"pw": 0, "avatar": 0})
    if not u:
        raise HTTPException(404, "no such account")
    return u


async def _out(u: dict) -> dict:
    db = _db()
    last = u.get("last_sign_in")
    if not last:
        # From before sign-ins were written down: the newest session.
        newest = [s async for s in db[auth.SESSIONS].find({"user": u["_id"]})]
        newest = [s for s in newest if s.get("kind") != auth.PAGE_KIND and s.get("created_at")]
        last = max((s["created_at"] for s in newest), default=None)
    return {"kind": "user", "id": u["_id"], "name": u.get("name") or u["email"], "email": u["email"],
            "role": auth.role_of(u), "about_role": access.ABOUT.get(auth.role_of(u)),
            "created_at": _iso(u.get("created_at")),
            "last_sign_in": _iso(last), **avatar_fields(u)}


@router.get("/api/me")
async def me():
    kind = _kind()
    if kind != "user":
        who = actors.current()
        return {"kind": kind, "id": who.get("id"), "name": who.get("name") or who.get("id") or "",
                "email": None, "role": access.current(), "about_role": access.ABOUT.get(access.current() or ""),
                "has_avatar": False, "avatar_v": None, "avatar_colour": AUTO}
    return await _out(await _user(actors.current()["id"]))


@router.get("/api/me/colours")
async def colours(ids: str = ""):
    """The avatar colours of the people asked for (comma-separated ids), for
    a page drawing them - the Chat's lines. Only the colour: an id that is
    no account is simply left out, and nobody is listed who was not asked
    for. Everyone not answered (agents, models) is "auto" to the page."""
    want = [i for i in dict.fromkeys(x.strip() for x in ids.split(",")) if i][:200]
    if not want:
        return {"colours": {}}
    out = {}
    async for u in _db()[auth.USERS].find({"_id": {"$in": want}}, {"avatar_colour": 1}):
        out[u["_id"]] = colour_of(u)
    return {"colours": out}


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=200)
    # The address is what one signs in with: changing it asks for the password.
    password: str | None = Field(default=None, max_length=400)
    # One of COLOURS, or "auto".
    avatar_colour: str | None = Field(default=None, max_length=20)


@router.patch("/api/me")
async def change_me(body: ProfileIn):
    who = _person()
    db = _db()
    u = await db[auth.USERS].find_one({"_id": who["id"]}, {"avatar": 0})
    if not u:
        raise HTTPException(404, "no such account")
    change: dict = {}
    if body.name is not None:
        name = re.sub(r"\s+", " ", body.name).strip()
        if not name:
            raise HTTPException(400, "give a name - it is what the others see")
        if len(name) > 80:
            raise HTTPException(400, "a name of at most 80 characters")
        if name != u.get("name"):
            change["name"] = name
    if body.email is not None:
        email = body.email.strip().lower()
        if not auth.EMAIL.match(email):
            raise HTTPException(400, "that does not look like an email address")
        if email != u["email"]:
            if auth.locked_out(u["email"]):
                raise HTTPException(429, "too many tries - wait a quarter of an hour")
            if not auth.check_password(body.password or "", u.get("pw") or ""):
                auth.failed(u["email"])
                raise HTTPException(403, "that is not your current password - it is needed to change the address you sign in with")
            if await db[auth.USERS].find_one({"email": email}, {"_id": 1}):
                raise HTTPException(409, "another account has that address")
            change["email"] = email
    colour, recolour = colour_change(u, body.avatar_colour) if body.avatar_colour is not None else ({}, False)
    if recolour:
        await db[auth.USERS].update_one({"_id": u["_id"]}, colour)
    if change:
        await db[auth.USERS].update_one({"_id": u["_id"]}, {"$set": change})
    if change or recolour:
        auth.forget_sessions()
        detail = {"fields": sorted([*change, *(["avatar_colour"] if recolour else [])])}
        if "email" in change:
            detail["was"] = u["email"]
        await actors.audit(db, "profile", u["_id"], detail)
    return await _out(await _user(u["_id"]))


# ---------------------------------------------------------------- the picture

def square_jpeg(raw: bytes) -> bytes:
    """A picture cut to its centred square, SIDE x SIDE, as a JPEG.
    ValueError for anything that is not a PNG, JPEG or WebP picture."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        img = Image.open(io.BytesIO(raw))
        if img.format not in FORMATS:
            raise ValueError("a PNG, JPEG or WebP picture, please")
        if img.width * img.height > MAX_PIXELS:
            raise ValueError("that picture is too large")
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("that is not a picture this can read") from exc
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        ground = Image.new("RGB", img.size, "white")
        ground.paste(img, mask=img.split()[-1])
        img = ground
    else:
        img = img.convert("RGB")
    side = min(img.size)
    left, top = (img.width - side) // 2, (img.height - side) // 2
    img = img.crop((left, top, left + side, top + side)).resize((SIDE, SIDE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=86, optimize=True)
    return out.getvalue()


@router.put("/api/me/avatar")
async def set_avatar(file: UploadFile = File(...)):
    who = _person()
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "a picture of at most 5 MB")
    if not raw:
        raise HTTPException(400, "the file is empty")
    try:
        jpeg = square_jpeg(raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    v = int(time.time() * 1000)
    db = _db()
    await db[auth.USERS].update_one({"_id": who["id"]}, {"$set": {"avatar": jpeg, "avatar_v": v}})
    auth.forget_sessions()
    await actors.audit(db, "avatar", who["id"], {"bytes": len(jpeg)})
    return {"has_avatar": True, "avatar_v": v}


@router.delete("/api/me/avatar")
async def drop_avatar():
    who = _person()
    db = _db()
    await db[auth.USERS].update_one({"_id": who["id"]}, {"$unset": {"avatar": "", "avatar_v": ""}})
    auth.forget_sessions()
    await actors.audit(db, "avatar", who["id"], {"removed": True})
    return {"has_avatar": False, "avatar_v": None}


@router.get("/api/me/avatar/{user_id}")
async def avatar(user_id: str, v: str | None = None):
    """Someone's picture: one's own, the person whose space this is, or -
    to the owner and the admins - anyone's. Only the picture - a 404 says
    nothing else."""
    db = _db()
    who = actors.current()
    mine = who.get("type") == "user" and who.get("id") == user_id
    u = await db[auth.USERS].find_one({"_id": user_id}, {"avatar": 1, "avatar_v": 1, "role": 1, "space": 1})
    admin = who.get("type") == "user" and not who.get("page") and access.current() in ("owner", "admin")
    if not u or not (mine or admin or auth.space_of(u) == scope.current()):
        raise HTTPException(404, "no picture")
    if not u.get("avatar"):
        raise HTTPException(404, "no picture")
    # The URL carries the moment it changed: a new picture is a new URL.
    keep = "private, max-age=31536000, immutable" if v and str(v) == str(u.get("avatar_v")) else "private, no-cache"
    return Response(bytes(u["avatar"]), media_type="image/jpeg", headers={"Cache-Control": keep})


# ---------------------------------------------------------------- the password

class PasswordIn(BaseModel):
    current: str = Field(min_length=1, max_length=400)
    new: str = Field(min_length=1, max_length=400)


@router.post("/api/me/password")
async def change_password(body: PasswordIn, request: Request):
    """A new password; every other session of the account ends, this one stays."""
    who = _person()
    db = _db()
    u = await db[auth.USERS].find_one({"_id": who["id"]}, {"avatar": 0})
    if not u:
        raise HTTPException(404, "no such account")
    if auth.locked_out(u["email"]):
        raise HTTPException(429, "too many tries - wait a quarter of an hour")
    if not auth.check_password(body.current, u.get("pw") or ""):
        auth.failed(u["email"])
        raise HTTPException(403, "that is not your current password")
    problem = auth.password_problem(body.new)
    if problem:
        raise HTTPException(400, problem)
    if body.new == body.current:
        raise HTTPException(400, "that is the password you have")
    await db[auth.USERS].update_one({"_id": u["_id"]}, {"$set": {"pw": auth.hash_password(body.new)}})
    ended = await _end_others(db, u["_id"], request)
    auth.cleared(u["email"])
    await actors.audit(db, "password", u["email"], {"how": "profile", "signed_out": ended})
    return {"changed": True, "signed_out": ended}


# ---------------------------------------------------------------- sessions

def device(agent: str) -> str:
    """A browser's user agent in a few words: 'Firefox · Linux'."""
    a = agent or ""
    browser = next((name for pat, name in (
        (r"Edg/", "Edge"), (r"OPR/|Opera", "Opera"), (r"HeadlessChrome", "Headless Chrome"),
        (r"Chrome/|CriOS/", "Chrome"), (r"Firefox/|FxiOS/", "Firefox"), (r"Safari/", "Safari"),
        (r"curl/", "curl"), (r"python", "Python")) if re.search(pat, a)), "")
    system = next((name for pat, name in (
        (r"Android", "Android"), (r"iPhone|iPad|iOS", "iOS"), (r"Windows", "Windows"),
        (r"Mac OS X|Macintosh", "macOS"), (r"CrOS", "ChromeOS"), (r"Linux", "Linux")) if re.search(pat, a)), "")
    words = " · ".join(x for x in (browser, system) if x)
    return words or (a[:40] if a else "unknown")


def _here(request: Request) -> str:
    return hashlib.sha256((request.cookies.get(auth.COOKIE) or "").encode()).hexdigest()


def _public_id(key: str) -> str:
    """A session's name on the page: not its key, which is the token's hash."""
    return hashlib.sha256(("session:" + key).encode()).hexdigest()[:12]


async def _end_others(db, user_id: str, request: Request) -> int:
    res = await db[auth.SESSIONS].delete_many({"user": user_id, "_id": {"$ne": _here(request)}})
    auth.forget_sessions()
    return int(getattr(res, "deleted_count", 0) or 0)


@router.get("/api/me/sessions")
async def sessions(request: Request):
    who = _person()
    from datetime import timezone
    here = _here(request)
    now = auth._now()
    rows = []
    async for s in _db()[auth.SESSIONS].find({"user": who["id"]}):
        if s.get("kind") == auth.PAGE_KIND:
            continue
        exp = s.get("expires")
        if exp and exp.replace(tzinfo=timezone.utc) <= now:
            continue
        rows.append({"id": _public_id(s["_id"]), "here": s["_id"] == here,
                     "device": device(s.get("agent") or ""), "created_at": _iso(s.get("created_at")),
                     "last_seen": _iso(s.get("last_seen")), "expires": _iso(exp)})
    # This one first, then the others by when they were last used.
    rows.sort(key=lambda r: r["last_seen"] or "", reverse=True)
    rows.sort(key=lambda r: not r["here"])
    return {"sessions": rows}


@router.post("/api/me/sessions/revoke-others")
async def revoke_others(request: Request):
    who = _person()
    db = _db()
    ended = await _end_others(db, who["id"], request)
    await actors.audit(db, "sessions", who["id"], {"signed_out": ended})
    return {"signed_out": ended}
