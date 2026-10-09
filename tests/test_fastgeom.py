"""The build's faster geometry queries (backend/fastgeom.py).

What has to hold:

- `is_inside` and `bounding_box` answer exactly what build123d's own do -
  inside, outside, on a face, with a tolerance, optimal or not - for
  solids and compounds;
- one classifier is loaded and one box made per shape, however often it
  is asked;
- a shape moved in place, or whose `wrapped` was replaced, is asked about
  where it is now;
- a box handed out is the caller's: changing it changes nothing kept;
- a kept answer still takes the shape's mesh away, as build123d does;
- what is kept is dropped with its shape;
- the build process (export_model.py) has it installed.
"""

from __future__ import annotations

import gc
import random

import pytest

pytest.importorskip("build123d")

from backend import fastgeom  # noqa: E402


@pytest.fixture
def fast(monkeypatch):
    """fastgeom installed for one test, build123d as it was afterwards."""
    from build123d.topology.shape_core import Shape
    from build123d.topology.three_d import Mixin3D

    monkeypatch.setattr(Mixin3D, "is_inside", Mixin3D.is_inside)
    monkeypatch.setattr(Shape, "bounding_box", Shape.bounding_box)
    monkeypatch.setattr(fastgeom, "_INSTALLED", False)
    monkeypatch.setattr(fastgeom, "_KEPT", {})
    monkeypatch.delenv("REDLINE_FASTGEOM", raising=False)
    original = Mixin3D.is_inside
    fastgeom.install()
    return original


def _plate():
    from build123d import Box, Cylinder, Pos
    plate = Box(60, 40, 10)
    for i in range(5):
        for j in range(3):
            plate -= Pos(-24 + i * 12, -12 + j * 12, 0) * Cylinder(3, 20)
    return plate


def _points(n: int = 400):
    from build123d import Vector
    rnd = random.Random(7)
    pts = [Vector(rnd.uniform(-32, 32), rnd.uniform(-22, 22), rnd.uniform(-6, 6))
           for _ in range(n)]
    # On faces and edges, where "on a face" decides: the top, a hole's
    # wall, a corner.
    pts += [Vector(0, 0, 5), Vector(-24 + 3, -12, 0), Vector(30, 20, 5), Vector(30, 0, 0)]
    return pts


def test_the_same_answers_as_build123d(fast):
    original = fast
    plate = _plate()
    pts = _points()
    want = [original(plate, p) for p in pts]
    got = [plate.is_inside(p) for p in pts]
    assert got == want
    assert 0 < sum(got) < len(got)
    # A tolerance is passed through.
    near = (30.0005, 0, 0)
    assert plate.is_inside(near, 1e-3) == original(plate, near, 1e-3) is True
    assert plate.is_inside(near) == original(plate, near) is False


def test_a_compound_answers_the_same(fast):
    from build123d import Box, Compound, Pos
    original = fast
    two = Compound([Box(10, 10, 10), Pos(30, 0, 0) * Box(10, 10, 10)])
    for p in [(0, 0, 0), (30, 0, 0), (15, 0, 0), (5, 0, 0), (40, 0, 0)]:
        assert two.is_inside(p) == original(two, p)


def test_one_classifier_per_shape(fast):
    plate = _plate()
    plate.is_inside((0, 0, 0))
    (entry,) = fastgeom._KEPT.values()
    loaded = entry[2]["classifier"]
    for p in _points(50):
        plate.is_inside(p)
    assert entry[2]["classifier"] is loaded and len(fastgeom._KEPT) == 1


def test_a_replaced_shape_is_asked_about_its_new_geometry(fast):
    from build123d import Box, Pos
    shape = Box(10, 10, 10)
    assert shape.is_inside((0, 0, 0))
    assert shape.bounding_box().max.X == pytest.approx(5)
    shape.wrapped = (Pos(100, 0, 0) * Box(10, 10, 10)).wrapped
    assert not shape.is_inside((0, 0, 0))
    assert shape.is_inside((100, 0, 0))
    assert shape.bounding_box().max.X == pytest.approx(105)


def test_a_shape_moved_in_place_is_asked_about_where_it_is(fast):
    """`move` changes the TopoDS_Shape it holds, not which one."""
    from build123d import Box, Location
    shape = Box(10, 10, 10)
    wrapped = shape.wrapped
    assert shape.is_inside((0, 0, 0))
    assert shape.bounding_box().min.X == pytest.approx(-5)
    shape.move(Location((50, 0, 0)))
    assert shape.wrapped is wrapped
    assert not shape.is_inside((0, 0, 0))
    assert shape.is_inside((50, 0, 0))
    assert shape.bounding_box().min.X == pytest.approx(45)


def test_boxes_are_the_same_as_build123d(fast):
    from build123d import Box, Cylinder, Pos, Sphere
    from build123d.topology.shape_core import Shape
    original = Shape.bounding_box.__wrapped__
    shapes = [_plate(), Pos(3, 4, 5) * Sphere(7), Cylinder(2, 30).edges()[0], Box(1, 2, 3)]
    for s in shapes:
        for kw in ({}, {"optimal": False}, {"tolerance": 0.1}):
            for _ in range(2):                      # made, then kept
                got, want = s.bounding_box(**kw), original(s, **kw)
                assert (tuple(got.min), tuple(got.max)) == (tuple(want.min), tuple(want.max))
                assert got.diagonal == want.diagonal


def test_one_box_per_shape_and_the_box_is_the_callers(fast, monkeypatch):
    from OCP.BRepBndLib import BRepBndLib
    calls = []
    real = BRepBndLib.AddOptimal_s
    plate = _plate()
    monkeypatch.setattr(BRepBndLib, "AddOptimal_s", lambda *a: (calls.append(1), real(*a))[1])
    first = plate.bounding_box()
    first.wrapped.Enlarge(100)                      # the caller's to change
    for _ in range(20):
        again = plate.bounding_box()
    assert len(calls) == 1
    assert again.max.X == pytest.approx(30)


def test_a_kept_box_still_takes_the_mesh_away(fast):
    """build123d drops a shape's triangulation on every bounding_box(); the
    viewer's tessellation depends on that (AGENTS.md, Tessellation cache)."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopLoc import TopLoc_Location
    from build123d import Box
    box = Box(10, 10, 10)
    box.bounding_box()
    BRepMesh_IncrementalMesh(box.wrapped, 0.1)
    face = box.faces()[0].wrapped
    assert BRep_Tool.Triangulation_s(face, TopLoc_Location()) is not None
    box.bounding_box()
    assert BRep_Tool.Triangulation_s(face, TopLoc_Location()) is None


def test_what_is_kept_goes_with_its_shape(fast):
    from build123d import Box
    shape = Box(10, 10, 10)
    shape.is_inside((0, 0, 0))
    shape.bounding_box()
    assert len(fastgeom._KEPT) == 1
    del shape
    gc.collect()
    assert fastgeom._KEPT == {}


def test_install_twice_wraps_once(fast):
    from build123d.topology.three_d import Mixin3D
    once = Mixin3D.is_inside
    fastgeom.install()
    assert Mixin3D.is_inside is once
    assert Mixin3D.is_inside.__wrapped__ is fast


def test_off_means_off(monkeypatch):
    from build123d.topology.three_d import Mixin3D
    monkeypatch.setattr(Mixin3D, "is_inside", Mixin3D.is_inside)
    monkeypatch.setattr(fastgeom, "_INSTALLED", False)
    monkeypatch.setenv("REDLINE_FASTGEOM", "off")
    before = Mixin3D.is_inside
    fastgeom.install()
    assert Mixin3D.is_inside is before


def test_the_build_installs_it():
    from pathlib import Path
    src = (Path(__file__).resolve().parent.parent / "export_model.py").read_text()
    assert "fastgeom.install()" in src


def test_check_compares_every_answer(monkeypatch):
    from build123d import Box
    from build123d.topology.shape_core import Shape
    from build123d.topology.three_d import Mixin3D
    monkeypatch.setattr(Mixin3D, "is_inside", Mixin3D.is_inside)
    monkeypatch.setattr(Shape, "bounding_box", Shape.bounding_box)
    monkeypatch.setattr(fastgeom, "_INSTALLED", False)
    monkeypatch.setattr(fastgeom, "_KEPT", {})
    monkeypatch.setenv("REDLINE_FASTGEOM", "check")
    fastgeom.install()
    box = Box(10, 10, 10)
    assert box.is_inside((0, 0, 0)) and box.bounding_box().max.X == pytest.approx(5)
    (entry,) = fastgeom._KEPT.values()
    entry[2]["classifier"].Load(Box(1, 1, 1).moved(__import__("build123d").Location((50, 0, 0))).wrapped)
    with pytest.raises(AssertionError, match="is_inside"):
        box.is_inside((0, 0, 0))
