"""A part's 3D pose corrected on one board (backend/poses.py): checked,
kept on the board, listed and removed through the API and the command
line, and written by the placer (docker/place.py `posed`) into this
board's copy of the footprint - the model's offset and rotation replaced,
the silkscreen and courtyard mirrored, the pads and copper left alone."""

from __future__ import annotations

import json
import math
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import access, actors, auth, poses, store
from backend import main as M
from test_component_pins import Bucket
from test_links import FakeDb, run

HERE = Path(__file__).resolve().parent.parent
PARTS = {"Q5": "C29780637", "I2C": "C91552", "UART2": "C91552", "R1": None}


# ---------------------------------------------------------------- checking

def test_a_good_pose_is_kept_with_the_part_it_was_measured_on():
    got = poses.check("Q5", {"rotate": [90, 0, 0], "offset": "0, 1.785, 2.27", "why": "flat"}, PARTS)
    assert got == {"rotate": [90.0, 0.0, 0.0], "offset": [0.0, 1.785, 2.27], "mirror": None,
                   "part": "C29780637", "why": "flat"}
    assert poses.check("I2C", {"mirror": "Y"}, PARTS)["mirror"] == "y"
    assert poses.check("I2C", {"offset": [0, 0, 1], "part": "c91552"}, PARTS)["part"] == "C91552"


@pytest.mark.parametrize("ref,body,says", [
    ("Q9", {"rotate": [0, 0, 0]}, "no part Q9"),
    ("Q5", {"offset": [0, 0, 101]}, "offset.z"),
    ("Q5", {"offset": [0, math.inf, 0]}, "offset.y"),
    ("Q5", {"rotate": [0, 0, float("nan")]}, "rotate.z"),
    ("Q5", {"rotate": [720, 0, 0]}, "rotate.x"),
    ("Q5", {"rotate": [1, 2]}, "three numbers"),
    ("Q5", {"rotate": ["a", 0, 0]}, "not a number"),
    ("Q5", {"mirror": "z"}, "mirror"),
    ("Q5", {}, "say what to change"),
    ("Q5", {"offset": [0, 0, 0], "part": "LM317"}, "part"),
    ("Q5.x", {"offset": [0, 0, 0]}, "reference designator"),
])
def test_a_bad_pose_is_refused_naming_the_field(ref, body, says):
    with pytest.raises(poses.PoseError) as err:
        poses.check(ref, body, PARTS)
    assert any(says in p for p in err.value.problems), err.value.problems


def test_an_unbuilt_board_cannot_check_a_ref():
    with pytest.raises(poses.PoseError, match="no build yet"):
        poses.check("Q5", {"offset": [0, 0, 0]}, None)


def test_only_poses_for_the_part_the_board_still_has_are_applied():
    kept = {"Q5": {"rotate": [90, 0, 0], "offset": [0, 1, 2], "mirror": None, "part": "C29780637"},
            "I2C": {"rotate": None, "offset": [0, 2.85, 0], "mirror": "y", "part": "C91552"},
            "J9": {"offset": [0, 0, 0], "part": None}}
    comps = [{"ref": "Q5", "part": "C111607"}, {"ref": "I2C", "part": "C91552"}]
    use, left = poses.for_plan(kept, comps)
    assert use == {"I2C": {"rotate": None, "offset": [0, 2.85, 0], "mirror": "y"}}
    assert "C29780637" in left["Q5"] and "C111607" in left["Q5"]
    assert left["J9"] == "not on the board any more"


# ---------------------------------------------------------------- the placer

@pytest.fixture(scope="module")
def place():
    sys.modules.setdefault("pcbnew", types.SimpleNamespace(
        F_SilkS=1, B_SilkS=2, F_CrtYd=3, PCB_TEXT=type("PCB_TEXT", (), {}),
        VECTOR2I=lambda *a: a, BOARD=object, PCB_SHAPE=object,
        SHAPE_T_SEGMENT=0, Edge_Cuts=0, NETINFO_ITEM=object,
        PAD_ATTRIB_PTH=0, PAD_ATTRIB_NPTH=1, FootprintLoad=lambda *a: None,
        SaveBoard=lambda *a: None, LoadBoard=lambda *a: None))
    sys.path.insert(0, str(HERE / "docker"))
    import place                                    # noqa: PLC0415
    return place


# What easyeda2kicad writes (KiCad 5's form), cut down.
OLD = """(module easyeda2kicad:HDR-TH_4P (layer F.Cu) (tedit 5DC5F6A4)
	(fp_text reference REF** (at 0.000 -4.000) (layer F.SilkS)
		(effects (font (size 1 1) (thickness 0.15)))
	)
	(fp_text value HDR (at 0.000 4.000) (layer F.Fab)
		(effects (font (size 1 1) (thickness 0.15)))
	)
	(fp_line (start 5.07 1.65) (end -5.09 1.65) (layer F.SilkS) (width 0.25))
	(fp_line (start 1 2) (end 3 4) (layer F.Fab) (width 0.1))
	(pad 1 thru_hole rect (at -3.81 1.50 0.00) (size 1.800 1.800) (layers *.Cu *.Mask)(drill 1.1))
	(fp_arc (start -2.77 2.53) (end -2.77 2.33) (angle 359.27) (layer F.SilkS) (width 0.40))
	(fp_line (start -5.08 1.64) (end 5.08 4.18) (layer F.CrtYd) (width 0.05))
	(model "/work/3d/C91552.step"
		(offset (xyz -0.005 -2.850 0.050))
		(scale (xyz 1 1 1))
		(rotate (xyz 0 0 180))
	)
)
"""

# KiCad's own form, as the library's passives are.
NEW = """(footprint "R_0402" (version 20240108) (generator "pcbnew")
	(layer "F.Cu")
	(property "Reference" "REF**" (at 0 -1.17 0) (layer "F.SilkS")
		(effects (font (size 1 1) (thickness 0.15))))
	(fp_arc (start -1 1) (mid 0 2) (end 1 1) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
	(fp_poly (pts (xy 0 1) (xy 1 2) (xy 2 1)) (stroke (width 0.1) (type solid)) (layer "F.Courtyard"))
	(pad "1" smd roundrect (at -0.51 0.25) (size 0.54 0.64) (layers "F.Cu" "F.Mask" "F.Paste"))
	(model "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl"
		(offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
"""


def model_of(text):
    from backend import modelseat
    return modelseat.offset_of(text), modelseat.rotation_of(text)


def test_the_pose_replaces_the_seat_it_is_not_added_to(place):
    out, trouble = place.posed(OLD, {"rotate": [90, 0, 0], "offset": [0, 1.785, 2.27], "mirror": None})
    assert trouble == []
    assert model_of(out) == ((0.0, 1.785, 2.27), (90.0, 0.0, 0.0))
    assert "(scale (xyz 1 1 1))" in out and '(model "/work/3d/C91552.step"' in out
    # Nothing else moved without a mirror.
    assert out.replace("(offset (xyz 0 1.785 2.27))", "").replace("(rotate (xyz 90 0 0))", "") == \
        OLD.replace("(offset (xyz -0.005 -2.850 0.050))", "").replace("(rotate (xyz 0 0 180))", "")


def test_a_rotation_or_offset_left_out_stays_as_the_footprint_has_it(place):
    out, _ = place.posed(OLD, {"rotate": None, "offset": [1, 2, 3]})
    assert model_of(out) == ((1.0, 2.0, 3.0), (0.0, 0.0, 180.0))
    out, _ = place.posed(OLD, {"rotate": [0, 0, 90], "offset": None})
    assert model_of(out) == ((-0.005, -2.85, 0.05), (0.0, 0.0, 90.0))


def test_mirror_flips_silk_and_courtyard_only(place):
    out, _ = place.posed(OLD, {"offset": [0.005, 2.85, 0.05], "rotate": [0, 0, 0], "mirror": "y"})
    assert "(fp_line (start 5.07 -1.65) (end -5.09 -1.65) (layer F.SilkS)" in out
    assert "(fp_line (start -5.08 -1.64) (end 5.08 -4.18) (layer F.CrtYd)" in out
    # The old arc (centre, start, angle) turns the other way round.
    assert "(fp_arc (start -2.77 -2.53) (end -2.77 -2.33) (angle -359.27) (layer F.SilkS)" in out
    # The reference moves; its letters do not.
    assert "(fp_text reference REF** (at 0 4) (layer F.SilkS)" in out
    assert "(size 1 1) (thickness 0.15)" in out
    # Pads, the fab drawing and its text stay.
    assert "(pad 1 thru_hole rect (at -3.81 1.50 0.00)" in out
    assert "(fp_line (start 1 2) (end 3 4) (layer F.Fab)" in out
    assert "(fp_text value HDR (at 0.000 4.000) (layer F.Fab)" in out


def test_mirror_in_x_and_kicads_own_form(place):
    out, trouble = place.posed(NEW, {"mirror": "x"})
    assert trouble == []
    assert "(fp_arc (start 1 1) (mid 0 2) (end -1 1)" in out
    assert "(pts (xy 0 1) (xy -1 2) (xy -2 1))" in out
    assert '(property "Reference" "REF**" (at 0 -1.17 0)' in out       # x of 0 stays 0
    assert '(pad "1" smd roundrect (at -0.51 0.25)' in out
    assert model_of(out) == ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))


def test_a_footprint_without_a_model_says_so(place):
    bare = OLD[:OLD.index("\t(model")] + ")\n"
    out, trouble = place.posed(bare, {"offset": [0, 0, 1]})
    assert out == bare and trouble


def test_the_shared_footprint_is_never_written(place, tmp_path, monkeypatch):
    shared = tmp_path / "fp" / "C91552.kicad_mod"
    shared.parent.mkdir()
    shared.write_text(OLD)
    seen = []
    monkeypatch.setattr(place.pcbnew, "FootprintLoad", lambda d, n: seen.append((d, n)) or "fp",
                        raising=False)
    done, trouble = [], {}
    got = place.load({"ref": "I2C", "footprint": str(shared)},
                     {"I2C": {"offset": [0, 2.85, 0], "rotate": [0, 0, 0], "mirror": "y"}},
                     done, trouble, scratch=str(tmp_path / "posed"))
    assert got == "fp" and done == ["I2C"] and trouble == {}
    assert shared.read_text() == OLD
    written = tmp_path / "posed" / "I2C" / "C91552.kicad_mod"
    assert seen == [(str(written.parent), "C91552")]
    assert model_of(written.read_text())[0] == (0.0, 2.85, 0.0)
    # A part with no pose loads the shared file as it is.
    place.load({"ref": "R1", "footprint": str(shared)}, {}, done, trouble)
    assert seen[-1] == (str(shared.parent), "C91552")


def test_the_report_names_what_was_turned_and_what_was_not(place):
    rep = place.pose_report({"I2C": {}, "J9": {}}, [{"ref": "I2C"}], ["I2C"], {})
    assert rep == {"posed": ["I2C"], "pose_trouble": {"J9": "not on the board"}}
    assert place.pose_report({}, [], [], {}) == {}


# ---------------------------------------------------------------- the API

GRAPH = {"components": [{"ref": r, "part": p} for r, p in PARTS.items()], "nets": []}


@pytest.fixture
def web(monkeypatch, tmp_path):
    db = FakeDb()
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda d, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    said = []

    async def say(text, level="info", room="cad"):
        said.append((text, room))
        return {}
    monkeypatch.setattr(M, "say", say)

    async def seed():
        db["boards"].rows.append({"_id": "b", "title": "B"})
        await store.put_artifact(M.db(), "b", "graph", json.dumps(GRAPH).encode(), collection="boards")
    run(seed())
    return TestClient(M.app), db, said


H = {"x-redline-csrf": "1"}


def test_set_list_and_remove_a_pose(web):
    client, db, said = web
    r = client.put("/api/boards/b/poses/Q5", headers=H,
                   json={"rotate": [90, 0, 0], "offset": [0, 1.785, 2.27], "why": "lies flat"})
    assert r.status_code == 200, r.text
    kept = db["boards"].rows[0]["poses"]["Q5"]
    assert kept["offset"] == [0.0, 1.785, 2.27] and kept["part"] == "C29780637"
    assert kept["by"]["name"] and kept["at"]
    assert r.json()["pose"]["applies"] is True
    assert said and said[-1][1] == "pcb" and "Q5" in said[-1][0]
    client.put("/api/boards/b/poses/I2C", headers=H, json={"offset": "0.005,2.85,0.05", "mirror": "y"})
    listed = client.get("/api/boards/b/poses").json()["poses"]
    assert sorted(listed) == ["I2C", "Q5"] and listed["I2C"]["mirror"] == "y"
    assert client.delete("/api/boards/b/poses/Q5", headers=H).status_code == 200
    assert "Q5" not in db["boards"].rows[0]["poses"]
    assert client.delete("/api/boards/b/poses/Q5", headers=H).status_code == 404
    assert client.delete("/api/boards/b/poses", headers=H).json()["poses"] == {}


def test_a_pose_for_another_part_is_kept_but_said_not_to_apply(web):
    client, db, _ = web
    r = client.put("/api/boards/b/poses/Q5", headers=H, json={"offset": [0, 0, 1], "part": "C111607"})
    assert r.status_code == 200
    assert r.json()["pose"]["applies"] is False and "C111607" in r.json()["pose"]["left_out"]


def test_a_bad_pose_is_refused_with_its_problems(web):
    client, db, _ = web
    r = client.put("/api/boards/b/poses/Q9", headers=H, json={"offset": [0, 0, 500]})
    assert r.status_code == 400
    problems = r.json()["detail"]["problems"]
    assert any("Q9" in p for p in problems) and any("offset.z" in p for p in problems)
    assert "poses" not in db["boards"].rows[0]
    assert client.put("/api/boards/nope/poses/Q5", headers=H, json={"offset": [0, 0, 0]}).status_code == 404


def test_poses_take_the_rules_right_and_are_audited():
    for method in ("PUT", "DELETE"):
        assert access.action(method, "/api/boards/b/poses/Q5") == "edit"
    assert access.action("DELETE", "/api/boards/b/poses") == "edit"
    assert access.action("GET", "/api/boards/b/poses") == "view"
    assert not access.allowed("reviewer", "edit") and access.allowed("editor", "edit")
    assert actors.audited("PUT", "/api/boards/b/poses/Q5") == "settings"
    assert actors.audited("DELETE", "/api/boards/b/poses/Q5") == "delete"


# ---------------------------------------------------------------- the command line

def test_the_command_sets_lists_and_clears(capsys):
    sys.path.insert(0, str(HERE / "tools"))
    import revisions                                # noqa: PLC0415
    calls = []
    row = {"rotate": [90, 0, 0], "offset": [0, 1.785, 2.27], "mirror": None, "part": "C29780637",
           "why": "flat", "by": {"name": "pcb room"}, "at": "2026-10-09T12:00", "applies": True}

    def call(path, method="GET", body=None, timeout=60):
        calls.append((method, path, body))
        return {"poses": {} if method == "DELETE" else {"Q5": row}}

    def args(**kw):
        base = dict(file=None, clear=False, rotate=None, offset=None, mirror=None, lcsc=None, why=None)
        return types.SimpleNamespace(**{**base, **kw})

    revisions._board_pose(call, "b", args(file="Q5", rotate="90,0,0", offset="0,1.785,2.27", why="flat"))
    assert calls[-1] == ("PUT", "/api/boards/b/poses/Q5",
                         {"rotate": "90,0,0", "offset": "0,1.785,2.27", "mirror": None,
                          "part": None, "why": "flat"})
    out = capsys.readouterr().out
    assert "Q5" in out and "90,0,0" in out and "board run b" in out
    revisions._board_pose(call, "b", args(file="I2C", offset="0,2.85,0", mirror="y"))
    assert calls[-1][2]["mirror"] == "y"
    revisions._board_pose(call, "b", args())
    assert calls[-1] == ("GET", "/api/boards/b/poses", None)
    revisions._board_pose(call, "b", args(file="Q5", clear=True))
    assert calls[-1][:2] == ("DELETE", "/api/boards/b/poses/Q5")
    with pytest.raises(SystemExit):
        revisions._board_pose(call, "b", args(file="Q5"))
