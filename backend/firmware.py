"""Firmware: the code that runs on one of a board's programmable chips.

A board's schematic is drawn in sheets, one per MCU (backend/sheets.py),
and `GET /api/boards/{id}/mcus` says which net every pin of that MCU is
on. A firmware is made from one of those MCUs: it belongs to the board
and to the MCU's ref (U2), remembers the board version it was made
against, and is a PlatformIO project - platformio.ini, src/, include/.

Its files are kept like Files keeps a file: every save is a version, in
`firmware_files` (one document per file per version; a delete is a
document that says so). The tree at a version is, for each path, the last
document at or before it. Sources are small text, so they sit in the
document itself; what a build makes (firmware.bin, .elf) goes to GridFS
(backend/fwbuild.py).

include/pins.h is not written by hand: it is generated from the MCU's
sheet - `#define <NET> <gpio>` for every pin on a signal net, with the
parts on that net as its comment - and written again whenever the board's
schematic is drawn and a pin has moved (`board_changed`, called at the end
of backend/schematic.py `draw`). The firmware then says what changed
("board v6: 2 pins moved, pins regenerated") and is built again.

Both collections belong to the workspace (backend/scope.py).
"""

from __future__ import annotations

import hashlib
import re
import secrets
from pathlib import PurePosixPath

from . import sheets, store

COLL = "firmware"
FILES = "firmware_files"
BUCKET = "firmware_builds"

# What a new firmware is built with. The image (docker/firmware) has this
# platform installed; a firmware asking for another needs the network once.
PLATFORM = "espressif32@6.13.0"
FRAMEWORK = "arduino"
PINS = "include/pins.h"
GENERATED = {PINS}
MAX_FILE = 512 * 1024
MAX_FILES = 200


class Refused(ValueError):
    """A change that is not allowed: pins.h by hand, a path outside the project."""


# ---------------------------------------------------------------- which chip

# MCU -> PlatformIO board, by its name (the LCSC title or part number).
_BOARDS = [
    (re.compile(r"ESP32-?S3", re.I), "esp32-s3-devkitc-1", "ESP32-S3"),
    (re.compile(r"ESP32-?C3", re.I), "esp32-c3-devkitm-1", "ESP32-C3"),
    (re.compile(r"ESP32-?S2", re.I), "esp32-s2-saola-1", "ESP32-S2"),
    (re.compile(r"ESP32", re.I), "esp32dev", "ESP32"),
]


def target_of(mcu: dict) -> dict:
    """The PlatformIO environment for an MCU: platform, board, framework."""
    text = " ".join(str(mcu.get(k) or "") for k in ("title", "part", "sheet"))
    for rx, board, family in _BOARDS:
        if rx.search(text):
            return {"platform": PLATFORM, "board": board, "framework": FRAMEWORK,
                    "env": board, "family": family}
    raise Refused(f"{mcu.get('ref')}: {mcu.get('title') or mcu.get('part')} - only ESP32 "
                  "firmware can be made so far")


# ---------------------------------------------------------------- pins

# ESP32 pins that are not called IOn on the chip or the module.
_ESP32_NAMED = {
    "SENSOR_VP": 36, "SENSOR_CAPP": 37, "SENSOR_CAPN": 38, "SENSOR_VN": 39,
    "VDET_1": 34, "VDET_2": 35, "32K_XP": 32, "32K_XN": 33,
    "MTDI": 12, "MTCK": 13, "MTMS": 14, "MTDO": 15,
    "U0TXD": 1, "TXD0": 1, "TXD": 1, "U0RXD": 3, "RXD0": 3, "RXD": 3,
    "GPIO0": 0, "BOOT": 0,
}
# The module's own SPI flash: on a WROOM these pins are taken.
_ESP32_FLASH = {"SHD/SD2": 9, "SWP/SD3": 10, "SCS/CMD": 11, "SCK/CLK": 6, "SDO/SD0": 7, "SDI/SD1": 8,
                "SD2": 9, "SD3": 10, "CMD": 11, "CLK": 6, "SD0": 7, "SD1": 8}
_GPIO = re.compile(r"^(?:GPIO|IO|GP)_?(\d{1,2})(?:$|[/_ (])", re.I)
# Inputs only: no output driver, no internal pull-up.
ESP32_INPUT_ONLY = {34, 35, 36, 37, 38, 39}
# Pins the chip reads at reset to decide how it boots.
ESP32_STRAPPING = {0, 2, 5, 12, 15}
# Names the Arduino core already uses: a net with one of these names gets
# PIN_ in front, or `static const uint8_t SDA = 21;` stops compiling.
RESERVED = frozenset({
    "TX", "RX", "SDA", "SCL", "SS", "MOSI", "MISO", "SCK", "LED_BUILTIN", "BUILTIN_LED",
    "KEY_BUILTIN", "RX1", "TX1", "RX2", "TX2", "DAC1", "DAC2", "HIGH", "LOW", "INPUT", "OUTPUT",
    "INPUT_PULLUP", "INPUT_PULLDOWN", "OPEN_DRAIN", "PI", "HALF_PI", "TWO_PI", "DEG_TO_RAD",
    "RAD_TO_DEG", "EULER", "SERIAL", "DISPLAY", "DEFAULT", "EXTERNAL", "INTERNAL", "LSBFIRST",
    "MSBFIRST", "CHANGE", "FALLING", "RISING", "ONLOW", "ONHIGH", "BIN", "OCT", "DEC", "HEX",
    "NOT_A_PIN", "NOT_AN_INTERRUPT", "EN", "GND", "VCC", "NULL", "TRUE", "FALSE", "BIT",
    *(f"A{i}" for i in range(20)), *(f"T{i}" for i in range(10)),
})


def gpio_of(name: str) -> int | None:
    """The GPIO number of an ESP32 pin, from the name on the symbol:
    IO21 -> 21, GPIO4 -> 4, SENSOR_VP -> 36, RXD0 -> 3. None for a pin
    that is not a GPIO (EN, 3V3, GND, NC) or is the module's flash."""
    n = (name or "").strip().upper()
    if not n or n in _ESP32_FLASH:
        return None
    if n in _ESP32_NAMED:
        return _ESP32_NAMED[n]
    m = _GPIO.match(n)
    if m:
        return int(m.group(1))
    head = re.split(r"[/ (]", n, 1)[0]
    return _ESP32_NAMED.get(head)


def macro_of(net: str) -> str:
    """A net's name as a C macro: L_SDA stays, 12V_EN is PIN_12V_EN, a
    name the Arduino core has (TX2, SDA) gets PIN_ too."""
    m = re.sub(r"[^A-Za-z0-9]+", "_", (net or "").rsplit(".", 1)[-1]).strip("_").upper()
    if not m:
        return ""
    if m[0].isdigit() or m in RESERVED:
        m = "PIN_" + m
    return m


def pin_rows(mcu: dict) -> list[dict]:
    """Every pin of an MCU with what the Firmware room shows of it: its
    GPIO, its net and the macro pins.h gives it, the parts on the net, and
    what kind of pin it is - gpio, power, ground, flash, nc or other."""
    rows, seen = [], set()
    for p in mcu.get("pins") or []:
        name, net = p.get("name") or "", p.get("net")
        gpio = gpio_of(name)
        if (name or "").strip().upper() in _ESP32_FLASH:
            kind = "flash"
        elif not net:
            kind = "nc"
        elif sheets.ground_name(net) or re.match(r"^(?:GND|VSS)", name.upper()):
            kind = "ground"
        elif sheets.rail_name(net) or re.match(r"^(?:3V3|VDD|VCC|5V|VIN)", name.upper()):
            kind = "power"
        elif gpio is None:
            kind = "other"
        else:
            kind = "gpio"
        macro = macro_of(net) if kind == "gpio" else ""
        dup = bool(macro) and macro in seen
        if macro:
            seen.add(macro)
        rows.append({"number": str(p.get("number")), "name": name, "net": net, "gpio": gpio,
                     "parts": list(p.get("parts") or []), "kind": kind,
                     "macro": "" if dup else macro,
                     "input_only": gpio in ESP32_INPUT_ONLY if gpio is not None else False,
                     "strapping": gpio in ESP32_STRAPPING if gpio is not None else False})
    return rows


def defined(rows: list[dict]) -> dict[str, int]:
    """macro -> gpio, what pins.h defines."""
    return {r["macro"]: r["gpio"] for r in rows if r.get("macro")}


def pins_digest(rows: list[dict]) -> str:
    text = "\n".join(f"{m}={g}" for m, g in sorted(defined(rows).items()))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _parts_text(parts: list[str], limit: int = 8) -> str:
    if not parts:
        return "nothing else on it"
    more = len(parts) - limit
    return ", ".join(parts[:limit]) + (f" +{more}" if more > 0 else "")


def pins_header(board: str, mcu: dict, rows: list[dict]) -> str:
    """include/pins.h: the MCU's pin map as the schematic draws it."""
    ref = mcu.get("ref") or "?"
    lines = [
        "// pins.h - GENERATED from the schematic. Do not edit: it is written again",
        f"// whenever board '{board}' changes. Sheet: {mcu.get('sheet') or ref}.",
        f"// {ref} {mcu.get('title') or mcu.get('part') or ''}".rstrip(),
        "//",
        "// Each signal net on a GPIO is a macro with its GPIO number; the comment",
        "// says which parts share the net. Names that start with a digit, or that",
        "// the Arduino core already uses (TX2, SDA ...), get PIN_ in front.",
        "#pragma once",
        "",
    ]
    width = max([len(r["macro"]) for r in rows if r["macro"]] + [8])
    for r in rows:
        if not r["macro"]:
            continue
        notes = []
        if r["input_only"]:
            notes.append("input only")
        if r["strapping"]:
            notes.append("strapping pin")
        extra = f" ({', '.join(notes)})" if notes else ""
        lines.append(f"#define {r['macro'].ljust(width)} {str(r['gpio']).rjust(2)}  "
                     f"// {r['name']} pin {r['number']}{extra} - {_parts_text(r['parts'])}")
    skipped = [r for r in rows if r["kind"] == "gpio" and not r["macro"]]
    for r in skipped:
        lines.append(f"// {r['name']} (pin {r['number']}) is on {r['net']} too - see above")
    unwired = [r for r in rows if r["kind"] == "nc" and r["gpio"] is not None]
    if unwired:
        lines += ["", "// Not connected on this board: "
                  + ", ".join(f"{r['name']}" for r in unwired)]
    lines.append("")
    return "\n".join(lines)


def diff_pins(old: dict[str, int], new: dict[str, int]) -> dict:
    """What a board change did to the pin map: nets that moved to another
    GPIO, nets that are new, nets that are gone."""
    moved = [{"net": m, "from": old[m], "to": new[m]} for m in sorted(new) if m in old and old[m] != new[m]]
    added = sorted(m for m in new if m not in old)
    removed = sorted(m for m in old if m not in new)
    return {"moved": moved, "added": added, "removed": removed}


def change_text(diff: dict) -> str:
    parts = []
    if diff["moved"]:
        n = len(diff["moved"])
        parts.append(f"{n} pin{'s' if n != 1 else ''} moved")
    if diff["added"]:
        parts.append(f"{len(diff['added'])} new")
    if diff["removed"]:
        parts.append(f"{len(diff['removed'])} gone")
    return ", ".join(parts) or "no pin changed"


def used_in(files: dict[str, str], macros: list[str]) -> dict[str, list[str]]:
    """Which of pins.h's macros the code uses, and where: a macro is used
    when a source file other than pins.h names it as a whole word outside
    a comment."""
    out: dict[str, list[str]] = {m: [] for m in macros}
    if not macros:
        return out
    rx = re.compile(r"\b(" + "|".join(re.escape(m) for m in sorted(macros, key=len, reverse=True)) + r")\b")
    for path, text in files.items():
        if path in GENERATED or not re.search(r"\.(?:c|cc|cpp|cxx|h|hh|hpp|ino)$", path):
            continue
        code = re.sub(r"/\*.*?\*/", " ", text or "", flags=re.S)
        code = re.sub(r"//[^\n]*", " ", code)
        code = re.sub(r'"(?:\\.|[^"\\])*"', '""', code)
        for m in set(rx.findall(code)):
            out[m].append(path)
    return out


# ---------------------------------------------------------------- a new project

def platformio_ini(target: dict, title: str) -> str:
    return "\n".join([
        f"; {title} - PlatformIO project. Built by Redline in docker (redline-firmware),",
        "; offline: the platform and the libraries below are in the image.",
        f"[env:{target['env']}]",
        f"platform = {target['platform']}",
        f"board = {target['board']}",
        f"framework = {target['framework']}",
        "monitor_speed = 115200",
        "build_src_flags = -Wall -Wextra",
        "lib_deps =",
        "",
    ])


def main_cpp(title: str, rows: list[dict]) -> str:
    ins = [r for r in rows if r["macro"]][:3]
    shown = "\n".join(f'  Serial.printf("  %-12s GPIO%d\\n", "{r["macro"]}", {r["macro"]});' for r in ins)
    return "\n".join([
        f"// {title}",
        "#include <Arduino.h>",
        '#include "pins.h"',
        "",
        "void setup() {",
        "  Serial.begin(115200);",
        f'  Serial.println("{title}: up");',
        shown,
        "}",
        "",
        "void loop() {",
        "  delay(1000);",
        "}",
        "",
    ])


def seed(target: dict, title: str, board: str, mcu: dict, rows: list[dict]) -> dict[str, str]:
    return {"platformio.ini": platformio_ini(target, title),
            "src/main.cpp": main_cpp(title, rows),
            PINS: pins_header(board, mcu, rows)}


# ---------------------------------------------------------------- the records

def _clean_path(path: str) -> str:
    p = PurePosixPath((path or "").replace("\\", "/").strip().lstrip("/"))
    parts = [x for x in p.parts if x not in ("", ".")]
    if not parts or any(x == ".." or x.startswith(".pio") for x in parts):
        raise Refused(f"not a path in the project: {path!r}")
    if not all(re.match(r"^[A-Za-z0-9_.+\-]+$", x) for x in parts):
        raise Refused(f"only letters, digits and _ . + - in a path: {path!r}")
    return "/".join(parts)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "fw"


def board_version(doc: dict | None) -> int:
    """What the catalog calls the board's version (its component version)."""
    return int(((doc or {}).get("component") or {}).get("version") or 0)


def mcu_of(doc: dict | None, ref: str) -> dict | None:
    from .schematic import mcus_of
    return next((m for m in mcus_of(doc or {}) if m.get("ref") == ref), None)


def view(fw: dict) -> dict:
    """A firmware as the API answers it."""
    out = {k: v for k, v in fw.items() if k not in ("workspace_id",)}
    out["id"] = fw["_id"]
    return out


async def listing(db, board: str | None = None) -> list[dict]:
    q = {"board": board} if board else {}
    return [view(d) async for d in db[COLL].find(q).sort("title", 1)]


async def get(db, fid: str) -> dict:
    doc = await db[COLL].find_one({"_id": fid})
    if not doc:
        raise KeyError(fid)
    return doc


async def create(db, board_id: str, ref: str, by: dict | None = None) -> tuple[dict, bool]:
    """A firmware for one MCU of a board, seeded as a PlatformIO Arduino
    project. One per MCU: asking again answers the one there is."""
    have = await db[COLL].find_one({"board": board_id, "mcu": ref})
    if have:
        return have, False
    board = await db["boards"].find_one({"_id": board_id})
    if not board:
        raise KeyError(board_id)
    mcu = mcu_of(board, ref)
    if not mcu:
        raise KeyError(f"{board_id} has no MCU {ref} in its schematic (draw the schematic first)")
    target = target_of(mcu)
    rows = pin_rows(mcu)
    title = f"{ref} {target['family']}"
    t = store.now()
    fw = {"_id": secrets.token_hex(6), "title": title, "name": _slug(title), "board": board_id,
          "board_title": board.get("title") or board_id, "folder": board.get("folder") or "",
          "mcu": ref, "mcu_part": mcu.get("part"), "mcu_title": mcu.get("title"),
          "sheet": mcu.get("key"), "sheet_name": mcu.get("sheet"),
          "platform": target["platform"], "pio_board": target["board"],
          "framework": target["framework"], "env": target["env"],
          "board_version": board_version(board), "pins_digest": pins_digest(rows),
          "pins": defined(rows), "version": 0, "created_at": t, "updated_at": t,
          "by": by, "board_change": None, "build": {}}
    await db[COLL].insert_one(fw)
    await save(db, fw["_id"], seed(target, title, board_id, mcu, rows),
               note=f"made from {board_id} {ref} (board v{fw['board_version']})", by=by,
               generated_ok=True)
    return await get(db, fw["_id"]), True


async def _rows(db, fid: str) -> list[dict]:
    return [d async for d in db[FILES].find({"firmware": fid})]


def _tree_of(rows: list[dict], version: int | None = None) -> dict[str, dict]:
    """path -> the file's document at a version (the latest by default)."""
    out: dict[str, dict] = {}
    for d in sorted(rows, key=lambda r: r["version"]):
        if version is not None and d["version"] > version:
            continue
        if d.get("deleted"):
            out.pop(d["path"], None)
        else:
            out[d["path"]] = d
    return out


async def tree(db, fid: str, version: int | None = None) -> list[dict]:
    """The files at a version, sorted folder-first like an IDE."""
    files = _tree_of(await _rows(db, fid), version)
    out = [{"path": p, "bytes": d.get("bytes", 0), "version": d["version"], "at": d.get("at"),
            "generated": bool(d.get("generated")), "sha256": d.get("sha256")}
           for p, d in files.items()]
    out.sort(key=lambda f: (f["path"].count("/") == 0, f["path"].lower()))
    return out


async def contents(db, fid: str, version: int | None = None) -> dict[str, str]:
    return {p: d.get("content") or "" for p, d in _tree_of(await _rows(db, fid), version).items()}


async def read(db, fid: str, path: str, version: int | None = None) -> dict:
    path = _clean_path(path)
    files = _tree_of(await _rows(db, fid), version)
    if path not in files:
        raise KeyError(path)
    d = files[path]
    return {"path": path, "content": d.get("content") or "", "version": d["version"],
            "generated": bool(d.get("generated")), "at": d.get("at"), "by": d.get("by")}


async def save(db, fid: str, changes: dict[str, str | None], note: str = "",
               by: dict | None = None, generated_ok: bool = False) -> dict:
    """One new version: each path given is written (None deletes it).
    pins.h is the schematic's; only the generator writes it."""
    fw = await get(db, fid)
    if not changes:
        raise Refused("nothing to save")
    clean: dict[str, str | None] = {}
    for path, text in changes.items():
        p = _clean_path(path)
        if p in GENERATED and not generated_ok:
            raise Refused(f"{p} is generated from the schematic - change the board, not this file")
        if text is not None and len(text.encode()) > MAX_FILE:
            raise Refused(f"{p} is larger than {MAX_FILE // 1024} kB")
        clean[p] = text
    now_files = _tree_of(await _rows(db, fid))
    if len(set(now_files) | {p for p, t in clean.items() if t is not None}) > MAX_FILES:
        raise Refused(f"a firmware keeps at most {MAX_FILES} files")
    # Only what actually changes: saving the same text is not a version.
    real = {p: t for p, t in clean.items()
            if (t is None and p in now_files) or
               (t is not None and (p not in now_files or now_files[p].get("content") != t))}
    if not real:
        return {"version": fw.get("version") or 0, "changed": []}
    version = (fw.get("version") or 0) + 1
    got = await db[COLL].update_one({"_id": fid, "version": fw.get("version") or 0},
                                    {"$set": {"version": version, "updated_at": store.now()}})
    if getattr(got, "matched_count", 1) == 0:
        raise Refused("saved by someone else meanwhile - read it again")
    t = store.now()
    for p, text in real.items():
        doc = {"_id": secrets.token_hex(8), "firmware": fid, "path": p, "version": version,
               "at": t, "by": by, "note": (note or "")[:500], "generated": p in GENERATED}
        if text is None:
            doc["deleted"] = True
        else:
            raw = text.encode()
            doc.update(content=text, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        await db[FILES].insert_one(doc)
    return {"version": version, "changed": sorted(real)}


async def versions(db, fid: str) -> list[dict]:
    """Every version, newest first: when, who, why, which files."""
    by_v: dict[int, dict] = {}
    for d in await _rows(db, fid):
        v = by_v.setdefault(d["version"], {"version": d["version"], "at": d.get("at"), "by": d.get("by"),
                                           "note": d.get("note") or "", "files": []})
        v["files"].append({"path": d["path"], "deleted": bool(d.get("deleted")),
                           "generated": bool(d.get("generated"))})
    return sorted(by_v.values(), key=lambda v: -v["version"])


async def remove(db, fid: str) -> bool:
    fw = await db[COLL].find_one({"_id": fid})
    if not fw:
        return False
    await db[FILES].delete_many({"firmware": fid})
    await db[COLL].delete_one({"_id": fid})
    return True


async def pins_now(db, fw: dict) -> dict:
    """The MCU's pins as the board draws them now, with whether the code
    uses each one, and whether pins.h still matches the board."""
    board = await db["boards"].find_one({"_id": fw["board"]})
    mcu = mcu_of(board, fw["mcu"])
    rows = pin_rows(mcu) if mcu else []
    files = await contents(db, fw["_id"])
    uses = used_in(files, [r["macro"] for r in rows if r["macro"]])
    serial = sorted(p for p, t in files.items() if p not in GENERATED and re.search(r"\bSerial\s*\.\s*begin\b", t or ""))
    for r in rows:
        r["used_in"] = uses.get(r["macro"], []) if r["macro"] else []
        # UART0 is Serial: the code uses these pins without naming them.
        if r["gpio"] in (1, 3) and not r["used_in"] and serial:
            r["used_in"] = [f"{serial[0]} (Serial)"]
    return {"pins": rows, "board_version": board_version(board), "sheet": (mcu or {}).get("key"),
            "svg": (mcu or {}).get("svg"), "matches": bool(mcu) and pins_digest(rows) == fw.get("pins_digest"),
            "found": bool(mcu)}


async def regenerate(db, fw: dict, board: dict | None = None, *, start_build=None) -> dict | None:
    """Write pins.h again from the board, if the pin map changed. Says what
    changed on the firmware (`board_change`) and starts a build. None when
    nothing about the pins changed."""
    board = board if board is not None else await db["boards"].find_one({"_id": fw["board"]})
    mcu = mcu_of(board, fw["mcu"])
    version = board_version(board)
    if not mcu:
        change = {"at": store.now(), "board_version": version, "from_version": fw.get("board_version"),
                  "text": f"{fw['mcu']} is no longer on the board's schematic", "missing": True,
                  "moved": [], "added": [], "removed": []}
        await db[COLL].update_one({"_id": fw["_id"]}, {"$set": {"board_change": change}})
        return change
    rows = pin_rows(mcu)
    digest = pins_digest(rows)
    if digest == fw.get("pins_digest"):
        if version != fw.get("board_version"):
            await db[COLL].update_one({"_id": fw["_id"]}, {"$set": {"board_version": version}})
        return None
    diff = diff_pins(fw.get("pins") or {}, defined(rows))
    text = f"board v{version} changed, pins regenerated: {change_text(diff)}"
    saved = await save(db, fw["_id"], {PINS: pins_header(fw["board"], mcu, rows)},
                       note=text, by={"type": "system", "id": "schematic"}, generated_ok=True)
    change = {"at": store.now(), "board_version": version, "from_version": fw.get("board_version"),
              "text": text, **diff, "files_version": saved["version"]}
    await db[COLL].update_one({"_id": fw["_id"]}, {"$set": {
        "pins_digest": digest, "pins": defined(rows), "board_version": version,
        "board_change": change}})
    if start_build is not None:
        try:
            await start_build(fw["_id"], text)
        except Exception as exc:                                 # noqa: BLE001 - the pins stand
            change["build_error"] = str(exc)
    return change


async def board_changed(db, board_id: str, *, start_build=None) -> list[dict]:
    """The board's schematic was drawn again: every firmware made from it
    gets its pins.h written again where a pin moved, and a build."""
    board = await db["boards"].find_one({"_id": board_id})
    out = []
    async for fw in db[COLL].find({"board": board_id}):
        got = await regenerate(db, fw, board, start_build=start_build)
        if got:
            out.append({"firmware": fw["_id"], **got})
    return out


def catalog_rows(firmwares: list[dict], boards: dict[str, dict]) -> list[dict]:
    """What the catalog shows of each firmware: under its board, `.fw`,
    with the board version it was made against."""
    out = []
    for f in firmwares:
        b = boards.get(f.get("board")) or {}
        build = f.get("build") or {}
        out.append({"id": f["_id"], "title": f.get("title"), "name": f.get("title"), "kind": "fw",
                    "board": f.get("board"), "mcu": f.get("mcu"), "sheet": f.get("sheet"),
                    "board_version": f.get("board_version") or 0,
                    "board_now": board_version(b),
                    "changed": bool(f.get("board_change")) and not f.get("board_change", {}).get("seen"),
                    "building": build.get("state") == "running",
                    "built": build.get("state"),
                    "folder": b.get("folder", f.get("folder") or "")})
    return out
