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


class FakeBox:
    def __init__(self, x, y, w, h):
        self._x, self._y, self._w, self._h = [v * 1_000_000 for v in (x, y, w, h)]

    def GetX(self):
        return self._x

    def GetY(self):
        return self._y

    def GetRight(self):
        return self._x + self._w

    def GetBottom(self):
        return self._y + self._h


class FakePad:
    def __init__(self, box):
        self._box = box

    def GetBoundingBox(self):
        return self._box


class FakePart:
    def __init__(self, boxes):
        self._pads = [FakePad(b) for b in boxes]

    def Pads(self):
        return self._pads


class FakeBoard:
    def __init__(self, parts):
        self._parts = parts

    def GetFootprints(self):
        return self._parts


def cutter(place, monkeypatch, bodies):
    monkeypatch.setattr(place, "body_on_board", lambda path, ref: bodies.get(ref))
    # One part, its pads well inside: 4 mm from the left edge, 4 from the right.
    return FakeBoard([FakePart([FakeBox(14.0, 20.0, 20.0, 5.0)])])


def test_the_edge_comes_in_to_the_nearest_body(place, monkeypatch):
    """Two connectors on one edge: the edge stops at the one that reaches
    least far out, and the other is reported as hanging over it."""
    board = cutter(place, monkeypatch, {"J1": (12.0, 20.0, 21.0, 29.0),
                                        "J2": (11.0, 18.0, 31.0, 37.0)})
    bounds, moved, over = place.cut_to_bodies(
        board, "board.kicad_pcb", {"left": ["J1", "J2"]}, (10.0, 19.0, 40.0, 47.0))
    assert round(bounds[0], 3) == 12.0
    assert moved == {"left": 2.0}
    assert over == {"J2": 1.0}


def test_the_edge_never_crowds_a_pad(place, monkeypatch):
    """A body that reaches deep into the board does not drag the edge over
    the copper: the board house's clearance wins, with a hair to spare so
    the rounding to whole nanometres cannot undercut it."""
    board = cutter(place, monkeypatch, {"J1": (20.0, 20.0, 25.0, 29.0)})
    bounds, moved, _ = place.cut_to_bodies(
        board, "b", {"left": ["J1"]}, (10.0, 19.0, 40.0, 47.0), clearance=0.5)
    assert bounds[0] < 14.0 - 0.5 + 1e-9        # clear of the pad at 14.0
    assert round(bounds[0], 3) == 13.45         # 0.5 mm, and 0.05 over


def test_the_edge_only_ever_comes_inwards(place, monkeypatch):
    board = cutter(place, monkeypatch, {"J1": (8.0, 20.0, 21.0, 29.0)})
    bounds, moved, _ = place.cut_to_bodies(
        board, "b", {"left": ["J1"]}, (10.0, 19.0, 40.0, 47.0))
    assert bounds[0] == 10.0 and moved == {}


def test_a_tenth_of_a_millimetre_is_not_worth_moving_for(place, monkeypatch):
    board = cutter(place, monkeypatch, {"J1": (10.05, 20.0, 21.0, 29.0)})
    _, moved, _ = place.cut_to_bodies(
        board, "b", {"left": ["J1"]}, (10.0, 19.0, 40.0, 47.0))
    assert moved == {}


def test_a_part_with_no_shape_leaves_its_edge_alone(place, monkeypatch):
    board = cutter(place, monkeypatch, {})
    bounds, moved, _ = place.cut_to_bodies(
        board, "b", {"right": ["J9"]}, (10.0, 19.0, 40.0, 47.0))
    assert bounds == (10.0, 19.0, 40.0, 47.0) and moved == {}
