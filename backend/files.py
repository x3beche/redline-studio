"""Files: anything a person wants the agents to have, dropped in one place.

A BOM for a board that came in as bare Gerbers, a pick-and-place file, a
datasheet, a photo of the bench, a STEP from a supplier. None of them is a
model or a board on its own - they are what the work needs. They are kept
as they came (GridFS bucket `user_files`), with who brought them, when,
and where they were: the room, and the board or model open there.

The kind is read from the name and, for tables, from the header row, so a
BOM is recognised as one and the PCB room's agent can be pointed at it
(`revisions.py files get <id>`, then `board convert <board> --bom`).

Files sit in folders of their own (collection `file_folders`: a name, the
parent folder's id - "" is the top - and the path of names, kept for
search and the command line). A file's `folder` is a folder id, "" for
the top; files from before folders have none and are at the top.

Files belong to the workspace (backend/scope.py), and so do the folders.
"""

from __future__ import annotations

import csv
import hashlib
import io
import mimetypes
import os
import re
import secrets
import tarfile
import zipfile
from xml.etree import ElementTree
from datetime import datetime, timezone
from pathlib import PurePosixPath

COLL = "files"
FOLDERS = "file_folders"
BUCKET = "user_files"
MAX_BYTES = int(float(os.getenv("REDLINE_FILE_MAX_MB", "200")) * 1024 * 1024)

KINDS = ("bom", "pick-place", "gerber", "drill", "step", "mesh", "image", "video", "audio", "pdf",
         "table", "archive", "text", "other")

_SUFFIX_KIND = {
    **{s: "gerber" for s in (".gbr", ".ger", ".gtl", ".gbl", ".gto", ".gbo", ".gts", ".gbs",
                             ".gtp", ".gbp", ".gko", ".gm1", ".gml", ".gdl", ".gdd")},
    **{s: "drill" for s in (".drl", ".xln", ".exc")},
    ".step": "step", ".stp": "step",
    **{s: "mesh" for s in (".stl", ".obj", ".glb", ".gltf", ".3mf")},
    **{s: "image" for s in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico")},
    **{s: "video" for s in (".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv")},
    **{s: "audio" for s in (".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".opus", ".aac")},
    ".pdf": "pdf",
    **{s: "table" for s in (".csv", ".tsv", ".xlsx", ".xls", ".ods")},
    **{s: "archive" for s in (".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz")},
    **{s: "text" for s in (".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".ato", ".py", ".c", ".h",
                           ".cpp", ".hpp", ".cc", ".ino", ".ts", ".js", ".kicad_pcb", ".kicad_sch", ".net", ".log",
                           ".xml", ".toml", ".ini", ".cfg", ".conf", ".sh", ".rs", ".go", ".java", ".css",
                           ".html", ".sql", ".ld", ".s", ".lua")},
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
              by: dict, note: str = "", folder: str = "") -> dict:
    if not data:
        raise ValueError("the file is empty")
    if len(data) > MAX_BYTES:
        raise ValueError(f"larger than {MAX_BYTES // (1024 * 1024)} MB (REDLINE_FILE_MAX_MB)")
    name = clean_name(name)
    fid = await _bucket(db).upload_from_stream(name, data)
    doc = {"_id": secrets.token_hex(6), "name": name, "bytes": len(data),
           "content_type": type_of(name, content_type),
           "kind": kind_of(name, data[:4096]), "sha256": hashlib.sha256(data).hexdigest(),
           "gridfs_id": fid, "context": context or {}, "by": by, "note": (note or "")[:2000],
           "folder": folder or "", "created_at": _now()}
    await db[COLL].insert_one(doc)
    return doc


async def listing(db, q: str = "", kind: str = "", board: str = "", limit: int = 2000,
                  folder: str | None = None) -> list[dict]:
    query: dict = {}
    if folder is not None:
        # The top holds the files from before folders too: they have none.
        query["folder"] = {"$in": ["", None]} if folder == "" else folder
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"name": rx}, {"note": rx}]
    if kind:
        query["kind"] = kind
    if board:
        query["context.board"] = board
    cur = db[COLL].find(query, {"gridfs_id": 0, "thumb": 0}).sort("created_at", -1).limit(min(limit, 5000))
    return [d async for d in cur]


async def get(db, fid: str) -> tuple[dict, bytes]:
    doc = await db[COLL].find_one({"_id": fid})
    if not doc:
        raise KeyError(fid)
    stream = await _bucket(db).open_download_stream(doc["gridfs_id"])
    return doc, await stream.read()


async def update(db, fid: str, note: str | None = None, board: str | None = None,
                 name: str | None = None) -> dict | None:
    patch: dict = {}
    if name is not None:
        doc = await db[COLL].find_one({"_id": fid}, {"name": 1, "kind": 1})
        if not doc:
            return None
        patch["name"] = check_name(name)
        # A new suffix is a new kind; the same one keeps what the header said.
        if PurePosixPath(patch["name"].lower()).suffix != PurePosixPath(doc["name"].lower()).suffix:
            patch["kind"] = kind_of(patch["name"])
    if note is not None:
        patch["note"] = note[:2000]
    if board is not None:
        # "" unlinks it; a name links it to that board.
        patch["context.board"] = board[:200] or None
    if patch:
        await db[COLL].update_one({"_id": fid}, {"$set": patch})
    return await db[COLL].find_one({"_id": fid}, {"gridfs_id": 0, "thumb": 0})


async def remove(db, fid: str) -> bool:
    doc = await db[COLL].find_one({"_id": fid}, {"gridfs_id": 1, "sha256": 1})
    if not doc:
        return False
    try:
        await _bucket(db).delete(doc["gridfs_id"])
    except Exception:
        pass                                  # the bytes are gone already; drop the record anyway
    await db[COLL].delete_one({"_id": fid})
    # A 3D file's picture is kept by content: it goes with the last copy.
    sha = doc.get("sha256")
    if sha and not await db[COLL].count_documents({"sha256": sha}, limit=1):
        await db[SOLID_THUMBS].delete_many({"sha256": sha})
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


# ---------------------------------------------------------------- names

class Clash(ValueError):
    """A folder of that name is already there."""


def check_name(name: str, longest: int = 180) -> str:
    """A name a person typed for a file or a folder, refused rather than
    quietly changed: it is theirs, and a different one would surprise."""
    n = (name or "").strip()
    if not n:
        raise ValueError("a name is needed")
    if len(n) > longest:
        raise ValueError(f"a name is at most {longest} characters")
    if "/" in n or "\\" in n:
        raise ValueError("a name cannot hold / or \\")
    if re.search(r"[\x00-\x1f\x7f]", n):
        raise ValueError("a name cannot hold control characters")
    if n in (".", ".."):
        raise ValueError(f"{n!r} is not a name")
    return n


# ---------------------------------------------------------------- what a preview shows

_EXT_PREVIEW = {
    **{s: "image" for s in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico")},
    **{s: "video" for s in (".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv")},
    **{s: "audio" for s in (".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".opus", ".aac")},
    ".pdf": "pdf",
    ".md": "markdown", ".markdown": "markdown",
    ".csv": "table", ".tsv": "table", ".xlsx": "table",
    **{s: "archive" for s in (".zip", ".tar", ".tgz", ".tbz2", ".txz")},
    **{s: "mesh" for s in (".stl", ".obj", ".glb", ".gltf", ".3mf")},
    ".step": "step", ".stp": "step",
}


def preview_of(name: str, kind: str = "", content_type: str = "") -> str:
    """How the Files tab shows a file in place: image, video, audio, pdf,
    markdown, table, archive, mesh (a 3D view), step (a 3D view once it is
    a model), text (a code view), or none (what it is, and Download)."""
    low = (name or "").lower()
    suffix = PurePosixPath(low).suffix
    if re.search(r"\.tar\.(gz|bz2|xz)$", low):
        return "archive"
    if suffix in _EXT_PREVIEW:
        return _EXT_PREVIEW[suffix]
    if kind in ("text", "gerber", "drill", "bom", "pick-place") and suffix not in (".xls", ".ods"):
        return "text"
    ct = (content_type or "").lower()
    for head in ("image", "video", "audio"):
        if ct.startswith(head + "/"):
            return head
    if ct.startswith("text/") or ct in ("application/json", "application/xml"):
        return "text"
    return "none"


# Served inline, these could run script on the app's own origin; they are
# kept in a sandbox with nothing allowed. A PDF is not: a sandboxed PDF is
# refused by the browser's viewer.
ACTIVE_TYPES = ("text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml")


def type_of(name: str, given: str | None) -> str:
    """The media type to keep: what the browser said, unless it said nothing
    useful (a command line sends application/octet-stream) - then the name's."""
    ct = (given or "").strip()
    if ct and ct.lower() not in ("application/octet-stream", "binary/octet-stream"):
        return ct[:120]
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def inline_type(doc: dict) -> str:
    """The type a file is served inline as: never one the browser would run
    as a page of its own - an .html file is shown as text."""
    ct = type_of(doc.get("name", ""), doc.get("content_type")).split(";")[0].strip().lower()
    if ct in ("text/html", "application/xhtml+xml"):
        return "text/plain; charset=utf-8"
    if PurePosixPath(doc.get("name", "").lower()).suffix == ".svg":
        return "image/svg+xml"
    return ct


# ---------------------------------------------------------------- folders

async def all_folders(db) -> list[dict]:
    return [d async for d in db[FOLDERS].find({}).sort("path", 1)]


def _subtree(folders: list[dict], root: str) -> set[str]:
    """A folder and every folder under it, by id."""
    kids: dict[str, list[str]] = {}
    for f in folders:
        kids.setdefault(f.get("parent") or "", []).append(f["_id"])
    out, todo = set(), [root]
    while todo:
        fid = todo.pop()
        if fid in out:
            continue
        out.add(fid)
        todo.extend(kids.get(fid, []))
    return out


async def _sibling_named(db, parent: str, name: str, but: str | None = None) -> bool:
    low = name.lower()
    async for f in db[FOLDERS].find({"parent": parent}):
        if f["_id"] != but and f["name"].lower() == low:
            return True
    return False


async def _path_of(db, parent: str, name: str) -> str:
    if not parent:
        return name
    p = await db[FOLDERS].find_one({"_id": parent})
    if not p:
        raise KeyError(parent)
    return f"{p['path']}/{name}"


async def make_folder(db, name: str, parent: str, by: dict) -> dict:
    name = check_name(name, 120)
    parent = parent or ""
    path = await _path_of(db, parent, name)
    if await _sibling_named(db, parent, name):
        raise Clash(f"there is a folder called {name!r} here already")
    doc = {"_id": secrets.token_hex(6), "name": name, "parent": parent, "path": path,
           "by": by, "created_at": _now()}
    await db[FOLDERS].insert_one(doc)
    return doc


async def make_path(db, path: str, by: dict) -> dict:
    """`a/b/c`, made as far as it is not there yet (mkdir -p)."""
    parts = [p for p in (path or "").strip().strip("/").split("/") if p.strip()]
    if not parts:
        raise ValueError("which folder?")
    parent, doc = "", None
    for part in parts:
        part = check_name(part, 120)
        doc = next((f for f in [x async for x in db[FOLDERS].find({"parent": parent})]
                    if f["name"].lower() == part.lower()), None)
        if doc is None:
            try:
                doc = await make_folder(db, part, parent, by)
            except Clash:
                # Made by another upload a moment ago (two pictures pasted at once).
                doc = next(f for f in [x async for x in db[FOLDERS].find({"parent": parent})]
                           if f["name"].lower() == part.lower())
        parent = doc["_id"]
    return doc


async def folder_by_path(db, path: str) -> dict | None:
    want = (path or "").strip().strip("/")
    if not want:
        return None
    for f in await all_folders(db):
        if f["path"].lower() == want.lower():
            return f
    raise KeyError(path)


async def _repath(db, root: str) -> None:
    """The path of a folder and everything under it, again, after a rename
    or a move."""
    folders = await all_folders(db)
    by_id = {f["_id"]: f for f in folders}
    under = _subtree(folders, root)

    def path(fid: str, seen=()) -> str:
        f = by_id[fid]
        p = f.get("parent") or ""
        if not p or p not in by_id or p in seen:
            return f["name"]
        return f"{path(p, (*seen, fid))}/{f['name']}"

    for fid in under:
        new = path(fid)
        if by_id[fid].get("path") != new:
            await db[FOLDERS].update_one({"_id": fid}, {"$set": {"path": new}})


async def rename_folder(db, fid: str, name: str) -> dict:
    doc = await db[FOLDERS].find_one({"_id": fid})
    if not doc:
        raise KeyError(fid)
    name = check_name(name, 120)
    if await _sibling_named(db, doc.get("parent") or "", name, but=fid):
        raise Clash(f"there is a folder called {name!r} here already")
    await db[FOLDERS].update_one({"_id": fid}, {"$set": {"name": name}})
    await _repath(db, fid)
    return await db[FOLDERS].find_one({"_id": fid})


async def move(db, file_ids: list[str], folder_ids: list[str], to: str) -> dict:
    """Files and folders into another folder ("" the top). A folder cannot
    go into itself or anything under it; a folder whose name is taken there
    is refused, and nothing moves."""
    to = to or ""
    folders = await all_folders(db)
    by_id = {f["_id"]: f for f in folders}
    if to and to not in by_id:
        raise KeyError(to)
    for fid in folder_ids:
        if fid not in by_id:
            raise KeyError(fid)
        if to in _subtree(folders, fid):
            raise ValueError(f"{by_id[fid]['name']!r} cannot go into itself or a folder inside it")
    names = {f["name"].lower() for f in folders if (f.get("parent") or "") == to and f["_id"] not in folder_ids}
    for fid in folder_ids:
        low = by_id[fid]["name"].lower()
        if (by_id[fid].get("parent") or "") != to and low in names:
            raise Clash(f"there is a folder called {by_id[fid]['name']!r} there already")
        names.add(low)
    moved_files = 0
    if file_ids:
        res = await db[COLL].update_many({"_id": {"$in": list(file_ids)}}, {"$set": {"folder": to}})
        moved_files = res.matched_count
    for fid in folder_ids:
        await db[FOLDERS].update_one({"_id": fid}, {"$set": {"parent": to}})
        await _repath(db, fid)
    return {"files": moved_files, "folders": len(folder_ids)}


async def files_under(db, fid: str) -> list[dict]:
    """Every file in a folder and the folders under it."""
    under = _subtree(await all_folders(db), fid)
    return [d async for d in db[COLL].find({"folder": {"$in": list(under)}}, {"gridfs_id": 0, "thumb": 0})]


async def remove_folder(db, fid: str, contents: bool, may_remove=lambda doc: True) -> dict:
    """A folder: empty, or with everything in it when `contents` says so.
    `may_remove(file)` is asked of every file first; one refused, and
    nothing is deleted."""
    folders = await all_folders(db)
    if fid not in {f["_id"] for f in folders}:
        raise KeyError(fid)
    under = _subtree(folders, fid)
    inside = [d async for d in db[COLL].find({"folder": {"$in": list(under)}}, {"by": 1, "name": 1})]
    if (inside or len(under) > 1) and not contents:
        raise Clash(f"the folder is not empty ({len(inside)} file(s), {len(under) - 1} folder(s))")
    refused = [d["name"] for d in inside if not may_remove(d)]
    if refused:
        raise PermissionError(", ".join(refused[:5]))
    for d in inside:
        await remove(db, d["_id"])
    await db[FOLDERS].delete_many({"_id": {"$in": list(under)}})
    return {"files": len(inside), "folders": len(under)}


# ---------------------------------------------------------------- reading part of one

def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """`Range: bytes=...` as (first, last), inclusive. None: no range (or
    one this does not understand - the whole file is the answer then).
    ValueError: a range that is past the end (416)."""
    if not header:
        return None
    m = re.fullmatch(r"\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(,.*)?", header)
    if not m or (not m.group(1) and not m.group(2)):
        return None
    a, b = m.group(1), m.group(2)
    if not a:                                   # the last n bytes
        n = int(b)
        if n == 0 or size == 0:
            raise ValueError("empty suffix range")
        return max(0, size - n), size - 1
    first = int(a)
    last = int(b) if b else size - 1
    if b and last < first:
        return None
    if first >= size:
        raise ValueError("past the end")
    return first, min(last, size - 1)


async def open_stream(db, doc: dict):
    return await _bucket(db).open_download_stream(doc["gridfs_id"])


async def stream(grid_out, first: int, last: int, piece: int = 256 * 1024):
    """The bytes first..last of a stored file, a piece at a time."""
    if first:
        grid_out.seek(first)
    left = last - first + 1
    while left > 0:
        data = await grid_out.read(min(piece, left))
        if not data:
            break
        left -= len(data)
        yield data


# ---------------------------------------------------------------- inside a file

TABLE_ROWS, TABLE_COLS = 2000, 200


def _decode(data: bytes) -> str:
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", errors="replace")
    for enc in ("utf-8-sig", "cp1254", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def _csv_rows(data: bytes, tsv: bool) -> tuple[list[list[str]], int]:
    text = _decode(data)
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    sep = "\t" if tsv or first.count("\t") > first.count(",") else (
        ";" if first.count(";") > first.count(",") else ",")
    rows, total = [], 0
    for row in csv.reader(io.StringIO(text), delimiter=sep):
        total += 1
        if len(rows) < TABLE_ROWS:
            rows.append([c[:500] for c in row[:TABLE_COLS]])
    return rows, total


_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
       "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
       "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
_XML_MAX = 80 * 1024 * 1024


def _col(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]*", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return max(n - 1, 0)


def _xlsx(data: bytes, sheet: int) -> tuple[list[str], list[list[str]], int]:
    """An .xlsx read with the standard library: the sheet names, and one
    sheet's cells as text. Formulas show their last value."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        def xml(name: str):
            info = z.getinfo(name)
            if info.file_size > _XML_MAX:
                raise ValueError("the sheet is too large to show")
            return ElementTree.fromstring(z.read(name))
        book = xml("xl/workbook.xml")
        rels = {r.get("Id"): r.get("Target") for r in xml("xl/_rels/workbook.xml.rels").findall("pr:Relationship", _NS)}
        sheets = [(s.get("name") or f"Sheet{i + 1}", rels.get(s.get(f"{{{_NS['r']}}}id"), ""))
                  for i, s in enumerate(book.findall("m:sheets/m:sheet", _NS))]
        if not sheets:
            return [], [], 0
        shared: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in xml("xl/sharedStrings.xml").findall("m:si", _NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
        sheet = max(0, min(sheet, len(sheets) - 1))
        target = sheets[sheet][1].lstrip("/")
        target = target if target.startswith("xl/") else f"xl/{target}"
        rows: list[list[str]] = []
        total = 0
        for row in xml(target).findall("m:sheetData/m:row", _NS):
            total += 1
            if len(rows) >= TABLE_ROWS:
                continue
            out: list[str] = []
            for c in row.findall("m:c", _NS):
                at = _col(c.get("r") or "")
                if at >= TABLE_COLS:
                    continue
                kind, v = c.get("t"), c.find("m:v", _NS)
                if kind == "s" and v is not None and (v.text or "").isdigit():
                    text = shared[int(v.text)] if int(v.text) < len(shared) else ""
                elif kind == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(f"{{{_NS['m']}}}t"))
                elif kind == "b":
                    text = "TRUE" if (v is not None and v.text == "1") else "FALSE"
                else:
                    text = v.text if v is not None and v.text is not None else ""
                while len(out) < at:
                    out.append("")
                out.append(text[:500])
            rows.append(out)
        return [s[0] for s in sheets], rows, total


def table_of(name: str, data: bytes, sheet: int = 0) -> dict:
    """A table file's cells, for the preview: at most TABLE_ROWS rows."""
    suffix = PurePosixPath(name.lower()).suffix
    if suffix in (".csv", ".tsv"):
        rows, total = _csv_rows(data, suffix == ".tsv")
        sheets = []
    elif suffix == ".xlsx":
        try:
            sheets, rows, total = _xlsx(data, sheet)
        except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as exc:
            raise ValueError(f"the workbook could not be read ({exc.__class__.__name__})") from exc
    else:
        raise ValueError("only CSV, TSV and XLSX are shown as a table")
    return {"sheets": sheets, "sheet": sheet if sheets else 0, "rows": rows,
            "total": total, "truncated": total > len(rows)}


ENTRIES_MAX = 5000


def entries_of(name: str, data: bytes) -> dict:
    """What is inside an archive: names, sizes, folders. Nothing is unpacked."""
    low = name.lower()
    out: list[dict] = []
    total = 0
    try:
        if low.endswith(".zip") or zipfile.is_zipfile(io.BytesIO(data)):
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for i in z.infolist():
                    total += 1
                    if len(out) < ENTRIES_MAX:
                        out.append({"name": i.filename, "bytes": i.file_size, "packed": i.compress_size,
                                    "dir": i.is_dir()})
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as t:
                for m in t:
                    total += 1
                    if len(out) < ENTRIES_MAX:
                        out.append({"name": m.name, "bytes": m.size, "dir": m.isdir()})
    except (zipfile.BadZipFile, tarfile.TarError, EOFError, OSError) as exc:
        raise ValueError("the archive could not be read - only ZIP and TAR are listed") from exc
    return {"entries": out, "total": total, "bytes": sum(e["bytes"] for e in out),
            "truncated": total > len(out)}


THUMB_PX = 480


def thumb_of(data: bytes) -> bytes:
    """A small picture of a picture, for the grid: WebP, at most 480 px."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as im:
        im.draft("RGB", (THUMB_PX, THUMB_PX))
        im = ImageOps.exif_transpose(im)
        im.thumbnail((THUMB_PX, THUMB_PX))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() or im.mode == "P" else "RGB")
        out = io.BytesIO()
        im.save(out, "WEBP", quality=80)
        return out.getvalue()


# A 3D file's picture is drawn in a browser - the server has no GPU - and
# sent here once (files_api.py `PUT /thumb`); it is kept by the file's
# content, per workspace, so every copy of the same STEP and everyone in
# the workspace shares it. It is shading only, grey on transparent: the
# page tints it with the theme's colour, so one picture suits every theme.
SOLID_THUMBS = "file_thumbs"
SOLID_MAX_BYTES = 512 * 1024
SOLID_MAX_PX = 1024
# Bumped when the page draws them differently, so older ones are drawn again.
SOLID_VERSION = 2


def solid_key(sha: str) -> str:
    return f"{sha}:v{SOLID_VERSION}"


def solid_thumb_of(data: bytes) -> bytes:
    """A 3D file's picture as the page sent it, checked and written again
    as WebP with its transparency: a PNG or a WebP, no larger than
    SOLID_MAX_PX a side. Raises ValueError for anything else."""
    from PIL import Image
    if len(data) > SOLID_MAX_BYTES:
        raise ValueError(f"larger than {SOLID_MAX_BYTES // 1024} kB")
    if not (data.startswith(b"\x89PNG\r\n\x1a\n") or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")):
        raise ValueError("not a PNG or a WebP")
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ("PNG", "WEBP"):
                raise ValueError("not a PNG or a WebP")
            w, h = im.size
            if not (16 <= w <= SOLID_MAX_PX and 16 <= h <= SOLID_MAX_PX):
                raise ValueError(f"{w} x {h} px - a side has to be 16 to {SOLID_MAX_PX} px")
            im = im.convert("RGBA")
            out = io.BytesIO()
            im.save(out, "WEBP", quality=85)
            return out.getvalue()
    except ValueError:
        raise
    except Exception as exc:                        # noqa: BLE001 - anything Pillow cannot read
        raise ValueError("the picture could not be read") from exc


def zip_names(entries: list[tuple[str, dict]]) -> list[tuple[str, dict]]:
    """Names inside a download's ZIP, made unique: `a.pdf`, `a (2).pdf`."""
    seen: set[str] = set()
    out = []
    for name, doc in entries:
        base, n, cand = name, 2, name
        while cand.lower() in seen:
            stem, dot, ext = base.rpartition(".")
            cand = f"{stem} ({n}).{ext}" if dot and stem and "/" not in ext else f"{base} ({n})"
            n += 1
        seen.add(cand.lower())
        out.append((cand, doc))
    return out


STORED = (".zip", ".7z", ".rar", ".gz", ".tgz", ".xz", ".bz2", ".jpg", ".jpeg", ".png", ".webp", ".gif",
          ".mp4", ".webm", ".mov", ".mp3", ".m4a", ".avif", ".pdf", ".xlsx", ".3mf", ".glb")


async def write_zip(db, entries: list[tuple[str, dict]], fh) -> None:
    """Every (name, file) into a ZIP written to `fh`; the compressed kinds
    are stored as they are."""
    with zipfile.ZipFile(fh, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
        for name, doc in zip_names(entries):
            how = zipfile.ZIP_STORED if PurePosixPath(name.lower()).suffix in STORED else zipfile.ZIP_DEFLATED
            info = zipfile.ZipInfo(name, date_time=_zip_time(doc.get("created_at")))
            info.compress_type = how
            grid = await open_stream(db, doc)
            with z.open(info, "w", force_zip64=True) as w:
                async for piece in stream(grid, 0, max(doc.get("bytes", 0) - 1, 0)):
                    w.write(piece)


def _zip_time(iso: str | None) -> tuple:
    try:
        d = datetime.fromisoformat(iso or "")
        return (max(d.year, 1980), d.month, d.day, d.hour, d.minute, d.second)
    except ValueError:
        return (1980, 1, 1, 0, 0, 0)
