"""X3 Studios Asset Manager - API.

All project data lives in MongoDB: model sources, generated viewer payloads,
revision images and version history. Local disk is used only as scratch space
while a model is built, and is removed when the build finishes.

The connection string is read here alone; it never reaches the frontend.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Response, UploadFile
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

# draft  : the user is still writing, models do not see it
# queued : in the apply queue, models read these
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
    """Without the database there is no app; everything lives there."""
    global _client
    if not MONGODB_URI:
        raise HTTPException(503, "MONGODB_URI is not set (.env)")
    if _client is None:
        from motor.motor_asyncio import AsyncIOMotorClient
        _client = AsyncIOMotorClient(MONGODB_URI)
    return _client[MONGODB_DB]


# ---------------- status ----------------
@app.get("/api/health")
async def health():
    try:
        await db().command("ping")
        return {"ok": True, "db": MONGODB_DB}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, f"database unreachable: {exc}") from exc


@app.get("/api/stats")
async def stats():
    d = db()
    ds = await d.command("dbStats")
    by_status = {s: await d.revisions.count_documents({"status": s}) for s in STATUSES}
    # A freshly created database reports storageSize as 0 for a while; the
    # logical size is always populated, so take whichever is larger.
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


# ---------------- catalog ----------------
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


# ---------------- uploads ----------------
# A STEP the user brings in is not a model; a model imports it. On upload we
# also write that model, so the file is visible in the viewer straight away
# and there is something to edit.
IGES_LOADER = """# IGES yuzey tabanli: kati gelmiyor. Yuzeyleri dikip kabuklari katiya
# cevirmek gerekiyor, yoksa hacim de boolean da yapilamiyor.
from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.IGESControl import IGESControl_Reader
from build123d.topology import Shape

reader = IGESControl_Reader()
if reader.ReadFile(str(SRC)) != IFSelect_ReturnStatus.IFSelect_RetDone:
    raise RuntimeError(f"IGES okunamadi: {SRC}")
reader.TransferRoots()
sewing = BRepBuilderAPI_Sewing(1e-3)
for face in Shape.cast(reader.OneShape()).faces():
    sewing.Add(face.wrapped)
sewing.Perform()
sewn = Shape.cast(sewing.SewedShape())
solids = []
for shell in sewn.shells():
    try:
        solids.append(Solid(shell))
    except Exception:
        pass                      # kapanmayan kabuk kati olamaz
part = Compound(children=solids) if solids else sewn"""

LOADERS = {
    ".brep": "part = import_brep(SRC)",
    ".stl": "part = import_stl(SRC)",
    ".3mf": "part = Compound(children=Mesher().read(SRC))",
    ".iges": IGES_LOADER,
    ".igs": IGES_LOADER,
}


def starter_source(filename: str) -> str:
    stem = Path(filename).stem
    suffix = Path(filename).suffix.lower()
    loader = LOADERS.get(suffix, "part = import_step(SRC)")
    # A mesh written back as STEP becomes one face per triangle: a 660 kB 3MF
    # came out as a 131 MB STEP. Mesh in, mesh out.
    fmt = "stl" if suffix in (".stl", ".3mf") else "step"
    writer = "export_stl" if fmt == "stl" else "export_step"
    return f'''"""{stem} - imported CAD file, not parametric.

The geometry came in as geometry: it can be cut, joined, filleted, measured
and placed in an assembly, but it carries no feature history, so a dimension
cannot be dialled in - it has to be cut and rebuilt.
"""

import os
from pathlib import Path

from build123d import *

STANDALONE = os.environ.get("X3_IMPORT_ONLY") != "1"
ROOT = Path(__file__).resolve().parent.parent   # uploads land here
SRC = ROOT / "{filename}"

{loader}

part.label, part.color = "{stem}", Color("steelblue")

box = part.bounding_box()
print(f"gabari : {{box.size.X:.1f}} x {{box.size.Y:.1f}} x {{box.size.Z:.1f}} mm")
print(f"katilar: {{len(part.solids())}}  yuz: {{len(part.faces())}}  "
      f"kenar: {{len(part.edges())}}")
print(f"hacim  : {{part.volume:.0f}} mm^3")

TITLE = "{stem}"
PARTS = [part]
NAMES = ["{stem}"]

if STANDALONE:
    {writer}(part, ROOT / "exports" / "{stem}.{fmt}")
    print("exports/{stem}.{fmt} yazildi")
'''


@app.get("/api/uploads")
async def get_uploads():
    return await store.list_uploads(db())


@app.post("/api/uploads")
async def post_upload(file: UploadFile = File(...), make_model: bool = True):
    data = await file.read()
    try:
        info = await store.put_upload(db(), file.filename or "part.step", data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    info["model"] = None
    if make_model:
        model_id = Path(info["name"]).stem
        doc = await store.save_model(db(), model_id, starter_source(info["name"]))
        info["model"] = doc["_id"]
    await push_activity(ActivityIn(
        text=f"uploaded {info['name']} ({info['bytes'] // 1024} kB)"
             + (f" -> model {info['model']}" if info["model"] else ""),
        level="done"))
    return info


@app.get("/api/uploads/{name}")
async def fetch_upload(name: str):
    try:
        data = await store.get_upload(db(), name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(data, media_type="application/octet-stream")


@app.delete("/api/uploads/{name}")
async def drop_upload(name: str):
    try:
        await store.delete_upload(db(), name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"deleted": name}


# ---------------- models ----------------
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


@app.post("/api/models/{model_id:path}/move")
async def move_model(model_id: str, folder: str = ""):
    try:
        new_id = await store.move_model(db(), model_id, folder)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, FileExistsError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"from": model_id, "to": new_id}


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
    except (ValueError, RuntimeError, TimeoutError, MemoryError) as exc:
        raise HTTPException(500, str(exc)) from exc


@app.get("/api/models/{model_id:path}/viewer.json")
async def model_viewer(model_id: str):
    try:
        data = await store.get_artifact(db(), model_id, "viewer")
    except KeyError as exc:
        raise HTTPException(404, f"{model_id}: build it first") from exc
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


# ---------------- version history ----------------
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


# ---------------- activity log and run progress ----------------
# Two separate things on screen: a scrolling IDE-style log at the bottom, and
# one progress bar at the top that lives from the moment work on a revision
# starts until it finishes.
ACTIVITY_KEEP = 300
RUN_ID = "current"


class ActivityIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    level: str = "info"                    # info | work | done | warn | error
    percent: float | None = Field(default=None, ge=0, le=100)


class RunStart(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    revision: str | None = None
    model: str | None = None


@app.post("/api/activity")
async def push_activity(body: ActivityIn):
    from datetime import datetime, timezone
    import uuid

    d = db()
    doc = {"_id": uuid.uuid4().hex[:12],
           "at": datetime.now(timezone.utc).isoformat(),
           "text": body.text.strip(), "level": body.level}
    await d.activity.insert_one(doc)

    # A percent on a log line also advances the bar, so one call does both.
    if body.percent is not None:
        await d.runs.update_one({"_id": RUN_ID},
                                {"$set": {"percent": body.percent}})

    # Keep the feed bounded without a capped collection, so it stays clearable.
    total = await d.activity.count_documents({})
    if total > ACTIVITY_KEEP:
        old = [x["_id"] async for x in
               d.activity.find({}, {"_id": 1}).sort("at", 1).limit(total - ACTIVITY_KEEP)]
        await d.activity.delete_many({"_id": {"$in": old}})
    return doc


@app.get("/api/activity")
async def list_activity(limit: int = 120):
    rows = [x async for x in db().activity.find({}).sort("at", -1).limit(limit)]
    return list(reversed(rows))            # oldest first, log order


@app.delete("/api/activity")
async def clear_activity():
    return {"deleted": (await db().activity.delete_many({})).deleted_count}


@app.get("/api/run")
async def get_run():
    return await db().runs.find_one({"_id": RUN_ID})


@app.post("/api/run/start")
async def start_run(body: RunStart):
    from datetime import datetime, timezone

    doc = {"_id": RUN_ID, "title": body.title, "revision": body.revision,
           "model": body.model, "percent": 0.0, "status": "running",
           "started_at": datetime.now(timezone.utc).isoformat(),
           "finished_at": None}
    await db().runs.replace_one({"_id": RUN_ID}, doc, upsert=True)
    return doc


@app.post("/api/run/finish")
async def finish_run(status: str = "done"):
    from datetime import datetime, timezone

    patch = {"status": status, "percent": 100.0,
             "finished_at": datetime.now(timezone.utc).isoformat()}
    await db().runs.update_one({"_id": RUN_ID}, {"$set": patch}, upsert=True)
    return await db().runs.find_one({"_id": RUN_ID})


# ---------------- revisions ----------------
class RevisionIn(BaseModel):
    comment: str = Field(min_length=1, max_length=4000)
    # Optional: a note about a part does not need a drawing.
    image_png: str | None = None
    camera: dict | None = None
    part: str | None = None
    model: str | None = None


def _out(d: dict) -> dict:
    return {"id": d["_id"], "created_at": d["created_at"], "comment": d["comment"],
            "camera": d.get("camera"), "part": d.get("part"), "model": d.get("model"),
            "status": d.get("status", "draft"), "queued_at": d.get("queued_at"),
            "edited_at": d.get("edited_at"), "archived": bool(d.get("archived")),
            "image_bytes": (d.get("image") or {}).get("bytes", 0)}


@app.post("/api/revisions")
async def create_revision(body: RevisionIn):
    from datetime import datetime, timezone
    import uuid

    d = db()
    image = None
    if body.image_png:
        raw = body.image_png.split(",", 1)[-1]
        try:
            png = base64.b64decode(raw, validate=True)
        except Exception as exc:
            raise HTTPException(400, f"invalid PNG: {exc}") from exc
        image = await store.put_shot(d, png)
    rid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    doc = {
        "_id": rid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "comment": body.comment, "camera": body.camera,
        "part": body.part, "model": body.model,
        "status": "draft", "queued_at": None,
        "image": image,
    }
    await d.revisions.insert_one(doc)
    return _out(doc)


def _sort_key(d: dict):
    bucket = ORDER.get(d.get("status", "draft"), 9)
    if bucket == 0:
        return (0, d.get("queued_at") or d["created_at"])
    return (bucket, "".join(chr(255 - ord(c)) for c in d["created_at"]))


@app.get("/api/revisions")
async def list_revisions(status: str | None = None, archived: bool = False):
    """Archived revisions are kept but hidden; pass archived=true to see them."""
    query: dict = {} if status is None else {"status": status}
    query["archived"] = True if archived else {"$ne": True}
    rows = [d async for d in db().revisions.find(query)]
    rows.sort(key=_sort_key)
    return [_out(d) for d in rows]


@app.get("/api/queue")
async def queue():
    """What models read: queued revisions only, archived ones excluded."""
    return await list_revisions(status="queued", archived=False)


@app.get("/api/revisions/{rid}")
async def one_revision(rid: str):
    doc = await db().revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    return _out(doc)


@app.get("/api/revisions/{rid}/image")
async def revision_image(rid: str):
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc or not doc.get("image"):
        raise HTTPException(404, rid)
    png = await store.get_shot(d, doc["image"]["gridfs_id"])
    return Response(content=png, media_type="image/png")


class RevisionEdit(BaseModel):
    """Only the text is editable; the drawing is the record and stays fixed."""
    comment: str | None = Field(default=None, min_length=1, max_length=4000)
    part: str | None = None


@app.put("/api/revisions/{rid}")
async def edit_revision(rid: str, body: RevisionEdit):
    from datetime import datetime, timezone

    patch: dict = {}
    if body.comment is not None:
        patch["comment"] = body.comment.strip()
    if body.part is not None:
        patch["part"] = body.part or None
    if not patch:
        raise HTTPException(400, "nothing to change")
    patch["edited_at"] = datetime.now(timezone.utc).isoformat()

    res = await db().revisions.update_one({"_id": rid}, {"$set": patch})
    if res.matched_count == 0:
        raise HTTPException(404, rid)
    doc = await db().revisions.find_one({"_id": rid})
    return _out(doc)


# ---------------- settings ----------------
# Kept server-side so the CLI honours it too, not just the browser.
SETTINGS_ID = store.SETTINGS_ID
DEFAULT_SETTINGS = store.DEFAULT_SETTINGS


@app.get("/api/settings")
async def get_settings():
    doc = await db().settings.find_one({"_id": SETTINGS_ID}) or {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in doc.items() if k != "_id"}}


@app.put("/api/settings")
async def put_settings(auto_archive: bool):
    await db().settings.update_one({"_id": SETTINGS_ID},
                                   {"$set": {"auto_archive": auto_archive}},
                                   upsert=True)
    return await get_settings()


@app.patch("/api/revisions/{rid}/archive")
async def archive_revision(rid: str, value: bool = True):
    res = await db().revisions.update_one({"_id": rid}, {"$set": {"archived": value}})
    if res.matched_count == 0:
        raise HTTPException(404, rid)
    return {"id": rid, "archived": value}


@app.patch("/api/revisions/{rid}")
async def set_status(rid: str, status: str):
    if status not in STATUSES:
        raise HTTPException(400, "status: " + " | ".join(STATUSES))
    patch = await store.set_status(db(), rid, status)
    if patch is None:
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


# compiled frontend, when present
_dist = ROOT / "frontend" / "dist" / "frontend" / "browser"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="ui")
