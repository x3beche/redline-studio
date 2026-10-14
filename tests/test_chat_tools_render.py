"""The Chat's model_render tool (backend/chat_tools/model_render.py).

What matters: the pictures are kept in the asker's Files (Chat/Renders)
with what they show - model, build version, view, size - and the step
points at them, so the page shows them inline; the same view of the same
build is never rendered twice; views and sizes are capped; a model being
built, queued for a linked rebuild, broken or never built is not
photographed and the answer says why; a board is shot in 3D, or its
drawings are shown when it has none. The renderer is faked."""

from __future__ import annotations

import pytest

from backend import access, actors, chat_tools, files, scope
from backend.chat_tools import Ctx, ToolError
from backend.chat_tools import model_render as mr
from test_telegram import FakeDb
from tests.test_chat_tools import run

ME = {"id": "u-me", "name": "Me", "type": "person"}
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 2000


@pytest.fixture
def ws(monkeypatch):
    fake = FakeDb()
    state = {"role": "reviewer"}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: ME)
    db = scope.ScopedDb(fake, "default")
    shots = []

    async def views(db_, model, vs, wh):
        shots.append((model, tuple(vs), wh))
        return {v: PNG + v.encode() for v in vs}

    async def board(db_, bid, wh):
        shots.append((f"board:{bid}", ("3d",), wh))
        return PNG
    monkeypatch.setattr(mr, "render_views", views)
    monkeypatch.setattr(mr, "render_board", board)

    class Bucket:
        async def upload_from_stream(self, name, data):
            return "grid-" + name
    monkeypatch.setattr(files, "_bucket", lambda db_: Bucket())

    async def get(db_, fid):
        return await db_[files.COLL].find_one({"_id": fid}), PNG
    monkeypatch.setattr(files, "get", get)
    built = {"artifacts": {"viewer": {"at": "t"}}, "built": {"version": 7, "at": "t"}, "version": 7}
    run(db["models"].insert_one({"_id": "box/parts/lid", "title": "Lid", **built}))
    return db, fake, state, shots


def call(db, args, vision=False):
    return run(chat_tools.tools()["model_render"].run(Ctx(db=db, actor=ME, chat="c1", vision=vision), args))


def test_it_is_the_3d_package_and_said_in_turkish():
    t = chat_tools.tools()["model_render"]
    assert (t.package, t.level, t.default) == ("cad", "change", True)
    assert "model_render" in chat_tools.SYSTEM_NOTE
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    for s in (t.label, t.about, t.running, t.failed, "Rendered {title} · {n} views", "Showed the drawings of {title}"):
        assert f"'{s}':" in tr, s
    assert "model_render:" in open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()


def test_the_views_are_kept_in_files_and_the_step_points_at_them(ws):
    db, fake, _, shots = ws
    got = call(db, {"model": "lid", "views": ["iso", "top"]}, vision=True)
    assert shots == [("box/parts/lid", ("iso", "top"), (960, 640))]
    rows = {f["context"]["view"]: f for f in fake["files"].docs.values()}
    assert set(rows) == {"iso", "top"}
    iso = rows["iso"]
    assert iso["context"] == {"room": "commandcode", "render": "model:box/parts/lid", "version": 7, "view": "iso",
                              "size": "960x640", "chat": "c1"}
    assert iso["content_type"] == "image/png" and iso["name"] == "Lid - iso v7.png" and iso["by"] == ME
    (folder,) = [f for f in fake["file_folders"].docs.values() if f["path"] == "Chat/Renders"]
    assert iso["folder"] == folder["_id"]
    assert got.say == "Rendered {title} · {n} views" and got.vars["n"] == 2
    assert got.vars["shot0"] == f"iso:{iso['_id']}" and got.vars["shot1"] == f"top:{rows['top']['_id']}"
    assert got.image == PNG + b"iso"                       # the first one, for a model that reads images
    # Again, with one more view: only that one is rendered; the rest come from Files.
    again = call(db, {"model": "box/parts/lid", "views": ["top", "front"]})
    assert shots[-1] == ("box/parts/lid", ("front",), (960, 640))
    assert again.vars["shot0"] == f"top:{rows['top']['_id']}" and "kept from before" in again.text
    # A new build is a new picture.
    run(db["models"].update_one({"_id": "box/parts/lid"}, {"$set": {"built.version": 8}}))
    call(db, {"model": "lid", "views": ["top"]})
    assert shots[-1] == ("box/parts/lid", ("top",), (960, 640))


def test_views_and_sizes_are_capped(ws):
    db, _, _, shots = ws
    with pytest.raises(ToolError, match="at most 4 views"):
        call(db, {"model": "lid", "views": ["iso", "iso-back", "front", "right", "top"]})
    with pytest.raises(ToolError, match="no view under"):
        call(db, {"model": "lid", "views": ["under"]})
    with pytest.raises(ToolError, match="size is one of"):
        call(db, {"model": "lid", "size": "huge"})
    call(db, {"model": "lid", "views": "back, side", "size": "small"})
    assert shots[-1] == ("box/parts/lid", ("iso-back", "right"), (640, 428))


@pytest.mark.parametrize("patch,why", [
    ({"building": True}, "being built right now"),
    ({"link": {"state": "queued"}}, "being built right now"),
    ({"error": "Traceback...\nValueError: wall too thin"}, "last build failed.*wall too thin"),
    ({"built": None, "artifacts": {}}, "never been built"),
])
def test_a_model_that_cannot_be_shown_is_said_so(ws, patch, why):
    db, _, _, shots = ws
    run(db["models"].update_one({"_id": "box/parts/lid"}, {"$set": patch}))
    with pytest.raises(ToolError, match=why):
        call(db, {"model": "lid"})
    assert shots == []


def test_a_board_in_3d_or_its_drawings(ws):
    db, fake, _, shots = ws
    run(db["boards"].insert_one({"_id": "fan-board", "title": "Fan board",
                                 "artifacts": {"model3d": {"at": "2026-10-14T10:00"}, "layout": {}}}))
    got = call(db, {"board": "fan"})
    assert shots == [("board:fan-board", ("3d",), (960, 640))]
    (f,) = [x for x in fake["files"].docs.values() if x["context"].get("render") == "board:fan-board"]
    assert got.vars["shot0"] == f"3d:{f['_id']}" and f["context"]["version"] == "2026-10-14T10:00"
    call(db, {"board": "fan-board"})
    assert len(shots) == 1                                  # kept
    run(db["boards"].insert_one({"_id": "led", "title": "LED strip", "artifacts": {"layout": {}, "bottom": {}}}))
    drawn = call(db, {"board": "led"})
    assert drawn.say == "Showed the drawings of {title}"
    assert (drawn.vars["shot0"], drawn.vars["shot1"]) == ("top:@layout", "bottom:@bottom")
    run(db["boards"].update_one({"_id": "led"}, {"$set": {"building": True}}))
    with pytest.raises(ToolError, match="being built"):
        call(db, {"board": "led"})


def test_a_viewer_gets_nothing_kept(ws):
    db, _, state, shots = ws
    state["role"] = "viewer"
    with pytest.raises(ToolError):
        call(db, {"model": "lid"})
    assert shots == []
