"""The ESP32 adapter: bridge parsing and the pause logic without an emulator,
then the real iot-fan firmware on QEMU when Docker and the image are here."""

from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.sim.adapters import qemu_esp32
from backend.sim.adapters.qemu_esp32 import QemuEsp32, encode, firmware_kind, parse_bridge_line
from backend.sim.messages import validate

IOT_FAN = Path(__file__).resolve().parents[3] / "projects" / "iot-fan" / "firmware"


def test_bridge_lines():
    assert parse_bridge_line(b'{"type":"pwm","t":5,"pin":"GPIO18","duty":0.5986,"hz":25000}\n') == \
        {"type": "pwm", "t": 5, "pin": "GPIO18", "duty": 0.5986, "hz": 25000}
    assert parse_bridge_line(b'{"type":"hello","sim":"redline-esp32"}\n') is None
    assert parse_bridge_line(b"\x00garbage\r\n") is None
    assert parse_bridge_line('{"type":"pin",') is None
    assert encode({"type": "freq", "pin": "GPIO19", "hz": 40}) == b'{"type":"freq","pin":"GPIO19","hz":40}\n'


def test_firmware_kind(tmp_path):
    (tmp_path / "p").mkdir()
    (tmp_path / "p" / "CMakeLists.txt").write_text("project(x)")
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "flash_args").write_text("")
    (tmp_path / "f.bin").write_bytes(b"\xff")
    assert [firmware_kind(tmp_path / n) for n in ("p", "b", "f.bin")] == ["project", "build", "image"]
    with pytest.raises(FileNotFoundError):
        firmware_kind(tmp_path)


def test_build_dir_is_stable_and_outside_the_project(tmp_path):
    a = QemuEsp32(cache=tmp_path / "cache")
    assert a.build_dir(tmp_path / "fw") == a.build_dir(tmp_path / "fw")
    assert a.build_dir(tmp_path / "fw") != a.build_dir(tmp_path / "other")
    assert (tmp_path / "cache") in a.build_dir(tmp_path / "fw").parents


class _Writer:
    def __init__(self):
        self.data = b""

    def write(self, b):
        self.data += b

    async def drain(self):
        pass


def test_transaction_pauses_the_vm_until_the_reply():
    async def go():
        a = QemuEsp32()
        a._mon, a._bridge, a._uart = _Writer(), _Writer(), _Writer()
        r = asyncio.StreamReader()
        r.feed_data(b'{"type":"hello"}\n{"type":"pin","t":1,"pin":"GPIO2","level":1}\n'
                    b'{"type":"i2c","t":2,"id":7,"bus":"I2C0","addr":60,"write":"00af","read":0}\n')
        r.feed_eof()
        await a._read_bridge(r)
        assert a._booted.is_set()
        got = [a._queue.get_nowait() for _ in range(2)]
        assert [m["type"] for m in got] == ["pin", "i2c"] and all(not validate(m) for m in got)
        assert a._mon.data == b"stop\n"
        await a.send({"type": "uart", "port": "UART0", "data": "status\r\n"})
        await a.send({"type": "reply", "id": 7, "data": "", "ack": True})
        assert a._uart.data == b"status\r\n"
        assert a._bridge.data == b'{"type":"reply","id":7,"data":"","ack":true}\n'
        assert a._mon.data == b"stop\ncont\n"
    asyncio.run(go())


def _image_ready() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", qemu_esp32.IMAGE],
                              capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


needs_qemu = pytest.mark.skipif(not (_image_ready() and IOT_FAN.is_dir()),
                                reason=f"needs Docker, the {qemu_esp32.IMAGE} image and projects/iot-fan")


@needs_qemu
def test_iot_fan_on_qemu():
    """speed 60 -> pwm on GPIO18; a 40 Hz tachometer -> 1200 rpm in `status`."""
    # A copy, so nothing ever builds in the project; a fixed place, so the build is cached.
    src = qemu_esp32.CACHE / "src" / "iot-fan"
    for part in ("esp32", "common"):
        shutil.copytree(IOT_FAN / part, src / part, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("build"))

    async def go():
        a = QemuEsp32()
        seen, uart = [], []

        async def wait_for(pred, timeout):
            async def poll():
                while not pred():
                    await asyncio.sleep(0.05)
            await asyncio.wait_for(poll(), timeout)

        await a.start(src / "esp32", {})
        try:
            async def pump():
                async for m in a.events():
                    (uart.append(m["data"]) if m["type"] == "uart" else seen.append(m))
            task = asyncio.create_task(pump())
            await wait_for(lambda: "iot-fan ready" in "".join(uart), 30)
            await a.send({"type": "uart", "port": "UART0", "data": "speed 60\r\n"})
            pwm = lambda: [m for m in seen if m["type"] == "pwm" and m["pin"] == "GPIO18" and m["duty"] > 0.5]
            await wait_for(pwm, 10)
            assert pwm()[0]["duty"] == pytest.approx(0.6, abs=0.01) and pwm()[0]["hz"] == 25000
            await a.send({"type": "freq", "pin": "GPIO19", "hz": 40})
            await asyncio.sleep(2.5)                     # two of the firmware's 1 s windows
            uart.clear()
            await a.send({"type": "uart", "port": "UART0", "data": "status\r\n"})
            await wait_for(lambda: "rpm" in "".join(uart), 10)
            rpm = int(re.search(r"(\d+) rpm", "".join(uart)).group(1))
            assert 1100 <= rpm <= 1300, "".join(uart)
            assert all(not validate(m) for m in seen), [validate(m) for m in seen]
            task.cancel()
        finally:
            await a.stop()

    asyncio.run(go())
