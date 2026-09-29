"""ESP32 firmware on Espressif's QEMU, as a SPEC adapter (backend/sim/SPEC.md §2).

QEMU runs the real firmware but does not model LEDC, PCNT, the ADC front
end or I2C devices. So the app is rebuilt with one extra ESP-IDF component,
`backend/sim/esp32/redline_sim`, which wraps those driver calls at link time
(the app's source is untouched) and speaks the SPEC messages on UART1:

    QEMU -serial #0  -> UART0  the app's console      <-> `uart` messages, port UART0
    QEMU -serial #1  -> UART1  the bridge, JSON Lines <-> every other message
    QEMU -monitor             stop/cont: virtual time stops during an i2c transaction

Everything heavy runs in the `redline-code-embedded` image (ESP-IDF 5.3 and
QEMU). The build goes to `<repo>/.cache/sim/<hash>/`, never into the project;
the project is mounted read-only. QEMU runs with `--network host` and listens
on three free 127.0.0.1 ports, so there is no port publishing to race with.
"""

from __future__ import annotations

import asyncio
import codecs
import hashlib
import json
import logging
import os
import socket
import uuid
from pathlib import Path

log = logging.getLogger(__name__)

IMAGE = "redline-code-embedded"
QEMU = "/opt/esp/tools/qemu-xtensa/esp_develop_9.0.0_20240606/qemu/bin/qemu-system-xtensa"
COMPONENT = Path(__file__).resolve().parents[1] / "esp32" / "redline_sim"
CACHE = Path(__file__).resolve().parents[3] / ".cache" / "sim"
TRANSACTIONS = ("i2c", "spi")


def firmware_kind(path: Path) -> str:
    """'image' (a merged flash .bin), 'build' (an idf.py build dir) or 'project' (an ESP-IDF project)."""
    if path.is_file():
        return "image"
    if (path / "flash_args").is_file():
        return "build"
    if (path / "CMakeLists.txt").is_file():
        return "project"
    raise FileNotFoundError(f"{path}: not an ESP-IDF project, build directory or flash image")


def parse_bridge_line(line: bytes | str) -> dict | None:
    """One line from the bridge UART as a message; None for noise and for the boot hello."""
    text = line.decode("utf-8", "replace") if isinstance(line, bytes) else line
    text = text.strip()
    if not text.startswith("{"):
        return None
    try:
        msg = json.loads(text)
    except ValueError:
        log.warning("bridge: not JSON: %r", text[:120])
        return None
    if not isinstance(msg, dict) or msg.get("type") in (None, "hello"):
        return None
    return msg


def encode(msg: dict) -> bytes:
    return (json.dumps(msg, separators=(",", ":")) + "\n").encode()


def _free_ports(n: int) -> list[int]:
    socks = [socket.socket() for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()


async def _run(args: list[str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"{args[0]} {args[1]}: no result in {timeout:.0f}s") from None
    return proc.returncode, out.decode(errors="replace")


async def image_present(image: str = IMAGE) -> bool:
    try:
        code, _ = await _run(["docker", "image", "inspect", image], 30)
    except (FileNotFoundError, TimeoutError):
        return False
    return code == 0


class QemuEsp32:
    name = "qemu-esp32"

    def __init__(self, image: str = IMAGE, cache: Path = CACHE, build_timeout: float = 900,
                 boot_timeout: float = 60, machine: str = "esp32"):
        self.image, self.cache, self.machine = image, cache, machine
        self.build_timeout, self.boot_timeout = build_timeout, boot_timeout
        self.container: str | None = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._uart = self._bridge = self._mon = None      # asyncio StreamWriters
        self._booted = asyncio.Event()
        self._open: set = set()                            # transaction ids the VM waits on
        self.build_log = ""

    # ---- build ----

    def build_dir(self, project: Path) -> Path:
        return self.cache / hashlib.sha1(str(project.resolve()).encode()).hexdigest()[:12]

    def _docker(self, *mounts: str) -> list[str]:
        args = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp"]
        for m in mounts:
            args += ["-v", m]
        return args + [self.image]

    async def build(self, project: Path) -> Path:
        """idf.py build with the bridge component; returns the merged flash image."""
        project = project.resolve()
        out = self.build_dir(project)
        out.mkdir(parents=True, exist_ok=True)
        # The project's parent is mounted too: firmwares share code with a sibling (../common).
        root, name = project.parent, project.name
        code, self.build_log = await _run(
            self._docker(f"{root}:/src:ro", f"{COMPONENT}:/sim/redline_sim:ro", f"{out}:/build")
            + ["idf.py", "-C", f"/src/{name}", "-B", "/build", f"-DIDF_TARGET={self.machine}",
               "-DEXTRA_COMPONENT_DIRS=/sim/redline_sim", "-DSDKCONFIG=/build/sdkconfig",
               *self._defaults(project, name), "build"],
            self.build_timeout)
        (out / "build.log").write_text(self.build_log)
        if code:
            raise RuntimeError(f"firmware build failed (log: {out / 'build.log'}):\n{self.build_log[-2000:]}")
        return await self.merge(out)

    @staticmethod
    def _defaults(project: Path, name: str) -> list[str]:
        """The project's own sdkconfig is read as defaults; the live one is written in the build dir."""
        files = [f"/src/{name}/{f}" for f in ("sdkconfig.defaults", "sdkconfig") if (project / f).is_file()]
        return [f"-DSDKCONFIG_DEFAULTS={';'.join(files)}"] if files else []

    async def merge(self, build: Path) -> Path:
        code, text = await _run(self._docker(f"{build.resolve()}:/build") + [
            "bash", "-c", f"cd /build && esptool.py --chip {self.machine} merge_bin --fill-flash-size 4MB "
                          "-o flash.bin @flash_args"], 120)
        if code:
            raise RuntimeError(f"merging the flash image failed:\n{text[-1500:]}")
        return build / "flash.bin"

    # ---- Adapter ----

    async def start(self, firmware: Path, board: dict | None = None) -> None:
        firmware = Path(firmware)
        if not await image_present(self.image):
            raise RuntimeError(f"Docker image {self.image!r} is missing (or Docker is not running); "
                               "the ESP32 simulator builds and runs firmware in it")
        kind = firmware_kind(firmware)
        flash = (firmware.resolve() if kind == "image" else
                 await self.merge(firmware) if kind == "build" else await self.build(firmware))
        mon, uart, bridge = _free_ports(3)
        self.container = f"redline-sim-{uuid.uuid4().hex[:10]}"
        serial = "tcp:127.0.0.1:{},server=on,wait=on"
        code, text = await _run([
            "docker", "run", "--rm", "-d", "--name", self.container, "--network", "host",
            "-v", f"{flash.parent}:/fw:ro", "--entrypoint", QEMU, self.image,
            "-M", self.machine, "-m", "4M", "-display", "none", "-nic", "none",
            "-drive", f"file=/fw/{flash.name},if=mtd,format=raw,snapshot=on",
            "-monitor", serial.format(mon), "-serial", serial.format(uart), "-serial", serial.format(bridge)], 60)
        if code:
            self.container = None
            raise RuntimeError(f"QEMU did not start:\n{text[-1500:]}")
        try:
            # QEMU waits for each socket in turn, in the order they were given.
            r_mon, self._mon = await self._connect(mon)
            r_uart, self._uart = await self._connect(uart)
            r_bridge, self._bridge = await self._connect(bridge)
            self._tasks = [asyncio.create_task(self._read_uart(r_uart)),
                           asyncio.create_task(self._read_bridge(r_bridge)),
                           asyncio.create_task(self._drain(r_mon))]
            await asyncio.wait_for(self._booted.wait(), self.boot_timeout)
        except BaseException:
            await self.stop()
            raise

    async def _connect(self, port: int):
        deadline = asyncio.get_running_loop().time() + 30
        while True:
            try:
                return await asyncio.open_connection("127.0.0.1", port)
            except OSError:
                if asyncio.get_running_loop().time() > deadline:
                    raise TimeoutError(f"QEMU is not listening on port {port}") from None
                await asyncio.sleep(0.1)

    async def _read_uart(self, reader: asyncio.StreamReader) -> None:
        text = codecs.getincrementaldecoder("utf-8")("replace")
        while chunk := await reader.read(4096):
            if data := text.decode(chunk):
                await self._queue.put({"type": "uart", "port": "UART0", "data": data})
        await self._queue.put(None)                       # the emulator is gone

    async def _read_bridge(self, reader: asyncio.StreamReader) -> None:
        while line := await reader.readline():
            if b'"hello"' in line:
                self._booted.set()
            msg = parse_bridge_line(line)
            if msg is None:
                continue
            if msg["type"] in TRANSACTIONS:               # hold the MCU until the reply
                self._open.add(msg.get("id"))
                await self._monitor("stop")
            await self._queue.put(msg)

    async def _drain(self, reader: asyncio.StreamReader) -> None:
        while await reader.read(4096):
            pass

    async def _monitor(self, command: str) -> None:
        self._mon.write(command.encode() + b"\n")
        await self._mon.drain()

    async def events(self):
        while (msg := await self._queue.get()) is not None:
            yield msg

    async def send(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "uart":
            if msg.get("port", "UART0") != "UART0":
                log.warning("qemu-esp32: only UART0 is wired, dropped %s", msg.get("port"))
                return
            self._uart.write(msg.get("data", "").encode())
            await self._uart.drain()
            return
        self._bridge.write(encode(msg))
        await self._bridge.drain()
        if kind == "reply" and msg.get("id") in self._open:
            self._open.discard(msg.get("id"))
            if not self._open:
                await self._monitor("cont")

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        for writer in (self._uart, self._bridge, self._mon):
            if writer:
                writer.close()
        self._uart = self._bridge = self._mon = None
        if self.container:
            await _run(["docker", "rm", "-f", self.container], 60)
            self.container = None
        self._queue.put_nowait(None)
