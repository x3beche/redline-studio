"""Redline - API.

All project data lives in MongoDB: model sources, generated viewer payloads,
revision images and version history. Local disk is used only as scratch space
while a model is built, and is removed when the build finishes.

The connection string is read here alone; it never reaches the frontend.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field

from . import (ato, insights, build, chat, compute, kicad, lcsc, questions, rules,
               schematic, store, summarise, sysinfo, usage, versions)
from . import code_api

LOG = logging.getLogger("x3.api")

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

app = FastAPI(title="Redline API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"], allow_headers=["*"],
)

_client = None

# The coding rooms keep their routes in a file of their own.
app.include_router(code_api.router)


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
async def drop_model(model_id: str, force: bool = False):
    users = await store.importers_of(db(), model_id)
    if users and not force:
        raise HTTPException(
            409, f"{model_id} is imported by {', '.join(users)}; "
                 "deleting it breaks their build. Pass force=true to go ahead.")
    try:
        await store.delete_model(db(), model_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"deleted": model_id, "was_imported_by": users}


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
    # Sent still compressed: the browser unpacks it for free and a 63 MB
    # payload goes over the wire as a few megabytes instead. Unpacking it
    # here only to have the browser see it uncompressed was the reason a
    # model took a minute and a half to open.
    try:
        packed = await store.get_artifact_gz(db(), model_id, "viewer")
    except KeyError as exc:
        raise HTTPException(404, f"{model_id}: build it first") from exc
    return Response(content=packed, media_type="application/json",
                    headers={"Content-Encoding": "gzip",
                             "Cache-Control": "public, max-age=31536000, immutable"})


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
    # Which room's log this belongs in. The 3D room's log is about models
    # and the board room's about boards; one feed for both mixed a
    # tessellation in with a placement.
    room: str = Field(default="cad", pattern="^(cad|pcb|web|embedded|mobile)$")


class RunStart(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    revision: str | None = None
    model: str | None = None
    # Whose run: each room has its own, so agents in different rooms can
    # work at once without closing each other's.
    room: str = Field(default="cad", pattern="^(cad|pcb|web|embedded|mobile)$")


async def say(text: str, level: str = "info", room: str = "cad") -> dict:
    """Put one line in the log, and keep the log bounded.

    The agent posts its own lines over HTTP; this is for the work the
    server does on its own behalf - a board build nobody would otherwise
    see happen.
    """
    from datetime import datetime, timezone
    import uuid

    d = db()
    doc = {"_id": uuid.uuid4().hex[:12],
           "at": datetime.now(timezone.utc).isoformat(),
           "text": text.strip(), "level": level, "room": room}
    await d.activity.insert_one(doc)
    total = await d.activity.count_documents({})
    if total > ACTIVITY_KEEP:
        old = [x["_id"] async for x in
               d.activity.find({}, {"_id": 1}).sort("at", 1).limit(total - ACTIVITY_KEEP)]
        await d.activity.delete_many({"_id": {"$in": old}})
    return doc


@app.post("/api/activity")
async def push_activity(body: ActivityIn):
    d = db()
    doc = await say(body.text, body.level, body.room)

    # A percent on a log line also advances the bar, so one call does both.
    if body.percent is not None:
        await d.runs.update_one({"_id": compute.run_key(body.room)},
                                {"$set": {"percent": body.percent}})

    return doc


@app.get("/api/activity")
async def list_activity(limit: int = 120, room: str = "cad"):
    """One room's log. Lines written before rooms had logs of their own are
    the 3D room's, which is the only one there was."""
    query = {"room": {"$in": ["cad", None]}} if room == "cad" else {"room": room}
    rows = [x async for x in db().activity.find(query).sort("at", -1).limit(limit)]
    return list(reversed(rows))            # oldest first, log order


@app.get("/api/run")
async def get_run(room: str = "cad"):
    return await db().runs.find_one({"_id": compute.run_key(room)})


@app.post("/api/run/start")
async def start_run(body: RunStart):
    from datetime import datetime, timezone

    key = compute.run_key(body.room)
    doc = {"_id": key, "title": body.title, "revision": body.revision,
           "model": body.model, "percent": 0.0, "status": "running",
           "room": body.room,
           "started_at": datetime.now(timezone.utc).isoformat(),
           "finished_at": None}
    await db().runs.replace_one({"_id": key}, doc, upsert=True)
    # Keyed by the revision as well: "current" is overwritten by the next run
    # and the window this one was worked in is what its cost is measured over.
    if body.revision:
        await db().runs.replace_one({"_id": body.revision},
                                    {**doc, "_id": body.revision}, upsert=True)
    return doc


@app.post("/api/run/finish")
async def finish_run(status: str = "done", room: str = "cad"):
    from datetime import datetime, timezone

    patch = {"status": status, "percent": 100.0,
             "finished_at": datetime.now(timezone.utc).isoformat()}
    d = db()
    key = compute.run_key(room)
    cur = await d.runs.find_one({"_id": key}) or {}
    await d.runs.update_one({"_id": key}, {"$set": patch}, upsert=True)
    rev = cur.get("revision")
    if rev:
        await d.runs.update_one({"_id": rev}, {"$set": patch}, upsert=False)
        # Freeze what the work cost. A failure here must not stop a run from
        # finishing, so it is logged and swallowed.
        try:
            await usage.store(d, rev, await d.runs.find_one({"_id": rev})
                              or {**cur, **patch})
        except Exception as exc:
            LOG.warning("analytics for %s skipped: %s", rev, exc)
    return await d.runs.find_one({"_id": key})


@app.get("/api/revisions/{rid}/analytics")
async def revision_analytics(rid: str, live: bool = False):
    """What one revision cost: tokens, money at list price, time, rate.

    Frozen when the run finished. `live` re-reads the transcripts, which is
    what the card does while a run is still going.
    """
    d = db()
    if not live:
        doc = await d[usage.ANALYTICS].find_one({"_id": rid})
        if doc:
            return doc
    run = await d.runs.find_one({"_id": rid})
    if not run or not run.get("started_at"):
        raise HTTPException(404, "no run recorded for this revision")
    # A live read happens on every page load and every poll; it may use the
    # transcript as it was a few seconds ago rather than wait to re-read it.
    return await usage.store(d, rid, run, fresh=not live)


@app.post("/api/usage/ingest")
async def usage_ingest(full: bool = False):
    """Pull new LLM calls out of the agent transcripts into the database."""
    return await usage.ingest(db(), full=full)


@app.get("/api/usage/prices")
async def usage_prices():
    """The rate card the costs are computed with, so the page can say so."""
    return {"unit": "USD per 1M tokens", "models": usage.PRICES}


# ---------------- revisions ----------------
class RevisionIn(BaseModel):
    comment: str = Field(min_length=1, max_length=4000)
    # Optional: a note about a part does not need a drawing.
    image_png: str | None = None
    # What was on screen when the note was written: which parts were shown.
    # The camera alone is only where it was seen from.
    view: dict | None = None
    camera: dict | None = None
    part: str | None = None
    model: str | None = None
    # "pcb" when the note is about a board. A board is not a model - it has
    # no camera, nothing to freeze, and `build` does not take it - so the
    # agent and the page both need to know which one they are holding.
    kind: str | None = Field(default=None, pattern="^(cad|pcb|web|embedded|mobile)$")
    # A note on a running interface: the route and size it was drawn at,
    # the commit it was drawn against, and the elements under the marks.
    # web, embedded and mobile are the three coding rooms.
    code: dict | None = None


def _out(d: dict) -> dict:
    return {"id": d["_id"], "created_at": d["created_at"], "comment": d["comment"],
            "camera": d.get("camera"), "part": d.get("part"), "model": d.get("model"),
            "kind": d.get("kind") or "cad",
            "view": d.get("view"),
            "code": d.get("code"),
            "status": d.get("status", "draft"), "queued_at": d.get("queued_at"),
            "edited_at": d.get("edited_at"), "archived": bool(d.get("archived")),
            "image_bytes": (d.get("image") or {}).get("bytes", 0),
            # The same view once the work is done, so the card can show
            # before and after side by side.
            "image_after_bytes": (d.get("image_after") or {}).get("bytes", 0),
            "summary": d.get("summary"),
            "comment_original": d.get("comment_original"),
            "summary_manual": bool(d.get("summary_manual"))}


async def _log_openrouter(rid: str, used: dict, surface: str,
                          kind: str) -> None:
    """Put an OpenRouter call on the revision's bill.

    It is a second vendor working on the same card, and the analytics panel
    should say so rather than showing Anthropic alone. OpenRouter reports its
    own cost, so no rate card is needed. Never fatal: the card is already
    saved by the time this runs.
    """
    import uuid

    try:
        await usage.record_call(
            db(), _id=f"or:{uuid.uuid4().hex[:16]}", provider="openrouter",
            surface=surface, kind=kind, model=summarise.MODEL,
            input=used.get("prompt_tokens") or 0,
            output=used.get("completion_tokens") or 0,
            cache_read=0, cache_write=0, thinking=0,
            cost_usd=used.get("cost"), cost_basis="billed", revision=rid)
    except Exception as exc:                         # noqa: BLE001
        LOG.warning("usage for %s not recorded: %s", rid, exc)


# ---------------- english notes ----------------
# Notes get written in whatever language is to hand; the model sources, the
# card summaries and the rest of this app are English. With the switch on,
# the note becomes an English request at the door, so everything downstream
# reads the same way. The original is kept - it is what the person actually
# wrote, and a bad translation must not lose it.
async def _translate_note(rid: str) -> None:
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc or doc.get("comment_original"):
        return
    try:
        text, used = await summarise.translate(doc["comment"])
    except Exception as exc:                         # noqa: BLE001
        LOG.warning("translation for %s failed: %s", rid, exc)
        return
    await _log_openrouter(rid, used, "translate", "translate")
    if not text or text.strip() == doc["comment"].strip():
        return
    await d.revisions.update_one({"_id": rid}, {"$set": {
        "comment": text, "comment_original": doc["comment"],
        "translated_at": store.now()}})
    # The summary is written from the note, so it has to follow the English.
    await _make_summary(rid, english=True)


# ---------------- card summaries ----------------
# A collapsed card shows one sentence instead of a wall of text. Generated
# off the request: a failed or slow call must never hold up saving a card,
# and it must never overwrite a sentence the user wrote by hand.
async def _make_summary(rid: str, english: bool | None = None) -> None:
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc or doc.get("summary_manual"):
        return
    png = None
    gid = (doc.get("image") or {}).get("gridfs_id")
    if gid:
        try:
            png = await store.get_shot(d, gid)
        except Exception:                            # noqa: BLE001
            png = None
    # With notes saved as English requests the summary has to follow, or the
    # card shows an English note under a Turkish sentence. A card that carries
    # the original it was translated from is English by definition; the caller
    # can also say so outright, for the first pass after a translation.
    if english is None:
        english = bool(doc.get("comment_original"))
    try:
        text, used = await summarise.summarise(doc["comment"], png, english)
    except Exception as exc:                         # noqa: BLE001
        LOG.warning("summary for %s failed: %s", rid, exc)
        return
    await _log_openrouter(rid, used, "card-summary", "summary")
    if not text:
        return
    await d.revisions.update_one({"_id": rid}, {"$set": {
        "summary": text, "summary_at": store.now(), "summary_manual": False}})


def schedule_summary(rid: str) -> None:
    import asyncio
    asyncio.create_task(_make_summary(rid))


async def _translate_then_summarise(rid: str) -> None:
    """Translate first when the switch is on, because the summary is written
    from the note and would otherwise be generated from the old language and
    then thrown away."""
    english = (await store.settings(db()))["auto_translate"]
    if english:
        await _translate_note(rid)          # writes the summary itself
        doc = await db().revisions.find_one({"_id": rid}) or {}
        if doc.get("summary"):
            return
    await _make_summary(rid, english=english)


def schedule_note_work(rid: str) -> None:
    import asyncio
    asyncio.create_task(_translate_then_summarise(rid))


@app.post("/api/revisions/{rid}/summary")
async def regenerate_summary(rid: str, force: bool = False):
    """Ask for the sentence again. force=true also replaces a hand-written one."""
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    if force:
        await d.revisions.update_one({"_id": rid},
                                     {"$set": {"summary_manual": False}})
    # With the switch on, the summary is English even for a note nobody
    # translated: the setting is the person saying which language they want
    # to read the board in.
    english = bool((await store.settings(d))["auto_translate"]
                   or doc.get("comment_original"))
    await _make_summary(rid, english=english)
    return _out(await d.revisions.find_one({"_id": rid}))


@app.post("/api/revisions/english")
async def make_everything_english(limit: int = 200):
    """Turn every note on the board into an English request.

    One card at a time and never in parallel: the same rate limit that
    protects the summariser applies here, and a card whose translation fails
    is left exactly as it was rather than half-converted.
    """
    d = db()
    rows = [r async for r in d.revisions.find(
        {"comment_original": {"$in": [None, ""]}}).limit(limit)]
    done, failed = [], []
    for row in rows:
        before = row.get("comment")
        try:
            await _translate_note(row["_id"])
        except Exception as exc:                     # noqa: BLE001
            LOG.warning("english for %s failed: %s", row["_id"], exc)
            failed.append(row["_id"])
            continue
        after = await d.revisions.find_one({"_id": row["_id"]}) or {}
        if after.get("comment_original"):
            done.append(row["_id"])
        elif after.get("comment") == before:
            # Already English: nothing to translate, but the summary may
            # still be in the other language.
            await _make_summary(row["_id"], english=True)
            done.append(row["_id"])
    return {"looked_at": len(rows), "translated": len(done),
            "failed": failed}


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
        "part": body.part, "model": body.model, "kind": body.kind or "cad",
        "status": "draft", "queued_at": None,
        "image": image,
        "view": body.view,
    }
    if body.code is not None:
        doc["code"] = code_api.enrich(body.code)
    await d.revisions.insert_one(doc)
    schedule_note_work(rid)
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


@app.put("/api/revisions/{rid}/image/after")
async def put_after_image(rid: str, file: UploadFile = File(...)):
    """Store the "after" shot: the same camera once the work is done.

    Uploaded rather than rendered here - rendering drives a headless browser
    against this very server, and having the server wait on itself is a good
    way to deadlock.
    """
    d = db()
    if not await d.revisions.find_one({"_id": rid}):
        raise HTTPException(404, "no such revision")
    png = await file.read()
    if not png.startswith(b"\x89PNG"):
        raise HTTPException(400, "expected a PNG")
    shot = await store.put_shot(d, png)
    await d.revisions.update_one({"_id": rid}, {"$set": {"image_after": shot}})
    return {"id": rid, "bytes": shot["bytes"]}


@app.get("/api/revisions/{rid}/image")
async def revision_image(rid: str, which: str = "before"):
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    key = "image_after" if which == "after" else "image"
    if not doc or not doc.get(key):
        raise HTTPException(404, rid)
    png = await store.get_shot(d, doc[key]["gridfs_id"])
    return Response(content=png, media_type="image/png")


class RevisionEdit(BaseModel):
    """Only the text is editable; the drawing is the record and stays fixed."""
    comment: str | None = Field(default=None, min_length=1, max_length=4000)
    part: str | None = None
    # Empty string clears it and hands the card back to the generator.
    summary: str | None = Field(default=None, max_length=200)


@app.put("/api/revisions/{rid}")
async def edit_revision(rid: str, body: RevisionEdit):
    from datetime import datetime, timezone

    patch: dict = {}
    if body.comment is not None:
        patch["comment"] = body.comment.strip()
    if body.part is not None:
        patch["part"] = body.part or None
    if body.summary is not None:
        # Written by hand: keep it, and stop the generator replacing it.
        patch["summary"] = body.summary.strip() or None
        patch["summary_manual"] = bool(patch["summary"])
    if not patch:
        raise HTTPException(400, "nothing to change")
    patch["edited_at"] = datetime.now(timezone.utc).isoformat()

    res = await db().revisions.update_one({"_id": rid}, {"$set": patch})
    if res.matched_count == 0:
        raise HTTPException(404, rid)
    doc = await db().revisions.find_one({"_id": rid})
    # The text changed, so the old sentence describes the old card.
    if body.comment is not None and body.summary is None \
            and not doc.get("summary_manual"):
        schedule_summary(rid)
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
async def put_settings(auto_archive: bool | None = None,
                       auto_translate: bool | None = None):
    patch = {k: v for k, v in (("auto_archive", auto_archive),
                               ("auto_translate", auto_translate))
             if v is not None}
    if patch:
        await db().settings.update_one({"_id": SETTINGS_ID}, {"$set": patch},
                                       upsert=True)
    return await get_settings()


# ---------------- boards ----------------
class BoardIn(BaseModel):
    source: str = Field(min_length=1, max_length=200_000)
    title: str | None = None
    entry: str | None = None


@app.get("/api/boards")
async def list_boards():
    """The board catalog: source stays out of it, it is the big field."""
    rows = [b async for b in db()[ato.BOARDS].find({}, {"source": 0})]
    for b in rows:
        # The GridFS id is an ObjectId and the browser has no use for it;
        # what it needs is the build time, to know when its copy is old.
        b["artifacts"] = {k: {"bytes": v.get("bytes"), "at": v.get("at")}
                          for k, v in (b.get("artifacts") or {}).items()}
        b["ready"] = "graph" in b["artifacts"]
    rows.sort(key=lambda b: b["_id"])
    return rows


@app.get("/api/boards/{bid}")
async def one_board(bid: str):
    doc = await db()[ato.BOARDS].find_one({"_id": bid}, {"artifacts": 0})
    if not doc:
        raise HTTPException(404, bid)
    return doc


@app.put("/api/boards/{bid}")
async def save_board(bid: str, body: BoardIn):
    """Write the source. Building is a separate step, as for a model."""
    patch = {"source": body.source, "saved_at": store.now(), "stale": True}
    if body.title:
        patch["title"] = body.title
    if body.entry:
        patch["entry"] = body.entry
    await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": patch}, upsert=True)
    return {"id": bid, "saved": True}


@app.post("/api/boards/{bid}/move")
async def move_board(bid: str, folder: str = ""):
    """Put a board in a folder.

    A model's id carries its path, so moving one renames it; a board's
    does not. The board keeps its id and its history - the netlist, the
    layout, every compute job filed against it - and only the folder it is
    listed under changes.
    """
    if folder and not await db().folders.find_one({"_id": folder}):
        raise HTTPException(404, f"no folder {folder}")
    got = await db()[ato.BOARDS].update_one({"_id": bid},
                                            {"$set": {"folder": folder}})
    if not got.matched_count:
        raise HTTPException(404, bid)
    return {"board": bid, "folder": folder}


@app.post("/api/boards/{bid}/build")
async def build_board(bid: str):
    # The log is how a build is watched, and until now a board built in
    # silence: the only sign it had happened was the netlist changing.
    await say(f"{bid}: building", "work", room="pcb")
    try:
        out = await ato.build(db(), bid)
    except KeyError:
        raise HTTPException(404, bid)
    except (ValueError, RuntimeError, TimeoutError) as exc:
        await say(f"{bid}: build failed - {str(exc).splitlines()[0][:160]}", "error", room="pcb")
        raise HTTPException(400, str(exc))
    await say(f"{bid}: built - {out['components']} parts, {out['nets']} nets, "
              f"{out['joins']} joins", "done", room="pcb")
    return out


@app.post("/api/boards/{bid}/layout")
async def layout_board(bid: str):
    """Place the built netlist and draw it. KiCad runs in a container."""
    await say(f"{bid}: placing - fetching parts, then KiCad", "work", room="pcb")
    try:
        out = await kicad.render(db(), bid)
    except kicad.NoDocker as exc:
        await say(f"{bid}: {exc}", "error", room="pcb")
        raise HTTPException(503, str(exc))
    except KeyError:
        raise HTTPException(404, "not built yet")
    except (RuntimeError, TimeoutError) as exc:
        await say(f"{bid}: placing failed - {str(exc).splitlines()[0][:160]}", "error", room="pcb")
        raise HTTPException(400, str(exc))
    size = out.get("size_mm")
    await say(f"{bid}: placed {out.get('placed')}"
              + (f" - {size[0]} x {size[1]} mm" if size else "")
              + f" - {out.get('parts_from_lcsc', 0)} from LCSC", "done", room="pcb")
    for trouble in (out.get("part_trouble") or [])[:4]:
        await say(f"{bid}: {trouble[:160]}", "warn", room="pcb")
    return out


@app.get("/api/boards/{bid}/layout.svg")
async def board_layout(bid: str):
    try:
        raw = await store.get_artifact(db(), bid, "layout", ato.BOARDS)
    except KeyError:
        raise HTTPException(404, "no layout yet")
    return Response(raw, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/boards/{bid}/{which}.svg")
async def board_drawing(bid: str, which: str):
    """The other drawings of a board: `tracks` (the copper without the
    ground pour), `bottom` (the back, seen from below) and `schematic`."""
    artifact = {"tracks": "tracks", "bottom": "bottom",
                "schematic": "schematic_svg"}.get(which)
    if not artifact:
        raise HTTPException(404, which)
    try:
        raw = await store.get_artifact(db(), bid, artifact, ato.BOARDS)
    except KeyError:
        raise HTTPException(404, f"no {which} drawing yet")
    return Response(raw, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/boards/{bid}/board.{kind}")
async def board_file(bid: str, kind: str):
    """The board and its schematic as KiCad files, to open and take further
    by hand. The routed board where there is one, the placed one if not."""
    if kind == "glb":
        # This route is registered first and would otherwise swallow the
        # 3D model's own.
        return await board_model(bid)
    if kind == "kicad_sch":
        names = ["schematic"]
    elif kind == "kicad_pcb":
        names = ["routed", "pcb"]
    else:
        raise HTTPException(404, kind)
    for name in names:
        try:
            raw = await store.get_artifact(db(), bid, name, ato.BOARDS)
        except KeyError:
            continue
        return Response(raw, media_type="application/octet-stream", headers={
            "Content-Disposition": f'attachment; filename="{bid}.{kind}"'})
    raise HTTPException(404, f"no {kind} yet")


@app.post("/api/boards/{bid}/schematic")
async def draw_schematic(bid: str):
    """Write the schematic from the last build, draw it, and run ERC."""
    await say(f"{bid}: drawing the schematic", "work", room="pcb")
    try:
        out = await schematic.draw(db(), bid)
    except KeyError:
        raise HTTPException(404, "not built yet")
    except (RuntimeError, OSError, TimeoutError) as exc:
        await say(f"{bid}: schematic failed - {str(exc).splitlines()[0][:160]}",
                  "error", room="pcb")
        raise HTTPException(400, str(exc))
    erc = out.get("erc", {})
    await say(f"{bid}: schematic - {out['parts']} parts, {out['labels']} pins joined, "
              f"ERC {erc.get('error_count', '?')} errors", 
              "done" if not erc.get("error_count") else "warn", room="pcb")
    return out


class RulesIn(BaseModel):
    rules: dict


@app.get("/api/boards/{bid}/rules")
async def board_rules(bid: str):
    """The routing rules, brought up to date with the board's nets."""
    doc = await db()[ato.BOARDS].find_one({"_id": bid}, {"rules": 1, "pads": 1})
    if doc is None:
        raise HTTPException(404, bid)
    try:
        graph = json.loads(await store.get_artifact(db(), bid, "graph", ato.BOARDS))
        nets = sorted({n.get("name") for n in graph.get("nets", []) if n.get("name")})
    except KeyError:
        nets = []
    merged = rules.merge(doc.get("rules"), nets)
    return {"rules": merged, "problems": rules.check(merged, nets, doc.get("pads")),
            "nets": nets,
            # Who is in each class once the patterns have caught their nets.
            "members": rules.members(merged, nets)}


@app.get("/api/rules/schema")
async def rules_schema():
    """What every rule is: label, unit, limits, help. The form in the
    board room is drawn from this, and an agent reads it before editing."""
    return rules.SCHEMA


async def _board_pads(bid: str) -> dict | None:
    doc = await db()[ato.BOARDS].find_one({"_id": bid}, {"pads": 1}) or {}
    return doc.get("pads")


async def _board_nets(bid: str) -> list[str] | None:
    try:
        graph = json.loads(await store.get_artifact(db(), bid, "graph", ato.BOARDS))
    except KeyError:
        return None
    return sorted({n.get("name") for n in graph.get("nets", []) if n.get("name")})


@app.post("/api/boards/{bid}/rules/check")
async def check_board_rules(bid: str, body: RulesIn):
    """What would be wrong with these rules, and who each class would
    hold - without saving. The form asks this as it is edited."""
    nets = await _board_nets(bid)
    clean = rules.normalise(body.rules)
    return {"problems": rules.check(clean, nets, await _board_pads(bid)),
            "members": rules.members(clean, nets or [])}


@app.put("/api/boards/{bid}/rules")
async def save_board_rules(bid: str, body: RulesIn):
    """Save the rules a person set. Checked first: a track under the
    board's minimum, or a net in two classes, is said now rather than
    discovered by the router."""
    nets = await _board_nets(bid)
    clean = rules.normalise(body.rules)
    problems = rules.check(clean, nets, await _board_pads(bid))
    if problems:
        raise HTTPException(400, {"problems": problems})
    clean["edited"] = True
    got = await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": {"rules": clean}})
    if not got.matched_count:
        raise HTTPException(404, bid)
    await say(f"{bid}: routing rules saved", "info", room="pcb")
    return {"saved": True}


@app.post("/api/boards/{bid}/run")
async def run_board(bid: str):
    """The whole of it, in order: build the source, draw the schematic,
    place, route, pour, check. What a change to a board goes through,
    every time - so nothing downstream is ever older than the source."""
    import time as _time

    t0 = _time.monotonic()
    out = {"board": bid}
    await say(f"{bid}: running the pipeline - build, schematic, place, route, DRC",
              "work", room="pcb")
    out["build"] = await build_board(bid)
    out["schematic"] = await draw_schematic(bid)
    out["layout"] = await layout_board(bid)
    took = round(_time.monotonic() - t0, 1)
    drc = (out["layout"] or {}).get("drc") or {}
    route = (out["layout"] or {}).get("route") or {}
    await say(f"{bid}: pipeline done in {took} s - unrouted {route.get('unrouted', '?')}, "
              f"DRC {drc.get('error_count', '?')} errors, "
              f"ERC {out['schematic'].get('erc', {}).get('error_count', '?')} errors",
              "done", room="pcb")
    out["seconds"] = took
    return out


@app.get("/api/boards/{bid}/board.glb")
async def board_model(bid: str):
    try:
        raw = await store.get_artifact(db(), bid, "model3d", ato.BOARDS)
    except KeyError:
        raise HTTPException(404, "no model yet")
    return Response(raw, media_type="model/gltf-binary",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------------- parts ----------------
@app.middleware("http")
async def _who_asks(request, call_next):
    """Tag LCSC lookups with who wanted them, for the journal.

    The page asks through a browser; anything else on these routes - curl
    from an agent, a script - is an agent. It is the same server either
    way, so the only thing that tells them apart is the client.
    """
    if request.url.path.startswith("/api/parts"):
        agent = request.headers.get("user-agent", "")
        lcsc.WHO.set("page" if "Mozilla" in agent else "agent")
    return await call_next(request)


@app.get("/api/lcsc/requests")
async def lcsc_requests(limit: int = 200):
    """Every ask made of LCSC - by the page, by an agent, by a builder -
    newest first, with the turn-taking as it stands."""
    rows = lcsc.journal(max(1, min(limit, 1000)))
    hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent = [r for r in rows if r.get("at", "") >= hour_ago]
    return {
        "state": lcsc.state(),
        "rows": rows,
        "last_hour": {
            "net": sum(r["source"] == "net" for r in recent),
            "disk": sum(r["source"] == "disk" for r in recent),
            "refused": sum(r["source"] == "refused" or r.get("status") in (403, 429)
                           for r in recent),
        },
    }

@app.get("/api/parts")
async def list_parts():
    """The drawer: every part that has been fetched, and whether it came
    with a 3D model."""
    return await lcsc.known(db())


@app.get("/api/parts/search")
async def search_parts(q: str, limit: int = 20):
    """LCSC's catalogue, by name, package, manufacturer or number.

    Nothing is downloaded here. A search is a list to choose from; the
    footprint and the model come when one is picked.
    """
    try:
        rows = await lcsc.search(q, limit)
    except (OSError, ValueError) as exc:
        raise HTTPException(502, f"LCSC did not answer: {exc}")
    have = {p["lcsc"] for p in await lcsc.known(db())}
    for row in rows:
        row["have"] = row["lcsc"] in have
    return rows


async def _look(what, *args):
    """A preview request: LCSC's errors become the browser's 404/502."""
    try:
        return await what(*args)
    except lcsc.Refused as exc:
        # Being asked to wait is not the server failing: 503 and why.
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except (OSError, TimeoutError) as exc:
        raise HTTPException(502, f"EasyEDA did not answer: {exc}")


# Previews do not change for a given part number, so the browser may keep
# them as long as it likes; the server keeps them on disk anyway.
_KEEP = {"Cache-Control": "public, max-age=604800"}

# The drawings are EasyEDA's markup served from this origin. The page only
# ever shows them through <img>, where nothing in them can run; this is for
# anybody who opens one directly.
_INERT_SVG = {**_KEEP, "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; img-src data:"}


@app.get("/api/parts/pick")
async def pick_parts(q: str, limit: int = 6):
    """A search ranked for somebody about to order: in stock first, then
    JLCPCB Basic before Extended, then the most stock."""
    try:
        return await lcsc.pick(q, limit)
    except (OSError, ValueError) as exc:
        raise HTTPException(502, f"LCSC did not answer: {exc}")


@app.get("/api/parts/{lcsc_id}/pins")
async def part_pins(lcsc_id: str):
    """Every pin, by the number it has on the footprint, from the symbol."""
    return await _look(lcsc.pins, lcsc_id)


@app.get("/api/parts/{lcsc_id}/ato")
async def part_ato(lcsc_id: str):
    """The part as an atopile component block, ready to paste into a board."""
    return Response(await _look(lcsc.ato_component, lcsc_id),
                    media_type="text/plain")


@app.get("/api/parts/{lcsc_id}/preview")
async def part_preview(lcsc_id: str):
    """What a part is, before anybody decides to keep it."""
    out = await _look(lcsc.preview, lcsc_id)
    out["have"] = bool(await db()[lcsc.PARTS].find_one({"_id": lcsc_id}, {"_id": 1}))
    return out


@app.get("/api/parts/{lcsc_id}/footprint.svg")
async def part_footprint(lcsc_id: str):
    return Response(await _look(lcsc.drawing, lcsc_id, lcsc.FOOTPRINT),
                    media_type="image/svg+xml", headers=_INERT_SVG)


@app.get("/api/parts/{lcsc_id}/symbol.svg")
async def part_symbol(lcsc_id: str):
    return Response(await _look(lcsc.drawing, lcsc_id, lcsc.SYMBOL),
                    media_type="image/svg+xml", headers=_INERT_SVG)


@app.get("/api/parts/{lcsc_id}/model.glb")
async def part_model(lcsc_id: str):
    """The 3D shape, converted from EasyEDA's OBJ once and kept. Gzipped on
    the way out: an LQFP-48 is 1.18 MB of GLB and 0.59 MB over the wire."""
    import gzip as _gzip

    raw = await _look(lcsc.model_glb, lcsc_id)
    return Response(_gzip.compress(raw, 5), media_type="model/gltf-binary",
                    headers={**_KEEP, "Content-Encoding": "gzip"})


@app.get("/api/parts/{lcsc_id}/photo.jpg")
async def part_photo(lcsc_id: str):
    return Response(await _look(lcsc.photo, lcsc_id),
                    media_type="image/jpeg", headers=_KEEP)


@app.post("/api/parts/{lcsc_id}")
async def add_part(lcsc_id: str, force: bool = False):
    """Fetch one part and keep it: footprint, and the 3D model if there is
    one. This is what makes it available to a board."""
    try:
        doc = await lcsc.fetch(db(), lcsc_id, force)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except (RuntimeError, TimeoutError, OSError) as exc:
        await say(f"{lcsc_id}: could not be fetched - {exc}", "warn", room="pcb")
        raise HTTPException(502, str(exc))
    has_3d = bool((doc.get("artifacts") or {}).get("model")
                  or doc.get("model_step") or doc.get("model_wrl"))
    await say(f"{lcsc_id} fetched from LCSC - {doc.get('name')}"
              + (f" with a {doc.get('model_kind', '3D')} model" if has_3d
                 else ", footprint only"), "done", room="pcb")
    return {"lcsc": lcsc_id, "name": doc.get("name"), "has_3d": has_3d}


@app.delete("/api/parts/{lcsc_id}")
async def drop_part(lcsc_id: str):
    got = await db()[lcsc.PARTS].delete_one({"_id": lcsc_id})
    if not got.deleted_count:
        raise HTTPException(404, lcsc_id)
    return {"deleted": lcsc_id}


@app.get("/api/boards/{bid}/analytics")
async def board_analytics(bid: str):
    """The board room's Analytics tab: the board, its bill and its library,
    from what is already known - nothing is asked of LCSC."""
    from . import board_stats
    try:
        return await board_stats.summary(db(), bid)
    except KeyError:
        raise HTTPException(404, bid)


@app.get("/api/boards/{bid}/compute")
async def board_compute(bid: str, limit: int = 12):
    """What building and placing this board has cost the machine.

    One row per job, newest first, plus the totals. The CPU figure is
    honest about where it comes from: atopile runs here and is measured
    here, while KiCad runs in a container whose time is nobody's child,
    so a placement reports the wall clock and leaves it at that.
    """
    rows = [r async for r in db()[compute.JOBS]
            .find({"model": bid}, {"_id": 0}).sort("at", -1).limit(limit)]
    total = {"jobs": len(rows),
             "wall_s": round(sum(r.get("wall_s") or 0 for r in rows), 2),
             "cpu_s": round(sum(r.get("cpu_s") or 0 for r in rows
                                if r.get("kind") != "layout"), 2)}
    return {"board": bid, "jobs": rows, "total": total}


@app.get("/api/boards/{bid}/geometry.json")
async def board_geometry(bid: str):
    """The routed board as data - tracks, vias, pads, nets - for looking
    into it with the mouse."""
    try:
        raw = await store.get_artifact_gz(db(), bid, "geometry", ato.BOARDS)
    except KeyError:
        raise HTTPException(404, "not routed yet")
    return Response(raw, media_type="application/json",
                    headers={"Content-Encoding": "gzip",
                             "Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/boards/{bid}/graph.json")
async def board_graph(bid: str):
    """What the build made of it: components, nets, and the bill."""
    try:
        raw = await store.get_artifact_gz(db(), bid, "graph", ato.BOARDS)
    except KeyError:
        raise HTTPException(404, "not built yet")
    return Response(raw, media_type="application/json",
                    headers={"Content-Encoding": "gzip",
                             "Cache-Control": "public, max-age=31536000, immutable"})


@app.delete("/api/boards/{bid}")
async def drop_board(bid: str):
    res = await db()[ato.BOARDS].delete_one({"_id": bid})
    if not res.deleted_count:
        raise HTTPException(404, bid)
    # Written down: a board went missing once with nothing to say when or
    # how, and a deletion is the one change there is no undoing.
    await say(f"{bid}: deleted", "warn", room="pcb")
    return {"id": bid, "deleted": True}


# ---------------- analytics ----------------
@app.on_event("startup")
async def _start_sampler():
    """The machine, once a minute, for the Analytics room's energy figures."""
    import asyncio
    if MONGODB_URI:
        asyncio.create_task(insights.sampler(db))


@app.get("/api/insights")
async def get_insights(range: str = "24h"):
    """Everything the app has used over a range: LLMs, compute, the
    machine and its energy, work, storage, catalog, LCSC. Answered from the
    last result at once, refreshed behind it when older than 20 s."""
    async def span():
        since, until = insights.parse_range(range)
        if range == "all":
            since = await insights.first_use(db()) or since
        return since, until
    return await insights.overview_cached(db(), range, span)


class KwhIn(BaseModel):
    price: float | None = Field(default=None, ge=0, le=10)


@app.put("/api/insights/kwh-price")
async def put_kwh_price(body: KwhIn):
    """What a kilowatt-hour costs here, for the electricity figures."""
    await insights.set_kwh_price(db(), body.price)
    return {"kwh_price": body.price}


# ---------------- chat ----------------
class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    # "Stop what you are doing", as opposed to "when you get a moment".
    urgent: bool = False
    # Which room's thread: each tab has its own.
    room: str = "cad"


@app.get("/api/chat")
async def chat_history(limit: int = 200, room: str | None = None):
    """The thread, oldest first - one room's, or all of them. The page
    polls its room's with the health."""
    return await chat.history(db(), limit, room)


@app.post("/api/chat")
async def chat_post(body: ChatIn):
    """Say something to the agent. Its own replies come in over the CLI."""
    try:
        return await chat.post(db(), body.text, urgent=body.urgent, room=body.room)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/chat")
async def chat_clear(room: str | None = None):
    return {"deleted": await chat.clear(db(), room)}


@app.delete("/api/chat/{mid}")
async def chat_retract(mid: str):
    """Unsend, while the agent has not picked it up."""
    if not await chat.retract(db(), mid):
        raise HTTPException(409, "already picked up, or not yours to take back")
    return {"id": mid, "retracted": True}


# ---------------- questions ----------------
class QuestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    context: str | None = Field(default=None, max_length=4000)
    options: list[str] = Field(default_factory=list)
    multi: bool = False
    revision: str | None = None


class AnswerIn(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)


@app.get("/api/questions")
async def list_questions():
    """What the agent is waiting on. The page polls this with the health."""
    return await questions.open_questions(db())


@app.post("/api/questions")
async def create_question(body: QuestionIn):
    return await questions.ask(db(), body.text, body.options, body.revision,
                               body.context, body.multi)


@app.post("/api/questions/{qid}/answer")
async def answer_question(qid: str, body: AnswerIn):
    doc = await questions.answer(db(), qid, body.answer)
    if not doc:
        raise HTTPException(404, "no open question with that id")
    return doc


@app.delete("/api/questions/{qid}")
async def drop_question(qid: str):
    if not await questions.drop(db(), qid):
        raise HTTPException(404, "no open question with that id")
    return {"id": qid, "status": questions.DROPPED}


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
