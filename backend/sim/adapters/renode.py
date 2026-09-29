"""STM32 firmware on Renode, as a SPEC adapter (backend/sim/SPEC.md section 2).

Renode runs the real, unmodified ELF on its STM32F0 machine
(`platforms/cpus/stm32f042.repl`, from the image). The generated machine sets the
clock the firmware assumes (the reset HSI, 8 MHz, unless sim.json's `mcu`
says `clock_hz`) and `backend/sim/renode/bridge.py`, run inside Renode,
speaks the SPEC messages over one TCP socket:

    bridge (JSON Lines, TCP)  <->  every message: uart, pin, pwm, freq, adc, i2c/spi + reply
    monitor (-P, telnet)           not used by the adapter; there for a person debugging

What the bridge does with each message is described at its top. In short:
GPIO outputs from a hook on GPIO writes; PWM computed from the timer
registers on a 1 ms virtual tick; `freq` is a virtual-time pulse train that
also sets the input-capture flag of the timer channel on that pin; i2c/spi
go through proxy peripherals that hold the CPU until the `reply`.

Builds run in `redline-code-embedded` (arm-none-eabi, CMake, Ninja) into
`<repo>/.cache/sim/<hash>/`, never into the project, which is mounted
read-only. Renode runs in `antmicro/renode` with `--network host` on free
127.0.0.1 ports, like the ESP32 adapter.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import uuid
from pathlib import Path

from .qemu_esp32 import _free_ports, _run, encode, image_present, parse_bridge_line

log = logging.getLogger(__name__)

IMAGE = "antmicro/renode:latest"
BUILD_IMAGE = "redline-code-embedded"
BRIDGE = Path(__file__).resolve().parents[1] / "renode"
CACHE = Path(__file__).resolve().parents[3] / ".cache" / "sim"
PLATFORM = "platforms/cpus/stm32f042.repl"
TIMERS = ("timer1", "timer2", "timer3", "timer14", "timer15", "timer16", "timer17")
USARTS = tuple(f"usart{i}" for i in range(1, 8))
BUSES = {"I2C1": "i2c1", "I2C2": "i2c2", "SPI1": "spi1", "SPI2": "spi2"}


def firmware_kind(path: Path) -> str:
    """'elf' (a linked image), 'build' (a build dir holding one) or 'project' (a CMake firmware)."""
    path = Path(path)
    if path.is_file():
        return "elf"
    if source_dir(path):
        return "project"
    if list(path.glob("*.elf")):
        return "build"
    raise FileNotFoundError(f"{path}: not an STM32 CMake project, build directory or .elf")


def source_dir(path: Path) -> Path | None:
    """The CMake source of a firmware: the dir itself, or its `stm32/` (a multi-target firmware dir)."""
    for cand in (path, path / "stm32"):
        if (cand / "CMakeLists.txt").is_file():
            return cand
    return None


def toolchain_file(source: Path) -> Path | None:
    for cand in (source / "cmake" / "arm-none-eabi.cmake", source.parent / "cmake" / "arm-none-eabi.cmake"):
        if cand.is_file():
            return cand
    return None


def platform(base: str, clock_hz: int) -> str:
    """The machine: Renode's STM32 description, with SysTick, timers and USARTs on the firmware's clock."""
    out = [f'using "{base}"\n', f"nvic:\n    systickFrequency: {clock_hz}\n"]
    out += [f"{t}:\n    frequency: {clock_hz}\n" for t in TIMERS]
    out += [f"{u}:\n    frequency: {clock_hz}\n" for u in USARTS]
    return "\n".join(out)


def bus_devices(board: dict | None) -> tuple[list[dict], list[dict]]:
    """The board's I2C addresses and SPI chip selects, for the bridge's proxies.

    A bus the MCU has (I2C1, SPI2...) is used as named; anything else (I2C0,
    'i2c', none) is the first controller, and messages carry the name the
    board uses so the runtime finds its part."""
    i2c, spi = [], {}
    for part in (board or {}).get("parts", []):
        name = str(part.get("bus") or "")
        if "addr" in part:
            i2c.append({"controller": BUSES.get(name.upper(), "i2c1"), "bus": name or "I2C0",
                        "addr": int(part["addr"])})
        elif "cs" in part:
            ctrl = BUSES.get(name.upper(), "spi1")
            entry = spi.setdefault(ctrl, {"controller": ctrl, "bus": name or "SPI0", "cs": []})
            entry["cs"].append(part["cs"])
    return i2c, list(spi.values())


def session_files(elf: str, port: int, board: dict | None) -> dict[str, str]:
    """What Renode is started with: the script, the machine and the bridge's config."""
    mcu = (board or {}).get("mcu") or {}
    clock = int(mcu.get("clock_hz", 8_000_000))
    i2c, spi = bus_devices(board)
    config = {"port": port, "clock_hz": clock, "tick_us": 1000, "i2c": i2c, "spi": spi}
    resc = "\n".join([
        'mach create "redline"',
        "machine LoadPlatformDescription @/session/machine.repl",
        f"sysbus.cpu PerformanceInMips {max(1, clock // 1_000_000)}",
        f"sysbus LoadELF @/fw/{elf}",
        "include @/sim/bridge.py",          # starts the machine once the adapter is connected
        ""])
    return {"session.resc": resc, "machine.repl": platform(mcu.get("repl", PLATFORM), clock), "config.json": json.dumps(config, indent=1)}


class Renode:
    name = "renode"

    def __init__(self, image: str = IMAGE, build_image: str = BUILD_IMAGE, cache: Path = CACHE,
                 build_timeout: float = 600, boot_timeout: float = 90):
        self.image, self.build_image, self.cache = image, build_image, cache
        self.build_timeout, self.boot_timeout = build_timeout, boot_timeout
        self.container: str | None = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._bridge = None
        self._booted = asyncio.Event()
        self.build_log = ""

    # ---- build ----

    def build_dir(self, project: Path) -> Path:
        return self.cache / hashlib.sha1(str(Path(project).resolve()).encode()).hexdigest()[:12]

    async def build(self, project: Path) -> Path:
        """cmake + ninja in the embedded image; returns the ELF."""
        source = source_dir(Path(project).resolve())
        if source is None:
            raise FileNotFoundError(f"{project}: no CMakeLists.txt")
        out = self.build_dir(source)
        out.mkdir(parents=True, exist_ok=True)
        # The source's parent is mounted too: firmwares share code with a sibling (../common).
        root, name = source.parent, source.name
        tool = toolchain_file(source)
        flags = f"-DCMAKE_TOOLCHAIN_FILE=/src/{tool.relative_to(root)}" if tool else ""
        code, self.build_log = await _run(
            ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
             "-v", f"{root}:/src:ro", "-v", f"{out}:/build", self.build_image, "bash", "-c",
             f"cmake -S /src/{name} -B /build -G Ninja {flags} && ninja -C /build"],
            self.build_timeout)
        (out / "build.log").write_text(self.build_log)
        if code:
            raise RuntimeError(f"firmware build failed (log: {out / 'build.log'}):\n{self.build_log[-2000:]}")
        return self.find_elf(out)

    @staticmethod
    def find_elf(build: Path) -> Path:
        elves = sorted(Path(build).glob("*.elf"), key=lambda p: p.stat().st_mtime)
        if not elves:
            raise FileNotFoundError(f"{build}: no .elf")
        return elves[-1].resolve()

    # ---- Adapter ----

    async def start(self, firmware: Path, board: dict | None = None) -> None:
        firmware = Path(firmware)
        kind = firmware_kind(firmware)
        if kind == "project" and not await image_present(self.build_image):
            raise RuntimeError(f"Docker image {self.build_image!r} is missing (or Docker is not running); "
                               "STM32 firmware is built in it")
        if not await image_present(self.image):
            raise RuntimeError(f"Docker image {self.image!r} is missing (or Docker is not running); "
                               "the STM32 simulator runs in it")
        elf = (firmware.resolve() if kind == "elf" else
               self.find_elf(firmware) if kind == "build" else await self.build(firmware))
        bridge, monitor = _free_ports(2)
        session = self.cache / "renode" / uuid.uuid4().hex[:10]
        session.mkdir(parents=True, exist_ok=True)
        for fname, text in session_files(elf.name, bridge, board).items():
            (session / fname).write_text(text)
        self.session = session
        self.container = f"redline-sim-{session.name}"
        code, text = await _run([
            "docker", "run", "--rm", "-d", "--name", self.container, "--network", "host",
            "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
            "-v", f"{elf.parent}:/fw:ro", "-v", f"{BRIDGE}:/sim:ro", "-v", f"{session}:/session:ro",
            self.image, "renode", "--disable-xwt", "--plain", "-P", str(monitor),
            "-e", "include @/session/session.resc"], 60)
        if code:
            self.container = None
            raise RuntimeError(f"Renode did not start:\n{text[-1500:]}")
        try:
            reader, self._bridge = await self._connect(bridge)
            self._tasks = [asyncio.create_task(self._read_bridge(reader))]
            await asyncio.wait_for(self._booted.wait(), self.boot_timeout)
        except BaseException:
            logs = await self.logs()
            await self.stop()
            log.error("renode: did not come up; its log:\n%s", logs[-3000:])
            raise

    async def logs(self) -> str:
        if not self.container:
            return ""
        try:
            return (await _run(["docker", "logs", self.container], 30))[1]
        except (OSError, TimeoutError):
            return ""

    async def _connect(self, port: int):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.boot_timeout
        while True:
            try:
                return await asyncio.open_connection("127.0.0.1", port, limit=1 << 20)
            except OSError:
                if loop.time() > deadline:
                    raise TimeoutError(f"the Renode bridge is not listening on port {port}") from None
                await asyncio.sleep(0.2)

    async def _read_bridge(self, reader: asyncio.StreamReader) -> None:
        while line := await reader.readline():
            if b'"hello"' in line:
                self._booted.set()
            msg = parse_bridge_line(line)
            if msg is not None:
                await self._queue.put(msg)
        await self._queue.put(None)                       # the emulator is gone

    async def events(self):
        while (msg := await self._queue.get()) is not None:
            yield msg

    async def send(self, msg: dict) -> None:
        if self._bridge is None:
            return
        self._bridge.write(encode(msg))
        await self._bridge.drain()

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        if self._bridge:
            self._bridge.close()
        self._bridge = None
        if self.container:
            await _run(["docker", "rm", "-f", self.container], 60)
            self.container = None
        if getattr(self, "session", None):
            shutil.rmtree(self.session, ignore_errors=True)
            self.session = None
        self._queue.put_nowait(None)

