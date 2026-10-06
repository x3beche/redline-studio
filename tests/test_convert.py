"""An imported board written back as atopile (backend/convert.py).

The board here is small and made up, the way an import leaves one: a
netlist from the probe file, pad positions, no BOM. LCSC is not asked -
the one chip's EasyEDA data is written out below.
"""

from __future__ import annotations

import asyncio
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from backend import ato, convert, lcsc


def _pin(number: str, name: str) -> str:
    # An EasyEDA symbol pin: the name is the fourth segment's fifth field,
    # the number the fifth's (backend/lcsc.py _symbol_pins).
    return f"P~show~0^^x^^x^^1~0~0~0~{name}^^1~0~0~0~{number}"


def _pad(number: str, x: float, y: float) -> str:
    # An EasyEDA footprint pad: shape, x, y, w, h, layer, net, number (10 mil).
    return f"PAD~RECT~{x}~{y}~2~2~1~~{number}~0~~0~id"


# A four-pin chip: two pins called GND, a supply, a signal. Its footprint
# puts pad 1 top left and runs round, 1 mm apart.
CHIP = {
    "title": "FAKE-CHIP",
    "dataStr": {"head": {"c_para": {"Manufacturer Part": "FAKE-CHIP", "Manufacturer": "Nobody"}},
                "shape": [_pin("1", "VCC"), _pin("2", "GND"), _pin("3", "OUT"), _pin("4", "GND")]},
    "packageDetail": {"title": "SOT-FAKE-4", "dataStr": {"shape": [
        _pad("1", 4000, 3000), _pad("2", 4000, 3003.937), _pad("3", 4003.937, 3003.937),
        _pad("4", 4003.937, 3000), _pad("5", 4001.97, 3001.97)]}},
}
LED = {
    "title": "FAKE-LED",
    "dataStr": {"head": {"c_para": {"Manufacturer Part": "FAKE-LED"}},
                "shape": [_pin("1", "A"), _pin("2", "K")]},
    "packageDetail": {"title": "LED0805_RED", "dataStr": {"shape": [
        _pad("1", 4000, 3000), _pad("2", 4008.27, 3000)]}},
}


@pytest.fixture
def parts_on_disk(monkeypatch):
    got = {"C900001": CHIP, "C900002": LED}

    async def component(code):
        if code not in got:
            raise LookupError(f"{code}: EasyEDA does not know this part")
        return got[code]

    monkeypatch.setattr(lcsc, "_component", component)


def board():
    """The import: U1 turned 90 degrees at (10, 20), a resistor, a
    capacitor, an LED, and three LEDs' cathodes on a net going nowhere."""
    graph = {
        "components": [{"ref": r, "value": None, "footprint": f, "part": None, "where": None}
                       for r, f in (("U1", "SOT-FAKE-4"), ("R1", "R0603"), ("C1", "C0603"),
                                    ("LED1", "LED0805_RED"), ("LED2", "LED0805_RED"),
                                    ("LED3", "LED0805_RED"))],
        "nets": [
            {"name": "GND", "nodes": [{"ref": "U1", "pin": "2"}, {"ref": "U1", "pin": "4"},
                                      {"ref": "C1", "pin": "2"}, {"ref": "U1", "pin": "5"}]},
            {"name": "3.3V", "nodes": [{"ref": "U1", "pin": "1"}, {"ref": "R1", "pin": "1"},
                                       {"ref": "C1", "pin": "1"}]},
            {"name": "OUT+", "nodes": [{"ref": "U1", "pin": "3"}, {"ref": "R1", "pin": "2"},
                                       {"ref": "LED1", "pin": "1"}]},
            {"name": "LED_K", "nodes": [{"ref": "LED1", "pin": "2"}, {"ref": "LED2", "pin": "2"},
                                        {"ref": "LED3", "pin": "2"}]},
            {"name": "NET_9", "nodes": [{"ref": "LED2", "pin": "1"}]},
            {"name": "NET_10", "nodes": [{"ref": "LED3", "pin": "1"}]},
        ],
    }
    # U1's pads, as the chip's footprint lies turned 90 degrees at (10, 20).
    pads = []
    for num, (x, y) in {"1": (0, 0), "2": (0, -1), "3": (1, -1), "4": (1, 0),
                        "5": (0.5, -0.5)}.items():
        pads.append({"ref": "U1", "pin": num, "x": 10 - y, "y": 20 + x, "type": "SMD"})
    pads += [{"ref": "R1", "pin": "1", "x": 30, "y": 5, "type": "SMD"},
             {"ref": "R1", "pin": "2", "x": 31.5, "y": 5, "type": "SMD"},
             {"ref": "C1", "pin": "1", "x": 30, "y": 9, "type": "SMD"},
             {"ref": "C1", "pin": "2", "x": 31.4, "y": 9, "type": "SMD"}]
    for i, r in enumerate(("LED1", "LED2", "LED3")):
        pads += [{"ref": r, "pin": "1", "x": 40, "y": 5 + 4 * i, "type": "SMD"},
                 {"ref": r, "pin": "2", "x": 42.1, "y": 5 + 4 * i, "type": "SMD"}]
    return graph, pads


def converted(picks=None, bom=None):
    graph, pads = board()
    table = convert.pad_table(graph, pads)
    fps = {c["ref"]: c["footprint"] for c in graph["components"]}
    parts, unresolved = asyncio.run(convert.identify(graph, table, bom or {}, picks or {}, fps))
    return graph, table, parts, unresolved


LEDS = {r: {"lcsc": "C900002", "why": "a red 0805 LED, as the footprint says"}
        for r in ("LED1", "LED2", "LED3")}


# ---- which part each one is ----

def test_passives_come_from_the_table_by_size_and_are_marked_guessed(parts_on_disk):
    _, _, parts, _ = converted({"U1": {"lcsc": "C900001"}, **LEDS})
    r1 = next(p for p in parts if p.ref == "R1")
    assert r1.lcsc == lcsc.passive("R", "10k", "0603")["lcsc"]
    assert r1.guessed and r1.how == "placeholder"
    assert "not known" in r1.why


def test_a_part_nothing_settles_is_unresolved_not_invented(parts_on_disk):
    _, _, parts, unresolved = converted()
    assert {p.ref for p in parts} == {"R1", "C1"}
    assert any(u.startswith("U1:") and "--part U1=" in u for u in unresolved)


def test_a_pick_is_checked_against_the_board_pads(parts_on_disk):
    _, _, parts, _ = converted({"U1": {"lcsc": "C900001"}, **LEDS})
    u1 = next(p for p in parts if p.ref == "U1")
    assert u1.guessed and u1.how == "pick"
    # Turned and moved, the land pattern is the board's to a hair.
    assert u1.land["worst_mm"] < 0.01
    assert u1.land["angle"] in (90.0, 270.0)
    # Pad 5 is on the footprint and not in the symbol: added, and said.
    assert u1.added_pins == ["5"]


def test_the_bom_replaces_the_guesses(parts_on_disk):
    bom = {"R1": {"footprint": "R0603", "value": "1k", "part": None},
           "U1": {"footprint": "SOT-FAKE-4", "value": "FAKE", "part": "C900001"}}
    _, _, parts, unresolved = converted(LEDS, bom)
    by = {p.ref: p for p in parts}
    assert not unresolved
    assert by["U1"].how == "bom" and not by["U1"].guessed
    assert by["R1"].how == "bom-value" and not by["R1"].guessed
    assert by["R1"].lcsc == lcsc.passive("R", "1k", "0603")["lcsc"]
    assert by["C1"].guessed                      # the BOM did not name it


def test_a_bom_csv_is_read_from_the_boards_own_files():
    import io
    import zipfile
    csv = ("Designator,Footprint,Value,LCSC Part\n"
           "\"R1,R2\",R0603,4.7k,C23162\nU1,SOT-FAKE-4,FAKE,C900001\n").encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("BOM_demo.csv", csv)
    rows, name = convert.bom_from(buf.getvalue(), None)
    assert name == "BOM_demo.csv"
    assert rows["R2"]["part"] == "C23162" and rows["U1"]["value"] == "FAKE"
    # One added later wins over what came with the upload.
    later, name = convert.bom_from(buf.getvalue(), b"Designator,LCSC Part\nR1,C25804\n")
    assert later["R1"]["part"] == "C25804" and "added" in name


def test_without_a_footprint_a_passive_is_sized_by_its_pads():
    graph, pads = board()
    for c in graph["components"]:
        c["footprint"] = None
    table = convert.pad_table(graph, pads)
    parts, unresolved = asyncio.run(convert.identify(graph, table, {}, {}, {}))
    by = {p.ref: p for p in parts}
    assert by["R1"].passive == ("R", "10k", "0603")
    assert "pitch" in by["R1"].why
    assert any(u.startswith("LED1:") for u in unresolved)


# ---- the source ----

def test_the_source_keeps_designators_net_names_and_marks_guesses(parts_on_disk):
    graph, table, parts, _ = converted({"U1": {"lcsc": "C900001"}, **LEDS})
    source, info = convert.write("Demo", parts, graph, table, "Gerbers", None)
    assert 'designator = "U1"' in source and 'designator = "LED3"' in source
    assert 'override_net_name = "3.3V"' in source
    assert 'override_net_name = "OUT+"' in source
    assert "GUESSED" in source
    assert info["guessed_count"] == 6
    # Single-pad nets are unconnected pins, not nets.
    assert "NET_9" not in source and sorted(info["open_pins"]) == ["LED2.1", "LED3.1"]


def test_pins_that_share_a_name_are_split_when_the_board_splits_them(parts_on_disk):
    graph, table, parts, _ = converted({"U1": {"lcsc": "C900001"}, **LEDS})
    # Move U1 pad 4 off ground: its two GND pins are now on two nets.
    graph["nets"][0]["nodes"] = [n for n in graph["nets"][0]["nodes"] if n["pin"] != "4"]
    graph["nets"] = [n for n in graph["nets"] if n["name"] != "NET_9"]
    graph["nets"].append({"name": "OTHER", "nodes": [{"ref": "U1", "pin": "4"},
                                                     {"ref": "LED2", "pin": "1"}]})
    source, _ = convert.write("Demo", parts, graph, table, "Gerbers", None)
    assert "signal GND_2 ~ pin 2" in source and "signal GND_4 ~ pin 4" in source


def test_a_star_of_two_pad_parts_is_a_finding_not_a_fix():
    graph, pads = board()
    found = convert.findings(graph, convert.pad_table(graph, pads))
    assert len(found) == 1 and "LED_K" in found[0] and "kept as imported" in found[0]


# ---- the proof ----

def test_the_same_netlist_is_equivalent_whatever_the_names():
    graph, _ = board()
    built = json.loads(json.dumps(graph))
    built["nets"][1]["name"] = "v3v3"
    built["nets"][4]["nodes"] = []               # single pads are not compared
    eq = convert.equivalence(graph, built)
    assert eq["equivalent"]
    assert eq["renamed"] == ["3.3V -> v3v3"]


def test_one_pad_on_the_wrong_net_is_named():
    graph, _ = board()
    built = json.loads(json.dumps(graph))
    built["nets"][2]["nodes"][0]["pin"] = "4"    # U1.4 on OUT+ instead of U1.3
    built["nets"][0]["nodes"] = [n for n in built["nets"][0]["nodes"] if n["pin"] != "4"]
    eq = convert.equivalence(graph, built)
    assert not eq["equivalent"]
    nets = {d.get("net") or d.get("built_net") for d in eq["differences"]}
    assert "OUT+" in nets and "GND" in nets
    gone = next(d for d in eq["differences"] if d.get("net") == "OUT+")
    assert "U1.3" in gone["pads"] and "(open)" in gone["built_as"]


def test_a_missing_part_is_named():
    graph, _ = board()
    built = json.loads(json.dumps(graph))
    built["components"] = built["components"][1:]
    eq = convert.equivalence(graph, built)
    assert not eq["equivalent"] and eq["parts"]["missing"] == ["U1"]


ATO_BIN = Path(ato.ATO)


@pytest.mark.skipif(not ATO_BIN.exists(), reason="atopile is not installed")
def test_the_written_source_builds_into_the_imported_netlist(parts_on_disk, tmp_path):
    """The whole claim: write it, build it with atopile, compare."""
    graph, table, parts, _ = converted({"U1": {"lcsc": "C900001"}, **LEDS})
    source, _ = convert.write("Demo", parts, graph, table, "Gerbers", None)
    (tmp_path / "elec" / "src").mkdir(parents=True)
    (tmp_path / "elec" / "layout").mkdir()
    (tmp_path / "ato.yaml").write_text(ato.PROJECT.format(entry="App"))
    (tmp_path / "elec" / "src" / "main.ato").write_text(source)
    done = subprocess.run([str(ATO_BIN), "--non-interactive", "build"], cwd=tmp_path,
                          capture_output=True, text=True, timeout=600)
    assert done.returncode == 0, done.stdout[-2000:] + source
    built = ato.graph((tmp_path / "build" / "default.net").read_text())
    eq = convert.equivalence(graph, built)
    assert eq["equivalent"], eq
    assert not eq["renamed"], eq["renamed"]         # every name kept, "3.3V" included


# ---- land patterns and outlines ----

def test_land_fit_finds_the_turn_and_measures_the_worst_pad():
    fp = {"1": [(0.0, 0.0)], "2": [(2.0, 0.0)], "3": [(2.0, 1.0)]}
    turn = math.radians(30)
    board_pads = {k: (5 + x * math.cos(turn) - y * math.sin(turn),
                      7 + x * math.sin(turn) + y * math.cos(turn)) for k, ((x, y),) in fp.items()}
    fit = convert.land_fit(fp, board_pads)
    assert fit["worst_mm"] < 1e-6 and fit["angle"] == 30.0
    board_pads["3"] = (board_pads["3"][0] + 0.5, board_pads["3"][1])
    assert convert.land_fit(fp, board_pads)["worst_mm"] > 0.2


GKO = """%FSLAX45Y45*%
%MOMM*%
%ADD10C,0.254*%
G75*
G54D10*
G01X0Y0D02*
G01X5000000Y0D01*
G01X5000000Y2820000D02*
G01X5000000Y0D01*
G01X0Y3000000D02*
G01X3000000Y3000000D01*
G01X2000000Y3000000D02*
G01X4800000Y3000000D01*
G01X0Y12700D02*
G01X0Y3000000D01*
G01X4800000Y3000000D02*
G02X5000000Y2800000I0J-200000D01*
M02*
"""


def test_an_outline_drawn_with_gaps_and_overlaps_comes_out_one_closed_loop(tmp_path):
    from gerbonara import GerberFile
    from backend.imports.gerbers import outline_loops
    path = tmp_path / "outline.gko"
    path.write_text(GKO)
    got = outline_loops(GerberFile.open(path))
    assert got["closed"] and len(got["loops"]) == 1
    assert got["joined_mm"] == pytest.approx(0.2, abs=0.01)   # the right edge's overshoot
    kinds = sorted(next(iter(p)) for p in got["loops"][0])
    assert kinds == ["arc", "line", "line", "line", "line"]
    assert got["box"] == pytest.approx([0, 0, 50, 30])


def test_a_held_board_puts_the_gerber_frame_on_kicads_page():
    # y turns over, the board's top-left corner goes to the margin.
    box = (8.636, 45.974, 104.14, 104.648)
    from backend import kicad
    assert kicad.to_page(box, 8.636, 104.648) == [kicad.MARGIN, kicad.MARGIN]
    x, y = kicad.to_page(box, 104.14, 45.974)
    assert (round(x - kicad.MARGIN, 3), round(y - kicad.MARGIN, 3)) == (95.504, 58.674)


def test_identifiers_keep_the_signs():
    assert convert._ident("BAT+") == "BAT_P"
    assert convert._ident("FAN-") == "FAN_N"
    assert convert._ident("3.3V") == "n3_3V"
    assert convert._ident("signal") == "signal_"


@pytest.mark.skipif(shutil.which("docker") is None, reason="no docker")
def test_place_py_still_parses():
    # The placer runs in the container; here it is only read, to catch a
    # typo before a board run does.
    import ast
    ast.parse((Path(__file__).resolve().parent.parent / "docker" / "place.py").read_text())


# ---- pads the footprint numbers alike ----

SWITCH = {
    "title": "FAKE-SLIDE",
    "dataStr": {"head": {"c_para": {"Manufacturer Part": "FAKE-SLIDE"}},
                "shape": [_pin("1", "1"), _pin("2", "2"), _pin("3", "3"), _pin("4", "4")]},
    # Three contacts, and four mechanical legs that EasyEDA all numbers 4.
    "packageDetail": {"title": "SW-FAKE-SLIDE", "dataStr": {"shape": [
        _pad("1", 4000, 3000), _pad("2", 4003, 3000), _pad("3", 4006, 3000),
        _pad("4", 3997, 2996), _pad("4", 3997, 3004), _pad("4", 4009, 2996),
        _pad("4", 4009, 3004)]}},
}


def _switch_board(leg_net: bool):
    graph, pads = board()
    graph["components"].append({"ref": "SW1", "value": None, "footprint": "SW-FAKE-SLIDE",
                                "part": None, "where": None})
    graph["nets"][1]["nodes"].append({"ref": "SW1", "pin": "1"})     # 3.3V
    graph["nets"][0]["nodes"].append({"ref": "SW1", "pin": "2"})     # GND
    if leg_net:
        graph["nets"][0]["nodes"].append({"ref": "SW1", "pin": "4"})
    for num, x in (("1", 50), ("2", 50.762), ("3", 51.524), ("4", 49.238)):
        pads.append({"ref": "SW1", "pin": num, "x": x, "y": 5, "type": "SMD"})
    return graph, pads


@pytest.mark.parametrize("leg_net", [False, True])
def test_legs_numbered_alike_are_joined_only_where_the_import_joins_them(monkeypatch, leg_net):
    got = {"C900001": CHIP, "C900002": LED, "C900003": SWITCH}

    async def component(code):
        return got[code]
    monkeypatch.setattr(lcsc, "_component", component)
    graph, pads = _switch_board(leg_net)
    table = convert.pad_table(graph, pads)
    fps = {c["ref"]: c["footprint"] for c in graph["components"]}
    parts, unresolved = asyncio.run(convert.identify(
        graph, table, {}, {"U1": {"lcsc": "C900001"}, "SW1": {"lcsc": "C900003"}, **LEDS}, fps))
    assert not unresolved
    source, info = convert.write("Demo", parts, graph, table, "Gerbers", None)
    block = source.split("component FAKE_SLIDE:")[1].split("\ncomponent ")[0].split("\nmodule ")[0]
    assert "signal p1 ~ pin 1" in block and "signal p2 ~ pin 2" in block
    if leg_net:
        # On ground in the import: the four legs are one pin on GND, as drawn.
        assert "signal p4 ~ pin 4" in block
        assert "SW1.4" not in info["open_pins"]
    else:
        # On no net: no signal, so the build leaves every leg on no net -
        # never one net of four pads the router would have to join.
        assert "~ pin 4" not in block and "left unconnected" in block
        assert "SW1.4" in info["open_pins"]
        assert ".p4 ~" not in source
