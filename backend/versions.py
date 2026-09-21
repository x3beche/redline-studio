"""Version history: the latest snapshot plus the previous 10.

A version holds the SOURCE code of every model. Generated viewer/STEP/STL
files are not copied: they are derived artifacts and get rebuilt after a
rollback. That keeps history measured in kilobytes.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

KEEP = 10                    # history kept beyond the latest snapshot


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def snapshot(db, note: str = "") -> dict:
    models = [m async for m in db.models.find({}, {"_id": 1, "source": 1, "title": 1})]
    if not models:
        raise ValueError("no models to snapshot")

    digest = hashlib.sha256()
    entries = []
    for m in sorted(models, key=lambda d: d["_id"]):
        h = hashlib.sha256(m["source"].encode()).hexdigest()
        digest.update(h.encode())
        entries.append({"id": m["_id"], "title": m.get("title", m["_id"]),
                        "source": m["source"], "sha256": h, "short": h[:12],
                        "chars": len(m["source"])})

    folders = [f async for f in db.folders.find({})]
    doc = {
        "_id": datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S"),
        "created_at": _now(),
        "note": note,
        "sha256": digest.hexdigest(),
        "short": digest.hexdigest()[:12],
        "models": entries,
        "folders": [{"_id": f["_id"], "name": f["name"], "parent": f["parent"]}
                    for f in folders],
        "model_count": len(entries),
        "chars": sum(e["chars"] for e in entries),
    }
    await db.model_versions.insert_one(doc)
    doc["pruned"] = await _prune(db)
    return doc


async def _prune(db) -> int:
    keep = [d["_id"] async for d in
            db.model_versions.find({}, {"_id": 1}).sort("created_at", -1).limit(KEEP + 1)]
    res = await db.model_versions.delete_many({"_id": {"$nin": keep}})
    return res.deleted_count


async def listing(db) -> list[dict]:
    """Summary list, excluding source text."""
    rows = [d async for d in db.model_versions.find(
        {}, {"models.source": 0}).sort("created_at", -1)]
    return rows


async def restore(db, version_id: str) -> dict:
    """Restore a version's sources, snapshotting the current state first."""
    doc = await db.model_versions.find_one({"_id": version_id})
    if not doc:
        raise KeyError(version_id)

    backup = await snapshot(db, note=f"before restoring {version_id}")

    for f in doc.get("folders", []):
        await db.folders.replace_one({"_id": f["_id"]}, f, upsert=True)

    from . import store
    touched = []
    for entry in doc["models"]:
        saved = await store.save_model(db, entry["id"], entry["source"])
        touched.append({"id": entry["id"], "short": entry["short"],
                        "hash_ok": saved["sha256"] == entry["sha256"]})

    return {"restored": version_id, "short": doc["short"],
            "backup": backup["_id"], "models": touched,
            "note": "generated artifacts are stale; rebuild the models"}
