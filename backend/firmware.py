"""Firmware, as the Embedded Programming room sees it.

A firmware image has no page to photograph. What there is to look at is
what the build made of the source: how full each memory region is, and
what fills it - every function and every table, with the file and line
it was written on. That is drawn as a page of its own, each block tagged
with its source, so a ring round one on the frozen picture says
`Core/Src/main.c:212` the way a ring on a web page says which button.

The build, the reading and the programming all happen in the Embedded
Programming image: ESP-IDF for ESP32, arm-none-eabi and OpenOCD/stlink
for STM32. The build goes to Redline's own cache, never into the
project's tree. Which compiler made an image is read off the ELF itself,
so the right nm reads it.
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path

from . import apps, compute, sandbox, store

ROOT = Path(__file__).resolve().parent.parent
BUILDS = ROOT / ".cache" / "fw"

# What the linker prints with --print-memory-usage:
#            FLASH:      152128 B         2 MB      7.25%
MEM = re.compile(r"^\s*([A-Za-z0-9_]+):\s+(\d+(?:\.\d+)?)\s*([KMG]?B)\s+"
                 r"(\d+(?:\.\d+)?)\s*([KMG]?B)\s+([\d.]+)%\s*$")
UNIT = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}

# nm -S --size-sort -l:  08001234 00000120 T HAL_Init\t/abs/path/file.c:123
NM = re.compile(r"^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([A-Za-z])\s+(\S+)"
                r"(?:\s+(\S+?):(\d+))?\s*$")

# Where a symbol lives, by its nm type: text and read-only data are flash;
# initialised data is in flash and copied to RAM; bss is RAM alone.
FLASH_TYPES = set("TtRrWwVv")
RAM_TYPES = set("BbCc")
BOTH_TYPES = set("Dd")


def build_dir(app_id: str) -> Path:
    return BUILDS / app_id


def parse_memory(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = MEM.match(line)
        if not m:
            continue
        used = float(m.group(2)) * UNIT[m.group(3).upper()]
        size = float(m.group(4)) * UNIT[m.group(5).upper()]
        rows.append({"name": m.group(1), "used": int(used), "size": int(size),
                     "pct": float(m.group(6))})
    return rows


def parse_nm(text: str, repo: str | Path) -> list[dict]:
    """Symbols with a size, largest first, their source made relative to
    the checkout. A symbol from the C library has no line in the project,
    and says so by having none."""
    repo = str(Path(repo).resolve())
    out = []
    for line in text.splitlines():
        m = NM.match(line)
        if not m:
            continue
        size = int(m.group(2), 16)
        if not size:
            continue
        kind = m.group(3)
        where = "flash" if kind in FLASH_TYPES else "ram" if kind in RAM_TYPES \
            else "both" if kind in BOTH_TYPES else None
        if not where:
            continue
        f = m.group(5)
        # CubeMX's projects name files as cmake/stm32cubemx/../../Middlewares/...
        if f:
            f = os.path.normpath(f)
        if f and f.startswith(repo + "/"):
            f = f[len(repo) + 1:]
        elif f:
            f = None                   # outside the project: a library's
        out.append({"name": m.group(4), "size": size, "type": kind,
                    "where": where, "file": f,
                    "line": int(m.group(6)) if m.group(6) and f else None})
    out.sort(key=lambda s: -s["size"])
    return out


def summarise(regions: list[dict], symbols: list[dict]) -> dict:
    flash = sum(s["size"] for s in symbols if s["where"] in ("flash", "both"))
    ram = sum(s["size"] for s in symbols if s["where"] in ("ram", "both"))
    return {"regions": regions, "symbols": len(symbols),
            "flash_bytes": flash, "ram_bytes": ram}


# ---------------- which chip ----------------
# e_machine in the ELF header: what the image was compiled for, and so
# which binutils read it.
MACHINES = {40: "arm", 94: "xtensa", 243: "riscv"}
NM_FOR = {
    "arm": "arm-none-eabi-nm",
    # ESP-IDF 5.2 onwards names one Xtensa toolchain for every chip; older
    # releases one per chip. Whichever the image has.
    "xtensa": "$(command -v xtensa-esp-elf-nm || command -v xtensa-esp32-elf-nm)",
    "riscv": "$(command -v riscv32-esp-elf-nm)",
}


def machine(elf: Path) -> str | None:
    try:
        head = elf.read_bytes()[:20]
    except OSError:
        return None
    if head[:4] != b"\x7fELF":
        return None
    order = "little" if head[5] == 1 else "big"
    return MACHINES.get(int.from_bytes(head[18:20], order))


def target_of(app: dict) -> str:
    """stm32 or esp32: said by the project, or read off its build."""
    if app.get("target") in ("stm32", "esp32"):
        return app["target"]
    return "esp32" if "idf.py" in (app.get("build") or "") else "stm32"


DEFAULT_FLASH = {
    "esp32": "idf.py -B $BUILD -p $PORT flash",
    "stm32": 'openocd -f interface/stlink.cfg -f target/stm32h7x.cfg '
             '-c "program $ELF verify reset exit"',
}


async def build(db, app: dict) -> dict:
    """Build the firmware in the Embedded image and read what came out."""
    if not app.get("build"):
        raise ValueError(f"{app['_id']}: no build command")
    out_dir = build_dir(app["_id"])
    out_dir.mkdir(parents=True, exist_ok=True)
    # The build command names its output directory as $BUILD, so it is
    # Redline's and not the project's.
    cmd = app["build"].replace("$BUILD", str(out_dir))
    rc, log, job = await sandbox.run(
        "embedded", ["bash", "-c", cmd], repo=app["repo"],
        workdir=apps.workdir(app), timeout=900)
    try:
        await compute.record(db, "build", await compute.current_revision(
            db, "embedded"), model=app["_id"], rc=rc, **job)
    except Exception:                                # noqa: BLE001
        pass
    result: dict = {"at": store.now(), "rc": rc, "ok": rc == 0,
                    "wall_s": job.get("wall_s"), "cpu_s": job.get("cpu_s"),
                    "log": log[-12_000:], "command": cmd}
    if rc == 0:
        elf = _find_elf(app, out_dir)
        if not elf:
            result.update(ok=False, why="the build made no .elf")
        else:
            arch = machine(elf) or "arm"
            rc2, nm, _ = await sandbox.run(
                "embedded", ["bash", "-c",
                             f'{NM_FOR[arch]} -S --size-sort -l "{elf}"'],
                repo=app["repo"], timeout=300)
            result["arch"] = arch
            symbols = parse_nm(nm, app["repo"]) if rc2 == 0 else []
            regions = parse_memory(log)
            before = (app.get("firmware") or {}).get("summary")
            summary = summarise(regions, symbols)
            result.update(elf=str(elf.relative_to(out_dir)), summary=summary,
                          before=before)
            await store.put_artifact(db, app["_id"], "firmware", json.dumps(
                {"regions": regions, "symbols": symbols[:600],
                 "summary": summary, "before": before,
                 "at": result["at"]}).encode(), collection=apps.APPS)
    await db[apps.APPS].update_one(
        {"_id": app["_id"]},
        {"$set": {"firmware": {k: v for k, v in result.items() if k != "log"},
                  "firmware_log": result["log"]}})
    return result


# ---------------- boards ----------------
# USB vendor ids worth naming: an ST-Link probe, and Espressif's own
# chips with a USB port (S2, S3, C3...). A classic ESP32 board shows up
# through its USB-serial bridge instead.
PROBES = {"0483": "ST-Link", "303a": "Espressif USB"}
BRIDGES = ("CP210", "Silicon_Labs", "CH340", "1a86", "FTDI", "Espressif",
           "USB_Serial", "wch.cn")


def boards() -> list[dict]:
    """What is plugged in that firmware could go to. Read from /dev and
    /sys on the host - listing files, nothing installed."""
    out: list[dict] = []
    for p in sorted(Path("/dev/serial/by-id").glob("*")) if \
            Path("/dev/serial/by-id").exists() else []:
        name = p.name
        kind = ("stm32" if "STM" in name or "STLink" in name
                else "esp32" if any(b in name for b in BRIDGES) else "serial")
        out.append({"kind": kind, "name": name, "port": str(p.resolve())})
    for dev in sorted(Path("/sys/bus/usb/devices").glob("*")):
        try:
            vid = (dev / "idVendor").read_text().strip()
            pid = (dev / "idProduct").read_text().strip()
        except OSError:
            continue
        if vid in PROBES:
            prod = ""
            try:
                prod = (dev / "product").read_text().strip()
            except OSError:
                pass
            out.append({"kind": "stm32" if vid == "0483" else "esp32",
                        "name": prod or PROBES[vid], "usb": f"{vid}:{pid}",
                        "bus": dev.name})
    return out


async def flash(db, app: dict, port: str | None = None) -> dict:
    """Program the board with the last build, in the Embedded image, with
    the board passed through. As root in there: a probe's USB node is not
    usually the person's to write to on the host."""
    fw = app.get("firmware") or {}
    if not fw.get("ok"):
        raise ValueError("nothing built to program - build it first")
    target = target_of(app)
    out_dir = build_dir(app["_id"])
    elf = out_dir / fw.get("elf", "")
    if not port:
        near = [b for b in boards() if b["kind"] == target and b.get("port")]
        port = near[0]["port"] if near else None
    if target == "esp32" and not port:
        raise ValueError("no ESP32 board is plugged in (no serial port found)")
    if target == "stm32" and not any(b["kind"] == "stm32" for b in boards()):
        raise ValueError("no ST-Link probe is plugged in")
    cmd = (app.get("flash") or DEFAULT_FLASH[target]).replace(
        "$BUILD", str(out_dir)).replace("$ELF", str(elf)).replace("$PORT", port or "")
    devices = ["--device", port] if port else []
    if target == "stm32":
        devices += ["--device", "/dev/bus/usb"]
    rc, log, job = await sandbox.run(
        "embedded", ["bash", "-c", cmd], repo=app["repo"],
        workdir=apps.workdir(app), timeout=600,
        extra=["--user", "0:0", *devices])
    try:
        await compute.record(db, "flash", await compute.current_revision(
            db, "embedded"), model=app["_id"], rc=rc, **job)
    except Exception:                                # noqa: BLE001
        pass
    result = {"at": store.now(), "ok": rc == 0, "rc": rc, "target": target,
              "port": port, "command": cmd, "wall_s": job.get("wall_s")}
    await db[apps.APPS].update_one({"_id": app["_id"]}, {"$set": {
        "flashed": result, "firmware_log": (app.get("firmware_log") or "")[-6000:]
        + f"\n$ {cmd}\n" + log[-6000:]}})
    return {**result, "log": log[-4000:]}


def _find_elf(app: dict, out_dir: Path) -> Path | None:
    if app.get("elf"):
        p = out_dir / app["elf"]
        return p if p.exists() else None
    found = sorted(out_dir.glob("*.elf")) or sorted(out_dir.rglob("*.elf"))
    return found[0] if found else None


# ---------------- the page ----------------
def _kb(n: int) -> str:
    return f"{n / 1024:.1f} kB" if n >= 1024 else f"{n} B"


def page(title: str, data: dict) -> str:
    """The firmware drawn as a page: regions, then what fills flash and
    RAM, file by file. Its own dark palette, like a board on black: this
    is the thing being looked at, not the application's chrome."""
    regions = data.get("regions") or []
    symbols = data.get("symbols") or []
    before = {r["name"]: r for r in ((data.get("before") or {}).get("regions") or [])}

    def bar(r: dict) -> str:
        was = before.get(r["name"])
        delta = ""
        if was and was["used"] != r["used"]:
            d = r["used"] - was["used"]
            delta = f' <b class="{"up" if d > 0 else "down"}">{"+" if d > 0 else "−"}{_kb(abs(d))}</b>'
        return (f'<div class="region" data-src="" data-sym="{html.escape(r["name"])}">'
                f'<span class="rname">{html.escape(r["name"])}</span>'
                f'<span class="track"><span class="fill" style="width:{min(r["pct"], 100):.2f}%"></span></span>'
                f'<span class="rnum">{_kb(r["used"])} / {_kb(r["size"])} · {r["pct"]:.2f}%{delta}</span></div>')

    def column(where: set[str], label: str) -> str:
        mine = [s for s in symbols if s["where"] in where]
        files: dict[str, list[dict]] = {}
        for s in mine:
            files.setdefault(s["file"] or "(libraries)", []).append(s)
        ranked = sorted(files.items(), key=lambda kv: -sum(s["size"] for s in kv[1]))[:18]
        rows = []
        for f, syms in ranked:
            total = sum(s["size"] for s in syms)
            blocks = "".join(
                f'<span class="sym" style="flex:{max(s["size"], 1)}" '
                f'data-src="{html.escape(s["file"] or "")}:{s["line"] or ""}" '
                f'data-sym="{html.escape(s["name"])}" '
                f'title="{html.escape(s["name"])} · {_kb(s["size"])}">'
                f'{html.escape(s["name"][:28])}</span>'
                for s in syms[:14])
            rows.append(f'<div class="file"><div class="fname">{html.escape(f)}'
                        f'<span>{_kb(total)}</span></div>'
                        f'<div class="syms">{blocks}</div></div>')
        return (f'<section><h2>{label} <span>{_kb(sum(s["size"] for s in mine))}'
                f'</span></h2>{"".join(rows)}</section>')

    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>{html.escape(title)} · firmware</title><style>
body{{margin:0;padding:18px 22px;background:#101214;color:#d6dbe0;
font:12px/1.35 'IBM Plex Sans',system-ui,sans-serif}}
h1{{font-size:15px;margin:0 0 12px;font-weight:600}}
h1 span,h2 span{{color:#8b949e;font-weight:400;margin-left:6px}}
h2{{font-size:13px;margin:14px 0 6px;font-weight:600}}
.region{{display:flex;align-items:center;gap:10px;margin:3px 0}}
.rname{{width:74px;font-family:'IBM Plex Mono',monospace}}
.track{{flex:1;height:10px;background:#23272c;border-radius:3px;overflow:hidden}}
.fill{{display:block;height:100%;background:#53a0e3}}
.rnum{{width:250px;text-align:right;font-family:'IBM Plex Mono',monospace;color:#aab2ba}}
.up{{color:#e8a735}} .down{{color:#6fb36f}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}
.file{{margin:0 0 7px}}
.fname{{display:flex;justify-content:space-between;font-family:'IBM Plex Mono',monospace;
font-size:11px;color:#aab2ba;margin-bottom:2px}}
.syms{{display:flex;gap:2px;height:22px}}
.sym{{min-width:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
background:#2b4a66;color:#dfe8f1;border-radius:2px;padding:3px 4px;font-size:10px;
font-family:'IBM Plex Mono',monospace}}
section:last-child .sym{{background:#4d3b5e}}
</style></head><body>
<h1>{html.escape(title)}<span>{html.escape(str(data.get("at") or "")[:19].replace("T", " "))}</span></h1>
{"".join(bar(r) for r in regions) or '<p>no memory map in the build output - link with -Wl,--print-memory-usage</p>'}
<div class="cols">{column({"flash", "both"}, "flash")}{column({"ram", "both"}, "RAM")}</div>
</body></html>"""
