"""render.py photographs exactly the model it was asked for.

An after shot of iot-fan/parts/button_caps came back of the Base assembly:
the page opened the first model in the catalog, switched to the
revision's, and the poll reloaded Base over it while a linked rebuild was
going on. render.py now names the model in the address, waits out the
model's own build, and refuses to capture when the page says it shows
anything else.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import render  # noqa: E402


def entry(mid, **kw):
    return {"id": mid, "name": mid.rsplit("/", 1)[-1], "data": True, "building": False,
            "stale": False, "built_at": "t1", "link": None, **kw}


def tree(*models, folders=()):
    return {"models": list(models), "folders": list(folders)}


CAT = tree(entry("iot-fan/assemblies/base"),
           folders=[tree(entry("iot-fan/parts/button_caps"), entry("iot-fan/parts/knob")),
                    tree(entry("other/knob"))])


def test_find_by_id_and_by_unique_name():
    assert render.find_entry(CAT, "iot-fan/parts/button_caps")["id"] == "iot-fan/parts/button_caps"
    assert render.find_entry(CAT, "button_caps")["id"] == "iot-fan/parts/button_caps"


def test_an_ambiguous_or_missing_name_is_an_error_not_a_guess():
    with pytest.raises(SystemExit, match="2 models"):
        render.find_entry(CAT, "knob")
    with pytest.raises(SystemExit, match="no model"):
        render.find_entry(CAT, "nope")


def test_the_address_names_the_model_as_well_as_the_revision():
    q = parse_qs(urlparse(render.page_url("20261007-083345-26f7fe", "iot-fan/parts/button_caps")).query)
    assert q == {"rev": ["20261007-083345-26f7fe"], "model": ["iot-fan/parts/button_caps"]}
    q = parse_qs(urlparse(render.page_url(None, "iot-fan/parts/knob")).query)
    assert q == {"model": ["iot-fan/parts/knob"]}


def test_its_own_build_is_waited_for():
    assert render.build_wait(entry("m", building=True)) == "building"
    assert render.build_wait(entry("m", link={"state": "queued"})).startswith("queued")
    assert render.build_wait(entry("m", link={"state": "building"})).startswith("building")
    assert render.build_wait(entry("m", link={"state": "done"})) is None
    assert render.build_wait(entry("m")) is None


def test_nothing_built_or_stale_without_a_build_coming_fails():
    with pytest.raises(SystemExit, match="never been built"):
        render.build_wait(entry("m", data=False))
    with pytest.raises(SystemExit, match="source changed"):
        render.build_wait(entry("m", stale=True))
    assert render.build_wait(entry("m", stale=True), allow_stale=True) is None
    # Stale while building is a wait, not an error.
    assert render.build_wait(entry("m", stale=True, building=True)) == "building"


def test_wait_built_polls_until_done_and_gives_up_loudly():
    states = iter([True, True, False])
    fetch = lambda: tree(entry("m", building=next(states), built_at="t2"))  # noqa: E731
    assert render.wait_built(fetch, "m", 60, sleep=lambda s: None)["built_at"] == "t2"

    now = iter(range(0, 1000, 100))
    with pytest.raises(SystemExit, match="still building"):
        render.wait_built(lambda: tree(entry("m", building=True)), "m", 250,
                          sleep=lambda s: None, clock=lambda: next(now))


def view(**kw):
    return {"model": "iot-fan/parts/button_caps", "built_at": "t1", "loading": None,
            "want": "iot-fan/parts/button_caps", "pending": False, "error": None, **kw}


def test_the_page_must_show_the_model_asked_for():
    m = "iot-fan/parts/button_caps"
    assert render.view_problem(view(), m, "t1") is None
    assert "not iot-fan/parts/button_caps" in render.view_problem(
        view(model="iot-fan/assemblies/base"), m, "t1")
    assert "still loading" in render.view_problem(view(loading="iot-fan/assemblies/base"), m, "t1")
    assert "build of t0" in render.view_problem(view(built_at="t0"), m, "t1")
    assert "has not said" in render.view_problem(None, m, "t1")
    assert "looking up" in render.view_problem(view(pending=True, model=None), m, "t1")


def test_a_page_that_cannot_show_it_is_an_error():
    with pytest.raises(SystemExit, match="not built yet"):
        render.view_problem(view(model=None, error="m: not built yet"), "m", "t1")


# ---------------------------------------------------------------- boards

BOARD = {"_id": "demoboard-gerber-zip", "building": False, "stale": False, "link": {},
         "artifacts": {"model3d": {"at": "2026-10-06T20:25:32.264457+00:00"}}}
AT = BOARD["artifacts"]["model3d"]["at"]


def test_a_board_is_found_by_id_only():
    assert render.find_board([BOARD], "demoboard-gerber-zip")["id"] == "demoboard-gerber-zip"
    with pytest.raises(SystemExit, match="no board"):
        render.find_board([BOARD], "fan-stand")


def test_a_board_waits_for_its_own_build_and_needs_a_3d():
    assert render.board_wait(render.find_board([BOARD], BOARD["_id"])) is None
    assert render.board_wait({**BOARD, "id": "b", "building": True}) == "building"
    assert render.board_wait({**BOARD, "id": "b", "link": {"state": "queued"}}).startswith("queued")
    with pytest.raises(SystemExit, match="no 3D"):
        render.board_wait({**BOARD, "id": "b", "artifacts": {}})


def test_the_board_address_opens_the_pcb_room_on_that_board_in_3d():
    q = parse_qs(urlparse(render.board_url("demoboard-gerber-zip")).query)
    assert q == {"ws": ["pcb"], "board": ["demoboard-gerber-zip"], "tab": ["3d"]}


def test_the_pcb_room_must_show_that_boards_current_3d():
    b = "demoboard-gerber-zip"
    ok = {"board": b, "tab": "3d", "error": None}
    glb = render.board_glb(b, AT)
    assert glb == "/api/boards/demoboard-gerber-zip/board.glb?v=2026-10-06T20%3A25%3A32.264457%2B00%3A00"
    assert render.board_problem(ok, glb, b, AT) is None
    assert "not demoboard" in render.board_problem({**ok, "board": "other"}, glb, b, AT)
    assert "layout view" in render.board_problem({**ok, "tab": "layout"}, glb, b, AT)
    assert "still loading" in render.board_problem(ok, None, b, AT)
    assert "shows" in render.board_problem(ok, render.board_glb(b, "old"), b, AT)
    assert "has not said" in render.board_problem(None, glb, b, AT)
    with pytest.raises(SystemExit, match="no such board"):
        render.board_problem({**ok, "board": None, "error": "x: no such board"}, None, b, AT)


def test_each_kind_cuts_its_picture_from_its_own_canvas():
    # The 3D room's viewer stays in the page under every other room: a bare
    # 'canvas' in the PCB room is the 3D-room model.
    assert "app-board-3d" in render.BOARD_CANVAS
    assert render.CAD_CANVAS != "canvas"
    assert render.BOARD_CANVAS in render.unclutter_js(render.BOARD_CANVAS)
