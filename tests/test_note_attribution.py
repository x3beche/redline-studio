"""A note's cost is the work of the agent that held it - not everything the
machine's agents did while it was open - and a note running under one agent
is not another's to start.

What went wrong: the card summed every LLM call between a run's start and
finish, so every parallel agent and session landed on it (a 3-minute note
showed 12.7M tokens). And `revisions.py start` let a second agent take a
running note, and runs/current with it.
"""

from __future__ import annotations

import argparse
import asyncio
import json

import pytest

from backend import runs, usage

RID = "20261007-062713-28886d"
S1, S2 = "sess-one", "sess-two"


def call(i, at, session=S1, agent="a1", surface="claude-code", **kw):
    return {"_id": f"cc:{i}", "at": at, "surface": surface, "provider": "anthropic",
            "model": "claude-opus-5", "input": 1, "output": 10, "cache_read": 100,
            "cache_write": 0, "thinking": 0, "cost_usd": 1.0, "cost_basis": "assumed",
            "session": session, "agent": agent, "spawned_by": None, **kw}


def holder(session=S1, agent="a1", since="2026-10-07T06:30:00Z", until=None, resolved=True):
    return {"by": {"name": "3d restructure"}, "session": session, "agent": agent,
            "since": since, "until": until, "resolved": resolved}


# ---------------------------------------------------------------- what a transcript says

def tool(name, **inp):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_x", "name": name, "input": inp}]}}


@pytest.mark.parametrize("cmd,want", [
    (f'export REDLINE_AGENT="x"; .venv/bin/python tools/revisions.py start {RID} "title"', [RID]),
    (f"tools/revisions.py start --take-over {RID} 'title'", [RID]),
    (f"tools/revisions.py start {RID}", [RID]),
    ("tools/revisions.py start -h", []),
    (f"tools/revisions.py log 'start {RID}'", []),
    (f"tools/revisions.py finish {RID}", []),
])
def test_a_start_is_found_in_a_shell_command(cmd, want):
    assert usage._starts(tool("Bash", command=cmd)) == want


def test_a_start_through_the_mcp_server_counts_too():
    assert usage._starts(tool("mcp__redline__start", id=RID, title="t")) == [RID]
    assert usage._starts(tool("mcp__redline__finish", id=RID)) == []


def test_sub_agents_started_are_recorded_by_their_tool_use_id():
    assert usage._spawns(tool("Agent", prompt="go")) == ["toolu_x"]
    assert usage._spawns(tool("Bash", command="ls")) == []


def test_a_row_says_which_session_and_sub_agent_made_it():
    e = {"type": "assistant", "requestId": "req_1", "timestamp": "2026-10-07T06:31:00Z",
         "sessionId": S1, "agentId": "a1",
         "message": {"model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 2}}}
    r = usage._row(e)
    assert (r["session"], r["agent"]) == (S1, "a1")
    del e["agentId"]                                   # the session's main thread
    assert usage._row(e)["agent"] is None


# ---------------------------------------------------------------- whose calls

def test_parallel_sessions_and_agents_are_not_counted():
    rows = [call(1, "2026-10-07T06:31:00Z"),
            call(2, "2026-10-07T06:32:00Z", agent="someone-else"),     # same session, other agent
            call(3, "2026-10-07T06:33:00Z", session=S2),               # another session
            call(4, "2026-10-07T06:34:00Z", agent=None),               # the session's main thread
            call(5, "2026-10-07T06:29:00Z"),                           # before the start
            call(6, "2026-10-07T07:20:00Z"),                           # after the finish
            call(7, "2026-10-07T06:35:00Z", surface="chat", session=None, agent=None)]
    got, exact = usage.pick(rows, RID, [holder()], "2026-10-07T07:14:00Z")
    assert exact and [r["_id"] for r in got] == ["cc:1"]


def test_the_card_summariser_is_kept_whenever_it_ran():
    rows = [call(1, "2026-10-07T06:31:00Z"),
            call("s", "2026-10-07T06:27:00+00:00", surface="card-summary", session=None,
                 agent=None, revision=RID)]
    got, exact = usage.pick(rows, RID, [holder()], "2026-10-07T07:14:00Z")
    assert exact and {r["_id"] for r in got} == {"cc:1", "cc:s"}


def test_sub_agents_the_holder_started_while_holding_count():
    rows = [call(1, "2026-10-07T06:31:00Z", spawns=["toolu_kid"]),
            call(2, "2026-10-07T06:32:00Z", agent="kid", spawned_by="toolu_kid",
                 spawns=["toolu_grandkid"]),
            call(3, "2026-10-07T06:33:00Z", agent="grandkid", spawned_by="toolu_grandkid"),
            call(4, "2026-10-07T06:33:00Z", agent="stranger", spawned_by="toolu_other")]
    got, _ = usage.pick(rows, RID, [holder()], "2026-10-07T07:14:00Z")
    assert {r["_id"] for r in got} == {"cc:1", "cc:2", "cc:3"}


def test_a_take_over_splits_the_note_between_two_holders():
    rows = [call(1, "2026-10-07T06:31:00Z"),
            call(2, "2026-10-07T06:50:00Z"),                     # a1 after it was taken over
            call(3, "2026-10-07T06:51:00Z", session=S2, agent="b1")]
    held = [holder(until="2026-10-07T06:40:00Z"),
            holder(session=S2, agent="b1", since="2026-10-07T06:40:00Z")]
    got, exact = usage.pick(rows, RID, held, "2026-10-07T07:14:00Z")
    assert exact and {r["_id"] for r in got} == {"cc:1", "cc:3"}


def test_unknown_agent_falls_back_to_the_window_and_says_so():
    rows = [call(1, "2026-10-07T06:31:00Z"), call(2, "2026-10-07T06:32:00Z", session=S2)]
    got, exact = usage.pick(rows, RID, [holder(resolved=False)], "2026-10-07T07:14:00Z")
    assert not exact and len(got) == 2


def test_the_claim_just_before_the_start_names_the_holder():
    claims = [{"_id": "c-old", "at": "2026-10-07T04:00:00Z", "session": S1, "agent": "old"},
              {"_id": "c-1", "at": "2026-10-07T06:29:59.500Z", "session": S1, "agent": "a1"},
              {"_id": "c-other", "at": "2026-10-07T06:29:59.900Z", "session": S2, "agent": "b"},
              {"_id": "c-late", "at": "2026-10-07T06:35:00Z", "session": S1, "agent": "late"}]
    h = {"by": None, "session": S1, "agent": None, "since": "2026-10-07T06:30:00.100+00:00",
         "resolved": False}
    got = usage.resolve([h], claims)[0]
    assert got["resolved"] and got["agent"] == "a1" and got["claim"] == "c-1"
    # Without the session the latest claim wins, whoever made it.
    assert usage.resolve([{**h, "session": None}], claims)[0]["agent"] == "b"
    # Nothing near the start: not resolved, not guessed.
    assert not usage.resolve([{**h, "since": "2026-10-08T00:00:00Z"}], claims)[0]["resolved"]


def test_a_run_from_before_holders_gets_every_agent_that_started_it():
    """The bug's own trace: a second start replaced the first agent's record,
    and both went on working the note."""
    run = {"_id": RID, "by": {"name": "3d restructure"},
           "started_at": "2026-10-07T06:30:31.738+00:00",
           "finished_at": "2026-10-07T07:14:15+00:00"}
    claims = [{"_id": "c-room", "at": "2026-10-07T06:28:00.453Z", "session": S2, "agent": "room"},
              {"_id": "c-rs", "at": "2026-10-07T06:30:30.492Z", "session": S1, "agent": "rs"},
              {"_id": "c-next-day", "at": "2026-10-08T06:00:00Z", "session": S1, "agent": "x"}]
    got = usage.derive(run, claims)
    assert [(h["session"], h["agent"]) for h in got] == [(S2, "room"), (S1, "rs")]
    assert got[1]["by"] == {"name": "3d restructure"} and got[0]["by"] is None


# ---------------------------------------------------------------- end to end, on a small db

class Calls:
    def __init__(self, rows):
        self.rows = rows

    def find(self, q=None, projection=None):
        rows = self.rows
        if q and "starts" in q:
            rows = [r for r in rows if q["starts"] in (r.get("starts") or [])]

        async def gen():
            for r in rows:
                yield dict(r)
        return gen()


class Runs:
    def __init__(self, rows):
        self.rows = {r["_id"]: dict(r) for r in rows}

    async def find_one(self, q, projection=None):
        r = self.rows.get(q["_id"])
        return dict(r) if r else None

    async def replace_one(self, q, doc, upsert=False):
        self.rows[q["_id"]] = dict(doc)

    async def update_one(self, q, u, upsert=False):
        if q["_id"] in self.rows:
            self.rows[q["_id"]].update(u.get("$set") or {})

    async def insert_one(self, doc):
        pass


class Db:
    def __init__(self, calls, run_rows):
        self.runs = Runs(run_rows)
        self.revisions = Runs([])
        self.activity = Runs([])
        self._calls = Calls(calls)

    def __getitem__(self, name):
        assert name == usage.CALLS
        return self._calls


def test_for_revision_counts_only_the_holder_and_keeps_who_it_was():
    run = {"_id": RID, "revision": RID, "by": {"name": "3d restructure"},
           "started_at": "2026-10-07T06:30:31+00:00", "finished_at": "2026-10-07T07:14:15+00:00"}
    calls = [call("claim", "2026-10-07T06:30:30.492Z", starts=[RID]),
             call(1, "2026-10-07T06:40:00Z"),
             call(2, "2026-10-07T06:41:00Z", session=S2, agent="busy-elsewhere"),
             call(3, "2026-10-07T06:42:00Z", agent="sibling")]
    db = Db(calls, [run])
    out = asyncio.run(usage.for_revision(db, RID, run["started_at"], run["finished_at"], run))
    assert out["totals"]["calls"] == 2
    assert out["attribution"]["approximate"] is False and out["attribution"]["label"] is None
    assert out["attribution"]["holders"][0]["agent"] == "a1"
    # Found once, kept on the run.
    assert db.runs.rows[RID]["holders"][0]["resolved"] is True


def test_for_revision_without_a_claim_is_the_old_window_marked_approximate():
    run = {"_id": RID, "revision": RID, "started_at": "2026-10-07T06:30:31+00:00",
           "finished_at": "2026-10-07T07:14:15+00:00"}
    calls = [call(1, "2026-10-07T06:40:00Z"), call(2, "2026-10-07T06:41:00Z", session=S2)]
    out = asyncio.run(usage.for_revision(Db(calls, [run]), RID, run["started_at"],
                                         run["finished_at"], run))
    assert out["totals"]["calls"] == 2
    assert out["attribution"]["approximate"] is True
    assert out["attribution"]["label"] == usage.APPROX_LABEL


# ---------------------------------------------------------------- ingest

class Meta:
    def __init__(self):
        self.doc = None

    async def find_one(self, q):
        return self.doc

    async def update_one(self, q, u, upsert=False):
        self.doc = {"_id": q["_id"], **u["$set"]}


class Sink:
    def __init__(self):
        self.ops = []

    async def bulk_write(self, ops, ordered=False):
        self.ops += ops

        class R:
            upserted_count = len(ops)
        return R()


def test_ingest_records_identity_claims_and_spawns(tmp_path, monkeypatch):
    sub = tmp_path / "proj" / S1 / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a1.meta.json").write_text(json.dumps({"toolUseId": "toolu_parent"}))
    line = {"type": "assistant", "requestId": "req_1", "timestamp": "2026-10-07T06:30:30Z",
            "sessionId": S1, "agentId": "a1", "cwd": usage.WORK_DIR,
            "message": {"model": "claude-opus-5", "usage": {"output_tokens": 3},
                        "content": [{"type": "tool_use", "id": "toolu_b", "name": "Bash",
                                     "input": {"command": f"tools/revisions.py start {RID} t"}}]}}
    path = sub / "agent-a1.jsonl"
    # The second line is still being written: no newline yet.
    path.write_text(json.dumps(line) + "\n" + '{"type": "assist')
    monkeypatch.setattr(usage, "transcripts", lambda: [path])

    class D:
        meta = Meta()
        sink = Sink()

        def __getitem__(self, name):
            return self.sink
    d = D()
    asyncio.run(usage.ingest(d, full=True))
    (op,) = d.sink.ops
    upd = op._doc
    assert upd["$set"]["session"] == S1 and upd["$set"]["agent"] == "a1"
    assert upd["$set"]["spawned_by"] == "toolu_parent"
    assert upd["$addToSet"]["starts"] == {"$each": [RID]}
    # The half-written line is read next time, not skipped.
    assert d.meta.doc["files"][str(path)] == len(json.dumps(line)) + 1


# ---------------------------------------------------------------- start: refusing, taking over

def _start(db, rid, agent, monkeypatch, title="t", take_over=False, force=False, session=None):
    from tools import revisions
    monkeypatch.setattr(revisions, "connect", lambda: db)
    monkeypatch.setenv("REDLINE_AGENT", agent)
    if session:
        monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", session)
    else:
        monkeypatch.delenv("CLAUDE_CODE_SESSION_ID", raising=False)
    asyncio.run(revisions.cmd_start(argparse.Namespace(
        id=rid, title=title, force=force, take_over=take_over)))


@pytest.fixture
def no_side_effects(monkeypatch):
    from backend import changes, compute
    monkeypatch.setattr(compute, "machine_cpu", lambda: {"busy_s": 1.0})

    async def nothing(*a, **kw):
        return None
    monkeypatch.setattr(changes, "started", nothing)


def test_a_second_agent_cannot_start_a_running_note(monkeypatch, capsys, no_side_effects):
    db = Db([], [])
    _start(db, RID, "3d room", monkeypatch, session=S2)
    first = dict(db.runs.rows[RID])
    with pytest.raises(SystemExit) as out:
        _start(db, RID, "3d restructure", monkeypatch, title="mine now", session=S1)
    msg = str(out.value)
    assert "already running under '3d room'" in msg and "--take-over" in msg
    # Nothing moved: not the note's run, not the room's.
    assert db.runs.rows[RID] == first
    assert db.runs.rows["current"]["by"]["name"] == "3d room"


def test_the_same_agent_starting_again_carries_on(monkeypatch, capsys, no_side_effects):
    db = Db([], [])
    _start(db, RID, "3d room", monkeypatch, session=S2)
    since = db.runs.rows[RID]["started_at"]
    _start(db, RID, "3d room", monkeypatch, title="renamed", session=S2)
    assert "carrying on" in capsys.readouterr().out
    assert db.runs.rows[RID]["started_at"] == since
    assert db.runs.rows[RID]["title"] == "renamed"
    assert len(db.runs.rows[RID]["holders"]) == 1


def test_take_over_is_explicit_and_recorded(monkeypatch, capsys, no_side_effects):
    db = Db([], [])
    _start(db, RID, "3d room", monkeypatch, session=S2)
    since = db.runs.rows[RID]["started_at"]
    _start(db, RID, "3d restructure", monkeypatch, title="", take_over=True, session=S1)
    assert "taken over from 3d room" in capsys.readouterr().out
    run = db.runs.rows[RID]
    assert run["started_at"] == since                  # the note's cost keeps the first stretch
    assert run["by"]["name"] == "3d restructure" and run["title"] == "t"
    (t,) = run["taken_over"]
    assert t["from"]["name"] == "3d room" and t["to"]["name"] == "3d restructure"
    assert t["from_session"] == S2 and t["to_session"] == S1
    a, b = run["holders"]
    assert a["until"] == b["since"] and a["session"] == S2 and b["session"] == S1
    assert db.runs.rows["current"]["holders"] == run["holders"]


def test_another_notes_run_in_the_room_still_needs_force(monkeypatch, no_side_effects):
    db = Db([], [])
    _start(db, "cad-1", "3d room", monkeypatch)
    with pytest.raises(SystemExit) as out:
        _start(db, RID, "other", monkeypatch)
    assert "cad-1" in str(out.value)
    _start(db, RID, "other", monkeypatch, force=True)
    assert db.runs.rows["current"]["revision"] == RID


def test_a_finished_note_can_be_started_again_by_anyone(monkeypatch, no_side_effects):
    db = Db([], [])
    _start(db, RID, "3d room", monkeypatch)
    db.runs.rows[RID]["status"] = db.runs.rows["current"]["status"] = "done"
    _start(db, RID, "3d restructure", monkeypatch)
    assert db.runs.rows[RID]["by"]["name"] == "3d restructure"


def test_the_api_refuses_the_same_way(monkeypatch, no_side_effects):
    from fastapi.testclient import TestClient

    from backend import auth
    from backend import main as M
    db = Db([], [])
    monkeypatch.setattr(M, "db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    web = TestClient(M.app)

    def post(agent, **body):
        return web.post("/api/run/start", json={"title": "t", "revision": RID, **body},
                        headers={"x-redline-csrf": "1", "X-Redline-Actor": f"agent:{agent}"})
    assert post("3d room", session=S2).json()["outcome"] == "started"
    r = post("3d restructure")
    assert r.status_code == 409 and "3d room" in r.json()["detail"]
    r = post("3d restructure", take_over=True)
    assert r.status_code == 200 and r.json()["outcome"] == "taken-over"
    assert db.runs.rows[RID]["taken_over"][0]["from"]["name"] == "3d room"


def test_the_mcp_start_tool_passes_take_over():
    from tools import mcp_server
    assert mcp_server.argv("start", {"id": RID, "title": "t"}) == ["start", RID, "t"]
    assert mcp_server.argv("start", {"id": RID, "title": "t", "take_over": True})[-1] == "--take-over"


def test_holders_of_an_old_run_is_its_by_and_start():
    got = runs.holders_of({"by": {"name": "x"}, "started_at": "2026-10-07T06:00:00Z"})
    assert got == [{"by": {"name": "x"}, "session": None, "agent": None,
                    "since": "2026-10-07T06:00:00Z", "until": None, "resolved": False}]
