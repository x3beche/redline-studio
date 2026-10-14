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


def _set(r: dict, patch: dict) -> None:
    for k, v in patch.items():
        if "." in k:                            # "agents.3d room"
            head, rest = k.split(".", 1)
            r.setdefault(head, {})[rest] = v
        else:
            r[k] = v


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
        _set(r, u.get("$set") or {})
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
def db(monkeypatch, tmp_path):
    from backend import changes, compute, usage
    # Nothing of this machine's own sessions: no transcripts, processes or tmux.
    monkeypatch.setattr(usage, "CLAUDE_HOME", tmp_path / "claude")
    monkeypatch.setattr(asks, "processes", lambda: [])
    monkeypatch.setattr(asks, "tmux_seen", lambda seat: None)
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
    _start_as(db, OLD, agent="main")
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


# ---------------------------------------------------------------- a sub-agent's own lease

def _age(db, **kw):
    for k in (RID, "current"):
        db.runs.rows[k]["started_at"] = ago(**kw)
        db.runs.rows[k]["holders"][-1]["since"] = ago(**kw)


def test_a_sub_agent_that_died_is_requeued_while_its_main_session_goes_on(db, monkeypatch, capsys):
    """A room's sub-agent runs in its main session (the same session id) under
    a name of its own: its note lives by its own commands, not the main's
    `wait`, which says the session is there and nothing more."""
    from tools import revisions
    run(asks.beat(db, OLD, "main", seat=SEAT))
    run(asks.beat(db, OLD, "3d room", at=ago(hours=2)))   # its last command
    _start_as(db, OLD)
    _age(db, hours=2)
    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", OLD)
    monkeypatch.setenv("REDLINE_AGENT", "main")

    async def unread(db, room=None):
        return []
    monkeypatch.setattr(chat, "unread", unread)
    run(revisions.cmd_wait(argparse.Namespace(timeout=0, ignore=None, every=0, room=None)))
    out = capsys.readouterr().out
    assert db.agent_sessions.rows[OLD]["agents"] == {"main": db.agent_sessions.rows[OLD]["agents"]["main"],
                                                     "3d room": db.agent_sessions.rows[OLD]["agents"]["3d room"]}
    assert "interrupted, requeued: " + RID in out          # and the main's watcher wakes for it
    assert db.runs.rows[RID]["status"] == "interrupted"


def test_a_sub_agent_still_running_commands_keeps_its_note(db):
    run(asks.beat(db, OLD, "main", at=ago(hours=2)))
    _start_as(db, OLD)
    _age(db, hours=2)
    run(asks.beat(db, OLD, "3d room"))
    assert run(asks.sweep(db, lease=45)) == []
    # Waiting is not working: the main's wait does not stand in for it.
    run(asks.beat(db, OLD, "3d room", at=ago(hours=1)))
    run(asks.beat(db, OLD, "main", work=False))
    assert [g["revision"] for g in run(asks.sweep(db, lease=45))] == [RID]


def test_a_taken_over_note_lives_by_its_new_holder(db):
    run(asks.beat(db, OLD, "3d room", at=ago(hours=2)))
    _start_as(db, OLD)
    _age(db, hours=2)
    run(asks.beat(db, NEW, "rescuer"))
    doc, what = run(runs.start(db, RID, "carry on", "cad", {"name": "rescuer"}, session=NEW, take_over=True))
    assert what == "taken-over"
    for k in (RID, "current"):
        db.runs.rows[k]["holders"][-1]["since"] = ago(hours=1)
    assert run(asks.sweep(db, lease=45)) == []       # the rescuer's beat counts, not the first's
    run(asks.beat(db, NEW, "rescuer", at=ago(hours=1)))
    assert [g["revision"] for g in run(asks.sweep(db, lease=45))] == [RID]


# ---------------------------------------------------------------- signs of a silent job

def test_its_own_log_lines_and_progress_keep_a_quiet_run(db):
    run(asks.beat(db, OLD, "3d room", at=ago(hours=2)))
    _start_as(db, OLD)
    _age(db, hours=2)
    run(db.activity.insert_one({"_id": "o1", "at": ago(minutes=5), "room": "cad", "text": "other",
                                "by": {"name": "pcb room"}}))
    assert [g["revision"] for g in run(asks.sweep(db, lease=45, now=None))] == [RID]  # not another's line
    _start_as(db, OLD)                                       # picked up again
    _age(db, hours=2)
    run(db.activity.insert_one({"_id": "o2", "at": ago(minutes=5), "room": "cad", "text": "mine",
                                "by": {"name": "3d room"}}))
    assert run(asks.sweep(db, lease=45)) == []
    db.activity.rows["o2"]["at"] = ago(hours=1)
    db.runs.rows[RID]["beat_at"] = ago(minutes=2)            # `log -p` moved the bar
    assert run(asks.sweep(db, lease=45)) == []


def test_a_silent_job_lives_by_its_transcript(db, tmp_path):
    """A run from before heartbeats: an old room log, but the sub-agent that
    started it is still writing its transcript."""
    _start_as(db, "legacy")
    _age(db, hours=2)
    sub = tmp_path / "claude" / "projects" / "-home-x3-projects-redline-studio" / "legacy" / "subagents"
    sub.mkdir(parents=True)
    t = sub / "agent-abc.jsonl"
    t.write_text(f'{{"msg": "revisions.py start {RID} one piece lid"}}\n')
    assert run(asks.sweep(db, lease=45)) == []
    import os
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).timestamp()
    os.utime(t, (old, old))
    assert [g["revision"] for g in run(asks.sweep(db, lease=45))] == [RID]


def test_a_silent_job_lives_by_a_process_running_under_its_name(db, monkeypatch):
    _start_as(db, "legacy")
    _age(db, hours=2)
    monkeypatch.setattr(asks, "processes", lambda: [
        {"session": "legacy", "agent": "3d room", "cmd": "bash tools/capped.sh python build.py"}])
    assert run(asks.sweep(db, lease=45)) == []
    # A watcher left behind is not work, nor another agent's build.
    monkeypatch.setattr(asks, "processes", lambda: [
        {"session": "legacy", "agent": "3d room", "cmd": "python tools/revisions.py wait --room cad"},
        {"session": "legacy", "agent": "main", "cmd": "python build.py"}])
    assert [g["revision"] for g in run(asks.sweep(db, lease=45))] == [RID]


def test_the_main_agent_in_tmux_lives_by_the_panes_activity(db, monkeypatch):
    run(asks.register(db, OLD, "main", SEAT))
    db.agent_sessions.rows[OLD]["agents"]["main"] = ago(hours=2)
    _start_as(db, OLD, agent="main")
    _age(db, hours=2)
    monkeypatch.setattr(asks, "tmux_seen", lambda seat: datetime.now(timezone.utc) if seat == SEAT else None)
    assert run(asks.sweep(db, lease=45)) == []


def test_the_processes_are_read_from_proc():
    import os
    me = [p for p in asks.processes()] if os.environ.get("CLAUDE_CODE_SESSION_ID") else []
    assert all({"session", "agent", "cmd"} <= set(p) for p in me)


# ---------------------------------------------------------------- answers nobody took

def _asked(db, qid="q1", answered_ago=5, room=None):
    from backend import questions
    doc = run(questions.ask(db, "which screw?", ["M3", "M4"], RID, room=room, session=OLD, track=True))
    db.questions.rows[doc["_id"]].update(status=questions.ANSWERED, answer="M3",
                                         answered_at=ago(minutes=answered_ago))
    return doc["_id"]


def test_an_answer_that_came_after_the_asker_died_is_offered_and_delivered_once(db, monkeypatch, capsys):
    from tools import revisions
    qid = _asked(db)
    from backend import questions
    run(questions.ask(db, "old one", None, RID))                # before answers were tracked
    for q in db.questions.rows.values():
        q.setdefault("status", "answered")
        q["status"] = "answered"
    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.setenv("REDLINE_AGENT", "main")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", NEW)
    monkeypatch.setenv("REDLINE_SEAT", SEAT)
    run(revisions.cmd_resume(argparse.Namespace(room=None)))
    out = capsys.readouterr().out
    assert "Unfinished asks" in out and qid in out and "A: M3" in out and "old one" not in out
    assert db.questions.rows[qid]["delivered_session"] == NEW
    assert run(asks.unfinished(db, NEW))["answers"] == []


def test_wait_wakes_for_an_answer_nobody_took(db, monkeypatch, capsys):
    from tools import revisions
    qid = _asked(db, room="cad")
    fresh = _asked(db, answered_ago=0)                          # its asker may still take it
    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    monkeypatch.delenv("CLAUDE_SESSION_ID", raising=False)

    async def unread(db, room=None):
        return []
    monkeypatch.setattr(chat, "unread", unread)
    with pytest.raises(SystemExit):                             # another room's: nothing for it
        run(revisions.cmd_wait(argparse.Namespace(timeout=1, ignore=None, every=0, room="pcb")))
    assert qid not in capsys.readouterr().out
    run(revisions.cmd_wait(argparse.Namespace(timeout=0, ignore=None, every=0, room="cad")))
    out = capsys.readouterr().out
    assert "answer(s) to a question whose asker has gone" in out and qid in out
    assert fresh not in out
    assert db.questions.rows[qid]["delivered_at"]


def test_ask_marks_its_answer_delivered(db, monkeypatch, capsys):
    from backend import questions
    from tools import revisions
    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", OLD)
    monkeypatch.setenv("REDLINE_AGENT", "3d room")
    real_get = questions.get

    async def answered(db, qid):
        db.questions.rows[qid].update(status=questions.ANSWERED, answer="M4", answered_at=ago(seconds=1))
        return await real_get(db, qid)
    monkeypatch.setattr(questions, "get", answered)
    run(revisions.cmd_ask(argparse.Namespace(text="which?", option=["M3", "M4"], revision=RID, context=None,
                                             multi=False, room=None, timeout=0, every=0)))
    q = next(iter(db.questions.rows.values()))
    assert "answer: M4" in capsys.readouterr().out
    assert q["asked_session"] == OLD and q["delivered_session"] == OLD
    assert "3d room" in db.agent_sessions.rows[OLD]["agents"]  # asking kept its lease


# ---------------------------------------------------------------- the thread marks lost reads

def test_the_thread_marks_a_line_read_before_a_restart_until_it_is_answered(db, monkeypatch):
    from backend import main as M
    monkeypatch.setattr(M, "db", lambda: db)
    run(asks.register(db, OLD, "main", SEAT))
    said = run(chat.post(db, "and make it blue"))
    run(chat.mark_seen(db, [said["_id"]], OLD))
    other = run(chat.post(db, "not read yet"))

    def lost():
        return {d["_id"] for d in run(M.chat_history(200, None)) if d.get("read_lost")}
    assert lost() == set()                                       # its reader is still there
    run(asks.register(db, NEW, "main", SEAT))                    # restarted
    assert lost() == {said["_id"]} and other["_id"] not in lost()
    run(chat.post(db, "done, it is blue", role=chat.AGENT))
    assert lost() == set()


def test_a_reader_gone_quiet_counts_as_gone(db):
    run(asks.beat(db, OLD, "main", at=ago(hours=2)))
    said = run(chat.post(db, "hello"))
    run(chat.mark_seen(db, [said["_id"]], OLD))
    rows = run(chat.history(db))
    assert run(asks.lost_reads(db, rows, lease=45)) == {said["_id"]}
    assert run(asks.lost_reads(db, rows, lease=180)) == set()


# ---------------------------------------------------------------- MCP

def test_resume_is_an_mcp_tool():
    from tools import mcp_server
    assert "resume" in {t["name"] for t in mcp_server.tool_list()}
    assert mcp_server.argv("resume", {}) == ["resume"]
    assert mcp_server.argv("resume", {"room": "pcb"}) == ["resume", "--room", "pcb"]
