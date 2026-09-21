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
import re
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
    return meta


async def get_artifact(db, model_id: str, label: str) -> bytes:
    doc = await db.models.find_one({"_id": model_id})
    meta = (doc or {}).get("artifacts", {}).get(label)
    if not meta:
        raise KeyError(f"{model_id}/{label}")
    stream = await bucket(db, "model_files").open_download_stream(meta["gridfs_id"])
    return gzip.decompress(await stream.read())


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
