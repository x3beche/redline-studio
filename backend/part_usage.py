"""Which boards use a part: worked out when asked, nothing stored.

A part in the drawer (an LCSC number) is on a board when the board's own
files say so. Each board of the asking workspace is read - nothing is
written - from what it has now:

- its build: the netlist (`graph`) names every part's number by reference,
  the BOM's picks included; and the BOM CSV, where there is one;
- its KiCad files: the layout (`pcb`, a .kicad_pcb) and the schematic
  (`schematic`, a .kicad_sch), whose footprints and symbols carry an
  "LCSC" property beside their "Reference";
- its atopile source as saved: `lcsc_id = "C25744"` (or `mpn`, `lcsc`,
  `supplier_partno` holding an LCSC number), and the converter's comment
  over each part (`# C1591 · C1, C6`, backend/convert.py), which names the
  references before a first build.

A part the source names but no build places yet is on the board without
references ("not built yet").

The answer is kept in memory for a minute, for the workspace as it was:
the key is the workspace and every board's version (saved, and the build's
files by their digests), so a saved or rebuilt board is read again at
once, and opening several part cards reads the boards once. A board's own
reading is kept by its version as long as it is unchanged.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException

from . import lcsc, scope, store

router = APIRouter()

BOARDS = "boards"
TTL = 60.0                      # seconds the workspace's answer is kept
BOARD_CACHE = 512               # boards' readings kept, all workspaces
# The board's files read, by label (backend/ato.py, backend/imports).
FILES = ("graph", "bom_csv", "pcb", "schematic")

# ws -> (when, the boards' versions, {lcsc: [rows]})
_index: dict[str, tuple[float, tuple, dict[str, list[dict]]]] = {}
# (ws, board) -> (version, {lcsc: {"refs": set, "from": set}})
_boards: OrderedDict[tuple[str, str], tuple[tuple, dict]] = OrderedDict()
_locks: dict[str, asyncio.Lock] = {}


def _natural(ref: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", ref or "")]


def _part(text) -> str | None:
    c = str(text or "").strip().upper()
    return c if lcsc.looks_like_a_part(c) else None


# ---------------------------------------------------------------- reading one board

# atopile: a field holding an LCSC number.
_ATO_FIELD = re.compile(r'^\s*(?:lcsc_id|lcsc|mpn|supplier_partno)\s*=\s*"(C\d{2,})"', re.I | re.M)
# The converter's comment over a part: "# C1591 · C1, C6, C9".
_ATO_NOTE = re.compile(r"^\s*#\s*(C\d{2,})\s*·\s*([^\n]*)$", re.M)
_REF = re.compile(r"^[A-Za-z]+[\w.-]*$")


def from_ato(source: str) -> dict[str, set[str]]:
    """LCSC number -> the references the source names for it (often none)."""
    out: dict[str, set[str]] = {}
    for m in _ATO_FIELD.finditer(source or ""):
        out.setdefault(m.group(1).upper(), set())
    for m in _ATO_NOTE.finditer(source or ""):
        refs = {r.strip() for r in m.group(2).split(",") if _REF.match(r.strip())}
        out.setdefault(m.group(1).upper(), set()).update(refs)
    return out


# A placed footprint (.kicad_pcb: `footprint`, before KiCad 6 `module`) or a
# placed symbol (.kicad_sch: `symbol` with a `lib_id`; the library's own
# definitions under lib_symbols have none and are not parts).
_KI_START = re.compile(r"\((?:footprint|module)\s|\(symbol\s+\(lib_id\s")
_KI_REF = re.compile(r'\(property\s+"Reference"\s+"([^"]+)"|\(fp_text\s+reference\s+"?([^\s")]+)')
_KI_PROP = re.compile(r'\(property\s+"([^"]*)"\s+"(C\d{2,})"')
_KI_NAMES = re.compile(r"lcsc|jlc|supplier", re.I)


def from_kicad(text: str) -> dict[str, set[str]]:
    """LCSC number -> references, from a .kicad_pcb or .kicad_sch: each
    footprint or symbol with an LCSC property and a reference."""
    out: dict[str, set[str]] = {}
    starts = [m.start() for m in _KI_START.finditer(text or "")]
    for i, a in enumerate(starts):
        chunk = text[a:starts[i + 1] if i + 1 < len(starts) else len(text)]
        part = next((_part(m.group(2)) for m in _KI_PROP.finditer(chunk) if _KI_NAMES.search(m.group(1))), None)
        if not part:
            continue
        m = _KI_REF.search(chunk)
        ref = (m.group(1) or m.group(2)) if m else None
        refs = out.setdefault(part, set())
        if ref and not ref.startswith("#") and "?" not in ref:
            refs.add(ref)
    return out


def from_graph(raw: bytes) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    try:
        comps = (json.loads(raw) or {}).get("components") or []
    except ValueError:
        return out
    for c in comps:
        part = _part(c.get("part"))
        if part:
            refs = out.setdefault(part, set())
            if c.get("ref"):
                refs.add(str(c["ref"]))
    return out


def from_bom(raw: bytes) -> dict[str, set[str]]:
    from .bom_cost import _bom_rows
    out: dict[str, set[str]] = {}
    try:
        rows = _bom_rows(raw)
    except Exception:                                   # noqa: BLE001 - a BOM that does not read names nothing
        return out
    for ref, r in rows.items():
        part = _part(r.get("part"))
        if part:
            out.setdefault(part, set()).add(ref)
    return out


_READERS = {"graph": from_graph, "bom_csv": from_bom,
            "pcb": lambda b: from_kicad(b.decode(errors="replace")),
            "schematic": lambda b: from_kicad(b.decode(errors="replace"))}


def version(doc: dict) -> tuple:
    """What a board's reading depends on: its source as saved and its files
    by digest (their time when an older entry has none)."""
    a = doc.get("artifacts") or {}
    return (doc.get("saved_at"),) + tuple(
        (a.get(k) or {}).get("sha256") or (a.get(k) or {}).get("at") for k in FILES)


async def read_board(db, doc: dict) -> dict[str, dict]:
    """LCSC number -> {"refs": set, "from": set of where it was read}."""
    out: dict[str, dict] = {}

    def add(got: dict[str, set[str]], where: str):
        for part, refs in got.items():
            e = out.setdefault(part, {"refs": set(), "from": set()})
            e["refs"] |= refs
            e["from"].add(where)

    bid = doc["_id"]
    for label in FILES:
        if label not in (doc.get("artifacts") or {}):
            continue
        try:
            raw = await store.get_artifact(db, bid, label, BOARDS)
        except (KeyError, OSError):
            continue
        except Exception:                               # noqa: BLE001 - one unreadable file is not the answer
            continue
        add(_READERS[label](raw), label)
    src = await db[BOARDS].find_one({"_id": bid}, {"source": 1})
    add(from_ato((src or {}).get("source") or ""), "source")
    return out


# ---------------------------------------------------------------- the workspace

def _ws(db) -> str:
    return getattr(db, "workspace", None) or scope.current()


def _row(doc: dict, entry: dict) -> dict:
    a = doc.get("artifacts") or {}
    folder = (doc.get("folder") or "").strip("/")
    refs = sorted(entry["refs"], key=_natural)
    built = (a.get("graph") or {}).get("at")
    return {
        "board": doc["_id"],
        "name": doc.get("title") or doc["_id"],
        "path": f"{folder}/{doc['_id']}" if folder else doc["_id"],
        "project": folder.split("/")[0] if folder else None,
        "refs": refs,
        "qty": len(refs) or None,
        "built": bool(built),
        "built_at": built,
        "saved_at": doc.get("saved_at"),
        "version": (doc.get("component") or {}).get("version"),
        # the source saved since the build: the build's references may be old
        "stale": bool(built and doc.get("saved_at") and str(doc["saved_at"]) > str(built)),
        "from": sorted(entry["from"]),
    }


async def index(db) -> dict[str, list[dict]]:
    """LCSC number -> the boards of the workspace that use it."""
    ws = _ws(db)
    lock = _locks.setdefault(ws, asyncio.Lock())
    async with lock:
        docs = [d async for d in db[BOARDS].find(
            {}, {"title": 1, "folder": 1, "saved_at": 1, "component": 1, "artifacts": 1})]
        docs.sort(key=lambda d: str(d["_id"]))
        versions = tuple((d["_id"], d.get("title"), d.get("folder"), version(d)) for d in docs)
        hit = _index.get(ws)
        if hit and hit[1] == versions and time.monotonic() - hit[0] < TTL:
            return hit[2]
        out: dict[str, list[dict]] = {}
        for d in docs:
            key, v = (ws, d["_id"]), version(d)
            kept = _boards.get(key)
            if kept and kept[0] == v:
                parts = kept[1]
                _boards.move_to_end(key)
            else:
                parts = await read_board(db, d)
                _boards[key] = (v, parts)
                while len(_boards) > BOARD_CACHE:
                    _boards.popitem(last=False)
            for part, entry in parts.items():
                out.setdefault(part, []).append(_row(d, entry))
        for rows in out.values():
            rows.sort(key=lambda r: (str(r["name"]).lower(), r["board"]))
        _index[ws] = (time.monotonic(), versions, out)
        return out


async def used_in(db, part: str) -> list[dict]:
    return (await index(db)).get(part, [])


def forget() -> None:
    """Every reading dropped (a test's fresh start)."""
    _index.clear()
    _boards.clear()


# ---------------------------------------------------------------- the routes
# Reading a board's files is what viewing a board needs: GET, "view"
# (backend/access.py), through the workspace's database like any route.

def _db():
    from .main import db
    return db()


@router.get("/api/parts/{lcsc_id}/used-in")
async def part_used_in(lcsc_id: str):
    """The boards of this workspace that use the part, each with the
    references it has there and how many."""
    part = _part(lcsc_id)
    if not part:
        raise HTTPException(400, f"{lcsc_id!r} is not an LCSC number (C25744)")
    return await used_in(_db(), part)


@router.get("/api/parts-used-in")
async def parts_used_in(parts: str = ""):
    """Several parts at once (`?parts=C1,C2`): {part: [boards]}, for the
    question before removing them from the drawer."""
    want = [p for p in (_part(x) for x in parts.split(",")) if p][:500]
    got = await index(_db())
    return {p: got.get(p, []) for p in want}
