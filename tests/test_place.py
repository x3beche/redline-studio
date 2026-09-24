"""The placer: the same parts come out the same board, every run.

`place.py` runs inside the KiCad container and imports pcbnew, which is not
on this machine. The parts tested here - naming the saved board's items,
and which of the packings a try takes - touch none of it, so a stand-in is
enough to import the module.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent


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


HEAD = """(kicad_pcb
\t(version 20241229)
"""
R1 = """\t(footprint "R_0402"
\t\t(uuid "aaaaaaaa-0000-0000-0000-000000000001")
\t\t(at 1 2)
\t\t(property "Reference" "R1")
\t\t(pad "1" smd rect
\t\t\t(uuid "aaaaaaaa-0000-0000-0000-000000000002")
\t\t)
\t)
"""
C1 = """\t(footprint "C_0402"
\t\t(uuid "bbbbbbbb-0000-0000-0000-000000000001")
\t\t(at 5 2)
\t\t(property "Reference" "C1")
\t)
"""
EDGE = """\t(gr_line
\t\t(start 0 0)
\t\t(end 10 0)
\t\t(uuid "cccccccc-0000-0000-0000-000000000001")
\t)
)
"""
BOARD = HEAD + R1 + C1 + EDGE


def written(tmp_path, text):
    path = tmp_path / "board.kicad_pcb"
    path.write_text(text)
    return path


def test_every_uuid_is_replaced(place, tmp_path):
    path = written(tmp_path, BOARD)
    assert place.steady(str(path), 0) == 4
    after = path.read_text()
    assert "aaaaaaaa-0000" not in after and "cccccccc-0000" not in after
    assert after.count("(uuid ") == 4


def test_the_names_are_the_same_next_time(place, tmp_path):
    """The point of the whole exercise: KiCad writes the footprints in
    uuid order, so a uuid that changes run to run is a board that changes
    run to run - a different DSN, and a different answer from a router
    that is otherwise the same on the same input."""
    one, two = tmp_path / "a", tmp_path / "b"
    one.mkdir()
    two.mkdir()
    first = written(one, BOARD)
    place.steady(str(first), 0)
    # The same board as KiCad would write it a second time: the same parts
    # in the same places, under different random names.
    again = BOARD.replace("aaaaaaaa", "dddddddd").replace("bbbbbbbb", "eeeeeeee")
    second = written(two, again)
    place.steady(str(second), 0)
    assert first.read_text() == second.read_text()


def test_the_salt_moves_them_all(place, tmp_path):
    one, two = tmp_path / "a", tmp_path / "b"
    one.mkdir()
    two.mkdir()
    first, second = written(one, BOARD), written(two, BOARD)
    place.steady(str(first), 0)
    place.steady(str(second), 1)
    assert first.read_text() != second.read_text()


def test_a_name_follows_the_part_not_the_order(place, tmp_path):
    """Swap the two footprints round in the file and each keeps its name.

    Which order KiCad wrote them in last time is exactly what varied, so a
    name that depends on it is no better than a random one."""
    import re

    one, two = tmp_path / "a", tmp_path / "b"
    one.mkdir()
    two.mkdir()
    first = written(one, HEAD + R1 + C1 + EDGE)
    second = written(two, HEAD + C1 + R1 + EDGE)
    place.steady(str(first), 0)
    place.steady(str(second), 0)

    def names(text):
        out = {}
        for block in text.split("\t(footprint ")[1:]:
            ref = re.search(r'\(property "Reference" "([^"]*)"', block)
            uuid = re.search(r'\(uuid "([^"]+)"', block)
            if ref:
                out[ref.group(1)] = uuid.group(1)
        return out

    assert names(first.read_text()) == names(second.read_text())


def test_packings_are_offered_tightest_first(place):
    """`attempt` walks them in order of how much ground they cover, so a
    try that comes up a wire short gets the next-smallest board, not a
    random one."""
    boxes = [(0, 0, 4, 3), (0, 0, 4, 3), (0, 0, 2, 2), (0, 0, 6, 1), (0, 0, 1, 5)]
    areas = []
    for attempt in range(len(place.TRIALS)):
        spots = place.pack(boxes, 0.5, None, attempt)
        w = max(x + b[2] for (x, _), b in zip(spots, boxes))
        h = max(y + b[3] for (_, y), b in zip(spots, boxes))
        areas.append(round(w * h, 3))
    assert areas == sorted(areas)
    assert place.pack(boxes, 0.5, None, 0) == place.pack(boxes, 0.5)


def test_an_attempt_past_the_last_packing_is_the_last_one(place):
    boxes = [(0, 0, 4, 3), (0, 0, 2, 2)]
    last = place.pack(boxes, 0.5, None, len(place.TRIALS) - 1)
    assert place.pack(boxes, 0.5, None, 99) == last
    assert place.pack(boxes, 0.5, None, -3) == place.pack(boxes, 0.5, None, 0)


def test_two_items_that_look_alike_get_two_names(place, tmp_path):
    """Nothing in a board may carry the same name twice, however alike two
    items are. The first of them keeps the plain name, so a board of parts
    that are all different is named exactly as it was before this."""
    import re

    path = written(tmp_path, HEAD + R1 + C1 + EDGE + EDGE.replace("\n)\n", "\n"))
    place.steady(str(path), 0)
    names = re.findall(r'\(uuid "([^"]+)"', path.read_text())
    assert len(names) == len(set(names))
