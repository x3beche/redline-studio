"""Faster answers to the questions model code asks over and over - the same
answers, without doing the setup again for every one.

A model checks itself in its own source. "Is this point inside the
shell?", walked in 0.05 mm steps along a few dozen rays, is thousands of
`is_inside` calls on one solid; "which of the board's parts are near this
one?" is a `bounding_box()` of every part, for every part asked about.
build123d works each answer out from nothing: a fresh
BRepClass3d_SolidClassifier per point - and loading one is the expensive
part, a bounding box and an intersection polyhedron for every face of the
shell, while classifying a point against it is cheap - and an optimal box
(BRepBndLib.AddOptimal, ~20 ms on a part read from a STEP) per call. On
the 80 mm enclosure those were three quarters of the build (2026-10-09:
~150 of ~190 s, one core busy and fifteen idle), and a quarter of the
station's.

So the build process (export_model.py) keeps, per shape, the loaded
classifier (OCCT's own Load-once, Perform-many use of the class, which
classifies exactly as a fresh one does) and the boxes it was asked for.
They are kept off the shape itself - the component cache
(backend/buildcache.py) stores a shape's attributes, and a classifier is
nothing it can keep - and dropped with the shape. What they were made
from is checked on every use: a shape moved in place (`move`, `locate`
change the TopoDS_Shape's location without replacing it) or given another
`wrapped` is worked out again.

    REDLINE_FASTGEOM=off       build123d's own, for comparing
    REDLINE_FASTGEOM=check     both, every time: a different answer raises

Stdlib only at import time: build123d is imported by `install()`.
"""

from __future__ import annotations

import os
import weakref

# id(shape) -> (weak ref to the shape, a copy of the TopoDS_Shape the
# answers are for, {what: answer}).
_KEPT: dict[int, tuple] = {}
_INSTALLED = False


def _kept(shape) -> dict | None:
    """What is kept for `shape` as it is now (emptied if it changed since),
    or None when nothing can be kept for it."""
    key = id(shape)
    wrapped = shape._wrapped
    got = _KEPT.get(key)
    if got is not None and got[0]() is shape and got[1].IsEqual(wrapped):
        return got[2]
    try:
        ref = weakref.ref(shape, lambda r, k=key: _forget(k, r))
    except TypeError:
        return None
    # A copy, not the object: an in-place move changes the object, and the
    # copy is how that is seen.
    answers: dict = {}
    _KEPT[key] = (ref, wrapped.Located(wrapped.Location()), answers)
    return answers


def _forget(key: int, ref) -> None:
    got = _KEPT.get(key)
    if got is not None and got[0] is ref:
        del _KEPT[key]


def clear() -> None:
    """Drop everything kept, now. export_model.py calls it when the model
    has run (the questions are asked while it runs): what is made after
    that - the viewer's tessellation, the STEP - and the interpreter's
    teardown go on without classifiers or weak references of ours alive."""
    _KEPT.clear()


def install() -> None:
    """Put what is kept behind build123d's `is_inside` (3D shapes) and
    `bounding_box`. Once per process; a second call does nothing, nor does
    REDLINE_FASTGEOM=off."""
    global _INSTALLED
    if _INSTALLED or os.environ.get("REDLINE_FASTGEOM", "").strip().lower() in ("off", "0", "no"):
        return
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepTools import BRepTools
    from OCP.Bnd import Bnd_Box
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_State
    from build123d.geometry import BoundBox, Vector
    from build123d.topology.shape_core import Shape
    from build123d.topology.three_d import Mixin3D

    original_inside = Mixin3D.is_inside
    original_box = Shape.bounding_box
    inside = TopAbs_State.TopAbs_IN
    check = os.environ.get("REDLINE_FASTGEOM", "").strip().lower() == "check"

    def is_inside(self, point, tolerance: float = 1.0e-6) -> bool:
        kept = _kept(self) if getattr(self, "_wrapped", None) is not None else None
        if kept is None:
            return original_inside(self, point, tolerance)
        classifier = kept.get("classifier")
        if classifier is None:
            classifier = kept["classifier"] = BRepClass3d_SolidClassifier(self._wrapped)
        classifier.Perform(gp_Pnt(*Vector(point)), tolerance)
        return classifier.State() == inside or classifier.IsOnAFace()

    def bounding_box(self, tolerance: float | None = None, optimal: bool = True) -> BoundBox:
        kept = _kept(self) if getattr(self, "_wrapped", None) is not None else None
        if kept is None:
            return original_box(self, tolerance, optimal)
        what = ("box", tolerance, optimal)
        box = kept.get(what)
        if box is None:
            got = original_box(self, tolerance, optimal)
            box = kept[what] = Bnd_Box()          # a copy: `got` is the caller's
            if got.wrapped is not None:
                box.Add(got.wrapped)
            return got
        # As build123d does on every call: the shape's mesh goes (the
        # viewer's tessellation depends on that); the box is the one made.
        BRepTools.Clean_s(self._wrapped)
        fresh = Bnd_Box()
        fresh.Add(box)
        return BoundBox(fresh)

    if check:
        fast_inside, fast_box = is_inside, bounding_box

        def is_inside(self, point, tolerance: float = 1.0e-6) -> bool:
            got, want = fast_inside(self, point, tolerance), original_inside(self, point, tolerance)
            if got != want:
                raise AssertionError(f"fastgeom: is_inside({point}) {got}, build123d {want}")
            return got

        def bounding_box(self, tolerance: float | None = None, optimal: bool = True) -> BoundBox:
            got, want = fast_box(self, tolerance, optimal), original_box(self, tolerance, optimal)
            if (tuple(got.min), tuple(got.max)) != (tuple(want.min), tuple(want.max)):
                raise AssertionError(f"fastgeom: bounding_box {got}, build123d {want}")
            return got

    is_inside.__doc__ = original_inside.__doc__
    is_inside.__wrapped__ = original_inside
    bounding_box.__doc__ = original_box.__doc__
    bounding_box.__wrapped__ = original_box
    Mixin3D.is_inside = is_inside
    Shape.bounding_box = bounding_box
    _INSTALLED = True
