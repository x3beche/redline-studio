"""Pinning a component, the versions a pin can point at, and the board's
version setting (backend/links.py, the /api/components routes).

What has to hold:

- a pin (or following the latest again) rebuilds the model and what uses
  it, says why, and refuses a component the model does not use or a
  version that is not kept;
- the versions of a component come newest first with what each changed;
- "update them all" moves every pin that is behind to the latest;
- the code view resolves an import through the build's own module table;
- a layout that leaves a board's 3D unchanged is no version, unless the
  board says every run is one;
- an imported board's free holes are given to the part whose pads they
  sit in, and otherwise read as mounting holes.
"""

from __future__ import annotations

import pytest

from backend import auth, board3d, links, store
from backend import main as M
from test_links import FakeDb, client, model, run


class Bucket:
    def __init__(self):
        self.files: dict = {}

    async def upload_from_stream(self, name, data):
        fid = f"f{len(self.files)}"
        self.files[fid] = data
        return fid

    async def delete(self, fid):
        self.files.pop(fid, None)

    async def open_download_stream(self, fid):
        data = self.files[fid]

        class S:
            async def read(_):
                return data
        return S()


@pytest.fixture
def db(monkeypatch, tmp_path):
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda db, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    return FakeDb()


@pytest.fixture
def api(monkeypatch, db):
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return db


H = {"x-redline-csrf": "1"}


async def seed(db):
    db["models"].rows += [model("p/part", "W = 3\nPARTS = []\n", version=3),
                          model("p/tray", "import part\nPARTS = []\n"),
                          model("p/box", "import tray\nPARTS = []\n")]
    for v, w in ((1, 1), (2, 2), (3, 3)):
        await links.archive(db, "model", "p/part", v, {"source": f"W = {w}\nPARTS = []\n"})


def tray_on_part(db):
    run(seed(db))


# ---------------------------------------------------------------- pins

def test_a_pin_rebuilds_the_model_and_what_uses_it_and_says_why(db):
    tray_on_part(db)
    out = run(links.set_pin(db, "p/tray", "model:p/part", 2))
    assert out["changed"] and sorted(out["queued"]) == ["p/box", "p/tray"]
    rows = {r["_id"]: r for r in db["models"].rows}
    assert rows["p/tray"]["pins"] == {"model:p/part": 2}
    assert rows["p/tray"]["link"]["state"] == "queued" and rows["p/tray"]["stale"]
    assert rows["p/tray"]["link"]["because"] == {"kind": "model", "id": "p/part", "title": "part",
                                                 "version": 2, "pin": "pinned"}
    assert rows["p/box"]["link"]["state"] == "queued"

    # The same pin again changes nothing and rebuilds nothing.
    assert run(links.set_pin(db, "p/tray", "model:p/part", 2))["changed"] is False
    # Following again: unpinned, rebuilt.
    out = run(links.set_pin(db, "p/tray", "model:p/part", None))
    assert out["was"] == 2 and "p/tray" in out["queued"]
    assert "model:p/part" not in ({r["_id"]: r for r in db["models"].rows}["p/tray"].get("pins") or {})


def test_a_pin_on_something_not_used_or_not_kept_is_refused(db):
    tray_on_part(db)
    db["models"].rows.append(model("p/loose", "X = 1\n"))
    with pytest.raises(links.PinError):
        run(links.set_pin(db, "p/tray", "model:p/loose", 1))
    with pytest.raises(LookupError):
        run(links.set_pin(db, "p/tray", "model:p/part", 9))
    with pytest.raises(KeyError):
        run(links.set_pin(db, "p/nothing", "model:p/part", 1))
    # A component used through another can be pinned too: the build of
    # the model takes it at that version.
    assert run(links.set_pin(db, "p/box", "model:p/part", 1))["changed"]


def test_versions_come_newest_first_with_what_changed(db):
    tray_on_part(db)
    rows = run(links.versions(db, "model", "p/part"))
    assert [r["version"] for r in rows] == [3, 2, 1]
    assert rows[0]["changes"][0] == "W 2 -> 3" and "+1 -1 lines" in rows[0]["changes"]
    assert rows[-1]["changes"] == ["first version"]


def test_board_versions_say_what_moved():
    a = {"version": 1, "digest": "a", "data": {"size": [10, 20], "thickness": 1.6,
                                               "holes": [{"x": 1, "y": 1, "d": 3}],
                                               "connectors": [], "bodies": [{"ref": "J1", "box": [0] * 6}]}}
    b = {"version": 2, "digest": "b", "data": {"size": [10, 22], "thickness": 1.6,
                                               "holes": [{"x": 1, "y": 1, "d": 3}, {"x": 9, "y": 1, "d": 3}],
                                               "connectors": [],
                                               "bodies": [{"ref": "J1", "box": [0, 0, 0, 1, 1, 1]},
                                                          {"ref": "U1", "box": [0] * 6}]}}
    said = links.what_changed("board", a, b)
    assert said[0] == "size 10 x 20 -> 10 x 22 mm"
    assert "holes 1 -> 2" in said and "U1 added" in said and "J1 moved" in said
    assert links.what_changed("board", a, {**a, "version": 2}) == ["same 3D as v1"]


def test_update_them_all_moves_every_pin_that_is_behind(db):
    tray_on_part(db)
    db["models"].rows.append(model("p/lid", "import part\nPARTS = []\n", pins={"model:p/part": 3}))
    run(links.set_pin(db, "p/tray", "model:p/part", 1))
    g = run(links.load(db))
    by = {r["id"]: r for r in links.pinned_by(g, "model:p/part")}
    assert by["p/tray"]["behind"] and not by["p/lid"]["behind"]
    moved = run(links.update_pins(db, "model", "p/part"))
    assert [(m["model"], m["from"], m["to"]) for m in moved] == [("p/tray", 1, 3)]
    assert {r["_id"]: r for r in db["models"].rows}["p/tray"]["pins"] == {"model:p/part": 3}


@pytest.mark.asyncio
async def test_the_pin_routes(api):
    await seed(api)
    async with client() as c:
        r = await c.post("/api/models/p/tray/pins", json={"component": "model:p/part", "version": 2}, headers=H)
        assert r.status_code == 200 and r.json()["changed"], r.text
        r = await c.post("/api/models/p/tray/pins", json={"component": "model:p/part", "version": 7}, headers=H)
        assert r.status_code == 404
        r = await c.post("/api/models/p/box/pins", json={"component": "model:p/nope", "version": 1}, headers=H)
        assert r.status_code == 400
        info = (await c.get("/api/models/p/part/links")).json()
        assert info["pinned_by"] == [{"id": "p/tray", "title": "tray", "version": 2, "latest": 3,
                                      "behind": True}]
        tray = (await c.get("/api/models/p/tray/links")).json()
        assert tray["uses"][0]["pinned"] == 2 and tray["stale"] is True
        got = (await c.get("/api/components/model/p/part/versions")).json()
        assert got["latest"] == 3 and [v["version"] for v in got["versions"]] == [3, 2, 1]
        assert got["pinned_by"][0]["id"] == "p/tray"
        r = await c.post("/api/components/model/p/part/update-pins", headers=H)
        assert r.json()["updated"][0]["to"] == 3
        rows = (await c.get("/api/components")).json()
        tray = next(x for x in rows if x["id"] == "p/tray")
        assert tray["uses"] == ["model:p/part"] and tray["pins"] == {"model:p/part": 3}
        assert tray["state"] == "queued"
        # The catalog says a model has pins, for the badge.
        api["folders"].rows.append({"_id": "p", "name": "p", "parent": ""})
        tree = (await c.get("/api/catalog")).json()

        def every(node):
            yield from node.get("models") or []
            for sub in node.get("folders") or []:
                yield from every(sub)
        pinned = {m["id"]: m["pinned"] for m in every(tree)}
        assert pinned["p/tray"] == 1 and pinned["p/part"] == 0


# ---------------------------------------------------------------- the code view

@pytest.mark.asyncio
async def test_the_code_view_resolves_imports_through_the_builds_table(api):
    api["boards"].rows.append({"_id": "demo-board", "title": "Demo"})
    api["models"].rows += [model("a/stand", "X = 1\n"), model("b/stand", "X = 2\n"),
                           model("a/tray", "import a__stand\n")]
    async with client() as c:
        table = (await c.get("/api/components/modules")).json()
    # Two models called stand: only their flat names resolve, like the build.
    assert "stand" not in table
    assert table["a__stand"] == {"kind": "model", "id": "a/stand", "title": "stand"}
    assert table["demo_board"]["kind"] == "board" and table["pcb_demo_board"]["id"] == "demo-board"
    assert table["tray"]["id"] == "a/tray"


# ---------------------------------------------------------------- the version setting

STEP = b"ISO-10303-21;\nHEADER;\nDATA;\n#1=X();\nENDSEC;"
DATA = {"size": [10, 10], "thickness": 1.6, "holes": [], "connectors": [], "bodies": [],
        "approximate": []}


def test_an_unchanged_layout_is_no_version_unless_every_run_is_one(db):
    db["boards"].rows.append({"_id": "demo", "title": "Demo"})
    db["models"].rows.append(model("p/case", "import demo as B\n"))
    first = run(links.board_component(db, "demo", STEP, DATA, None, digest="d1"))
    assert first["version"] == 1 and first["changed"]
    again = run(links.board_component(db, "demo", STEP, DATA, None, digest="d1"))
    assert again == {"version": 1, "changed": False, "queued": []}

    db["boards"].rows[0][links.EVERY_RUN] = True
    third = run(links.board_component(db, "demo", STEP, DATA, None, digest="d1"))
    assert third["version"] == 2 and third["changed"] and third["queued"] == ["p/case"]
    assert db["boards"].rows[0]["component"]["same_as_before"] is True
    rows = run(links.versions(db, "board", "demo"))
    assert rows[0]["changes"] == ["same 3D as v1"]


@pytest.mark.asyncio
async def test_the_setting_is_kept_on_the_board_and_shown_on_its_card(api):
    api["boards"].rows.append({"_id": "demo", "title": "Demo",
                               "component_error": {"at": "t", "error": "export failed"}})
    async with client() as c:
        card = (await c.get("/api/boards/demo/component")).json()
        assert card["every_run"] is False and card["error"]["error"] == "export failed"
        r = await c.put("/api/boards/demo/component/settings", json={"every_run": True}, headers=H)
        assert r.status_code == 200
        assert api["boards"].rows[0][links.EVERY_RUN] is True
        assert (await c.get("/api/boards/demo/component")).json()["every_run"] is True
        r = await c.put("/api/boards/nope/component/settings", json={"every_run": True}, headers=H)
        assert r.status_code == 404


# ---------------------------------------------------------------- an imported board

def test_an_imported_boards_free_holes_go_to_the_part_round_them_or_are_mounting():
    outline = {"box": [10, 10, 60, 40],
               "loops": [[{"line": [[10, 10], [60, 10]]}, {"line": [[60, 10], [60, 40]]},
                          {"line": [[60, 40], [10, 40]]}, {"line": [[10, 40], [10, 10]]}]]}
    pads = [{"ref": "J1", "pin": "1", "x": 20, "y": 20}, {"ref": "J1", "pin": "2", "x": 24, "y": 20},
            {"ref": "Q1", "pin": "1", "x": 50, "y": 30}]
    hits = [{"x": 20, "y": 20, "d": 1.0, "plated": True},       # J1's own pad
            {"x": 22, "y": 20.5, "d": 0.8, "plated": False},    # J1's peg
            {"x": 13, "y": 13, "d": 3.2, "plated": False},      # mounting
            {"x": 57, "y": 37, "d": 3.2, "plated": False},      # mounting
            {"x": 50, "y": 36, "d": 2.5, "plated": False}]      # inside Q1's body
    info = board3d.imported_info(outline, None, pads, [{"ref": "J1", "x": 12, "y": 10, "rot": 0,
                                                        "side": "top"}], [], hits)
    assert info["box"] == [10, -40, 60, -10]
    boxes = {"Q1": [38, 18, 1.6, 42, 28, 9.0]}
    board3d._own_free_holes(info, boxes)
    data = board3d.describe(info, boxes)
    assert data["size"] == [50, 30]
    assert sorted((h["x"], h["y"]) for h in data["holes"]) == [(3, 3), (47, 27)]
    owners = sorted((d["ref"], d["x"], d["y"]) for d in data["drills"])
    assert owners == [("J1", 10, 10), ("J1", 12, 10.5), ("Q1", 40, 26)]


def test_an_uploaded_step_is_moved_into_the_board_frame_with_its_names(tmp_path):
    """The STEP an imported board came with is B.part, moved so the board
    body's lower corner is the origin - names kept, geometry untouched."""
    from build123d import Box, Compound, export_step, import_step, Pos
    body = Pos(10, 20, 5) * Box(4, 2, 1.6)
    body.label = "Board"
    export_step(Compound(label="PCB", children=[body]), tmp_path / "in.step")
    out = board3d.moved_step((tmp_path / "in.step").read_bytes(), (-8.0, -19.0, -4.2))
    (tmp_path / "out.step").write_bytes(out)
    got = import_step(tmp_path / "out.step")
    bb = got.bounding_box()
    assert [round(v, 3) for v in (bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z)] == \
        [0, 0, 0, 4, 2, 1.6]
    labels = []

    def walk(n):
        labels.append(n.label)
        for c in n.children:
            walk(c)
    walk(got)
    assert "Board" in labels


def test_a_connector_is_known_by_its_library_footprint_when_the_layout_names_it_by_number():
    """A Redline layout names footprints by LCSC number (C5379909) and its
    parts are all U<n>: the netlist's footprint name says it is a USB-C
    receptacle or a pin header."""
    info = {"box": [0, 0, 30, 20], "thickness": 1.6, "outline": [], "holes": [],
            "footprints": [
                {"ref": "U1", "value": "?", "footprint": "C5379909", "x": 1, "y": 10, "side": "top",
                 "box": [0, 8, 4, 12], "pads": 12, "library": "TYPE-C-SMD_20009-UCAF001-X"},
                {"ref": "U31", "value": "?", "footprint": "C492404", "x": 25, "y": 10, "side": "top",
                 "box": [24, 4, 26, 16], "pads": 5, "library": "HDR-TH_5P-P2.54-V-M"},
                {"ref": "U24", "value": "?", "footprint": "C2969989", "x": 15, "y": 10, "side": "top",
                 "box": [12, 7, 18, 13], "pads": 20, "library": "TSSOP-20_L6.5-W4.4-P0.65-LS6.4-BL"}]}
    data = board3d.describe(info, {})
    assert [c["ref"] for c in data["connectors"]] == ["U1", "U31"]
    assert data["connectors"][0]["edge"] == "left"
