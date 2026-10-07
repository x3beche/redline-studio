"""Every component a model uses is one node in its 3D tree
(backend/assembly.py, export_model.py).

What has to hold, with the component cache on and off:

- an assembly's parts that came from another model are under one node
  labelled with that model's TITLE, nested as deep as the imports go;
- several copies of one component are "Title xN", each copy its part (or
  "Title i" when a copy is several parts); one copy is just "Title";
- what a component's function returns (`screw.make(10)`) is that
  component's, each call a copy; a boolean keeps the mark of what it cut;
- the model's own solids stay at its top level; a model that uses no
  component is exported flat, as before;
- the marks survive the component cache, and assembly.py is in its key.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from backend import buildcache

REPO = Path(__file__).resolve().parent.parent
pytest.importorskip("build123d")

MODELS = {
    "screw": '''
        from build123d import *
        TITLE = "Screw M3"
        def make(length):
            s = Cylinder(1.5, length)
            s.label = f"screw_{length}"
            return s
        part = make(10)
        PARTS = [part]
        NAMES = ["screw"]
    ''',
    "foot": '''
        from build123d import *
        TITLE = "Foot"
        part = Cylinder(4, 2)
        PARTS = [part]
        NAMES = ["foot"]
    ''',
    "cell": '''
        from build123d import *
        TITLE = "Cell"
        can = Cylinder(9, 65)
        wrap = Pos(30, 0, 0) * Cylinder(9.2, 60)
        plus = Pos(60, 0, 0) * Cylinder(3, 1)
        PARTS = [can, wrap, plus]
        NAMES = ["can", "wrap", "plus"]
    ''',
    "base": '''
        from build123d import *
        import cell, foot, screw
        TITLE = "Base"
        shell = Box(100, 60, 20)
        shell.label = "shell"
        feet = [Pos(x, 0, -12) * foot.part for x in (-40, 40)]
        for i, f in enumerate(feet):
            f.label = f"foot_{i + 1}"
        screws = [Pos(x, 20, 12) * screw.make(8) for x in (-30, 30)]
        cells = [Pos(0, 0, 30) * p for p in cell.PARTS]
        trimmed = Pos(0, -20, 12) * screw.part
        trimmed -= Pos(0, -20, 18) * Box(5, 5, 5)          # cut to fit: still a screw
        PARTS = [shell, *feet, *screws, *cells, trimmed]
        NAMES = ["govde", "ayak_1", "ayak_2", "vida_1", "vida_2", "can", "wrap", "plus", "kisa_vida"]
    ''',
    "station": '''
        from build123d import *
        import base, foot
        TITLE = "Station"
        lift = Pos(0, 0, 50)
        parts = [lift * p for p in base.PARTS]
        names = [f"taban_{n}" for n in base.NAMES]
        stand = Box(10, 10, 10)
        PARTS = [stand, *parts, Pos(200, 0, 0) * foot.part]
        NAMES = ["stand", *names, "loose_foot"]
    ''',
}


def layout(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "build"
    models = root / "models"
    models.mkdir(parents=True)
    (root / "assets").mkdir()
    (root / "exports").mkdir()
    for name, src in MODELS.items():
        (models / f"{name}.py").write_text(textwrap.dedent(src).lstrip())
    return root, models


def export(root: Path, target: str, cache: str):
    env = {**os.environ, "REDLINE_BUILD_CACHE": cache}
    env.pop("REDLINE_IMPORT_ONLY", None)
    out = subprocess.run(
        [sys.executable, str(REPO / "export_model.py"), target,
         "--models-dir", str(root / "models"), "--assets-dir", str(root / "assets")],
        cwd=root, env=env, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stdout + out.stderr
    return json.loads((root / "assets" / f"{target}.json").read_text())


def outline(viewer: dict) -> dict:
    """The tree as {name: subtree}, a leaf as None."""
    def walk(node):
        kids = node.get("parts")
        return {k["name"]: walk(k) for k in kids} if kids else None
    shapes = viewer["data"]["shapes"]
    return {shapes["name"]: walk(shapes)}


BASE = {
    "govde": None,
    "Foot ×2": {"ayak_1": None, "ayak_2": None},
    "Screw M3 ×3": {"vida_1": None, "vida_2": None, "kisa_vida": None},
    "Cell": {"can": None, "wrap": None, "plus": None},
}


@pytest.fixture(params=["cache", "off"])
def cache(request, tmp_path):
    return str(tmp_path / "cache") if request.param == "cache" else "off"


def test_assembly_groups_its_components(tmp_path, cache):
    root, _ = layout(tmp_path)
    got = outline(export(root, "base", cache))
    assert got == {"Base": BASE}


def test_nested_assembly_and_own_parts(tmp_path, cache):
    root, _ = layout(tmp_path)
    viewer = export(root, "station", cache)
    got = outline(viewer)
    assert got == {"Station": {
        "stand": None,
        "Base": {k.replace("ayak", "taban_ayak").replace("vida", "taban_vida")
                 .replace("govde", "taban_govde"): v for k, v in {
            "govde": None,
            "Foot ×2": {"taban_ayak_1": None, "taban_ayak_2": None},
            "Screw M3 ×3": {"taban_vida_1": None, "taban_vida_2": None, "taban_kisa_vida": None},
            "Cell": {"taban_can": None, "taban_wrap": None, "taban_plus": None},
        }.items()},
        "Foot": {"loose_foot": None},
    }}
    # The editor's Part field still gets the model's own part names.
    assert viewer["names"][:2] == ["stand", "taban_govde"] and viewer["names"][-1] == "loose_foot"


def test_second_build_from_the_cache_is_the_same_tree(tmp_path):
    root, _ = layout(tmp_path)
    cache = str(tmp_path / "cache")
    first = outline(export(root, "station", cache))
    second = outline(export(root, "station", cache))
    assert first == second and "Base" in first["Station"]


def test_placement_is_kept(tmp_path):
    """Grouping moves nothing: the parts' boxes are where the flat export
    put them (the station lifts the base 50 mm)."""
    root, _ = layout(tmp_path)
    viewer = export(root, "station", "off")
    assert viewer["data"]["shapes"]["bb"]["zmax"] == pytest.approx(50 + 30 + 65 / 2, abs=0.01)


def test_plain_part_is_flat_as_before(tmp_path):
    root, _ = layout(tmp_path)
    got = outline(export(root, "cell", "off"))
    assert got == {"Group": {"can": None, "wrap": None, "plus": None}}


def test_step_is_an_assembly(tmp_path):
    root, _ = layout(tmp_path)
    export(root, "station", "off")
    step = (root / "exports" / "station.step").read_text(errors="replace")
    assert "'Base'" in step and "'Cell'" in step


def test_tree_logic_directly():
    from build123d import Box, Pos
    from backend import assembly as A

    def part(tag, label):
        b = Box(1, 1, 1)
        if tag:
            setattr(b, A.TAG, tag)
        return b

    own = part((), "own")
    a1 = part((("asm", "PARTS[0]"), ("bolt", "PARTS[0]")), "a")
    a2 = part((("asm", "PARTS[1]"), ("bolt", "PARTS[0]")), "b")
    a3 = part((("asm", "PARTS[2]"),), "c")
    w1 = part((("wheel", "PARTS[0]"),), "w")
    w2 = part((("wheel", "PARTS[1]"),), "w")
    w3 = part((("wheel", "PARTS[0]"),), "w")
    w4 = part((("wheel", "PARTS[1]"),), "w")
    root = A.tree([own, a1, w1, a2, w2, a3, w3, w4],
                  ["own", "a1", "w1", "a2", "w2", "a3", "w3", "w4"], "Top",
                  {"asm": "Assembly", "bolt": "Bolt", "wheel": "Wheel"})

    def shape(n):
        return (n.label, [shape(c) for c in n.children]) if n.children else n.label
    assert shape(root) == ("Top", [
        "own",
        ("Assembly", [("Bolt ×2", ["a1", "a2"]), "a3"]),
        ("Wheel ×2", [("Wheel 1", ["w1", "w2"]), ("Wheel 2", ["w3", "w4"])]),
    ])
    assert A.tree([Box(1, 1, 1)], ["x"], "T") is None


def test_marks_are_in_the_cache_key():
    assert (REPO / "backend" / "assembly.py").exists()
    assert buildcache.FORMAT >= 2
    src = (REPO / "backend" / "buildcache.py").read_text()
    assert 'with_name("assembly.py")' in src
