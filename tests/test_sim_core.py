"""The virtual board's core: messages, part blocks, SSD1306, runtime, sim.json from a netlist."""

from __future__ import annotations

import asyncio
import base64

import pytest

from backend.sim import board as simboard
from backend.sim.messages import validate
from backend.sim.parts import load_catalog, make_part
from backend.sim.runtime import Board
from backend.sim.ssd1306 import SSD1306

CATALOG = load_catalog()


def part(model: str, **entry):
    out = []
    p = make_part("X1", {**CATALOG["models"][model], **entry}, out.append)
    return p, out


def i2c(write: str, read: int = 0, addr: int = 60, id: int = 1, **kw):
    return {"type": "i2c", "id": id, "bus": "I2C0", "addr": addr, "write": write, "read": read, **kw}


# -- messages ------------------------------------------------------------------

@pytest.mark.parametrize("msg", [
    {"type": "pwm", "t": 120400, "pin": "GPIO18", "duty": 0.6, "hz": 25000},
    {"type": "pin", "pin": "GPIO0", "level": 0},
    {"type": "i2c", "t": 130000, "id": 7, "bus": "I2C0", "addr": 60, "write": "00af", "read": 0},
    {"type": "reply", "id": 7, "data": "", "ack": True},
    {"type": "freq", "pin": "GPIO19", "hz": 40},
    {"type": "adc", "pin": "GPIO34", "volts": 1.2},
    {"type": "spi", "id": 2, "bus": "SPI2", "cs": "GPIO5", "write": "9f", "read": 3},
    {"type": "uart", "port": "UART0", "data": "hi\n", "extra": "ignored"},
])
def test_valid_messages(msg):
    assert validate(msg) == []


@pytest.mark.parametrize("msg, word", [
    ({"type": "pin", "pin": "GPIO0", "level": 2}, "level"),
    ({"type": "pwm", "pin": "GPIO1", "duty": 1.5, "hz": 1}, "duty"),
    ({"type": "i2c", "id": 1, "bus": "I2C0", "addr": 200, "write": "", "read": 0}, "addr"),
    ({"type": "i2c", "id": 1, "bus": "I2C0", "addr": 60, "write": "0g", "read": 0}, "write"),
    ({"type": "reply", "id": 1, "data": "00"}, "ack"),
    ({"type": "pin", "pin": "GPIO0", "level": True}, "level"),
    ({"type": "teleport"}, "unknown"),
])
def test_invalid_messages(msg, word):
    errors = validate(msg)
    assert errors and word in " ".join(errors)


# -- blocks --------------------------------------------------------------------

def test_light_pin_pwm_and_active_low():
    led, _ = part("led", pins={"A": "GPIO2"})
    led.on({"type": "pin", "pin": "GPIO2", "level": 1})
    assert led.view() == {"glow": 1.0}
    led.on({"type": "pwm", "pin": "GPIO2", "duty": 0.25, "hz": 5000})
    assert led.view() == {"glow": 0.25}
    low, _ = part("led", pins={"K": "GPIO4"})            # wired on the cathode
    low.on({"type": "pin", "pin": "GPIO4", "level": 0})
    assert low.view() == {"glow": 1.0}
    opt, _ = part("led", pins={"A": "GPIO4"}, active="low")
    opt.on({"type": "pwm", "pin": "GPIO4", "duty": 0.25, "hz": 1})
    assert opt.view() == {"glow": 0.75}


def test_press_pull_up_and_down():
    btn, out = part("button", pins={"1": "GPIO0"})
    assert out == [{"type": "pin", "pin": "GPIO0", "level": 1}]
    btn.act({"press": True})
    btn.act({"press": True})                              # no change, no message
    btn.act({"press": False})
    assert [m["level"] for m in out] == [1, 0, 1]
    down, out = part("button", pins={"1": "GPIO5"}, pull="down")
    down.act({"press": True})
    assert [m["level"] for m in out] == [0, 1]


def test_level_maps_to_volts():
    pot, out = part("potentiometer", pins={"W": "GPIO34"})
    assert out[-1] == {"type": "adc", "pin": "GPIO34", "volts": 1.65}
    pot.act({"value": 100})
    pot.act({"value": 500})                               # clamped
    assert out[-1]["volts"] == 3.3 and pot.view()["value"] == 100


def test_motor_lag_and_tach():
    fan, out = part("fan", pins={"pwm": "GPIO18", "tach": "GPIO19"})
    fan.tick(0)
    assert out == [{"type": "freq", "pin": "GPIO19", "hz": 0.0}]
    fan.on({"type": "pwm", "pin": "GPIO18", "duty": 0.5, "hz": 25000})
    fan.tick(500_000)                                     # one tau: 63 %
    assert fan.view()["rpm"] == round(1500 * (1 - 2.718281828 ** -1))
    n = len(out)
    fan.tick(500_001)                                     # moved by less than 1 rpm: quiet
    assert len(out) == n
    fan.tick(20_000_000)
    assert fan.view()["rpm"] == 1500 and out[-1]["hz"] == 50.0
    fan.on({"type": "pin", "pin": "GPIO18", "level": 0})
    fan.tick(60_000_000)
    assert out[-1]["hz"] == 0.0


def test_regs_tmp102():
    tmp, _ = part("tmp102")
    assert tmp.on(i2c("00", 2, addr=72, id=3)) == {"type": "reply", "id": 3, "data": "1900", "ack": True}
    tmp.act({"temperature": -25})
    assert tmp.on(i2c("", 2, addr=72))["data"] == "e700"   # pointer kept from the last write
    tmp.act({"value": 30})
    assert tmp.on(i2c("", 2, addr=72))["data"] == "1e00"
    assert tmp.on(i2c("01", 2, addr=72))["data"] == "60a0"
    tmp.on(i2c("016180", addr=72))                          # write the config register
    assert tmp.on(i2c("01", 4, addr=72))["data"] == "61804b00"   # then walks to T low
    assert tmp.on(i2c("09", 2, addr=72))["data"] == "0000"       # unknown registers read 0
    tmp.act({"temperature": 1000})
    assert tmp.view()["sliders"]["temperature"]["value"] == 125


def test_screen_packs_rows_msb_first():
    s = make_part("S", {"block": "screen", "width": 10, "height": 2}, lambda m: None)
    s.set(0, 0, 1)
    s.set(9, 1, 1)
    v = s.view()["screen"]
    assert (v["w"], v["h"]) == (10, 2)
    assert base64.b64decode(v["bits"]) == bytes([0x80, 0x00, 0x00, 0x40])


# -- SSD1306 -------------------------------------------------------------------

INIT = "00" + "ae d5 80 a8 3f d3 00 40 8d 14 20 00 a1 c8 da 12 81 cf d9 f1 db 40 a4 a6 2e af".replace(" ", "")


def lit(oled) -> set:
    v = oled.view()["screen"]
    bits = base64.b64decode(v["bits"])
    return {(x, y) for y in range(v["h"]) for x in range(v["w"])
            if bits[y * 16 + x // 8] >> (7 - x % 8) & 1}


@pytest.fixture
def oled():
    o = SSD1306("OLED1", CATALOG["models"]["ssd1306"], lambda m: None)
    assert o.on(i2c(INIT))["ack"]
    o.on(i2c("00" + "21007f" + "220007"))
    o.on(i2c("40" + "ff0180"))
    return o


def test_ssd1306_horizontal(oled):
    assert lit(oled) == {(0, y) for y in range(8)} | {(1, 0), (2, 7)}
    assert oled.view()["screen"]["on"] is True


def test_ssd1306_horizontal_wrap_in_window(oled):
    oled.on(i2c("00" + "21" + "7e7f" + "22" + "0203"))
    oled.on(i2c("40" + "01010101" + "01"))                 # 5th byte wraps back to (126, page 2)
    assert {(126, 16), (127, 16), (126, 24), (127, 24)} <= lit(oled)
    assert oled.ram[2][126] == 1 and (oled.col, oled.page) == (127, 2)


def test_ssd1306_vertical(oled):
    oled.on(i2c("00" + "2001" + "211011" + "220001"))
    oled.on(i2c("40" + "01010101"))
    assert {(16, 0), (16, 8), (17, 0), (17, 8)} <= lit(oled)


def test_ssd1306_page_mode_and_co_bit(oled):
    # Co=1: one byte per control byte - page 7, column 5, then one data byte
    oled.on(i2c("80" + "20" + "80" + "02" + "80b7" + "8005" + "8010" + "c001"))
    assert (5, 56) in lit(oled)
    oled.on(i2c("00" + "b3" + "00" + "17"))                  # page 3, column start 0x70
    oled.on(i2c("40" + "80" * 16 + "01"))                    # 0x70..0x7f, then back to 0x70
    assert (0x7F, 31) in lit(oled) and (0x70, 24) in lit(oled) and (0x70, 31) not in lit(oled)
    assert oled.page == 3


def test_ssd1306_invert_off_remap(oled):
    oled.on(i2c("00a7"))
    assert (1, 0) not in lit(oled) and (5, 5) in lit(oled)
    oled.on(i2c("00a6" + "a0"))                              # segment remap off: mirrored
    assert (126, 0) in lit(oled) and (1, 0) not in lit(oled)
    oled.on(i2c("00a1" + "c0"))                              # COM scan normal: flipped
    assert (1, 63) in lit(oled)
    oled.on(i2c("00a5"))
    assert len(lit(oled)) == 128 * 64
    oled.on(i2c("00ae"))
    assert lit(oled) == set() and oled.view()["screen"]["on"] is False


def test_ssd1306_args_across_transactions_and_scroll(oled):
    oled.on(i2c("0081"))
    oled.on(i2c("0010"))                                    # the contrast byte, not a column
    assert oled.contrast == 0x10
    oled.on(i2c("00" + "26" + "0000070700ff" + "2f" + "2e" + "a3" + "0040" + "ae"))
    assert oled.on_ is False                                # the scroll arguments were eaten
    oled.on(i2c("00" + "d301" + "af"))                      # offset 1: row 1 shows up top
    assert (2, 6) in lit(oled)


# -- runtime -------------------------------------------------------------------

SIM = {"mcu": {"part": "C701342", "family": "esp32", "emulator": "qemu-esp32"},
       "parts": [{"ref": "LED2", "model": "led", "pins": {"A": "GPIO2"}},
                 {"ref": "SW1", "model": "button", "pins": {"1": "GPIO0"}},
                 {"ref": "J1", "model": "fan", "pins": {"pwm": "GPIO18", "tach": "GPIO19"}},
                 {"ref": "U3", "model": "tmp102", "bus": "I2C0", "addr": 72},
                 {"ref": "OLED", "model": "ssd1306", "bus": "I2C0", "addr": 60}]}


def test_runtime_routes_and_replies():
    b = Board(SIM, CATALOG)
    assert b.drain() == [{"type": "pin", "pin": "GPIO0", "level": 1}]
    b.handle({"type": "pin", "t": 10, "pin": "GPIO2", "level": 1})
    b.handle(i2c("00", 2, addr=72, id=9, t=20))
    b.handle(i2c("", 2, addr=0x50, id=10, t=30))
    b.handle(i2c("00af", 0, addr=60, id=11, t=40))
    out = b.drain()
    replies = {m["id"]: m for m in out if m["type"] == "reply"}
    assert replies[9] == {"type": "reply", "id": 9, "data": "1900", "ack": True}
    assert replies[10] == {"type": "reply", "id": 10, "data": "ffff", "ack": False}
    assert replies[11]["ack"] is True
    b.act("SW1", {"press": True})
    assert b.drain() == [{"type": "pin", "pin": "GPIO0", "level": 0}]
    b.handle({"type": "uart", "t": 50, "port": "UART0", "data": "boot\n"})
    b.handle({"type": "bogus", "t": 60})                   # dropped
    b.write_uart("UART0", "help\n")
    snap = b.snapshot()
    assert snap["t"] == 50 and snap["parts"]["LED2"] == {"glow": 1.0}
    assert snap["parts"]["OLED"]["screen"]["on"] is True
    assert [u["dir"] for u in snap["uart"]] == ["out", "in"]
    b.handle({"type": "pwm", "t": 100, "pin": "GPIO18", "duty": 1.0, "hz": 25000})
    b.handle({"type": "pin", "t": 10_000_000, "pin": "GPIO2", "level": 0})
    assert b.snapshot()["parts"]["J1"]["rpm"] == 3000
    assert [m for m in b.drain() if m["type"] == "freq"][-1]["hz"] == 100.0


def test_runtime_run_pumps_adapter():
    class Fake:
        name = "fake"

        def __init__(self):
            self.sent, self.started, self.stopped = [], None, False

        async def start(self, firmware, board):
            self.started = (firmware, board["mcu"]["family"])

        async def events(self):
            yield i2c("00", 2, addr=72, id=1, t=5)
            yield i2c("", 1, addr=0x11, id=2, t=6)

        async def send(self, msg):
            self.sent.append(msg)

        async def stop(self):
            self.stopped = True

    a = Fake()
    asyncio.run(Board(SIM, CATALOG).run(a, "fw.bin"))
    assert a.started == ("fw.bin", "esp32") and a.stopped
    assert a.sent[0] == {"type": "pin", "pin": "GPIO0", "level": 1}
    assert [(m["id"], m["ack"]) for m in a.sent if m["type"] == "reply"] == [(1, True), (2, False)]


# -- sim.json from a netlist ---------------------------------------------------

GRAPH = {
    "components": [
        {"ref": "U1", "value": "ESP32-WROOM-32E", "footprint": "WIRELM-SMD_ESP32-WROOM-32E",
         "part": "C701342", "where": "main.ato:App::mcu"},
        {"ref": "R1", "value": "330", "footprint": "R0603", "part": "C23138"},
        {"ref": "LED1", "value": "red", "footprint": "LED0603-RD", "part": "C2286"},
        {"ref": "R2", "value": "10k", "footprint": "R0603", "part": "C25804"},
        {"ref": "SW1", "value": "TS-1187A", "footprint": "SW-SMD_4P-L5.1-W5.1-P3.70", "part": "C318884"},
        {"ref": "OLED1", "value": "OLED 0.96", "footprint": "PinHeader_1x04_P2.54mm", "part": ""},
        {"ref": "U9", "value": "XYZ123", "footprint": "SOT-23-5", "part": "C12345"},
    ],
    "nets": [
        {"name": "gnd", "code": "1", "nodes": [{"ref": "U1", "pin": "1"}, {"ref": "LED1", "pin": "1"},
                                               {"ref": "SW1", "pin": "3"}, {"ref": "SW1", "pin": "4"},
                                               {"ref": "OLED1", "pin": "1"}, {"ref": "U9", "pin": "2"}]},
        {"name": "3v3", "code": "2", "nodes": [{"ref": "U1", "pin": "2"}, {"ref": "R2", "pin": "2"},
                                               {"ref": "OLED1", "pin": "2"}, {"ref": "U9", "pin": "1"}]},
        {"name": "led_drive", "code": "3", "nodes": [{"ref": "U1", "pin": "24"}, {"ref": "R1", "pin": "1"}]},
        {"name": "led_a", "code": "4", "nodes": [{"ref": "R1", "pin": "2"}, {"ref": "LED1", "pin": "2"}]},
        {"name": "boot", "code": "5", "nodes": [{"ref": "U1", "pin": "25"}, {"ref": "R2", "pin": "1"},
                                                {"ref": "SW1", "pin": "1"}, {"ref": "SW1", "pin": "2"}]},
        {"name": "i2c-sda", "code": "6", "nodes": [{"ref": "U1", "pin": "33"}, {"ref": "OLED1", "pin": "4"}]},
        {"name": "i2c-scl", "code": "7", "nodes": [{"ref": "U1", "pin": "36"}, {"ref": "OLED1", "pin": "3"}]},
    ],
}
PINS = {"1": "GND", "2": "3V3", "24": "GPIO2", "25": "GPIO0", "33": "GPIO21", "36": "GPIO22"}


def test_describe_board():
    sim = simboard.describe(GRAPH, PINS, CATALOG)
    assert sim["mcu"] == {"part": "C701342", "family": "esp32", "emulator": "qemu-esp32"}
    assert sim["parts"] == [
        {"ref": "LED1", "model": "led", "pins": {"A": "GPIO2"}},
        {"ref": "SW1", "model": "button", "pins": {"1": "GPIO0"}},
        {"ref": "OLED1", "model": "ssd1306", "bus": "I2C0", "addr": 60,
         "pins": {"SDA": "GPIO21", "SCL": "GPIO22"}},
    ]
    skipped = {s["ref"]: s["why"] for s in sim["skipped"]}
    assert skipped["U9"] == "no model for C12345"
    assert set(skipped) == {"R1", "R2", "U9"}
    Board(sim, CATALOG)                                     # what it describes, runs


def test_describe_needs_an_mcu():
    with pytest.raises(ValueError):
        simboard.describe({"components": [GRAPH["components"][1]], "nets": []}, {}, CATALOG)


def test_mcu_pin_names(monkeypatch):
    from backend import lcsc

    async def pins(code):
        assert code == "C701342"
        return [{"number": "25", "name": "IO0", "electric": "0"},
                {"number": "3", "name": "EN", "electric": "0"}]
    monkeypatch.setattr(lcsc, "pins", pins)
    assert asyncio.run(simboard.mcu_pin_names(None, "C701342")) == {"25": "GPIO0", "3": "EN"}


def test_time_moves_while_the_firmware_is_quiet(monkeypatch):
    """One PWM write, then silence: the fan still spins up, and its
    tachometer reaches the MCU (the clock in Board.run)."""
    import backend.sim.runtime as rt
    monkeypatch.setattr(rt, "TICK_S", 0.01)
    sent = []

    class Quiet:
        async def start(self, firmware, board): pass
        async def events(self):
            yield {"type": "pwm", "t": 1000, "pin": "GPIO18", "duty": 0.5, "hz": 25000}
            await asyncio.sleep(0.6)
        async def send(self, msg): sent.append(msg)
        async def stop(self): pass

    board = Board({"mcu": {"family": "esp32"}, "parts": [
        {"ref": "FAN", "model": "fan", "pins": {"pwm": "GPIO18", "tach": "GPIO19"}}]})
    asyncio.run(board.run(Quiet(), None))
    assert board.snapshot()["parts"]["FAN"]["rpm"] > 500
    assert any(m["type"] == "freq" and m["pin"] == "GPIO19" and m["hz"] > 10 for m in sent)


def test_encoder_turns_as_quadrature():
    sent = []
    enc = make_part("U1", {**CATALOG["models"]["encoder"], "pins": {"A": "GPIO32", "B": "GPIO33", "S": "GPIO4"}},
                    sent.append)
    assert {(m["pin"], m["level"]) for m in sent} == {("GPIO32", 1), ("GPIO33", 1), ("GPIO4", 1)}
    sent.clear()
    enc.act({"turn": 1})
    for t in range(0, 20000, 1000):
        enc.tick(t)
    states = [(sent[i]["level"], sent[i + 1]["level"]) for i in range(0, len(sent), 2)]
    assert states == [(0, 1), (0, 0), (1, 0), (1, 1)]           # clockwise: A falls first
    enc.act({"press": True})
    assert sent[-1] == {"type": "pin", "pin": "GPIO4", "level": 0}
    assert enc.view() == {"position": 1, "pressed": True}


def test_an_encoder_footprint_is_not_a_button():
    comp = {"ref": "U1", "footprint": "SW-SMD_SIQ-02FVS3_1", "value": "", "part": ""}
    name = next(k for k, m in CATALOG["models"].items() if simboard._matches(comp, m["match"]))
    assert name == "encoder"
    comp = {"ref": "SW1", "footprint": "SW-SMD_TS36CA", "value": "", "part": ""}
    assert next(k for k, m in CATALOG["models"].items() if simboard._matches(comp, m["match"])) == "button"


def test_the_clock_keeps_the_emulators_pace(monkeypatch):
    """An emulator at half speed: between its messages, the parts' time
    moves at half speed too, not at the wall clock's."""
    import time as _time
    import backend.sim.runtime as rt
    monkeypatch.setattr(rt, "TICK_S", 0.01)
    start = _time.monotonic()

    class Slow:
        async def start(self, firmware, board): pass
        async def events(self):
            for i in range(8):                      # 100 ms of wall per 50 ms of virtual time
                await asyncio.sleep(0.1)
                yield {"type": "pwm", "t": 50_000 * (i + 1), "pin": "GPIO18", "duty": 0.5, "hz": 25000}
            await asyncio.sleep(0.5)                 # then silence
        async def send(self, msg): pass
        async def stop(self): pass

    board = Board({"mcu": {"family": "esp32"}, "parts": [
        {"ref": "FAN", "model": "fan", "pins": {"pwm": "GPIO18", "tach": "GPIO19"}}]})
    asyncio.run(board.run(Slow(), None))
    wall_us = (_time.monotonic() - start) * 1e6
    assert 400_000 * 0.9 < board.t < wall_us * 0.75    # ~0.65 s at half pace, well short of the wall's ~1.3 s


def _led_board(other_net):
    return {"components": [
        {"ref": "U2", "footprint": "WIFIM-SMD_ESP32-WROOM-32-N4", "value": "", "part": ""},
        {"ref": "R19", "footprint": "R0603", "value": "", "part": ""},
        {"ref": "LED2", "footprint": "LED0805_RED", "value": "", "part": ""}],
        "nets": [{"name": "LED2", "nodes": [{"ref": "U2", "pin": "11"}, {"ref": "R19", "pin": "2"}]},
                 {"name": "LED2_1", "nodes": [{"ref": "R19", "pin": "1"}, {"ref": "LED2", "pin": "1"}]},
                 {"name": other_net, "nodes": [{"ref": "LED2", "pin": "2"}, {"ref": "C1", "pin": "1"}]}]}


def test_a_led_is_polarised_by_its_wiring_not_its_pad_numbers():
    pins = {"11": "GPIO26"}
    on_ground = simboard.describe(_led_board("GND"), pins, CATALOG)["parts"][0]
    assert on_ground["pins"] == {"A": "GPIO26"} and "dead" not in on_ground        # pad 1 is the anode here
    on_supply = simboard.describe(_led_board("3.3V"), pins, CATALOG)["parts"][0]
    assert on_supply["pins"] == {"K": "GPIO26"}
    floating = simboard.describe(_led_board("LED2_2"), pins, CATALOG)
    assert "cannot light" in floating["parts"][0]["dead"] and floating["warnings"]
    led = make_part("LED2", {**CATALOG["models"]["led"], **floating["parts"][0]}, lambda m: None)
    led.on({"type": "pin", "pin": "GPIO26", "level": 1})
    assert led.view()["glow"] == 0
