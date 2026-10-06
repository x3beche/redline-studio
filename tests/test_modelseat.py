"""An LCSC part's 3D body, seated on its pads.

easyeda2kicad writes `(offset (xyz 0 0 0))` and copies the STEP as it came,
so on a board every body stood wherever its STEP's origin was: a 2x8
header 8.9 mm off its pins, chip resistors half sunk into the board. What
has to hold: EasyEDA's placement is read the way easyeda2kicad reads it;
the offset turns the model the way KiCad does before moving it; a WRL that
is already baked gets (nearly) nothing more; and the footprint text is
changed in its model block and nowhere else.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import lcsc, modelseat as ms


def component(c_origin="4000,3000", z="0", children=None, etype="outline3D",
              head=(4000, 3000), extra_nodes=()):
    node = {"attrs": {"c_etype": etype, "uuid": "u1", "title": "M",
                      "c_origin": c_origin, "z": z, "c_rotation": "0,0,0"},
            "childNodes": children or []}
    shapes = ["TRACK~1~3~~0 0 1 1~gge1~0", *extra_nodes,
              "SVGNODE~" + json.dumps(node)]
    return {"packageDetail": {"dataStr": {"head": {"x": head[0], "y": head[1]},
                                          "shape": shapes}}}


FOOTPRINT = """(module "X" (layer F.Cu)
\t(fp_text reference REF** (at 0 -2) (layer F.SilkS))
\t(pad 1 smd rect (at -1 0) (size 1 1) (layers F.Cu))
\t(pad 2 smd rect (at 1 0) (size 1 1) (layers F.Cu))
\t(model "/tmp/x/lib.3dshapes/X.wrl"
\t\t(offset (xyz 0.000 0.000 0.000))
\t\t(scale (xyz 1 1 1))
\t\t(rotate (xyz 0 0 270))
\t)
)
"""


def close(a, b, tol=1e-6):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


# ---- EasyEDA's placement ----------------------------------------------------

def test_placement_is_c_origin_from_the_canvas_origin_in_mm_y_up():
    # 10 canvas units right, 5 down (canvas y grows down), z -5 units.
    t = ms.placement(component(c_origin="4010,3005", z="-5"))
    assert close(t, (2.54, -1.27, -1.27))


def test_the_outline_centre_wins_when_it_is_off_by_more_than_0_1_mm():
    rect = [{"attrs": {"points": "4020 2990 4040 2990 4040 3010 4020 3010"}}]
    t = ms.placement(component(c_origin="4000,3000", children=rect))
    assert close(t, (30 * 0.254, 0.0, 0.0))


def test_an_outline_that_agrees_with_c_origin_changes_nothing():
    rect = [{"attrs": {"points": "3990 2990 4010 2990 4010 3010 3990 3010"}}]
    assert close(ms.placement(component(children=rect)), (0, 0, 0))


def test_the_outline3d_node_is_the_one_read():
    other = "SVGNODE~" + json.dumps({"attrs": {"c_etype": "logo",
                                               "c_origin": "5000,5000"}})
    t = ms.placement(component(c_origin="4010,3000", extra_nodes=[other]))
    assert close(t, (2.54, 0, 0))


def test_no_3d_node_is_no_placement():
    c = {"packageDetail": {"dataStr": {"head": {}, "shape": ["TRACK~1"]}}}
    assert ms.placement(c) is None
    assert ms.placement({}) is None


# ---- KiCad's turn, then offset ------------------------------------------------

def test_kicad_turns_by_minus_the_rotation():
    # Checked with kicad-cli: a 4x1x1 box at x[0,4] y[0,1] with
    # (rotate (xyz 0 0 90)) (offset (xyz 1 2 3)) on a footprint at
    # (100,100) exported at x[101,102] y[-102,-98] - turned by -90.
    m = ms.rotation_matrix(0, 0, 90)
    x = [sum(m[i][k] * v for k, v in enumerate((1, 0, 0))) for i in range(3)]
    assert close(x, (0, -1, 0))


def test_turned_box_is_exact_for_quarter_turns():
    box = ((0, 0, 0), (4, 1, 1))
    assert ms.turned_box(box, (0, 0, 90)) == ((0, -4, 0), (1, 0, 1))
    assert ms.turned_box(box, (0, 0, 0)) == box


def test_seat_puts_the_turned_box_on_the_placement():
    # The same box and turn as the kicad-cli check: turned it is
    # x[0,1] y[-4,0]; centred on (1,2) with its bottom at 3.
    off = ms.seat(((0, 0, 0), (4, 1, 1)), (0, 0, 90), (1, 2, 3))
    assert off == (0.5, 4.0, 3.0)


def test_seat_a_header_whose_step_starts_at_pin_one():
    # C68234, a 2x8 header: the STEP's origin is pin 1, the footprint's
    # the middle. Before: 8.9 mm off in x, 1.27 in y. EasyEDA puts its
    # centre on the footprint's, pins 3 mm below the board.
    box = ((-1.27, -3.81, -3.0), (19.06, 1.27, 8.5))
    off = ms.seat(box, (0, 0, 0), (0.0, 0.0, -3.0))
    assert off == (-8.895, 1.27, 0.0)


def test_a_chip_centred_on_z_zero_is_lifted_onto_the_board():
    # 0603s come with z[-0.4, 0.4]: half of the body in the board.
    assert ms.seat(((-0.8, -0.4, -0.4), (0.8, 0.4, 0.4)), (0, 0, 0),
                   (0, 0, 0)) == (0.0, 0.0, 0.4)


def test_the_placement_is_in_the_footprint_frame_not_the_models():
    # A part turned 180 with its body 0.75 below centre (C431540): the body
    # goes to y=-0.75 whichever way the model itself is turned.
    box = ((-3.9, -2.85, -0.5), (3.9, 2.35, 1.51))
    off = ms.seat(box, (0, 0, 180), (0.0, -0.75, -0.5))
    (x0, y0, z0), (x1, y1, _) = ms.turned_box(box, (0, 0, 180))
    assert close(((x0 + x1) / 2 + off[0], (y0 + y1) / 2 + off[1], z0 + off[2]),
                 (0, -0.75, -0.5), 1e-3)


def test_a_baked_wrl_needs_no_more_offset():
    # easyeda2kicad already centred the WRL on the placement and put its
    # bottom at z: seating it again must not move it twice.
    box = ((-1.5, -0.5, -0.2), (1.5, 1.5, 2.0))       # centre (0, 0.5), bottom -0.2
    assert ms.seat(box, (0, 0, 0), (0.0, 0.5, -0.2)) == (0.0, 0.0, 0.0)


def test_tiny_offsets_are_zero():
    assert ms.seat(((-1, -1, -0.0001), (1, 1, 1)), (0, 0, 0), (0, 0, 0)) \
        == (0.0, 0.0, 0.0)


# ---- the model's box ------------------------------------------------------------

STEP_TEXT = b"""ISO-10303-21;
DATA;
#1=CARTESIAN_POINT('',(-1.,2.5,0.));
#2=CARTESIAN_POINT('Origin',(3.25,-0.5,1.5E0));
#3=DIRECTION('',(0.,0.,1.));
ENDSEC;
END-ISO-10303-21;
"""


def test_step_box_by_points():
    assert ms.step_box_by_points(STEP_TEXT) == ((-1.0, -0.5, 0.0), (3.25, 2.5, 1.5))


def test_step_box_by_points_of_nothing():
    assert ms.step_box_by_points(b"ISO-10303-21;\nEND-ISO-10303-21;\n") is None


def test_step_box_reads_a_real_step(tmp_path):
    pytest.importorskip("OCP")
    build123d = pytest.importorskip("build123d")
    part = build123d.Pos(5, -1, -0.4) * build123d.Box(2, 4, 0.8)
    path = tmp_path / "b.step"
    build123d.export_step(part, str(path))
    lo, hi = ms.step_box(path.read_bytes())
    assert close(lo, (4, -3, -0.8), 1e-3) and close(hi, (6, 1, 0.0), 1e-3)


def test_wrl_box_is_in_mm():
    wrl = """#VRML V2.0 utf8
Shape{ geometry IndexedFaceSet { coord DEF co Coordinate { point [
  -1 0 0, 1 2 0.5
] } coordIndex [0,1,-1,] } }
Shape{ geometry IndexedFaceSet { coord DEF co Coordinate { point [
  0 -1 1
] } } }"""
    lo, hi = ms.wrl_box(wrl)
    assert close(lo, (-2.54, -2.54, 0)) and close(hi, (2.54, 5.08, 2.54))


# ---- the footprint text ------------------------------------------------------------

def test_offset_and_rotation_are_read_from_the_model_block():
    assert ms.rotation_of(FOOTPRINT) == (0, 0, 270)
    assert ms.offset_of(FOOTPRINT) == (0, 0, 0)
    assert ms.has_model(FOOTPRINT)
    assert not ms.has_model("(module X (pad 1 smd rect (at 0 0)))")


def test_with_offset_changes_the_offset_and_nothing_else():
    out = ms.with_offset(FOOTPRINT, (-8.895, 1.27, 0.4))
    assert "(offset (xyz -8.895 1.270 0.400))" in out
    assert ms.offset_of(out) == (-8.895, 1.27, 0.4)
    assert out.replace("(offset (xyz -8.895 1.270 0.400))",
                       "(offset (xyz 0.000 0.000 0.000))") == FOOTPRINT


def test_with_offset_is_idempotent():
    once = ms.with_offset(FOOTPRINT, (1, 2, 3))
    assert ms.with_offset(once, (1, 2, 3)) == once


def test_with_offset_adds_one_where_there_was_none():
    text = '(module X\n  (model "a b.step" (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))\n)\n'
    out = ms.with_offset(text, (1, 0, 0))
    assert ms.offset_of(out) == (1, 0, 0)
    assert out.startswith('(module X\n  (model "a b.step" (offset (xyz 1.000 0.000 0.000))')


def test_an_offset_outside_the_model_block_is_left_alone():
    text = '(module X (offset (xyz 9 9 9))\n (model "m.step" (offset (xyz 0 0 0))))'
    out = ms.with_offset(text, (1, 2, 3))
    assert "(offset (xyz 9 9 9))" in out and ms.offset_of(out) == (1, 2, 3)


def test_seated_end_to_end_with_a_wrl():
    # A WRL already baked to sit at the placement, turned 270: the
    # offset that remains is what the turn moves it by.
    wrl = "point [ -1 -0.5 0, 1 0.5 1 ]"         # 0.1" units, centred, on z=0
    got = ms.seated(FOOTPRINT, wrl.encode(), "wrl", component())
    text, off = got
    assert off == (0.0, 0.0, 0.0)
    assert ms.offset_of(text) == (0, 0, 0)


def test_seated_needs_a_placement_and_a_model_block():
    assert ms.seated(FOOTPRINT, STEP_TEXT, "wrl", {}) is None
    assert ms.seated("(module X)", STEP_TEXT, "step", component()) is None


# ---- the stored part --------------------------------------------------------------

class FakeParts:
    def __init__(self, docs):
        self.docs = docs

    async def find_one(self, q, proj=None):
        d = self.docs.get(q["_id"])
        return dict(d) if d else None

    async def find(self, q, proj=None):          # pragma: no cover - not async-iterated here
        raise NotImplementedError

    async def update_one(self, q, upd):
        self.docs[q["_id"]].update(upd["$set"])


class FakeDb(dict):
    pass


def test_seat_model_rewrites_the_stored_footprint(monkeypatch):
    parts = FakeParts({"C1": {"_id": "C1", "footprint": FOOTPRINT.replace(
        "(rotate (xyz 0 0 270))", "(rotate (xyz 0 0 0))")}})
    db = FakeDb({lcsc.PARTS: parts})
    # A STEP whose body starts at its own origin, 2 x 1 x 0.8 mm.
    step = (b"#1=CARTESIAN_POINT('',(0.,0.,0.));\n"
            b"#2=CARTESIAN_POINT('',(2.,1.,0.8));\n")

    async def model_of(db_, code):
        return step, "step"

    asked = []

    async def _component(code):
        asked.append(code)
        return component(c_origin="4010,3000")       # centre at x=2.54

    monkeypatch.setattr(lcsc, "model_of", model_of)
    monkeypatch.setattr(lcsc, "_component", _component)
    monkeypatch.setattr(ms, "step_box", ms.step_box_by_points)
    row = asyncio.run(lcsc.seat_model(db, "C1"))
    assert row["status"] == "seated" and asked == ["C1"]
    assert row["offset"] == (1.54, -0.5, 0.0)
    doc = parts.docs["C1"]
    assert ms.offset_of(doc["footprint"]) == (1.54, -0.5, 0.0)
    assert doc["model_offset"] == [1.54, -0.5, 0.0]
    # Again: the same answer, and it says so.
    assert asyncio.run(lcsc.seat_model(db, "C1"))["status"] == "already seated"


def test_seat_model_leaves_a_part_without_a_model(monkeypatch):
    parts = FakeParts({"C2": {"_id": "C2", "footprint": "(module X (pad 1))"}})

    async def model_of(db_, code):               # pragma: no cover
        raise AssertionError("not asked")

    monkeypatch.setattr(lcsc, "model_of", model_of)
    row = asyncio.run(lcsc.seat_model(FakeDb({lcsc.PARTS: parts}), "C2"))
    assert row["status"] == "footprint names no model"


# ---- a WRL-only part, put into the board's GLB ----

WRL = """#VRML V2.0 utf8
Shape{
    appearance Appearance { material Material { diffuseColor 0.25 0.5 0.75 } }
    geometry IndexedFaceSet {
        coord DEF co Coordinate { point [ 0 0 0, 0.1 0 0, 0 0.2 0, 0 0 0.04 ] }
        coordIndex [ 0, 1, 2, -1, 0, 1, 3, -1, 0, 2, 3, 1, -1 ]
    }
}
"""

PCB = """(kicad_pcb (version 20240108)
\t(general (thickness 1.6))
\t(footprint "C518800"
\t\t(layer "F.Cu")
\t\t(at 50 40 90)
\t\t(property "Reference" "Q3")
\t\t(model "/work/3d/C518800.wrl" (offset (xyz 1 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
\t)
\t(footprint "C82899"
\t\t(layer "F.Cu")
\t\t(at 10 10)
\t\t(property "Reference" "U2")
\t\t(model "/work/3d/C82899.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
\t)
)
"""


def _glb(doc: dict, binary: bytes = b"") -> bytes:
    import struct
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js
    if binary:
        body += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def _read_glb(blob: bytes):
    import struct
    pos, doc, binary = 12, None, b""
    while pos < len(blob):
        size, kind = struct.unpack_from("<II", blob, pos)
        if kind == 0x4E4F534A:
            doc = json.loads(blob[pos + 8:pos + 8 + size])
        else:
            binary = blob[pos + 8:pos + 8 + size]
        pos += 8 + size
    return doc, binary


def test_a_wrl_mesh_goes_into_the_glb_where_kicad_would_put_it():
    import numpy as np
    glb = _glb({"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
                "nodes": [{"name": "U2"}], "buffers": [{"byteLength": 0}]})
    out, added = ms.add_meshes(glb, PCB, {"C518800": WRL, "C82899": WRL})
    assert added == ["Q3"]                         # U2 is a STEP: KiCad exported it
    doc, binary = _read_glb(out)
    node = doc["nodes"][-1]
    assert node["name"] == "Q3" and doc["scenes"][0]["nodes"][-1] == len(doc["nodes"]) - 1
    prim = doc["meshes"][node["mesh"]]["primitives"][0]
    acc = doc["accessors"][prim["attributes"]["POSITION"]]
    view = doc["bufferViews"][acc["bufferView"]]
    pts = np.frombuffer(binary, np.float32, acc["count"] * 3, view["byteOffset"]).reshape(-1, 3)
    # The point at the model's origin: moved 1 mm along its X by the
    # offset, turned 90 degrees with the footprint - so 1 mm up the page -
    # and set on the board's top: page (50, 39), 1.6 mm up.
    assert np.allclose(pts[0] * 1000, [50, 1.6, 39], atol=1e-3)
    # 0.2 WRL units (0.1 inch each: 0.508 mm) along the model's Y turns to
    # the page's -X.
    assert np.allclose(pts[2] * 1000, [50 - 0.508, 1.6, 39], atol=1e-3)
    idx = doc["accessors"][prim["indices"]]
    assert idx["count"] == 12                         # two triangles, and a quad fanned into two
    colour = doc["materials"][prim["material"]]["pbrMetallicRoughness"]["baseColorFactor"]
    assert colour == [0.25, 0.5, 0.75, 1.0]


def test_a_part_missing_its_model_is_asked_again_but_not_every_time():
    from backend import lcsc
    fp = '(footprint "X" (model "/tmp/lib.3dshapes/X.wrl" (offset (xyz 0 0 0))))'
    assert lcsc._model_worth_asking_again({"footprint": fp})
    assert not lcsc._model_worth_asking_again({"footprint": fp, "artifacts": {"model": {"bytes": 1}}})
    assert not lcsc._model_worth_asking_again({"footprint": '(footprint "X")'})
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    assert not lcsc._model_worth_asking_again({"footprint": fp, "model_missing_at": now})
    assert lcsc._model_worth_asking_again({"footprint": fp,
                                           "model_missing_at": "2020-01-01T00:00:00+00:00"})
