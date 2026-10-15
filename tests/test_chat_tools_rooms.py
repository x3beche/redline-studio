"""The Chat's tools for what the rooms' buttons do (backend/chat_tools):
model_build (the 3D room's Rebuild), drawing_get (the Model tab's
technical drawing and its Make now), board_route (the PCB room's Build /
layout, Freerouting only), board_render (the PCB room's 3D and Layout
views), firmware_read (the Firmware room's files and build log) and
note_status (a note's card: its status, run and log, Mark applied).

What matters: each starts the very function the room's route does, with
the room's rights; launching ones are off by default or ask first; waits
are bounded and a job that runs on is given back to be read later;
TraceMaker is never started; what is read is bounded; Mark applied asks,
keeps the Taste check gate and is kept for undo. Builds, routing,
drawings, renders and checks are faked: nothing real runs."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from fastapi.responses import JSONResponse

from backend import access, actors, buildjobs, cc_tools, chat_tools, chat_undo, files, firmware, fwbuild, jobs, release, scope, store, taste_check
from backend.chat_tools import Ctx, ToolError
from backend.chat_tools import _drawing_job, board_render, board_route, drawing_get, model_build
from test_telegram import FakeDb
from tests.test_chat_tools import run

ME = {"id": "u-me", "name": "Me", "type": "person"}
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 2000
NEW = ("model_build", "drawing_get", "board_route", "board_render", "firmware_read", "note_status")


@pytest.fixture
def ws(monkeypatch):
    fake = FakeDb()
    state = {"role": "editor"}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: ME)
    monkeypatch.setattr(scope, "current", lambda: "default")
    db = scope.ScopedDb(fake, "default")
    built = {"artifacts": {"viewer": {"at": "t"}, "step": {"sha256": "a" * 64}}, "built": {"version": 3, "at": "t"},
             "version": 3}
    run(db["models"].insert_one({"_id": "box/parts/lid", "title": "Lid", **built}))
    run(db["boards"].insert_one({"_id": "fan-board", "title": "Fan board", "rules": {"route": {"engine": "freerouting"}},
                                 "artifacts": {"layout": {"at": "2026-10-14T10:00", "gridfs_id": "g1"},
                                               "bottom": {"at": "2026-10-14T10:00", "gridfs_id": "g2"}}}))
    return db, fake, state


def call(db, name, args, vision=False, step=""):
    return run(chat_tools.tools()[name].run(Ctx(db=db, actor=ME, chat="c1", vision=vision, step=step), args))


def now():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- the registry

def test_their_packages_levels_and_defaults_and_their_words_in_turkish():
    t = chat_tools.tools()
    assert all(n in t for n in NEW)
    got = {n: (t[n].package, t[n].level, t[n].default) for n in NEW}
    assert got == {"model_build": ("cad", "change", False), "drawing_get": ("cad", "change", True),
                   "board_route": ("pcb", "change", False), "board_render": ("pcb", "change", True),
                   "firmware_read": ("firmware", "read", True), "note_status": ("general", "change", True)}
    # Launching: off by default (builds, routing) or asking first (Make now, Mark applied).
    assert t["drawing_get"].asks({"make_now": True}) and not t["drawing_get"].asks({})
    assert t["note_status"].asks({"action": "mark_applied"}) and not t["note_status"].asks({"action": "read"})
    # Not undoable, and the step says why; Mark applied is undone the generic way.
    for n in ("model_build", "drawing_get", "board_route"):
        assert isinstance(t[n].undo, str) and t[n].undo
    assert t["note_status"].undo is None
    # Sent with their rooms' lines.
    assert cc_tools.GROUP.get("note_status") == "queue"
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    for n in NEW:
        for s in (t[n].label, t[n].about, t[n].running, t[n].failed):
            assert "'" + s.replace("'", "\\'") + "':" in tr, s
    for s in ("Building {title}", "Built {title} · {seconds} s", "The build of {title} failed",
              "Started the drawing of {title}", "Drawing of {title}: made", "Drawing of {title}: not made yet",
              "Laying out {title}", "Laid out {title} · {unrouted} unrouted · DRC {drc}", "Laying out {title} failed",
              "Showed {title} · {view}", "Read {n} files of {title}", "Read the build log of {title}: {errors} errors",
              "Marked {title} applied", "Note {title}: applied", "{title}: Taste check did not pass"):
        assert f"'{s}':" in tr, s
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()
    assert all(f"{n}:" in icons for n in NEW)
    # Its schema is what the model is told.
    for n in NEW:
        assert t[n].spec()["parameters"]["type"] == "object"


# ---------------------------------------------------------------- model_build

def test_a_build_starts_as_the_rooms_rebuild_and_answers_with_its_job(ws, monkeypatch):
    db, fake, _ = ws
    started = []

    async def start(d, mid, by):
        started.append((mid, by))
        job = {"_id": "j1", "model": mid, "workspace": "default", "status": "running", "started_at": now(), "beat": now()}
        await d.raw[buildjobs.JOBS].insert_one(job)
        return job
    from backend import main
    monkeypatch.setattr(main, "_start_build", start)
    got = call(db, "model_build", {"model": "lid"})
    assert started == [("box/parts/lid", "request")]
    assert got.vars["job"] == "j1" and got.vars["state"] == "running" and "job j1" in got.text
    # Read later by its job.
    run(fake[buildjobs.JOBS].update_one({"_id": "j1"}, {"$set": {"status": "done", "seconds": 12.5,
                                                                "result_json": json.dumps({"artifacts": {"step": 2048, "stl": 4096}})}}))
    done = call(db, "model_build", {"job": "j1"})
    assert done.say == "Built {title} · {seconds} s" and done.vars["artifacts"] == 2 and "12.5 s" in done.text


def test_a_build_waits_a_bounded_time_and_says_how_it_went(ws, monkeypatch):
    db, fake, _ = ws
    from backend import main

    async def start(d, mid, by):
        job = {"_id": "j2", "model": mid, "workspace": "default", "status": "running", "started_at": now(), "beat": now()}
        await d.raw[buildjobs.JOBS].insert_one(job)
        return job
    monkeypatch.setattr(main, "_start_build", start)

    async def forever(raw, jid, poll=None):
        await asyncio.sleep(30)
    monkeypatch.setattr(buildjobs, "wait", forever)
    got = call(db, "model_build", {"model": "lid", "wait": 1})
    assert got.vars["state"] == "running" and got.text.startswith("Still building after 1 s")

    async def failed(raw, jid, poll=None):
        await fake[buildjobs.JOBS].update_one({"_id": jid}, {"$set": {
            "status": "failed", "seconds": 3.0, "detail": "Traceback\n  line 4\nValueError: wall too thin"}})
        return await fake[buildjobs.JOBS].find_one({"_id": jid})
    monkeypatch.setattr(buildjobs, "wait", failed)
    run(fake[buildjobs.JOBS].delete_many({}))
    bad = call(db, "model_build", {"model": "lid", "wait": 999})            # capped, not refused
    assert bad.vars["state"] == "failed" and "wall too thin" in bad.text and bad.vars["error"].endswith("wall too thin")
    assert model_build.MAX_WAIT < 180


def test_a_model_already_building_is_not_built_twice_and_rights_hold(ws, monkeypatch):
    db, fake, state = ws
    from backend import main
    run(fake[buildjobs.JOBS].insert_one({"_id": "j0", "model": "box/parts/lid", "workspace": "default",
                                         "status": "running", "started_at": now(), "beat": now()}))

    async def busy(d, mid, by):
        raise HTTPException(409, {"detail": "a build is already running", "job": "j0"})
    monkeypatch.setattr(main, "_start_build", busy)
    got = call(db, "model_build", {"model": "lid"})
    assert got.vars["busy"] == 1 and got.vars["job"] == "j0" and got.text.startswith("Not started")
    state["role"] = "reviewer"
    with pytest.raises(ToolError, match="queue notes and run builds"):
        call(db, "model_build", {"model": "lid"})
    with pytest.raises(ToolError, match="which 3D model"):
        call(db, "model_build", {})


# ---------------------------------------------------------------- drawing_get

def test_the_drawing_status_with_its_links_and_make_now(ws, monkeypatch, tmp_path):
    db, _, state = ws
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    status = {"id": "box/parts/lid", "state": "ready", "key": "k1", "built": {"at": "t"},
              "layout": {"custom": False}, "made": {"at": "2026-10-14T09:00:00", "pdf_bytes": 300_000, "preview": True,
                                                    "sheet": "A3", "scale": "1:2", "views": [1, 2, 3]}}

    async def st(d, mid):
        return dict(status)
    monkeypatch.setattr(release, "drawing_status", st)
    spawned, queued = [], []

    async def spawn(ws_, mid, again):
        spawned.append((ws_, mid, again))
        return 4242
    monkeypatch.setattr(_drawing_job, "spawn", spawn)

    async def queue(d, mid, by, pid=None):
        queued.append((mid, by, pid))
    monkeypatch.setattr(release, "queue", queue)
    got = call(db, "drawing_get", {"model": "lid"})
    assert got.say == "Drawing of {title}: made" and got.vars["sheet"] == "A3" and got.vars["views"] == 3
    assert "/api/models/box/parts/lid/drawing.pdf" in got.text and "/3d/box/parts/lid" in got.text
    assert spawned == []
    # Make now on a made drawing is Make again, in a process of its own.
    again = call(db, "drawing_get", {"model": "lid", "make_now": True})
    assert spawned == [("default", "box/parts/lid", True)] and again.say == "Started the drawing of {title}"
    assert queued == [("box/parts/lid", "chat", 4242)]          # shown waiting before its process is up
    # Under way - started anywhere (here, the room): not started twice.
    status.update(state="making", pct=40, stage="projecting the top view",
                  job={"by": "room", "started_at": "2026-10-14T10:00:00", "heartbeat": "2026-10-14T10:01:00"})
    twice = call(db, "drawing_get", {"model": "lid", "make_now": True})
    assert len(spawned) == 1 and twice.vars["state"] == "making" and "not pressed again" in twice.text
    assert twice.vars["by"] == "room" and "40%" in twice.text and "the 3D room" in twice.text
    # The Chat's own, still waiting for its process: not twice either.
    status.update(state="queued", job={"by": "chat", "started_at": "t", "heartbeat": "t"})
    call(db, "drawing_get", {"model": "lid", "make_now": True})
    assert len(spawned) == 1
    status.pop("job")
    status.update(state="no_step", made=None, key=None)
    with pytest.raises(ToolError, match="no STEP"):
        call(db, "drawing_get", {"model": "lid", "make_now": True})
    state["role"] = "viewer"
    status.update(state="none", key="k2")
    assert call(db, "drawing_get", {"model": "lid"}).say == "Drawing of {title}: not made yet"   # looking is a view
    with pytest.raises(ToolError, match="queue notes and run builds"):
        call(db, "drawing_get", {"model": "lid", "make_now": True})


# ---------------------------------------------------------------- board_route

def _as_job_fake(started, fake):
    async def as_job(kind, bid, body, detach):
        assert detach is True
        started.append((kind, bid, body))
        job = {"_id": f"b{len(started)}", "kind": kind, "board": bid, "workspace": "default", "status": "running",
               "started_at": now(), "beat": now()}
        await fake[jobs.JOBS].insert_one(job)
        return JSONResponse({"job": job["_id"], "kind": kind, "board": bid, "status": "running"}, status_code=202)
    return as_job


def test_routing_starts_as_the_pcb_rooms_build_and_summarises_when_done(ws, monkeypatch):
    db, fake, _ = ws
    from backend import main
    started = []
    monkeypatch.setattr(main, "_as_job", _as_job_fake(started, fake))
    got = call(db, "board_route", {"board": "fan"})
    assert started == [("run", "fan-board", {})] and got.vars["state"] == "running" and got.vars["job"] == "b1"
    call(db, "board_route", {"board": "fan-board", "step": "route"})
    call(db, "board_route", {"board": "fan-board", "step": "place"})
    assert [s[0] for s in started] == ["run", "layout", "layout"]
    result = {"schematic": {"erc": {"error_count": 0}},
              "layout": {"placed": 14, "size_mm": [40, 30], "route": {"unrouted": 2, "engine": "freerouting"},
                         "drc": {"error_count": 1, "warning_count": 5}}}
    run(fake[jobs.JOBS].update_one({"_id": "b1"}, {"$set": {"status": "done", "seconds": 88.0,
                                                           "result_json": json.dumps(result)}}))
    done = call(db, "board_route", {"job": "b1"})
    assert done.say == "Laid out {title} · {unrouted} unrouted · DRC {drc}"
    assert (done.vars["unrouted"], done.vars["drc"], done.vars["erc"], done.vars["placed"]) == (2, 1, 0, 14)
    assert "2 unrouted nets" in done.text and "1 DRC errors" in done.text


def test_routing_never_starts_tracemaker_and_waits_a_bounded_time(ws, monkeypatch):
    db, fake, state = ws
    from backend import main
    started = []
    monkeypatch.setattr(main, "_as_job", _as_job_fake(started, fake))
    run(db["boards"].insert_one({"_id": "tm", "title": "TM board", "rules": {"route": {"engine": "tracemaker"}}}))
    with pytest.raises(ToolError, match="Freerouting only"):
        call(db, "board_route", {"board": "tm", "step": "both"})
    with pytest.raises(ToolError, match="Freerouting only"):
        call(db, "board_route", {"board": "tm", "step": "route"})
    assert started == []
    run(db["boards"].insert_one({"_id": "imp", "title": "Imported", "kind": "imported"}))
    with pytest.raises(ToolError, match="imported"):
        call(db, "board_route", {"board": "imp"})
    with pytest.raises(ToolError, match="place, route or both"):
        call(db, "board_route", {"board": "fan-board", "step": "pour"})

    async def forever(d, jid, poll=1.0):
        await asyncio.sleep(30)
    monkeypatch.setattr(jobs, "wait", forever)
    got = call(db, "board_route", {"board": "fan-board", "wait": 1})
    assert got.text.startswith("Still running after 1 s") and got.vars["job"] == "b1"
    assert board_route.MAX_WAIT < 180
    # A board with a job running: named, not started again.

    async def busy(kind, bid, body, detach):
        raise HTTPException(409, {"detail": "a run is already running", "job": "b1"})
    monkeypatch.setattr(main, "_as_job", busy)
    again = call(db, "board_route", {"board": "fan-board"})
    assert again.vars["busy"] == 1 and again.vars["job"] == "b1"
    state["role"] = "reviewer"
    with pytest.raises(ToolError, match="queue notes and run builds"):
        call(db, "board_route", {"board": "fan-board"})


def test_no_tracemaker_anywhere_in_the_tools():
    for n in ("board_route", "board_render", "model_build"):
        src = open(f"backend/chat_tools/{n}.py", encoding="utf-8").read()
        assert "tm_" not in src and "route_tracemaker" not in src and "routelive" not in src


# ---------------------------------------------------------------- board_render

def test_a_board_from_the_top_or_the_bottom_as_a_kept_picture(ws, monkeypatch):
    db, fake, _ = ws
    printed = []

    async def drawing(d, bid, art, wh):
        printed.append((bid, art, wh))
        return PNG
    monkeypatch.setattr(board_render, "render_drawing", drawing)

    class Bucket:
        async def upload_from_stream(self, name, data):
            return "grid-" + name
    monkeypatch.setattr(files, "_bucket", lambda db_: Bucket())

    async def get(db_, fid):
        return await db_[files.COLL].find_one({"_id": fid}), PNG
    monkeypatch.setattr(files, "get", get)
    got = call(db, "board_render", {"board": "fan", "view": "bottom"}, vision=True)
    assert printed == [("fan-board", "bottom", (960, 640))] and got.image == PNG
    (f,) = fake["files"].docs.values()
    assert f["context"]["render"] == "board:fan-board" and f["context"]["view"] == "bottom"
    assert got.vars["shot0"] == f"bottom:{f['_id']}" and got.say == "Showed {title} · {view}"
    call(db, "board_render", {"board": "fan-board", "view": "bottom"})
    assert len(printed) == 1                                   # kept: not printed again
    call(db, "board_render", {"board": "fan-board", "view": "top", "size": "small"})
    assert printed[-1] == ("fan-board", "layout", (640, 428))
    with pytest.raises(ToolError, match="top, bottom or 3d"):
        call(db, "board_render", {"board": "fan-board", "view": "left"})
    # 3d is model_render's own board picture.
    seen = []

    async def board3d(ctx, ref, wh):
        seen.append((ref, wh))
        return "3d"
    from backend.chat_tools import model_render
    monkeypatch.setattr(model_render, "_board", board3d)
    assert call(db, "board_render", {"board": "fan-board", "view": "3d"}) == "3d" and seen == [("fan-board", (960, 640))]


def test_the_drawing_is_cut_out_of_the_printed_page(monkeypatch):
    from PIL import Image
    import io
    page = Image.new("RGB", (600, 800), (255, 255, 255))
    page.paste(Image.new("RGB", (480, 320), (29, 33, 38)), (60, 70))

    class Page:
        def render(self, scale):
            class R:
                def to_pil(self_):
                    return page
            return R()

    class Doc:
        def __init__(self, data):
            pass

        def __getitem__(self, i):
            return Page()

        def close(self):
            pass
    import pypdfium2
    monkeypatch.setattr(pypdfium2, "PdfDocument", Doc)
    png = board_render._picture(b"%PDF", (240, 160))
    img = Image.open(io.BytesIO(png))
    assert img.size == (240, 160) and img.getpixel((5, 5)) == (29, 33, 38)
    assert "aspect-ratio:960/640" in board_render._page(b"<svg/>", (960, 640))


# ---------------------------------------------------------------- firmware_read

def test_the_firmware_source_is_read_bounded_with_its_file_list(ws, monkeypatch):
    db, fake, state = ws
    run(db[firmware.COLL].insert_one({"_id": "fw1", "title": "Fan firmware", "board": "fan-board", "version": 4,
                                      "build": {"state": "failed", "job": "fj1", "version": 4, "at": "t", "seconds": 9}}))
    tree = [{"path": "include/pins.h", "bytes": 300, "version": 2, "generated": True},
            {"path": "src/main.cpp", "bytes": 9000, "version": 4}, {"path": "src/fan.cpp", "bytes": 500, "version": 3},
            {"path": "platformio.ini", "bytes": 200, "version": 1}]
    big = "\n".join(f"line {i}" for i in range(1, 1001))

    async def t(d, fid, version=None):
        return tree

    async def rd(d, fid, path, version=None):
        if path not in {f["path"] for f in tree}:
            raise KeyError(path)
        return {"path": path, "content": big if path == "src/main.cpp" else "int x;", "version": 4,
                "generated": path == "include/pins.h"}
    monkeypatch.setattr(firmware, "tree", t)
    monkeypatch.setattr(firmware, "read", rd)
    got = call(db, "firmware_read", {"firmware": "fan"})
    assert "src/main.cpp" in got.text and "include/pins.h  " in got.text and "(generated)" in got.text
    assert got.vars["n"] == 2 and "--- src/main.cpp" in got.text and "--- src/fan.cpp" in got.text
    assert "lines 1-400 of 1000" in got.text and "  401  line 401" not in got.text
    page = call(db, "firmware_read", {"firmware": "fw1", "path": "src/main.cpp", "from_line": 401})
    assert "  401  line 401" in page.text and "lines 401-800 of 1000" in page.text
    with pytest.raises(ToolError, match="no file"):
        call(db, "firmware_read", {"firmware": "fw1", "path": "src/nope.c"})
    listed = call(db, "firmware_read", {"firmware": "fw1", "what": "files"})
    assert listed.vars["files"] == 4 and "--- " not in listed.text
    # The log: errors first, then the end.
    lines = [{"text": f"Compiling obj{i}.o", "level": "info"} for i in range(300)]
    lines[10] = {"text": "src/main.cpp:12:5: error: 'fan' was not declared", "level": "error"}

    async def job(raw, jid):
        return {"_id": jid, "workspace": "default", "lines": lines}
    monkeypatch.setattr(fwbuild, "get", job)
    log = call(db, "firmware_read", {"firmware": "fw1", "what": "log"})
    assert log.vars["errors"] == 1 and log.text.index("not declared") < log.text.index("The end of the log")
    assert "Compiling obj299.o" in log.text and "Compiling obj5.o" not in log.text
    state["role"] = "nobody"
    with pytest.raises(ToolError):
        call(db, "firmware_read", {"firmware": "fw1", "what": "log"})


# ---------------------------------------------------------------- note_status

@pytest.fixture
def note(ws, monkeypatch):
    db, fake, state = ws
    run(db.revisions.insert_one({"_id": "20261014-1", "kind": None, "model": "box/parts/lid", "status": "queued",
                                 "comment": "Round the lid's corners\nmore", "created_at": "2026-10-14T08:00:00",
                                 "queued_at": "2026-10-14T08:01:00"}))
    run(db.runs.insert_one({"_id": "20261014-1", "revision": "20261014-1", "room": "cad", "status": "done",
                            "title": "Rounding", "percent": 100.0, "started_at": "2026-10-14T09:00:00",
                            "finished_at": "2026-10-14T09:30:00",
                            "holders": [{"by": {"name": "3d room"}}]}))
    for at, text in (("2026-10-14T08:59:00", "before"), ("2026-10-14T09:05:00", "filleting the rim"),
                     ("2026-10-14T09:29:00", "built ok"), ("2026-10-14T09:40:00", "after")):
        run(db.activity.insert_one({"at": at, "text": text, "level": "info", "room": "cad"}))

    async def settings(d):
        return {"auto_archive": False}
    monkeypatch.setattr(store, "settings", settings)
    return db, fake, state


def test_a_notes_status_with_its_run_and_the_log_of_that_run(note):
    db, _, _ = note
    got = call(db, "note_status", {"note": "20261014-1"})
    assert got.vars["state"] == "review" and got.say == "Note {title}: done, waiting for review"
    assert "filleting the rim" in got.text and "built ok" in got.text
    assert "before" not in got.text.split("What the agent said")[1] and "after" not in got.text.split("What the agent said")[1]
    latest = call(db, "note_status", {"note": "latest for lid"})
    assert latest.vars["note"] == "20261014-1"
    assert call(db, "note_status", {"for": "box/parts/lid"}).vars["note"] == "20261014-1"
    with pytest.raises(ToolError, match="no note is about"):
        call(db, "note_status", {"for": "nothing-here"})


def test_mark_applied_asks_keeps_the_taste_gate_and_is_kept_for_undo(note, monkeypatch):
    db, fake, state = note
    tool = chat_tools.tools()["note_status"]
    assert tool.asks({"note": "x", "action": "mark_applied"})              # the person says yes first (ccgen)
    held = {"reason": "check", "palettes": [{"id": "p1", "name": "Rounded"}], "check": None}

    async def gate(d, rid):
        return held
    started = []

    async def start(d, rid, by=None):
        started.append(rid)
        return {"_id": "chk1", "status": "queued"}
    monkeypatch.setattr(taste_check, "gate", gate)
    monkeypatch.setattr(taste_check, "start", start)

    async def decided(d, rid, forced, by=None):
        await d.revisions.update_one({"_id": rid}, {"$set": {"taste_check": {"forced": forced}}})
    monkeypatch.setattr(taste_check, "decided", decided)
    # No check yet: started, as the card's box starts it; not marked.
    got = call(db, "note_status", {"note": "20261014-1", "action": "mark_applied"}, step="s1")
    assert started == ["20261014-1"] and got.vars["marked"] == "checking"
    assert run(db.revisions.find_one({"_id": "20261014-1"}))["status"] == "queued"
    # A check that did not pass: said, not marked; force marks anyway.
    held["check"] = {"status": "done", "result": {"verdict": "fail", "items": [
        {"verdict": "fail", "strength": "must", "text": "Corners rounded 2 mm", "why": "sharp"}]}}
    no = call(db, "note_status", {"note": "20261014-1", "action": "mark_applied"}, step="s2")
    assert no.vars["marked"] == "held" and "Corners rounded 2 mm" in no.text and len(started) == 1
    assert not [c for c in fake[chat_undo.COLL].docs.values() if c.get("step") in ("s1", "s2")]   # nothing changed
    yes = call(db, "note_status", {"note": "20261014-1", "action": "mark_applied", "force": True}, step="s3")
    doc = run(db.revisions.find_one({"_id": "20261014-1"}))
    assert yes.vars["marked"] == "yes" and yes.say == "Marked {title} applied"
    assert doc["status"] == "applied" and doc["applied_at"] and doc["status_by"] == ME and doc["taste_check"]["forced"]
    # Kept for undo, as one change of the step: the status set back by the generic inverse.
    (change,) = [c for c in fake[chat_undo.COLL].docs.values() if c.get("step") == "s3"]
    assert change["tool"] == "note_status" and any(d.get("coll") == "revisions" for d in change["docs"])
    # Rights: Mark applied runs the queue.
    state["role"] = "reviewer"
    run(db.revisions.update_one({"_id": "20261014-1"}, {"$set": {"status": "queued"}}))
    with pytest.raises(ToolError, match="queue notes and run builds"):
        call(db, "note_status", {"note": "20261014-1", "action": "mark_applied", "force": True})
    assert call(db, "note_status", {"note": "20261014-1"}).vars["note"] == "20261014-1"      # reading is a view


def test_mark_applied_without_palettes_marks_at_once(note, monkeypatch):
    db, _, _ = note

    async def gate(d, rid):
        return None
    monkeypatch.setattr(taste_check, "gate", gate)

    async def decided(d, rid, forced, by=None):
        return None
    monkeypatch.setattr(taste_check, "decided", decided)
    got = call(db, "note_status", {"note": "20261014-1", "action": "mark_applied"})
    assert got.vars["marked"] == "yes" and got.vars["state"] == "applied"
    assert call(db, "note_status", {"note": "20261014-1", "action": "mark_applied"}).vars["marked"] == "already"
