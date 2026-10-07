"""A board's schematic in sheets: one per MCU, Power, the rest.

The Firmware room opens on an MCU's sheet and reads its pin map, so which
chip is an MCU, which parts go on its sheet, and which nets cross sheets
(global labels) are decided by backend/sheets.py from the parts' LCSC data
and the netlist - tested here without KiCad. The generator's labels are
checked by running it, where the atopile environment is on this machine.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest

from backend import schematic, sheets


def part(ref, *, title="", mpn="", category="", group="", pins=None, value="", part_no=None):
    if pins is None:
        pins = [{"number": "1", "name": ""}, {"number": "2", "name": ""}]
    elif isinstance(pins, int):
        pins = [{"number": str(i), "name": ""} for i in range(1, pins + 1)]
    return {"ref": ref, "part": part_no or f"C{abs(hash(ref)) % 100000}", "title": title, "mpn": mpn,
            "category": category, "group": group, "pins": pins, "value": value}


def named_pins(*names):
    return [{"number": str(i), "name": n} for i, n in enumerate(names, 1)]


def net(name, *nodes):
    return {"name": name, "nodes": [{"ref": r, "pin": str(p)} for r, p in nodes]}


ESP_PINS = named_pins("GND", "3V3", "EN", "IO0", "IO2", "IO4", "TXD0", "RXD0", "IO21", "IO22",
                      "IO25", "IO26", "IO27", "IO32", "IO33", "GND")
STM_PINS = named_pins("VDD", "VSS", "OSC_IN", "OSC_OUT", "NRST", "BOOT0", "PA0", "PA1", "PA2",
                      "PA3", "PA9", "PA10", "PB6", "PB7", "PB8", "PB9")


# ---------------------------------------------------------------- recognising an MCU

def test_an_esp32_module_is_an_mcu_by_its_category_or_name():
    assert sheets.is_mcu(part("U1", title="ESP32-WROOM-32E", category="WiFi Modules"))
    assert sheets.is_mcu(part("U1", title="", mpn="ESP32-WROOM-32E-N8"))
    assert sheets.is_mcu(part("U1", title="ESP32-C3-MINI-1", category="RF Modules"))


def test_rp2040_and_stm32_by_name_atmega_by_category():
    assert sheets.is_mcu(part("U3", title="RP2040", category=""))
    assert sheets.is_mcu(part("U4", mpn="STM32F103C8T6", category=""))
    assert sheets.is_mcu(part("U5", title="ATMEGA328P-AU",
                              category="Microcontroller Units (MCUs/MPUs/SOCs)"))
    for name in ("ATTINY85-20SU", "CH32V003F4P6", "NRF52832-QFAA", "ATSAMD21G18A-AU", "GD32F303CCT6"):
        assert sheets.is_mcu(part("U9", mpn=name)), name


def test_an_unnamed_chip_with_gpio_pins_is_an_mcu_and_others_are_not():
    gpio = named_pins(*[f"PA{i}" for i in range(10)], "VDD", "VSS", "NRST", "PB0", "PB1", "PB2")
    assert sheets.is_mcu(part("U7", title="XYZ123", pins=gpio))
    # a USB-UART bridge, a regulator, a resistor, a header: not MCUs
    assert not sheets.is_mcu(part("U5", title="CH340G", category="USB ICs",
                                  pins=named_pins("GND", "TXD", "RXD", "V3", "UD+", "UD-")))
    assert not sheets.is_mcu(part("U2", title="AMS1117-3.3", category="Linear Voltage Regulators (LDO)"))
    assert not sheets.is_mcu(part("R1", title="0603WAF1002T5E", category="Resistors"))
    assert not sheets.is_mcu(part("J3", title="Header-Male-2.54_2x8", category="Pin Headers", pins=16))
    # an I/O expander has P-pins too, but its category says what it is
    assert not sheets.is_mcu(part("U8", title="MCP23017", category="I/O Expanders", pins=gpio))


def test_rail_names():
    for n in ("GND", "AGND", "3V3", "3.3V", "+5V", "12V", "VBUS", "VCC", "VDD_3V3", "power.3V3", "VBAT"):
        assert sheets.rail_name(n), n
    for n in ("12V_EN", "ESP_EN", "IO0", "L_SDA", "VBUS_DET", "XI"):
        assert not sheets.rail_name(n), n


# ---------------------------------------------------------------- one MCU board

def one_mcu_board():
    parts = [
        part("U1", title="STM32F103C8T6", mpn="STM32F103C8T6", category="", pins=STM_PINS, group="mcu"),
        part("Y1", title="8MHz", category="Crystals", pins=named_pins("1", "2"), group="mcu"),
        part("C1", value="20pF", group="mcu"), part("C2", value="20pF", group="mcu"),
        part("C3", value="100nF", group="mcu"),                 # decoupling, in the MCU's module
        part("R1", value="10kΩ", group="mcu"),                  # NRST pull-up
        part("SW1", title="TS-1187A", category="Tactile Switches", pins=4, group="mcu"),
        part("R2", value="1kΩ", group="mcu"), part("D1", title="LED", category="Light Emitting Diodes (LED)", group="mcu"),
        part("J1", title="Header 1x4", category="Pin Headers", pins=4, group="io"),
        part("R3", value="4.7kΩ", group="io"),                  # I2C pull-up shared with the header
        part("U2", title="AMS1117-3.3", category="Linear Voltage Regulators (LDO)",
             pins=named_pins("GND", "VOUT", "VIN"), group="power"),
        part("C4", value="10uF", group="power"), part("C5", value="10uF", group="power"),
        part("J2", title="USB-C", category="USB Connectors", pins=6, group="power"),
    ]
    nets = [
        net("GND", ("U1", 2), ("C1", 2), ("C2", 2), ("C3", 2), ("SW1", 2), ("D1", 2), ("U2", 1),
            ("C4", 2), ("C5", 2), ("J2", 2), ("J1", 1)),
        net("3V3", ("U1", 1), ("C3", 1), ("R1", 1), ("U2", 2), ("C5", 1), ("R3", 1), ("J1", 2)),
        net("5V", ("U2", 3), ("C4", 1), ("J2", 1)),
        net("OSC_IN", ("U1", 3), ("Y1", 1), ("C1", 1)),
        net("OSC_OUT", ("U1", 4), ("Y1", 2), ("C2", 1)),
        net("NRST", ("U1", 5), ("R1", 2), ("SW1", 1)),
        net("LED", ("U1", 7), ("R2", 1)),
        net("LED_K", ("R2", 2), ("D1", 1)),
        net("SDA", ("U1", 13), ("R3", 2), ("J1", 3)),
        net("SCL", ("U1", 14), ("J1", 4)),
    ]
    return parts, nets


def test_crystal_load_caps_decoupling_and_reset_go_on_the_mcu_sheet():
    got = sheets.split(*one_mcu_board())
    keys = [s["key"] for s in got["sheets"]]
    assert keys == ["mcu-u1", "power", "periph"]
    mcu_sheet = got["sheets"][0]
    assert mcu_sheet["name"] == "U1 · STM32F103C8T6" and mcu_sheet["kind"] == "mcu"
    assert set(mcu_sheet["refs"]) == {"U1", "Y1", "C1", "C2", "C3", "R1", "SW1", "R2", "D1"}
    # the regulator and its caps and the power input on Power, the rest on the third
    assert set(got["sheets"][1]["refs"]) == {"U2", "C4", "C5", "J2"}
    assert set(got["sheets"][2]["refs"]) == {"J1", "R3"}
    # a pull-up that also meets a header is not the MCU's alone
    assert got["assign"]["R3"] == "periph"


def test_nets_on_two_sheets_are_global_the_rest_local():
    got = sheets.split(*one_mcu_board())
    glob = set(got["global_nets"])
    assert {"GND", "3V3", "SDA", "SCL"} <= glob
    # the crystal's, the reset's and the LED's nets stay on the MCU's sheet
    assert not glob & {"OSC_IN", "OSC_OUT", "NRST", "LED", "LED_K", "5V"}


def test_the_mcu_record_maps_every_pin_to_its_net_and_parts():
    got = sheets.split(*one_mcu_board())
    (m,) = got["mcus"]
    assert m["ref"] == "U1" and m["sheet"] == "U1 · STM32F103C8T6" and m["file"] == "mcu-u1.kicad_sch"
    pins = {p["number"]: p for p in m["pins"]}
    assert len(pins) == len(STM_PINS)
    assert pins["3"] == {"number": "3", "name": "OSC_IN", "net": "OSC_IN", "parts": ["C1", "Y1"]}
    assert pins["13"]["net"] == "SDA" and pins["13"]["parts"] == ["J1", "R3"]
    assert pins["8"]["net"] is None and pins["8"]["parts"] == []       # PA1, on nothing


def test_an_esp32_module_with_a_usb_uart_bridge_gets_its_programming_circuit():
    parts = [
        part("U1", title="ESP32-WROOM-32E", category="WiFi Modules", pins=ESP_PINS, group="mcu"),
        part("U5", title="CH340C", category="USB ICs",
             pins=named_pins("GND", "TXD", "RXD", "V3", "UD+", "UD-", "DTR", "RTS", "VCC"), group="usb"),
        part("Q1", title="BC817", category="Bipolar Transistors - BJT", pins=3, group="usb"),
        part("R5", value="10kΩ", group="usb"),
        part("J1", title="USB-C", category="USB Connectors", pins=6, group="usb"),
        part("R9", value="10kΩ", group="mcu"),
    ]
    nets = [
        net("GND", ("U1", 1), ("U5", 1), ("J1", 2)),
        net("3V3", ("U1", 2), ("U5", 9), ("R9", 1)),
        net("ESP_TX", ("U1", 7), ("U5", 3)), net("ESP_RX", ("U1", 8), ("U5", 2)),
        net("DTR", ("U5", 7), ("R5", 1)), net("Q1_B", ("R5", 2), ("Q1", 1)),
        net("IO0", ("U1", 4), ("Q1", 3), ("R9", 2)),
        net("USB_DP", ("U5", 5), ("J1", 3)), net("USB_DN", ("U5", 6), ("J1", 4)),
        net("VBUS", ("J1", 1), ("U5", 4)),
    ]
    got = sheets.split(parts, nets)
    s = got["sheets"][0]
    assert s["name"] == "U1 · ESP32-WROOM-32E"
    assert set(s["refs"]) == {"U1", "U5", "Q1", "R5", "R9"}
    assert got["groups"]["U5"] == "usb-uart" and got["groups"]["R9"] == "mcu"
    assert got["assign"]["J1"] != s["key"]                  # the connector is not drawn on it


def test_two_mcus_two_sheets_each_with_its_own_crystal():
    parts = [
        part("U1", mpn="RP2040", pins=named_pins("IOVDD", "GND", "XIN", "XOUT", "GPIO0", "GPIO1",
                                                    "GPIO2", "GPIO3", "GPIO4", "GPIO5"), group=""),
        part("U2", mpn="ATMEGA328P-AU", pins=named_pins("VCC", "GND", "XTAL1", "XTAL2", "PD0", "PD1",
                                                           "PB0", "PB1", "PC4", "PC5"), group=""),
        part("Y1", title="12MHz", category="Crystals"), part("Y2", title="16MHz", category="Crystals"),
        part("C1", value="15pF"), part("C2", value="15pF"), part("C3", value="22pF"), part("C4", value="22pF"),
        part("C5", value="100nF"), part("C6", value="100nF"),
        part("R1", value="4.7kΩ"),                             # I2C pull-up between the two
    ]
    nets = [
        net("GND", ("U1", 2), ("U2", 2), ("C1", 2), ("C2", 2), ("C3", 2), ("C4", 2), ("C5", 2), ("C6", 2)),
        net("3V3", ("U1", 1), ("C5", 1), ("R1", 1)),
        net("5V", ("U2", 1), ("C6", 1)),
        net("XIN", ("U1", 3), ("Y1", 1), ("C1", 1)), net("XOUT", ("U1", 4), ("Y1", 2), ("C2", 1)),
        net("XTAL1", ("U2", 3), ("Y2", 1), ("C3", 1)), net("XTAL2", ("U2", 4), ("Y2", 2), ("C4", 1)),
        net("SDA", ("U1", 5), ("U2", 9), ("R1", 2)),
    ]
    got = sheets.split(parts, nets)
    by = {s["key"]: s for s in got["sheets"]}
    assert [s["kind"] for s in got["sheets"]][:2] == ["mcu", "mcu"]
    assert set(by["mcu-u1"]["refs"]) == {"U1", "Y1", "C1", "C2", "C5"}
    assert set(by["mcu-u2"]["refs"]) == {"U2", "Y2", "C3", "C4", "C6"}
    assert got["assign"]["R1"] not in ("mcu-u1", "mcu-u2")
    assert [m["ref"] for m in got["mcus"]] == ["U1", "U2"]
    assert by["mcu-u1"]["name"].startswith("U1 · ") and by["mcu-u2"]["name"].startswith("U2 · ")
    assert "SDA" in got["global_nets"] and "XIN" not in got["global_nets"]


def test_a_board_without_an_mcu_is_one_overview_sheet():
    parts = [part("U1", title="NE555", category="Timers", pins=8), part("R1", value="1kΩ"),
             part("C1", value="10nF")]
    nets = [net("GND", ("U1", 1), ("C1", 2)), net("TRIG", ("U1", 2), ("R1", 1), ("C1", 1))]
    got = sheets.split(parts, nets)
    assert got["mcus"] == [] and got["global_nets"] == []
    assert [s["name"] for s in got["sheets"]] == ["Overview"]
    assert got["sheets"][0]["file"] == "board.kicad_sch"
    assert set(got["assign"].values()) == {"overview"}


# ---------------------------------------------------------------- the API's shape

def test_mcus_api_shape(monkeypatch):
    from backend import main as M

    got = sheets.split(*one_mcu_board())
    rec = [{**m, "svg": schematic.sheet_url("b1", m["key"])} for m in got["mcus"]]
    doc = {"_id": "b1", "schematic": {"mcus": rec}}

    class Col:
        async def find_one(self, q, proj=None):
            return doc if q.get("_id") == "b1" else None

    class Db:
        def __getitem__(self, name):
            return Col()

    monkeypatch.setattr(M, "db", lambda: Db())
    out = asyncio.run(M.board_mcus("b1"))
    assert isinstance(out, list) and len(out) == 1
    m = out[0]
    assert {"ref", "part", "sheet", "pins", "svg"} <= set(m)
    assert m["svg"] == "/api/boards/b1/sheets/mcu-u1.svg"
    assert all(set(p) == {"number", "name", "net", "parts"} for p in m["pins"])
    assert asyncio.run(M.board_mcus("b1")) == out
    # a board drawn before sheets, or with no MCU: an empty list
    doc["schematic"] = {"parts": 3}
    assert asyncio.run(M.board_mcus("b1")) == []
    with pytest.raises(Exception):
        asyncio.run(M.board_mcus("nope"))


def test_each_sheet_drawing_is_found_by_its_name(tmp_path):
    for name in ("board.svg", "board-U1 · STM32F103C8T6.svg", "board-Power.svg",
                 "board-Connectors & peripherals.svg"):
        (tmp_path / name).write_text(name)
    split = sheets.split(*one_mcu_board())
    got = schematic.svgs_by_sheet(sorted(tmp_path.glob("*.svg")), split["sheets"])
    assert {k: v.decode() for k, v in got.items()} == {
        "root": "board.svg", "mcu-u1": "board-U1 · STM32F103C8T6.svg",
        "power": "board-Power.svg", "periph": "board-Connectors & peripherals.svg"}


# ---------------------------------------------------------------- the generator

DEVICE = schematic.DEVICE


def _generator():
    from backend import atoenv
    try:
        py, env = atoenv.python("kiutils")
    except atoenv.AtoEnvMissing:
        pytest.skip("no atopile environment here")
    if subprocess.run([*py, "-c", "import kiutils"], env={**os.environ, **env},
                      capture_output=True).returncode != 0:
        pytest.skip("kiutils is not in the atopile environment here")
    if not DEVICE.exists():
        pytest.skip("KiCad's Device library has not been copied out on this machine")
    return py, env


def test_the_generator_draws_a_root_and_sheets_with_global_labels_across(tmp_path):
    py, env = _generator()
    parts, nets = one_mcu_board()
    # Drawn with KiCad's resistor for every part: the labels are what is checked.
    sym = {"kind": "kicad", "lib": str(DEVICE), "entry": "R", "key": "Device_R"}
    two = [p for p in parts if len(p["pins"]) == 2]
    refs = {p["ref"] for p in two}
    nets2 = [{"name": n["name"], "nodes": [x for x in n["nodes"] if x["ref"] in refs and x["pin"] in ("1", "2")]}
             for n in nets]
    split = sheets.split(two + [p for p in parts if p["ref"] == "U1"], nets)
    plan = {"project": "board", "title": "t", "nets": nets2, "out": str(tmp_path / "board.kicad_sch"),
            "sheets": [{k: v for k, v in s.items() if k != "refs"} for s in split["sheets"]],
            "global_nets": split["global_nets"],
            "components": [{"ref": p["ref"], "part": p["part"], "group": split["groups"][p["ref"]],
                            "value": p["value"], "footprint": "", "symbol": sym,
                            "sheet": split["assign"][p["ref"]]} for p in two]}
    # every sheet must hold a part for the drawing; the MCU's sheet has its passives
    plan["sheets"] = [s for s in plan["sheets"] if any(c["sheet"] == s["key"] for c in plan["components"])]
    run = subprocess.run([*py, str(schematic.GENERATOR)], input=json.dumps(plan).encode(),
                         capture_output=True, env={**os.environ, **env}, timeout=120)
    assert run.returncode == 0, run.stdout.decode()[-800:] + run.stderr.decode()[-800:]
    root = (tmp_path / "board.kicad_sch").read_text()
    assert root.count("(sheet ") == len(plan["sheets"])
    assert '"Sheetname" "U1 · STM32F103C8T6"' in root or '"U1 · STM32F103C8T6"' in root
    mcu = (tmp_path / "mcu-u1.kicad_sch").read_text()
    # the crystal's load caps' net is local, ground (on every sheet) global
    assert '(label "OSC_IN"' in mcu and '(global_label "GND"' in mcu
    assert '(global_label "OSC_IN"' not in mcu
    # and every symbol carries the path through its sheet box
    assert root.split("(uuid ", 1)[1].split(")", 1)[0].strip('"') in mcu
