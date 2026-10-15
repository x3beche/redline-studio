"""Rate limits kept in the database (backend/ratelimit.py): they hold across
an API reload, are one count for every process, clean themselves up, and
never shut the site when the database does not answer. And the share
tokens stay out of the access log."""

from __future__ import annotations

import asyncio
import importlib
import logging

import pytest

from backend import ratelimit, shares
from test_telegram import FakeDb


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(ratelimit, "_indexed", False)
    monkeypatch.setattr(ratelimit, "_warned", 0.0)
    ratelimit._local.clear()
    yield
    ratelimit._local.clear()


def hits(db, n, scope="t", key="198.51.100.7", limit=3, window=600):
    return [run(ratelimit.hit(db, scope, key, limit, window)) for _ in range(n)]


def test_a_limit_is_counted_and_says_how_long_to_wait():
    db = FakeDb()
    got = hits(db, 4)
    assert [ok for ok, _ in got] == [True, True, True, False]
    assert [w for _, w in got[:3]] == [0, 0, 0] and 1 <= got[3][1] <= 600
    full, wait = run(ratelimit.full(db, "t", "198.51.100.7", 3, 600))
    assert full and 1 <= wait <= 600
    # Another key, another scope: counted apart.
    assert run(ratelimit.hit(db, "t", "198.51.100.8", 3, 600))[0]
    assert run(ratelimit.hit(db, "u", "198.51.100.7", 3, 600))[0]
    assert not run(ratelimit.full(db, "t", "198.51.100.8", 3, 600))[0]


def test_a_limit_outlives_a_reload_of_the_api():
    db = FakeDb()
    hits(db, 3)
    importlib.reload(ratelimit)                   # what a backend save does: the module starts afresh
    assert not ratelimit._local
    assert run(ratelimit.hit(db, "t", "198.51.100.7", 3, 600))[0] is False


def test_two_processes_share_one_count():
    db = FakeDb()
    a = ratelimit.Window("share-hits", 4, 60)     # each process makes its own
    b = ratelimit.Window("share-hits", 4, 60)
    got = [run(w.hit(db, "198.51.100.7"))[0] for w in (a, b, a, b, a)]
    assert got == [True, True, True, True, False]
    assert run(b.full(db, "198.51.100.7"))[0]


def test_a_new_window_starts_afresh(monkeypatch):
    db = FakeDb()
    t = [1_000_000.0]
    monkeypatch.setattr(ratelimit.time, "time", lambda: t[0])
    assert [ok for ok, _ in hits(db, 4, window=60)] == [True, True, True, False]
    assert hits(db, 1, window=60)[0][1] == 1_000_020 - 1_000_000          # the window ends at :20
    t[0] += 20
    assert hits(db, 1, window=60)[0] == (True, 0)


def test_the_counts_forget_themselves():
    made = []
    db = FakeDb()
    coll = db[ratelimit.COLL]

    async def create_index(*a, **kw):
        made.append((a, kw))
        return "ix"

    coll.create_index = create_index
    hits(db, 2)
    assert made == [(("expires",), {"expireAfterSeconds": 0})]   # once per process
    (doc,) = coll.docs.values()
    assert doc["count"] == 2 and doc["scope"] == "t" and doc["key"] == "198.51.100.7"
    assert (doc["expires"] - doc["start"]).total_seconds() == 600


class Down:
    """A database that does not answer: refused, or never."""

    def __init__(self, hang=False):
        self.hang = hang

    def __getitem__(self, name):
        return self

    async def _no(self, *a, **kw):
        if self.hang:
            await asyncio.sleep(10)
        raise ConnectionError("no database")

    create_index = find_one_and_update = find_one = _no


@pytest.mark.parametrize("hang", [False, True])
def test_no_database_does_not_shut_the_site(monkeypatch, caplog, hang):
    monkeypatch.setattr(ratelimit, "TIMEOUT", 0.05)
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        got = hits(Down(hang), 4)
    # Still counted - in this process's memory - and said once.
    assert [ok for ok, _ in got] == [True, True, True, False]
    assert run(ratelimit.full(Down(hang), "t", "198.51.100.7", 3, 600))[0]
    warned = [r for r in caplog.records if "rate limits" in r.getMessage()]
    assert len(warned) == 1 and "counting in memory" in warned[0].getMessage()


def test_share_tokens_stay_out_of_the_access_log():
    tok = "A" * 43
    rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                            ("203.0.113.9:5555", "GET", f"/api/public/s/{tok}/view/model.json?light=1",
                             "1.1", 200), None)
    assert shares.HideTokens().filter(rec)
    line = rec.getMessage()
    assert tok not in line
    assert '"GET /api/public/s/<token>/view/model.json?light=1 HTTP/1.1" 200' in line
    assert shares.redact(f'"GET /s/{tok} HTTP/1.1"') == '"GET /s/<token> HTTP/1.1"'
    assert shares.redact(f"/s/{tok}?x=1") == "/s/<token>?x=1"
    # Other addresses are left as they are.
    for path in ("/api/shares", "/api/things/s/abc", "/api/public/m/app.apk"):
        assert shares.redact(path) == path
    # The filter sits on uvicorn's access logger once the app is loaded.
    assert any(isinstance(f, shares.HideTokens) for f in logging.getLogger("uvicorn.access").filters)
