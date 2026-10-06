"""A real board: the ports plugged in, flashing, and the serial monitor.

Routes under /api/embedded/<app>/... (rooms/fw-device.ts).

  GET  device             everything the view draws at once: ports, the
                          image to flash, the board's own note, the last
                          flash job, the last simulation's UART transcript
  GET  ports              serial ports and programming probes seen
  POST flash              {port, erase?} - program the last build, as a job
  GET  flash              that job: state, percent, its lines (?since=n)
  GET  serial/stream      ?port=&baud= - Server-Sent Events of lines read
  POST serial/write       {port, text}

Ports are read from /sys on the host - listing files, nothing installed.
A port name is only ever one of the ports listed: never a path the caller
made up.

The monitor runs on the host with the standard library (termios), when
the port is the person's to open - on Linux that is being in `dialout`.
pyserial is not one of Redline's dependencies and a tty needs nothing
more than termios. When the port is not the person's, it is opened in
the Embedded image instead, as root with the device passed through, the
way flashing does, by the pyserial that ESP-IDF ships in there. One
reader per port, shared by every viewer; it stops when nobody has
listened for IDLE_S. While a flash runs on a port its monitor lets go of
the port, and takes it again after.

Flashing is the path backend/firmware.py takes - its commands, its
image, root in the container with the board passed through - run here as
a job whose output is read as it comes, so the page shows progress.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import termios
import time
import tty
import uuid
from collections import deque
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import apps, compute, firmware, sandbox, store

router = APIRouter(prefix="/api/embedded")

SYS = Path("/sys")
IDLE_S = 30.0                 # a monitor nobody listens to stops after this
KEEPALIVE_S = 15.0
BACKLOG = 400                 # lines a viewer who joins late is given
LINE_MAX = 2000               # a line with no end is cut here
FLUSH_S = 0.25                # a partial line is shown after this much quiet
WRITE_MAX = 1024
BAUDS = (1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400,
         460800, 921600, 1500000, 2000000)


def _db():
    # Late, as code_api does: main imports this module and owns the connection.
    from backend.main import db
    return db()


async def _say(text: str, level: str = "info") -> None:
    """A line in the Embedded room's log."""
    try:
        from backend.main import say
        await say(text, level, "embedded")
    except Exception:                                          # noqa: BLE001
        pass


# ---------------- ports ----------------
# What a USB id is, by name. The bridges put a classic ESP32 (or any
# board with a UART) on a tty; the probes program an STM32 over SWD.
USB_NAMES = {
    ("1a86", "7523"): "CH340", ("1a86", "5523"): "CH341", ("1a86", "55d4"): "CH9102",
    ("1a86", "55d3"): "CH343", ("1a86", "55d2"): "CH342",
    ("10c4", "ea60"): "CP210x", ("10c4", "ea70"): "CP2105", ("10c4", "ea71"): "CP2108",
    ("0403", "6001"): "FTDI FT232R", ("0403", "6010"): "FTDI FT2232", ("0403", "6011"): "FTDI FT4232",
    ("0403", "6014"): "FTDI FT232H", ("0403", "6015"): "FTDI FT-X",
    ("303a", "1001"): "ESP32 USB-Serial/JTAG", ("303a", "0002"): "ESP32-S2 USB",
    ("0483", "3748"): "ST-Link/V2", ("0483", "374b"): "ST-Link/V2-1", ("0483", "3752"): "ST-Link/V2-1",
    ("0483", "374e"): "ST-Link/V3", ("0483", "374f"): "ST-Link/V3", ("0483", "3753"): "ST-Link/V3",
    ("0483", "3754"): "ST-Link/V3", ("0483", "5740"): "STM32 USB CDC",
    ("0d28", "0204"): "CMSIS-DAP", ("2e8a", "000c"): "Raspberry Pi Debug Probe",
}
VENDORS = {"1a86": "WCH", "10c4": "Silicon Labs", "0403": "FTDI", "303a": "Espressif",
           "0483": "STMicroelectronics", "1366": "SEGGER", "0d28": "Arm", "2e8a": "Raspberry Pi"}
PROBES = {("0483", p) for p in ("3748", "374b", "3752", "374e", "374f", "3753", "3754")} \
    | {("0d28", "0204"), ("2e8a", "000c")}
FOR_ESP32 = {"1a86", "10c4", "0403", "303a"}


def _read(p: Path) -> str | None:
    try:
        return p.read_text().strip() or None
    except OSError:
        return None


def _usb_of(dev: Path) -> Path | None:
    """The USB device a tty hangs off: the nearest parent with an idVendor."""
    try:
        p = dev.resolve()
    except OSError:
        return None
    while p != p.parent and str(p).startswith(str(SYS)):
        if (p / "idVendor").exists():
            return p
        p = p.parent
    return None


def _describe(usb: Path) -> dict:
    vid, pid = _read(usb / "idVendor") or "", _read(usb / "idProduct") or ""
    name = USB_NAMES.get((vid, pid)) or ("J-Link" if vid == "1366" else None)
    return {"usb": f"{vid}:{pid}", "name": name or _read(usb / "product") or "USB serial",
            "vendor": VENDORS.get(vid) or _read(usb / "manufacturer"),
            "product": _read(usb / "product"), "serial": _read(usb / "serial"),
            "bus": usb.name,
            "for": "stm32" if (vid, pid) in PROBES or vid == "1366" else
                   "esp32" if vid in FOR_ESP32 else None}


def list_ports() -> list[dict]:
    """Serial ports on USB and programming probes, as {id, kind, ...}.

    kind "serial": a tty, id its /dev path - what the monitor opens and an
    ESP32 is flashed through. kind "probe": an SWD probe, id "usb:<bus>" -
    what an STM32 is flashed through. REDLINE_SERIAL_EXTRA (comma separated
    paths) adds ports that are not on USB, a pty for trying things out."""
    out: list[dict] = []
    by_id: dict[str, str] = {}
    serial_dir = Path("/dev/serial/by-id")
    if serial_dir.is_dir():
        for p in serial_dir.iterdir():
            try:
                by_id[str(p.resolve())] = p.name
            except OSError:
                pass
    ttys = SYS / "class" / "tty"
    seen_usb: set[str] = set()
    for t in sorted(ttys.iterdir()) if ttys.is_dir() else []:
        usb = _usb_of(t / "device") if (t / "device").exists() else None
        if usb is None:
            continue                       # the machine's own UARTs, consoles
        path = f"/dev/{t.name}"
        seen_usb.add(usb.name)
        out.append({"id": path, "kind": "serial", "path": path, **_describe(usb),
                    "by_id": by_id.get(path),
                    "access": os.access(path, os.R_OK | os.W_OK)})
    usbs = SYS / "bus" / "usb" / "devices"
    for dev in sorted(usbs.iterdir()) if usbs.is_dir() else []:
        if ":" in dev.name:
            continue                       # an interface, not a device
        vid, pid = _read(dev / "idVendor"), _read(dev / "idProduct")
        if (vid, pid) in PROBES or vid == "1366":
            out.append({"id": f"usb:{dev.name}", "kind": "probe", "path": None,
                        **_describe(dev), "by_id": None, "access": True})
    for extra in filter(None, (os.environ.get("REDLINE_SERIAL_EXTRA") or "").split(",")):
        extra = extra.strip()
        if extra and Path(extra).exists() and extra not in {p["id"] for p in out}:
            out.append({"id": extra, "kind": "serial", "path": extra, "usb": None,
                        "name": "extra port", "vendor": None, "product": None, "serial": None,
                        "bus": None, "for": None, "by_id": None,
                        "access": os.access(extra, os.R_OK | os.W_OK)})
    return out


def port_named(port: str, kind: str | None = None) -> dict:
    """The listed port with this id, or a 400. Never an arbitrary path."""
    for p in list_ports():
        if p["id"] == port and (kind is None or p["kind"] == kind):
            return p
    what = "serial port" if kind == "serial" else "probe" if kind == "probe" else "port"
    raise HTTPException(400, f"{port!r} is not a {what} that is plugged in - pick one from the list")


# ---------------- the serial monitor ----------------
def _baud_const(baud: int) -> int:
    c = getattr(termios, f"B{baud}", None)
    if c is None:
        raise ValueError(f"{baud} baud is not a rate this machine's tty driver has")
    return c


class HostLink:
    """A tty opened on the host: termios, raw 8N1."""

    where = "host"

    def __init__(self, path: str, baud: int):
        self.path, self.baud, self.fd = path, baud, -1

    async def open(self) -> None:
        fd = os.open(self.path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            tty.setraw(fd)
            a = termios.tcgetattr(fd)
            speed = _baud_const(self.baud)
            a[2] = (a[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB | termios.HUPCL)) \
                | termios.CS8 | termios.CLOCAL | termios.CREAD
            a[4] = a[5] = speed
            termios.tcsetattr(fd, termios.TCSANOW, a)
        except (termios.error, ValueError, OSError):
            os.close(fd)
            raise
        self.fd = fd

    async def read(self) -> bytes:
        loop = asyncio.get_running_loop()
        while True:
            try:
                data = os.read(self.fd, 4096)
            except BlockingIOError:
                ready = loop.create_future()
                loop.add_reader(self.fd, lambda: ready.done() or ready.set_result(None))
                try:
                    await ready
                finally:
                    loop.remove_reader(self.fd)
                continue
            if not data:
                raise EOFError("the port closed")
            return data

    async def write(self, data: bytes) -> None:
        while data:
            try:
                n = os.write(self.fd, data)
                data = data[n:]
            except BlockingIOError:
                await asyncio.sleep(0.01)

    async def close(self) -> None:
        if self.fd >= 0:
            try:
                asyncio.get_running_loop().remove_reader(self.fd)
            except Exception:                                  # noqa: BLE001
                pass
            os.close(self.fd)
            self.fd = -1


# Run in the Embedded image: stdin to the port, the port to stdout.
BRIDGE = r"""
import os, sys, threading, serial
s = serial.Serial(sys.argv[1], int(sys.argv[2]), timeout=0.05)
def up():
    while True:
        d = os.read(0, 4096)
        if not d:
            os._exit(0)
        s.write(d)
threading.Thread(target=up, daemon=True).start()
o = sys.stdout.buffer
while True:
    d = s.read(4096)
    if d:
        o.write(d); o.flush()
"""


class ContainerLink:
    """A tty the person may not open: read in the Embedded image, as root
    with only that device passed through."""

    where = "container"

    def __init__(self, path: str, baud: int):
        self.path, self.baud = path, baud
        self.proc: asyncio.subprocess.Process | None = None
        self.name = f"redline-serial-{uuid.uuid4().hex[:8]}"

    async def open(self) -> None:
        if not await asyncio.to_thread(sandbox.have_image, "embedded"):
            raise OSError(f"{self.path} is not yours to open (join the dialout group), and "
                          f"the Embedded image that could is not built: {sandbox.build_hint('embedded')}")
        argv = sandbox.argv("embedded", ["python3", "-u", "-c", BRIDGE, self.path, str(self.baud)],
                            name=self.name,
                            extra=["-i", "--user", "0:0", "--device", self.path])
        self.proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT)

    async def read(self) -> bytes:
        assert self.proc and self.proc.stdout
        data = await self.proc.stdout.read(4096)
        if not data:
            raise EOFError("the port closed")
        return data

    async def write(self, data: bytes) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(data)
        await self.proc.stdin.drain()

    async def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            await asyncio.to_thread(subprocess.run, ["docker", "kill", self.name],
                                    capture_output=True, timeout=20)
            try:
                await asyncio.wait_for(self.proc.wait(), 10)
            except asyncio.TimeoutError:
                self.proc.kill()
        self.proc = None


def link_for(path: str, baud: int):
    """On the host when the port is the person's to open; else in the image."""
    if os.access(path, os.R_OK | os.W_OK):
        return HostLink(path, baud)
    return ContainerLink(path, baud)


def frame(event: str, data: dict) -> str:
    """One Server-Sent Event. JSON keeps a line's own newlines out of it."""
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


class Monitor:
    """One port's reader, and everyone watching it."""

    def __init__(self, hub: "Hub", port: str, baud: int):
        self.hub, self.port, self.baud = hub, port, baud
        self.subs: set[asyncio.Queue] = set()
        self.backlog: deque[dict] = deque(maxlen=BACKLOG)
        self.n = 0
        self.state, self.why = "opening", None
        self.link = None
        self.where: str | None = None
        self.paused = False
        self.task: asyncio.Task | None = None
        self.idle_since: float | None = None
        self._wake = asyncio.Event()

    # -- viewers
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.subs.add(q)
        self.idle_since = None
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subs.discard(q)
        if not self.subs:
            self.idle_since = time.monotonic()
            self.hub.watch()

    def _send(self, event: str, data: dict) -> None:
        for q in list(self.subs):
            try:
                q.put_nowait((event, data))
            except asyncio.QueueFull:
                pass                       # a viewer that stopped reading loses lines, not the port

    def line(self, text: str, dir: str = "rx") -> dict:
        self.n += 1
        entry = {"n": self.n, "t": round(time.time() * 1000), "dir": dir, "text": text}
        self.backlog.append(entry)
        self._send("line", entry)
        return entry

    def status(self) -> dict:
        return {"port": self.port, "baud": self.baud, "state": self.state, "why": self.why,
                "where": self.where, "viewers": len(self.subs)}

    def _set(self, state: str, why: str | None = None) -> None:
        self.state, self.why = state, why
        self._send("state", self.status())

    # -- the port
    def start(self) -> None:
        if not self.task or self.task.done():
            self.task = asyncio.create_task(self._run(), name=f"serial:{self.port}")

    async def _run(self) -> None:
        while True:
            if self.paused:
                self._wake.clear()
                await self._wake.wait()
                continue
            self._set("opening")
            self.link = link_for(self.port, self.baud)
            try:
                await self.link.open()
            except (OSError, ValueError, termios.error) as exc:
                self.link = None
                self._set("error", str(exc))
                self._wake.clear()
                try:
                    await asyncio.wait_for(self._wake.wait(), 3)
                except asyncio.TimeoutError:
                    pass
                continue
            self.where = self.link.where
            self._set("open")
            self._wake.clear()
            try:
                await self._pump()
            except (OSError, EOFError) as exc:
                self._set("error", str(exc) or "the port went away")
                await asyncio.sleep(1)
            finally:
                if self.link:
                    await self.link.close()
                    self.link = None

    async def _pump(self) -> None:
        """Bytes into lines until paused, re-tuned or closed."""
        part = b""
        link = self.link
        read: asyncio.Task | None = None
        waker = asyncio.create_task(self._wake.wait())
        try:
            while True:
                if read is None:
                    read = asyncio.create_task(link.read())
                done, _ = await asyncio.wait({read, waker}, timeout=FLUSH_S,
                                             return_when=asyncio.FIRST_COMPLETED)
                if waker in done:
                    break                  # pause or a new baud: let go of the port
                if read in done:
                    data, read = read.result(), None
                    part += data
                    *lines, part = re.split(rb"\r?\n", part)
                    for ln in lines:
                        self.line(ln.decode("utf-8", "replace").rstrip("\r"))
                    while len(part) > LINE_MAX:
                        self.line(part[:LINE_MAX].decode("utf-8", "replace"))
                        part = part[LINE_MAX:]
                elif part:                 # quiet: a prompt with no newline still shows
                    self.line(part.decode("utf-8", "replace").rstrip("\r"))
                    part = b""
        finally:
            for t in (read, waker):
                if t and not t.done():
                    t.cancel()
                    try:
                        await t
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001
                        pass
            if part:
                self.line(part.decode("utf-8", "replace").rstrip("\r"))

    def retune(self, baud: int) -> None:
        if baud != self.baud:
            self.baud = baud
            self._wake.set()

    def pause(self, why: str) -> None:
        self.paused = True
        self._wake.set()
        self._set("paused", why)

    def resume(self) -> None:
        self.paused = False
        self._wake.set()

    async def write(self, text: str) -> None:
        if self.paused:
            raise HTTPException(409, f"{self.port} is busy: {self.why or 'paused'}")
        if not self.link or self.state != "open":
            raise HTTPException(409, f"{self.port} is not open ({self.why or self.state})")
        await self.link.write(text.encode())
        self.line(text.rstrip("\r\n"), "tx")

    async def stop(self) -> None:
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):        # noqa: BLE001
                pass
        if self.link:
            await self.link.close()
            self.link = None
        self.state = "closed"


class Hub:
    """The monitors of this process, one per port."""

    def __init__(self, idle_s: float = IDLE_S):
        self.idle_s = idle_s
        self.monitors: dict[str, Monitor] = {}
        self.paused: dict[str, str] = {}           # port -> why, for monitors not yet made
        self._watcher: asyncio.Task | None = None

    def get(self, port: str, baud: int) -> Monitor:
        m = self.monitors.get(port)
        if m is None:
            m = self.monitors[port] = Monitor(self, port, baud)
            if port in self.paused:
                m.pause(self.paused[port])
            m.start()
        else:
            m.retune(baud)
        return m

    def pause(self, port: str, why: str) -> None:
        self.paused[port] = why
        if port in self.monitors:
            self.monitors[port].pause(why)

    def resume(self, port: str) -> None:
        self.paused.pop(port, None)
        if port in self.monitors:
            self.monitors[port].resume()

    def watch(self) -> None:
        if self._watcher and not self._watcher.done():
            return

        async def loop():
            while any(m.idle_since is not None for m in self.monitors.values()):
                await asyncio.sleep(min(1.0, self.idle_s / 4))
                await self.sweep()

        self._watcher = asyncio.create_task(loop(), name="serial:watch")

    async def sweep(self) -> None:
        now = time.monotonic()
        for port, m in list(self.monitors.items()):
            if not m.subs and m.idle_since is not None and now - m.idle_since >= self.idle_s:
                self.monitors.pop(port, None)
                await m.stop()


HUB = Hub()


async def sse(mon: Monitor, q: asyncio.Queue, request: Request | None = None, limit: int = 0):
    """The stream one viewer reads: a hello with what came before, then
    lines and state changes as they happen, a comment now and then."""
    sent = 0
    try:
        yield frame("hello", {**mon.status(), "backlog": list(mon.backlog)})
        while True:
            if request is not None and await request.is_disconnected():
                return
            try:
                event, data = await asyncio.wait_for(q.get(), KEEPALIVE_S)
            except asyncio.TimeoutError:
                yield ": still here\n\n"
                continue
            yield frame(event, data)
            if event == "line":
                sent += 1
                if limit and sent >= limit:
                    return
    finally:
        mon.unsubscribe(q)


# ---------------- flashing ----------------
PCT = re.compile(r"\(\s*(\d{1,3})\s*%\s*\)|\b(\d{1,3})\s*%")


class FlashJob:
    def __init__(self, app_id: str, port: dict, erase: bool, target: str):
        self.id = uuid.uuid4().hex[:10]
        self.app, self.port, self.erase, self.target = app_id, port, erase, target
        self.state = "running"
        self.lines: list[str] = []
        self.pct: int | None = None
        self.stage: str | None = None
        self.started, self.ended = store.now(), None
        self.rc: int | None = None
        self.command: str | None = None
        self.task: asyncio.Task | None = None

    def add(self, text: str) -> None:
        text = text.rstrip()
        if not text:
            return
        if len(self.lines) >= 3000:
            del self.lines[:1000]
        self.lines.append(text[:LINE_MAX])
        m = PCT.search(text)
        if m:
            self.pct = min(100, int(m.group(1) or m.group(2)))
        low = text.lower()
        for key, stage in (("erasing", "erasing"), ("chip erase", "erasing"), ("connecting", "connecting"),
                           ("writing at", "writing"), ("programming", "writing"),
                           ("verif", "verifying"), ("hard resetting", "resetting")):
            if key in low:
                self.stage = stage
                break

    def view(self, since: int = 0) -> dict:
        return {"id": self.id, "app": self.app, "port": self.port["id"], "erase": self.erase,
                "target": self.target, "state": self.state, "pct": self.pct, "stage": self.stage,
                "started": self.started, "ended": self.ended, "rc": self.rc,
                "command": self.command, "n": len(self.lines), "lines": self.lines[since:]}


JOBS: dict[str, FlashJob] = {}


def flash_command(app: dict, target: str, port: dict, erase: bool) -> tuple[str, list[str]]:
    """firmware.flash's command and devices, with an erase in front when asked."""
    out_dir = firmware.build_dir(app["_id"])
    fw = app.get("firmware") or {}
    elf = out_dir / fw.get("elf", "")
    tty_path = port["path"] if port["kind"] == "serial" else None
    cmd = (app.get("flash") or firmware.DEFAULT_FLASH[target]).replace(
        "$BUILD", str(out_dir)).replace("$ELF", str(elf)).replace("$PORT", tty_path or "")
    if erase:
        if target == "esp32" and re.search(r"idf\.py\b.*\sflash\s*$", cmd):
            cmd = re.sub(r"\sflash\s*$", " erase-flash flash", cmd)
        elif target == "esp32":
            cmd = f"esptool.py -p {tty_path} erase_flash && {cmd}"
        else:
            cmd = f"st-flash --connect-under-reset erase && {cmd}"
    devices = ["--device", tty_path] if tty_path else []
    if target == "stm32" or port["kind"] == "probe":
        devices += ["--device", "/dev/bus/usb"]
    return cmd, devices


def flash_argv(app: dict, cmd: str, devices: list[str], name: str) -> list[str]:
    """The docker line that runs it: as root in there, the board passed through."""
    if not sandbox.have_image("embedded"):
        raise sandbox.NoImage(f"the embedded image ({sandbox.image_of('embedded')}) is not built: "
                              f"{sandbox.build_hint('embedded')}")
    return sandbox.argv("embedded", ["bash", "-c", cmd], repo=app["repo"],
                        workdir=apps.workdir(app), name=name,
                        extra=["--user", "0:0", *devices])


async def _run_flash(db, job: FlashJob, app: dict, argv: list[str], name: str,
                     timeout: float = 600) -> None:
    serial_port = job.port["path"] if job.port["kind"] == "serial" else None
    if serial_port:
        HUB.pause(serial_port, "flashing")
    t0 = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        part = b""

        async def pump():
            nonlocal part
            assert proc.stdout
            while True:
                data = await proc.stdout.read(1024)
                if not data:
                    break
                part += data
                *done, part = re.split(rb"\r\n|\r|\n", part)
                for ln in done:
                    job.add(ln.decode("utf-8", "replace"))
            await proc.wait()

        try:
            await asyncio.wait_for(pump(), timeout)
            job.rc = proc.returncode
        except asyncio.TimeoutError:
            await asyncio.to_thread(subprocess.run, ["docker", "kill", name], capture_output=True)
            proc.kill()
            await proc.wait()
            job.add(f"(stopped after {timeout:.0f} s)")
            job.rc = -9
        if part:
            job.add(part.decode("utf-8", "replace"))
    except Exception as exc:                                   # noqa: BLE001
        job.add(f"could not run: {exc}")
        job.rc = -1
    finally:
        job.state = "done" if job.rc == 0 else "failed"
        if job.rc == 0:
            job.pct = 100
        job.ended = store.now()
        if serial_port:
            HUB.resume(serial_port)
    wall = round(time.monotonic() - t0, 2)
    result = {"at": job.ended, "ok": job.rc == 0, "rc": job.rc, "target": job.target,
              "port": serial_port or job.port["id"], "command": job.command, "wall_s": wall}
    try:
        await compute.record(db, "flash", await compute.current_revision(db, "embedded"),
                             model=app["_id"], rc=job.rc, wall_s=wall, where="container")
    except Exception:                                          # noqa: BLE001
        pass
    try:
        log = "\n".join(job.lines)
        await db[apps.APPS].update_one({"_id": app["_id"]}, {"$set": {
            "flashed": result, "firmware_log": (app.get("firmware_log") or "")[-6000:]
            + f"\n$ {job.command}\n" + log[-6000:]}})
    except Exception:                                          # noqa: BLE001
        pass
    await _say(f"{app['_id']}: programmed the {job.target} on {result['port']} "
                  + ("- done" if result["ok"] else "FAILED"),
               "done" if result["ok"] else "error")


# ---------------- what the view draws ----------------
def image_of(app: dict) -> dict | None:
    """The last build, as the thing that would be flashed."""
    fw = app.get("firmware") or {}
    if not fw.get("ok"):
        return None
    target = firmware.target_of(app)
    out_dir = firmware.build_dir(app["_id"])
    elf = fw.get("elf") or ""
    info = {"name": Path(elf).stem or app["_id"], "elf": elf, "at": fw.get("at"),
            "target": target, "chip": None, "flash_size": None, "bytes": None}
    fa = out_dir / "flasher_args.json"
    if fa.is_file():
        try:
            d = json.loads(fa.read_text())
            info["chip"] = (d.get("extra_esptool_args") or {}).get("chip")
            info["flash_size"] = (d.get("flash_settings") or {}).get("flash_size")
            binf = out_dir / ((d.get("app") or {}).get("file") or "")
            if binf.is_file():
                info["bytes"] = binf.stat().st_size
        except (OSError, ValueError):
            pass
    if not info["flash_size"]:
        regions = ((fw.get("summary") or {}).get("regions")) or []
        f = next((r for r in regions if r["name"].upper() == "FLASH"), None)
        if f:
            info["flash_size"] = f"{round(f['size'] / 1024)} KB" if f["size"] < 2 ** 20 \
                else f"{f['size'] / 2 ** 20:g} MB"
            info["bytes"] = f["used"]
    return info


EN_PIN = re.compile(r"(?i)^(EN|CHIP_PU)$")
BOOT_PIN = re.compile(r"(?i)^(GPIO0|IO0)$")
EN_NET = re.compile(r"(?i)(^|[_\-/])(EN|CHIP_PU)$")
BOOT_NET = re.compile(r"(?i)(^|[_\-/])(G?P?IO0|BOOT)$")
DTR_RTS = re.compile(r"(?i)(^|[_\-/])n?(DTR|RTS)$")


async def board_note(db, app: dict) -> dict | None:
    """What the linked board's netlist says about programming it: an ESP32
    whose EN and IO0 are driven by transistors from a USB bridge's DTR and
    RTS goes into download mode by itself. None when that cannot be read."""
    from backend import ato
    from backend.sim import board as simboard, service
    bid = app.get("board")
    if not bid:
        return None
    note: dict = {"board": bid, "title": None, "usb": None, "auto": None}
    try:
        doc = await db[ato.BOARDS].find_one({"_id": bid}, {"title": 1})
        note["title"] = (doc or {}).get("title")
        graph = json.loads(await store.get_artifact(db, bid, "graph", ato.BOARDS))
    except Exception:                                          # noqa: BLE001
        return note
    comps = {c["ref"]: c for c in graph.get("components", [])}
    for c in comps.values():
        fp = (c.get("footprint") or "").upper()
        if "USB" in fp:
            note["usb"] = "USB-C" if ("TYPE-C" in fp or "USB-C" in fp) else \
                "micro-USB" if "MICRO" in fp else "USB"
            break
    if firmware.target_of(app) != "esp32":
        return note
    nets = {n["name"]: n.get("nodes") or [] for n in graph.get("nets", [])}
    net_of = {(nd["ref"], str(nd["pin"])): name for name, nodes in nets.items() for nd in nodes}
    try:
        catalog = service.load_catalog()
        mcu = service._mcu_component(graph, catalog)
    except Exception:                                          # noqa: BLE001
        mcu = None
    if not mcu:
        return note
    names: dict = {}
    code = next(iter(simboard.LCSC.findall(simboard._text(mcu))), None)
    if not code:
        entry = next((m for m in catalog.get("mcus", []) if simboard._matches(mcu, m["match"])), {})
        code = entry.get("symbol")
    if code:
        try:
            names = await asyncio.wait_for(simboard.mcu_pin_names(db, code), 8)
        except Exception:                                      # noqa: BLE001
            names = {}
    mine = {pad: net for (ref, pad), net in net_of.items() if ref == mcu["ref"]}

    def mcu_net(pin_re: re.Pattern, net_re: re.Pattern) -> str | None:
        for pad, net in mine.items():
            if names.get(pad) and pin_re.match(names[pad]):
                return net
        return next((n for n in mine.values() if net_re.search(n)), None)

    en, io0 = mcu_net(EN_PIN, EN_NET), mcu_net(BOOT_PIN, BOOT_NET)
    if not en or not io0:
        return note

    def through(net: str, me: str) -> set[str]:
        """Nets reached from `net`: itself, and across one 2-pad resistor."""
        out = {net}
        for nd in nets.get(net, []):
            r = nd["ref"]
            if r != me and re.match(r"^R\d+$", r):
                pads = [p for (ref, p) in net_of if ref == r]
                if len(pads) == 2:
                    out.add(net_of[(r, next(p for p in pads if p != str(nd["pin"])))])
        return out

    def driver(net: str) -> tuple[str, set[str]] | None:
        """A transistor on this net whose other pins reach DTR or RTS."""
        for nd in nets.get(net, []):
            q = nd["ref"]
            if not re.match(r"^Q\d+$", q):
                continue
            hits = {n for (ref, pad), other in net_of.items() if ref == q and other != net
                    for n in through(other, q) if DTR_RTS.search(n)}
            if hits:
                return q, hits
        return None

    d_en, d_io0 = driver(en), driver(io0)
    if not d_en or not d_io0 or d_en[0] == d_io0[0]:
        return note
    lines = d_en[1] | d_io0[1]
    if len(lines) < 2:
        return note                        # one line cannot hold EN and IO0 apart
    bridge = None
    for ref in {nd["ref"] for ln in lines for nd in nets.get(ln, [])}:
        if not re.match(r"^[QR]\d+$", ref) and all(any(nd["ref"] == ref for nd in nets[ln]) for ln in lines):
            bridge = ref
            break
    note["auto"] = {"en": d_en[0], "io0": d_io0[0], "en_net": en, "io0_net": io0,
                    "bridge": bridge, "lines": sorted(lines)}
    return note


def _sim_uart(app_id: str) -> dict | None:
    """The last simulation's transcript, when there is one in this process."""
    from backend.sim import service
    s = service.SIMS.get(app_id)
    if not s:
        return None
    snap = service.SIMS.snapshot(app_id, touch=False)
    if not snap.get("uart"):
        return None
    return {"state": snap.get("state"), "started": snap.get("started"), "uart": snap["uart"]}


# ---------------- routes ----------------
async def _app(app_id: str) -> dict:
    a = await _db()[apps.APPS].find_one({"_id": app_id})
    if not a:
        raise HTTPException(404, f"no app {app_id!r}")
    if (a.get("platform") or "web") != "embedded":
        raise HTTPException(400, f"{app_id} is a {a.get('platform') or 'web'} app, not firmware")
    return a


@router.get("/{app_id}/ports")
async def ports(app_id: str):
    """Serial ports and probes plugged into this machine."""
    await _app(app_id)
    return await asyncio.to_thread(list_ports)


@router.get("/{app_id}/device")
async def device(app_id: str):
    """Everything the Device view draws at once."""
    a = await _app(app_id)
    job = JOBS.get(app_id)
    mons = [m.status() for m in HUB.monitors.values()]
    return {"app": app_id, "target": firmware.target_of(a),
            "ports": await asyncio.to_thread(list_ports),
            "image": image_of(a), "board": await board_note(_db(), a),
            "flash": job.view(max(0, len(job.lines) - 60)) if job else None,
            "flashed": a.get("flashed"), "monitors": mons,
            "sim": _sim_uart(app_id), "bauds": list(BAUDS)}


class FlashBody(BaseModel):
    port: str = Field(min_length=1, max_length=256)
    erase: bool = False


@router.post("/{app_id}/flash")
async def flash(app_id: str, body: FlashBody):
    """Program the board on this port with the last build. A job: its
    lines and percent are read from GET flash while it runs."""
    a = await _app(app_id)
    fw = a.get("firmware") or {}
    if not fw.get("ok"):
        raise HTTPException(400, "nothing built to program - build it first")
    target = firmware.target_of(a)
    port = port_named(body.port)
    if target == "esp32" and port["kind"] != "serial":
        raise HTTPException(400, "an ESP32 is programmed through its serial port, not a probe")
    old = JOBS.get(app_id)
    if old and old.state == "running":
        raise HTTPException(409, "a flash of this app is already running")
    if any(j.state == "running" and j.port["id"] == port["id"] for j in JOBS.values()):
        raise HTTPException(409, f"{port['id']} is being flashed already")
    cmd, devices = flash_command(a, target, port, body.erase)
    name = f"redline-flash-{uuid.uuid4().hex[:8]}"
    try:
        argv = await asyncio.to_thread(flash_argv, a, cmd, devices, name)
    except sandbox.NoImage as exc:
        raise HTTPException(503, str(exc))
    job = FlashJob(app_id, port, body.erase, target)
    job.command = cmd
    job.add(f"$ {cmd}")
    JOBS[app_id] = job
    job.task = asyncio.create_task(_run_flash(_db(), job, a, argv, name), name=f"flash:{app_id}")
    return job.view()


@router.get("/{app_id}/flash")
async def flash_state(app_id: str, since: int = 0):
    """The app's current or last flash job; lines from `since` on."""
    await _app(app_id)
    job = JOBS.get(app_id)
    return job.view(max(0, since)) if job else None


@router.get("/{app_id}/serial/stream")
async def serial_stream(app_id: str, request: Request, port: str, baud: int = 115200,
                        limit: int = 0):
    """Lines read from the port as Server-Sent Events: `hello` (state and
    the lines so far), `line` {n, t, dir, text}, `state`. `limit` ends the
    stream after that many lines (for tests and agents)."""
    await _app(app_id)
    if baud not in BAUDS:
        raise HTTPException(400, f"baud is one of {', '.join(map(str, BAUDS))}")
    p = await asyncio.to_thread(port_named, port, "serial")
    mon = HUB.get(p["path"], baud)
    q = mon.subscribe()
    return StreamingResponse(sse(mon, q, request, limit), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class WriteBody(BaseModel):
    port: str = Field(min_length=1, max_length=256)
    text: str = Field(max_length=WRITE_MAX)


@router.post("/{app_id}/serial/write")
async def serial_write(app_id: str, body: WriteBody):
    """Type into the port. Its monitor has to be open (someone is watching)."""
    await _app(app_id)
    p = await asyncio.to_thread(port_named, body.port, "serial")
    mon = HUB.monitors.get(p["path"])
    if not mon:
        raise HTTPException(409, f"{p['id']} is not open - open its monitor first")
    await mon.write(body.text)
    return {"ok": True, "bytes": len(body.text.encode())}
