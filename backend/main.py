"""Fan editoru backend'i.

Angular arayuzunden gelen "revizyon" kayitlarini saklar: donmus 3B goruntunun
uzerine cizilmis isaret, yorum metni ve o andaki kamera durumu.

Baglanti dizesi SADECE burada durur; Angular tarafina hicbir sekilde gecmez.
MONGODB_URI tanimli degilse yerel JSON dosyasina duser, boylece Atlas
gelmeden de uygulama calisir.
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent          # game/editor
ASSETS = ROOT / "assets"
SHOTS = ROOT / "revisions"                              # isaretli PNG'ler
LOCAL_DB = ROOT / "revisions" / "_index.json"
SHOTS.mkdir(parents=True, exist_ok=True)

load_dotenv(ROOT / ".env")
MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DB = os.getenv("MONGODB_DB", "fan_editor")

app = FastAPI(title="Fan Editor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_mongo = None


def collection():
    """Atlas koleksiyonu; URI yoksa None (yerel JSON'a duseriz)."""
    global _mongo
    if not MONGODB_URI:
        return None
    if _mongo is None:
        from motor.motor_asyncio import AsyncIOMotorClient
        _mongo = AsyncIOMotorClient(MONGODB_URI)
    return _mongo[MONGODB_DB]["revisions"]


def _local_read() -> list[dict]:
    if not LOCAL_DB.exists():
        return []
    return json.loads(LOCAL_DB.read_text())


def _local_write(rows: list[dict]) -> None:
    LOCAL_DB.write_text(json.dumps(rows, indent=2, ensure_ascii=False))


class RevisionIn(BaseModel):
    comment: str = Field(min_length=1, max_length=4000)
    image_png: str = Field(description="data:image/png;base64,... veya ham base64")
    camera: dict | None = None
    part: str | None = None                             # isaretlenen parca adi
    model_version: str | None = None


class RevisionOut(BaseModel):
    id: str
    created_at: str
    comment: str
    image_path: str
    camera: dict | None = None
    part: str | None = None
    status: str


@app.get("/api/health")
async def health():
    return {"ok": True, "storage": "atlas" if MONGODB_URI else "yerel-json",
            "revisions_dir": str(SHOTS)}


@app.post("/api/revisions", response_model=RevisionOut)
async def create_revision(body: RevisionIn):
    rid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    raw = body.image_png.split(",", 1)[-1]
    try:
        png = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise HTTPException(400, f"gecersiz PNG: {exc}") from exc

    # Goruntuyu diske yaziyoruz: Claude dosyayi dogrudan acip bakabilsin.
    path = SHOTS / f"{rid}.png"
    path.write_bytes(png)

    doc = {
        "_id": rid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "comment": body.comment,
        "image_path": str(path),
        "camera": body.camera,
        "part": body.part,
        "model_version": body.model_version,
        "status": "open",
    }
    col = collection()
    if col is not None:
        await col.insert_one(doc)
    else:
        rows = _local_read()
        rows.append(doc)
        _local_write(rows)
    return RevisionOut(id=rid, **{k: doc[k] for k in
                                  ("created_at", "comment", "image_path",
                                   "camera", "part", "status")})


@app.get("/api/revisions", response_model=list[RevisionOut])
async def list_revisions(status: str | None = None):
    col = collection()
    if col is not None:
        query = {"status": status} if status else {}
        rows = [d async for d in col.find(query).sort("created_at", -1)]
    else:
        rows = sorted(_local_read(), key=lambda d: d["created_at"], reverse=True)
        if status:
            rows = [d for d in rows if d["status"] == status]
    return [RevisionOut(id=d["_id"], **{k: d.get(k) for k in
                                        ("created_at", "comment", "image_path",
                                         "camera", "part", "status")})
            for d in rows]


@app.patch("/api/revisions/{rid}")
async def set_status(rid: str, status: str):
    if status not in ("open", "applied", "rejected"):
        raise HTTPException(400, "status: open | applied | rejected")
    col = collection()
    if col is not None:
        res = await col.update_one({"_id": rid}, {"$set": {"status": status}})
        if res.matched_count == 0:
            raise HTTPException(404, "bulunamadi")
    else:
        rows = _local_read()
        hit = next((d for d in rows if d["_id"] == rid), None)
        if hit is None:
            raise HTTPException(404, "bulunamadi")
        hit["status"] = status
        _local_write(rows)
    return {"id": rid, "status": status}


# 3B model ve derlenmis arayuz
app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")
_dist = ROOT / "frontend" / "dist" / "frontend" / "browser"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="ui")
