"""A saved McMaster-Carr part's or GrabCAD model's real size, measured from
the STEP dropped on it (backend/linked.py).

What an item says of itself comes from words - its title, a search
snippet, a category's filters ("Length 30 mm") - and words can be wrong:
the STEP is the part. When a STEP becomes an item's `cad`, it is measured
in a process of its own (backend/imports/stepmeasure.py, OpenCascade):
the box it fills, and for a screw - an item whose name says screw or bolt
and whose shape has a head at one end of a round shank - the length under
the head (the overall length for a countersunk one), the head and the
shank. The result is kept on the item as `measured`, with the file it was
measured from, so a new STEP is measured again and an old one never is.

The item's own specs stay as they were said. What is shown beside them
(`view`) is read each time: the measured rows, and a mismatch for each
figure the words give that the STEP does not bear out - a title's 30 mm
against 25 mm under the head, an M3 against a 4 mm shank.

The drop measures it after the answer has gone (linked.py api_files);
items that had a STEP before this are measured by

    .venv/bin/python tools/linked_measure.py [--apply] [--again]
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Bumped when the measuring changes, so the backfill measures again.
VERSION = 1
TIMEOUT = float(os.getenv("REDLINE_STEP_MEASURE_TIMEOUT", "180"))
ROOT = Path(__file__).resolve().parent.parent

# Whose shape is read as a screw's: its name says so. A standoff or a nut
# can be long and round with a wide end too.
SCREW = re.compile(r"\b(screws?|bolts?|vida|c[ıi]vata)\b", re.I)
NOT_SCREW = re.compile(r"\b(standoffs?|spacers?|nuts?|washers?|inserts?|anchors?)\b", re.I)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def run(src: Path) -> dict:
    """stepmeasure in a process of its own, niced, with a time limit; its JSON line."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "backend.imports.stepmeasure", str(src),
        cwd=str(ROOT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        preexec_fn=lambda: os.nice(10))
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {"error": f"the STEP took more than {round(TIMEOUT)} s to measure"}
    text = out.decode(errors="replace").strip()
    try:
        return json.loads(text.splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": "the STEP reader stopped without a result"}


def stale(item: dict) -> bool:
    """Whether the item's STEP is not measured yet (or was, the old way)."""
    cad = item.get("cad") or {}
    if cad.get("kind") != "step":
        return False
    m = item.get("measured") or {}
    return m.get("sha256") != cad.get("sha256") or m.get("v") != VERSION


async def measure(db, key: str) -> dict | None:
    """Measure the STEP of the saved item whose document id is `key` and
    keep the result on it; None when it has no STEP. The item may have taken another file meanwhile: the result
    is kept only if its `cad` is still the one measured."""
    from . import files
    from .linked import COLL
    have = await db[COLL].find_one({"_id": key})
    cad = (have or {}).get("cad") or {}
    if cad.get("kind") != "step":
        return None
    try:
        _, data = await files.get(db, cad["file"])
    except KeyError:
        got = {"error": "its STEP is no longer in Files"}
    else:
        if b"CARTESIAN_POINT" not in data:
            got = {"error": "the STEP has no geometry in it"}
        else:
            with tempfile.TemporaryDirectory(prefix="redline-measure-") as work:
                src = Path(work) / "in.step"
                await asyncio.to_thread(src.write_bytes, data)
                got = await run(src)
    m = {"v": VERSION, "file": cad["file"], "sha256": cad.get("sha256"), "at": _now()}
    if got.get("error"):
        m["error"] = str(got["error"])[:300]
    else:
        m.update({"size": got.get("size"), "axis": got.get("axis"), "screw": got.get("screw"),
                  "seconds": got.get("seconds")})
    await db[COLL].update_one({"_id": have["_id"], "cad.file": cad["file"]}, {"$set": {"measured": m}})
    return m


async def measure_quietly(db, key: str) -> None:
    """measure() after a drop's answer has gone: a failure is kept on the
    item, never raised to anyone."""
    try:
        await measure(db, key)
    except Exception as exc:                            # noqa: BLE001 - the drop itself is done
        import logging
        logging.getLogger(__name__).warning("measuring %s failed: %s", key, exc)


# ---------------------------------------------------------------- read beside the specs

def mm(v: float) -> str:
    """6.0 -> "6", 27.4466 -> "27.45"."""
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _mm_of(text: str) -> float | None:
    """A length as words say it, in millimetres: "30 mm", "1/2\"", "1-1/4\"", "0.75 in"."""
    t = (text or "").strip().lower()
    if m := re.search(r"(\d+(?:\.\d+)?)\s*mm\b", t):
        return float(m.group(1))
    if m := re.search(r"(?:(\d+)[- ])?(\d+)/(\d+)\s*(?:\"|in\b|inch)", t):
        return (int(m.group(1) or 0) + int(m.group(2)) / int(m.group(3))) * 25.4
    if m := re.search(r"(\d+(?:\.\d+)?)\s*(?:\"|in\b|inch)", t):
        return float(m.group(1)) * 25.4
    return None


def _thread_of(text: str) -> float | None:
    """A thread's nominal diameter in millimetres: "M3", "M3 x 0.5 mm", "1/4\"-20"."""
    t = (text or "").strip()
    if m := re.search(r"\bM(\d+(?:\.\d+)?)\b", t, re.I):
        return float(m.group(1))
    if m := re.search(r"\b(\d+)/(\d+)\"?\s*-\s*\d+\b", t):
        return int(m.group(1)) / int(m.group(2)) * 25.4
    return None


def is_screw(item: dict) -> bool:
    words = " ".join([item.get("title") or "", *(item.get("tags") or [])])
    return bool(SCREW.search(words)) and not NOT_SCREW.search(words)


def view(item: dict, specs_of=None) -> dict | None:
    """What the page and the catalog show of the measurement: {rows: [[what,
    value]], mismatch: [{what, said, measured}], size, screw (the screw's
    figures, when it is one), pending, error}. None when the item has no STEP."""
    cad = item.get("cad") or {}
    m = item.get("measured") or {}
    if cad.get("kind") != "step":
        return None
    if stale(item):
        return {"pending": True, "rows": [], "mismatch": []}
    if m.get("error"):
        return {"error": m["error"], "rows": [], "mismatch": [], "at": m.get("at")}
    rows, bad = [], []
    size = m.get("size") or []
    if len(size) == 3:
        rows.append(["Size", " × ".join(mm(x) for x in size) + " mm"])
    s = m.get("screw") if is_screw(item) else None
    # What the words say: the item's own specs, else its title read the source's way.
    said = dict(item.get("specs") or {})
    if specs_of and item.get("title"):
        said = {**specs_of(item["title"]), **said}
    if s:
        if s.get("countersunk"):
            rows.append(["Length", f"{mm(s['length'])} mm overall (countersunk)"])
        else:
            rows.append(["Length", f"{mm(s['length'])} mm under the head"])
        rows.append(["Head", f"Ø{mm(s['head_d'])} × {mm(s['head'])} mm"])
        rows.append(["Shank", f"Ø{mm(s['shank'])} mm"])
        if (want := _mm_of(said.get("Length") or "")) is not None and abs(want - s["length"]) > max(0.5, want * 0.03):
            bad.append({"what": "Length", "said": said["Length"], "measured": f"{mm(s['length'])} mm"})
        thread = said.get("Thread size") or said.get("Thread") or ""
        if (d := _thread_of(thread)) is not None and abs(d - s["shank"]) > max(0.35, d * 0.12):
            bad.append({"what": "Thread", "said": thread, "measured": f"Ø{mm(s['shank'])} mm shank"})
    return {"rows": rows, "mismatch": bad, "at": m.get("at"), "size": size or None, "screw": s}


def specs(v: dict | None) -> dict[str, str]:
    """The measured rows as catalog specs: "Size (measured from STEP)", a
    mismatch said in the row it is about."""
    if not v or not v.get("rows"):
        return {}
    bad = {b["what"]: b for b in v.get("mismatch") or []}
    out = {}
    for what, value in v["rows"]:
        b = bad.get(what) or (bad.get("Thread") if what == "Shank" else None)
        out[f"{what} (measured from STEP)"] = value + (f" - not {b['said']} as said" if b else "")
    return out
