"""X3 Studios Asset Manager - API.

Proje verisinin tamami MongoDB'de durur: model kaynaklari, uretilen viewer
dosyalari, revizyon goruntuleri ve surum gecmisi. Yerel disk yalnizca model
uretimi sirasinda gecici calisma alani olarak kullanilir ve is bitince silinir.

Baglanti dizesi sadece burada okunur; arayuze hicbir sekilde gecmez.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import build, store, sysinfo, versions

ROOT = Path(__file__).resolve().parent.parent
EXPORT_SCRIPT = ROOT / "export_model.py"

load_dotenv(ROOT / ".env")
MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DB = os.getenv("MONGODB_DB", "assets_3d")
QUOTA_MB = float(os.getenv("STORAGE_QUOTA_MB", "512"))

# draft  : kullanici yaziyor, LLM gormez
# queued : uygulama sirasina alindi, LLM bunlari okur
STATUSES = ("draft", "queued", "applied", "rejected")
ORDER = {"queued": 0, "draft": 1, "applied": 2, "rejected": 3}

app = FastAPI(title="X3 Asset Manager API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"], allow_headers=["*"],
)

_client = None


def db():
    """Veritabani yoksa uygulama calismaz; her sey orada duruyor."""
    global _client
    if not MONGODB_URI:
        raise HTTPException(503, "MONGODB_URI tanimli degil (.env)")
    if _client is None:
        from motor.motor_asyncio import AsyncIOMotorClient
        _client = AsyncIOMotorClient(MONGODB_URI)
    return _client[MONGODB_DB]


# ---------------- durum ----------------
@app.get("/api/health")
async def health():
    try:
        await db().command("ping")
        return {"ok": True, "db": MONGODB_DB}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, f"veritabanina ulasilamiyor: {exc}") from exc


@app.get("/api/stats")
async def stats():
    d = db()
    ds = await d.command("dbStats")
    by_status = {s: await d.revisions.count_documents({"status": s}) for s in STATUSES}
    # Yeni olusturulmus bir veritabaninda storageSize bir sure 0 raporlanir;
    # mantiksal boyut her zaman dolu oldugu icin buyugunu aliyoruz.
    used = max(int(ds.get("storageSize", 0)),
               int(ds.get("dataSize", 0))) + int(ds.get("indexSize", 0))
    quota = int(QUOTA_MB * 1024 * 1024)
    return {
        "db": ds.get("db"),
        "collections": int(ds.get("collections", 0)),
        "objects": int(ds.get("objects", 0)),
        "data_bytes": int(ds.get("dataSize", 0)),
        "used_bytes": used,
        "index_bytes": int(ds.get("indexSize", 0)),
        "quota_bytes": quota,
        "percent": round(used / quota * 100, 1) if quota else None,
        "revisions": by_status,
        "models": await d.models.count_documents({}),
        "versions": await d.model_versions.count_documents({}),
    }


@app.get("/api/system")
async def system():
    return sysinfo.snapshot()


# ---------------- katalog ----------------
@app.get("/api/catalog")
async def get_catalog():
    return await store.catalog(db())


@app.post("/api/catalog/folders")
async def new_folder(name: str, parent: str = ""):
    try:
        return {"path": await store.create_folder(db(), parent, name)}
    except (ValueError, FileExistsError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/catalog/folders/{path:path}")
async def drop_folder(path: str):
    try:
        await store.delete_folder(db(), path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"deleted": path}


# ---------------- modeller ----------------
class ModelIn(BaseModel):
    source: str = Field(min_length=1)


@app.get("/api/models/{model_id:path}/source")
async def model_source(model_id: str):
    doc = await db().models.find_one({"_id": model_id})
    if not doc:
        raise HTTPException(404, model_id)
    return {"id": model_id, "title": doc.get("title"), "source": doc["source"],
            "sha256": doc.get("sha256"), "stale": doc.get("stale", True)}


@app.put("/api/models/{model_id:path}")
async def put_model(model_id: str, body: ModelIn):
    try:
        doc = await store.save_model(db(), model_id, body.source)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {k: doc[k] for k in ("_id", "title", "ready", "stale", "sha256", "error")}


@app.delete("/api/models/{model_id:path}")
async def drop_model(model_id: str):
    try:
        await store.delete_model(db(), model_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"deleted": model_id}


@app.post("/api/models/{model_id:path}/build")
async def build_model(model_id: str):
    try:
        return await build.build(db(), model_id, EXPORT_SCRIPT)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, RuntimeError, TimeoutError) as exc:
        raise HTTPException(500, str(exc)) from exc


@app.get("/api/models/{model_id:path}/viewer.json")
async def model_viewer(model_id: str):
    try:
        data = await store.get_artifact(db(), model_id, "viewer")
    except KeyError as exc:
        raise HTTPException(404, f"{model_id}: once uret") from exc
    return Response(content=data, media_type="application/json")


@app.get("/api/models/{model_id:path}/file/{label}")
async def model_file(model_id: str, label: str):
    try:
        data = await store.get_artifact(db(), model_id, label)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    name = model_id.rpartition("/")[2] + "." + label
    return Response(content=data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------- surum gecmisi ----------------
@app.get("/api/versions")
async def list_versions():
    return await versions.listing(db())


@app.post("/api/versions")
async def take_version(note: str = ""):
    try:
        doc = await versions.snapshot(db(), note)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    doc.pop("models", None)
    doc.pop("folders", None)
    return doc


@app.post("/api/versions/{version_id}/restore")
async def restore_version(version_id: str):
    try:
        return await versions.restore(db(), version_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


# ---------------- revizyonlar ----------------
class RevisionIn(BaseModel):
    comment: str = Field(min_length=1, max_length=4000)
    image_png: str
    camera: dict | None = None
    part: str | None = None
    model: str | None = None


def _out(d: dict) -> dict:
    return {"id": d["_id"], "created_at": d["created_at"], "comment": d["comment"],
            "camera": d.get("camera"), "part": d.get("part"), "model": d.get("model"),
            "status": d.get("status", "draft"), "queued_at": d.get("queued_at"),
            "image_bytes": (d.get("image") or {}).get("bytes", 0)}


@app.post("/api/revisions")
async def create_revision(body: RevisionIn):
    from datetime import datetime, timezone
    import uuid

    raw = body.image_png.split(",", 1)[-1]
    try:
        png = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise HTTPException(400, f"gecersiz PNG: {exc}") from exc

    d = db()
    rid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    doc = {
        "_id": rid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "comment": body.comment, "camera": body.camera,
        "part": body.part, "model": body.model,
        "status": "draft", "queued_at": None,
        "image": await store.put_shot(d, png),
    }
    await d.revisions.insert_one(doc)
    return _out(doc)


def _sort_key(d: dict):
    bucket = ORDER.get(d.get("status", "draft"), 9)
    if bucket == 0:
        return (0, d.get("queued_at") or d["created_at"])
    return (bucket, "".join(chr(255 - ord(c)) for c in d["created_at"]))


@app.get("/api/revisions")
async def list_revisions(status: str | None = None):
    rows = [d async for d in db().revisions.find({"status": status} if status else {})]
    rows.sort(key=_sort_key)
    return [_out(d) for d in rows]


@app.get("/api/queue")
async def queue():
    """LLM'in okudugu liste: yalnizca uygulama sirasina alinmis revizyonlar."""
    return await list_revisions(status="queued")


@app.get("/api/revisions/{rid}/image")
async def revision_image(rid: str):
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc or not doc.get("image"):
        raise HTTPException(404, rid)
    png = await store.get_shot(d, doc["image"]["gridfs_id"])
    return Response(content=png, media_type="image/png")


@app.patch("/api/revisions/{rid}")
async def set_status(rid: str, status: str):
    from datetime import datetime, timezone

    if status not in STATUSES:
        raise HTTPException(400, "status: " + " | ".join(STATUSES))
    patch = {"status": status,
             "queued_at": datetime.now(timezone.utc).isoformat()
             if status == "queued" else None}
    res = await db().revisions.update_one({"_id": rid}, {"$set": patch})
    if res.matched_count == 0:
        raise HTTPException(404, rid)
    return {"id": rid, **patch}


@app.delete("/api/revisions/{rid}")
async def drop_revision(rid: str):
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    if doc.get("image"):
        try:
            await store.bucket(d, "shots").delete(doc["image"]["gridfs_id"])
        except Exception:
            pass
    await d.revisions.delete_one({"_id": rid})
    return {"deleted": rid}


# derlenmis arayuz (varsa)
_dist = ROOT / "frontend" / "dist" / "frontend" / "browser"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="ui")
