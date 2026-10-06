"""Passives: values read the way people write them, never another value
stood in for a BOM's, and every two-pin passive drawn with KiCad's own
symbol (passive pins) so ERC does not see two undriven inputs per part."""

from __future__ import annotations

import asyncio
import json

import pytest

from backend import convert, lcsc, schematic


@pytest.mark.parametrize("kind,text,want", [
    ("C", "0.1u", "100n"), ("C", "100n", "100n"), ("C", "100nF", "100n"), ("C", "0u1", "100n"),
    ("C", ".1uF", "100n"), ("C", "18p", "18p"), ("C", "18pf", "18p"), ("C", "18pF", "18p"),
    ("C", "22uF", "22u"), ("C", "22uF/6.3V", "22u"), ("C", "10uF 16V", "10u"),
    ("C", "1000p", "1n"), ("C", "4.7µF", "4.7u"), ("C", "2.2u", "2.2u"),
    ("R", "4k7", "4.7k"), ("R", "4.7K", "4.7k"), ("R", "2R2", "2.2"), ("R", "10K", "10k"),
    ("R", "10 kΩ", "10k"), ("R", "619", "619"), ("R", "619R", "619"), ("R", "42.2k", "42.2k"),
    ("R", "1M", "1M"), ("R", "1meg", "1M"), ("R", "0", "0"), ("R", "0R", "0"), ("R", "100R", "100"),
    ("L", "22uH", "22u"), ("L", "1u", "1u"), ("L", "4.7uH", "4.7u"),
])
def test_values_as_people_write_them(kind, text, want):
    assert lcsc.value_of(kind, text) == want


@pytest.mark.parametrize("kind,text", [
    ("C", "100"),          # pF? uF? not guessed
    ("C", "10k"), ("R", "100n"), ("R", "LED-0805"), ("C", ""), ("C", None), ("X", "10k"),
])
def test_what_cannot_be_read_as_a_value_is_none(kind, text):
    assert lcsc.value_of(kind, text) is None


def test_the_table_is_found_whatever_the_spelling():
    assert lcsc.passive("C", "0.1u", "0603")["lcsc"] == "C1591"
    assert lcsc.passive("C", "0u1", "0603")["lcsc"] == "C1591"
    assert lcsc.passive("C", "100nF", "0603")["lcsc"] == "C1591"
    assert lcsc.passive("R", "4k7", "0603") == lcsc.passive("R", "4.7k", "0603")
    # A value it does not hold is not the nearest one.
    assert lcsc.passive("C", "47n", "0603") is None
    assert lcsc.passive("C", "22u", "0402") is None


def test_the_values_demoboard_needed_are_in_the_table():
    """18 pF crystal caps, 22 uF and 2.2 uF bulk caps and the E96 resistors
    of the DemoBoard import, each checked by exact LCSC part number."""
    want = {("C", "18pF", "0603"): "C92671", ("C", "22uF", "0603"): "C59461",
            ("C", "2.2u", "0603"): "C23630", ("R", "619", "0603"): "C23218",
            ("R", "1.1k", "0603"): "C22764", ("R", "56k", "0603"): "C23206",
            ("R", "5.6k", "0603"): "C23189", ("R", "12k", "0603"): "C22790",
            ("R", "560k", "0603"): "C23203", ("R", "42.2k", "0603"): "C23167",
            ("R", "2.1k", "0603"): "C22902"}
    for (k, v, s), code in want.items():
        assert lcsc.passive(k, v, s)["lcsc"] == code, (k, v, s)


@pytest.mark.parametrize("value,code", [
    ("619", "6190"), ("1.1k", "1101"), ("42.2k", "4222"), ("560k", "5603"), ("10", "100J"),
    ("47", "470J"), ("0", "0000"), ("100", "1000"), ("10k", "1002"), ("1M", "1004"),
    ("2.2", None), ("4.75k", "4751"), ("4.753k", None),
])
def test_uni_royal_spells_the_value(value, code):
    assert lcsc.resistor_code(value) == code


def test_a_resistor_outside_the_table_is_found_by_its_exact_number(monkeypatch):
    asked = []

    async def search(term, limit=20):
        asked.append(term)
        return [{"lcsc": "C99", "mpn": "0603WAF3301T5E", "package": "0603", "stock": 5},
                {"lcsc": "C98", "mpn": "0603WAF3301T5E-X", "package": "0603", "stock": 9}]
    monkeypatch.setattr(lcsc, "search", search)
    got = asyncio.run(lcsc.find_passive("R", "3.3K", "0603"))
    assert got["lcsc"] == "C99" and got["key"] == "R 3.3k 0603"
    # Asked once; the answer is kept.
    assert asyncio.run(lcsc.find_passive("R", "3k3", "0603"))["lcsc"] == "C99"
    assert asked == ["0603WAF3301T5E"]


def test_nothing_exactly_that_is_none(monkeypatch):
    async def search(term, limit=20):
        return [{"lcsc": "C98", "mpn": "0603WAF3302T5E", "package": "0603", "stock": 9}]
    monkeypatch.setattr(lcsc, "search", search)
    assert asyncio.run(lcsc.find_passive("R", "3.3k", "0603")) is None
    assert asyncio.run(lcsc.find_passive("C", "47n", "0603")) is None     # capacitors: not guessed


# ---- the converter ----

def _board(values: dict[str, tuple[str, str]]):
    graph = {"components": [{"ref": r, "value": None, "footprint": fp, "part": None, "where": None}
                            for r, (fp, _v) in values.items()],
             "nets": [{"name": "A", "nodes": [{"ref": r, "pin": "1"} for r in values]},
                      {"name": "B", "nodes": [{"ref": r, "pin": "2"} for r in values]}]}
    pads = []
    for i, r in enumerate(values):
        pads += [{"ref": r, "pin": "1", "x": 0, "y": 3 * i, "type": "SMD"},
                 {"ref": r, "pin": "2", "x": 1.5, "y": 3 * i, "type": "SMD"}]
    bom = {r: {"footprint": fp, "value": v, "part": None} for r, (fp, v) in values.items()}
    table = convert.pad_table(graph, pads)
    fps = {c["ref"]: c["footprint"] for c in graph["components"]}
    return asyncio.run(convert.identify(graph, table, bom, {}, fps))


def test_a_bom_value_is_kept_and_found_never_a_placeholder(monkeypatch):
    async def search(term, limit=20):
        return []
    monkeypatch.setattr(lcsc, "search", search)
    parts, unresolved = _board({"C14": ("C0603", "0.1u"), "C7": ("C0603", "18pf"),
                                "C10": ("C0603", "22uF"), "IS": ("R0603", "619"),
                                "C30": ("C0603", "47nF"), "C31": ("C0603", "100")})
    by = {p.ref: p for p in parts}
    assert by["C14"].lcsc == "C1591" and by["C14"].passive == ("C", "100n", "0603")
    assert by["C7"].lcsc == "C92671" and by["C10"].lcsc == "C59461" and by["IS"].lcsc == "C23218"
    assert all(not p.guessed and p.how == "bom-value" for p in parts)
    # 47 nF is not in the table and capacitors are not guessed at: said, not
    # built as 100 nF. A bare "100" says no unit at all.
    assert set(by) == {"C14", "C7", "C10", "IS"}
    assert any(u.startswith("C30:") and "47n" in u and "--part C30=" in u for u in unresolved)
    assert any(u.startswith("C31:") and "cannot be read" in u for u in unresolved)
    assert not any("placeholder" in p.why for p in parts)


def test_without_a_bom_value_the_placeholder_is_still_marked():
    parts, unresolved = _board({"R1": ("R0603", "")})
    assert not unresolved
    assert parts[0].guessed and parts[0].how == "placeholder"


# ---- the schematic ----

def _comp(pre: str, pins=(("1", "1"), ("2", "2")), value="18pF"):
    shapes = [f"P~show~0^^x^^x^^1~0~0~0~{name}^^1~0~0~0~{num}" for num, name in pins]
    return {"title": "X", "dataStr": {"head": {"c_para": {"pre": pre, "Value": value}},
                                      "shape": shapes}}


@pytest.mark.parametrize("pre,pins,ref,want", [
    ("R?", (("1", "1"), ("2", "2")), "IS", "R"),
    ("C?", (("1", "1"), ("2", "2")), "C7", "C"),
    ("L?", (("1", "1"), ("2", "2")), "L1", "L"),
    ("FB?", (("1", "1"), ("2", "2")), "FB1", "FerriteBead"),
    ("C?", (("1", "+"), ("2", "-")), "C9", "C_Polarized"),
    ("C?", (("1", "-"), ("2", "+")), "C9", None),           # reversed: keeps its own
    ("R?", (("1", "1"), ("2", "2"), ("3", "3")), "RN1", None),   # an array
    ("LED?", (("1", "A"), ("2", "K")), "LED1", None),
    ("U?", (("1", "1"), ("2", "2")), "R5", None),             # the maker says it is a U
    ("", (("1", "1"), ("2", "2")), "R5", "R"),                # no prefix: the designator
])
def test_which_two_pin_parts_get_kicads_symbol(pre, pins, ref, want):
    data = _comp(pre, pins)
    assert schematic.passive_entry(data, lcsc._symbol_pins(data["dataStr"]["shape"]), ref) == want


def test_every_passive_is_drawn_with_a_device_symbol(monkeypatch, tmp_path):
    parts = {"C92671": _comp("C?", value="18pF"), "C7589003": _comp("L?", value="1uH"),
             "C900": _comp("U?", (("1", "VCC"), ("2", "GND")), "CHIP")}

    async def component(code):
        return parts[code]

    async def device():
        return tmp_path / "Device.kicad_sym"
    monkeypatch.setattr(lcsc, "_component", component)
    monkeypatch.setattr(schematic, "_device_library", device)
    graph = {"components": [{"ref": "C7", "part": "C92671"}, {"ref": "L1", "part": "C7589003"},
                            {"ref": "U1", "part": "C900"}, {"ref": "C14", "part": "C1591"}],
             "nets": []}
    plan = asyncio.run(schematic.plan_for(graph, "t"))
    by = {c["ref"]: c for c in plan["components"]}
    assert by["C7"]["symbol"]["kind"] == "kicad" and by["C7"]["symbol"]["entry"] == "C"
    assert by["C7"]["value"] == "18pF"
    assert by["L1"]["symbol"]["entry"] == "L" and by["L1"]["value"] == "1uH"
    assert by["C14"]["symbol"]["entry"] == "C" and by["C14"]["value"] == "100nF"
    assert by["U1"]["symbol"]["kind"] == "easyeda"
