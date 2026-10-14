"""Files on any Parts product: its 3D model, datasheets, drawings, pictures.

A product of any source holds files - a site's product (backend/
manufacturers.py), a My Items one (catalog_own.py), an LCSC part of the
drawer (catalog_lcsc.py: its own EasyEDA 3D stays; a STEP attached here is
an extra or an override the person chose), a saved McMaster-Carr part or
GrabCAD model (linked.py). The bytes live in Files like any other file
(files.py): a product only refers to them - a Files id, its name, kind and
hash - so a file attached to two products, or already in Files, is kept
once, and the CAD rooms, the Chat and the agents read it where they read
every file. A file dropped on a product, a ZIP's CAD files and PDFs, or a
file fetched from an address the person gave are put in Files first
(folder "Parts/<maker>"), then referred to; a file whose bytes Files holds
already is referred to as it is.

Where the references are kept:
  - a McMaster-Carr or GrabCAD item keeps them on itself (`linked_parts`:
    `files`, `cad`), as its drop zone always did;
  - every other product has a document of its own in `product_files` (the
    workspace's - backend/scope.py), keyed by the maker's id and the
    product's id - the same pair a stock line points at. It lives beside
    the catalog, so a site read again never drops it; and a full
    exploration keeps a product that holds files or stock even when the
    site no longer lists it (manufacturers.fold_in `keep`). A product
    deleted by hand leaves its document behind as an orphan, the files
    still in Files: `summary` says how many there are.

Each file has a role, read from its kind and name unless the person says:
a STEP, STP, STL, 3MF, OBJ or GLB is a 3D `model`; a PDF a `datasheet` (a
`drawing` when its name says drawing, çizim, teknik, ölçü...); a DXF or DWG
a `drawing`; a picture an `image`. One model is the product's `cad`: a new
STEP replaces the one before (which stays attached, listed, until it is
detached), a mesh never replaces a STEP unless asked. The `cad` is measured
as a saved McMaster part's is (backend/linked_measure.py, collection
`product_files`): its box, a screw's figures, an assembly's solids, and a
mismatch with what the product's specs or name say. One picture may be the
product's `picture`, shown in place of the one its page gave.

Rights: attaching is the catalog's right (access.py "draw"); detaching a
file someone else attached needs the right to delete, as removing someone
else's file in Files does. Removing the file from Files too is only for
whoever may delete it there, and only when no other product refers to it.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
import secrets
import urllib.parse
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import access, actors, linked_measure

COLL = "product_files"
MAX_FILES = 60                                   # on one product
MAX_ZIP = 40                                     # files kept out of one ZIP
FETCH_MAX = 100 * 1024 * 1024                    # bytes fetched from an address, at most
FETCH_TIMEOUT = 60.0
# Sites whose files Workbench never downloads (backend/linked.py: McMaster does
# not allow scraping, GrabCAD's files need its login): the person downloads
# them there and attaches them from Files or the drop zone.
NO_FETCH = ("mcmaster.com", "grabcad.com")
ROLES = ("model", "datasheet", "drawing", "image")
ROLE_NAMES = {"model": "3D model", "datasheet": "datasheet", "drawing": "drawing", "image": "picture"}
MODEL_SUFFIXES = (".step", ".stp", ".stl", ".3mf", ".obj", ".glb")
DRAWING_SUFFIXES = (".dxf", ".dwg")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".avif")
KEEP_SUFFIXES = MODEL_SUFFIXES + DRAWING_SUFFIXES + IMAGE_SUFFIXES + (".pdf",)
ACCEPT = ",".join(KEEP_SUFFIXES + (".zip",))
DRAWING_WORDS = re.compile(r"draw|dimension|dims\b|outline|footprint|cizim|çizim|teknik|olcu|ölçü|olculer|ölçüler",
                           re.I)


class Refused(Exception):
    """What cannot be done, said to the person (a 400, or the tool's error)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _who(by: dict | None = None) -> dict:
    by = by or actors.current() or {}
    return {"id": by.get("id"), "name": by.get("name")}


def suffix(name: str) -> str:
    return PurePosixPath((name or "").lower()).suffix


def role_of(name: str, kind: str = "") -> str | None:
    """What a file is to a product, from its kind and name; None when it is none of them."""
    sfx = suffix(name)
    if kind in ("step", "mesh") or sfx in MODEL_SUFFIXES:
        return "model"
    if sfx in DRAWING_SUFFIXES:
        return "drawing"
    if kind == "pdf" or sfx == ".pdf":
        return "drawing" if DRAWING_WORDS.search(PurePosixPath(name).stem) else "datasheet"
    if kind == "image" or sfx in IMAGE_SUFFIXES:
        return "image"
    return None


def not_kept(name: str) -> str:
    return (f"{name} is not a 3D model (STEP, STP, STL, 3MF, OBJ), a PDF, a drawing (DXF, DWG) or a picture - "
            "a product keeps only those")


def is_step(data: bytes) -> bool:
    return data[:4096].lstrip().startswith(b"ISO-10303-21")


# ---------------------------------------------------------------- the product and where its files are kept

async def target(db, mid: str, pid: str) -> tuple[dict, dict]:
    """(maker, product) by their ids - any source's -, or LookupError."""
    from . import catalog_builtin
    got = await catalog_builtin.find_product(db, str(mid or ""), str(pid or ""))
    if not got:
        raise LookupError(f"no product {pid} of {mid} in Parts")
    return got


def _linked_kind(mid: str):
    from . import linked
    return linked.KINDS.get(mid)


async def holder(db, mid: str, pid: str, product: dict | None = None, make: bool = False) -> tuple[str, dict | None]:
    """(collection, document) that keeps a product's files: a saved
    McMaster/GrabCAD item itself, else its `product_files` document (made
    when `make`)."""
    if _linked_kind(mid):
        from . import linked
        lid = ((product or {}).get("linked") or {}).get("id")
        doc = await db[linked.COLL].find_one({"_id": lid}) if lid else \
            await db[linked.COLL].find_one({"source": mid, "key": pid})
        return linked.COLL, doc
    doc = await db[COLL].find_one({"mid": mid, "pid": pid})
    if doc is None and make:
        doc = {"_id": secrets.token_hex(6), "mid": mid, "pid": pid, "name": (product or {}).get("name") or "",
               "files": [], "cad": None, "picture": None, "created_at": _now(), "updated_at": _now()}
        await db[COLL].insert_one(doc)
    return COLL, doc


def entries(doc: dict | None) -> list[dict]:
    """A holder's files, each with its role (a McMaster item's from before roles: read from its kind)."""
    return [{**f, "role": f.get("role") or role_of(f.get("name") or "", f.get("kind") or "") or "model"}
            for f in (doc or {}).get("files") or []]


# ---------------------------------------------------------------- putting files in Files

async def _folder(db, maker: dict, by: dict) -> str:
    from . import files
    name = re.sub(r"[/\\]+", " ", str(maker.get("name") or maker.get("_id") or "Parts")).strip()[:80] or "Parts"
    return (await files.make_path(db, f"Parts/{name}", by))["_id"]


async def keep_bytes(db, maker: dict, product: dict, name: str, data: bytes, by: dict) -> dict:
    """A file for a product, in Files: one of the same bytes already there is
    used as it is; otherwise it is put in the folder Parts/<maker>."""
    from . import files
    if not data:
        raise Refused(f"{name} is empty")
    if len(data) > files.MAX_BYTES:
        raise Refused(f"{name} is larger than {files.MAX_BYTES // (1024 * 1024)} MB")
    if suffix(name) in (".step", ".stp") and not is_step(data):
        raise Refused(f"{name} is not a STEP (it does not start with ISO-10303-21)")
    sha = hashlib.sha256(data).hexdigest()
    same = await db[files.COLL].find_one({"sha256": sha}, {"gridfs_id": 0, "thumb": 0})
    if same:
        return same
    note = f"{product.get('name') or product.get('id')} - {maker.get('name') or maker.get('_id')} (Parts)"
    return await files.put(db, name, data, None, {"room": "catalog", "product": f"{maker['_id']}:{product['id']}"},
                           by, note=note[:300], folder=await _folder(db, maker, by))


def unpack(name: str, data: bytes) -> list[tuple[str, bytes]]:
    """A ZIP's files a product keeps (3D models, PDFs, drawings, pictures),
    a folder's path left out; its own name when it is not a ZIP."""
    from . import files
    if suffix(name) != ".zip":
        return [(PurePosixPath(name).name, data)]
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise Refused(f"{name} could not be opened as a ZIP") from exc
    want = [i for i in z.infolist() if not i.is_dir() and suffix(i.filename) in KEEP_SUFFIXES
            and not PurePosixPath(i.filename).name.startswith(("._", "."))]
    if not want:
        raise Refused(f"there is no 3D model, PDF, drawing or picture in {name}")
    want = want[:MAX_ZIP]
    if sum(i.file_size for i in want) > files.MAX_BYTES:
        raise Refused(f"the files in {name} are larger than {files.MAX_BYTES // (1024 * 1024)} MB unpacked")
    # STEPs first, so the first of them becomes the product's model.
    want.sort(key=lambda i: (suffix(i.filename) not in (".step", ".stp"), suffix(i.filename) not in MODEL_SUFFIXES))
    return [(PurePosixPath(i.filename).name, z.read(i)) for i in want]


def _mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB" if n < 10 * 1048576 else f"{n // 1048576} MB"


def _name_from(url: str, headers) -> str:
    cd = headers.get("content-disposition") or ""
    m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", cd, re.I) or re.search(r'filename="?([^";]+)"?', cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1).strip())
    return urllib.parse.unquote(PurePosixPath(urllib.parse.urlsplit(url).path).name) or "download"


async def fetch(url: str) -> tuple[str, bytes]:
    """A file from an address the person gave: http(s), a public host
    (manufacturers.check: the crawler's rules), each redirect checked
    again, never McMaster-Carr or GrabCAD, at most FETCH_MAX bytes, and a
    file - not a web page."""
    from . import manufacturers as mf

    async def allowed(u: str) -> str:
        try:
            u = await mf.check(u)
        except mf.Refused as exc:
            raise Refused(f"{u}: {exc}") from exc
        dom = mf.registrable(urllib.parse.urlsplit(u).hostname or "")
        if dom in NO_FETCH:
            raise Refused(f"Workbench never downloads from {dom}: download the file on its page yourself and attach "
                          "it here (drop it on the product, or attach it in the Chat)")
        return u

    u = await allowed(str(url or "").strip() if "://" in str(url or "") else "https://" + str(url or "").strip())
    async with mf._client() as client:
        for _ in range(mf.MAX_REDIRECTS + 1):
            try:
                async with client.stream("GET", u) as r:
                    if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                        u = await allowed(urllib.parse.urljoin(u, r.headers["location"]))
                        continue
                    if r.status_code != 200:
                        raise Refused(f"{u} answered HTTP {r.status_code}")
                    ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
                    name = _name_from(u, r.headers)
                    if ctype in ("text/html", "application/xhtml+xml") and suffix(name) not in KEEP_SUFFIXES + (".zip",):
                        raise Refused(f"{u} is a web page, not a file - give the file's own link "
                                      "(the one that downloads the .step, .pdf ...)")
                    size = int(r.headers.get("content-length") or 0)
                    if size > FETCH_MAX:
                        raise Refused(f"the file at {u} is {_mb(size)} - more than {_mb(FETCH_MAX)} "
                                      "is not downloaded")
                    buf = bytearray()
                    async for chunk in r.aiter_bytes():
                        buf += chunk
                        if len(buf) > FETCH_MAX:
                            raise Refused(f"the file at {u} is more than {_mb(FETCH_MAX)} - it is not downloaded")
            except Refused:
                raise
            except Exception as exc:                    # noqa: BLE001 - the network's reason, said
                raise Refused(f"{u} could not be downloaded ({type(exc).__name__})") from exc
            data = bytes(buf)
            if suffix(name) not in KEEP_SUFFIXES + (".zip",):
                ext = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
                       "application/zip": ".zip", "model/stl": ".stl"}.get(ctype)
                if is_step(data):
                    ext = ".step"
                elif data[:5] == b"%PDF-":
                    ext = ".pdf"
                if not ext:
                    raise Refused(not_kept(name))
                name = (PurePosixPath(name).stem or "download") + ext
            return name, data
    raise Refused(f"{url} redirected too many times")


# ---------------------------------------------------------------- attaching, detaching

async def attach(db, mid: str, pid: str, fids: list[str], *, role: str | None = None, main: bool | None = None,
                 by: dict | None = None, measure: bool = True) -> tuple[dict, list[dict]]:
    """Files already in Files attached to a product (by reference). ZIPs are
    unpacked to the files a product keeps. Each gets a report: {file, name,
    role, status: attached | already | refused, why, main, replaced}.
    Returns (the product's files as `view` gives them, the reports)."""
    from . import files
    maker, product = await target(db, mid, pid)
    who = _who(by)
    if role and role not in ROLES:
        raise Refused(f"the role is one of {', '.join(ROLES)}")
    coll, doc = await holder(db, maker["_id"], str(product["id"]), product, make=True)
    if doc is None:
        raise LookupError(f"no product {pid} of {mid} in Parts")
    have = list(doc.get("files") or [])
    cad = doc.get("cad")
    sets: dict = {}
    reports: list[dict] = []
    todo: list[dict] = []
    took = False                                  # a model of this call became the product's: the others only join it
    for fid in dict.fromkeys(str(x) for x in fids if x):
        f = await db[files.COLL].find_one({"_id": fid}, {"gridfs_id": 0, "thumb": 0})
        if not f:
            reports.append({"file": fid, "name": fid, "status": "refused", "why": f"there is no file {fid} in Files"})
            continue
        if suffix(f["name"]) == ".zip":
            _, data = await files.get(db, fid)
            try:
                for n, d in unpack(f["name"], data):
                    todo.append(await keep_bytes(db, maker, product, n, d, who))
            except Refused as exc:
                reports.append({"file": fid, "name": f["name"], "status": "refused", "why": str(exc)})
            continue
        todo.append(f)
    for f in todo:
        r = role or role_of(f["name"], f.get("kind") or "")
        rep = {"file": f["_id"], "name": f["name"], "role": r, "kind": f.get("kind")}
        if not r:
            reports.append({**rep, "status": "refused", "why": not_kept(f["name"])})
            continue
        if r == "model" and f.get("kind") not in ("step", "mesh"):
            reports.append({**rep, "status": "refused", "why": f"{f['name']} is not a 3D model (STEP, STL, 3MF, OBJ)"})
            continue
        if r == "model" and f.get("kind") == "step":
            _, data = await files.get(db, f["_id"])
            if not is_step(data):
                reports.append({**rep, "status": "refused", "why": f"{f['name']} is not a STEP (it does not start "
                                                                   "with ISO-10303-21)"})
                continue
        same = next((x for x in have if x.get("file") == f["_id"] or (x.get("sha256") and x.get("sha256") == f.get("sha256"))),
                    None)
        if same:
            rep.update(status="already", file=same["file"], name=same["name"],
                       why=f"{same['name']} is attached already" + (" (the same bytes)" if same["file"] != f["_id"] else ""))
            entry = same
        else:
            if len(have) >= MAX_FILES:
                reports.append({**rep, "status": "refused", "why": f"a product keeps at most {MAX_FILES} files"})
                continue
            entry = {"file": f["_id"], "name": f["name"], "kind": f.get("kind") or "other", "role": r,
                     "bytes": f.get("bytes") or 0, "sha256": f.get("sha256") or "", "original": f["name"][:200],
                     "by": who, "at": _now()}
            have.insert(0, entry)
            rep["status"] = "attached"
        # Which model is the product's: a new STEP takes the place of the one before, a mesh only of a mesh or of none.
        if r == "model" and main is not False:
            take = main is True or not cad or cad.get("file") == entry["file"] or \
                (entry["kind"] == "step") or (cad.get("kind") == "mesh" and entry["kind"] == "mesh")
            if take and not took and (cad or {}).get("file") != entry["file"]:
                took = True
                if cad:
                    rep["replaced"] = cad.get("name")
                cad = {k: entry[k] for k in ("file", "name", "kind", "bytes", "sha256", "by", "at")}
                sets["cad"] = cad
            rep["main"] = (cad or {}).get("file") == entry["file"]
        if r == "image" and main:
            sets["picture"] = {"file": entry["file"], "name": entry["name"]}
            rep["main"] = True
        reports.append(rep)
    if any(x["status"] == "attached" for x in reports) or sets:
        sets.update(files=have, updated_at=_now(), **({"name": product.get("name") or ""} if coll == COLL else {}))
        unset = {"measured": "", "measuring": ""} if "cad" in sets else {}
        await db[coll].update_one({"_id": doc["_id"]}, {"$set": sets, **({"$unset": unset} if unset else {})})
        doc = {**doc, **sets}
        for k in unset:
            doc.pop(k, None)
        await actors.audit(db, "product-files", f"{maker['_id']}:{product['id']}",
                           {"files": [x["file"] for x in reports if x["status"] == "attached"][:10]})
    if measure and linked_measure.stale(doc):
        linked_measure.start(db, doc["_id"], coll)
    return await view(db, maker, product, doc, coll, resume=measure), reports


async def put(db, mid: str, pid: str, name: str, data: bytes, *, role: str | None = None, main: bool | None = None,
              by: dict | None = None, measure: bool = True) -> tuple[dict, list[dict]]:
    """Bytes for a product - dropped on it, or fetched -: kept in Files
    (a ZIP unpacked first), then attached."""
    maker, product = await target(db, mid, pid)
    who = _who(by)
    got = unpack(name, data)
    if len(got) == 1 and not role and not role_of(got[0][0]):
        raise Refused(not_kept(got[0][0]))
    kept = [await keep_bytes(db, maker, product, n, d, who) for n, d in got if role or role_of(n)]
    return await attach(db, mid, pid, [f["_id"] for f in kept], role=role, main=main, by=by, measure=measure)


def may_detach(entry: dict) -> bool:
    """One's own attachment, or anyone's with the right to delete."""
    return (entry.get("by") or {}).get("id") == (actors.current() or {}).get("id") or \
        access.allowed(access.current(), "delete")


async def users_of(db, fid: str, but: tuple[str, str] | None = None) -> list[str]:
    """The other products ("maker:product") that refer to a file."""
    from . import linked
    def has(d):
        return any(f.get("file") == fid for f in d.get("files") or [])
    out = [f"{d['mid']}:{d['pid']}" async for d in db[COLL].find({}, {"mid": 1, "pid": 1, "files": 1}) if has(d)]
    out += [f"{d['source']}:{d['key']}" async for d in db[linked.COLL].find({}, {"source": 1, "key": 1, "files": 1})
            if has(d)]
    return [x for x in out if not but or x != f"{but[0]}:{but[1]}"]


async def detach(db, mid: str, pid: str, fid: str, *, delete_file: bool = False, measure: bool = True) -> dict:
    """A file no longer the product's. Its model, if it was, is the next
    model attached (or none). The file stays in Files unless `delete_file`
    - and then only for whoever may delete it there, and only when no
    other product refers to it. {removed, cad, deleted, kept_because, models}."""
    from . import files
    try:
        maker, product = await target(db, mid, pid)
        coll, doc = await holder(db, maker["_id"], str(product["id"]), product)
    except LookupError:
        maker, product = {"_id": mid}, {"id": pid}           # an orphan's files can still be let go
        coll, doc = COLL, await db[COLL].find_one({"mid": mid, "pid": pid})
    have = entries(doc)
    entry = next((x for x in have if x["file"] == fid), None)
    if not doc or not entry:
        raise LookupError(f"{fid} is not attached to {pid}")
    if not may_detach(entry):
        raise PermissionError("only whoever attached it, or someone who may delete, can detach it - "
                              + access.refusal(access.current() or "nobody", "delete"))
    rest = [x for x in doc.get("files") or [] if x.get("file") != fid]
    sets: dict = {"files": rest, "updated_at": _now()}
    unset: dict = {}
    cad = doc.get("cad")
    if (cad or {}).get("file") == fid:
        models = [x for x in rest if x.get("kind") in ("step", "mesh")]
        nxt = next((x for x in models if x["kind"] == "step"), models[0] if models else None)
        sets["cad"] = {k: nxt[k] for k in ("file", "name", "kind", "bytes", "sha256", "by", "at") if k in nxt} if nxt else None
        unset = {"measured": "", "measuring": ""}
    if ((doc.get("picture") or {}).get("file")) == fid:
        sets["picture"] = None
    await db[coll].update_one({"_id": doc["_id"]}, {"$set": sets, **({"$unset": unset} if unset else {})})
    out = {"removed": entry["name"], "cad": (sets.get("cad") or {}).get("name") if "cad" in sets else (cad or {}).get("name"),
           "deleted": False, "kept_because": "", "models": []}
    f = await db[files.COLL].find_one({"_id": fid}, {"model": 1, "by": 1, "name": 1})
    if f and f.get("model"):
        out["models"] = [f["model"]]            # a model made of it holds its own copy (main.py files_to_model)
    if delete_file and f:
        others = await users_of(db, fid, (maker["_id"], str(product["id"])))
        if others:
            out["kept_because"] = f"{', '.join(others[:5])} still refer(s) to it"
        elif not ((f.get("by") or {}).get("id") == (actors.current() or {}).get("id")
                  or access.allowed(access.current(), "delete")):
            out["kept_because"] = "removing someone else's file from Files needs the right to delete"
        else:
            out["deleted"] = await files.remove(db, fid)
    await actors.audit(db, "product-files-detach", f"{maker['_id']}:{product['id']}", {"file": fid, **out})
    if measure and linked_measure.stale({**doc, **sets}):
        linked_measure.start(db, doc["_id"], coll)
    return out


async def set_main(db, mid: str, pid: str, fid: str, measure: bool = True) -> dict:
    """An attached file made the product's own: a 3D model its `cad` (and
    measured), a picture its `picture`."""
    maker, product = await target(db, mid, pid)
    coll, doc = await holder(db, maker["_id"], str(product["id"]), product)
    entry = next((x for x in entries(doc) if x["file"] == fid), None)
    if not entry:
        raise LookupError(f"{fid} is not attached to {product.get('name') or pid}")
    if entry["role"] == "model" and entry.get("kind") in ("step", "mesh"):
        sets = {"cad": {k: entry[k] for k in ("file", "name", "kind", "bytes", "sha256", "by", "at") if k in entry}}
        unset = {"measured": "", "measuring": ""} if (doc.get("cad") or {}).get("file") != fid else {}
    elif entry["role"] == "image":
        if _linked_kind(maker["_id"]):
            raise Refused(f"a {maker.get('name')} item shows its CAD file's picture; its pictures stay attached")
        sets, unset = {"picture": {"file": fid, "name": entry["name"]}}, {}
    else:
        raise Refused(f"{entry['name']} is a {ROLE_NAMES[entry['role']]}: only a 3D model or a picture can be the "
                      "product's own")
    await db[coll].update_one({"_id": doc["_id"]}, {"$set": {**sets, "updated_at": _now()},
                                                    **({"$unset": unset} if unset else {})})
    doc = {**doc, **sets}
    for k in unset:
        doc.pop(k, None)
    if measure and linked_measure.stale(doc):
        linked_measure.start(db, doc["_id"], coll)
    return await view(db, maker, product, doc, coll, resume=measure)


# ---------------------------------------------------------------- reading them

def measurable(maker: dict, product: dict, doc: dict) -> dict:
    """The holder as linked_measure reads an item: the product's name and
    category for its words, its specs - and what its name says of its size
    where the specs do not."""
    k = _linked_kind(maker["_id"])
    if k:
        return doc
    return {**doc, "title": product.get("name") or "", "tags": [product.get("category") or ""],
            "specs": {**linked_measure.title_specs(product.get("name") or ""), **(product.get("specs") or {})}}


async def view(db, maker: dict, product: dict, doc: dict | None = None, coll: str | None = None,
               resume: bool = True) -> dict:
    """A product's files as the page and the tools read them: {maker,
    product, name, files (each with role and whether its picture is drawn),
    cad, measured (linked_measure.view), picture, orphan: false}."""
    from . import files
    if coll is None:
        coll, doc = await holder(db, maker["_id"], str(product["id"]), product)
    doc = doc or {}
    k = _linked_kind(maker["_id"])
    fl = entries(doc)
    keys = {files.solid_key(f["sha256"]) for f in fl if f.get("sha256") and f.get("role") == "model"}
    drawn = set()
    if keys:
        drawn = {x["_id"] async for x in db[files.SOLID_THUMBS].find({"_id": {"$in": list(keys)}}, {"_id": 1})}
    for f in fl:
        f["has_thumb"] = f"{f['sha256'][:12]}.{files.SOLID_VERSION}" if f.get("sha256") and \
            files.solid_key(f["sha256"]) in drawn else None
    cad = doc.get("cad")
    if cad:
        cad = {**cad, "has_thumb": next((f["has_thumb"] for f in fl if f["file"] == cad["file"]), None)}
    measured = linked_measure.view(measurable(maker, product, doc), k.specs_of if k else None) if doc else None
    if resume and doc.get("_id"):
        linked_measure.resume(db, doc, coll)          # one a reload cut off is measured again
    lcsc_3d = None
    if maker["_id"] == "lcsc":
        lcsc_3d = bool((product.get("part") or {}).get("has_3d"))
    return {"maker": maker["_id"], "maker_name": maker.get("name") or maker["_id"], "product": str(product["id"]),
            "name": product.get("name") or str(product["id"]), "files": fl, "cad": cad, "measured": measured,
            "picture": doc.get("picture"), "linked": bool(k), "lcsc_3d": lcsc_3d,
            "accept": ACCEPT, "updated_at": doc.get("updated_at")}


async def of(db, mid: str, pid: str) -> dict:
    maker, product = await target(db, mid, pid)
    return await view(db, maker, product)


async def summary(db) -> dict:
    """Every product that holds files, in one read: {"maker:product":
    {files, roles: {model: n, ...}, cad: kind, box, mismatch, pending,
    picture}} - for the 3D badge of the cards and rows, and for "which
    products have no 3D model". Orphans (their product deleted) are listed
    apart, with their files' names."""
    from . import files, linked
    out: dict[str, dict] = {}

    def one(doc: dict, title: str = "") -> dict:
        fl = entries(doc)
        roles: dict[str, int] = {}
        for f in fl:
            roles[f["role"]] = roles.get(f["role"], 0) + 1
        m = doc.get("measured") or {}
        cad = doc.get("cad") or {}
        v = linked_measure.view({**doc, "title": title, "specs": {}}) if cad else None
        return {"files": len(fl), "roles": roles, "cad": cad.get("kind"), "cad_name": cad.get("name"),
                "cad_file": cad.get("file"), "sha": cad.get("sha256") or "",
                "box": m.get("size") if not m.get("error") else None, "pending": bool(v and v.get("pending")),
                "error": m.get("error") if cad else None,
                "picture": (doc.get("picture") or {}).get("file")}

    docs = [d async for d in db[COLL].find({})]
    for d in docs:
        if d.get("files"):
            out[f"{d['mid']}:{d['pid']}"] = {**one(d, d.get("name") or ""), "name": d.get("name") or ""}
    async for d in db[linked.COLL].find({}):
        if not d.get("files"):
            continue
        out[f"{d['source']}:{d['key']}"] = {**one(d, d.get("title") or ""), "name": d.get("title") or d["key"]}
    # The model's picture, where a page has drawn it (files.py): a card without a picture of its own shows it.
    shas = {h["sha"] for h in out.values() if h.get("sha")}
    drawn = set()
    if shas:
        drawn = {x["_id"] async for x in db[files.SOLID_THUMBS].find(
            {"_id": {"$in": [files.solid_key(x) for x in shas]}}, {"_id": 1})}
    for h in out.values():
        sha = h.pop("sha", "")
        h["thumb"] = (f"/api/files/{h['cad_file']}/thumb?v={sha[:12]}.{files.SOLID_VERSION}"
                      if sha and files.solid_key(sha) in drawn else None)
    # Which of them lost their product (deleted by hand): said, never dropped.
    orphans = []
    if docs:
        have = await _catalog_keys(db)
        for d in docs:
            key = f"{d['mid']}:{d['pid']}"
            if d.get("files") and key not in have:
                out[key]["orphan"] = True
                orphans.append(key)
    return {"products": out, "orphans": orphans}


async def _catalog_keys(db) -> set[str]:
    """"maker:product" of every product in Parts, of every source."""
    from . import catalog_builtin
    have: set[str] = set()
    for m in await catalog_builtin.makers(db):
        have |= {f"{m['_id']}:{p['id']}" for p in m.get("products") or []}
    async for m in db["manufacturers"].find({}, {"products.id": 1}):
        have |= {f"{m['_id']}:{p.get('id')}" for p in m.get("products") or []}
    return have


# ---------------------------------------------------------------- orphans: files whose product is gone

async def orphans(db) -> list[dict]:
    """The products deleted by hand whose files are still referred to,
    newest first: each with its maker's name (when the maker is still
    there), its files - their roles, and whether Files still holds them -
    and which was its model."""
    from . import files
    docs = [d async for d in db[COLL].find({}) if d.get("files")]
    if not docs:
        return []
    have = await _catalog_keys(db)
    out = []
    for d in docs:
        if f"{d['mid']}:{d['pid']}" in have:
            continue
        fl = entries(d)
        held = {x["_id"] async for x in db[files.COLL].find({"_id": {"$in": [f["file"] for f in fl]}}, {"_id": 1})}
        m = await db["manufacturers"].find_one({"_id": d["mid"]}, {"name": 1})
        out.append({"mid": d["mid"], "pid": d["pid"], "name": d.get("name") or "", "maker_name": (m or {}).get("name") or "",
                    "files": [{**f, "in_files": f["file"] in held} for f in fl],
                    "cad": (d.get("cad") or {}).get("file"), "picture": (d.get("picture") or {}).get("file"),
                    "updated_at": d.get("updated_at")})
    out.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return out


async def _orphan(db, mid: str, pid: str) -> dict:
    """An orphan's document, or LookupError / Refused when it is none."""
    doc = await db[COLL].find_one({"mid": mid, "pid": pid})
    if not doc:
        raise LookupError(f"no files are kept for {mid}:{pid}")
    if f"{mid}:{pid}" in await _catalog_keys(db):
        raise Refused(f"{doc.get('name') or pid} is still in Parts: its files are its own, not an orphan's")
    return doc


async def adopt(db, mid: str, pid: str, to_mid: str, to_pid: str, measure: bool = True) -> dict:
    """An orphan's files attached to a product of Parts: its model the
    product's model only when it has none (a STEP never replaces one it
    has), its picture its picture only when it has none. What was attached
    leaves the orphan; once nothing is left, the orphan is gone.
    {product: its files as `view` gives them, report, left}."""
    doc = await _orphan(db, mid, pid)
    fl = entries(doc)
    cad = (doc.get("cad") or {}).get("file")
    ids = ([cad] if cad else []) + [f["file"] for f in fl if f["file"] != cad]
    before = await of(db, to_mid, to_pid)
    v, reps = await attach(db, to_mid, to_pid, ids, main=None if not before.get("cad") else False, measure=measure)
    pic = (doc.get("picture") or {}).get("file")
    took = {r["file"] for r in reps if r.get("status") in ("attached", "already")}
    if pic and pic in took and not before.get("picture") and not before.get("linked"):
        v = await set_main(db, to_mid, to_pid, pic, measure=measure)
    rest = [f for f in doc.get("files") or [] if f.get("file") not in took]
    if rest:
        await db[COLL].update_one({"_id": doc["_id"]}, {"$set": {"files": rest, "updated_at": _now()}})
    else:
        await db[COLL].delete_one({"_id": doc["_id"]})
    await actors.audit(db, "product-files-adopt", f"{mid}:{pid}", {"to": f"{to_mid}:{to_pid}", "files": sorted(took)[:20]})
    return {"product": v, "report": reps, "left": len(rest)}


async def forget(db, mid: str, pid: str, delete_files: bool = False) -> dict:
    """An orphan let go. Its files stay in Files unless `delete_files` -
    then each goes only when nothing else refers to it, and only for
    whoever may delete it there (its own uploader, or the right to delete),
    as detaching does. {removed: [names], kept: [[name, why]]}."""
    from . import files
    doc = await _orphan(db, mid, pid)
    removed: list[str] = []
    kept: list[list[str]] = []
    if delete_files:
        for f in entries(doc):
            others = await users_of(db, f["file"], (mid, pid))
            if others:
                kept.append([f["name"], f"{', '.join(others[:5])} still refer(s) to it"])
                continue
            fd = await db[files.COLL].find_one({"_id": f["file"]}, {"by": 1})
            if not fd:
                continue
            if not ((fd.get("by") or {}).get("id") == (actors.current() or {}).get("id")
                    or access.allowed(access.current(), "delete")):
                kept.append([f["name"], "removing someone else's file from Files needs the right to delete"])
                continue
            if await files.remove(db, f["file"]):
                removed.append(f["name"])
    await db[COLL].delete_one({"_id": doc["_id"]})
    await actors.audit(db, "product-files-forget", f"{mid}:{pid}", {"removed": removed[:20], "kept": len(kept)})
    return {"removed": removed, "kept": kept}


async def card_line(db, mid: str, pid: str) -> str:
    """"3D model (STEP) + 2 files" - what a product's card in Chat says of its files ("" for none)."""
    try:
        coll, doc = await holder(db, mid, pid)
    except Exception:                                   # noqa: BLE001 - a card without it
        return ""
    fl = entries(doc)
    if not fl:
        return ""
    cad = (doc or {}).get("cad")
    rest = len(fl) - (1 if cad else 0)
    bits = [f"3D model ({'STEP' if cad['kind'] == 'step' else 'mesh'})"] if cad else []
    if rest:
        bits.append(f"{rest} file" + ("s" if rest > 1 else ""))
    return " + ".join(bits)


# ---------------------------------------------------------------- export and import with a maker's catalog

async def export_refs(db, mid: str) -> dict[str, list[dict]]:
    """A maker's products' files as references - name, role, kind, hash -
    for its export file: the bytes stay in Files."""
    out: dict[str, list[dict]] = {}
    async for d in db[COLL].find({"mid": mid}):
        cad = (d.get("cad") or {}).get("file")
        if d.get("files"):
            out[d["pid"]] = [{"name": f["name"], "role": f.get("role"), "kind": f.get("kind"), "bytes": f.get("bytes"),
                              "sha256": f.get("sha256"), **({"main": True} if f["file"] == cad else {})}
                             for f in entries(d)]
    return out


async def import_refs(db, mid: str, products: list[dict], refs_by_key: dict[str, list[dict]],
                      by: dict | None = None) -> dict:
    """References an export file brings, attached again to the imported
    products wherever Files here holds the same bytes. {linked, missing}."""
    from . import files
    from . import manufacturers as mf
    linked_n, missing = 0, []
    for p in products:
        refs = refs_by_key.get(mf.product_key(p)) or []
        ids, main = [], None
        for r in refs:
            f = await db[files.COLL].find_one({"sha256": r.get("sha256")}, {"_id": 1}) if r.get("sha256") else None
            if f:
                ids.append(f["_id"])
                if r.get("main"):
                    main = f["_id"]
            else:
                missing.append(str(r.get("name") or "?"))
        if ids:
            _, reps = await attach(db, mid, p["id"], [main, *[i for i in ids if i != main]] if main else ids, by=by)
            linked_n += sum(1 for x in reps if x["status"] == "attached")
    return {"linked": linked_n, "missing": missing[:50]}


async def kept_ids(db, mid: str) -> set[str]:
    """The products of a maker a full exploration keeps although its site
    no longer lists them: those holding files, and those counted in stock."""
    from . import inventory
    ids = {d["pid"] async for d in db[COLL].find({"mid": mid}, {"pid": 1, "files": 1}) if d.get("files")}
    ids |= set((await inventory.stock_of(db, mid)).get(mid, {}))
    return ids


async def measure_later(db, mid: str, pid: str, background) -> bool:
    """A route's model measured after its answer has gone (as linked.py's
    drop does): the page asks for the product's files again. Whether it was."""
    try:
        maker, product = await target(db, mid, pid)
    except LookupError:
        return False
    coll, doc = await holder(db, maker["_id"], str(product["id"]), product)
    if doc and linked_measure.stale(doc) and linked_measure.hold(db, doc["_id"], coll):
        background.add_task(linked_measure.measure_quietly, db, doc["_id"], held=True, coll=coll)
        return True
    return False


async def wait_measured(db, mid: str, pid: str, seconds: float = 20.0) -> dict:
    """The product's files once its model is measured, or as they are after `seconds`."""
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        v = await of(db, mid, pid)
        if not (v.get("measured") or {}).get("pending") or asyncio.get_running_loop().time() > deadline:
            return v
        await asyncio.sleep(0.4)


# ---------------------------------------------------------------- routes

router = APIRouter()
BASE = "/api/manufacturers/{mid}/products/{pid}/files"


def _db():
    from .main import db
    return db()


def _http(exc: Exception):
    if isinstance(exc, LookupError):
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    if isinstance(exc, PermissionError):
        raise HTTPException(403, str(exc)) from exc
    raise HTTPException(400, str(exc)) from exc


@router.get("/api/product-files/summary")
async def api_summary() -> dict:
    return await summary(_db())


@router.get(BASE)
async def api_of(mid: str, pid: str) -> dict:
    """A product's files and what its model measured: the page asks again while it is measured."""
    try:
        return await of(_db(), mid, pid)
    except LookupError as exc:
        _http(exc)


@router.post(BASE)
async def api_put(mid: str, pid: str, upload: UploadFile, background: BackgroundTasks, role: str | None = None,
                  main: bool | None = None) -> dict:
    """A file dropped on the product (a ZIP's files unpacked): kept in Files,
    attached; a new model is measured after the answer has gone."""
    from . import files
    data = await upload.read(files.MAX_BYTES + 1)
    if len(data) > files.MAX_BYTES:
        raise HTTPException(413, f"larger than {files.MAX_BYTES // (1024 * 1024)} MB")
    try:
        v, reps = await put(_db(), mid, pid, upload.filename or "file", data, role=role, main=main, measure=False)
    except (LookupError, Refused, ValueError) as exc:
        _http(exc)
    await measure_later(_db(), mid, pid, background)
    return {**v, "report": reps}


class AttachIn(BaseModel):
    files: list[str] = Field(default_factory=list, max_length=40)     # Files ids
    url: str | None = Field(default=None, max_length=2000)            # or one address to fetch it from
    role: str | None = Field(default=None, max_length=20)
    main: bool | None = None


@router.post(BASE + "/attach")
async def api_attach(mid: str, pid: str, body: AttachIn, background: BackgroundTasks) -> dict:
    """Files already in Files - or one fetched from an address - attached to the product."""
    try:
        if body.url:
            name, data = await fetch(body.url)
            v, reps = await put(_db(), mid, pid, name, data, role=body.role, main=body.main, measure=False)
        elif body.files:
            v, reps = await attach(_db(), mid, pid, body.files, role=body.role, main=body.main, measure=False)
        else:
            raise Refused("give the Files ids to attach, or an address to download from")
    except (LookupError, Refused, ValueError) as exc:
        _http(exc)
    await measure_later(_db(), mid, pid, background)
    return {**v, "report": reps}


class MainIn(BaseModel):
    main: bool = True


@router.patch(BASE + "/{fid}")
async def api_main(mid: str, pid: str, fid: str, body: MainIn, background: BackgroundTasks) -> dict:
    """An attached 3D model made the product's model, or a picture its picture."""
    try:
        v = await set_main(_db(), mid, pid, fid, measure=False)
    except (LookupError, Refused) as exc:
        _http(exc)
    await measure_later(_db(), mid, pid, background)
    return v


@router.delete(BASE + "/{fid}")
async def api_detach(mid: str, pid: str, fid: str, background: BackgroundTasks, delete_file: bool = False) -> dict:
    try:
        out = await detach(_db(), mid, pid, fid, delete_file=delete_file, measure=False)
    except (LookupError, PermissionError) as exc:
        _http(exc)
    await measure_later(_db(), mid, pid, background)
    try:
        return {**out, "product": await of(_db(), mid, pid)}
    except LookupError:
        return {**out, "product": None}


@router.get("/api/product-files/orphans")
async def api_orphans() -> list[dict]:
    """The files of products deleted by hand, for the Parts page to attach elsewhere or let go."""
    return await orphans(_db())


class AdoptIn(BaseModel):
    maker: str = Field(min_length=1, max_length=200)
    product: str = Field(min_length=1, max_length=200)


# Under /api/manufacturers, so attaching them and letting them go are the catalog's right ("draw", access.py).
@router.post("/api/manufacturers/orphan-files/{mid}/{pid}/adopt")
async def api_adopt(mid: str, pid: str, body: AdoptIn, background: BackgroundTasks) -> dict:
    """An orphan's files attached to another product."""
    try:
        out = await adopt(_db(), mid, pid, body.maker, body.product, measure=False)
    except (LookupError, Refused, ValueError) as exc:
        _http(exc)
    await measure_later(_db(), body.maker, body.product, background)
    return out


@router.delete("/api/manufacturers/orphan-files/{mid}/{pid}")
async def api_forget(mid: str, pid: str, delete_files: bool = False) -> dict:
    """An orphan let go; its files removed from Files too when asked and allowed."""
    try:
        return await forget(_db(), mid, pid, delete_files)
    except (LookupError, Refused) as exc:
        _http(exc)


class ToModel(BaseModel):
    folder: str = Field(min_length=1, max_length=300)
    title: str | None = Field(default=None, max_length=120)
    file: str | None = Field(default=None, max_length=40)


async def to_model(db, mid: str, pid: str, folder: str, title: str | None = None, fid: str | None = None) -> dict:
    """The product's 3D model (or one of its attached models) into a
    project as a model of its own, as Files' "Add to project" makes one
    (main.py files_to_model: the bytes copied, a build started - no agent)."""
    from .main import FileToModel, files_to_model
    maker, product = await target(db, mid, pid)
    coll, doc = await holder(db, maker["_id"], str(product["id"]), product)
    fl = entries(doc)
    fid = fid or ((doc or {}).get("cad") or {}).get("file")
    entry = next((x for x in fl if x["file"] == fid), None)
    if not fid or not entry:
        raise Refused(f"{product.get('name') or pid} has no 3D model attached - attach its STEP first")
    if entry.get("kind") not in ("step", "mesh"):
        raise Refused(f"{entry['name']} is not a 3D model")
    name = title or f"{maker.get('name') or maker['_id']} {product.get('name') or pid}"
    return await files_to_model(fid, FileToModel(folder=folder, title=name[:120]))


@router.post("/api/manufacturers/{mid}/products/{pid}/to-model")
async def api_to_model(mid: str, pid: str, body: ToModel) -> dict:
    try:
        return await to_model(_db(), mid, pid, body.folder, body.title, body.file)
    except (LookupError, Refused) as exc:
        _http(exc)
