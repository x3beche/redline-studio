"""Accounts remembered on a browser, and switching between them
(backend/accounts.py, backend/auth.py remembered accounts): a token is only
ever its own account's, a revoked or expired one is refused, removing one
revokes it on the server, a switch lands in the other account's space, the
CSRF header is asked for, and switching is counted like signing in.

Sign-in is on; the database is test_telegram's fake. Each TestClient is a
browser: its cookie jar holds the session and the device cookie."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import access, actors, auth, scope
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
    auth._HITS.clear()
    now = datetime.now(timezone.utc)
    # Each in a private space of their own (auth.space_of).
    for uid, email, name in (("u-ayse", "ayse@example.com", "Ayşe"), ("u-bora", "bora@example.com", "Bora")):
        run(fake["users"].insert_one({"_id": uid, "email": email, "name": name, "role": "user",
                                      "pw": auth.hash_password(PW), "created_at": now}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    auth._CACHE.clear()
    auth._FAILS.clear()
    auth._HITS.clear()


def browser(csrf: bool = True) -> TestClient:
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    if csrf:
        c.headers[auth.CSRF_HEADER] = "1"
    return c


def sign_in(c: TestClient, email: str, remember: bool = True) -> None:
    r = c.post("/api/auth/login", json={"email": email, "password": PW, "remember": remember})
    assert r.status_code == 200, r.text
    assert r.json()["remembered"] is remember


def both() -> TestClient:
    """A browser that remembers Ayşe and Bora, signed in as Bora."""
    c = browser()
    sign_in(c, "ayse@example.com")
    sign_in(c, "bora@example.com")
    return c


def remembers(fake) -> list[dict]:
    return [d for d in fake["sessions"].docs.values() if d.get("kind") == auth.REMEMBER_KIND]


def device_tokens(c: TestClient) -> dict[str, str]:
    """account id -> its token, read out of the browser's cookie (the test
    is the browser; nothing on the page can do this, the cookie is HttpOnly)."""
    return {r["u"]: r["t"] for r in auth.read_device(c.cookies.get(auth.DEVICE_COOKIE))}


def with_device(c: TestClient, rows: list[dict]) -> None:
    c.cookies.set(auth.DEVICE_COOKIE, auth.write_device(rows), path="/api")


# ---------------------------------------------------------------- remembering

def test_remember_me_keeps_a_hashed_token_and_no_password(db):
    c = browser()
    sign_in(c, "ayse@example.com")
    [doc] = remembers(db)
    token = device_tokens(c)["u-ayse"]
    assert doc["user"] == "u-ayse" and doc["_id"] == auth._digest(token)
    assert token not in str(db["sessions"].docs) and PW not in (c.cookies.get(auth.DEVICE_COOKIE) or "")
    # Ninety days, not the session's thirty.
    left = auth._aware(doc["expires"]) - datetime.now(timezone.utc)
    assert timedelta(days=auth.REMEMBER_DAYS - 1) < left <= timedelta(days=auth.REMEMBER_DAYS)
    assert [a for a in db["audit"].docs.values() if a["action"] == "remember"]


def test_without_remember_me_nothing_is_kept(db):
    c = browser()
    sign_in(c, "ayse@example.com", remember=False)
    assert not remembers(db) and not c.cookies.get(auth.DEVICE_COOKIE)
    assert c.get("/api/auth/accounts").json()["accounts"] == []


def test_the_device_cookie_is_httponly_strict_and_kept_to_the_api(db):
    c = browser()
    r = c.post("/api/auth/login", json={"email": "ayse@example.com", "password": PW, "remember": True})
    set_cookie = [h for h in r.headers.get_list("set-cookie") if h.startswith(auth.DEVICE_COOKIE + "=")]
    assert set_cookie, r.headers
    h = set_cookie[0].lower()
    assert "httponly" in h and "samesite=strict" in h and "path=/api" in h


def test_the_list_says_who_is_remembered_and_who_is_signed_in(db):
    c = both()
    rows = c.get("/api/auth/accounts").json()
    assert rows["current"] == "u-bora"
    assert [(a["id"], a["email"], a["live"], a["current"]) for a in rows["accounts"]] == [
        ("u-ayse", "ayse@example.com", True, False), ("u-bora", "bora@example.com", True, True)]
    assert "t" not in rows["accounts"][0] and device_tokens(c)["u-ayse"] not in str(rows)


def test_remembering_again_replaces_the_old_token(db):
    c = browser()
    sign_in(c, "ayse@example.com")
    first = device_tokens(c)["u-ayse"]
    sign_in(c, "ayse@example.com")
    assert len(remembers(db)) == 1 and device_tokens(c)["u-ayse"] != first
    assert run(auth.remembered(db, first)) is None


def test_the_signed_in_account_can_be_remembered_later(db):
    c = browser()
    sign_in(c, "ayse@example.com", remember=False)
    assert c.post("/api/auth/remember").json() == {"remembered": True, "new": True}
    assert c.post("/api/auth/remember").json() == {"remembered": True, "new": False}
    assert len(remembers(db)) == 1 and "u-ayse" in device_tokens(c)
    # signed out, there is nobody to remember
    assert browser().post("/api/auth/remember").status_code == 401


# ---------------------------------------------------------------- switching

def test_switching_signs_in_the_other_account_in_its_own_space(db):
    c = both()
    assert c.get("/api/me").json()["id"] == "u-bora"
    assert c.put("/api/settings", params={"auto_archive": True}).json()["auto_archive"] is True
    before = c.cookies.get(auth.COOKIE)
    r = c.post("/api/auth/switch", json={"id": "u-ayse"})
    assert r.status_code == 200, r.text
    assert c.get("/api/me").json()["id"] == "u-ayse"
    got = run(auth.session_user(db, c.cookies.get(auth.COOKIE)))
    assert got["workspace"] == "uu-ayse" and got["user"]["id"] == "u-ayse"
    # Bora's settings are Bora's: Ayşe's space has none of them.
    assert c.get("/api/settings").json().get("auto_archive") is not True
    # The session the browser had ended with the switch.
    auth._CACHE.clear()
    assert run(auth.session_user(db, before)) is None
    assert c.get("/api/auth/accounts").json()["current"] == "u-ayse"
    a = [x for x in db["audit"].docs.values() if x["action"] == "switch"]
    assert a and a[0]["actor"]["id"] == "u-ayse" and a[0]["detail"]["from"] == "bora@example.com"
    # and back, still no password
    assert c.post("/api/auth/switch", json={"id": "u-bora"}).status_code == 200
    assert c.get("/api/settings").json()["auto_archive"] is True


def test_signing_out_keeps_the_remembered_accounts(db):
    c = both()
    assert c.post("/api/auth/logout").status_code == 200
    assert c.get("/api/me").status_code == 401
    rows = c.get("/api/auth/accounts").json()
    assert rows["current"] is None and [a["id"] for a in rows["accounts"]] == ["u-ayse", "u-bora"]
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 200
    assert c.get("/api/me").json()["id"] == "u-ayse"


def test_a_token_for_one_account_never_signs_in_another(db):
    c = both()
    ayse = device_tokens(c)["u-ayse"]
    # Ayşe's token, put on Bora's row by hand
    thief = browser()
    with_device(thief, [{"t": ayse, "u": "u-bora", "e": "bora@example.com", "n": "Bora"}])
    r = thief.post("/api/auth/switch", json={"id": "u-bora"})
    assert r.status_code == 401
    assert thief.get("/api/me").status_code == 401
    assert thief.get("/api/auth/accounts").json()["accounts"][0]["live"] is False
    assert thief.get("/api/auth/accounts/u-bora/avatar").status_code == 404
    # ... asked for an account the browser does not hold at all
    assert c.post("/api/auth/switch", json={"id": "u-nobody"}).status_code == 401
    # ... or used as a session: a remember token is not one
    raw = browser()
    raw.cookies.set(auth.COOKIE, ayse)
    assert raw.get("/api/me").status_code == 401
    assert run(auth.session_user(db, ayse)) is None


def test_a_session_token_is_not_a_remember_token(db):
    c = browser()
    sign_in(c, "ayse@example.com", remember=False)
    session = c.cookies.get(auth.COOKIE)
    thief = browser()
    with_device(thief, [{"t": session, "u": "u-ayse", "e": "ayse@example.com", "n": ""}])
    assert thief.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401


def test_an_expired_token_is_refused_and_says_sign_in_again(db):
    c = both()
    for d in remembers(db):
        if d["user"] == "u-ayse":
            db["sessions"].docs[d["_id"]]["expires"] = datetime.now(timezone.utc) - timedelta(minutes=1)
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401
    rows = {a["id"]: a for a in c.get("/api/auth/accounts").json()["accounts"]}
    assert rows["u-ayse"]["live"] is False and rows["u-ayse"]["email"] == "ayse@example.com"
    assert rows["u-bora"]["live"] is True
    # signing in again (the password, once) makes it live
    sign_in(c, "ayse@example.com")
    assert c.post("/api/auth/switch", json={"id": "u-bora"}).status_code == 200
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 200


def test_a_disabled_account_is_not_switched_to(db):
    c = both()
    run(db["users"].update_one({"_id": "u-ayse"}, {"$set": {"disabled": True}}))
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401


def test_a_new_password_elsewhere_revokes_this_browsers_token(db):
    c = both()
    # Ayşe changes her password on another browser
    other = browser()
    sign_in(other, "ayse@example.com", remember=False)
    assert other.post("/api/me/password", json={"current": PW, "new": "a brand new password"}).status_code == 200
    assert [d["user"] for d in remembers(db)] == ["u-bora"]
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401


def test_a_new_password_here_keeps_this_browser_remembered(db):
    c = both()
    elsewhere = browser()
    sign_in(elsewhere, "bora@example.com")
    assert c.post("/api/me/password", json={"current": PW, "new": "a brand new password"}).status_code == 200
    mine = auth._digest(device_tokens(c)["u-bora"])
    assert [d["_id"] for d in remembers(db) if d["user"] == "u-bora"] == [mine]
    assert elsewhere.post("/api/auth/switch", json={"id": "u-bora"}).status_code == 401
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 200
    assert c.post("/api/auth/switch", json={"id": "u-bora"}).status_code == 200


def test_signing_an_account_out_everywhere_revokes_its_tokens(db):
    c = both()
    run(auth.end_sessions_of(db, "u-ayse"))               # disabling or deleting it (backend/admin.py)
    assert [d["user"] for d in remembers(db)] == ["u-bora"]
    assert c.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401


# ---------------------------------------------------------------- removing

def test_removing_an_account_revokes_it_on_the_server(db):
    c = both()
    kept = c.cookies.get(auth.DEVICE_COOKIE)              # a copy, taken before
    r = c.post("/api/auth/forget", json={"id": "u-ayse"})
    assert r.json() == {"forgotten": True, "revoked": True}
    assert [d["user"] for d in remembers(db)] == ["u-bora"]
    assert [a["id"] for a in c.get("/api/auth/accounts").json()["accounts"]] == ["u-bora"]
    # the copy is worth nothing now
    replay = browser()
    replay.cookies.set(auth.DEVICE_COOKIE, kept, path="/api")
    assert replay.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401
    assert [a for a in db["audit"].docs.values() if a["action"] == "forget"]
    # Bora, signed in, is untouched by removing Ayşe
    assert c.get("/api/me").json()["id"] == "u-bora"


def test_removing_the_signed_in_account_signs_it_out(db):
    c = both()
    session = c.cookies.get(auth.COOKIE)
    c.post("/api/auth/forget", json={"id": "u-bora"})
    auth._CACHE.clear()
    assert run(auth.session_user(db, session)) is None
    assert browser().get("/api/me", cookies={auth.COOKIE: session}).status_code == 401


def test_removing_with_another_accounts_id_revokes_nothing(db):
    c = both()
    ayse = device_tokens(c)["u-ayse"]
    thief = browser()
    with_device(thief, [{"t": ayse, "u": "u-bora", "e": "x@example.com", "n": ""}])
    assert thief.post("/api/auth/forget", json={"id": "u-bora"}).json()["revoked"] is False
    assert len(remembers(db)) == 2


def test_forget_all_revokes_every_one_and_signs_out(db):
    c = both()
    session = c.cookies.get(auth.COOKIE)
    assert c.post("/api/auth/forget-all").json() == {"revoked": 2}
    assert not remembers(db)
    auth._CACHE.clear()
    assert run(auth.session_user(db, session)) is None
    assert c.get("/api/auth/accounts").json()["accounts"] == []


# ---------------------------------------------------------------- the guards

def test_every_change_asks_for_the_csrf_header(db):
    c = both()
    bare = browser(csrf=False)
    bare.cookies = c.cookies
    for path, body in (("/api/auth/switch", {"id": "u-ayse"}), ("/api/auth/forget", {"id": "u-ayse"}),
                       ("/api/auth/forget-all", None), ("/api/auth/remember", None)):
        r = bare.post(path, json=body)
        assert r.status_code == 403, (path, r.text)
    assert len(remembers(db)) == 2 and c.get("/api/me").json()["id"] == "u-bora"


def test_switching_is_rate_limited_like_signing_in(db):
    c = both()
    good = device_tokens(c)["u-ayse"]
    thief = browser()
    for i in range(auth.FAIL_LIMIT):
        with_device(thief, [{"t": f"guess{i}", "u": "u-ayse", "e": "a@example.com", "n": ""}])
        assert thief.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 401
    # now even the right token waits
    with_device(thief, [{"t": good, "u": "u-ayse", "e": "a@example.com", "n": ""}])
    assert thief.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 429
    auth._FAILS.clear()
    assert thief.post("/api/auth/switch", json={"id": "u-ayse"}).status_code == 200
    # and many tries from one address in a minute are refused whatever they are
    auth._HITS.clear()
    codes = [thief.post("/api/auth/switch", json={"id": "u-nobody"}).status_code
             for _ in range(auth.SWITCH_LIMIT + 1)]
    assert codes[-1] == 429


def test_a_malformed_device_cookie_is_ignored(db):
    for value in ("", "!!!", "bm90IGpzb24", auth.write_device([]),
                  "W3sidCI6MX1d"):                      # [{"t":1}]
        assert auth.read_device(value) == []
    c = browser()
    c.cookies.set(auth.DEVICE_COOKIE, "garbage", path="/api")
    assert c.get("/api/auth/accounts").json()["accounts"] == []
    # at most DEVICE_MAX rows, one per account
    rows = [{"t": f"t{i}", "u": f"u{i % 10}", "e": "e@x.y", "n": ""} for i in range(30)]
    assert len(auth.read_device(auth.write_device(rows))) == auth.DEVICE_MAX


def test_the_routes_in_the_access_table(db):
    assert access.action("POST", "/api/auth/remember") == "view"
    for m, p in (("GET", "/api/auth/accounts"), ("GET", "/api/auth/accounts/u-x/avatar"),
                 ("POST", "/api/auth/switch"), ("POST", "/api/auth/forget"), ("POST", "/api/auth/forget-all")):
        assert access.action(m, p) == access.NONE, (m, p)
        assert not auth.needs_session(m, p)
    assert auth.needs_session("POST", "/api/auth/remember")
    # a headless browser's page session neither remembers nor switches by the middleware's leave
    assert not access.page_allowed("POST", "/api/auth/remember")


def test_a_picture_is_only_shown_to_a_browser_that_remembers_the_account(db):
    run(db["users"].update_one({"_id": "u-ayse"}, {"$set": {"avatar": b"jpeg-bytes", "avatar_v": 7}}))
    c = both()
    c.post("/api/auth/logout")
    rows = {a["id"]: a for a in c.get("/api/auth/accounts").json()["accounts"]}
    assert rows["u-ayse"]["has_avatar"] is True
    assert c.get("/api/auth/accounts/u-ayse/avatar?v=7").content == b"jpeg-bytes"
    assert browser().get("/api/auth/accounts/u-ayse/avatar").status_code == 404
    c.post("/api/auth/forget", json={"id": "u-ayse"})
    assert c.get("/api/auth/accounts/u-ayse/avatar").status_code == 404


def test_the_profile_lists_this_browsers_remembered_token_as_here(db):
    c = both()
    rows = c.get("/api/me/sessions").json()["sessions"]
    assert sorted((r["here"], r["remembered"]) for r in rows) == [(True, False), (True, True)]
    # signing the others out leaves this browser's own
    c.post("/api/me/sessions/revoke-others")
    assert len([d for d in remembers(db) if d["user"] == "u-bora"]) == 1
