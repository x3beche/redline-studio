"""Flashing a firmware from the browser, and the record of each flash.

The Firmware room flashes over Web Serial with esptool-js, on the
person's own computer: nothing is plugged into the server. What the
server gives is the image - every file and where it goes - and what it
keeps is a line per flash.

An ESP32 Arduino image is four files (PlatformIO writes the first three
into .pio/build/<env>/, backend/fwbuild.py keeps them with the build):

    bootloader.bin   0x1000   the second-stage bootloader (0x0 on S3/C3)
    partitions.bin   0x8000   the partition table
    boot_app0.bin    0xe000   otadata: boot the first app slot
    firmware.bin     0x10000  the app

The offsets of the last two are read from the partition table itself (the
otadata partition and the first app partition), so a firmware with its own
table is written where that table says; the numbers above are the default
table's and the fallback.

A flash is refused unless the last build is good and is a build of the
code as it is now: a failed build, a build of older sources or a build
still running is not what the person thinks they are flashing.

Each flash is a document in `firmware_flashes` (the workspace's): the
build it wrote, the chip, the last three bytes of the board's MAC (never
the whole of it), whether it worked and how long it took. The last one is
copied onto the firmware (`last_flash`) for the Status tab, and each is a
line in the audit trail.
"""

from __future__ import annotations

import re
import secrets
import struct
from datetime import datetime, timedelta, timezone

from . import actors, firmware, store

FLASHES = "firmware_flashes"

# What is written, in order, and where by default.
FLASH_FILES = ("bootloader.bin", "partitions.bin", "boot_app0.bin", "firmware.bin")
DEFAULT_AT = {"partitions.bin": 0x8000, "boot_app0.bin": 0xE000, "firmware.bin": 0x10000}
BOOTLOADER_AT = {"ESP32": 0x1000, "ESP32-S2": 0x1000, "ESP32-S3": 0x0, "ESP32-C3": 0x0}
FAMILY = {"esp32dev": "ESP32", "esp32-s2-saola-1": "ESP32-S2", "esp32-s3-devkitc-1": "ESP32-S3",
          "esp32-c3-devkitm-1": "ESP32-C3"}
BAUD = 921600
FALLBACK_BAUD = 115200
MONITOR_BAUD = 115200
# A flash that started and never said how it ended is not "working now"
# for ever: the page was closed, or the cable pulled.
RUNNING_FOR = timedelta(minutes=5)


class NotReady(Exception):
    """The last build is not one to flash: why, in a word and in a sentence."""

    def __init__(self, reason: str, text: str):
        self.reason, self.text = reason, text
        super().__init__(text)


# ---------------------------------------------------------------- the image

def partition_table(data: bytes) -> list[dict]:
    """The entries of an ESP32 partition table: 32 bytes each, starting
    0xAA 0x50, until the MD5 line (0xEB 0xEB) or blank flash."""
    out = []
    for i in range(0, len(data) - 31, 32):
        e = data[i:i + 32]
        if e[:2] != b"\xaa\x50":
            break
        kind, sub, offset, size = struct.unpack("<BBII", e[2:12])
        out.append({"type": kind, "subtype": sub, "offset": offset, "size": size,
                    "label": e[12:28].split(b"\0", 1)[0].decode(errors="replace")})
    return out


def offsets(family: str, partitions: bytes | None) -> dict[str, int]:
    """Where each of the four files goes, for this chip and this table."""
    at = {"bootloader.bin": BOOTLOADER_AT.get(family, 0x1000), **DEFAULT_AT}
    table = partition_table(partitions or b"")
    ota = next((p for p in table if p["type"] == 1 and p["subtype"] == 0), None)
    # The app the bootloader starts with no otadata: factory, else ota_0.
    apps = [p for p in table if p["type"] == 0]
    app = next((p for p in apps if p["subtype"] == 0), None) or next((p for p in apps if p["subtype"] == 0x10), None)
    if ota:
        at["boot_app0.bin"] = ota["offset"]
    if app:
        at["firmware.bin"] = app["offset"]
    return at


def family_of(fw: dict) -> str:
    return FAMILY.get(fw.get("pio_board") or "", "ESP32")


def monitor_baud(files: dict[str, str]) -> int:
    """monitor_speed from platformio.ini, as the serial monitor's default."""
    m = re.search(r"^\s*monitor_speed\s*=\s*(\d+)", files.get("platformio.ini") or "", re.M)
    return int(m.group(1)) if m else MONITOR_BAUD


def ready(fw: dict) -> dict:
    """The build to flash, or NotReady with what to do instead."""
    b = fw.get("build") or {}
    state = b.get("state")
    if not state:
        raise NotReady("never", "Not built yet - build it first.")
    if state == "running":
        raise NotReady("running", "A build is running - wait for it to finish.")
    if state != "ok":
        raise NotReady("failed", "The last build failed - fix it and build again before flashing.")
    if (b.get("version") or 0) != (fw.get("version") or 0):
        raise NotReady("stale", f"The code changed since the last build (v{b.get('version')} -> "
                                f"v{fw.get('version')}) - build first.")
    arts = b.get("artifacts") or {}
    missing = [n for n in FLASH_FILES if n not in arts]
    if missing:
        raise NotReady("missing", "This build has no " + ", ".join(missing) +
                       " (it is from before flashing) - build again.")
    return b


def manifest(fw: dict, files: dict[str, str] | None = None) -> dict:
    """What the page writes: every file, where, how big, its hashes."""
    b = ready(fw)
    arts = b["artifacts"]
    fid = fw["_id"]
    family = family_of(fw)
    rows = []
    for name in FLASH_FILES:
        a = arts[name]
        rows.append({"name": name, "offset": int(a.get("offset", DEFAULT_AT.get(name, BOOTLOADER_AT.get(family, 0)))),
                     "size": a["bytes"], "sha256": a["sha256"], "md5": a.get("md5"),
                     "url": f"/api/firmware/{fid}/download/{name}?build={b.get('job')}"})
    rows.sort(key=lambda r: r["offset"])
    return {"firmware": fid, "title": fw.get("title"), "chip": family, "board": fw.get("board"),
            "mcu": fw.get("mcu"), "build_job": b.get("job"), "built_at": b.get("at"),
            "version": b.get("version"), "files": rows, "baud": BAUD, "fallback_baud": FALLBACK_BAUD,
            "monitor_baud": monitor_baud(files or {}), "flash_mode": "keep", "flash_freq": "keep",
            "flash_size": "keep"}


# ---------------------------------------------------------------- the records

def mac_tail(mac: str | None) -> str | None:
    """The board's MAC as it is kept: its last three bytes (aa:bb:cc), or
    a short hash the page made of it. The whole of it is never stored."""
    if not mac:
        return None
    text = str(mac).strip().lower()
    pairs = re.findall(r"[0-9a-f]{2}", text)
    if re.fullmatch(r"[0-9a-f]{2}([:-][0-9a-f]{2}){2,5}", text):
        return ":".join(pairs[-3:])
    if re.fullmatch(r"[0-9a-f]{8,64}", text):
        return text[:16]
    return None


def _clean(body: dict) -> dict:
    out = {}
    if body.get("chip") is not None:
        out["chip"] = str(body["chip"])[:80]
    if body.get("mac") is not None:
        out["mac"] = mac_tail(body.get("mac"))
    if body.get("secs") is not None:
        out["secs"] = round(max(0.0, min(float(body["secs"]), 3600.0)), 1)
    if body.get("baud") is not None:
        out["baud"] = int(body["baud"])
    if body.get("error"):
        out["error"] = str(body["error"])[:500]
    return out


def view(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in ("workspace_id",)} | {"id": doc["_id"]}


async def _build_of(db, fw: dict, job_id: str) -> dict:
    """The build a flash wrote: its job, version and when it was made."""
    from . import fwbuild
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    ws = getattr(db, "workspace", None) or "default"
    job = await raw[fwbuild.JOBS].find_one({"_id": job_id})
    if not job or job.get("firmware") != fw["_id"] or (job.get("workspace") or "default") != ws:
        raise KeyError(job_id)
    b = fw.get("build") or {}
    at = b.get("at") if b.get("job") == job_id else job.get("finished_at")
    return {"build_job": job_id, "build_at": at if isinstance(at, str) or at is None else str(at),
            "version": job.get("version")}


async def start(db, fw: dict, body: dict, by: dict | None) -> dict:
    """A flash begins: written down, so Working now can say so."""
    built = await _build_of(db, fw, str(body.get("build_job") or ""))
    doc = {"_id": secrets.token_hex(8), "firmware": fw["_id"], "title": fw.get("title"),
           "board": fw.get("board"), **built, "state": "running", "ok": None,
           "started_at": store.now(), "by": by, **_clean(body)}
    await db[FLASHES].insert_one(doc)
    return view(doc)


async def finish(db, fw: dict, flash_id: str | None, body: dict, by: dict | None) -> dict:
    """A flash ended, well or not: the record, the firmware's last flash,
    a line in the audit trail. Without a started record (flash_id None)
    the whole flash is written at once."""
    ok = bool(body.get("ok"))
    t = store.now()
    if flash_id:
        doc = await db[FLASHES].find_one({"_id": flash_id, "firmware": fw["_id"]})
        if not doc:
            raise KeyError(flash_id)
        patch = {"state": "done" if ok else "failed", "ok": ok, "finished_at": t, **_clean(body)}
        await db[FLASHES].update_one({"_id": flash_id}, {"$set": patch})
        doc = {**doc, **patch}
    else:
        built = await _build_of(db, fw, str(body.get("build_job") or ""))
        doc = {"_id": secrets.token_hex(8), "firmware": fw["_id"], "title": fw.get("title"),
               "board": fw.get("board"), **built, "state": "done" if ok else "failed", "ok": ok,
               "started_at": t, "finished_at": t, "by": by, **_clean(body)}
        await db[FLASHES].insert_one(doc)
    last = {k: doc.get(k) for k in ("ok", "build_job", "build_at", "version", "chip", "mac", "secs", "error")}
    last.update(at=t, id=doc["_id"], by=by)
    await db[firmware.COLL].update_one({"_id": fw["_id"]}, {"$set": {"last_flash": last}})
    await actors.audit(db, "flash", f"/api/firmware/{fw['_id']}", {
        "ok": ok, "build_job": doc.get("build_job"), "version": doc.get("version"),
        "chip": doc.get("chip"), "mac": doc.get("mac"), "secs": doc.get("secs"),
        **({"error": doc["error"]} if doc.get("error") else {})}, actor=by)
    return view(doc)


async def listing(db, fid: str, limit: int = 20) -> list[dict]:
    rows = [d async for d in db[FLASHES].find({"firmware": fid}).sort("started_at", -1).limit(limit)]
    return [view(d) for d in rows]


def _dt(v) -> datetime | None:
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


async def working(db, now: datetime) -> tuple[list[dict], list[dict]]:
    """For Working now: flashes under way, and those that ended lately."""
    items, recent = [], []
    since = now - timedelta(minutes=10)
    async for f in db[FLASHES].find({}).sort("started_at", -1).limit(30):
        start_at = _dt(f.get("started_at"))
        if not start_at or start_at < since - RUNNING_FOR:
            break
        if f.get("state") == "running":
            if now - start_at < RUNNING_FOR:
                items.append({"kind": "firmware", "id": f.get("firmware"), "title": f.get("title") or f.get("firmware"),
                              "state": "running", "job": "flash",
                              "secs": round((now - start_at).total_seconds(), 1), "expected_secs": None,
                              "why": None})
            continue
        end = _dt(f.get("finished_at"))
        if end and end >= since:
            recent.append({"kind": "flash", "id": f"{f.get('title') or f.get('firmware')} · flash",
                           "ok": bool(f.get("ok")), "secs": f.get("secs"),
                           "ago": round((now - end).total_seconds(), 1), "_at": end})
    return items, recent
