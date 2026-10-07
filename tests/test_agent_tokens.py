"""Agent tokens on the Settings page: made with a last day, taken back,
deleted for good, kept to those who may hand them out - and their usage,
counted per token and day and added up for the page. Never the token or
its hash in an answer. Sign-in is on; the database is test_telegram's fake."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import actors, auth, scope, usage
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
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()
    now = datetime.now(timezone.utc)
    # u-ed is the owner (the default space); u-view another account, in a
    # private space of its own.
    for uid, role in (("u-ed", "owner"), ("u-view", "user")):
        run(fake["users"].insert_one({"_id": uid, "email": f"{uid}@example.com", "name": uid, "role": role,
                                      "pw": auth.hash_password(PW), "created_at": now}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()


def person(fake, uid: str) -> TestClient:
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.cookies.set(auth.COOKIE, run(auth.create_session(fake, {"_id": uid}, "default", "Mozilla/5.0")))
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def agent(token: str) -> TestClient:
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.headers["Authorization"] = "Bearer " + token
    return c


def make(c: TestClient, name="bot", **kw) -> dict:
    r = c.post("/api/agent-tokens", json={"name": name, "role": "editor", **kw})
    assert r.status_code == 200, r.text
    return r.json()


def no_secrets(fake, text: str) -> None:
    for d in fake["agent_tokens"].docs.values():
        assert d["_id"] not in text                   # the SHA-256
    assert auth.TOKEN_PREFIX not in text


def test_a_token_with_a_last_day(db):
    ed = person(db, "u-ed")
    t = make(ed, expires_days=30, room="pcb")
    assert t["token"].startswith(auth.TOKEN_PREFIX) and t["status"] == "active"
    exp = datetime.fromisoformat(t["expires_at"].replace("Z", "+00:00"))
    exp = exp if exp.tzinfo else exp.replace(tzinfo=timezone.utc)
    assert timedelta(days=29, hours=23) < exp - datetime.now(timezone.utc) <= timedelta(days=30)
    never = make(ed, "forever")
    assert never["expires_at"] is None
    assert ed.post("/api/agent-tokens", json={"name": "x", "expires_days": 0}).status_code == 422
    rows = ed.get("/api/agent-tokens").json()
    assert {r["name"]: r["status"] for r in rows} == {"bot": "active", "forever": "active"}
    no_secrets(db, ed.get("/api/agent-tokens").text)
    trail = [d for d in db["audit"].docs.values() if d["action"] == "token" and d["target"] == "bot"]
    assert trail and trail[0]["detail"]["expires_days"] == 30


def test_an_expired_token_is_refused(db):
    ed = person(db, "u-ed")
    t = make(ed, expires_days=7)
    assert agent(t["token"]).get("/api/health").status_code != 401
    doc = next(d for d in db["agent_tokens"].docs.values() if d["id"] == t["id"])
    doc["expires_at"] = datetime.now(timezone.utc) - timedelta(minutes=1)
    auth._TOKEN_CACHE.clear()
    r = agent(t["token"]).get("/api/health")
    assert r.status_code == 401
    assert run(auth.token_agent(db, t["token"])) is None
    assert {r["id"]: r["status"] for r in ed.get("/api/agent-tokens").json()}[t["id"]] == "expired"


def test_an_expiry_while_remembered_is_refused_too(db):
    ed = person(db, "u-ed")
    t = make(ed, expires_days=7)
    assert run(auth.token_agent(db, t["token"]))      # now in the cache
    key, (at, out) = next(iter(auth._TOKEN_CACHE.items()))
    auth._TOKEN_CACHE[key] = (at, {**out, "expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
    assert run(auth.token_agent(db, t["token"])) is None


def test_revoke_keeps_it_listed_and_old_clients_still_work(db):
    ed = person(db, "u-ed")
    t = make(ed)
    r = ed.delete(f"/api/agent-tokens/{t['id']}")
    assert r.status_code == 200 and r.json() == {"revoked": t["id"]}
    assert agent(t["token"]).get("/api/health").status_code == 401
    assert [r["status"] for r in ed.get("/api/agent-tokens").json()] == ["revoked"]
    assert any(d["action"] == "token-revoke" and d["target"] == "bot" for d in db["audit"].docs.values())


def test_purge_deletes_an_active_token_for_good(db):
    ed = person(db, "u-ed")
    t = make(ed)
    agent(t["token"]).get("/api/health")
    run(auth.flush_usage(db))
    assert db["agent_token_usage"].docs
    r = ed.delete(f"/api/agent-tokens/{t['id']}?purge=1")
    assert r.status_code == 200 and r.json() == {"deleted": t["id"]}
    assert ed.get("/api/agent-tokens").json() == []
    assert not db["agent_token_usage"].docs
    auth._TOKEN_CACHE.clear()
    assert agent(t["token"]).get("/api/health").status_code == 401
    gone = [d for d in db["audit"].docs.values() if d["action"] == "token-delete"]
    assert gone and gone[0]["target"] == "bot" and gone[0]["detail"]["was"] == "active"
    assert ed.delete(f"/api/agent-tokens/{t['id']}?purge=1").status_code == 404


def test_a_revoked_token_can_be_deleted(db):
    ed = person(db, "u-ed")
    t = make(ed)
    ed.delete(f"/api/agent-tokens/{t['id']}")
    assert ed.delete(f"/api/agent-tokens/{t['id']}?purge=1").status_code == 200
    assert ed.get("/api/agent-tokens").json() == []


def test_another_account_and_an_agent_may_not(db):
    ed, other = person(db, "u-ed"), person(db, "u-view")
    t = make(ed)
    # another account has its own tokens, and cannot see or touch these
    assert other.get("/api/agent-tokens").json() == []
    for m, p in (("get", f"/api/agent-tokens/{t['id']}/usage"), ("delete", f"/api/agent-tokens/{t['id']}?purge=1"),
                 ("delete", f"/api/agent-tokens/{t['id']}")):
        assert getattr(other, m)(p).status_code == 404, p
    assert other.post("/api/agent-tokens", json={"name": "x"}).status_code == 200
    assert len(ed.get("/api/agent-tokens").json()) == 1
    # an agent (an editor) is not a person: it hands out and takes back nothing
    bot = agent(t["token"])
    assert bot.get("/api/agent-tokens").status_code == 403
    assert bot.delete(f"/api/agent-tokens/{t['id']}?purge=1").status_code == 403
    assert len(ed.get("/api/agent-tokens").json()) == 1
    # a token never names the space it works in
    assert "workspace" not in ed.get("/api/agent-tokens").json()[0]


def test_an_agent_is_an_editor_at_most(db):
    for uid in ("u-ed", "u-view"):
        p = person(db, uid)
        for role in ("owner", "admin", "user"):
            assert p.post("/api/agent-tokens", json={"name": "x", "role": role}).status_code == 400, (uid, role)
        assert p.post("/api/agent-tokens", json={"name": "x", "role": "editor"}).status_code == 200


def test_usage_is_counted_and_added_up(db):
    ed = person(db, "u-ed")
    a, b = make(ed, "alpha"), make(ed, "beta")
    for _ in range(3):
        agent(a["token"]).get("/api/health")
    agent(a["token"]).post("/api/agent-tokens", json={"name": "nope"})     # a write, refused
    agent(b["token"]).get("/api/health")
    # counted in memory, not yet written ...
    assert sum(r["n"] for r in auth._USAGE.values()) == 5
    # ... and written out as one row per token and day
    run(auth.flush_usage(db))
    rows = list(db["agent_token_usage"].docs.values())
    assert len(rows) == 2 and not auth._USAGE
    ra = next(r for r in rows if r["token"] == a["id"])
    assert ra["n"] == 4 and ra["read"] == 3 and ra["write"] == 1 and ra["acts"]["tokens"] == 1
    assert ra["day"] == datetime.now(timezone.utc).strftime("%Y-%m-%d") and ra["workspace"] == "default"
    # people's requests are not counted
    ed.get("/api/health")
    assert not auth._USAGE
    # once more: the same row grows
    agent(a["token"]).get("/api/health")
    run(auth.flush_usage(db))
    assert next(r for r in db["agent_token_usage"].docs.values() if r["token"] == a["id"])["n"] == 5
    # a row from yesterday, and one from another workspace that must not show
    yday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    run(db["agent_token_usage"].insert_one({"_id": f"{a['id']}:{yday}", "token": a["id"], "workspace": "default",
                                            "day": yday, "n": 10, "read": 10, "write": 0}))
    run(db["agent_token_usage"].insert_one({"_id": "zz:x", "token": "zz", "workspace": "team2",
                                            "day": yday, "n": 99, "read": 99, "write": 0}))

    r = ed.get("/api/agent-tokens/usage")
    assert r.status_code == 200, r.text
    u = r.json()
    no_secrets(db, r.text)
    assert len(u["days"]) == 30 and u["chart"]["n"] == 30 and u["chart"]["step"] == 86400
    assert u["totals"]["today"] == 6 and u["totals"]["d7"] == 16 and u["totals"]["d30"] == 16
    assert u["totals"]["active"] == 2 and u["totals"]["read"] == 15 and u["totals"]["write"] == 1
    assert u["top"]["id"] == a["id"] and u["top"]["name"] == "alpha" and u["top"]["d30"] == 15
    pa = u["per_token"][a["id"]]
    assert pa["today"] == 5 and pa["d7"] == 15 and pa["series"][-2:] == [10, 5]
    assert u["per_token"][b["id"]]["d7"] == 1 and "zz" not in u["per_token"]
    assert {s["name"] for s in u["chart"]["series"]} == {"alpha", "beta"}

    # one token in detail, with its LLM calls and its audit lines
    tok = actors.CURRENT.set({"type": "agent", "id": "alpha", "name": "alpha", "token": a["id"]})
    try:
        run(usage.record_call(db, _id="or:1", provider="openrouter", model="m1", input=100, output=20,
                              cost_usd=0.01))
    finally:
        actors.CURRENT.reset(tok)
    run(usage.record_call(db, _id="or:2", provider="openrouter", model="m1", input=5, output=5))
    run(actors.audit(db, "delete", "/api/notes/n1", {"method": "DELETE"},
                     actor={"type": "agent", "id": "alpha", "name": "alpha", "token": a["id"]}))
    d = ed.get(f"/api/agent-tokens/{a['id']}/usage")
    assert d.status_code == 200, d.text
    d = d.json()
    assert d["totals"] == {"n": 15, "read": 14, "write": 1}
    assert d["series"][-1] == 5 and d["reads"][-2] == 10 and d["writes"][-1] == 1
    assert d["acts"]["tokens"] == 1
    assert d["audit"]["by_action"] == {"delete": 1} and d["audit"]["recent"][0]["target"] == "/api/notes/n1"
    assert d["llm"]["calls"] == 1 and d["llm"]["tokens"] == 120 and d["llm"]["by_model"] == {"m1": 1}
    assert ed.get("/api/agent-tokens/nope/usage").status_code == 404
