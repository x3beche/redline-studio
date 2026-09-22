"""Everything project-related lives in MongoDB; local disk is scratch space only.

Collections
    folders        {_id: path, name, parent}
    models         {_id: path, folder, name, title, source, sha256, updated_at,
                    artifacts: {viewer|step|stl: {gridfs_id, bytes, sha256}}}
    revisions      {..., image: {gridfs_id, bytes}}
    model_versions version history (versions.py)

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
import tempfile
from pathlib import Path
from datetime import datetime, timezone

SAFE = re.compile(r"^[A-Za-z0-9_-]+$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def bucket(db, name: str):
    from motor.motor_asyncio import AsyncIOMotorGridFSBucket
    return AsyncIOMotorGridFSBucket(db, bucket_name=name)


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
DEFAULT_SETTINGS = {"auto_archive": False}


async def settings(db) -> dict:
    doc = await db.settings.find_one({"_id": SETTINGS_ID}) or {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in doc.items() if k != "_id"}}


async def set_status(db, rev_id: str, status: str) -> dict | None:
    """Move a revision to `status`; returns the patch, or None if unknown."""
    patch = {"status": status,
             "queued_at": now() if status == "queued" else None}
    if status == "applied" and (await settings(db))["auto_archive"]:
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
    doc = await db.uploads.find_one({"_id": name})
    if not doc:
        raise KeyError(name)
    stream = await bucket(db, "cad_files").open_download_stream(doc["gridfs_id"])
    return await stream.read()


async def delete_upload(db, name: str) -> None:
    doc = await db.uploads.find_one({"_id": name})
    if not doc:
        raise KeyError(name)
    await bucket(db, "cad_files").delete(doc["gridfs_id"])
    await db.uploads.delete_one({"_id": name})


# ---------------- models ----------------
async def save_model(db, model_id: str, source: str) -> dict:
    """Write or update source code. Generated artifacts go stale and are flagged."""
    folder, _, name = model_id.rpartition("/")
    if not SAFE.match(name):
        raise ValueError("model name may only contain letters, digits, - and _")
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
        doc["stale"] = existing.get("sha256") != doc["sha256"]
    else:
        doc["artifacts"], doc["stale"] = {}, True
    await db.models.replace_one({"_id": model_id}, doc, upsert=True)
    return doc


async def move_model(db, model_id: str, folder: str) -> str:
    """Move a model to another folder. The id carries the path, so this is a
    rename; revisions point at the model by id and are carried along."""
    doc = await db.models.find_one({"_id": model_id})
    if not doc:
        raise KeyError(model_id)
    if folder and not await db.folders.find_one({"_id": folder}):
        raise ValueError(f"no such folder: {folder}")
    new_id = f"{folder}/{doc['name']}" if folder else doc["name"]
    if new_id == model_id:
        return new_id
    if await db.models.find_one({"_id": new_id}):
        raise FileExistsError(f"{new_id} already exists")
    doc["_id"], doc["folder"] = new_id, folder
    await db.models.insert_one(doc)
    await db.models.delete_one({"_id": model_id})
    await db.revisions.update_many({"model": model_id},
                                   {"$set": {"model": new_id}})
    return new_id


async def importers_of(db, model_id: str) -> list[str]:
    """Models whose source imports this one.

    An assembly says `import base`, and the build writes every model's
    source next to it. Deleting a part therefore breaks the assembly the
    next time it is built, with a traceback and no clue why.
    """
    name = model_id.rpartition("/")[2]
    flat = model_id.replace("/", "__")
    patterns = [re.compile(rf"^\s*(?:import\s+{re.escape(n)}\b"
                           rf"|from\s+{re.escape(n)}\s+import\b)", re.M)
                for n in {name, flat}]
    found = []
    async for other in db.models.find({}, {"source": 1}):
        if other["_id"] == model_id or not other.get("source"):
            continue
        if any(p.search(other["source"]) for p in patterns):
            found.append(str(other["_id"]))
    return sorted(found)


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


# Generated artifacts are big - a viewer payload runs to tens of megabytes -
# and pulling one from Atlas took a minute and a half. They never change once
# written, so the compressed bytes live on disk under the GridFS id and the
# database keeps the backup.
CACHE = Path(os.environ.get(
    "X3_CACHE", Path(__file__).resolve().parent.parent / ".cache" / "artifacts"))


async def put_artifact(db, model_id: str, label: str, data: bytes) -> dict:
    """Gzip the generated artifact into GridFS and drop the previous one."""
    files = bucket(db, "model_files")
    doc = await db.models.find_one({"_id": model_id})
    old = (doc or {}).get("artifacts", {}).get(label)
    if old:
        try:
            await files.delete(old["gridfs_id"])
        except Exception:
            pass
    packed = gzip.compress(data, compresslevel=6)
    fid = await files.upload_from_stream(f"{model_id}:{label}.gz", packed)
    meta = {"gridfs_id": fid, "bytes": len(data), "stored_bytes": len(packed),
            "sha256": hashlib.sha256(data).hexdigest(), "at": now()}
    await db.models.update_one(
        {"_id": model_id},
        {"$set": {f"artifacts.{label}": meta, "stale": False}})
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


async def get_artifact_gz(db, model_id: str, label: str) -> bytes:
    """The stored bytes, still gzipped."""
    doc = await db.models.find_one({"_id": model_id})
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


async def get_artifact(db, model_id: str, label: str) -> bytes:
    return gzip.decompress(await get_artifact_gz(db, model_id, label))


# ---------------- revision images ----------------
async def put_shot(db, png: bytes) -> dict:
    fid = await bucket(db, "shots").upload_from_stream("shot.png", png)
    return {"gridfs_id": fid, "bytes": len(png)}


async def get_shot(db, gridfs_id) -> bytes:
    stream = await bucket(db, "shots").open_download_stream(gridfs_id)
    return await stream.read()


# ---------------- catalog tree ----------------
async def catalog(db) -> dict:
    folders = [f async for f in db.folders.find({})]
    models = [m async for m in db.models.find({}, {"source": 0})]

    def node(path: str, name: str) -> dict:
        return {
            "name": name, "path": path,
            "folders": sorted(
                (node(f["_id"], f["name"]) for f in folders if f["parent"] == path),
                key=lambda n: n["name"]),
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
                } for m in models if m.get("folder", "") == path),
                key=lambda e: e["title"]),
        }

    return node("", "models")
