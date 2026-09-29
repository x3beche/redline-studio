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


def _idf_size(build_cmd: str) -> str | None:
    """`idf.py ... build` as `idf.py ... size --format json2`."""
    if "idf.py" not in build_cmd or not build_cmd.rstrip().endswith(" build"):
        return None
    return build_cmd.rstrip()[:-len(" build")] + " size --format json2 2>/dev/null"


def parse_idf_size(text: str) -> list[dict]:
    """esp-idf-size's json2: one entry per memory type that is used."""
    try:
        data = json.loads(text[text.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return []
    out = []
    for m in data.get("layout") or []:
        total, used = int(m.get("total") or 0), int(m.get("used") or 0)
        if total and used:
            out.append({"name": m.get("name") or "?", "used": used, "size": total,
                        "pct": round(100 * used / total, 2)})
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
    started = __import__("time").time()
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
            if not regions and target_of(app) == "esp32":
                # ESP-IDF does not print the linker's memory map; its own
                # size tool says the same thing per memory type.
                size_cmd = _idf_size(cmd)
                if size_cmd:
                    rc3, out3, _ = await sandbox.run(
                        "embedded", ["bash", "-c", size_cmd], repo=app["repo"],
                        workdir=apps.workdir(app), timeout=300)
                    if rc3 == 0:
                        regions = parse_idf_size(out3)
            before = (app.get("firmware") or {}).get("summary")
            if not regions and (before or {}).get("regions") and \
                    elf.stat().st_mtime < started:
                # Nothing to relink, so the linker said nothing: the image
                # is the one the last build measured.
                regions = before["regions"]
            summary = summarise(regions, symbols)
            result.update(elf=str(elf.relative_to(out_dir)), summary=summary,
                          before=before)
            await store.put_artifact(db, app["_id"], "firmware", json.dumps(
                {"regions": regions, "symbols": symbols[:600],
                 "summary": summary, "before": before,
                 "at": result["at"]}).encode(), collection=apps.APPS)
            # What fills flash, by owner, archive, file and function, and
            # a line of it on the app's history (the build view).
            sizes = await record_sizes(db, app, out_dir, elf, nm if rc2 == 0 else "",
                                       symbols, regions, result["at"])
            if sizes:
                summary["groups"] = sizes["groups"]
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


# ---------------- what fills flash ----------------
# The build view (backend/embedded/build.py, rooms/fw-build.ts) draws the
# image as the bytes it is made of: whose code, which library, which file,
# which function. Three owners:
#   yours      - the project's own sources
#   framework  - ESP-IDF's components, a vendor HAL, CubeMX's startup
#   runtime    - the C library, libgcc, libstdc++: the compiler's own
# ESP32 is read from esp-idf-size's raw report (the link map, archive by
# archive); STM32 from nm -l, each symbol by the file it was compiled from.
GROUPS = ("yours", "framework", "runtime")
RUNTIME_LIB = re.compile(r"(?:^|/)lib(?:c|m|g|gcc|gcov|stdc\+\+|supc\+\+|nosys|gloss|atomic"
                         r"|c_nano|g_nano|stdc\+\+_nano|supc\+\+_nano)\.a$")
RUNTIME_SRC = re.compile(r"/(?:newlib|libgcc|libgloss|libstdc\+\+-v3|libsupc\+\+|picolibc)/")
VENDOR = re.compile(r"(?:^|/)(?:Drivers|Middlewares|CMSIS|[A-Za-z0-9]+_HAL_Driver)/"
                    r"|(?:^|/)(?:startup_|system_stm32)[^/]*$"
                    r"|_hal(?:_[a-z0-9]+)?\.c$|_ll_[a-z0-9]+\.c$")
# Sections that take RAM and nothing in the image: zeroed, reserved.
NOLOAD = re.compile(r"bss|noinit|reserved|heap|stack", re.I)
STRINGS = "(constant strings)"
KEEP_SYMBOLS = 40          # per file; the rest folded into one block
HISTORY = 10               # build summaries kept on the app


def _json_tail(text: str) -> dict:
    try:
        return json.loads(text[text.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return {}


def _idf_symbol(name: str) -> str:
    """An input section as esp-idf-size names it, as a person would:
    a function's literal pool joins the function, the linker's merged
    string pool is strings, an unnamed section says it is one."""
    if name.startswith(".literal."):
        return name[len(".literal."):] + "()"
    if re.search(r"\.str1\.\d+$", name):
        return STRINGS
    if name.startswith("."):
        return "(unnamed sections)"
    return name


def parse_idf_raw(text: str) -> list[dict]:
    """esp-idf-size --format raw: memory type > section > archive > object
    file > symbol. What goes into the flash image, one row per symbol of
    each object file (its padding as "(padding)")."""
    data = _json_tail(text)
    rows: dict[tuple[str, str, str], int] = {}
    for mem in (data.get("memory_types") or {}).values():
        for sname, sec in (mem.get("sections") or {}).items():
            if NOLOAD.search(sname):
                continue
            for aname, arch in (sec.get("archives") or {}).items():
                for oname, obj in (arch.get("object_files") or {}).items():
                    got = 0
                    for sym, s in (obj.get("symbols") or {}).items():
                        n = int(s.get("size") or 0)
                        if n:
                            k = (aname, oname, _idf_symbol(sym))
                            rows[k] = rows.get(k, 0) + n
                            got += n
                    rest = int(obj.get("size") or 0) - got
                    if rest > 0:
                        k = (aname, oname, "(padding)")
                        rows[k] = rows.get(k, 0) + rest
    return [{"archive": a, "object": o, "symbol": s, "size": n}
            for (a, o, s), n in rows.items()]


def idf_components(build: Path, repo: str | Path) -> dict[str, str]:
    """The project's own components, archive (relative to the build
    directory) -> component directory, from project_description.json."""
    try:
        desc = json.loads((Path(build) / "project_description.json").read_text())
    except (OSError, ValueError):
        return {}
    repo = str(Path(repo).resolve())
    out = {}
    for info in (desc.get("build_component_info") or {}).values():
        d, f = str(info.get("dir") or ""), str(info.get("file") or "")
        if f and (d == repo or d.startswith(repo + "/")):
            try:
                out[os.path.relpath(f, build)] = d
            except ValueError:
                pass
    return out


def idf_group(archive: str, mine: dict[str, str]) -> str:
    if archive in mine:
        return "yours"
    if RUNTIME_LIB.search(archive):
        return "runtime"
    return "framework"


def idf_rows(raw: list[dict], mine: dict[str, str], symbols: list[dict],
             repo: str | Path) -> list[dict]:
    """esp-idf-size's rows, each with its owner, its source file where it
    is the project's, and the line nm found for the function."""
    repo = Path(repo).resolve()
    where = {s["name"]: s for s in symbols if s.get("file")}
    by_base: dict[str, str] = {}
    for s in symbols:
        if s.get("file"):
            by_base.setdefault(os.path.basename(s["file"]), s["file"])
    out = []
    for r in raw:
        a, o, name = r["archive"], r["object"], r["symbol"]
        group = idf_group(a, mine)
        base = re.sub(r"\.(c|cc|cpp|cxx|S|s)?\.?obj$|\.o$", lambda m: "." + m.group(1)
                      if m.group(1) else "", o)
        base = re.sub(r"^lib\w+_a-", "", base)       # newlib's libc_a-vfprintf.o
        src = None
        if group == "yours":
            src = by_base.get(base)
            if not src:
                hit = next(iter(sorted(Path(mine[a]).rglob(base))), None) \
                    if base and mine.get(a) else None
                src = str(hit.resolve().relative_to(repo)) if hit and \
                    hit.resolve().is_relative_to(repo) else None
        if name == STRINGS:
            # One pool for the whole program, filed under whichever object
            # the linker met first: nobody's in particular.
            group, a, o, src = "framework", STRINGS, "merged by the linker", None
        sym = where.get(name[:-2] if name.endswith("()") else name)
        if a.startswith("/"):
            a = os.path.normpath(a)                  # the toolchain's bin/../lib/...
        out.append({"group": group, "archive": a,
                    "archive_label": os.path.basename(a) if a != STRINGS else a,
                    "file": src or o, "file_label": os.path.basename(src) if src
                    else base or o, "symbol": name, "size": r["size"],
                    "src": sym["file"] if sym and group == "yours" else None,
                    "line": sym["line"] if sym and group == "yours" else None})
    return out


def parse_nm_paths(text: str) -> list[dict]:
    """nm -S -l with every path kept, absolute, and aliases (one address,
    several names: the weak IRQ handlers) counted once."""
    seen: set[str] = set()
    out = []
    for line in text.splitlines():
        m = NM.match(line)
        if not m:
            continue
        size, kind = int(m.group(2), 16), m.group(3)
        if not size or kind not in FLASH_TYPES | BOTH_TYPES:
            continue
        if m.group(1) in seen:
            continue
        seen.add(m.group(1))
        out.append({"name": m.group(4), "size": size, "type": kind,
                    "path": os.path.normpath(m.group(5)) if m.group(5) else None,
                    "line": int(m.group(6)) if m.group(6) else None})
    return out


def _runtime_lib(path: str | None) -> str:
    if not path:
        return "C runtime"
    if "/libgcc/" in path:
        return "libgcc"
    if "/libgloss/" in path:
        return "libnosys"
    if "libstdc++" in path or "libsupc++" in path:
        return "libstdc++"
    m = re.search(r"/newlib/(libc|libm)/", path)
    return m.group(1) if m else "C runtime"


def nm_rows(nm: list[dict], repo: str | Path) -> list[dict]:
    """nm's symbols, each with its owner: a file in the project is yours
    (a vendor's HAL or CubeMX's startup in it is framework); the compiler's
    own libraries are runtime, and so is what has no file at all."""
    repo = str(Path(repo).resolve())
    out = []
    for s in nm:
        p, rel = s["path"], None
        if p and (p == repo or p.startswith(repo + "/")):
            rel = p[len(repo) + 1:]
        if rel:
            group = "framework" if VENDOR.search(rel) else "yours"
            archive = os.path.dirname(rel) or "."
            file, label = rel, os.path.basename(rel)
        elif p and not RUNTIME_SRC.search(p) and "gcc" not in p:
            group, archive = "framework", os.path.dirname(p)
            file, label = p, os.path.basename(p)
        else:
            group = "runtime"
            archive = _runtime_lib(p)
            tail = re.search(r"/(?:newlib|libgcc|libgloss)/(.+)$", p or "")
            file = tail.group(1) if tail else (os.path.basename(p) if p else "(no source)")
            label = os.path.basename(file)
        out.append({"group": group, "archive": archive,
                    "archive_label": archive if rel else os.path.basename(archive) or archive,
                    "file": file, "file_label": label, "symbol": s["name"],
                    "size": s["size"], "src": rel if group == "yours" else None,
                    "line": s["line"] if rel and group == "yours" else None})
    return out


def size_tree(rows: list[dict]) -> dict:
    """Rows into flash > owner > archive > file > symbol, each node with
    its bytes, largest first; a file's small symbols folded into one."""
    root: dict = {"name": "flash", "kind": "root", "size": 0, "children": {}}
    for r in rows:
        g = root["children"].setdefault(r["group"], {
            "name": r["group"], "kind": "group", "size": 0, "children": {}})
        a = g["children"].setdefault(r["archive"], {
            "name": r["archive_label"], "path": r["archive"], "kind": "archive",
            "size": 0, "children": {}})
        f = a["children"].setdefault(r["file"], {
            "name": r["file_label"], "path": r["file"], "kind": "file",
            "size": 0, "children": {}})
        s = f["children"].setdefault(r["symbol"], {
            "name": r["symbol"], "kind": "symbol", "size": 0,
            "file": r.get("src"), "line": r.get("line")})
        for node in (root, g, a, f, s):
            node["size"] += r["size"]

    def finish(node: dict) -> dict:
        kids = sorted(node.get("children", {}).values(), key=lambda n: -n["size"])
        if node["kind"] == "file" and len(kids) > KEEP_SYMBOLS:
            rest = kids[KEEP_SYMBOLS:]
            kids = kids[:KEEP_SYMBOLS] + [{
                "name": f"{len(rest)} more", "kind": "rest", "size": sum(k["size"] for k in rest),
                "file": None, "line": None}]
        if "children" in node:
            node["children"] = [finish(k) for k in kids]
        return node

    finish(root)
    order = {g: i for i, g in enumerate(GROUPS)}
    root["children"].sort(key=lambda n: order.get(n["name"], 9))
    return root


def sizes_from(rows: list[dict], tool: str) -> dict:
    """What the build view is given: the tree, and the lists beside it."""
    tree = size_tree(rows)
    groups = {g: 0 for g in GROUPS}
    for n in tree["children"]:
        groups[n["name"]] = n["size"]
    archives = [{"name": a["name"], "path": a["path"], "group": g["name"], "size": a["size"]}
                for g in tree["children"] for a in g["children"]]
    archives.sort(key=lambda a: -a["size"])
    files = []
    top = []
    for g in tree["children"]:
        for a in g["children"]:
            for f in a["children"]:
                if g["name"] == "yours":
                    files.append({"name": f["name"], "path": f["path"], "archive": a["name"],
                                  "size": f["size"]})
                    top += [{"name": s["name"], "size": s["size"], "file": s.get("file"),
                             "line": s.get("line")} for s in f["children"] if s["kind"] == "symbol"]
    files.sort(key=lambda f: -f["size"])
    top.sort(key=lambda s: -s["size"])
    return {"tool": tool, "total": tree["size"], "groups": groups,
            "tree": tree, "archives": archives, "files": files, "top": top[:30]}


def history_entry(at: str, sizes: dict | None, regions: list[dict],
                  commit: str | None = None) -> dict:
    """One build, in a line: what the size change compares."""
    return {"at": at, "commit": commit, "total": (sizes or {}).get("total"),
            "groups": (sizes or {}).get("groups"),
            "regions": [{"name": r["name"], "used": r["used"], "size": r["size"]}
                        for r in regions]}


def push_history(history: list[dict] | None, entry: dict, keep: int = HISTORY) -> list[dict]:
    return [*(history or []), entry][-keep:]


def linker_rest(rows: list[dict], regions: list[dict]) -> list[dict]:
    """What the FLASH region holds beyond the symbols nm sizes: alignment,
    the init tables, .data's copy - the linker's, filed with the runtime."""
    used = next((r["used"] for r in regions if r["name"].upper() == "FLASH"), 0)
    rest = used - sum(r["size"] for r in rows)
    if rest <= 0:
        return rows
    return [*rows, {"group": "runtime", "archive": "linker", "archive_label": "linker",
                    "file": "(padding, tables)", "file_label": "(padding, tables)",
                    "symbol": "(padding, tables)", "size": rest, "src": None, "line": None}]


async def _flash_sizes(app: dict, out_dir: Path, elf: Path, nm_text: str,
                       symbols: list[dict], regions: list[dict]) -> dict | None:
    """What fills flash, owner by owner. None when it cannot be read; the
    build is still a build."""
    if target_of(app) == "esp32":
        mp = elf.with_suffix(".map")
        if not mp.exists():
            found = sorted(out_dir.glob("*.map"))
            mp = found[0] if found else mp
        if not mp.exists():
            return None
        rc, out, _ = await sandbox.run(
            "embedded", ["bash", "-c",
                         f'python -m esp_idf_size --ng --format raw "{mp}" 2>/dev/null'],
            repo=app["repo"], workdir=apps.workdir(app), timeout=300)
        raw = parse_idf_raw(out) if rc == 0 else []
        if not raw:
            return None
        return sizes_from(idf_rows(raw, idf_components(out_dir, app["repo"]), symbols,
                                   app["repo"]), "esp-idf-size")
    rows = nm_rows(parse_nm_paths(nm_text), app["repo"])
    return sizes_from(linker_rest(rows, regions), "nm") if rows else None


async def _head(repo: str) -> str | None:
    import asyncio
    try:
        p = await asyncio.create_subprocess_exec(
            "git", "-C", repo, "rev-parse", "--short", "HEAD",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await p.communicate()
        return out.decode().strip() or None if p.returncode == 0 else None
    except OSError:
        return None


async def record_sizes(db, app: dict, out_dir: Path, elf: Path, nm_text: str,
                       symbols: list[dict], regions: list[dict], at: str) -> dict | None:
    """After a good build: what fills flash into its own artifact, and a
    line of it onto the app's short history."""
    try:
        sizes = await _flash_sizes(app, out_dir, elf, nm_text, symbols, regions)
    except Exception:                                # noqa: BLE001
        sizes = None
    if sizes:
        sizes["at"] = at
        await store.put_artifact(db, app["_id"], "fw-sizes", json.dumps(sizes).encode(),
                                 collection=apps.APPS)
    entry = history_entry(at, sizes, regions, await _head(app["repo"]))
    await db[apps.APPS].update_one({"_id": app["_id"]}, {"$push": {
        "firmware_history": {"$each": [entry], "$slice": -HISTORY}}})
    return sizes
