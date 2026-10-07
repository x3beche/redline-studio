"""A note's after shot shows the view it was drawn on, not only its angle.

What went wrong: the person cut the base assembly open with the clipping
planes, looked at the encoder wheel through the case and drew on it. The
note kept the camera and which parts were shown, so the after shot came
back from the same angle over the uncut model - the outside of the case.
Now the page keeps the whole view (frontend api.ts NoteView, format 2:
clipping, tab, render settings, camera type, canvas), puts it back, and
render.py refuses to shoot until the page says it applied that note's view
and the viewer reads back as the note says.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import render  # noqa: E402

RID = "20261007-120000-abcdef"


def plane(normal, slider, offset, enabled=True, center=(0.0, 0.0, 0.0)):
    return {"normal": list(normal), "slider": slider, "offset": offset,
            "center": list(center), "enabled": enabled}


def note_view(**kw):
    v = {
        "v": 2,
        "states": {"/base/case": [1, 1], "/base/encoder_wheel": [1, 1], "/base/lid": [0, 0]},
        "tab": "clip",
        "clip": {"planes": [plane([-1, 0, 0], 12.5, -12.5),
                            plane([0, -1, 0], 60.0, -60.0, enabled=False),
                            plane([0, 0, -1], 60.0, -60.0, enabled=False)],
                 "intersection": False, "helpers": False, "caps": False, "half": 60.0},
        "render": {"transparent": False, "black_edges": False, "axes": False, "axes0": False,
                   "grid": [False, False, False], "opacity": 0.5, "edge_color": 7368816,
                   "ambient": 1.0, "direct": 1.1, "metalness": 0.3, "roughness": 0.65},
        "zebra": {"count": 11, "opacity": 1.0, "direction": 0, "color_scheme": "blackwhite",
                  "mapping_mode": "reflection"},
        "studio": {"Environment": "studio", "Exposure": 1.0},
        "camera": {"ortho": False, "zoom": 1.0, "quaternion": [0.1, 0.2, 0.3, 0.9]},
        "canvas": {"w": 1100, "h": 700, "aspect": 1.5714},
    }
    v.update(kw)
    return v


def readback(view, **kw):
    """What the page's window.redlineViewReadback() says when it shows `view`."""
    clip = view["clip"]
    rb = {"tab": view["tab"], "half": clip["half"], "intersection": clip["intersection"],
          "caps": clip["caps"], "helpers": clip["helpers"], "ortho": view["camera"]["ortho"],
          "planes": [{"normal": p["normal"],
                      "slider": clip["half"] if not p["enabled"] else p["slider"],
                      "offset": p["offset"]} for p in clip["planes"]]}
    rb.update(kw)
    return rb


# ---------------------------------------------------------------- the schema

def test_the_revision_schema_takes_the_whole_view():
    from backend.main import RevisionIn, _out

    v = note_view()
    body = RevisionIn(comment="the wheel rubs the case here", camera={
        "position": [100, 80, 60], "target": [0, 0, 0], "up": [0, 0, 1]},
        model="iot-fan/assemblies/base", view=v)
    assert body.view == v
    # Through JSON as the page sends it, and back out as the card reads it.
    again = RevisionIn.model_validate_json(json.dumps(body.model_dump()))
    assert again.view == v
    doc = {"_id": RID, "created_at": "2026-10-07T12:00:00Z", "comment": "c",
           "view": again.view}
    assert _out(doc)["view"] == v


def test_an_older_note_with_only_parts_or_no_view_still_goes_in():
    from backend.main import RevisionIn

    old = {"states": {"/base/case": [1, 1]}}
    assert RevisionIn(comment="c", view=old).view == old
    assert RevisionIn(comment="c").view is None


# ---------------------------------------------------------------- the address

def test_the_after_shot_opens_the_note_on_its_own_model():
    q = parse_qs(urlparse(render.page_url(RID, "iot-fan/assemblies/base")).query)
    assert q == {"rev": [RID], "model": ["iot-fan/assemblies/base"]}


# ---------------------------------------------------------------- the fingerprint

def test_the_fingerprint_is_the_pages():
    # Computed by the page's own viewHash (ocp.ts) in node, for this view:
    # ties at the fourth decimal, a negative near zero, non-ASCII, ints.
    v = {"v": 2, "tab": "clip",
         "states": {"/base/case": [1, 1], "/base/wheel ü": [0, 1]},
         "clip": {"planes": [{"normal": [-1, 0, 0], "slider": 12.5, "offset": -3.03125,
                              "center": [1.0, -0.00001, 2], "enabled": True},
                             {"normal": [0, -1, 0], "slider": 60, "offset": 0.0625,
                              "center": [0, 0, 0], "enabled": False}],
                  "intersection": False, "helpers": True, "caps": False, "half": 60},
         "render": {"edge_color": 7368816, "opacity": 0.5, "grid": [False, True, False]},
         "zebra": {"color_scheme": "blackwhite"},
         "camera": {"ortho": False, "zoom": 1.23456789, "quaternion": [0.1, -0.2, 0.3, 0.9]},
         "canvas": {"w": 1100, "h": 700, "aspect": 1.5714}}
    assert render.view_hash(v) == "a087ab18"
    # Key order, and an int stored back as a float, do not change it.
    shuffled = json.loads(json.dumps(v, sort_keys=True))
    shuffled["clip"]["half"] = 60.0
    assert render.view_hash(shuffled) == "a087ab18"
    # A plane moved by a hundredth does.
    shuffled["clip"]["planes"][0]["offset"] = -3.04
    assert render.view_hash(shuffled) != "a087ab18"


# ---------------------------------------------------------------- waiting for it

def test_the_render_waits_until_the_page_applied_this_notes_view():
    v = note_view()
    rb = readback(v)
    applied = {"model": "m", "view_rev": RID, "view_applied": True,
               "view_hash": render.view_hash(v), "view_error": None}
    # The page has loaded the model but not looked the note up yet.
    assert "not applied" in render.view_state_problem(
        {"model": "m", "view_rev": None}, None, RID, v)
    # Another note's view is on screen.
    assert "not applied" in render.view_state_problem(
        {**applied, "view_rev": "20261007-000000-000000"}, rb, RID, v)
    # Studio mode or the clipping still going in.
    assert "still applying" in render.view_state_problem(
        {**applied, "view_applied": False}, rb, RID, v)
    assert render.view_state_problem(applied, rb, RID, v) is None


def test_a_view_the_page_could_not_apply_is_an_error_not_a_wait():
    v = note_view()
    page = {"view_rev": RID, "view_applied": False, "view_hash": render.view_hash(v),
            "view_error": "clipping: plane 1 cuts at 3.000, not -12.500"}
    with pytest.raises(SystemExit, match="could not apply"):
        render.view_state_problem(page, readback(v), RID, v)
    page = {"view_rev": RID, "view_applied": True, "view_hash": "00000000", "view_error": None}
    with pytest.raises(SystemExit, match="not note"):
        render.view_state_problem(page, readback(v), RID, v)


def test_the_viewer_must_read_back_the_cut_where_the_note_had_it():
    v = note_view()
    page = {"view_rev": RID, "view_applied": True, "view_hash": render.view_hash(v)}
    # Clipping lives on the clip tab: on the tree tab nothing is cut.
    assert "tree tab" in render.view_state_problem(page, readback(v, tab="tree"), RID, v)
    moved = readback(v)
    moved["planes"][0] = {**moved["planes"][0], "offset": -10.0}
    assert "plane 1 cuts at -10.000" in render.view_state_problem(page, moved, RID, v)
    shut = readback(v)
    shut["planes"][1] = {**shut["planes"][1], "slider": 5.0, "offset": -5.0}
    assert "plane 2 should be open" in render.view_state_problem(page, shut, RID, v)
    turned = readback(v)
    turned["planes"][2] = {**turned["planes"][2], "normal": [0, 0, 1]}
    assert "plane 3 faces" in render.view_state_problem(page, turned, RID, v)
    assert "orthographic" in render.view_state_problem(page, readback(v, ortho=True), RID, v)
    assert "intersection" in render.view_state_problem(
        page, readback(v, intersection=True), RID, v)


def test_a_rebuilt_model_keeps_the_cut_in_the_same_place():
    # The box grew: the slider that puts the plane at the same world
    # position is another number, and that is what the page reads back.
    v = note_view()
    rb = readback(v, half=80.0)
    rb["planes"][0] = {**rb["planes"][0], "slider": 20.5, "offset": -12.5}
    rb["planes"][1] = {**rb["planes"][1], "slider": 80.0}
    rb["planes"][2] = {**rb["planes"][2], "slider": 80.0}
    assert render.readback_mismatch(v, rb) == []


def test_an_older_note_is_shot_as_before():
    old = {"states": {"/base/case": [1, 1]}}
    assert render.view_format(old) == 1 and render.view_format(None) == 0
    # Nothing to wait for and nothing to check beyond the model.
    assert render.view_state_problem(None, None, RID, old) is None
    assert render.readback_mismatch(old, None) == []
    assert render.shot_size(old, 1200, 800) == (1200, 800, None)
    assert render.shot_size(None, None, None) == (1400, 950, None)


# ---------------------------------------------------------------- the picture's shape

def test_the_picture_has_the_canvas_shape_the_note_was_drawn_in():
    v = note_view()
    w, h, why = render.shot_size(v, None, None)
    assert (w, h) == (1100, 700) and "canvas" in why
    # A width asked for keeps the aspect: the framing depends on it.
    w, h, why = render.shot_size(v, 1200, 800)
    assert (w, h) == (1200, 764) and "aspect" in why
    assert render.shot_size(v, 1400, None)[:2] == (1400, 891)
    # Unless told otherwise.
    assert render.shot_size(v, 1200, 800, free_aspect=True) == (1200, 800, None)
    # A phone's canvas is scaled up to something worth looking at.
    w, h, _ = render.shot_size(note_view(canvas={"w": 380, "h": 300, "aspect": 1.2667}),
                               None, None)
    assert w >= 800 and abs(w / h - 380 / 300) < 0.01
