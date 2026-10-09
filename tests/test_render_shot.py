"""render.py: the picture is the size asked for, and --camera / --side put
the camera where they say.

2026-10-09: `--camera 0,-400,0,0,0,0` of station_80 came back as part of a
fan blade, in a canvas of 508x589 one run and 2292x1312 the next, both
"asked for 1400x950". The camera numbers were right (world millimetres);
the target was the origin, under the model, and the canvas was whatever the
page's panels left - measured before the viewer had answered the resize,
and fought over by another render on the same DevTools port."""

import math
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import render  # noqa: E402


# ---- the canvas ----

def test_the_cad_page_is_told_the_size_of_the_picture():
    q = parse_qs(urlparse(render.page_url("r1", "p/m", shot=(1400, 950))).query)
    assert q == {"rev": ["r1"], "model": ["p/m"], "shot": ["1400x950"]}
    # Without it the address is what it was.
    assert "shot" not in render.page_url("r1", "p/m")


def test_the_window_holds_the_pinned_canvas_and_stays_out_of_the_phone_layout():
    w, h = render.shot_window(1400, 950)
    assert w >= 1400 + render.TREE_W and h > 950
    assert render.shot_window(300, 200)[0] >= render.MIN_WINDOW_W > 768
    # Where the canvas sits in the shot layout (measured: 315,57): on screen
    # in the window it starts with, so no second resize is needed.
    assert render.window_plan([315, 57, 1400, 950, w, h], 1400, 950, True) is None


def test_a_pinned_canvas_on_screen_is_done():
    assert render.window_plan([315, 57, 1400, 950, 1740, 1070], 1400, 950, True) is None
    assert render.window_plan([315.4, 57.4, 1401, 949, 1740, 1070], 1400, 950, True) is None


def test_a_pinned_canvas_off_screen_gets_room_not_a_difference():
    # The right size, but its right edge is past the window: grow to hold it.
    nw, nh = render.window_plan([315, 57, 1400, 950, 1500, 900], 1400, 950, True)
    assert nw >= 315 + 1400 and nh >= 57 + 950


def test_an_unpinned_canvas_gets_the_difference_once():
    # The board room: the window takes what the canvas lacks - from the
    # window as it is now, so a resize that has landed is not added twice.
    assert render.window_plan([573, 87, 508, 589, 1400, 863], 1400, 950, False) == (2292, 1224)
    assert render.window_plan([573, 87, 1400, 950, 2292, 1224], 1400, 950, False) is None


def test_a_pinned_page_that_did_not_pin_falls_back_to_the_difference():
    # An old page without ?shot: measured like the board room.
    assert render.window_plan([573, 87, 508, 589, 1400, 863], 1400, 950, True) == (2292, 1224)


def test_each_render_has_a_browser_of_its_own():
    assert render.PORT == 0                 # a free port per render, not 9411 for all
    tabs = [{"type": "page", "url": "http://127.0.0.1:4200/?rev=other&shot=1028x690"},
            {"type": "page", "url": "about:blank", "webSocketDebuggerUrl": "ws://mine"}]
    assert render.devtools_page(tabs)["webSocketDebuggerUrl"] == "ws://mine"
    assert render.devtools_page(tabs[:1]) is None


# ---- the camera ----

def test_camera_is_world_coordinates_with_an_optional_target():
    assert render.parse_camera("0,-400,0,0,0,0") == ([0, -400, 0], [0, 0, 0])
    assert render.parse_camera("-22, -400, 60") == ([-22, -400, 60], None)


@pytest.mark.parametrize("bad", ["0,-400", "1,2,3,4", "a,b,c", "nan,0,0", "0,0,inf,0,0,0",
                                 "1,2,3,1,2,3"])
def test_a_camera_that_cannot_look_anywhere_is_refused(bad):
    with pytest.raises(SystemExit):
        render.parse_camera(bad)


def test_camera_js_looks_at_the_middle_when_no_target_is_given():
    js = render.camera_js([0, -400, 60], None)
    assert "const t = null || c" in js
    assert "const p0 = [0, -400, 60]" in js and "setCameraPosition(p0, false" in js
    # Straight down: nudged so the roll is +Y up, not whatever rounding gave.
    assert "1e-3" in render.camera_js([0, 0, 400], [0, 0, 0])


@pytest.mark.parametrize("side", sorted(render.SIDES))
def test_every_side_uses_the_viewers_own_preset(side):
    js = render.side_js(side)
    assert f'presetCamera("{render.SIDES[side]}"' in js
    assert "boundingSphere" in js and "setCameraZoom" in js      # ortho is zoomed to fit


def test_back_is_the_viewers_rear():
    assert render.SIDES["back"] == "rear" and render.SIDES["front"] == "front"


def test_side_framing_fits_the_box():
    """The distance side_js computes, done here for a box seen from the
    front: every corner inside the 22 deg perspective frustum."""
    sx, sy, sz, aspect, margin = 104.7, 67.3, 123.3, 1400 / 950, 1.08
    tv = math.tan(math.radians(11)); th = tv * aspect
    need = 0
    for x in (-sx / 2, sx / 2):
        for z in (-sz / 2, sz / 2):
            for y in (-sy / 2, sy / 2):
                depth = -y                  # towards a camera at -Y
                need = max(need, depth + abs(x) / th, depth + abs(z) / tv)
    d = need * margin
    for x in (-sx / 2, sx / 2):
        for z in (-sz / 2, sz / 2):
            for y in (-sy / 2, sy / 2):
                assert abs(x) / (d + y) <= th and abs(z) / (d + y) <= tv


def test_only_is_one_set_states_not_a_repaint_per_part():
    js = render.only_js("fan")
    assert "v.setStates(out)" in js and "v.setState(" not in js


def test_camera_and_side_together_are_refused(monkeypatch):
    monkeypatch.setattr(render, "find_browser", lambda: pytest.fail("no browser needed"))
    with pytest.raises(SystemExit, match="give one"):
        render.render("model:p/m", Path("/tmp/x.png"), None, None, 1,
                      camera="0,-400,0", side="front")
    with pytest.raises(SystemExit, match="--side is one of"):
        render.render("model:p/m", Path("/tmp/x.png"), None, None, 1, side="sideways")


def test_main_hands_side_on_and_never_writes_it_as_the_after_picture(monkeypatch, tmp_path):
    got = {}

    def fake(revision, path, *a):
        got["side"], got["path"] = a[10], path
        return path

    from backend import compute
    monkeypatch.setattr(render, "render", fake)
    monkeypatch.setattr(compute, "record_sync", lambda *a, **kw: None)
    monkeypatch.setattr(Path, "stat", lambda self: type("S", (), {"st_size": 1})())
    monkeypatch.setattr(sys, "argv", ["render.py", "r1", "--side", "top"])
    render.main()
    assert got["side"] == "top"
    assert got["path"].name.startswith("view-r1-")          # not /tmp/after-r1.png
    monkeypatch.setattr(sys, "argv", ["render.py", "r1"])
    render.main()
    assert got["side"] is None and got["path"].name == "after-r1.png"


def test_the_after_picture_takes_the_background_the_note_was_drawn_on():
    """A dark theme draws on black: the after picture is taken on the same,
    read off the drawing's corners for a note that did not keep it."""
    from io import BytesIO
    from PIL import Image, ImageDraw
    from tools import render
    im = Image.new("RGB", (400, 300), (0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 150, 400, 300), fill=(20, 20, 20))           # a darker bottom, as the gradient
    d.rectangle((0, 0, 30, 30), fill=(255, 0, 0))                # a mark drawn into one corner
    buf = BytesIO()
    im.save(buf, "PNG")
    b = render.corner_backdrop(buf.getvalue())
    assert b["top"] == "rgb(0, 0, 0)" and b["bottom"] == "rgb(20, 20, 20)"
    js = render.backdrop_js(b)
    assert "--view-top" in js and "rgb(0, 0, 0)" in js and "--view-bottom" in js
    assert render.corner_backdrop(b"not a png") is None
