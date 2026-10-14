"""A saved McMaster-Carr part's or GrabCAD model's real size, measured from
the STEP dropped on it (backend/linked.py) - and any Parts product's, from
the 3D model attached to it (backend/product_files.py: a site's product, a
My Items one, an LCSC part). Both keep the same fields on their document -
`cad`, `measured`, `measuring` - in their own collection, named by `coll`
(linked_parts when it is left out).

What an item says of itself comes from words - its title, a search
snippet, a category's filters ("Length 30 mm") - and words can be wrong:
the STEP is the part. When a STEP becomes an item's `cad`, it is measured
in a process of its own (backend/imports/stepmeasure.py, OpenCascade):
the box it fills, and for a screw - an item whose name says screw or bolt
and whose shape has a head at one end of a round shank - the length under
the head (the overall length for a countersunk one), the head and the
shank. The result is kept on the item as `measured`, with the file it was
measured from, so a new STEP is measured again and an old one never is.

An assembly (more than one solid) is its overall box and its count of
solids, never a screw. A mesh (STL, OBJ, 3MF; backend/imports/
meshmeasure.py) is its box alone, read in this process: an STL or OBJ has
no unit and is taken as millimetres - said so beside the size.

The item's own specs stay as they were said. What is shown beside them
(`view`) is read each time: the measured rows, and a mismatch for each
figure the words give that the STEP does not bear out - a title's 30 mm
against 25 mm under the head, an M3 against a 4 mm shank.

The drop measures it after the answer has gone (linked.py api_files), and
so does a STEP the McMaster-Carr API fetched by itself (mcmaster.auto_step).
A measurement the API's reload cut off is not left "measuring" for ever:
the API measures every item still waiting at its start (`recover`), and an
item read while it waits, with nothing measuring it here and its last start
older than the time limit, is measured again (`resume`). Items that had a
STEP before this are measured by

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
# A start kept on the item (`measuring`) older than this, with nothing in this
# process measuring it, was cut off: the item is measured again when read.
STALE_AFTER = TIMEOUT + 60
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


MEASURED_KINDS = ("step", "mesh")


def _coll(coll: str | None) -> str:
    from .linked import COLL
    return coll or COLL


def stale(item: dict) -> bool:
    """Whether the item's STEP (or mesh) is not measured yet (or was, the old way)."""
    cad = item.get("cad") or {}
    if cad.get("kind") not in MEASURED_KINDS:
        return False
    m = item.get("measured") or {}
    return m.get("sha256") != cad.get("sha256") or m.get("v") != VERSION


async def measure(db, key: str, coll: str | None = None) -> dict | None:
    """Measure the STEP (or mesh) of the item whose document id is `key` in
    `coll` and keep the result on it; None when it has no 3D file. The item
    may have taken another file meanwhile: the result is kept only if its
    `cad` is still the one measured."""
    from . import files
    COLL = _coll(coll)
    have = await db[COLL].find_one({"_id": key})
    cad = (have or {}).get("cad") or {}
    if cad.get("kind") not in MEASURED_KINDS:
        return None
    # Kept on the item while it is measured: a start a reload cut off is seen (cut_off).
    await db[COLL].update_one({"_id": have["_id"]}, {"$set": {"measuring": {"file": cad["file"], "at": _now()}}})
    try:
        _, data = await files.get(db, cad["file"])
    except KeyError:
        data = None
    if data is None:
        got = {"error": f"its {'STEP' if cad['kind'] == 'step' else 'mesh'} is no longer in Files"}
    elif cad["kind"] == "mesh":
        from .imports import meshmeasure
        try:
            got = await asyncio.to_thread(meshmeasure.measure, cad.get("name") or "", data)
        except Exception as exc:                        # noqa: BLE001 - kept on the item as why
            got = {"error": str(exc)[:300] or type(exc).__name__}
    elif b"CARTESIAN_POINT" not in data:
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
                  "seconds": got.get("seconds"), "kind": cad["kind"],
                  **{k: got[k] for k in ("solids", "unit") if got.get(k) is not None}})
    await db[COLL].update_one({"_id": have["_id"], "cad.file": cad["file"]},
                              {"$set": {"measured": m}, "$unset": {"measuring": ""}})
    return m


# The items this process is measuring now, (workspace, id), and the tasks it
# started for them (held, so none is collected half-way).
_running: set[tuple[str, str]] = set()
_tasks: set[asyncio.Task] = set()


def _id(db, key: str, coll: str | None = None) -> tuple[str, str, str]:
    return (getattr(db, "workspace", None) or "default", _coll(coll), key)


def running(db, key: str, coll: str | None = None) -> bool:
    return _id(db, key, coll) in _running


def hold(db, key: str, coll: str | None = None) -> bool:
    """Marked as measured here, before measure_quietly(held=True) runs: a read
    meanwhile starts no second one. False when it is being measured already."""
    if running(db, key, coll):
        return False
    _running.add(_id(db, key, coll))
    return True


async def measure_quietly(db, key: str, held: bool = False, coll: str | None = None) -> None:
    """measure() after a drop's answer has gone: a failure is kept on the
    item, never raised to anyone. Once at a time for an item; a STEP dropped
    while the one before it was measured is measured next. `held`: the
    caller marked it running already (`hold`)."""
    import logging
    COLL = _coll(coll)
    me = _id(db, key, coll)
    if me in _running and not held:
        return
    _running.add(me)
    try:
        for _ in range(3):
            await measure(db, key, coll)
            if not stale(await db[COLL].find_one({"_id": key}) or {}):
                break
    except Exception as exc:                            # noqa: BLE001 - the drop itself is done
        logging.getLogger(__name__).warning("measuring %s failed: %s", key, exc)
    finally:
        _running.discard(me)


def start(db, key: str, coll: str | None = None) -> bool:
    """measure_quietly() in a task of its own; False when it is being measured here already."""
    if not hold(db, key, coll):
        return False
    t = asyncio.get_running_loop().create_task(measure_quietly(db, key, held=True, coll=coll))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return True


def cut_off(item: dict, now: datetime | None = None) -> bool:
    """A STEP waiting to be measured whose measuring was cut off (or never
    started): no start kept on it, or one older than STALE_AFTER."""
    if not stale(item):
        return False
    at = (item.get("measuring") or {}).get("at")
    if not at:
        return True
    try:
        began = datetime.fromisoformat(at)
    except (TypeError, ValueError):
        return True
    return ((now or datetime.now(timezone.utc)) - began).total_seconds() > STALE_AFTER


def resume(db, item: dict, coll: str | None = None) -> bool:
    """An item read while its STEP waits: measured again when nothing here
    measures it and its last start was cut off. Whether it was started."""
    if item.get("_id") and not running(db, item["_id"], coll) and cut_off(item):
        return start(db, item["_id"], coll)
    return False


async def recover(raw) -> int:
    """At the API's start: every item, in every workspace, whose STEP is not
    measured - a reload cut its measuring off, or it never began - is
    measured, one after another in a task of its own. How many."""
    from . import scope
    from .linked import COLL
    from .product_files import COLL as PRODUCT_FILES
    todo = []
    for coll in (COLL, PRODUCT_FILES):
        async for d in raw[coll].find({"cad.kind": {"$in": list(MEASURED_KINDS)}},
                                      {"cad": 1, "measured": 1, "workspace_id": 1}):
            if stale(d):
                db = scope.ScopedDb(raw, d.get("workspace_id") or scope.DEFAULT)
                key = scope.Ids(db.workspace).out(d["_id"])
                if hold(db, key, coll):
                    todo.append((db, key, coll))
    if not todo:
        return 0

    async def one_by_one():
        for db, key, coll in todo:
            token = scope.WORKSPACE.set(db.workspace)
            try:
                await measure_quietly(db, key, held=True, coll=coll)
            finally:
                scope.WORKSPACE.reset(token)

    t = asyncio.get_running_loop().create_task(one_by_one())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return len(todo)


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


_TR = str.maketrans({"ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ç": "c", "Ç": "c",
                     "ö": "o", "Ö": "o", "ü": "u", "Ü": "u", "ä": "a", "Ä": "a"})

# What the words call each figure, in English and in Turkish (a Turkish
# site's specs say "Uzunluk: 30 mm", "Diş: M3", "Boyut: 20x20x10 mm").
LENGTH_SAID = ("Length", "Uzunluk", "Boy", "Vida boyu", "Länge")
THREAD_SAID = ("Thread size", "Thread", "Dis", "Dis olcusu", "Vida capi", "Cap")
SIZE_SAID = ("Size", "Dimensions", "Boyut", "Boyutlar", "Olculer", "Olcu", "Ebat", "Ebatlar", "Dis olculer")


def _fold(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "").translate(_TR).lower()).strip()


def _said(said: dict, names: tuple[str, ...]) -> tuple[str, str]:
    """(key, value) of the first spec whose name is one of `names`, any case or accent; ("", "") when none."""
    want = {_fold(n) for n in names}
    for k, v in said.items():
        if _fold(k) in want and str(v).strip():
            return k, str(v)
    return "", ""


_NUM = r"(\d+(?:[.,]\d+)?)"


def title_specs(title: str) -> dict:
    """What a product's name says of its size, for a product with no specs
    of it: "M3x10" or "M3 x 10 mm" a thread and a length, "20x20x10 mm" a box."""
    t = title or ""
    out = {}
    if m := re.search(r"\bM" + _NUM + r"\s*[x×*]\s*" + _NUM + r"(?!\s*[x×*]\s*\d)", t, re.I):
        out["Thread size"] = "M" + m.group(1).replace(",", ".")
        out["Length"] = m.group(2).replace(",", ".") + " mm"
    elif m := re.search(r"\bM" + _NUM + r"\b", t):
        out["Thread size"] = "M" + m.group(1).replace(",", ".")
    if m := re.search(_NUM + r"\s*[x×*]\s*" + _NUM + r"\s*[x×*]\s*" + _NUM + r"\s*(mm|cm)\b", t, re.I):
        out["Size"] = " x ".join(m.group(i).replace(",", ".") for i in (1, 2, 3)) + " " + m.group(4).lower()
    return out


def _box_of(text: str) -> list[float] | None:
    """Three figures of a size as words say it, in millimetres, smallest first: "20 x 20 x 10 mm", "2x3x4 cm"."""
    t = (text or "").lower().replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|\")?", t)
    if not m:
        return None
    k = {"cm": 10.0, "in": 25.4, '"': 25.4}.get(m.group(4) or "mm", 1.0)
    return sorted(float(m.group(i)) * k for i in (1, 2, 3))


def view(item: dict, specs_of=None) -> dict | None:
    """What the page and the catalog show of the measurement: {rows: [[what,
    value]], mismatch: [{what, said, measured}], size, screw (the screw's
    figures, when it is one), solids, kind, pending, error}. None when the
    item has no STEP or mesh."""
    cad = item.get("cad") or {}
    m = item.get("measured") or {}
    if cad.get("kind") not in MEASURED_KINDS:
        return None
    if stale(item):
        return {"pending": True, "rows": [], "mismatch": [], "kind": cad["kind"]}
    if m.get("error"):
        return {"error": m["error"], "rows": [], "mismatch": [], "at": m.get("at"), "kind": cad["kind"]}
    rows, bad = [], []
    size = m.get("size") or []
    if len(size) == 3:
        rows.append(["Size", " × ".join(mm(x) for x in size) + " mm" + (" (assumed)" if m.get("unit") == "assumed mm" else "")])
    if (m.get("solids") or 0) > 1:
        rows.append(["Solids", f"{m['solids']} (an assembly: the size is all of them)"])
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
        _, length = _said(said, LENGTH_SAID)
        if (want := _mm_of(length)) is not None and abs(want - s["length"]) > max(0.5, want * 0.03):
            bad.append({"what": "Length", "said": length, "measured": f"{mm(s['length'])} mm"})
        _, thread = _said(said, THREAD_SAID)
        if (d := _thread_of(thread)) is not None and abs(d - s["shank"]) > max(0.35, d * 0.12):
            bad.append({"what": "Thread", "said": thread, "measured": f"Ø{mm(s['shank'])} mm shank"})
    elif len(size) == 3:
        # A box the words give, held against the box measured (in any order: a file's axes are its own).
        _, box = _said(said, SIZE_SAID)
        want_box = _box_of(box)
        got = sorted(size)
        if want_box and any(abs(a - b) > max(0.5, a * 0.03) for a, b in zip(want_box, got)):
            bad.append({"what": "Size", "said": box, "measured": " × ".join(mm(x) for x in size) + " mm"})
    return {"rows": rows, "mismatch": bad, "at": m.get("at"), "size": size or None, "screw": s,
            "solids": m.get("solids"), "kind": cad["kind"], "unit": m.get("unit") or "mm"}


def specs(v: dict | None) -> dict[str, str]:
    """The measured rows as catalog specs: "Size (measured from STEP)", a
    mismatch said in the row it is about."""
    if not v or not v.get("rows"):
        return {}
    bad = {b["what"]: b for b in v.get("mismatch") or []}
    src = "mesh" if v.get("kind") == "mesh" else "STEP"
    out = {}
    for what, value in v["rows"]:
        b = bad.get(what) or (bad.get("Thread") if what == "Shank" else None)
        out[f"{what} (measured from {src})"] = value + (f" - not {b['said']} as said" if b else "")
    return out
