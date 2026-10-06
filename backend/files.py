"""Files: anything a person wants the agents to have, dropped in one place.

A BOM for a board that came in as bare Gerbers, a pick-and-place file, a
datasheet, a photo of the bench, a STEP from a supplier. None of them is a
model or a board on its own - they are what the work needs. They are kept
as they came (GridFS bucket `user_files`), with who brought them, when,
and where they were: the room, and the board, model or app open there.

The kind is read from the name and, for tables, from the header row, so a
BOM is recognised as one and the PCB room's agent can be pointed at it
(`revisions.py files get <id>`, then `board convert <board> --bom`).

Files belong to the workspace (backend/scope.py).
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import PurePosixPath

COLL = "files"
BUCKET = "user_files"
MAX_BYTES = int(float(os.getenv("X3_FILE_MAX_MB", "200")) * 1024 * 1024)

KINDS = ("bom", "pick-place", "gerber", "drill", "step", "mesh", "image", "pdf",
         "table", "archive", "text", "other")

_SUFFIX_KIND = {
    **{s: "gerber" for s in (".gbr", ".ger", ".gtl", ".gbl", ".gto", ".gbo", ".gts", ".gbs",
                             ".gtp", ".gbp", ".gko", ".gm1", ".gml", ".gdl", ".gdd")},
    **{s: "drill" for s in (".drl", ".xln", ".exc")},
    ".step": "step", ".stp": "step",
    **{s: "mesh" for s in (".stl", ".obj", ".glb", ".gltf", ".3mf")},
    **{s: "image" for s in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp")},
    ".pdf": "pdf",
    **{s: "table" for s in (".csv", ".tsv", ".xlsx", ".xls", ".ods")},
    **{s: "archive" for s in (".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz")},
    **{s: "text" for s in (".txt", ".md", ".json", ".yaml", ".yml", ".ato", ".py", ".c", ".h",
                           ".cpp", ".ts", ".js", ".kicad_pcb", ".kicad_sch", ".net", ".log")},
}

# What a header row says about a table. EasyEDA, JLCPCB, KiCad and Altium
# spell these differently; lower-cased and squeezed they mostly agree.
_BOM_COLS = ("designator", "reference", "refdes", "references")
_BOM_HINTS = ("lcsc", "lcscpart", "supplierpart", "mpn", "manufacturerpart", "comment", "value",
              "footprint", "quantity", "qty", "package")
_PNP_COLS = ("midx", "centerx", "posx", "refx", "x", "locationx")
_PNP_HINTS = ("rotation", "rot", "layer", "side", "midy", "centery", "posy", "y")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_name(name: str) -> str:
    """The file's own name: no folders, no control characters, not empty."""
    base = PurePosixPath((name or "").replace("\\", "/")).name
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip().strip(".")
    return base[:180] or "file"


def _header_cells(head: bytes) -> list[str]:
    """The first non-empty line of a text table, as squeezed lower-case cells."""
    for enc in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            text = head.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        return []
    for line in text.splitlines():
        if line.strip():
            sep = "\t" if line.count("\t") > line.count(",") else (";" if line.count(";") > line.count(",") else ",")
            return [re.sub(r"[^a-z0-9]", "", c.lower()) for c in line.split(sep)]
    return []


def kind_of(name: str, head: bytes = b"") -> str:
    """What the file is, from its name and (for tables) its first line."""
    low = name.lower()
    suffix = PurePosixPath(low).suffix
    kind = _SUFFIX_KIND.get(suffix, "other")
    if kind != "table":
        return kind
    cells = _header_cells(head) if suffix in (".csv", ".tsv") else []
    if cells:
        if any(c in _BOM_COLS for c in cells) and any(h in cells for h in _BOM_HINTS) \
                and not any(c in _PNP_COLS[:4] for c in cells):
            return "bom"
        if any(c in _PNP_COLS for c in cells) and any(h in cells for h in _PNP_HINTS):
            return "pick-place"
    # A spreadsheet cannot be read here; its name is all there is.
    if re.search(r"(^|[^a-z])bom([^a-z]|$)", low):
        return "bom"
    if re.search(r"pick|place|pnp|cpl|centroid|position", low):
        return "pick-place"
    return "table"


def _bucket(db):
    from .store import bucket
    return bucket(db, BUCKET)


async def put(db, name: str, data: bytes, content_type: str | None, context: dict | None,
              by: dict, note: str = "") -> dict:
    if not data:
        raise ValueError("the file is empty")
    if len(data) > MAX_BYTES:
        raise ValueError(f"larger than {MAX_BYTES // (1024 * 1024)} MB (X3_FILE_MAX_MB)")
    name = clean_name(name)
    fid = await _bucket(db).upload_from_stream(name, data)
    doc = {"_id": secrets.token_hex(6), "name": name, "bytes": len(data),
           "content_type": (content_type or "application/octet-stream")[:120],
           "kind": kind_of(name, data[:4096]), "sha256": hashlib.sha256(data).hexdigest(),
           "gridfs_id": fid, "context": context or {}, "by": by, "note": (note or "")[:2000],
           "created_at": _now()}
    await db[COLL].insert_one(doc)
    return doc


async def listing(db, q: str = "", kind: str = "", board: str = "", limit: int = 500) -> list[dict]:
    query: dict = {}
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"name": rx}, {"note": rx}]
    if kind:
        query["kind"] = kind
    if board:
        query["context.board"] = board
    cur = db[COLL].find(query, {"gridfs_id": 0}).sort("created_at", -1).limit(min(limit, 2000))
    return [d async for d in cur]


async def get(db, fid: str) -> tuple[dict, bytes]:
    doc = await db[COLL].find_one({"_id": fid})
    if not doc:
        raise KeyError(fid)
    stream = await _bucket(db).open_download_stream(doc["gridfs_id"])
    return doc, await stream.read()


async def update(db, fid: str, note: str | None = None, board: str | None = None) -> dict | None:
    patch: dict = {}
    if note is not None:
        patch["note"] = note[:2000]
    if board is not None:
        # "" unlinks it; a name links it to that board.
        patch["context.board"] = board[:200] or None
    if patch:
        await db[COLL].update_one({"_id": fid}, {"$set": patch})
    return await db[COLL].find_one({"_id": fid}, {"gridfs_id": 0})


async def remove(db, fid: str) -> bool:
    doc = await db[COLL].find_one({"_id": fid}, {"gridfs_id": 1})
    if not doc:
        return False
    try:
        await _bucket(db).delete(doc["gridfs_id"])
    except Exception:
        pass                                  # the bytes are gone already; drop the record anyway
    await db[COLL].delete_one({"_id": fid})
    return True


def as_message(doc: dict) -> str:
    """A file, as the room's agent gets it in its thread: what it is and the
    command that fetches it."""
    ctx = doc.get("context") or {}
    line = f"A file was uploaded: {doc['name']} ({doc['kind']}, {doc['bytes'] // 1024} kB), id {doc['_id']}."
    get = f".venv/bin/python tools/revisions.py files get {doc['_id']} -o {doc['name']}"
    out = [line, f"Fetch it: {get}"]
    if doc["kind"] == "bom" and ctx.get("board"):
        out.append(f"It is a BOM for board {ctx['board']}: "
                   f"board convert {ctx['board']} --bom {doc['name']} --run")
    if doc.get("note"):
        out.append(f"Their note: {doc['note']}")
    return "\n".join(out)
