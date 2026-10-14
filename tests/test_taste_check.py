"""The Taste check before a note is marked applied (backend/taste_check.py):
a note whose project has palettes is checked against them - the model
rendered and judged by a model that reads images - and marked applied only
when nothing fails, or when the person (or an agent, with --force) marks
it anyway."""

from __future__ import annotations

import asyncio

from backend import llm, scope, taste, taste_check
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401  (the fixture)


def run(c):
    return asyncio.run(c)


ITEMS = [
    {"text": "Outside edges filleted 1 mm", "domain": "form", "strength": "must"},
    {"text": "Self-tapping screws into PLA", "domain": "mechanical", "strength": "avoid"},
    {"text": "Decoupling caps within 2 mm of the pin", "domain": "pcb", "strength": "prefer"},
]


def _workspace(fake):
    run(fake["folders"].insert_one({"_id": "fan", "name": "fan", "parent": ""}))
    run(fake["models"].insert_one({"_id": "fan/case", "title": "Fan case", "folder": "fan"}))
    run(fake["boards"].insert_one({"_id": "ctl", "title": "Controller", "folder": "fan"}))
    run(fake["revisions"].insert_one({"_id": "r1", "kind": "cad", "model": "fan/case", "status": "queued",
                                      "comment": "round the edges", "queued_at": "2026-10-01T10:00:00+00:00"}))
    run(fake["revisions"].insert_one({"_id": "r2", "kind": "pcb", "model": "ctl", "status": "queued",
                                      "comment": "move C3", "queued_at": "2026-10-01T10:00:00+00:00"}))
    p = run(taste.create(fake, "Fan family", items=ITEMS, by={"id": "a"}))
    run(taste.attach(fake, p["_id"], [{"kind": "folder", "id": "fan"}]))
    return p


def _model(monkeypatch, answer: str, seen: dict | None = None):
    async def render_views(db, model, views=taste.LOOK_VIEWS, size=taste.RENDER_SIZE):
        if seen is not None:
            seen["views"] = views
        return {v: b"png" for v in views[:2]}

    async def vision_route():
        return "commandcode", "m", True

    async def complete(messages, **kw):
        if seen is not None:
            seen["messages"] = messages
        return {"choices": [{"message": {"content": answer}}], "usage": {}, "provider": "commandcode", "model": "m"}

    async def nothing(db, **kw):
        pass

    monkeypatch.setattr(taste, "render_views", render_views)
    monkeypatch.setattr(taste, "vision_route", vision_route)
    monkeypatch.setattr(taste, "_for_model", lambda png: "data:image/jpeg;base64,")
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", nothing)


def _done(fake, rid):
    async def go():
        cur = await taste_check.latest(fake, rid)
        t = taste_check._TASKS.get(cur["_id"]) if cur else None
        if t:
            await t
        return await taste_check.latest(fake, rid)
    return go


def test_a_note_is_about_its_model_board_or_firmware():
    assert taste_check.note_projects({"kind": "pcb", "model": "ctl"}) == [("board", "ctl")]
    assert taste_check.note_projects({"kind": "cad", "model": "case"}) == [("model", "case")]
    assert taste_check.note_projects({"kind": "firmware", "model": "fw1"}) == [("firmware", "fw1")]


def test_the_models_answer_is_read_item_by_item():
    got = taste_check.parse_verdicts('```json\n[{"n": 2, "verdict": "FAIL", "why": "screws"},'
                                     ' {"n": 1, "verdict": "pass"}, {"n": 9, "verdict": "fail"}]\n```', 3)
    assert [g["verdict"] for g in got] == ["pass", "fail", "unclear"]
    assert got[1]["why"] == "screws" and got[2]["why"] == "not answered"
    assert taste_check.overall(got) == "fail"
    assert taste_check.overall([{"verdict": "pass"}, {"verdict": "unclear"}]) == "pass"
    assert taste_check.overall([{"verdict": "unchecked"}]) == "unchecked"


def test_a_model_note_is_rendered_and_judged_on_its_shape_items(monkeypatch):
    fake = FakeDb()
    _workspace(fake)
    seen: dict = {}
    _model(monkeypatch, '[{"n": 1, "verdict": "pass", "why": "filleted"},'
                        ' {"n": 2, "verdict": "fail", "why": "screws straight into the plastic"}]', seen)
    note = run(fake["revisions"].find_one({"_id": "r1"}))
    got = run(taste_check.check(fake, note, taste.Tracker()))
    # The PCB item is not about a 3D model: it is not asked about.
    assert [i["text"] for i in got["items"]] == [ITEMS[0]["text"], ITEMS[1]["text"]]
    assert got["verdict"] == "fail" and got["items"][1]["why"].startswith("screws")
    assert got["palettes"][0]["via"] == "fan" and got["model"] == "m"
    assert seen["views"] == taste.LOOK_VIEWS                  # no references: the usual views
    words = seen["messages"][1]["content"][0]["text"]
    assert "1. MUST: Outside edges" in words and "2. AVOID: Self-tapping" in words and "round the edges" in words
    assert "Decoupling" not in words


def test_a_board_note_has_nothing_to_render_and_is_unchecked():
    fake = FakeDb()
    _workspace(fake)
    note = run(fake["revisions"].find_one({"_id": "r2"}))
    got = run(taste_check.check(fake, note, taste.Tracker()))
    assert got["verdict"] == "unchecked" and {i["domain"] for i in got["items"]} == {"pcb"}
    assert "no picture" in got["notice"]


def test_a_render_that_fails_leaves_it_unchecked(monkeypatch):
    fake = FakeDb()
    _workspace(fake)
    _model(monkeypatch, "[]")

    async def broken(db, model, views=taste.LOOK_VIEWS, size=taste.RENDER_SIZE):
        raise RuntimeError("no build")
    monkeypatch.setattr(taste, "render_views", broken)
    note = run(fake["revisions"].find_one({"_id": "r1"}))
    got = run(taste_check.check(fake, note, taste.Tracker()))
    assert got["verdict"] == "unchecked" and "could not be rendered (no build)" in got["notice"]


def test_the_gate_holds_until_a_check_passes_and_again_once_requeued(monkeypatch):
    fake = FakeDb()
    _workspace(fake)
    run(fake["revisions"].insert_one({"_id": "r3", "kind": "cad", "model": "elsewhere", "status": "queued"}))
    assert run(taste_check.gate(fake, "r3")) is None            # no palette: nothing to check
    assert run(taste_check.start(fake, "r3")) is None
    held = run(taste_check.gate(fake, "r1"))
    assert held["reason"] == "check" and held["check"] is None and held["palettes"][0]["name"] == "Fan family"
    _model(monkeypatch, '[{"n": 1, "verdict": "fail", "why": "sharp"}, {"n": 2, "verdict": "pass"}]')

    async def checked():
        await taste_check.start(fake, "r1", {"id": "a"})
        return await _done(fake, "r1")()
    cur = run(checked())
    assert cur["status"] == "done" and cur["result"]["verdict"] == "fail"
    assert [s["id"] for s in cur["steps"]] == ["render", "ask"]
    assert run(taste_check.gate(fake, "r1"))["check"]["result"]["verdict"] == "fail"
    _model(monkeypatch, '[{"n": 1, "verdict": "pass"}, {"n": 2, "verdict": "pass"}]')
    assert run(checked())["result"]["verdict"] == "pass"
    assert run(taste_check.gate(fake, "r1")) is None
    # Queued again after the pass: that pass was for other work.
    run(fake["revisions"].update_one({"_id": "r1"}, {"$set": {"queued_at": "2999-01-01T00:00:00+00:00"}}))
    assert run(taste_check.gate(fake, "r1"))["reason"] == "check"


def test_a_check_left_by_a_gone_process_is_failed_when_read():
    fake = FakeDb()
    run(fake[taste_check.COLL].insert_one({"_id": "c1", "note": "r1", "status": "asking",
                                           "started_at": "2026-10-01T10:00:00+00:00",
                                           "beat": "2026-10-01T10:00:00+00:00", "worker": {"host": "x", "pid": 1}}))
    got = run(taste_check.latest(fake, "r1"))
    assert got["status"] == "failed" and got["error"] == taste_check.GONE


def test_marking_applied_through_the_api(db, monkeypatch):  # noqa: F811
    o = person(db, "o")
    sdb = scope.ScopedDb(db, scope.DEFAULT)
    _workspace(sdb)
    # Palettes apply and nothing has been checked: refused, saying why.
    r = o.patch("/api/revisions/r1?status=applied")
    assert r.status_code == 409 and r.json()["detail"]["taste"]["reason"] == "check"
    assert run(sdb["revisions"].find_one({"_id": "r1"}))["status"] == "queued"
    # The check, started and read through the API.
    _model(monkeypatch, '[{"n": 1, "verdict": "fail", "why": "sharp"}, {"n": 2, "verdict": "pass"}]')
    started = o.post("/api/revisions/r1/taste-check").json()
    assert started["status"] == "queued" and started["palettes"][0]["via"] == "fan"
    # It runs in the app's own loop: read until it is done.
    import time
    for _ in range(500):
        cur = o.get("/api/revisions/r1/taste-check").json()
        if cur["status"] not in taste_check.ACTIVE:
            break
        time.sleep(0.02)
    assert cur["status"] == "done" and cur["result"]["verdict"] == "fail"
    assert o.patch("/api/revisions/r1?status=applied").status_code == 409
    # Marked anyway: kept on the note.
    assert o.patch("/api/revisions/r1?status=applied&force=true").json()["status"] == "applied"
    kept = run(sdb["revisions"].find_one({"_id": "r1"}))["taste_check"]
    assert kept["forced"] is True and kept["verdict"] == "fail"
    # No palette: no check, marked straight away.
    run(sdb["revisions"].insert_one({"_id": "r9", "kind": "cad", "model": "other", "status": "queued"}))
    assert o.post("/api/revisions/r9/taste-check").json() == {"status": "none"}
    assert o.patch("/api/revisions/r9?status=applied").json()["status"] == "applied"
    assert "taste_check" not in run(sdb["revisions"].find_one({"_id": "r9"}))
    assert o.post("/api/revisions/nope/taste-check").status_code == 404


def test_an_agents_done_runs_the_check_and_needs_force_past_a_fail(monkeypatch, capsys):
    import argparse

    import pytest

    from tools import mcp_server, revisions

    fake = FakeDb()
    _workspace(fake)
    monkeypatch.setattr(revisions, "connect", lambda: fake)
    asked = []
    verdict = {"v": "fail"}

    def by_api(rid, limit=900):
        asked.append(rid)
        return {"status": "done", "result": {"verdict": verdict["v"], "model": "m", "items": [
            {"strength": "must", "text": "Outside edges filleted 1 mm", "verdict": verdict["v"], "why": "sharp",
             "palette_name": "Fan family"}]}}
    monkeypatch.setattr(revisions, "_taste_check_by_api", by_api)
    done = lambda rid, force=False: run(revisions.cmd_done(argparse.Namespace(id=rid, force=force)))  # noqa: E731
    with pytest.raises(SystemExit) as out:
        done("r1")
    assert "NOT marked applied" in str(out.value) and "--force" in str(out.value)
    assert "[FAIL] MUST: Outside edges filleted 1 mm - sharp" in capsys.readouterr().out
    assert run(fake["revisions"].find_one({"_id": "r1"}))["status"] == "queued"
    done("r1", force=True)
    note = run(fake["revisions"].find_one({"_id": "r1"}))
    assert note["status"] == "applied" and note["taste_check"]["forced"] is True and asked == ["r1"]
    verdict["v"] = "pass"
    done("r2")                                                  # a pass marks it
    assert run(fake["revisions"].find_one({"_id": "r2"}))["status"] == "applied" and asked == ["r1", "r2"]
    run(fake["revisions"].insert_one({"_id": "r4", "kind": "cad", "model": "other", "status": "queued"}))
    done("r4")                                                  # no palette: no check
    assert asked == ["r1", "r2"]
    assert mcp_server.argv("done", {"id": "r1", "force": True}) == ["done", "r1", "--force"]
