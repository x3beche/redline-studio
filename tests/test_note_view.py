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


def test_a_reversed_plane_is_checked_by_its_real_normal():
    # The Clip tab's reverse switch (editor/clip-reverse.ts) negates a
    # plane's normal; the note keeps the real one and the page reads it back.
    v = note_view()
    v["clip"]["planes"][0] = plane([1, 0, 0], 12.5, -12.5)
    v["clip"]["planes"][2] = plane([0, 0, 1], 60.0, -60.0, enabled=False)
    assert render.readback_mismatch(v, readback(v)) == []
    # A page that put the plane back the default way round is caught.
    unturned = readback(v)
    unturned["planes"][0] = {**unturned["planes"][0], "normal": [-1, 0, 0]}
    assert "plane 1 faces" in " ".join(render.readback_mismatch(v, unturned))


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


# ---------------------------------------------------------------- an older note's shape
# Note 20261007-102504-26cf19 was drawn before notes kept their canvas: its
# drawing is 1028x823, and its after shot came out 1200x800 - the same
# camera over another aspect, so the frame moved (lower and further back).

def png(w, h):
    import struct
    import zlib
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * w for _ in range(h))
    chunk = lambda t, d: (struct.pack(">I", len(d)) + t + d
                          + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def test_a_drawings_size_is_read_from_its_png_header():
    assert render.png_size(png(1028, 823)) == (1028, 823)
    assert render.png_size(b"GIF89a....") is None
    assert render.png_size(b"") is None and render.png_size(None) is None


def test_an_older_note_is_shot_in_the_shape_of_its_drawing():
    old = {"states": {"/base/case": [1, 1]}}
    w, h, why = render.shot_size(old, None, None, drawn=(1028, 823))
    assert (w, h) == (1028, 823) and "drawing" in why
    # No view at all (an even older note): the drawing still says it.
    assert render.shot_size(None, None, None, drawn=(1028, 823))[:2] == (1028, 823)
    # A width asked for keeps the drawing's aspect.
    w, h, _ = render.shot_size(old, 1200, None, drawn=(1028, 823))
    assert w == 1200 and abs(w / h - 1028 / 823) < 0.005
    # A small drawing is scaled up the way a small canvas is, same shape.
    w, h, why = render.shot_size(old, None, None, drawn=(380, 300))
    assert w >= 800 and abs(w / h - 380 / 300) < 0.01 and "scaled" in why
    # A drawing from a 2x screen is shot no larger than a canvas would be.
    w, h, _ = render.shot_size(old, None, None, drawn=(2056, 1646))
    assert w <= 2400 and h <= 1600 and abs(w / h - 2056 / 1646) < 0.01
    # The note's own canvas wins over its drawing; --free-aspect over both.
    assert render.shot_size(note_view(), None, None, drawn=(1028, 823))[:2] == (1100, 700)
    assert render.shot_size(old, 1200, 800, free_aspect=True,
                            drawn=(1028, 823)) == (1200, 800, None)
    # Nothing to go on: as before.
    assert render.shot_size(old, None, None, drawn=None) == (1400, 950, None)
    assert render.shot_size(old, None, None, drawn=(10, 10)) == (1400, 950, None)


def test_the_drawings_size_comes_from_the_notes_before_image(monkeypatch):
    seen = {}

    class Resp:
        def __init__(self, data):
            self.data = data

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return self.data

    def opener(req, timeout=None):
        seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
        return Resp(png(1028, 823))

    assert render.drawn_size(RID, {"Authorization": "Bearer t"}, opener) == (1028, 823)
    assert seen["url"].endswith(f"/api/revisions/{RID}/image") and seen["auth"] == "Bearer t"

    def broken(req, timeout=None):
        raise OSError("down")
    assert render.drawn_size(RID, {}, broken) is None


def test_same_camera_same_aspect_same_frame():
    """Why the aspect is all that matters, for both camera types the viewer
    has (three-cad-viewer Camera): a perspective camera's fov (22 deg) is
    vertical and fixed, its zoom is its distance; an orthographic one's
    frustum is fitted to the shorter side and scaled by its zoom. So the
    same position and target over the same aspect frame the same picture
    at any pixel size - and over another aspect, another one."""
    import math

    def frame(ortho, aspect, dist=100.0, zoom=1.0, radius=50.0):
        """Half extents (x, y) of what the camera sees at the target."""
        if ortho:
            # projectSize: the shorter side gets the bounding radius.
            w, h = (radius, radius / aspect) if aspect < 1 else (radius * aspect, radius)
            return w / zoom, h / zoom
        h = dist * math.tan(math.radians(22 / 2))
        return h * aspect, h

    for ortho in (False, True):
        drawn = frame(ortho, 1028 / 823)
        assert frame(ortho, 2056 / 1646) == pytest.approx(drawn)     # same shape, bigger
        assert frame(ortho, 1200 / 800) != pytest.approx(drawn)      # the old fixed size
    # Perspective: the height matches at any aspect, the sides do not - a
    # wider shot shows more to the left and right of the drawing.
    assert frame(False, 1.5)[1] == pytest.approx(frame(False, 1028 / 823)[1])


def test_the_after_shot_no_longer_forces_1200x800_on_an_older_note(monkeypatch, tmp_path):
    import asyncio

    from tools import revisions

    argv = {}

    class Proc:
        returncode = 1

        async def communicate(self):
            return b"stopped here", None

    async def spawn(*a, **kw):
        argv["a"] = a
        return Proc()

    monkeypatch.setattr(revisions.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(revisions.tempfile, "gettempdir", lambda: str(tmp_path))

    class Revs:
        async def find_one(self, *a, **kw):
            return {"_id": RID, "view": {"states": {}}}

    class Db:
        revisions = Revs()

    with pytest.raises(SystemExit):
        asyncio.run(revisions._after_shot(Db(), RID))
    assert "--width" not in argv["a"] and "--height" not in argv["a"]
    with pytest.raises(SystemExit):
        asyncio.run(revisions._after_shot(Db(), RID, 900))
    assert argv["a"][argv["a"].index("--width") + 1] == "900"


# ---------------------------------------------------------------- motions

def test_the_fingerprint_keeps_the_hand_set_motions():
    # The page's viewHash (ocp.ts) for this view, computed in node.
    v = {"v": 2, "tab": "tree", "states": {"/Station/Fan": [1, 1]},
         "motions": {"Tilt": 12.5, "Lid": -3.03125},
         "camera": {"ortho": False, "zoom": 1, "quaternion": [0, 0, 0, 1]}}
    assert render.view_hash(v) == "3cb031fc"
    v["motions"]["Tilt"] = 13.0
    assert render.view_hash(v) != "3cb031fc"


def test_the_render_waits_for_the_notes_tilt_and_a_still_fan():
    v = note_view(motions={"Tilt": 30.0})
    applied = {"model": "m", "view_rev": RID, "view_applied": True,
               "view_hash": render.view_hash(v), "view_error": None}
    ok = readback(v, motions={"Tilt": 30.0}, spin_rest=True)
    assert render.view_state_problem(applied, ok, RID, v) is None
    # The slider is somewhere else.
    off = render.view_state_problem(applied, readback(v, motions={"Tilt": 0.0}, spin_rest=True), RID, v)
    assert off and "Tilt is at 0, not 30" in off
    # The fan is still turning: not the rest pose a picture is taken at.
    spin = render.view_state_problem(applied, readback(v, motions={"Tilt": 30.0}, spin_rest=False), RID, v)
    assert spin and "spinning" in spin
    # A motion this build no longer has is let go, like a part it no longer has.
    assert render.view_state_problem(applied, readback(v, motions={}, spin_rest=True), RID, v) is None
    # A view without motions on a page without any: as before.
    plain = note_view()
    assert render.readback_mismatch(plain, readback(plain)) == []


def test_the_page_keeps_motions_in_the_view_and_puts_them_back():
    """The page's side (ocp.ts / motions.ts / api.ts), read as text: the
    view carries the hand-set values, a note's view puts them back and
    stops the spins, and the readback says both."""
    root = Path(__file__).resolve().parent.parent / "frontend" / "src" / "app"
    ocp = (root / "editor" / "ocp.ts").read_text()
    mot = (root / "editor" / "motions.ts").read_text()
    assert "motions?: Record<string, number>" in (root / "api.ts").read_text()
    assert "this.motions?.captured()" in ocp and "restoreValues(view.motions)" in ocp
    assert "this.motions?.readback()" in ocp
    assert "spin_rest" in mot and "this.playing[s.name] = false" in mot
    # A shot starts no spin.
    assert "this.motions.still = !!this.shot" in ocp
