"""One's own profile (backend/profile.py): the name, the address, the
picture, the password and the sessions - each person their own, and only
their own. Sign-in is on; the database is test_telegram's fake, and the
sessions are real ones (backend/auth.py) so "this one" is the cookie's."""

from __future__ import annotations

import asyncio
import io
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import access, actors, auth, profile, scope
from test_telegram import FakeDb

PW = "a long password 1"


def run(c):
    return asyncio.run(c)


@pytest.fixture
def db(monkeypatch):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)
    auth._CACHE.clear()
    auth._FAILS.clear()
    now = datetime.now(timezone.utc)
    # Each in a private space of their own (auth.space_of); Cem is an admin.
    for uid, email, name, role in (("u-ayse", "ayse@example.com", "Ayşe", "user"),
                                   ("u-bora", "bora@example.com", "Bora", "user"),
                                   ("u-cem", "cem@example.com", "Cem", "admin")):
        run(fake["users"].insert_one({"_id": uid, "email": email, "name": name, "role": role,
                                      "pw": auth.hash_password(PW), "created_at": now}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    auth._CACHE.clear()
    auth._FAILS.clear()


def session(fake, uid: str, ws: str = "default", agent: str = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0") -> str:
    return run(auth.create_session(fake, {"_id": uid}, ws, agent))


def client(token: str) -> TestClient:
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.cookies.set(auth.COOKIE, token)
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def picture(w: int, h: int, fmt: str = "PNG", mode: str = "RGB") -> bytes:
    img = Image.new(mode, (w, h), (200, 30, 30) if mode == "RGB" else (200, 30, 30, 128))
    # A stripe down the middle, so the centred square can be checked.
    for x in range(w // 2 - 2, w // 2 + 2):
        for y in range(h):
            img.putpixel((x, y), (0, 0, 255) if mode == "RGB" else (0, 0, 255, 255))
    out = io.BytesIO()
    img.save(out, fmt)
    return out.getvalue()


# ---------------------------------------------------------------- the rules

def test_everyone_signed_in_may_manage_themselves():
    for role in access.ROLES:
        for m, p in (("GET", "/api/me"), ("PATCH", "/api/me"), ("PUT", "/api/me/avatar"),
                     ("DELETE", "/api/me/avatar"), ("GET", "/api/me/avatar/u-x"),
                     ("POST", "/api/me/password"), ("GET", "/api/me/sessions"),
                     ("POST", "/api/me/sessions/revoke-others")):
            assert access.action(m, p) == "view", (m, p)
            assert access.allowed(role, access.action(m, p))
    # a page session only looks
    assert access.page_allowed("GET", "/api/me")
    assert not access.page_allowed("PATCH", "/api/me")
    assert not access.page_allowed("POST", "/api/me/sessions/revoke-others")


def test_signed_out_is_refused(db):
    assert client("nobody").get("/api/me").status_code == 401


# ---------------------------------------------------------------- reading and changing

def test_me_says_who_and_where_and_never_the_password(db):
    r = client(session(db, "u-ayse")).get("/api/me")
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["kind"] == "user" and me["id"] == "u-ayse" and me["email"] == "ayse@example.com"
    assert me["role"] == "user" and me["has_avatar"] is False and me["last_sign_in"]
    assert "workspace" not in me and "workspace_name" not in me
    assert me["created_at"].endswith("+00:00")
    assert "pw" not in me and "scrypt" not in r.text


def test_a_name_is_changed_and_audited(db):
    c = client(session(db, "u-bora"))
    r = c.patch("/api/me", json={"name": "  Bora   Yılmaz "})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Bora Yılmaz"
    assert run(db["users"].find_one({"_id": "u-bora"}))["name"] == "Bora Yılmaz"
    audit = [d for d in db["audit"].docs.values() if d["action"] == "profile"]
    assert audit and audit[0]["detail"]["fields"] == ["name"] and audit[0]["actor"]["id"] == "u-bora"


# ---------------------------------------------------------------- the colour

def test_the_avatar_colour_is_auto_until_chosen(db):
    me = client(session(db, "u-ayse")).get("/api/me").json()
    assert me["avatar_colour"] == "auto"
    assert profile.colour_of({}) == "auto" and profile.colour_of({"avatar_colour": "#ff0000"}) == "auto"


def test_the_avatar_colour_is_one_of_the_palette(db):
    c = client(session(db, "u-ayse"))
    for bad in ("red", "#ff0000", "var(--series-1)", "series-9", "series-0", "", "accent; x"):
        assert c.patch("/api/me", json={"avatar_colour": bad}).status_code in (400, 422), bad
    assert "avatar_colour" not in run(db["users"].find_one({"_id": "u-ayse"}))
    for good in (*profile.COLOURS,):
        r = c.patch("/api/me", json={"avatar_colour": good})
        assert r.status_code == 200 and r.json()["avatar_colour"] == good
        assert run(db["users"].find_one({"_id": "u-ayse"}))["avatar_colour"] == good
    audit = [d for d in db["audit"].docs.values() if d["action"] == "profile"]
    assert audit and audit[0]["detail"]["fields"] == ["avatar_colour"]
    # "auto" takes the choice off again: the name picks.
    r = c.patch("/api/me", json={"avatar_colour": "auto"})
    assert r.json()["avatar_colour"] == "auto"
    assert "avatar_colour" not in run(db["users"].find_one({"_id": "u-ayse"}))
    # A bad colour beside a good name changes neither.
    assert c.patch("/api/me", json={"name": "Ayşe Q", "avatar_colour": "pink"}).status_code == 400
    assert run(db["users"].find_one({"_id": "u-ayse"}))["name"] == "Ayşe"


def test_the_colour_reaches_the_session_and_the_authors(db):
    """The signed-in user carries it (the top bar), and a page drawing
    message authors gets theirs - only for the ids it names."""
    a = client(session(db, "u-ayse"))
    a.patch("/api/me", json={"avatar_colour": "series-3"})
    auth._CACHE.clear()
    who = run(auth.session_user(db, session(db, "u-ayse")))
    assert who["user"]["avatar_colour"] == "series-3"
    b = client(session(db, "u-bora"))
    r = b.get("/api/me/colours", params={"ids": "u-ayse,u-bora,nobody,u-ayse"})
    assert r.status_code == 200, r.text
    assert r.json()["colours"] == {"u-ayse": "series-3", "u-bora": "auto"}
    assert b.get("/api/me/colours").json()["colours"] == {}
    assert access.action("GET", "/api/me/colours") == "view"


def test_names_are_checked(db):
    c = client(session(db, "u-bora"))
    assert c.patch("/api/me", json={"name": "   "}).status_code == 400
    assert c.patch("/api/me", json={"name": "x" * 81}).status_code == 400
    assert c.patch("/api/me", json={"name": "x" * 201}).status_code == 422


def test_one_changes_only_oneself(db):
    """There is no id to aim at: the session's person is the one changed."""
    c = client(session(db, "u-ayse"))
    c.patch("/api/me", json={"name": "Ayşe K", "id": "u-bora", "_id": "u-bora"})
    assert run(db["users"].find_one({"_id": "u-bora"}))["name"] == "Bora"
    assert run(db["users"].find_one({"_id": "u-ayse"}))["name"] == "Ayşe K"
    # and no route takes someone else's id to change
    assert c.patch("/api/me/u-bora", json={"name": "x"}).status_code in (404, 405)
    assert c.delete("/api/me/avatar/u-bora").status_code in (404, 405)


def test_changing_the_address_asks_for_the_password(db):
    c = client(session(db, "u-ayse"))
    assert c.patch("/api/me", json={"email": "not an address"}).status_code == 400
    r = c.patch("/api/me", json={"email": "new@example.com"})
    assert r.status_code == 403
    r = c.patch("/api/me", json={"email": "new@example.com", "password": "wrong password"})
    assert r.status_code == 403
    assert c.patch("/api/me", json={"email": "Bora@example.com", "password": PW}).status_code == 409
    r = c.patch("/api/me", json={"email": "New@Example.com", "password": PW})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "new@example.com"
    # the same address again needs nothing
    assert c.patch("/api/me", json={"email": "new@example.com"}).status_code == 200


def test_no_account_no_changes(db, monkeypatch):
    """Local mode, an agent's token: the page is read-only, the changes refused."""
    monkeypatch.setattr(auth, "enabled", lambda: False)
    c = client("x")
    me = c.get("/api/me").json()
    assert me["kind"] == "local" and me["role"] == "owner"
    assert c.patch("/api/me", json={"name": "x"}).status_code == 400
    assert c.post("/api/me/password", json={"current": PW, "new": "another long one"}).status_code == 400
    assert c.get("/api/me/sessions").status_code == 400


def test_an_agent_has_no_profile_to_change(db):
    token, _ = run(auth.create_agent_token(db, "zz bot", "default", None, {"type": "user", "id": "u-bora"}))
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.headers["Authorization"] = "Bearer " + token
    me = c.get("/api/me").json()
    assert me["kind"] == "agent" and me["name"] == "zz bot"
    assert c.patch("/api/me", json={"name": "x"}).status_code == 403
    assert c.get("/api/me/sessions").status_code == 403
    auth._TOKEN_CACHE.clear()


# ---------------------------------------------------------------- the picture

def test_a_picture_is_cut_square_and_made_small():
    out = Image.open(io.BytesIO(profile.square_jpeg(picture(900, 300))))
    assert out.format == "JPEG" and out.size == (256, 256)
    # the stripe was in the middle, so it is in the middle still
    r, g, b = out.getpixel((128, 128))
    assert b > 150 and r < 120
    r, g, b = out.getpixel((10, 128))
    assert r > 150 and b < 100
    tall = Image.open(io.BytesIO(profile.square_jpeg(picture(100, 400, "WEBP"))))
    assert tall.size == (256, 256)
    # a see-through PNG goes onto a plain ground
    assert Image.open(io.BytesIO(profile.square_jpeg(picture(64, 64, "PNG", "RGBA")))).mode == "RGB"


def test_only_pictures_are_pictures():
    for bad in (b"hello", picture(40, 40, "GIF"), picture(40, 40, "BMP")):
        with pytest.raises(ValueError):
            profile.square_jpeg(bad)


def test_a_picture_is_put_shown_and_taken_off(db):
    c = client(session(db, "u-ayse"))
    r = c.put("/api/me/avatar", files={"file": ("me.png", picture(600, 400), "image/png")})
    assert r.status_code == 200, r.text
    v = r.json()["avatar_v"]
    assert r.json()["has_avatar"] and v
    stored = run(db["users"].find_one({"_id": "u-ayse"}))
    assert Image.open(io.BytesIO(stored["avatar"])).size == (256, 256)
    me = c.get("/api/me").json()
    assert me["has_avatar"] and me["avatar_v"] == v
    got = c.get(f"/api/me/avatar/u-ayse?v={v}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/jpeg"
    assert "immutable" in got.headers["cache-control"]
    # another user does not see it - each account is private - but an
    # admin does (the admin panel), and its list says it is there
    assert client(session(db, "u-bora")).get(f"/api/me/avatar/u-ayse?v={v}").status_code == 404
    admin = client(session(db, "u-cem"))
    assert admin.get(f"/api/me/avatar/u-ayse?v={v}").status_code == 200
    rows = admin.get("/api/admin/users").json()["users"]
    assert next(m for m in rows if m["id"] == "u-ayse")["has_avatar"]
    assert "avatar" not in next(m for m in rows if m["id"] == "u-ayse")
    assert c.delete("/api/me/avatar").status_code == 200
    assert c.get("/api/me/avatar/u-ayse").status_code == 404
    assert not c.get("/api/me").json()["has_avatar"]
    assert {d["action"] for d in db["audit"].docs.values()} >= {"avatar"}


def test_a_picture_is_checked(db):
    c = client(session(db, "u-ayse"))
    assert c.put("/api/me/avatar", files={"file": ("x.txt", b"not a picture", "text/plain")}).status_code == 400
    assert c.put("/api/me/avatar", files={"file": ("x.png", b"", "image/png")}).status_code == 400
    big = b"\x89PNG" + b"0" * (profile.MAX_UPLOAD + 10)
    assert c.put("/api/me/avatar", files={"file": ("x.png", big, "image/png")}).status_code == 413
    assert c.get("/api/me/avatar/u-nobody").status_code == 404


# ---------------------------------------------------------------- the password

def test_a_wrong_current_password_changes_nothing(db):
    c = client(session(db, "u-bora"))
    before = run(db["users"].find_one({"_id": "u-bora"}))["pw"]
    r = c.post("/api/me/password", json={"current": "wrong password", "new": "a brand new password"})
    assert r.status_code == 403
    assert run(db["users"].find_one({"_id": "u-bora"}))["pw"] == before


def test_a_new_password_is_checked(db):
    c = client(session(db, "u-bora"))
    assert c.post("/api/me/password", json={"current": PW, "new": "short"}).status_code == 400
    assert c.post("/api/me/password", json={"current": PW, "new": PW}).status_code == 400


def test_a_password_is_changed_and_the_other_sessions_end(db):
    here = session(db, "u-bora")
    elsewhere = session(db, "u-bora", agent="Mozilla/5.0 (iPhone) Safari/605")
    c = client(here)
    r = c.post("/api/me/password", json={"current": PW, "new": "a brand new password"})
    assert r.status_code == 200, r.text
    assert r.json()["signed_out"] == 1
    pw = run(db["users"].find_one({"_id": "u-bora"}))["pw"]
    assert pw.startswith("scrypt$") and auth.check_password("a brand new password", pw)
    auth._CACHE.clear()
    assert c.get("/api/me").status_code == 200
    assert client(elsewhere).get("/api/me").status_code == 401
    a = [d for d in db["audit"].docs.values() if d["action"] == "password"]
    assert a and "a brand new password" not in str(a)


def test_guessing_the_current_password_is_slowed(db):
    c = client(session(db, "u-bora"))
    for _ in range(auth.FAIL_LIMIT):
        c.post("/api/me/password", json={"current": "wrong password", "new": "a brand new password"})
    assert c.post("/api/me/password", json={"current": PW, "new": "a brand new password"}).status_code == 429


# ---------------------------------------------------------------- sessions

def test_sessions_are_listed_without_their_tokens(db):
    here = session(db, "u-bora")
    session(db, "u-bora", agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1")
    session(db, "u-ayse")
    r = client(here).get("/api/me/sessions")
    assert r.status_code == 200, r.text
    rows = r.json()["sessions"]
    assert len(rows) == 2 and rows[0]["here"] and not rows[1]["here"]
    assert rows[0]["device"] == "Firefox · Linux" and rows[1]["device"] == "Safari · iOS"
    keys = set(db["sessions"].docs)
    assert here not in r.text and not any(k in r.text for k in keys)


def test_signing_out_the_others_keeps_this_one(db):
    here = session(db, "u-bora")
    other = session(db, "u-bora")
    ayse = session(db, "u-ayse")
    c = client(here)
    r = c.post("/api/me/sessions/revoke-others")
    assert r.status_code == 200 and r.json()["signed_out"] == 1
    auth._CACHE.clear()
    assert c.get("/api/me").status_code == 200
    assert client(other).get("/api/me").status_code == 401
    assert client(ayse).get("/api/me").status_code == 200          # someone else's stay
    assert len(c.get("/api/me/sessions").json()["sessions"]) == 1


def test_the_device_in_a_few_words():
    assert profile.device("Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120 Safari/537 Edg/120") == "Edge · Windows"
    assert profile.device("Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Chrome/120 Safari/537") == "Chrome · macOS"
    assert profile.device("curl/8.0") == "curl"
    assert profile.device("") == "unknown"
