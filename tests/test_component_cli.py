"""The agents' component commands - `revisions.py component ...` and the
same as MCP tools (tools/revisions.py, tools/mcp_server.py).

They go through the API with the agent's token, so here the API is the
app itself over a small in-memory Mongo: what an agent reads is what the
routes answer, and what it changes goes through the routes' checks.
"""

from __future__ import annotations

import sys

import pytest
from fastapi.testclient import TestClient

from backend import auth, links, scope, store
from backend import main as M
from test_component_pins import Bucket
from test_links import FakeDb, model, run
from tools import mcp_server, revisions


@pytest.fixture
def api(monkeypatch, tmp_path):
    db = FakeDb()
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda d, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    web = TestClient(M.app)
    calls = []

    def call(path, method="GET", body=None, timeout=60):
        calls.append((method, path))
        r = web.request(method, path, json=body, headers={"x-redline-csrf": "1"})
        if r.status_code >= 400:
            raise revisions.ApiError(f"{method} {path}: {r.status_code} {r.json().get('detail')}")
        return r.json()

    monkeypatch.setattr(revisions, "api_call", call)
    db.calls = calls

    async def seed():
        db["boards"].rows.append({"_id": "demo-board", "title": "Demo"})
        db["models"].rows += [model("p/part", "W = 2\nPARTS = []\n", version=2),
                              model("p/tray", "import part\nimport demo_board as B\nPARTS = []\n"),
                              model("p/box", "import tray\nPARTS = []\n")]
        for v in (1, 2):
            await links.archive(db, "model", "p/part", v, {"source": f"W = {v}\nPARTS = []\n"})
        data = {"size": [95.5, 58.67], "thickness": 1.6,
                "holes": [{"x": 2.159, "y": 2.286, "d": 2.032, "plated": False, "ref": "H1"}],
                "drills": [], "connectors": [{"ref": "USB1", "edge": "left", "along": 27.4,
                                              "height": 3.1, "overhang": 1.2}],
                "bodies": [], "keepout": {"top": 15.1, "bottom": 1.7}, "approximate": []}
        await links.board_component(db, "demo-board", b"ISO-10303-21;\nDATA;\nENDSEC;", data,
                                     None, digest="d1")
    run(seed())
    return db


def cli(*argv) -> None:
    """The command as an agent runs it: argv through the real parser."""
    old = sys.argv
    sys.argv = ["revisions.py", *argv]
    try:
        revisions.main()
    finally:
        sys.argv = old


def test_list_counts_versions_uses_and_users(api, capsys):
    cli("component", "list")
    out = capsys.readouterr().out
    rows = {line.split()[1]: line.split() for line in out.splitlines()[1:]}
    assert rows["demo-board"][:5] == ["board", "demo-board", "v1", "0", "1"]
    assert rows["p/tray"][:6] == ["model", "p/tray", "v1", "2", "1", "0"]
    assert rows["p/part"][2] == "v2"


def test_show_gives_a_boards_named_data_and_a_models_links(api, capsys):
    cli("component", "show", "demo-board")
    out = capsys.readouterr().out
    assert "size       95.5 x 58.67 x 1.6 mm" in out
    assert "holes      1 mounting: (2.159, 2.286) d2.032" in out
    assert "USB1 left @27.4 h3.1" in out
    assert "import     import demo_board as B" in out
    assert "used by    p/tray" in out
    cli("component", "show", "p/part")
    out = capsys.readouterr().out
    assert "used by    p/tray" in out
    assert "v2  " in out and "W 1 -> 2" in out          # its versions, with what changed


def test_deps_flat_and_as_a_tree(api, capsys):
    cli("component", "deps", "p/tray")
    out = capsys.readouterr().out
    assert "uses:    model:p/part v2, board:demo-board v1" in out
    assert "used by: model:p/box v1" in out
    cli("component", "deps", "demo-board", "--tree")
    out = capsys.readouterr().out
    assert "+ model:p/tray v1" in out and "  + model:p/box v1" in out


def test_pin_and_follow_again_rebuild_through_the_api(api, capsys):
    cli("component", "pin", "p/tray", "p/part", "v1")
    out = capsys.readouterr().out
    assert "p/tray: p/part pinned at v1" in out and "rebuilding p/box, p/tray" in out
    assert {r["_id"]: r for r in api["models"].rows}["p/tray"]["pins"] == {"model:p/part": 1}
    cli("component", "show", "p/tray")
    assert "p/part v2 (pinned v1)" in capsys.readouterr().out
    cli("component", "pin", "p/tray", "p/part", "latest")
    assert "follows its latest (was v1)" in capsys.readouterr().out
    with pytest.raises(SystemExit) as no:
        cli("component", "pin", "p/tray", "p/part", "9")
    assert "not kept" in str(no.value)
    with pytest.raises(SystemExit) as no:
        cli("component", "pin", "demo-board", "p/part", "1")
    assert "only a model pins" in str(no.value)


def test_refresh_is_refused_while_a_job_runs_on_the_board(api, monkeypatch, capsys):
    api["board_jobs"].rows.append({"_id": "j1", "board": "demo-board", "workspace": scope.DEFAULT,
                                   "status": "running", "kind": "run", "started_at": "now"})
    with pytest.raises(SystemExit) as no:
        cli("component", "refresh", "demo-board")
    assert "a run job is running (j1)" in str(no.value)
    assert ("POST", "/api/boards/demo-board/component") not in api.calls

    api["board_jobs"].rows.clear()

    async def export(db, bid):
        return {"board": bid, "step_bytes": 2_500_000, "version": 2, "changed": True,
                "queued": ["p/tray"]}
    monkeypatch.setattr(M.kicad, "refresh_component", export)
    cli("component", "refresh", "demo-board")
    out = capsys.readouterr().out
    assert "version    v2 (new)" in out and "rebuilding p/tray" in out
    with pytest.raises(SystemExit):
        cli("component", "refresh", "p/tray")             # a model has no layout


def test_the_mcp_tools_are_the_same_commands(api, capsys):
    names = {t["name"] for t in mcp_server.tool_list()}
    assert {"component_list", "component_show", "component_deps", "component_pin",
            "component_refresh"} <= names
    assert mcp_server.argv("component_deps", {"id": "p/tray", "tree": True}) == \
        ["component", "deps", "p/tray", "--tree"]
    assert mcp_server.argv("component_pin", {"model": "p/tray", "component": "p/part", "version": 1}) == \
        ["component", "pin", "p/tray", "p/part", "1"]
    with pytest.raises(ValueError):
        mcp_server.argv("component_pin", {"model": "p/tray", "component": "p/part"})
    # And what each builds is a command the CLI takes.
    cli(*mcp_server.argv("component_pin", {"model": "p/tray", "component": "p/part", "version": "1"}))
    assert "pinned at v1" in capsys.readouterr().out
    cli(*mcp_server.argv("component_show", {"id": "board:demo-board"}))
    assert "board demo-board - Demo" in capsys.readouterr().out
