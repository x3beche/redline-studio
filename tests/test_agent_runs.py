"""The agents' side of a note: one run per room, through the CLI, and the
same commands over MCP (tools/revisions.py, tools/mcp_server.py)."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


# ---------------- one shared run, two agents ----------------
class _Runs:
    """Just the runs and revisions an agent's start and finish touch."""

    def __init__(self, rows):
        self.rows = {r["_id"]: dict(r) for r in rows}

    async def find_one(self, q):
        r = self.rows.get(q["_id"])
        return dict(r) if r else None

    async def replace_one(self, q, doc, upsert=False):
        self.rows[q["_id"]] = dict(doc)

    async def update_one(self, q, u, upsert=False):
        if q["_id"] in self.rows or upsert:
            self.rows.setdefault(q["_id"], {"_id": q["_id"]}).update(u["$set"])

    async def update_many(self, q, u, upsert=False):
        for i in q["_id"]["$in"]:
            if i in self.rows:
                self.rows[i].update(u["$set"])

    async def insert_one(self, doc):
        pass


class _Db:
    def __init__(self, runs):
        self.runs = _Runs(runs)
        self.revisions = _Runs([])
        self.activity = _Runs([])


def test_start_will_not_take_over_somebody_elses_open_run(monkeypatch):
    """A CAD run and a board run crossed on one database: the second start
    re-pointed the shared run, and the first agent's finish closed it."""
    import argparse
    import asyncio

    from tools import revisions

    db = _Db([{"_id": "current", "revision": "cad-1", "status": "running",
               "title": "screws", "started_at": "2026-09-24T07:19"}])
    monkeypatch.setattr(revisions, "connect", lambda: db)
    with pytest.raises(SystemExit) as out:
        asyncio.run(revisions.cmd_start(argparse.Namespace(
            id="pcb-1", title="route the last net", force=False)))
    assert "cad-1" in str(out.value)
    assert db.runs.rows["current"]["revision"] == "cad-1"


def test_finish_by_id_closes_only_that_run(monkeypatch):
    import argparse
    import asyncio

    from tools import revisions

    db = _Db([{"_id": "current", "revision": "cad-1", "status": "running"},
              {"_id": "cad-1", "revision": "cad-1", "status": "running"},
              {"_id": "pcb-1", "revision": "pcb-1", "status": "running"}])
    monkeypatch.setattr(revisions, "connect", lambda: db)
    asyncio.run(revisions.cmd_finish(argparse.Namespace(
        id="pcb-1", failed=False, no_shot=True, room="cad")))
    assert db.runs.rows["pcb-1"]["status"] == "done"
    assert db.runs.rows["current"]["status"] == "running"
    assert db.runs.rows["cad-1"]["status"] == "running"


def test_rooms_have_runs_of_their_own(monkeypatch):
    """A tab's agent works while another room's run is open: the board note's
    run goes in its own room's document, and the 3D room's is untouched."""
    import argparse
    import asyncio

    from tools import revisions

    db = _Db([{"_id": "current", "revision": "cad-1", "status": "running"}])
    db.revisions = _Runs([{"_id": "pcb-1", "kind": "pcb"}])
    monkeypatch.setattr(revisions, "connect", lambda: db)
    asyncio.run(revisions.cmd_start(argparse.Namespace(
        id="pcb-1", title="route the last net", force=False)))
    assert db.runs.rows["current:pcb"]["revision"] == "pcb-1"
    assert db.runs.rows["current"]["revision"] == "cad-1"
    asyncio.run(revisions.cmd_finish(argparse.Namespace(
        id="pcb-1", failed=False, no_shot=True, room="cad")))
    assert db.runs.rows["current:pcb"]["status"] == "done"
    assert db.runs.rows["current"]["status"] == "running"


# ---------------- the queues, over MCP ----------------
def test_mcp_server_speaks_the_protocol_over_stdio():
    """initialize, tools/list, and an unknown method - through a real
    process, the way an agent starts it from .mcp.json."""
    import json as _json
    import sys as _sys

    root = Path(__file__).resolve().parent.parent
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "nonsense"},
    ]
    out = subprocess.run([_sys.executable, str(root / "tools/mcp_server.py")],
                         input="".join(_json.dumps(m) + "\n" for m in msgs),
                         capture_output=True, text=True, timeout=30)
    replies = [_json.loads(line) for line in out.stdout.splitlines()]
    # The notification gets no answer; the three requests get one each.
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[0]["result"]["serverInfo"]["name"] == "redline"
    names = {t["name"] for t in replies[1]["result"]["tools"]}
    assert {"queue", "show", "start", "finish", "done", "ask", "chat"} <= names
    assert replies[2]["error"]["code"] == -32601


def test_mcp_tools_are_the_cli_commands():
    from tools import mcp_server as m

    assert m.argv("queue", {"room": "pcb"}) == ["queue", "--room", "pcb"]
    assert m.argv("log", {"text": "x", "room": "pcb", "percent": 40}) == \
        ["log", "x", "--room", "pcb", "-l", "info", "-p", "40"]
    assert m.argv("ask", {"text": "which?", "options": ["a", "b"]}) == \
        ["ask", "which?", "-o", "a", "-o", "b"]
    assert m.argv("finish", {"id": "r1", "failed": True}) == ["finish", "r1", "--failed"]
    with pytest.raises(ValueError):
        m.argv("start", {"id": "r1"})
    got = m.call("nope", {})
    assert got["isError"]
