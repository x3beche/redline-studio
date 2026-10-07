"""Page sessions: how a headless browser is shown the app with sign-in on.

tools/render.py trades the agents' token for one (POST
/api/auth/page-session); the server can make one for whoever asks it for a
shot of its own pages. Either way it is read-only, minutes long, in the
source's space, and ends when its source does.
"""
import asyncio
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend import access, actors, auth, scope


def run(c):
    return asyncio.run(c)


def _match(r, q):
    return all(r.get(k) == v for k, v in (q or {}).items())


class Coll:
    def __init__(self):
        self.rows = []

    async def insert_one(self, doc):
        self.rows.append(dict(doc))

    async def find_one(self, q=None, proj=None):
        for r in self.rows:
            if _match(r, q):
                return {k: v for k, v in r.items() if not proj or proj.get(k, 1)}
        return None

    async def update_one(self, q, update, upsert=False):
        for r in self.rows:
            if _match(r, q):
                r.update(update.get("$set", {}))
                return type("R", (), {"matched_count": 1})()
        if upsert:
            self.rows.append({**q, **update.get("$set", {}), **update.get("$setOnInsert", {})})
        return type("R", (), {"matched_count": 0})()

    async def delete_one(self, q):
        self.rows = [r for r in self.rows if not _match(r, q)]

    async def delete_many(self, q):
        self.rows = [r for r in self.rows if not _match(r, q)]

    async def count_documents(self, q):
        return sum(1 for r in self.rows if _match(r, q))


class Db(dict):
    def __missing__(self, k):
        self[k] = Coll()
        return self[k]


@pytest.fixture(autouse=True)
def _fresh():
    auth._CACHE.clear()
    auth._TOKEN_CACHE.clear()
    yield
    auth._CACHE.clear()
    auth._TOKEN_CACHE.clear()


def _token(db, role="editor", workspace="default", room=None):
    raw, doc = run(auth.create_agent_token(db, "bot", workspace, room,
                                           {"type": "user", "id": "u1", "name": "O"}, role))
    return raw, doc


def _mint(db, raw):
    agent = run(auth.token_agent(db, raw))
    return run(auth.create_page_session(db, agent["workspace"], agent["actor"],
                                        token_id=agent["actor"]["token"], room=agent["room"]))


# ---------------------------------------------------------------- the session itself

def test_a_page_session_is_a_viewer_in_the_tokens_workspace_whatever_the_tokens_role():
    db = Db()
    raw, _ = _token(db, role="editor", workspace="ws2", room="pcb")
    value, expires = _mint(db, raw)
    got = run(auth.session_user(db, value))
    assert got["role"] == "viewer" and got["page"] is True
    assert got["workspace"] == "ws2" and got["room"] == "pcb"
    assert got["user"]["type"] == "agent" and got["user"]["name"] == "bot"
    # Minutes, not the thirty days a person's session lasts.
    left = expires - datetime.now(timezone.utc)
    assert timedelta(minutes=1) < left <= timedelta(minutes=auth.PAGE_MINUTES)
    # Only its digest is kept, and neither secret is in the record.
    stored = str(db[auth.SESSIONS].rows)
    assert value not in stored and raw not in stored


def test_it_cannot_be_asked_for_longer_than_the_limit():
    db = Db()
    raw, _ = _token(db)
    agent = run(auth.token_agent(db, raw))
    _, expires = run(auth.create_page_session(db, "default", agent["actor"],
                                              token_id=agent["actor"]["token"], minutes=60 * 24))
    assert expires - datetime.now(timezone.utc) <= timedelta(minutes=auth.PAGE_MINUTES)


def test_it_needs_exactly_one_source():
    db = Db()
    with pytest.raises(ValueError):
        run(auth.create_page_session(db, "default", {"type": "agent", "name": "x"}))
    with pytest.raises(ValueError):
        run(auth.create_page_session(db, "default", {"type": "agent", "name": "x"},
                                     token_id="t", user_id="u"))


def test_an_expired_page_session_signs_nobody_in():
    db = Db()
    raw, _ = _token(db)
    value, _ = _mint(db, raw)
    db[auth.SESSIONS].rows[0]["expires"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert run(auth.session_user(db, value)) is None


def test_the_cache_does_not_outlive_the_session():
    db = Db()
    raw, _ = _token(db)
    value, _ = _mint(db, raw)
    assert run(auth.session_user(db, value))                 # now cached for a minute
    key = auth._digest(value)
    _, out = auth._CACHE[key]
    # Fresh in the cache, but the session's own end has passed.
    auth._CACHE[key] = (time.time(), {**out, "until": time.time() - 1})
    assert run(auth.session_user(db, value)) is None


def test_revoking_the_token_ends_its_page_sessions():
    db = Db()
    raw, doc = _token(db)
    value, _ = _mint(db, raw)
    assert run(auth.session_user(db, value))
    assert run(auth.revoke_agent_token(db, doc["id"], "default"))
    assert run(auth.session_user(db, value)) is None
    assert not [s for s in db[auth.SESSIONS].rows if s.get("kind") == auth.PAGE_KIND]


def test_a_token_revoked_behind_its_back_is_checked_too():
    db = Db()
    raw, doc = _token(db)
    value, _ = _mint(db, raw)
    db[auth.TOKENS].rows[0]["revoked"] = True               # no revoke_agent_token call
    auth._CACHE.clear()
    assert run(auth.session_user(db, value)) is None


def test_a_persons_page_session_ends_when_their_account_is_disabled():
    db = Db()
    u = run(auth.make_first_user(db, "o@example.com", "O", "a long password"))
    who = {"type": "user", "id": u["_id"], "name": "O"}
    value, _ = run(auth.create_page_session(db, "default", who, user_id=u["_id"]))
    got = run(auth.session_user(db, value))
    assert got["role"] == "viewer" and got["user"]["id"] == u["_id"]
    db[auth.USERS].rows[0]["disabled"] = True
    auth._CACHE.clear()
    assert run(auth.session_user(db, value)) is None


def test_the_server_makes_one_for_whoever_asks(monkeypatch):
    db = Db()
    raw, doc = _token(db)
    monkeypatch.setenv("REDLINE_REQUIRE_SIGNIN", "true")
    agent = run(auth.token_agent(db, raw))
    a, w = actors.CURRENT.set(agent["actor"]), scope.WORKSPACE.set("default")
    try:
        jar = run(auth.page_session_for_request(db))
    finally:
        actors.CURRENT.reset(a)
        scope.WORKSPACE.reset(w)
    assert jar["name"] == auth.COOKIE
    assert run(auth.session_user(db, jar["value"]))["role"] == "viewer"
    # A page session does not make another.
    a = actors.CURRENT.set({**agent["actor"], "page": True})
    try:
        with pytest.raises(PermissionError):
            run(auth.page_session_for_request(db))
    finally:
        actors.CURRENT.reset(a)
    monkeypatch.setenv("REDLINE_REQUIRE_SIGNIN", "false")
    assert run(auth.page_session_for_request(db)) is None


# ---------------------------------------------------------------- what it may do

def test_a_page_session_only_reads():
    assert access.page_allowed("GET", "/api/catalog")
    assert access.page_allowed("GET", "/api/boards/b/board.glb")
    assert access.page_allowed("GET", "/api/auth/state")
    assert access.page_allowed("POST", "/api/auth/logout")           # it may end itself
    # Not the writes a viewer may make, and nothing a viewer may not see.
    for method, path in [("POST", "/api/agent/db"), ("GET", "/api/admin/users"),
                         ("POST", "/api/boards/b/rules/check"), ("POST", "/api/tools/find"),
                         ("POST", "/api/auth/page-session"), ("POST", "/api/revisions"),
                         ("DELETE", "/api/notes/n"), ("PUT", "/api/settings"),
                         ("GET", "/api/agent-tokens")]:
        assert not access.page_allowed(method, path), (method, path)


def test_every_route_a_page_session_reaches_is_a_viewers():
    from tests.test_access import routes
    for method, path in routes():
        if access.page_allowed(method, path):
            assert access.allowed("viewer", access.action(method, path)), (method, path)


def test_minting_one_needs_a_token_with_a_role():
    act = access.action("POST", "/api/auth/page-session")
    assert act == "view"
    assert not access.allowed(None, act)                             # signed out: no
    assert all(access.allowed(r, act) for r in access.TOKEN_ROLES)


# ---------------------------------------------------------------- through the app

@pytest.fixture
def app(monkeypatch):
    from fastapi.testclient import TestClient
    from backend import main
    db = Db()
    monkeypatch.setattr(main, "db", lambda: db)
    monkeypatch.setenv("REDLINE_REQUIRE_SIGNIN", "true")
    return TestClient(main.app), db


def test_the_endpoint_trades_a_token_for_a_read_only_cookie(app):
    client, db = app
    raw, _ = _token(db, role="reviewer", workspace="ws2")
    r = client.post("/api/auth/page-session", headers={"Authorization": "Bearer " + raw})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cookie"] == auth.COOKIE and body["role"] == "viewer" and body["workspace"] == "ws2"
    assert body["expires"] - time.time() <= auth.PAGE_MINUTES * 60
    assert r.headers["cache-control"] == "no-store"
    assert "set-cookie" not in r.headers                    # handed to the caller, not set here
    assert raw not in r.text
    value = body["value"]
    jar = {auth.COOKIE: value}
    state = client.get("/api/auth/state", cookies=jar).json()
    assert state["role"] == "viewer" and state["can"] == ["view"] and not state["must_change_password"]
    # Looking gets past the gate (404: no such route, but not 401 or 403).
    assert client.get("/api/no-such-thing", cookies=jar).status_code == 404
    # Changing anything does not, even a viewer's permitted POST.
    for path in ("/api/agent/db", "/api/revisions", "/api/auth/page-session"):
        r = client.post(path, cookies=jar, headers={"x-redline-csrf": "1"})
        assert r.status_code == 403 and r.json()["refused"] == "page", path
    assert client.get("/api/agent-tokens", cookies=jar).status_code == 403
    # And it can end itself.
    assert client.post("/api/auth/logout", cookies=jar,
                       headers={"x-redline-csrf": "1"}).status_code == 200
    assert client.get("/api/auth/state", cookies=jar).json()["user"] is None


def test_the_endpoint_refuses_anything_but_a_good_token(app):
    client, db = app
    assert client.post("/api/auth/page-session").status_code == 401
    r = client.post("/api/auth/page-session", headers={"Authorization": "Bearer rlat_wrong"})
    assert r.status_code == 401
    raw, doc = _token(db)
    run(auth.revoke_agent_token(db, doc["id"], "default"))
    r = client.post("/api/auth/page-session", headers={"Authorization": "Bearer " + raw})
    assert r.status_code == 401
    # A person's own session does not buy one: only a token does.
    u = run(auth.make_first_user(db, "o@example.com", "O", "a long password"))
    mine = run(auth.create_session(db, u, "default"))
    r = client.post("/api/auth/page-session", cookies={auth.COOKIE: mine},
                    headers={"x-redline-csrf": "1"})
    assert r.status_code == 401


def test_with_sign_in_off_there_is_nothing_to_trade(app, monkeypatch):
    client, db = app
    raw, _ = _token(db)
    monkeypatch.setenv("REDLINE_REQUIRE_SIGNIN", "false")
    r = client.post("/api/auth/page-session", headers={"Authorization": "Bearer " + raw})
    assert r.status_code == 400


# ---------------------------------------------------------------- render.py's side

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import render  # noqa: E402


def test_render_finds_the_token_without_saying_it(tmp_path):
    env = tmp_path / ".env"
    env.write_text('OTHER="x"\nREDLINE_TOKEN=rlat_new\n')
    assert render.agent_token({}, env) == "rlat_new"
    assert render.agent_token({"REDLINE_TOKEN": "rlat_env"}, env) == "rlat_env"
    assert render.agent_token({}, tmp_path / "missing") is None


def test_render_asks_for_a_session_only_when_sign_in_is_on():
    seen = []

    def call(method, path, headers=None):
        seen.append((method, path, headers))
        if path == "/api/auth/state":
            return {"mode": mode}
        return {"cookie": auth.COOKIE, "value": "v", "expires": time.time() + 600}

    mode = "off"
    assert render.page_session("rlat_x", call) is None
    assert [p for _, p, _ in seen] == ["/api/auth/state"]
    mode = "on"
    got = render.page_session("rlat_x", call)
    assert got["value"] == "v"
    assert seen[-1] == ("POST", "/api/auth/page-session", {"Authorization": "Bearer rlat_x"})
    with pytest.raises(SystemExit) as exc:
        render.page_session(None, call)
    assert "REDLINE_TOKEN" in str(exc.value)


def test_render_never_puts_the_session_in_the_address_or_on_the_command_line():
    session = {"cookie": auth.COOKIE, "value": "secret-value", "expires": time.time() + 600}
    c = render.browser_cookie(session, "http://127.0.0.1:4200")
    assert c["url"] == "http://127.0.0.1:4200/" and c["httpOnly"] and c["value"] == "secret-value"
    argv = render.browser_argv(("local", "/usr/bin/chromium"), 9411, 800, 600, "/tmp/p",
                               "about:blank", "n")
    assert "secret-value" not in json.dumps(argv)
