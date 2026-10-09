"""Parts that move in the 3D viewer (backend/motions.py, export_model.py,
frontend editor/motions.ts).

A model says MOTIONS next to PARTS; the build checks every motion against
the tree it made - a path that is not there, a number that is not one, a
range upside down stop the build with what is wrong - and puts them in
the viewer payload in the form the page reads. An imported model's
MOTIONS stay its own.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from backend import motions as M

REPO = Path(__file__).resolve().parent.parent

SHAPES = {"name": "Station", "parts": [
    {"name": "Base", "parts": [{"name": "case"}, {"name": "cable (case side)"}]},
    {"name": "Fan Module", "parts": [
        {"name": "housing"}, {"name": "rotor"}, {"name": "frame"},
        {"name": "Cradle", "parts": [{"name": "arm"}]}, {"name": "cable (loop)"}]},
]}

TILT = {"part": ["Fan Module/housing", "Fan Module/rotor", "Fan Module/frame"],
        "range": (-18, 18), "default": -18, "axis": (2, 0, 0), "pivot": (0, 0, 40)}
FAN = {"part": "Fan Module/rotor", "spin": 900, "axis": (0, -1, 0), "pivot": (0, 0, 40)}


def check(motions):
    return {m["name"]: m for m in M.check(motions, SHAPES)}


def test_paths_of_the_tree():
    p = M.tree_paths(SHAPES)
    assert p[0] == "/Station" and "/Station/Fan Module/Cradle/arm" in p


def test_a_good_declaration_comes_out_normalised_and_parents_first():
    out = M.check({"Fan": FAN, "Tilt": TILT}, SHAPES)
    assert [m["name"] for m in out] == ["Tilt", "Fan"]
    tilt, fan = out
    assert tilt["kind"] == "range" and tilt["range"] == [-18, 18] and tilt["default"] == -18
    assert tilt["axis"] == [1, 0, 0]                      # unit length
    assert tilt["parts"][0] == "/Station/Fan Module/housing"
    # The rotor is a part of the tilt too: the spin rides on it.
    assert fan["kind"] == "spin" and fan["rpm"] == 900 and fan["on"] == "Tilt"
    json.dumps(out)                                        # goes into the payload as is


def test_a_path_may_name_the_root_or_not():
    a = check({"T": {**TILT, "part": "/Station/Fan Module/Cradle"}})
    b = check({"T": {**TILT, "part": "Fan Module/Cradle"}})
    assert a["T"]["parts"] == b["T"]["parts"] == ["/Station/Fan Module/Cradle"]


def test_a_part_by_its_own_name_when_it_is_the_only_one():
    assert check({"T": {**TILT, "part": ["rotor", "Cradle/arm"]}})["T"]["parts"] == [
        "/Station/Fan Module/rotor", "/Station/Fan Module/Cradle/arm"]
    shapes = {"name": "S", "parts": [{"name": "A", "parts": [{"name": "x"}]},
                                     {"name": "B", "parts": [{"name": "x"}]}]}
    with pytest.raises(M.MotionError, match="is 2 nodes in the tree"):
        M.check({"T": {**TILT, "part": "x"}}, shapes)


def test_riding_on_another_is_found_from_the_tree_or_said():
    m = check({"Tilt": {**TILT, "part": "Fan Module"}, "Arm": {**TILT, "part": "Fan Module/Cradle/arm"}})
    assert m["Arm"]["on"] == "Tilt" and m["Tilt"]["on"] is None
    m = check({"Tilt": TILT, "Fan": {**FAN, "part": "Base/case", "on": "Tilt"}})
    assert m["Fan"]["on"] == "Tilt"


@pytest.mark.parametrize("motions, says", [
    ({"T": {**TILT, "part": "Fan Module/rotr"}}, "no part 'Fan Module/rotr' in the tree; did you mean"),
    ({"T": {**TILT, "range": (18, -18)}}, "must be low < high"),
    ({"T": {**TILT, "default": 40}}, "outside the range"),
    ({"T": {**TILT, "axis": (0, 0, 0)}}, "axis is zero"),
    ({"T": {**TILT, "pivot": (0, float("nan"), 0)}}, "finite number"),
    ({"T": {**TILT, "pivot": (0, 0)}}, "pivot must be (x, y, z)"),
    ({"F": {**FAN, "spin": 0}}, "spin is rpm"),
    ({"F": {**FAN, "range": (0, 1)}}, "exactly one of"),
    ({"F": {**FAN, "on": "Nope"}}, "is not another rigid motion"),
    ({"A": {**TILT, "on": "B"}, "B": {**TILT, "on": "A"}}, "goes round in a circle"),
    ({"C": {"part": "Fan Module/cable (loop)", "follows": "Fan", "radius": 1,
            "paths": {-18: [(0, 0, 0), (1, 0, 0)], 18: [(0, 0, 0), (1, 0, 0)]}}, "Fan": FAN},
     "not a range motion"),
    ("tilt", "MOTIONS must be a dict"),
])
def test_what_is_wrong_is_said(motions, says):
    with pytest.raises(M.MotionError) as e:
        M.check(motions, SHAPES)
    assert says in str(e.value)


def test_a_cable_from_sampled_centre_lines():
    paths = {t: [(0, 0, 40), (0, 10 + t / 10, 30), (0, 20, 0)] for t in (-18, 0, 18)}
    m = check({"Tilt": TILT, "Cable": {"part": "Fan Module/cable (loop)", "follows": "Tilt",
                                         "radius": 1.0, "paths": paths}})
    c = m["Cable"]
    assert c["kind"] == "flex" and c["path"]["values"] == [-18, 0, 18]
    assert c["path"]["points"][2][1] == [0, 11.8, 30]
    # Every sample needs the same number of points, and the whole range.
    bad = dict(paths)
    bad[0] = bad[0][:2]
    with pytest.raises(M.MotionError, match="same number"):
        check({"Tilt": TILT, "Cable": {"part": "Fan Module/cable (loop)", "follows": "Tilt",
                                         "radius": 1.0, "paths": bad}})
    with pytest.raises(M.MotionError, match="not all of"):
        check({"Tilt": TILT, "Cable": {"part": "Fan Module/cable (loop)", "follows": "Tilt",
                                         "radius": 1.0, "paths": {-18: paths[-18], 0: paths[0]}}})


def test_a_cable_between_two_ends_must_reach():
    spec = {"part": "Fan Module/cable (loop)", "follows": "Tilt", "radius": 1.0,
            "from": {"at": (0, 0, 40), "dir": (0, 1, 0)}, "to": {"at": (0, 30, 0), "dir": (0, 0, -1)},
            "length": 60}
    m = check({"Tilt": TILT, "Cable": spec})
    assert m["Cable"]["to"]["dir"] == [0, 0, -1] and m["Cable"]["length"] == 60
    with pytest.raises(M.MotionError, match="shorter than"):
        check({"Tilt": TILT, "Cable": {**spec, "length": 10}})


# ---------------------------------------------------------------- through a build

MODELS = {
    "rotor": '''
        from build123d import *
        TITLE = "Rotor"
        hub = Cylinder(10, 5)
        PARTS = [hub]
        NAMES = ["hub"]
        MOTIONS = {"Own": {"part": "hub", "spin": 100, "axis": (0, 0, 1), "pivot": (0, 0, 0)}}
    ''',
    "fan": '''
        import os
        os.environ["REDLINE_IMPORT_ONLY"] = "1"
        from build123d import *
        import rotor
        TITLE = "Fan"
        frame = Box(30, 30, 5)
        frame.label = "frame"
        PARTS = [frame, Pos(0, 0, 10) * rotor.PARTS[0]]
        NAMES = ["frame", "hub"]
        MOTIONS = %s
    ''',
}


def build(tmp_path: Path, motions: str):
    root = tmp_path / "build"
    (root / "models").mkdir(parents=True)
    (root / "assets").mkdir()
    (root / "exports").mkdir()
    for name, src in MODELS.items():
        src = src % motions if name == "fan" else src
        (root / "models" / f"{name}.py").write_text(textwrap.dedent(src).lstrip())
    env = {**os.environ, "REDLINE_BUILD_CACHE": "off"}
    env.pop("REDLINE_IMPORT_ONLY", None)
    out = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), "fan",
         "--models-dir", str(root / "models"), "--assets-dir", str(root / "assets")],
        cwd=root, env=env, capture_output=True, text=True, timeout=300)
    return out, root / "assets" / "fan.json"


def test_the_build_puts_the_motions_in_the_payload_and_not_the_imports(tmp_path):
    pytest.importorskip("build123d")
    out, payload = build(tmp_path, '{"Spin": {"part": "Rotor/hub", "spin": 1200, '
                                   '"axis": (0, 0, 1), "pivot": (0, 0, 10)}}')
    assert out.returncode == 0, out.stdout + out.stderr
    got = json.loads(payload.read_text())["motions"]
    # The rotor's own "Own" stayed in the rotor: only the fan's are here.
    assert [m["name"] for m in got] == ["Spin"]
    assert got[0]["parts"] == ["/Fan/Rotor/hub"] and math.isclose(got[0]["rpm"], 1200)


def test_a_wrong_path_stops_the_build_and_says_why(tmp_path):
    pytest.importorskip("build123d")
    out, payload = build(tmp_path, '{"Spin": {"part": "Rotor/hubb", "spin": 1200, '
                                   '"axis": (0, 0, 1), "pivot": (0, 0, 10)}}')
    assert out.returncode != 0 and not payload.exists()
    assert "no part 'Rotor/hubb' in the tree; did you mean '/Fan/Rotor/hub'" in out.stdout + out.stderr


def test_a_model_without_motions_has_an_empty_list(tmp_path):
    pytest.importorskip("build123d")
    out, payload = build(tmp_path, "None")
    assert out.returncode == 0, out.stdout + out.stderr
    assert json.loads(payload.read_text())["motions"] == []
