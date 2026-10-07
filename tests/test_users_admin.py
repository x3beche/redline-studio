"""System roles, private spaces and the admin panel (backend/auth.py,
backend/admin.py): the first account is the owner, the owner and the admins
manage the accounts, and each account's data is its own. Sign-in is on; the
database is test_telegram's fake and the sessions are real ones."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import actors, auth, scope
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
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._FAILS):
        c.clear()
    now = datetime.now(timezone.utc)
    for uid, role in (("o", "owner"), ("ad", "admin"), ("ad2", "admin"), ("a", "user"), ("b", "user")):
        run(fake["users"].insert_one({"_id": uid, "email": f"{uid}@example.com", "name": uid.upper(),
                                      "role": role, "pw": auth.hash_password(PW), "created_at": now}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._FAILS):
        c.clear()


def app() -> TestClient:
    return TestClient(__import__("backend.main", fromlist=["app"]).app)


def person(fake, uid: str) -> TestClient:
    c = app()
    c.cookies.set(auth.COOKIE, run(auth.create_session(fake, {"_id": uid}, "ignored", "Mozilla/5.0")))
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def login(email: str, password: str) -> TestClient:
    c = app()
    c.headers[auth.CSRF_HEADER] = "1"
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    c.status = r.status_code
    return c


def agent(token: str) -> TestClient:
    c = app()
    c.headers["Authorization"] = "Bearer " + token
    return c


def audit(fake, action: str) -> list[dict]:
    return [d for d in fake["audit"].docs.values() if d["action"] == action]


# ---------------------------------------------------------------- the migration

def test_the_migration_makes_the_first_account_the_owner_and_is_idempotent():
    fake = FakeDb()
    old = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run(fake["users"].insert_one({"_id": "first", "email": "f@x.y", "pw": "h", "created_at": old}))
    run(fake["users"].insert_one({"_id": "adm", "email": "a@x.y", "pw": "h", "created_at": old + timedelta(days=1)}))
    run(fake["users"].insert_one({"_id": "ed", "email": "e@x.y", "pw": "h", "created_at": old + timedelta(days=2)}))
    for uid, role in (("first", "owner"), ("adm", "admin"), ("ed", "editor")):
        run(fake["memberships"].insert_one({"_id": f"{uid}:default", "user": uid, "workspace": "default",
                                            "role": role}))
    got = run(auth.migrate(fake))
    assert got == {"owner": "first", "updated": 3}
    users = fake["users"].docs
    assert (users["first"]["role"], users["first"]["space"]) == ("owner", "default")
    assert (users["adm"]["role"], users["adm"]["space"]) == ("admin", "uadm")
    assert (users["ed"]["role"], users["ed"]["space"]) == ("user", "ued")
    before = {k: dict(v) for k, v in users.items()}
    assert run(auth.migrate(fake)) == {"owner": "first", "updated": 0}          # again: nothing
    assert {k: dict(v) for k, v in fake["users"].docs.items()} == before
    assert fake["memberships"].docs                                             # left as it was


def test_without_memberships_the_oldest_account_is_the_owner():
    fake = FakeDb()
    old = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run(fake["users"].insert_one({"_id": "late", "email": "l@x.y", "created_at": old + timedelta(days=3)}))
    run(fake["users"].insert_one({"_id": "early", "email": "e@x.y", "created_at": old}))
    assert run(auth.migrate(fake))["owner"] == "early"
    assert fake["users"].docs["late"]["role"] == "user"
    assert run(auth.migrate(FakeDb())) == {"owner": None, "updated": 0}         # nobody yet


def test_the_signed_in_role_and_space_are_the_accounts(db):
    st = person(db, "o").get("/api/auth/state").json()
    assert st["role"] == "owner" and "users" in st["can"] and "workspace" not in st
    st = person(db, "a").get("/api/auth/state").json()
    assert st["role"] == "user" and "users" not in st["can"] and "settings" not in st["can"]
    assert "space" in st["can"] and "tokens" in st["can"]
    me = person(db, "a").get("/api/me").json()
    assert me["role"] == "user" and "workspace" not in me


# ---------------------------------------------------------------- who may

def test_a_user_cannot_reach_the_admin_apis(db):
    a = person(db, "a")
    for m, p in (("get", "/api/admin/users"), ("post", "/api/admin/users"), ("patch", "/api/admin/users/b"),
                 ("post", "/api/admin/users/b/password"), ("post", "/api/admin/users/b/sign-out"),
                 ("delete", "/api/admin/users/b")):
        kw = {"json": {}} if m in ("post", "patch") else {}
        r = getattr(a, m)(p, **kw)
        assert r.status_code == 403 and r.json()["refused"] == "users", (m, p)
    # nor the server's settings
    assert a.put("/api/llm/settings", json={}).status_code == 403
    # an agent's token neither, whoever made it
    tok = person(db, "o").post("/api/agent-tokens", json={"name": "bot"}).json()["token"]
    assert agent(tok).get("/api/admin/users").status_code == 403


def test_the_admins_list_everyone(db):
    r = person(db, "ad").get("/api/admin/users")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [u["id"] for u in body["users"]][0] == "o"                       # the owner first
    assert {u["role"] for u in body["users"]} == {"owner", "admin", "user"}
    assert '"pw"' not in r.text and "scrypt" not in r.text and '"avatar":' not in r.text
    assert body["my_role"] == "admin" and next(u for u in body["users"] if u["id"] == "ad")["me"]


def test_only_the_owner_changes_roles(db):
    o, ad = person(db, "o"), person(db, "ad")
    assert ad.patch("/api/admin/users/a", json={"role": "admin"}).status_code == 403
    assert ad.patch("/api/admin/users/o", json={"role": "user"}).status_code == 403   # nor demotes the owner
    assert ad.patch("/api/admin/users/ad2", json={"role": "user"}).status_code == 403
    r = o.patch("/api/admin/users/a", json={"role": "admin"})
    assert r.status_code == 200 and r.json()["role"] == "admin"
    assert person(db, "a").get("/api/admin/users").status_code == 200          # at once
    assert o.patch("/api/admin/users/a", json={"role": "user"}).json()["role"] == "user"
    assert o.patch("/api/admin/users/a", json={"role": "owner"}).status_code == 400  # one owner
    assert o.patch("/api/admin/users/o", json={"role": "admin"}).status_code == 403  # the owner stays
    assert {d["detail"]["role"] for d in audit(db, "user-role")} == {"admin", "user"}


def test_an_admin_manages_users_but_not_the_owner_or_other_admins(db):
    ad = person(db, "ad")
    assert ad.patch("/api/admin/users/a", json={"name": "Ayşe"}).json()["name"] == "Ayşe"
    for target in ("o", "ad2"):
        assert ad.patch(f"/api/admin/users/{target}", json={"name": "x"}).status_code == 403
        assert ad.patch(f"/api/admin/users/{target}", json={"disabled": True}).status_code == 403
        assert ad.post(f"/api/admin/users/{target}/password", json={"password": "temporary pw 1"}).status_code == 403
        assert ad.post(f"/api/admin/users/{target}/sign-out").status_code == 403
    # an admin edits their own name here, but does not disable themselves
    assert ad.patch("/api/admin/users/ad", json={"name": "Admin"}).status_code == 200
    assert ad.patch("/api/admin/users/ad", json={"disabled": True}).status_code == 400


def test_the_owner_cannot_be_disabled_demoted_or_deleted(db):
    o = person(db, "o")
    assert o.patch("/api/admin/users/o", json={"disabled": True}).status_code == 403
    assert o.delete("/api/admin/users/o").status_code == 403
    assert not db["users"].docs["o"].get("disabled")


def test_only_the_owner_deletes_and_data_needs_saying_so(db):
    a_data = scope.ScopedDb(db, "ua")
    run(a_data.notes.insert_one({"_id": "n1", "text": "a's"}))
    tok = person(db, "a").post("/api/agent-tokens", json={"name": "a-bot"}).json()
    assert person(db, "ad").delete("/api/admin/users/a").status_code == 403
    o = person(db, "o")
    r = o.delete("/api/admin/users/a")
    assert r.status_code == 409 and "1 items" in r.json()["detail"]
    assert "a" in db["users"].docs
    r = o.delete("/api/admin/users/a?with_data=1")
    assert r.status_code == 200 and r.json()["removed"] >= 1
    assert "a" not in db["users"].docs
    assert not [d for d in db["notes"].docs.values() if d.get("workspace_id") == "ua"]
    assert not [d for d in db["agent_tokens"].docs.values() if d["id"] == tok["id"]]
    auth._TOKEN_CACHE.clear()
    assert agent(tok["token"]).get("/api/health").status_code == 401
    # someone with nothing in their space goes without asking
    assert o.delete("/api/admin/users/b").status_code == 200
    assert {d["action"] for d in db["audit"].docs.values()} >= {"user-delete"}


# ---------------------------------------------------------------- adding, disabling, passwords

def test_an_admin_adds_an_account_with_a_password_to_change(db):
    ad = person(db, "ad")
    r = ad.post("/api/admin/users", json={"name": "Zz New", "email": "ZZ@Example.com",
                                          "password": "temporary pw 1", "must_change_password": True})
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["role"] == "user" and new["email"] == "zz@example.com" and new["must_change_password"]
    stored = db["users"].docs[new["id"]]
    assert stored["space"] == "u" + new["id"] and "temporary" not in str(stored)
    assert ad.post("/api/admin/users", json={"email": "zz@example.com", "password": "another pw 12"}).status_code == 409
    assert ad.post("/api/admin/users", json={"email": "x@example.com", "password": "short"}).status_code == 400
    assert audit(db, "user-add")


def test_the_password_must_be_changed_before_anything_else(db):
    person(db, "ad").post("/api/admin/users", json={"name": "Zz", "email": "zz@example.com",
                                                    "password": "temporary pw 1", "must_change_password": True})
    c = login("zz@example.com", "temporary pw 1")
    assert c.status == 200
    st = c.get("/api/auth/state").json()
    assert st["must_change_password"] is True
    assert c.get("/api/me").status_code == 200                               # who am I: yes
    r = c.get("/api/notes")
    assert r.status_code == 403 and r.json()["refused"] == "password"
    assert c.post("/api/auth/new-password", json={"new": "temporary pw 1"}).status_code == 400   # the same
    assert c.post("/api/auth/new-password", json={"new": "short"}).status_code == 400
    assert c.post("/api/auth/new-password", json={"new": "my own password 9"}).status_code == 200
    assert c.get("/api/auth/state").json()["must_change_password"] is False
    assert c.get("/api/notes").status_code == 200
    assert c.post("/api/auth/new-password", json={"new": "yet another pw 9"}).status_code == 409
    assert login("zz@example.com", "my own password 9").status == 200
    assert login("zz@example.com", "temporary pw 1").status == 401


def test_a_reset_password_ends_sessions_and_asks_for_a_new_one(db):
    a = person(db, "a")
    assert a.get("/api/notes").status_code == 200
    r = person(db, "ad").post("/api/admin/users/a/password", json={"password": "temporary pw 2"})
    assert r.status_code == 200 and r.json()["signed_out"] >= 1
    assert a.get("/api/notes").status_code == 401                            # signed out
    c = login("a@example.com", "temporary pw 2")
    assert c.get("/api/notes").json()["refused"] == "password"
    assert audit(db, "user-password")


def test_disabling_ends_sessions_blocks_sign_in_and_stops_tokens(db):
    a = person(db, "a")
    tok = a.post("/api/agent-tokens", json={"name": "a-bot"}).json()["token"]
    bot = agent(tok)
    assert bot.get("/api/notes").status_code == 200
    r = person(db, "ad").patch("/api/admin/users/a", json={"disabled": True})
    assert r.status_code == 200 and r.json()["disabled"] is True
    assert a.get("/api/notes").status_code == 401
    assert bot.get("/api/notes").status_code == 401
    assert login("a@example.com", PW).status == 401
    assert audit(db, "user-disable")[0]["detail"]["signed_out"] >= 1
    # enabled again: signs in, and the token works again
    person(db, "ad").patch("/api/admin/users/a", json={"disabled": False})
    assert login("a@example.com", PW).status == 200
    assert agent(tok).get("/api/notes").status_code == 200


def test_sign_out_everywhere(db):
    a1, a2 = person(db, "a"), person(db, "a")
    r = person(db, "o").post("/api/admin/users/a/sign-out")
    assert r.status_code == 200 and r.json()["signed_out"] == 2
    assert a1.get("/api/notes").status_code == 401 and a2.get("/api/notes").status_code == 401


def test_an_admin_changes_a_users_email_but_not_to_one_taken(db):
    ad = person(db, "ad")
    assert ad.patch("/api/admin/users/a", json={"email": "b@example.com"}).status_code == 409
    assert ad.patch("/api/admin/users/a", json={"email": "nope"}).status_code == 400
    assert ad.patch("/api/admin/users/a", json={"email": "A2@example.com"}).json()["email"] == "a2@example.com"
    assert login("a2@example.com", PW).status == 200


# ---------------------------------------------------------------- private spaces

def test_each_account_sees_only_its_own_data(db):
    a, b, o = person(db, "a"), person(db, "b"), person(db, "o")
    # notes, through the app
    assert a.post("/api/notes", json={"text": "a's secret"}).status_code == 200
    assert [n["text"] for n in a.get("/api/notes").json()] == ["a's secret"]
    assert b.get("/api/notes").json() == [] and o.get("/api/notes").json() == []
    # a model and a chat in a's space: the same names elsewhere are not there
    space = scope.ScopedDb(db, "ua")
    run(space.models.insert_one({"_id": "proj/part", "source": "x = 1", "title": "A's"}))
    run(space.cc_chats.insert_one({"_id": "c1", "title": "a's chat", "messages": [],
                                   "updated_at": datetime.now(timezone.utc)}))
    assert a.get("/api/models/proj/part/source").status_code == 200
    assert b.get("/api/models/proj/part/source").status_code == 404
    assert o.get("/api/models/proj/part/source").status_code == 404
    assert a.get("/api/cc/chats/c1").status_code == 200
    assert b.get("/api/cc/chats/c1").status_code == 404 and o.get("/api/cc/chats/c1").status_code == 404
    # a's agent token works in a's space, not the owner's
    tok = a.post("/api/agent-tokens", json={"name": "a-bot"}).json()["token"]
    assert [n["text"] for n in agent(tok).get("/api/notes").json()] == ["a's secret"]
    assert b.get("/api/agent-tokens").json() == []


def test_a_new_account_starts_empty_and_the_owner_keeps_the_old_data(db):
    run(scope.ScopedDb(db, scope.DEFAULT).notes.insert_one({"_id": "old", "text": "from before"}))
    db["notes"].docs["old"].pop("workspace_id", None)                         # as written before spaces
    assert [n["text"] for n in person(db, "o").get("/api/notes").json()] == ["from before"]
    r = person(db, "ad").post("/api/admin/users", json={"email": "zz@example.com", "password": "temporary pw 1",
                                                        "must_change_password": False})
    c = login("zz@example.com", "temporary pw 1")
    assert c.get("/api/notes").json() == []
    assert r.json()["role"] == "user"
