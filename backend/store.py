"""Everything project-related lives in MongoDB; local disk is scratch space only.

Collections
    folders        {_id: path, name, parent}
    models         {_id: path, folder, name, title, source, sha256, updated_at,
                    artifacts: {viewer|step|stl: {gridfs_id, bytes, sha256}},
                    version, uses, built, link, pins}       (backend/links.py)
    boards         ... component: {version, digest, module, ...},
                    artifacts.step|board3d|stl              (backend/board3d.py)
    component_versions  a copy of each version a pin can point at
    revisions      {..., image: {gridfs_id, bytes}}

GridFS buckets
    model_files    generated viewer/step/stl files (gzipped)
    shots          revision images (raw PNG)
"""

from __future__ import annotations

import ast
import gzip
import hashlib
import os
import re
from pathlib import Path
from datetime import datetime, timezone
from . import scope

SAFE = re.compile(r"^[A-Za-z0-9_-]+$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def bucket(db, name: str):
    from motor.motor_asyncio import AsyncIOMotorGridFSBucket
    # Reached through the API (tools/remote_db.py): its own stand-in. Asked
    # of the class - a Motor database answers any attribute with a
    # collection, so hasattr() on the instance is always true.
    if getattr(type(db), "REMOTE", False):
        return db.gridfs(name)
    # Stored files are shared: the documents that point at them are what
    # belong to a workspace.
    # The workspace view (scope.ScopedDb) hands over the database itself.
    # Asked of the class, like REMOTE above: getattr(db, "raw") on a plain
    # Motor database is a collection called "raw".
    return AsyncIOMotorGridFSBucket(db.raw if getattr(type(db), "SCOPED", False) else db,
                                    bucket_name=name)


# ---------------- reading metadata from source ----------------
def read_meta(source: str) -> dict:
    """Read TITLE and PARTS without executing; importing is expensive and risky."""
    title, has_parts = None, False
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {"title": None, "ready": False, "error": "syntax error"}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for t in node.targets:
            if not isinstance(t, ast.Name):
                continue
            if t.id == "TITLE" and isinstance(node.value, ast.Constant):
                title = str(node.value.value)
            if t.id == "PARTS":
                has_parts = True
    return {"title": title, "ready": has_parts, "error": None}


# ---------------- folders ----------------
# The archive rule lives here rather than in the route, because the CLI marks
# revisions applied too and used to write straight to Mongo, so a task closed
# from the terminal was never filed away.
SETTINGS_ID = "app"
DEFAULT_SETTINGS = {"auto_archive": False, "auto_translate": False}


async def settings(db) -> dict:
    doc = await db.settings.find_one({"_id": scope.key(SETTINGS_ID)}) or {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in doc.items() if k != "_id"}}


async def set_status(db, rev_id: str, status: str) -> dict | None:
    """Move a revision to `status`; returns the patch, or None if unknown."""
    patch = {"status": status,
             "queued_at": now() if status == "queued" else None}
    if status == "applied":
        # When it was applied, so the card can sit next to what the work cost.
        patch["applied_at"] = now()
        if (await settings(db))["auto_archive"]:
            patch["archived"] = True
    res = await db.revisions.update_one({"_id": rev_id}, {"$set": patch})
    return patch if res.matched_count else None


async def create_folder(db, parent: str, name: str) -> str:
    if not SAFE.match(name):
        raise ValueError("folder name may only contain letters, digits, - and _")
    path = f"{parent}/{name}" if parent else name
    if await db.folders.find_one({"_id": path}):
        raise FileExistsError(f"{path} already exists")
    if parent and not await db.folders.find_one({"_id": parent}):
        raise ValueError(f"parent folder missing: {parent}")
    await db.folders.insert_one({"_id": path, "name": name, "parent": parent})
    return path


async def delete_folder(db, path: str) -> None:
    if await db.models.count_documents({"folder": path}):
        raise ValueError("folder is not empty")
    if await db.folders.count_documents({"parent": path}):
        raise ValueError("folder is not empty")
    await db.folders.delete_one({"_id": path})


# ---------------- uploads ----------------
# CAD files the user brings in (STEP/IGES/BREP/STL). They are not models; a
# model imports one by name. Kept in GridFS like everything else, because the
# build machine has no project directory to read from.
UPLOAD_SUFFIXES = (".step", ".stp", ".iges", ".igs", ".brep", ".stl", ".3mf")

# Native CAD formats are each vendor's own database; no open reader exists for
# them, so say what to export instead of a generic "wrong extension".
NATIVE_HINT = {
    ".f3d": "a Fusion archive holds Autodesk's own BREP, which nothing outside "
            "Fusion reads - in Fusion use File > Export and pick STEP",
    ".sldprt": "SolidWorks part: export STEP (File > Save As > STEP)",
    ".sldasm": "SolidWorks assembly: export STEP (File > Save As > STEP)",
    ".ipt": "Inventor part: export STEP",
    ".iam": "Inventor assembly: export STEP",
    ".catpart": "CATIA part: export STEP",
    ".prt": "native part file: export STEP",
    ".3dm": "Rhino file: export STEP",
    ".blend": "Blender file: export STL or 3MF (it is mesh, not solid)",
    ".scad": "OpenSCAD source: render and export STL",
}


async def put_upload(db, name: str, data: bytes) -> dict:
    name = Path(name).name                       # dizin bilesenlerini at
    suffix = Path(name).suffix.lower()
    # Format once: an unreadable native file deserves a better answer than
    # a complaint about its name.
    if suffix in NATIVE_HINT:
        raise ValueError(NATIVE_HINT[suffix])
    if suffix not in UPLOAD_SUFFIXES:
        raise ValueError("expected one of " + ", ".join(UPLOAD_SUFFIXES))
    # Real files have spaces and dots in them; the stem also becomes a module
    # name, so clean it rather than refuse it.
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(name).stem).strip("_-") or "part"
    name = stem + suffix
    old = await db.uploads.find_one({"_id": name})
    if old:
        await bucket(db, "cad_files").delete(old["gridfs_id"])
    fid = await bucket(db, "cad_files").upload_from_stream(name, data)
    doc = {"_id": name, "gridfs_id": fid, "bytes": len(data), "at": now()}
    await db.uploads.replace_one({"_id": name}, doc, upsert=True)
    return {"name": name, "bytes": len(data), "at": doc["at"]}


async def list_uploads(db) -> list[dict]:
    return [{"name": d["_id"], "bytes": d["bytes"], "at": d["at"]}
            async for d in db.uploads.find().sort("_id", 1)]


async def get_upload(db, name: str) -> bytes:
    """An uploaded CAD file, from disk if it has been read before.

    Uploads never change - a new file gets a new GridFS id - and they are
    the largest thing a build reads. This link runs at about 100 kB/s, so
    36 MB of STEP is six minutes before any geometry happens: a model that
    tessellates in 1.8 seconds was taking 389. Same cache the artifacts
    use, and the same reason.
    """
    doc = await db.uploads.find_one({"_id": name})
    if not doc:
        raise KeyError(name)

    hit = CACHE / f"{doc['gridfs_id']}.bin"
    try:
        if hit.exists():
            return hit.read_bytes()
    except OSError:
        pass

    stream = await bucket(db, "cad_files").open_download_stream(doc["gridfs_id"])
    raw = await stream.read()
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        tmp = hit.with_suffix(".part")
        tmp.write_bytes(raw)
        tmp.replace(hit)                 # atomic: a half-written file is never read
    except OSError:
        pass                             # the cache is an optimisation only
    return raw


async def delete_upload(db, name: str) -> None:
    doc = await db.uploads.find_one({"_id": name})
    if not doc:
        raise KeyError(name)
    await bucket(db, "cad_files").delete(doc["gridfs_id"])
    await db.uploads.delete_one({"_id": name})


# ---------------- models ----------------
class SourceError(ValueError):
    """A source that cannot even be compiled. `line` is where."""

    def __init__(self, message: str, line: int | None = None):
        super().__init__(message)
        self.line = line


def check_source(source: str, name: str = "<model>") -> None:
    """The cheap check at save: compile it, never run it. A syntax error
    used to be saved, kept as a version a pin could point at, and only
    found by the build (enclosure v5)."""
    try:
        compile(source, name, "exec", dont_inherit=True)
    except SyntaxError as exc:
        text = (exc.text or "").strip()
        raise SourceError(f"not saved: syntax error on line {exc.lineno}: {exc.msg}"
                          + (f" - {text[:120]}" if text else ""), exc.lineno) from None
    except ValueError as exc:            # null bytes, on older Pythons
        raise SourceError(f"not saved: {exc}") from None


async def save_model(db, model_id: str, source: str) -> dict:
    """Write or update source code. Generated artifacts go stale and are flagged."""
    folder, _, name = model_id.rpartition("/")
    if not SAFE.match(name):
        raise ValueError("model name may only contain letters, digits, - and _")
    check_source(source, f"{model_id}.py")
    meta = read_meta(source)
    doc = {
        "_id": model_id, "folder": folder, "name": name,
        "title": meta["title"] or name,
        "source": source,
        "sha256": hashlib.sha256(source.encode()).hexdigest(),
        "ready": meta["ready"], "error": meta["error"],
        "updated_at": now(),
    }
    existing = await db.models.find_one({"_id": model_id})
    if existing:
        doc["artifacts"] = existing.get("artifacts", {})
        doc["stale"] = existing.get("sha256") != doc["sha256"] or bool(existing.get("stale"))
        # What the model is as a component - its version, its pins, what
        # its last build used, a rebuild in flight - outlives a save.
        for k in ("version", "pins", "built", "link", "build_secs"):
            if k in existing:
                doc[k] = existing[k]
    else:
        doc["artifacts"], doc["stale"] = {}, True
    await db.models.replace_one({"_id": model_id}, doc, upsert=True)
    # A new version, and every model that uses this one marked stale and
    # queued for a rebuild (backend/links.py).
    from . import links
    doc["propagation"] = await links.model_saved(db, model_id, existing, doc)
    doc["version"] = doc["propagation"]["version"]
    return doc


# ---------------- versions whose build failed ----------------
# A save makes a version (backend/links.py model_saved); whether it builds
# is only known later. A version whose own build failed is marked on its
# kept copy, so pins and "latest" skip it and the history says so; a later
# build of the same version that works clears the mark.
VERSIONS = "component_versions"


async def current_version(db, model_id: str) -> int | None:
    doc = await db.models.find_one({"_id": model_id}, {"version": 1})
    return (doc.get("version") or 1) if doc else None


async def version_built(db, model_id: str, version: int | None,
                        error: str | None = None) -> bool:
    """Record how the build of `model_id` at `version` went: `error` marks
    that kept version failed, None clears the mark. False when no such
    version is kept."""
    if version is None:
        return False
    vid = f"model:{model_id}:v{version}"
    if error is None:
        res = await db[VERSIONS].update_one(
            {"_id": vid}, {"$unset": {"failed": "", "error": "", "failed_at": ""}})
    else:
        res = await db[VERSIONS].update_one(
            {"_id": vid}, {"$set": {"failed": True, "error": str(error)[-1500:],
                                    "failed_at": now()}})
    return bool(res.matched_count)


async def failed_versions(db, kind: str, cid: str) -> set[int]:
    """The kept versions of a component whose build failed."""
    return {r.get("version") async for r in db[VERSIONS].find(
        {"kind": kind, "component": cid, "failed": True}, {"version": 1})}


async def latest_good(db, kind: str, cid: str, latest: int | None) -> int | None:
    """The newest kept version at or below `latest` that did not fail, or
    `latest` itself when it is not marked (or nothing is kept)."""
    if latest is None:
        return None
    bad = await failed_versions(db, kind, cid)
    if latest not in bad:
        return latest
    kept = sorted([r.get("version") or 0 async for r in db[VERSIONS].find(
        {"kind": kind, "component": cid}, {"version": 1})], reverse=True)
    return next((v for v in kept if v is not None and v < latest and v not in bad), None)


async def move_model(db, model_id: str, folder: str, name: str | None = None) -> str:
    """Move a model to another folder, and/or give it another name. The id
    carries the path, so either is a rename; revisions point at the model by
    id and are carried along, and so is what the component graph keeps
    under its id - other models' pins on it, what their last build was
    built against, and its kept versions. A new name is a new module name:
    the sources that import the old one must be changed to match."""
    doc = await db.models.find_one({"_id": model_id})
    if not doc:
        raise KeyError(model_id)
    if folder and not await db.folders.find_one({"_id": folder}):
        raise ValueError(f"no such folder: {folder}")
    name = name or doc["name"]
    if not SAFE.match(name):
        raise ValueError("model name may only contain letters, digits, - and _")
    new_id = f"{folder}/{name}" if folder else name
    if new_id == model_id:
        return new_id
    if await db.models.find_one({"_id": new_id}):
        raise FileExistsError(f"{new_id} already exists")
    doc["_id"], doc["folder"], doc["name"] = new_id, folder, name
    await db.models.insert_one(doc)
    await db.models.delete_one({"_id": model_id})
    await db.revisions.update_many({"model": model_id},
                                   {"$set": {"model": new_id}})
    old_key, new_key = f"model:{model_id}", f"model:{new_id}"
    async for m in db.models.find(
            {"$or": [{f"pins.{old_key}": {"$exists": True}},
                     {f"built.against.{old_key}": {"$exists": True}}]},
            {"pins": 1, "built": 1}):
        patch = {}
        pins = dict(m.get("pins") or {})
        if old_key in pins:
            pins[new_key] = pins.pop(old_key)
            patch["pins"] = pins
        against = dict(((m.get("built") or {}).get("against")) or {})
        if old_key in against:
            against[new_key] = against.pop(old_key)
            patch["built.against"] = against
        if patch:
            await db.models.update_one({"_id": m["_id"]}, {"$set": patch})
    async for row in db.component_versions.find({"kind": "model", "component": model_id}):
        await db.component_versions.delete_one({"_id": row["_id"]})
        row["_id"] = f"{new_key}:v{row.get('version')}"
        row["component"] = new_id
        await db.component_versions.insert_one(row)
    return new_id


async def importers_of(db, model_id: str) -> list[str]:
    """Models whose source imports this one.

    An assembly says `import base`; deleting the part breaks the assembly
    the next time it is built, with a traceback and no clue why. Read from
    the imports themselves (backend/links.py), not by searching the text.
    """
    from . import links
    return await links.users_of(db, "model", model_id)


async def delete_model(db, model_id: str) -> None:
    doc = await db.models.find_one({"_id": model_id})
    if not doc:
        raise KeyError(model_id)
    files = bucket(db, "model_files")
    for meta in doc.get("artifacts", {}).values():
        try:
            await files.delete(meta["gridfs_id"])
        except Exception:
            pass
    await db.models.delete_one({"_id": model_id})
    # And the copies of its versions that pins could have pointed at.
    await db.component_versions.delete_many({"kind": "model", "component": model_id})


# Generated artifacts are big - a viewer payload runs to tens of megabytes -
# and pulling one from Atlas took a minute and a half. They never change once
# written, so the compressed bytes live on disk under the GridFS id and the
# database keeps the backup.
CACHE = Path(os.environ.get(
    "REDLINE_CACHE", Path(__file__).resolve().parent.parent / ".cache" / "artifacts"))


async def put_artifact(db, model_id: str, label: str, data: bytes,
                       collection: str = "models") -> dict:
    """Gzip the generated artifact into GridFS and drop the previous one.

    `collection` is which catalog the thing belongs to: models build into
    geometry, boards into a netlist, and both store their output the same
    way.
    """
    files = bucket(db, "model_files")
    doc = await db[collection].find_one({"_id": model_id})
    old = (doc or {}).get("artifacts", {}).get(label)
    digest = hashlib.sha256(data).hexdigest()
    if old and old.get("sha256") == digest:
        # The same bytes as last time. Sending them again is a hundred
        # seconds of upload for a file that is already there, and the page
        # would refetch a payload it has because the timestamp moved. The
        # build still counts as a build; the artifact is simply unchanged.
        await db[collection].update_one({"_id": model_id},
                                        {"$set": {"stale": False}})
        return old

    packed = gzip.compress(data, compresslevel=6)
    fid = await files.upload_from_stream(f"{model_id}:{label}.gz", packed)
    meta = {"gridfs_id": fid, "bytes": len(data), "stored_bytes": len(packed),
            "sha256": digest, "at": now()}
    await db[collection].update_one(
        {"_id": model_id},
        {"$set": {f"artifacts.{label}": meta, "stale": False}})
    if old:
        try:
            await files.delete(old["gridfs_id"])
        except Exception:
            pass
    # Keep a copy on disk straight away, so even the first read after a build
    # is local. The database holds the backup; the disk does the work.
    cache_put(fid, packed)
    return meta


def cache_put(gridfs_id, packed: bytes) -> None:
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        tmp = CACHE / f"{gridfs_id}.part"
        tmp.write_bytes(packed)
        tmp.replace(CACHE / f"{gridfs_id}.gz")
    except OSError:
        pass                                   # cache is an optimisation only


async def get_artifact_gz(db, model_id: str, label: str,
                          collection: str = "models") -> bytes:
    """The stored bytes, still gzipped."""
    doc = await db[collection].find_one({"_id": model_id})
    meta = (doc or {}).get("artifacts", {}).get(label)
    if not meta:
        raise KeyError(f"{model_id}/{label}")

    CACHE.mkdir(parents=True, exist_ok=True)
    hit = CACHE / f"{meta['gridfs_id']}.gz"
    try:
        if hit.exists():
            return hit.read_bytes()
    except OSError:
        pass

    stream = await bucket(db, "model_files").open_download_stream(meta["gridfs_id"])
    packed = await stream.read()
    try:
        tmp = hit.with_suffix(".part")
        tmp.write_bytes(packed)
        tmp.replace(hit)                 # atomic: a half-written file is never read
    except OSError:
        pass
    return packed


async def get_artifact(db, model_id: str, label: str,
                       collection: str = "models") -> bytes:
    return gzip.decompress(
        await get_artifact_gz(db, model_id, label, collection))


# ---------------- revision images ----------------
async def put_shot(db, png: bytes) -> dict:
    fid = await bucket(db, "shots").upload_from_stream("shot.png", png)
    return {"gridfs_id": fid, "bytes": len(png)}


async def get_shot(db, gridfs_id) -> bytes:
    stream = await bucket(db, "shots").open_download_stream(gridfs_id)
    return await stream.read()


# ---------------- catalog tree ----------------
async def catalog(db) -> dict:
    """The one tree. Models and boards live in it together.

    They are different things built by different tools, but they are the
    same kind of thing to the person looking for one: a file in a folder.
    The extension says which - .3d builds into geometry, .pcb into a
    circuit - and the room follows from that rather than from which list
    it was found in.
    """
    folders = [f async for f in db.folders.find({})]
    models = [m async for m in db.models.find({}, {"source": 0})]
    boards = [b async for b in db.boards.find({}, {"source": 0})]

    # Who uses whom, from what each model's imports were last read as
    # (backend/links.py keeps `uses` current on every save and rename).
    used_by: dict[str, list[dict]] = {}
    for m in models:
        for u in m.get("uses") or []:
            used_by.setdefault(f"{u['kind']}:{u['id']}", []).append(
                {"kind": "model", "id": m["_id"], "title": m.get("title", m["name"])})
    titles = {f"model:{m['_id']}": m.get("title", m["name"]) for m in models}
    titles.update({f"board:{b['_id']}": b.get("title") or b["_id"] for b in boards})
    versions = {f"model:{m['_id']}": m.get("version") or 1 for m in models}
    versions.update({f"board:{b['_id']}": (b.get("component") or {}).get("version") or 0
                     for b in boards})

    def uses_of(m: dict) -> list[dict]:
        built = ((m.get("built") or {}).get("against") or {})
        out = []
        for u in m.get("uses") or []:
            k = f"{u['kind']}:{u['id']}"
            got = built.get(k) or {}
            out.append({"kind": u["kind"], "id": u["id"], "module": u.get("module"),
                        "title": titles.get(k, u["id"]), "version": versions.get(k),
                        "built_against": got.get("version"),
                        "pinned": (m.get("pins") or {}).get(k)})
        return out

    def link_of(m: dict) -> dict | None:
        link = m.get("link")
        if not link:
            return None
        return {k: link.get(k) for k in ("state", "because", "error", "cycle", "at", "done_at")
                if link.get(k) is not None}

    def node(path: str, name: str) -> dict:
        return {
            "name": name, "path": path,
            "folders": sorted(
                (node(f["_id"], f["name"]) for f in folders if f["parent"] == path),
                key=lambda n: n["name"]),
            "boards": sorted(
                ({
                    "id": b["_id"],
                    "name": b.get("title") or b["_id"],
                    "title": b.get("title") or b["_id"],
                    "kind": "pcb",
                    "ready": bool((b.get("artifacts") or {}).get("graph")),
                    "stale": bool(b.get("stale")),
                    "building": bool(b.get("building")),
                    "build_secs": b.get("build_secs"),
                    "laid_out": bool((b.get("layout") or {}).get("at")),
                    # The board as a component: its 3D version, and who uses it.
                    "version": (b.get("component") or {}).get("version") or 0,
                    "module": (b.get("component") or {}).get("module"),
                    "has_3d": bool((b.get("artifacts") or {}).get("step")),
                    "used_by": used_by.get(f"board:{b['_id']}", []),
                } for b in boards if b.get("folder", "") == path),
                key=lambda e: e["title"]),
            "models": sorted(
                ({
                    "id": m["_id"], "name": m["name"], "title": m.get("title", m["name"]),
                    "ready": m.get("ready", False), "stale": m.get("stale", True),
                    "data": "viewer" in m.get("artifacts", {}),
                    "data_bytes": m.get("artifacts", {}).get("viewer", {}).get("bytes", 0),
                    # The open page watches this to notice a rebuild.
                    "built_at": m.get("artifacts", {}).get("viewer", {}).get("at"),
                    "updated_at": m.get("updated_at"),
                    "sha256": (m.get("sha256") or "")[:12],
                    # Set while a build is running, wherever it was started.
                    "building": bool(m.get("building")),
                    "build_started": m.get("build_started"),
                    # How long this model took last time, so a running build
                    # can show progress against something real.
                    "build_secs": m.get("build_secs"),
                    "kind": "3d",
                    # The model as a component: its version, what it uses,
                    # who uses it, and a rebuild a change elsewhere started.
                    "version": m.get("version") or 1,
                    "uses": uses_of(m),
                    "used_by": used_by.get(f"model:{m['_id']}", []),
                    "link": link_of(m),
                    # Components it uses at a fixed version: the badge's pin.
                    "pinned": len(m.get("pins") or {}),
                    "built_hash": (m.get("built") or {}).get("hash"),
                } for m in models if m.get("folder", "") == path),
                key=lambda e: e["title"]),
        }

    return node("", "models")
