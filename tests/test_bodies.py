"""A part's 3D bodies: LCSC's and the drawn ones, and a board's choice
(backend/bodies.py, backend/bodies_api.py, tools/revisions.py part body-*,
board body).

What has to hold:

- a body binds only a built model of the workspace to a part in the
  drawer, under a name of its own; the default is LCSC's until changed;
  a body a board chooses is not unbound without force;
- a board's choice is its own, per reference, checked against its parts,
  workspace-scoped and audited;
- the routes ask the right role: binding and choosing change the design,
  asking for a body queues a note;
- the commands answer the same over either transport (both through the
  server);
- the 3D room's note carries the footprint in the component frame, pin 1,
  LCSC's body's box, the frame, the target and how to bind it;
- the choice reaches the written .kicad_pcb: the part's footprint for that
  reference wears the drawn STEP at offset 0, rotate 0, and the placer
  loads that one; a pose is not put on top of it; a refresh puts each
  reference's body in again;
- a bound model built again with a new STEP queues the boards that wear
  it, and their redraw travels on to what imports the board.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import actors, access, auth, bodies, lcsc, links, modelseat, scope, store
from backend import main as M
from test_component_pins import Bucket
from test_links import FakeDb, model
from tools import revisions

HERE = Path(__file__).resolve().parent.parent
PART = "C111607"

# The drawer's footprint for a TO-220 standing up, as easyeda2kicad wrote it.
FOOTPRINT = """(module easyeda2kicad:TO-220-3_L10.0-W4.5-P2.54-T (layer F.Cu) (tedit 5DC5F6A4)
\t(attr smd)
\t(fp_text reference REF** (at 0.000 -6.540) (layer F.SilkS)
\t\t(effects (font (size 1 1) (thickness 0.15)))
\t)
\t(fp_line (start -2.67 -5.08) (end 1.78 -5.08) (layer F.SilkS) (width 0.25))
\t(fp_line (start 1.78 -5.08) (end 1.78 5.08) (layer F.SilkS) (width 0.25))
\t(pad 1 thru_hole rect (at -0.00 -2.54 -90.00) (size 2.000 2.500) (layers *.Cu *.Mask)(drill 1.3))
\t(pad 2 thru_hole oval (at 0.00 0.00 -90.00) (size 2.000 2.500) (layers *.Cu *.Mask)(drill 1.3))
\t(pad 3 thru_hole oval (at 0.00 2.54 -90.00) (size 2.000 2.500) (layers *.Cu *.Mask)(drill 1.3))
\t(fp_line (start -2.63 -5.00) (end 1.87 -5.00) (layer F.CrtYd) (width 0.05))
\t(fp_line (start 1.87 -5.00) (end 1.87 5.00) (layer F.CrtYd) (width 0.05))
\t(fp_line (start 1.87 5.00) (end -2.63 5.00) (layer F.CrtYd) (width 0.05))
\t(model "/tmp/x/lib.3dshapes/TO-220.step"
\t\t(offset (xyz 0.055 0.000 -2.800))
\t\t(scale (xyz 1 1 1))
\t\t(rotate (xyz 0 0 0))
\t)
)
"""
# A WRL of 0.4 x 0.2 x 0.1 inch: 10.16 x 5.08 x 2.54 mm.
WRL = "#VRML V2.0 utf8\nShape { geometry IndexedFaceSet { coord Coordinate { point [0 0 0, 4 2 1] } } }"


def run(c):
    return asyncio.run(c)


@pytest.fixture
def world(monkeypatch, tmp_path):
    """The app over a small in-memory Mongo, sign-in off: a part in the
    drawer, a built model, a board whose Q5 is that part and that has a
    layout, and a model that imports the board."""
    db = FakeDb()
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda d, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(M, "schedule_note_work", lambda rid: None)
    monkeypatch.setattr(auth, "enabled", lambda: False)

    async def model_of(_db, code):
        return (WRL.encode(), "wrl") if code == PART else None
    monkeypatch.setattr(lcsc, "model_of", model_of)
    sdb = scope.ScopedDb(db, scope.DEFAULT)

    async def seed():
        db["parts"].rows.append({"_id": PART, "name": "TO-220-3_L10.0-W4.5-P2.54-T",
                                 "footprint": FOOTPRINT, "model_kind": "wrl", "model_wrl": WRL})
        db["parts"].rows.append({"_id": "C25744", "name": "R0402", "footprint": "(module x)"})
        db["models"].rows += [model("scratch/flat", "PARTS = []\n"), model("scratch/raw", "PARTS = []\n"),
                              model("p/case", "import demo_board as B\nPARTS = []\n")]
        await store.put_artifact(sdb, "scratch/flat", "step", b"ISO-10303-21; flat v1")
        db["boards"].rows.append({"_id": "demo-board", "title": "Demo"})
        db["boards"].rows.append({"_id": "other-board", "title": "Other"})
        graph = {"components": [{"ref": "Q5", "part": PART}, {"ref": "Q1", "part": PART},
                                {"ref": "R1", "part": "C25744"}], "nets": []}
        for bid in ("demo-board", "other-board"):
            await store.put_artifact(sdb, bid, "graph", json.dumps(graph).encode(), collection="boards")
            await store.put_artifact(sdb, bid, "routed", PCB.encode(), collection="boards")
    run(seed())
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    web = TestClient(M.app)
    yield types.SimpleNamespace(db=db, sdb=sdb, web=web, bucket=bucket)
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])


def call(w, method, path, body=None):
    r = w.web.request(method, path, json=body, headers={"x-redline-csrf": "1"})
    return r.status_code, r.json()


# ---------------------------------------------------------------- storage and validation

def test_a_part_starts_with_lcsc_s_body_as_its_default(world):
    st, out = call(world, "GET", f"/api/parts/{PART}/bodies")
    assert st == 200
    assert out["default"] == "lcsc"
    assert [(b["slug"], b["default"], b["ready"]) for b in out["bodies"]] == [("lcsc", True, True)]


def test_binding_checks_part_model_build_and_name(world):
    bind = lambda **b: call(world, "POST", f"/api/parts/{b.pop('part', PART)}/bodies",
                            {"model": "scratch/flat", "name": "lying flat", **b})
    assert bind(part="C999999")[0] == 404                      # not in the drawer
    assert bind(model="nope/none")[0] == 404                   # no such model
    st, out = bind(model="scratch/raw")
    assert st == 409 and "build it" in out["detail"]           # not built: no STEP
    assert bind(name="LCSC")[0] == 400                         # reserved
    assert bind(name="  ")[0] in (400, 422)
    st, out = bind()
    assert st == 200 and out["body"]["slug"] == "lying-flat" and out["default"] == "lcsc"
    assert bind(name="Lying  Flat")[0] == 409                  # the same slug twice
    st, out = call(world, "GET", f"/api/parts/{PART}/bodies")
    rows = {b["slug"]: b for b in out["bodies"]}
    assert rows["lying-flat"]["model"] == "scratch/flat" and rows["lying-flat"]["ready"]
    assert rows["lcsc"]["default"] and not rows["lying-flat"]["default"]
    # Kept in the workspace, with who bound it; audited.
    doc = world.db["part_bodies"].rows[0]
    assert doc["workspace_id"] == scope.DEFAULT and doc["bodies"][0]["by"]["name"]
    assert any(a["action"] == "body-bind" for a in world.db["audit"].rows)


def test_default_by_name_and_back_to_lcsc(world):
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    st, out = call(world, "PUT", f"/api/parts/{PART}/bodies/default", {"variant": "Lying Flat"})
    assert st == 200 and out["default"] == "lying-flat" and out["changed"]
    # Both boards have the part and a layout: both are redrawn.
    assert out["queued"] == ["demo-board", "other-board"]
    assert call(world, "PUT", f"/api/parts/{PART}/bodies/default", {"variant": "nope"})[0] == 404
    st, out = call(world, "PUT", f"/api/parts/{PART}/bodies/default", {"variant": "lcsc"})
    assert out["default"] == "lcsc"


def test_a_chosen_body_is_not_unbound_without_force(world):
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat",
                                                      "default": True})
    call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "lying-flat"})
    st, out = call(world, "DELETE", f"/api/parts/{PART}/bodies/lying-flat")
    assert st == 409 and "demo-board Q5" in out["detail"]
    st, out = call(world, "DELETE", f"/api/parts/{PART}/bodies/lying-flat?force=true")
    assert st == 200 and out["cleared"] == ["demo-board Q5"] and out["default"] == "lcsc"
    board = next(b for b in world.db["boards"].rows if b["_id"] == "demo-board")
    assert "Q5" not in (board.get("bodies") or {})
    assert world.db["models"].rows[0]["_id"] == "scratch/flat"       # the model stays


def test_the_effective_body_of_a_reference():
    doc = {"default": "flat", "bodies": [{"slug": "flat", "name": "flat", "model": "m/a"},
                                         {"slug": "short", "name": "short legs", "model": "m/b"}]}
    assert bodies.effective(PART, doc, None)[0]["slug"] == "flat"
    assert bodies.effective(PART, doc, {"variant": "short", "part": PART})[0]["slug"] == "short"
    assert bodies.effective(PART, doc, {"variant": "lcsc", "part": PART}) == (None, None)
    body, why = bodies.effective(PART, doc, {"variant": "short", "part": "C1"})
    assert body["slug"] == "flat" and "C1" in why                # chosen for another part
    body, why = bodies.effective(PART, doc, {"variant": "gone", "part": PART})
    assert body["slug"] == "flat" and "gone" in why
    assert bodies.effective(PART, {"bodies": doc["bodies"]}, None) == (None, None)


# ---------------------------------------------------------------- a board's choice

def test_a_board_chooses_per_reference_and_only_for_itself(world):
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    st, out = call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "lying-flat"})
    assert st == 200 and out["wears"] == "lying-flat" and out["queued"] == ["demo-board"]
    st, out = call(world, "GET", "/api/boards/demo-board/bodies")
    rows = {r["ref"]: r for r in out["refs"]}
    assert rows["Q5"]["wears"] == "lying-flat" and rows["Q5"]["chosen"] == "lying-flat"
    assert rows["Q1"]["wears"] == "lcsc" and rows["Q1"]["chosen"] is None
    assert "R1" not in rows                                     # one body only: no selector
    assert [o["slug"] for o in rows["Q5"]["options"]] == ["lcsc", "lying-flat"]
    other = call(world, "GET", "/api/boards/other-board/bodies")[1]
    assert {r["ref"]: r["wears"] for r in other["refs"]} == {"Q1": "lcsc", "Q5": "lcsc"}
    assert any(a["action"] == "body-choose" and a["detail"]["ref"] == "Q5"
               for a in world.db["audit"].rows)
    # Back to the part's default, and the refusals.
    assert call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "default"})[1]["wears"] == "lcsc"
    assert call(world, "PUT", "/api/boards/demo-board/bodies/Q9", {"variant": "lcsc"})[0] == 404
    assert call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "short"})[0] == 404
    assert call(world, "PUT", "/api/boards/nope/bodies/Q5", {"variant": "lcsc"})[0] == 404


def test_another_workspace_sees_none_of_it(world):
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    other = scope.ScopedDb(world.db, "team2")
    got = run(bodies.listing(other, PART))
    assert [b["slug"] for b in got["bodies"]] == ["lcsc"]


# ---------------------------------------------------------------- roles

@pytest.mark.parametrize("method,path,act", [
    ("POST", f"/api/parts/{PART}/bodies", "edit"),
    ("PUT", f"/api/parts/{PART}/bodies/default", "edit"),
    ("DELETE", f"/api/parts/{PART}/bodies/lying-flat", "edit"),
    ("PUT", "/api/boards/demo-board/bodies/Q5", "edit"),
    ("POST", f"/api/parts/{PART}/body-request", "run"),
    ("GET", f"/api/parts/{PART}/bodies", "view"),
    ("GET", "/api/boards/demo-board/bodies", "view"),
])
def test_each_route_is_its_action(method, path, act):
    assert access.action(method, path) == act


def test_a_reviewer_token_may_look_but_not_bind_or_ask(world, monkeypatch):
    monkeypatch.setattr(auth, "bearer", lambda headers: "rlat_test")

    async def token_agent(db, token):
        return {"actor": actors.agent("pcb room"), "workspace": scope.DEFAULT, "role": "reviewer"}
    monkeypatch.setattr(auth, "token_agent", token_agent)
    monkeypatch.setattr(auth, "count_usage", lambda *a, **k: None)
    assert call(world, "GET", f"/api/parts/{PART}/bodies")[0] == 200
    st, out = call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "x"})
    assert st == 403 and out["refused"] == "edit"
    st, out = call(world, "POST", f"/api/parts/{PART}/body-request", {"name": "x", "why": "y"})
    assert st == 403 and out["refused"] == "run"


# ---------------------------------------------------------------- the 3D room's note

def test_the_request_note_carries_what_the_3d_agent_needs(world):
    st, out = call(world, "POST", f"/api/parts/{PART}/body-request",
                   {"name": "lying flat", "why": "bolted to the board flat, tab over the edge",
                    "board": "demo-board", "ref": "Q5"})
    assert st == 200, out
    assert out["model"] == f"components/{PART}-lying-flat"
    note = next(r for r in world.db["revisions"].rows if r["_id"] == out["note"])
    assert note["kind"] == "cad" and note["status"] == "queued"
    assert note["model"] == f"components/{PART}-lying-flat"
    assert note["body_request"]["ref"] == "Q5"
    text = note["comment"]
    assert len(text) <= 4000
    for want in ("lying flat", "bolted to the board flat", "component frame",
                 "+Y = the footprint's -Y", "offset, no rotate",
                 # pin 1 at footprint (0, -2.54) is (0, 2.54) in the frame
                 "1 thru_hole rect 2x2.5 rot -90 at (0, 2.54) drill 1.3  <- pin 1",
                 "3 thru_hole oval 2x2.5 rot -90 at (0, -2.54)",
                 "courtyard: x -2.63..1.87, y -5..5 (4.5 x 10)",
                 # the WRL's 10.16 x 5.08 x 2.54 box, moved by the seat's offset
                 "LCSC's body as it sits now: x 0.055..10.215, y 0..5.08, z -2.8..-0.26",
                 f"pdf text {PART}", f"pdf page {PART} <n>",
                 f"part body-bind {PART} components/{PART}-lying-flat --name \"lying flat\"",
                 "board body demo-board Q5 lying-flat"):
        assert want in text, want
    # The folder it is to be saved in exists, so the model shows once saved.
    assert world.db["folders"].rows[0]["_id"] == "components"
    assert any(a["action"] == "body-request" for a in world.db["audit"].rows)


def test_a_request_is_checked(world):
    ask = lambda **b: call(world, "POST", f"/api/parts/{PART}/body-request",
                           {"name": "lying flat", "why": "flat", **b})
    assert ask(board="demo-board")[0] == 400                   # --board without --ref
    assert ask(board="demo-board", ref="R1")[0] == 404         # R1 is another part
    assert ask(why=" ")[0] in (400, 422)
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    assert ask()[0] == 409                                     # it has one by that name


def test_a_many_pad_note_stays_a_note():
    pads = [{"number": str(i), "type": "smd", "shape": "rect", "x": i * 0.5, "y": 0.0,
             "w": 0.3, "h": 1.0, "rot": 0.0} for i in range(1, 200)]
    sp = {"lcsc": "C1", "footprint": "QFN", "pads": pads, "pin1": pads[0], "outline": {},
          "lcsc_box": None, "part": {}}
    text = bodies.request_text(sp, "tall", "why", "components/C1-tall", None, None)
    assert len(text) <= 4000 and "more lines" in text and "part body-bind C1" in text


# ---------------------------------------------------------------- the commands

def cli(*argv) -> None:
    old = sys.argv
    sys.argv = ["revisions.py", *argv]
    try:
        revisions.main()
    finally:
        sys.argv = old


@pytest.mark.parametrize("transport", ["", "api"])
def test_the_commands_over_either_transport(world, monkeypatch, capsys, transport):
    monkeypatch.setenv("REDLINE_TRANSPORT", transport)
    calls = []

    def api(path, method="GET", body=None, timeout=60):
        calls.append((method, path))
        st, out = call(world, method, path, body)
        if st >= 400:
            raise revisions.ApiError(f"{method} {path}: {st} {out.get('detail')}")
        return out
    monkeypatch.setattr(revisions, "api_call", api)

    cli("part", "body-bind", PART, "scratch/flat", "--name", "lying flat")
    assert ("POST", f"/api/parts/{PART}/bodies") in calls
    cli("part", "bodies", PART)
    out = capsys.readouterr().out
    assert "* lcsc" in out and "  lying-flat" in out
    cli("board", "body", "demo-board", "Q5", "lying-flat")
    out = capsys.readouterr().out
    assert "Q5 (C111607) wears lying-flat" in out and "Q5       C111607     wears lying-flat" in out
    cli("part", "body-default", PART, "lying-flat")
    assert "default body lying-flat" in capsys.readouterr().out
    cli("board", "body", "demo-board")
    out = capsys.readouterr().out
    assert "Q1       C111607     wears lying-flat" in out and "[lcsc, *lying-flat]" in out
    with pytest.raises(SystemExit) as stop:
        cli("part", "body-unbind", PART, "lying-flat")
    assert "409" in str(stop.value)
    cli("part", "body-unbind", PART, "lying-flat", "--force")
    assert "demo-board Q5: back to the part's default (lcsc)" in capsys.readouterr().out
    cli("part", "body-request", PART, "--name", "short legs", "--why", "the heatsink sits low",
        "--board", "demo-board", "--ref", "Q5")
    out = capsys.readouterr().out
    assert f"components/{PART}-short-legs" in out and "board body demo-board Q5 short-legs" in out
    cli("part", "bodies", PART, "--spec")
    spec = json.loads(capsys.readouterr().out)
    assert spec["pin1"]["number"] == "1" and spec["lcsc_box"]["kind"] == "wrl"
    # Every one of them went through the server, whichever transport.
    assert all(p.startswith("/api/") for _m, p in calls)


# ---------------------------------------------------------------- into the .kicad_pcb

PCB = """(kicad_pcb
\t(version 20241229)
\t(footprint "C111607"
\t\t(layer "F.Cu")
\t\t(at 10 20 90)
\t\t(property "Reference" "Q5"
\t\t)
\t\t(model "/work/3d/C111607.step"
\t\t\t(offset
\t\t\t\t(xyz 0.055 0 -2.8)
\t\t\t)
\t\t\t(scale
\t\t\t\t(xyz 1 1 1)
\t\t\t)
\t\t\t(rotate
\t\t\t\t(xyz 0 0 0)
\t\t\t)
\t\t)
\t)
\t(footprint "C111607"
\t\t(layer "F.Cu")
\t\t(at 30 20)
\t\t(property "Reference" "Q1"
\t\t)
\t\t(model "/work/3d/C111607.step"
\t\t\t(offset
\t\t\t\t(xyz 0.055 0 -2.8)
\t\t\t)
\t\t)
\t)
)
"""


def test_the_frame_rule_and_the_body_block():
    assert modelseat.to_component(1.5, -2.54) == (1.5, 2.54)
    dressed = modelseat.with_body(FOOTPRINT, "/work/3d/body-C111607-flat.step")
    assert modelseat.model_path_of(dressed) == "/work/3d/body-C111607-flat.step"
    assert modelseat.offset_of(dressed) == (0.0, 0.0, 0.0)
    assert modelseat.rotation_of(dressed) == (0.0, 0.0, 0.0)
    assert dressed.count("(model") == 1 and "(pad 1 thru_hole rect" in dressed
    bare = modelseat.with_body("(module x (layer F.Cu)\n\t(pad 1 smd rect (at 0 0) (size 1 1))\n)",
                               "/work/3d/b.step")
    assert modelseat.model_path_of(bare) == "/work/3d/b.step" and bare.rstrip().endswith(")")


@pytest.fixture
def place():
    loaded = []
    stub = types.SimpleNamespace(
        F_SilkS=1, B_SilkS=2, F_CrtYd=3, PCB_TEXT=type("PCB_TEXT", (), {}),
        VECTOR2I=lambda *a: a, BOARD=object, PCB_SHAPE=object,
        SHAPE_T_SEGMENT=0, Edge_Cuts=0, NETINFO_ITEM=object,
        PAD_ATTRIB_PTH=0, PAD_ATTRIB_NPTH=1, FootprintLoad=lambda d, n: loaded.append((d, n)) or (d, n),
        SaveBoard=lambda *a: None, LoadBoard=lambda *a: None)
    old = sys.modules.get("pcbnew")
    sys.modules["pcbnew"] = stub
    sys.path.insert(0, str(HERE / "docker"))
    sys.modules.pop("place", None)
    import place as P                                         # noqa: PLC0415
    P.pcbnew = stub
    yield P, loaded
    sys.modules.pop("place", None)
    if old is not None:
        sys.modules["pcbnew"] = old


def test_the_choice_reaches_the_layout_s_footprint(world, tmp_path, place):
    """kicad.render's way: the footprints written into work/fp, the bodies
    staged, the placer loading the reference's footprint - which wears the
    drawn STEP at offset 0, rotate 0 - and a pose taken off it."""
    P, loaded = place
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "lying-flat"})
    work = tmp_path / "work"
    (work / "fp").mkdir(parents=True)
    (work / "3d").mkdir()
    lcsc_fp = FOOTPRINT.replace("/tmp/x/lib.3dshapes/TO-220.step", f"/work/3d/{PART}.wrl")
    (work / "fp" / f"{PART}.kicad_mod").write_text(lcsc_fp)
    sdb = world.sdb
    use, left = run(bodies.for_board(sdb, "demo-board"))
    assert list(use) == ["Q5"] and use["Q5"]["model"] == "scratch/flat" and not left
    dressed, left = run(bodies.stage(sdb, work, use, {}))
    assert dressed == {"Q5": f"/work/fp/body-lying-flat/{PART}.kicad_mod"} and not left
    assert (work / "3d" / f"body-{PART}-lying-flat.step").read_bytes() == b"ISO-10303-21; flat v1"
    text = (work / "fp" / "body-lying-flat" / f"{PART}.kicad_mod").read_text()
    assert modelseat.model_path_of(text) == f"/work/3d/body-{PART}-lying-flat.step"
    assert modelseat.offset_of(text) == (0, 0, 0) and modelseat.rotation_of(text) == (0, 0, 0)
    # A pose on the same reference is taken off, and says why; others stay.
    plan = {"poses": {"Q5": {"rotate": [90, 0, 0]}, "Q1": {"rotate": [0, 0, 90]}}}
    why = bodies.unposed(plan, dressed, use)
    assert list(plan["poses"]) == ["Q1"] and "lying flat" in why["Q5"]
    # The placer loads that file for Q5 (by its container path) - the same
    # stem, so the footprint keeps the part's name - and the shared one for Q1.
    container = {f"/work/fp/body-lying-flat/{PART}.kicad_mod":
                 str(work / "fp" / "body-lying-flat" / f"{PART}.kicad_mod")}
    P.load({"ref": "Q5", "footprint": container[dressed["Q5"]]}, plan["poses"], [], {},
           scratch=str(tmp_path / "posed"))
    P.load({"ref": "Q1", "footprint": str(work / "fp" / f"{PART}.kicad_mod")}, plan["poses"], [], {},
           scratch=str(tmp_path / "posed"))
    assert loaded[0] == (str(work / "fp" / "body-lying-flat"), PART)
    assert loaded[1][1] == PART and loaded[1][0].endswith("posed/Q1")


def test_a_refresh_puts_each_reference_s_body_in_again(world, tmp_path):
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "lying-flat"})
    work = tmp_path / "w"
    (work / "3d").mkdir(parents=True)
    text, worn, left = run(bodies.refit(world.sdb, "demo-board", PCB, work))
    feet = {f["ref"]: f for f in modelseat.board_footprints(text)}
    assert feet["Q5"]["model"] == f"/work/3d/body-{PART}-lying-flat.step"
    assert feet["Q5"]["offset"] == (0, 0, 0) and feet["Q5"]["rotation"] == (0, 0, 0)
    assert feet["Q1"]["model"] == f"/work/3d/{PART}.step"         # untouched
    assert list(worn) == ["Q5"] and (work / "3d" / f"body-{PART}-lying-flat.step").exists()
    # Back to LCSC's: the drawer's seated block, with this board's pose if
    # one applies to the reference.
    call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "lcsc"})
    world.db["boards"].rows[0]["poses"] = {"Q5": {"rotate": [90, 0, 0], "offset": None,
                                                  "mirror": None, "part": PART}}
    again, worn, left = run(bodies.refit(world.sdb, "demo-board", text, work))
    feet = {f["ref"]: f for f in modelseat.board_footprints(again)}
    assert feet["Q5"]["model"] == f"/work/3d/{PART}.wrl"
    assert feet["Q5"]["offset"] == (0.055, 0.0, -2.8) and feet["Q5"]["rotation"] == (90, 0, 0)
    assert not worn


# ---------------------------------------------------------------- how a change travels

def test_a_rebuilt_body_redraws_the_boards_that_wear_it_and_on(world):
    sdb = world.sdb
    call(world, "POST", f"/api/parts/{PART}/bodies", {"model": "scratch/flat", "name": "lying flat"})
    call(world, "PUT", "/api/boards/demo-board/bodies/Q5", {"variant": "lying-flat"})
    for b in world.db["boards"].rows:
        b.pop("body_refresh", None)
    # Built again, the same STEP: nothing to do.
    assert run(bodies.model_built(sdb, "scratch/flat")) == []
    # Built again with a different STEP: the board that wears it, not the other.
    run(store.put_artifact(sdb, "scratch/flat", "step", b"ISO-10303-21; flat v2"))
    assert run(bodies.model_built(sdb, "scratch/flat")) == ["demo-board"]
    board = next(b for b in world.db["boards"].rows if b["_id"] == "demo-board")
    assert board["body_refresh"]["state"] == "queued"
    assert board["body_refresh"]["because"]["model"] == "scratch/flat"
    assert "body_refresh" not in next(b for b in world.db["boards"].rows if b["_id"] == "other-board")
    # The redraw makes a new board 3D, which rebuilds what imports the board.
    drawn = []

    async def refresher(d, bid):
        drawn.append(bid)
        return await links.board_component(d, bid, b"ISO-10303-21; board", {"size": [1, 1]}, None,
                                           digest="d-" + str(len(drawn)))
    board["body_refresh"]["due"] = "2000-01-01T00:00:00+00:00"
    said = []

    async def say(text, level="info", room="cad"):
        said.append(text)
    assert run(bodies.tick(sdb, refresher, say)) == ["demo-board"]
    assert drawn == ["demo-board"] and board["body_refresh"]["state"] == "done"
    case = next(m for m in world.db["models"].rows if m["_id"] == "p/case")
    assert case["link"]["state"] == "queued" and case["link"]["because"]["id"] == "demo-board"
    assert "rebuilding p/case" in said[0]
    # Nothing queued: nothing drawn.
    assert run(bodies.tick(sdb, refresher, say)) == []


def test_a_failed_redraw_is_said_on_the_board(world):
    run(bodies.queue_boards(world.sdb, ["demo-board"], {"model": "x"}))
    world.db["boards"].rows[0]["body_refresh"]["due"] = "2000-01-01T00:00:00+00:00"

    async def refresher(d, bid):
        raise RuntimeError("the STEP export failed")
    assert run(bodies.tick(world.sdb, refresher)) == []
    r = world.db["boards"].rows[0]["body_refresh"]
    assert r["state"] == "failed" and "STEP export" in r["error"]
