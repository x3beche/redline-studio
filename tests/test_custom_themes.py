"""Themes people make (backend/themes.py): kept in each account's private
space, checked on the way in, and changed or deleted only by their maker or
the person whose space it is (not by one of their agents). The database is
test_telegram's fake; sign-in is on, and the cookie says who is asking."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import access, actors, auth, scope, themes
from test_telegram import FakeDb

CSS = Path(__file__).resolve().parent.parent / "frontend/src/styles.css"

PEOPLE = {
    "ayse": ({"type": "user", "id": "u-ayse", "name": "Ayşe"}, "uu-ayse", "user"),
    # an agent working in Ayşe's space with her token
    "bot": ({"type": "agent", "id": "bot", "name": "bot", "token": "t1"}, "uu-ayse", "editor"),
    "deniz": ({"type": "user", "id": "u-deniz", "name": "Deniz"}, "default", "owner"),
}

GOOD = {"name": "zz Ocean", "base": "github-dark", "light": False,
        "vars": {"--surface": "#0b1d2a", "--accent": "#3fb6ff", "--line": "rgba(255, 255, 255, .12)"}}


@pytest.fixture
def db(monkeypatch):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)

    async def session_user(_db, token):
        if token not in PEOPLE:
            return None
        user, ws, role = PEOPLE[token]
        return {"user": user, "workspace": ws, "role": role}

    monkeypatch.setattr(auth, "session_user", session_user)
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])


def as_(who: str) -> TestClient:
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.cookies.set(auth.COOKIE, who)
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def test_the_token_list_is_the_stylesheets():
    css = CSS.read_text()
    start = css.index(":root {") + len(":root {")
    block = css[start:css.index("}", start)]
    assert set(re.findall(r"(--[a-z0-9-]+)\s*:", block)) == themes.TOKENS


@pytest.mark.parametrize("v,ok", [
    ("#abc", True), ("#a1b2c3", True), ("#a1b2c3d4", True), ("rgb(1, 2, 3)", True),
    ("rgba(255,255,255,.5)", True), ("rgba(0, 0, 0, 1)", True),
    ("#abcd", False), ("#ggg", False), ("red", False), ("rgba(256, 0, 0, .5)", False),
    ("rgba(0, 0, 0, 2)", False), ("url(x)", False), ("#fff; background: red", False),
    ("var(--ink)", False), ("", False),
])
def test_only_colours_are_colours(v, ok):
    assert themes.colour_ok(v) is ok


def test_anyone_may_make_one():
    for role in access.ROLES:
        for m in ("GET", "POST"):
            assert access.allowed(role, access.action(m, "/api/themes"))
        for m in ("PUT", "DELETE"):
            assert access.allowed(role, access.action(m, "/api/themes/abc"))


def test_a_theme_is_made_listed_and_says_who_made_it(db):
    r = as_("ayse").post("/api/themes", json=GOOD)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["by"]["name"] == "Ayşe" and got["mine"] and got["can_edit"]
    assert got["vars"]["--accent"] == "#3fb6ff"
    listed = as_("bot").get("/api/themes").json()
    assert [t["name"] for t in listed] == ["zz Ocean"]
    assert not listed[0]["mine"] and not listed[0]["can_edit"]      # her agent, not its maker


@pytest.mark.parametrize("patch,why", [
    ({"name": ""}, "name"),
    ({"name": "x" * 41}, "at most"),
    ({"base": "Not A Theme!"}, "base"),
    ({"vars": {}}, "at least one"),
    ({"vars": {"--surface": "#000", "--evil": "#fff"}}, "unknown token"),
    ({"vars": {"--surface": "red"}}, "not a colour"),
    ({"vars": {"--surface": "#000;}body{display:none"}}, "not a colour"),
])
def test_what_is_wrong_is_refused(db, patch, why):
    r = as_("ayse").post("/api/themes", json={**GOOD, **patch})
    assert r.status_code == 422 and why in r.text
    assert not db["themes"].docs


def test_only_its_maker_or_the_spaces_person_changes_or_deletes_it(db):
    tid = as_("ayse").post("/api/themes", json=GOOD).json()["id"]
    assert as_("bot").put(f"/api/themes/{tid}", json={**GOOD, "name": "zz mine now"}).status_code == 403
    assert as_("bot").delete(f"/api/themes/{tid}").status_code == 403
    r = as_("ayse").put(f"/api/themes/{tid}", json={**GOOD, "name": "zz Ocean 2", "light": True})
    assert r.status_code == 200 and r.json()["name"] == "zz Ocean 2" and r.json()["light"] is True
    # one her agent made is hers to change all the same
    bid = as_("bot").post("/api/themes", json={**GOOD, "name": "zz By the bot"}).json()["id"]
    assert next(t for t in as_("ayse").get("/api/themes").json() if t["id"] == bid)["can_edit"]
    assert as_("ayse").delete(f"/api/themes/{bid}").status_code == 200
    assert as_("ayse").delete(f"/api/themes/{tid}").status_code == 200
    assert as_("ayse").get("/api/themes").json() == []
    assert as_("ayse").delete(f"/api/themes/{tid}").status_code == 404


def test_each_account_sees_only_its_own(db):
    as_("ayse").post("/api/themes", json=GOOD)
    as_("deniz").post("/api/themes", json={**GOOD, "name": "zz The owner's"})
    assert [t["name"] for t in as_("bot").get("/api/themes").json()] == ["zz Ocean"]
    assert [t["name"] for t in as_("deniz").get("/api/themes").json()] == ["zz The owner's"]
    tid = as_("ayse").get("/api/themes").json()[0]["id"]
    assert as_("deniz").delete(f"/api/themes/{tid}").status_code == 404     # not even the owner


def test_signed_out_gets_nothing(db):
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    assert c.get("/api/themes").status_code == 401
