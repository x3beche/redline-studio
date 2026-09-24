"""Signing in: passwords, sessions, the first account, guessing, CSRF."""
import asyncio
from datetime import datetime, timedelta, timezone

from backend import auth


def run(c):
    return asyncio.run(c)


class Coll:
    def __init__(self):
        self.rows = []

    async def insert_one(self, doc):
        self.rows.append(dict(doc))

    async def find_one(self, q=None, proj=None):
        for r in self.rows:
            if all(r.get(k) == v for k, v in (q or {}).items()):
                return {k: v for k, v in r.items() if not proj or proj.get(k, 1)}
        return None

    async def update_one(self, q, update, upsert=False):
        for r in self.rows:
            if all(r.get(k) == v for k, v in q.items()):
                r.update(update.get("$set", {}))
                return
        if upsert:
            self.rows.append({**q, **update.get("$set", {}), **update.get("$setOnInsert", {})})

    async def delete_one(self, q):
        self.rows = [r for r in self.rows if not all(r.get(k) == v for k, v in q.items())]


class Db(dict):
    def __missing__(self, k):
        self[k] = Coll()
        return self[k]


def test_passwords_hash_and_check():
    h = auth.hash_password("correct horse battery")
    assert h.startswith("scrypt$") and "correct" not in h
    assert auth.check_password("correct horse battery", h)
    assert not auth.check_password("wrong", h)
    assert not auth.check_password("x", "not a hash")
    assert auth.hash_password("same") != auth.hash_password("same")       # salted


def test_short_passwords_are_refused():
    assert auth.password_problem("short") and not auth.password_problem("long enough pw")


def test_the_first_account_owns_the_workspace_and_there_is_only_one_first():
    db = Db()
    u = run(auth.make_first_user(db, "Owner@Example.com", "Owner", "a long password"))
    assert u["email"] == "owner@example.com" and "pw" in u
    assert db["memberships"].rows[0]["role"] == "owner"
    try:
        run(auth.make_first_user(db, "x@example.com", "", "another long one"))
        raise AssertionError("a second first account was made")
    except PermissionError:
        pass


def test_login_session_and_sign_out():
    db = Db()
    run(auth.make_first_user(db, "o@example.com", "O", "a long password"))
    assert run(auth.check_login(db, "o@example.com", "wrong password")) is None
    assert run(auth.check_login(db, "nobody@example.com", "a long password")) is None
    user, ws = run(auth.check_login(db, "O@example.com", "a long password"))
    token = run(auth.create_session(db, user, ws))
    assert token not in str(db["sessions"].rows)                         # only its digest is stored
    auth._CACHE.clear()
    got = run(auth.session_user(db, token))
    assert got["user"]["email"] == "o@example.com" and got["workspace"] == "default"
    run(auth.end_session(db, token))
    auth._CACHE.clear()
    assert run(auth.session_user(db, token)) is None


def test_an_expired_session_signs_nobody_in():
    db = Db()
    run(auth.make_first_user(db, "o@example.com", "O", "a long password"))
    user, ws = run(auth.check_login(db, "o@example.com", "a long password"))
    token = run(auth.create_session(db, user, ws))
    db["sessions"].rows[0]["expires"] = datetime.now(timezone.utc) - timedelta(minutes=1)
    auth._CACHE.clear()
    assert run(auth.session_user(db, token)) is None


def test_guessing_is_slowed_after_five_misses():
    auth._FAILS.clear()
    for _ in range(4):
        auth.failed("a@example.com")
    assert not auth.locked_out("a@example.com")
    auth.failed("a@example.com")
    assert auth.locked_out("a@example.com")
    auth.cleared("a@example.com")
    assert not auth.locked_out("a@example.com")


def test_which_requests_need_a_session_and_the_csrf_header():
    assert auth.needs_session("GET", "/api/catalog")
    assert not auth.needs_session("POST", "/api/auth/login")
    assert not auth.needs_session("GET", "/index.html")
    assert auth.csrf_ok("GET", {})
    assert not auth.csrf_ok("POST", {})
    assert auth.csrf_ok("DELETE", {"x-redline-csrf": "1"})


def test_sign_in_is_off_unless_asked_for(monkeypatch):
    monkeypatch.delenv("X3_AUTH", raising=False)
    assert not auth.enabled()
    monkeypatch.setenv("X3_AUTH", "on")
    assert auth.enabled()
