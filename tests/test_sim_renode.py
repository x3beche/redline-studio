"""The Renode (STM32) adapter: session generation and the bridge stream without an
emulator, then the real iot-fan firmware on Renode when Docker and the images are here:
straight through the adapter, through backend.sim.runtime.Board with a fan and a
button, and a bus probe firmware for the i2c/spi/adc proxies."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.sim.adapters import ADAPTERS
from backend.sim.adapters import renode
from backend.sim.adapters.renode import Renode, bus_devices, firmware_kind, session_files, source_dir
from backend.sim.messages import validate
from backend.sim.runtime import Board

IOT_FAN = Path(__file__).resolve().parents[3] / "projects" / "iot-fan" / "firmware"


def test_registered():
    assert ADAPTERS["renode"] is Renode and Renode.name == "renode"


def test_firmware_kind(tmp_path):
    (tmp_path / "fw" / "stm32").mkdir(parents=True)
    (tmp_path / "fw" / "stm32" / "CMakeLists.txt").write_text("project(x C)")
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "app.elf").write_bytes(b"\x7fELF")
    kinds = [firmware_kind(tmp_path / n) for n in ("fw", "fw/stm32", "b", "b/app.elf")]
    assert kinds == ["project", "project", "build", "elf"]
    assert source_dir(tmp_path / "fw") == tmp_path / "fw" / "stm32"
    with pytest.raises(FileNotFoundError):
        firmware_kind(tmp_path)


def test_build_dir_is_stable_and_outside_the_project(tmp_path):
    a = Renode(cache=tmp_path / "cache")
    assert a.build_dir(tmp_path / "fw") == a.build_dir(tmp_path / "fw")
    assert a.build_dir(tmp_path / "fw") != a.build_dir(tmp_path / "other")
    assert (tmp_path / "cache") in a.build_dir(tmp_path / "fw").parents


def test_session_files():
    board = {"mcu": {"family": "stm32f0", "clock_hz": 48_000_000},
             "parts": [{"ref": "U1", "model": "tmp102", "bus": "I2C0", "addr": 72},
                       {"ref": "U2", "model": "flash", "bus": "SPI2", "cs": "PB12"},
                       {"ref": "SW1", "model": "button", "pins": {"1": "PA0"}}]}
    files = session_files("app.elf", 4242, board)
    assert files["machine.repl"].startswith('using "platforms/cpus/stm32f042.repl"')
    assert "systickFrequency: 48000000" in files["machine.repl"]
    assert "timer3:\n    frequency: 48000000" in files["machine.repl"]
    resc = files["session.resc"].splitlines()
    assert "sysbus LoadELF @/fw/app.elf" in resc and resc[-1] == "include @/sim/bridge.py"
    assert "sysbus.cpu PerformanceInMips 48" in resc
    config = json.loads(files["config.json"])
    assert config["port"] == 4242 and config["clock_hz"] == 48_000_000
    # A bus the MCU does not have (I2C0) goes on the first controller, under the board's name.
    assert config["i2c"] == [{"controller": "i2c1", "bus": "I2C0", "addr": 72}]
    assert config["spi"] == [{"controller": "spi2", "bus": "SPI2", "cs": ["PB12"]}]
    assert "systickFrequency: 8000000" in session_files("a.elf", 1, {})["machine.repl"]


def test_bus_devices_share_a_spi_bus():
    _, spi = bus_devices({"parts": [{"ref": "A", "bus": "SPI1", "cs": "PA4"},
                                    {"ref": "B", "bus": "SPI1", "cs": "PA15"}]})
    assert spi == [{"controller": "spi1", "bus": "SPI1", "cs": ["PA4", "PA15"]}]


class _Writer:
    def __init__(self):
        self.data = b""

    def write(self, b):
        self.data += b

    async def drain(self):
        pass

    def close(self):
        pass


def test_bridge_stream():
    async def go():
        a = Renode()
        a._bridge = _Writer()
        r = asyncio.StreamReader()
        r.feed_data(b'{"type":"hello","sim":"redline-renode","t":0}\n'
                    b'{"t":39,"type":"uart","data":"iot-fan ready\\r\\n","port":"USART1"}\n'
                    b'{"hz":25000.0,"duty":0.6,"type":"pwm","t":200000,"pin":"PA6"}\n'
                    b'{"write":"01","t":0,"read":2,"bus":"I2C1","id":1,"type":"i2c","addr":72}\n')
        r.feed_eof()
        await a._read_bridge(r)
        assert a._booted.is_set()
        got = [m async for m in a.events()]
        assert [m["type"] for m in got] == ["uart", "pwm", "i2c"] and all(not validate(m) for m in got)
        await a.send({"type": "reply", "id": 1, "data": "1a2b", "ack": True})
        await a.send({"type": "uart", "port": "USART1", "data": "status\r\n"})
        assert a._bridge.data == (b'{"type":"reply","id":1,"data":"1a2b","ack":true}\n'
                                  b'{"type":"uart","port":"USART1","data":"status\\r\\n"}\n')
    asyncio.run(go())


def _images_ready() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return all(subprocess.run(["docker", "image", "inspect", image], capture_output=True,
                                  timeout=30).returncode == 0 for image in (renode.IMAGE, renode.BUILD_IMAGE))
    except (OSError, subprocess.TimeoutExpired):
        return False


needs_renode = pytest.mark.skipif(not (_images_ready() and (IOT_FAN / "stm32").is_dir()),
                                  reason=f"needs Docker, the {renode.IMAGE} and {renode.BUILD_IMAGE} "
                                         "images and projects/iot-fan")


async def _wait_for(pred, timeout):
    async def poll():
        while not pred():
            await asyncio.sleep(0.05)
    await asyncio.wait_for(poll(), timeout)


def _rpm(text: str) -> int:
    return int(re.findall(r"(\d+) rpm", text)[-1])


@needs_renode
def test_iot_fan_on_renode():
    """speed 60 -> pwm on PA6; a press on PA0 steps it; a 40 Hz tachometer -> 1200 rpm."""
    async def go():
        a = Renode()
        seen, uart = [], []
        await a.start(IOT_FAN, {})                 # builds into .cache/sim; the project is mounted read-only
        try:
            async def pump():
                async for m in a.events():
                    (uart.append(m["data"]) if m["type"] == "uart" else seen.append(m))
            task = asyncio.create_task(pump())
            await _wait_for(lambda: "iot-fan ready" in "".join(uart), 30)
            await a.send({"type": "pin", "pin": "PA0", "level": 1})
            await a.send({"type": "pin", "pin": "PA1", "level": 1})
            await a.send({"type": "uart", "port": "USART1", "data": "speed 60\r\n"})
            pwm = lambda d: [m for m in seen if m["type"] == "pwm" and m["pin"] == "PA6" and m["duty"] == d]
            await _wait_for(lambda: pwm(0.6), 10)
            assert pwm(0.6)[0]["hz"] == pytest.approx(25000)
            await a.send({"type": "pin", "pin": "PA0", "level": 0})     # press "up"
            await asyncio.sleep(0.3)
            await a.send({"type": "pin", "pin": "PA0", "level": 1})
            await _wait_for(lambda: pwm(0.75), 10)
            uart.clear()
            await a.send({"type": "uart", "port": "USART1", "data": "status\r\n"})
            await _wait_for(lambda: "rpm" in "".join(uart), 10)
            assert "fan 75% (asked 75%)" in "".join(uart)
            await a.send({"type": "freq", "pin": "PA7", "hz": 40})
            for _ in range(60):                      # the firmware counts pulses over 1 s windows
                uart.clear()
                await a.send({"type": "uart", "port": "USART1", "data": "status\r\n"})
                await _wait_for(lambda: "rpm" in "".join(uart), 10)
                if _rpm("".join(uart)):
                    break
                await asyncio.sleep(0.5)
            await asyncio.sleep(3)                   # a full window at 40 Hz
            uart.clear()
            await a.send({"type": "uart", "port": "USART1", "data": "status\r\n"})
            await _wait_for(lambda: "rpm" in "".join(uart), 10)
            assert 1100 <= _rpm("".join(uart)) <= 1300, "".join(uart)
            assert all(not validate(m) for m in seen), [validate(m) for m in seen]
            assert all(isinstance(m.get("t"), int) for m in seen)
            task.cancel()
        finally:
            await a.stop()
    asyncio.run(go())


@needs_renode
def test_closed_loop_through_the_board():
    """The runtime, unchanged: the fan model spins from PA6's pwm and its tachometer
    `freq` on PA7 reaches the firmware; the button part steps the speed."""
    sim = {"mcu": {"family": "stm32f0", "emulator": "renode"},
           "parts": [{"ref": "J1", "model": "fan", "pins": {"pwm": "PA6", "tach": "PA7"}},
                     {"ref": "SW1", "model": "button", "pins": {"1": "PA0"}}]}

    async def go():
        board, a = Board(sim), Renode()
        run = asyncio.create_task(board.run(a, IOT_FAN))
        out = lambda: "".join(u["data"] for u in board.uart if u["dir"] == "out")
        try:
            await _wait_for(lambda: "iot-fan ready" in out(), 60)
            board.write_uart("USART1", "speed 60\r\n")
            await _wait_for(lambda: board.parts["J1"].duty == 0.6, 10)
            board.act("SW1", {"press": True})
            await asyncio.sleep(0.3)
            board.act("SW1", {"press": False})
            await _wait_for(lambda: board.parts["J1"].duty == 0.75, 10)
            for _ in range(40):                      # the fan spins up; the firmware counts its pulses
                await asyncio.sleep(1)
                board.write_uart("USART1", "status\r\n")
                await _wait_for(lambda: out().rstrip().endswith("manual"), 10)
                if _rpm(out()) > 1500:
                    break
            rpm = _rpm(out())
            assert "fan 75% (asked 75%)" in out().splitlines()[-1]
            # the model reaches 0.75 * 3000 = 2250 rpm; the firmware measures it from its tachometer
            assert 1500 < rpm <= 2300, out()
            assert board.snapshot()["parts"]["J1"]["rpm"] > 1500
        finally:
            run.cancel()
            try:
                await run
            except asyncio.CancelledError:
                pass
            await a.stop()
    asyncio.run(go())


PROBE = r"""
/* Bus probe: I2C1 write 01 to 0x48 then read 2; SPI1 9f 00 with PA4 as CS; ADC IN0 (PA0). */
#include <stdint.h>
#define R(a) (*(volatile uint32_t *)(a))
#define R8(a) (*(volatile uint8_t *)(a))
void SysTick_Handler(void) {}
static void put(const char *s) { while (*s) { while (!(R(0x4001381C) & 0x80)) {} R(0x40013828) = (uint8_t)*s++; } }
static void hex(uint32_t v, int n) { char b[9]; for (int i = n - 1; i >= 0; i--) { b[i] = "0123456789abcdef"[v & 15]; v >>= 4; } b[n] = 0; put(b); }
static int wait(uint32_t addr, uint32_t mask) { for (int i = 0; i < 100000; i++) if (R(addr) & mask) return 1; return 0; }
int main(void) {
    R(0x40021014) |= 1u << 17; R(0x4002101C) |= 1u << 21; R(0x40021018) |= (1u << 14) | (1u << 12) | (1u << 9);
    R(0x48000000) = (R(0x48000000) & ~(3u << 8)) | (1u << 8) | 3u;
    R(0x48000014) |= 1u << 4;
    R(0x4001380C) = 8000000u / 115200u; R(0x40013800) = 0xD;
    R(0x40005400) = 1;
    R(0x40005404) = (0x48u << 1) | (1u << 16) | (1u << 13);
    wait(0x40005418, 2); R(0x40005428) = 0x01; wait(0x40005418, 1u << 6);
    R(0x40005404) = (0x48u << 1) | (1u << 10) | (2u << 16) | (1u << 13) | (1u << 25);
    uint32_t a = 0, b = 0;
    if (wait(0x40005418, 4)) a = R(0x40005424);
    if (wait(0x40005418, 4)) b = R(0x40005424);
    put("i2c "); hex(a, 2); hex(b, 2); put("\r\n");
    R(0x40013004) = (7u << 8) | (1u << 12);
    R(0x40013000) = (1u << 2) | (1u << 6) | (1u << 9) | (1u << 8);
    R(0x48000014) &= ~(1u << 4);
    uint8_t rx[2];
    for (int i = 0; i < 2; i++) { wait(0x40013008, 2); R8(0x4001300C) = i ? 0x00 : 0x9f; wait(0x40013008, 1); rx[i] = R8(0x4001300C); }
    R(0x48000014) |= 1u << 4;
    put("spi "); hex(rx[0], 2); hex(rx[1], 2); put("\r\n");
    R(0x40012408) = 1; wait(0x40012400, 1); R(0x40012428) = 1; R(0x40012408) |= 4;
    wait(0x40012400, 4); put("adc "); hex(R(0x40012440), 3); put("\r\n");
    for (;;) {}
}
"""


@needs_renode
def test_bus_proxies():
    """i2c and spi go out as transactions and wait for the reply; adc volts reach the ADC."""
    src = renode.CACHE / "src" / "renode-busprobe"
    (src / "src").mkdir(parents=True, exist_ok=True)
    (src / "src" / "main.c").write_text(PROBE)
    shutil.copy(IOT_FAN / "stm32" / "src" / "startup.c", src / "src" / "startup.c")
    shutil.copy(IOT_FAN / "stm32" / "link" / "stm32f042f6.ld", src / "f042.ld")
    shutil.copytree(IOT_FAN / "stm32" / "cmake", src / "cmake", dirs_exist_ok=True)
    (src / "CMakeLists.txt").write_text(
        "cmake_minimum_required(VERSION 3.20)\nproject(busprobe C)\n"
        "add_executable(busprobe.elf src/main.c src/startup.c)\n"
        "target_compile_options(busprobe.elf PRIVATE -mcpu=cortex-m0 -mthumb -Os)\n"
        "target_link_options(busprobe.elf PRIVATE -mcpu=cortex-m0 -mthumb -nostartfiles "
        "--specs=nano.specs --specs=nosys.specs -T${CMAKE_SOURCE_DIR}/f042.ld)\n")
    board = {"parts": [{"ref": "U1", "model": "tmp102", "bus": "I2C1", "addr": 72},
                       {"ref": "U2", "model": "flash", "bus": "SPI1", "cs": "PA4"}]}

    async def go():
        a, seen, uart = Renode(), [], []
        await a.start(src, board)
        await a.send({"type": "adc", "pin": "PA0", "volts": 1.65})
        try:
            async def pump():
                async for m in a.events():
                    if m["type"] == "uart":
                        uart.append(m["data"])
                        continue
                    seen.append(m)
                    if m["type"] == "i2c":
                        await asyncio.sleep(0.5)       # a slow part: the CPU waits for it
                        await a.send({"type": "reply", "id": m["id"], "data": "1a2b", "ack": True})
                    elif m["type"] == "spi":
                        await a.send({"type": "reply", "id": m["id"], "ack": True,
                                      "data": "c2" if m["write"] == "00" else "ff"})
            task = asyncio.create_task(pump())
            await _wait_for(lambda: "adc" in "".join(uart), 30)
            text = "".join(uart)
            assert "i2c 1a2b" in text and "spi ffc2" in text and "adc 800" in text, text
            i2c = [m for m in seen if m["type"] == "i2c"]
            assert [(m["bus"], m["addr"], m["write"], m["read"]) for m in i2c] == [("I2C1", 72, "01", 2)]
            spi = [(m["cs"], m["write"]) for m in seen if m["type"] == "spi"]
            assert spi == [("PA4", "9f"), ("PA4", "00")]
            assert all(not validate(m) for m in seen)
            task.cancel()
        finally:
            await a.stop()
    asyncio.run(go())
