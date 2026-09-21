"""Projeye ait her sey MongoDB'de durur; yerel disk yalnizca gecici calisma alani.

Koleksiyonlar
    folders        {_id: yol, name, parent}
    models         {_id: yol, folder, name, title, source, sha256, updated_at,
                    artifacts: {viewer|step|stl: {gridfs_id, bytes, sha256}}}
    revisions      {..., image: {gridfs_id, bytes}}
    model_versions surum gecmisi (versions.py)

GridFS kovalari
    model_files    uretilen viewer/step/stl dosyalari (gzip'li)
    shots          revizyon goruntuleri (ham PNG)
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


# ---------------- kaynak koddan meta okuma ----------------
def read_meta(source: str) -> dict:
    """TITLE ve PARTS'i calistirmadan okur; import etmek pahali ve riskli."""
    title, has_parts = None, False
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {"title": None, "ready": False, "error": "sozdizimi hatasi"}
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


# ---------------- klasorler ----------------
async def create_folder(db, parent: str, name: str) -> str:
    if not SAFE.match(name):
        raise ValueError("klasor adi yalnizca harf, rakam, - ve _ icerebilir")
    path = f"{parent}/{name}" if parent else name
    if await db.folders.find_one({"_id": path}):
        raise FileExistsError(f"{path} zaten var")
    if parent and not await db.folders.find_one({"_id": parent}):
        raise ValueError(f"ust klasor yok: {parent}")
    await db.folders.insert_one({"_id": path, "name": name, "parent": parent})
    return path


async def delete_folder(db, path: str) -> None:
    if await db.models.count_documents({"folder": path}):
        raise ValueError("klasor bos degil")
    if await db.folders.count_documents({"parent": path}):
        raise ValueError("klasor bos degil")
    await db.folders.delete_one({"_id": path})


# ---------------- modeller ----------------
async def save_model(db, model_id: str, source: str) -> dict:
    """Kaynak kodu yazar/gunceller. Uretilen dosyalar bayatlar, isaretlenir."""
    folder, _, name = model_id.rpartition("/")
    if not SAFE.match(name):
        raise ValueError("model adi yalnizca harf, rakam, - ve _ icerebilir")
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
    """Uretilen dosyayi gzip'leyip GridFS'e koyar, eskisini siler."""
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


# ---------------- revizyon goruntuleri ----------------
async def put_shot(db, png: bytes) -> dict:
    fid = await bucket(db, "shots").upload_from_stream("shot.png", png)
    return {"gridfs_id": fid, "bytes": len(png)}


async def get_shot(db, gridfs_id) -> bytes:
    stream = await bucket(db, "shots").open_download_stream(gridfs_id)
    return await stream.read()


# ---------------- katalog agaci ----------------
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
                    "updated_at": m.get("updated_at"),
                    "sha256": (m.get("sha256") or "")[:12],
                } for m in models if m.get("folder", "") == path),
                key=lambda e: e["title"]),
        }

    return node("", "models")
