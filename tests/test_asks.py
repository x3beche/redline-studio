"""Asks that outlive the agent session (backend/asks.py): what a session had
in hand is kept with the session that holds it, given back when that
session goes away, and offered to the one that starts after it."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend import asks, chat, runs

OLD, NEW = "sess-old", "sess-new"
SEAT = "tmux:redline-cagsak"
RID = "20261014-070000-abc123"


def _match(doc: dict, q: dict) -> bool:
    for k, v in (q or {}).items():
        have = doc.get(k)
        if isinstance(v, dict) and "$in" in v:
            if have not in v["$in"]:
                return False
        elif isinstance(v, dict) and "$ne" in v:
            if have == v["$ne"]:
                return False
        elif v is None:
            if have is not None:
                return False
        elif have != v:
            return False
    return True


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        self.rows.sort(key=lambda d: str(d.get(key) or ""), reverse=direction < 0)
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield dict(r)
        return gen()


class Coll:
    def __init__(self):
        self.rows: dict = {}

    def find(self, q=None, proj=None):
        return Cursor([dict(r) for r in self.rows.values() if _match(r, q)])

    async def find_one(self, q, proj=None):
        r = next((r for r in self.rows.values() if _match(r, q)), None)
        return dict(r) if r else None

    async def insert_one(self, doc):
        self.rows[doc["_id"]] = dict(doc)

    async def replace_one(self, q, doc, upsert=False):
        self.rows[q["_id"]] = dict(doc)

    async def update_one(self, q, u, upsert=False):
        r = next((r for r in self.rows.values() if _match(r, q)), None)
        if r is None and upsert:
            r = self.rows.setdefault(q["_id"], {"_id": q["_id"]})
            r.update(u.get("$setOnInsert") or {})
        if r is None:
            return SimpleNamespace(matched_count=0, modified_count=0)
        r.update(u.get("$set") or {})
        return SimpleNamespace(matched_count=1, modified_count=1)

    async def update_many(self, q, u, upsert=False):
        n = 0
        for r in self.rows.values():
            if _match(r, q):
                r.update(u.get("$set") or {})
                n += 1
        return SimpleNamespace(matched_count=n, modified_count=n)


class Db:
    def __init__(self):
        self.c: dict[str, Coll] = {}

    def __getitem__(self, name):
        return self.c.setdefault(name, Coll())

    def __getattr__(self, name):
        if name.startswith("_") or name == "c":
            raise AttributeError(name)
        return self[name]


def run(coro):
    return asyncio.run(coro)


def ago(**kw) -> str:
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


@pytest.fixture
def db(monkeypatch):
    from backend import changes, compute
    d = Db()
    d.revisions.rows[RID] = {"_id": RID, "status": "queued", "comment": "make the lid one piece",
                             "kind": "cad", "created_at": ago(hours=3), "queued_at": ago(hours=3)}
    monkeypatch.setattr(compute, "machine_cpu", lambda: {"busy_s": 1.0})

    async def nothing(*a, **kw):
        return None
    monkeypatch.setattr(changes, "started", nothing)
    return d


def _start_as(db, session, agent="3d room"):
    return run(runs.start(db, RID, "one piece lid", "cad", {"name": agent}, session=session))


# ---------------------------------------------------------------- persistence

def test_who_holds_a_note_and_who_read_a_line_is_kept(db):
    run(asks.beat(db, OLD, "main"))
    _start_as(db, OLD)
    said = run(chat.post(db, "also round the corners"))
    run(chat.mark_seen(db, [said["_id"]], OLD))
    assert db.agent_sessions.rows[OLD]["agent"] == "main"
    assert db.agent_sessions.rows[OLD]["last_seen"]
    assert db.runs.rows[RID]["holders"][-1]["session"] == OLD
    assert db.chat.rows[said["_id"]]["seen_session"] == OLD


def test_a_session_without_an_id_leaves_no_heartbeat(db):
    run(asks.beat(db, None, "main"))
    assert db.agent_sessions.rows == {}


# ---------------------------------------------------------------- the lease

def test_a_note_whose_session_went_quiet_is_requeued(db):
    run(asks.beat(db, OLD, "main", at=ago(hours=2)))
    _start_as(db, OLD)
    for k in (RID, "current"):
        db.runs.rows[k]["started_at"] = ago(hours=2)
        db.runs.rows[k]["holders"][-1]["since"] = ago(hours=2)
    got = run(asks.sweep(db, lease=45))
    assert [g["revision"] for g in got] == [RID]
    for k in (RID, "current"):                  # the room is free again too
        assert db.runs.rows[k]["status"] == "interrupted"
        assert "45 min" in db.runs.rows[k]["interrupted"][-1]["reason"]
    assert db.revisions.rows[RID]["status"] == "queued"
    assert any("interrupted, requeued" in a["text"] for a in db.activity.rows.values())
    assert run(asks.sweep(db, lease=45)) == []  # once


def test_a_session_still_beating_keeps_its_note(db):
    run(asks.beat(db, OLD, "main", at=ago(hours=2)))
    _start_as(db, OLD)
    db.runs.rows[RID]["started_at"] = db.runs.rows[RID]["holders"][-1]["since"] = ago(hours=2)
    run(asks.beat(db, OLD, "main"))             # a command a minute ago
    assert run(asks.sweep(db, lease=45)) == []
    assert db.runs.rows[RID]["status"] == "running"


def test_an_old_run_without_a_heartbeat_lives_by_its_rooms_log(db):
    _start_as(db, "never-beat")
    db.runs.rows[RID]["started_at"] = db.runs.rows[RID]["holders"][-1]["since"] = ago(hours=2)
    run(db.activity.insert_one({"_id": "a1", "at": ago(minutes=3), "room": "cad", "text": "x"}))
    assert run(asks.sweep(db, lease=45)) == []
    db.activity.rows["a1"]["at"] = ago(hours=1)
    assert [g["revision"] for g in run(asks.sweep(db, lease=45))] == [RID]


def test_wait_and_next_offer_the_requeued_note_again(db, monkeypatch, capsys):
    from tools import revisions
    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)
    run(asks.beat(db, OLD, "main", at=ago(hours=2)))
    _start_as(db, OLD)
    db.runs.rows[RID]["started_at"] = db.runs.rows[RID]["holders"][-1]["since"] = ago(hours=2)

    async def unread(db, room=None):
        return []
    monkeypatch.setattr(chat, "unread", unread)
    run(revisions.cmd_wait(argparse.Namespace(timeout=0, ignore=None, every=0, room=None)))
    out = capsys.readouterr().out
    assert "interrupted, requeued: " + RID in out and "1 queued" in out
    monkeypatch.setattr(revisions, "cmd_show", lambda a: asyncio.sleep(0))
    run(revisions.cmd_next(argparse.Namespace(room=None, out=None)))
    assert RID in capsys.readouterr().out


# ---------------------------------------------------------------- restart

def test_a_restart_gives_back_what_the_old_session_held_and_offers_it(db, monkeypatch, capsys):
    from tools import revisions
    run(asks.beat(db, OLD, "main", seat=SEAT))
    _start_as(db, OLD)
    said = run(chat.post(db, "and make it blue"))
    run(chat.mark_seen(db, [said["_id"]], OLD))     # read, then the session died

    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.setenv("REDLINE_AGENT", "main")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", NEW)
    monkeypatch.setenv("REDLINE_SEAT", SEAT)
    run(revisions.cmd_resume(argparse.Namespace(room=None)))
    out = capsys.readouterr().out
    assert db.agent_sessions.rows[OLD]["superseded_by"] == NEW
    assert db.runs.rows[RID]["status"] == "interrupted"
    assert "restarted" in db.runs.rows[RID]["interrupted"][-1]["reason"]
    assert "Unfinished asks from before the restart" in out
    assert f"note {RID}" in out and "and make it blue" in out
    assert "INTERRUPTED, requeued" in out          # the queue says it too

    # Picked up again: a new stretch, the old one and the interruption kept.
    doc, what = _start_as(db, NEW)
    assert what == "restarted"
    assert [h["session"] for h in doc["holders"]] == [OLD, NEW]
    assert doc["holders"][0]["until"] and len(doc["interrupted"]) == 1
    # Answered now: no longer an unfinished ask.
    run(chat.post(db, "done, it is blue", role=chat.AGENT))
    assert run(asks.unfinished(db, NEW))["unanswered"] == []


def test_a_session_in_another_seat_supersedes_nobody(db):
    """Another Claude working in the repository from its own terminal is
    not a restart of the agent in tmux, even under the same name."""
    run(asks.beat(db, OLD, "agent", seat=SEAT))
    run(asks.register(db, NEW, "agent", "tmux:dev-shell"))
    assert db.agent_sessions.rows[OLD]["superseded_at"] is None
    run(asks.register(db, "sess-3", "agent", SEAT))
    assert db.agent_sessions.rows[OLD]["superseded_by"] == "sess-3"


def test_the_seat_is_the_tmux_session_unless_set():
    assert asks.seat_from_env("main", {"REDLINE_SEAT": "x"}) == "x"
    assert asks.seat_from_env("main", {}) == "agent:main"


def test_the_card_hears_why_its_note_is_back_in_the_queue(db, monkeypatch):
    from backend import main as M
    monkeypatch.setattr(M, "db", lambda: db)
    run(asks.beat(db, OLD, "main", seat=SEAT))
    _start_as(db, OLD)
    run(asks.register(db, NEW, "main", SEAT))
    run(asks.sweep(db))
    got = run(M._runs_of([RID]))[RID]
    assert got["status"] == "interrupted"
    assert "restarted" in got["interrupted"]["reason"]
