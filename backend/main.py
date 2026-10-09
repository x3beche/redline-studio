"""Redline - API.

All project data lives in MongoDB: model sources, generated viewer payloads,
revision images and version history. Local disk is used only as scratch space
while a model is built, and is removed when the build finishes.

The connection string is read here alone; it never reaches the frontend.
"""

from __future__ import annotations

import base64
import json
import re
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field

# .env before the modules below: some read their settings when imported
# (ato's REDLINE_ATO, lcsc's REDLINE_EASYEDA and REDLINE_LCSC_GAP), and reading them
# first left .env's values unseen - the defaults won wherever they differed.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from . import (access, actors, ato, auth, buildjobs, changes, convert, files, jobs, notes, release, search, insights, scope, build, chat, compute, kicad, lcsc, questions, rules,
               schematic, store, summarise, usage, links, board3d)
from . import tools_api
from . import fwnotes

LOG = logging.getLogger("redline.api")

ROOT = Path(__file__).resolve().parent.parent
EXPORT_SCRIPT = ROOT / "export_model.py"

load_dotenv(ROOT / ".env")
MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DB = os.getenv("MONGODB_DB", "redline")

# draft  : the user is still writing, models do not see it
# queued : in the apply queue, models read these
STATUSES = ("draft", "queued", "applied", "rejected")   # a note's status (PATCH /api/revisions)
ORDER = {"queued": 0, "draft": 1, "applied": 2, "rejected": 3}

app = FastAPI(title="Redline API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"], allow_headers=["*"],
)

_client = None

# The Tools tab's catalog, checks, runs and usage, and the tool pages.
tools_api.mount(app)
# And the agents' way in to their database work (users phase 4).
from . import agent_api  # noqa: E402
app.include_router(agent_api.router)
# A board brought in from outside: Gerbers, drills, a probe netlist, a BOM,
# a STEP, or another tool's design file.
from .imports import api as imports_api  # noqa: E402
app.include_router(imports_api.router)
# Which model does which job, the keys (Preferences > LLM settings), and
# the Command Code room's conversations.
from . import cc_chat, llm, llm_api, netproxy  # noqa: E402
app.include_router(llm_api.router)
app.include_router(cc_chat.router)
# Settings > Proxy: a second way out for the EasyEDA part lookups.
app.include_router(netproxy.router)
from . import routelive  # noqa: E402
app.include_router(routelive.router)
from . import costs as costs_api, fx  # noqa: E402
app.include_router(fx.router)
app.include_router(costs_api.router)
from . import worknow  # noqa: E402
app.include_router(worknow.router)
# An agent's question or thread reply, in the reader's language.
from . import reading  # noqa: E402
app.include_router(reading.router)
from . import themes as themes_api  # noqa: E402
app.include_router(themes_api.router)
# A ```task block in a chat, into the queue with one click (backend/tasks.py).
from . import tasks as tasks_api  # noqa: E402
app.include_router(tasks_api.router)
# Settings > Telegram: the bot, each person's own link, the webhook (backend/tgbot/).
from .tgbot import api as tg_api  # noqa: E402
app.include_router(tg_api.router)
from . import profile as profile_api  # noqa: E402
from . import client_errors  # noqa: E402
app.include_router(client_errors.router)
app.include_router(profile_api.router)
# The admin panel: the accounts, for the owner and the admins.
from . import admin as admin_api  # noqa: E402
app.include_router(admin_api.router)
# Accounts remembered on a browser, and switching between them.
from . import accounts as accounts_api  # noqa: E402
app.include_router(accounts_api.router)
# The Firmware room: a board's MCU, its code, its builds (backend/firmware.py).
from . import firmware_api  # noqa: E402
app.include_router(firmware_api.router)
# The Files tab: files in folders, read in place (backend/files_api.py).
from . import files_api  # noqa: E402
app.include_router(files_api.router)
# The next question, suggested in the empty composer (backend/suggest.py).
from . import suggest as suggest_api  # noqa: E402
app.include_router(suggest_api.router)


def _raw_db():
    """The database itself. Not for routes: they go through db()."""
    global _client
    if not MONGODB_URI:
        raise HTTPException(503, "MONGODB_URI is not set (.env)")
    if _client is None:
        from motor.motor_asyncio import AsyncIOMotorClient
        _client = AsyncIOMotorClient(MONGODB_URI)
    return _client[MONGODB_DB]


def db():
    """The database as the request's workspace sees it (backend/scope.py).
    Everything lives there, and every route reaches it through here."""
    return scope.ScopedDb(_raw_db(), scope.current())


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

STANDALONE = os.environ.get("REDLINE_IMPORT_ONLY") != "1"
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
    # The version the writer started from (`rev` from reading it): if the
    # source has changed since - an agent's edit - the write is refused
    # rather than laid over it.
    if_match: str | None = Field(default=None, max_length=64)


def _rev(source: str | None) -> str:
    """A short fingerprint of a source text: its version, for if_match."""
    import hashlib
    return hashlib.sha256((source or "").encode()).hexdigest()[:16]


def _stale_write(current: str | None, if_match: str | None) -> None:
    if if_match and current is not None and _rev(current) != if_match:
        raise HTTPException(409, {"detail": "the source changed while you were editing it - "
                                            "an agent or someone else saved first",
                                  "rev": _rev(current)})


@app.get("/api/models/{model_id:path}/source")
async def model_source(model_id: str):
    doc = await db().models.find_one({"_id": model_id})
    if not doc:
        raise HTTPException(404, model_id)
    if "source" not in doc:
        raise HTTPException(404, "this one has no source - it was brought in as a file, not written as code")
    return {"id": model_id, "title": doc.get("title"), "source": doc["source"],
            "sha256": doc.get("sha256"), "stale": doc.get("stale", True), "rev": _rev(doc["source"])}


@app.put("/api/models/{model_id:path}")
async def put_model(model_id: str, body: ModelIn):
    if body.if_match:
        cur = await db().models.find_one({"_id": model_id}, {"source": 1})
        _stale_write((cur or {}).get("source"), body.if_match)
    try:
        doc = await store.save_model(db(), model_id, body.source)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.if_match:
        await actors.audit(db(), "edit", f"model {model_id}", {"how": "code view"})
    prop = doc.get("propagation") or {}
    await _say_propagation(model_id, prop)
    return {**{k: doc[k] for k in ("_id", "title", "ready", "stale", "sha256", "error")},
            "rev": _rev(body.source), "version": doc.get("version"),
            "queued": prop.get("queued", []), "cycles": prop.get("cycles", [])}


async def _say_propagation(what: str, prop: dict, room: str = "cad") -> None:
    """In the log: what a change set off."""
    if prop.get("queued"):
        await say(f"{what} changed (v{prop.get('version')}): rebuilding "
                  + ", ".join(prop["queued"]), "work", room=room)
    for c in prop.get("cycles") or []:
        await say("import cycle, not built: " + " -> ".join(c + c[:1]), "error", room=room)


@app.post("/api/models/{model_id:path}/move")
async def move_model(model_id: str, folder: str = "", name: str | None = None):
    """Move a model to `folder`; with `name`, rename it too (its module
    name: the sources that import it must say the new one)."""
    try:
        new_id = await store.move_model(db(), model_id, folder, name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, FileExistsError) as exc:
        raise HTTPException(400, str(exc)) from exc
    await links.reindex(db())          # `import stand` may mean something else now
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
    await links.reindex(db())
    return {"deleted": model_id, "was_imported_by": users}


# ---------------- components: what uses what (backend/links.py) ----------------
async def _model_states(d) -> dict[str, dict]:
    """Each model's stale flag and its rebuild's state, for the lists."""
    out = {}
    async for m in d.models.find({}, {"stale": 1, "link": 1, "ready": 1, "error": 1}):
        link = m.get("link") or {}
        out[str(m["_id"])] = {"stale": bool(m.get("stale")), "state": link.get("state"),
                              "error": link.get("error") or m.get("error")}
    return out


@app.get("/api/components")
async def list_components(model: str | None = None):
    """Everything a model can import, for the 3D room's Insert picker and
    the agents' `component list`: every .3d model and every .pcb board,
    with the line that imports it, what it uses and who uses it. With
    `model`, the line is the one that model would write (a bare name
    resolves by the importer's project, backend/modnames.py); without, one
    that means the same thing in every model."""
    d = db()
    g = await links.load(d)
    states = await _model_states(d)
    out = []
    for k, info in sorted(g.nodes.items(), key=lambda kv: (kv[1]["kind"], kv[1]["title"].lower())):
        mod = links.module_for(info["kind"], info["id"], g.table, model)
        alias = "B" if info["kind"] == "board" else (info["id"].rpartition("/")[2] or "m")[:1].upper()
        st = states.get(info["id"], {}) if info["kind"] == "model" else {}
        out.append({"kind": info["kind"], "id": info["id"], "title": info["title"],
                    "version": info.get("version"), "module": mod,
                    "ready": info.get("ready", True),
                    "line": f"import {mod} as {alias}" if mod and mod.isidentifier() else None,
                    "uses": list(g.uses.get(k, [])),
                    "pins": g.pins.get(k, {}),
                    "stale": st.get("stale", False), "state": st.get("state"),
                    "used_by": [links.split(x)[1] for x in g.used_by(k)]})
    return out


@app.get("/api/components/modules")
async def component_modules():
    """Every name a model can import a component by, and what it is - the
    table the build lays the modules out by (links.module_table). The code
    view resolves an import line through it, so Ctrl+click opens what the
    build would import."""
    g = await links.load(db(), write_back=False)
    return links.table_rows(g)


@app.get("/api/components/{kind}/{cid:path}/versions")
async def component_versions(kind: str, cid: str):
    """The kept versions of a component, newest first, each with what it
    changed - what a pin can point at - and who pins it."""
    if kind not in ("model", "board"):
        raise HTTPException(404, kind)
    d = db()
    g = await links.load(d, write_back=False)
    k = links.key(kind, cid)
    if k not in g.nodes:
        raise HTTPException(404, cid)
    newest = g.nodes[k].get("version")
    # "latest" is the newest version that did not fail to build; `newest`
    # is the newest saved, failed or not.
    return {"kind": kind, "id": cid, "latest": await store.latest_good(d, kind, cid, newest),
            "newest": newest,
            "versions": await links.versions(d, kind, cid),
            "pinned_by": links.pinned_by(g, k)}


@app.post("/api/components/{kind}/{cid:path}/update-pins")
async def component_update_pins(kind: str, cid: str):
    """Move every model pinned to an older version of this component to its
    latest, and rebuild them."""
    if kind not in ("model", "board"):
        raise HTTPException(404, kind)
    d = db()
    try:
        moved = await links.update_pins(d, kind, cid)
    except (KeyError, links.PinError, LookupError) as exc:
        raise HTTPException(400, str(exc)) from exc
    for m in moved:
        await say(f"{m['model']}: {cid} v{m['from']} -> "
                  + (f"v{m['to']}" if m["to"] is not None else "latest") + ", rebuilding", "work")
    return {"component": links.key(kind, cid), "updated": moved}


@app.get("/api/models/{model_id:path}/links")
async def model_links(model_id: str):
    """One model as a component: what it uses (at which version, and
    which version its last build had), who uses it and who pins it, the
    rebuild a change set off, any cycle it is in, and numbers it copies
    from a component instead of reading them."""
    d = db()
    doc = await d.models.find_one({"_id": model_id}, {"source": 1, "built": 1, "link": 1,
                                                      "version": 1, "pins": 1, "stale": 1})
    if not doc:
        raise HTTPException(404, model_id)
    g = await links.load(d)
    k = links.key("model", model_id)
    now = links.against(g, k)
    built = doc.get("built") or {}
    against = built.get("against") or {}
    uses = []
    for u in g.uses.get(k, []):
        info = g.nodes.get(u) or {}
        uses.append({"kind": info.get("kind"), "id": info.get("id"), "title": info.get("title"),
                     "module": links.module_for(info.get("kind"), info.get("id"), g.table,
                                                model_id),
                     "version": info.get("version"),
                     "built_against": (against.get(u) or {}).get("version"),
                     "pinned": (doc.get("pins") or {}).get(u)})
    exports = {}
    for u in g.uses.get(k, []):
        kind, cid = links.split(u)
        mod = links.module_for(kind, cid, g.table, model_id) or cid
        if kind == "model":
            exports[mod] = links.model_exports(g.nodes[u].get("source") or "")
        else:
            try:
                exports[mod] = links.board_exports(json.loads(
                    await store.get_artifact(d, cid, "board3d", ato.BOARDS)))
            except KeyError:
                pass
    cycles = [[links.split(x)[1] for x in c] for c in g.cycles() if k in c]
    return {"id": model_id, "version": doc.get("version") or 1, "stale": bool(doc.get("stale")),
            "uses": uses,
            "used_by": [{"id": links.split(x)[1], "title": g.nodes[x]["title"]} for x in g.used_by(k)],
            "dependents": [links.split(x)[1] for x in g.dependents(k)],
            "pinned_by": links.pinned_by(g, k),
            "built": {"at": built.get("at"), "hash": built.get("hash"),
                      "current": bool(built.get("hash")) and built.get("hash") == now["hash"]},
            "link": doc.get("link"), "cycles": cycles, "pins": doc.get("pins") or {},
            "copied": links.copied_numbers(doc.get("source") or "", exports),
            # Bare names the build will refuse: several models, none in this project.
            "ambiguous": links.ambiguous(doc.get("source") or "", g.table, model_id)}


class PinIn(BaseModel):
    component: str = Field(pattern=r"^(model|board):.+")
    version: int | None = None          # None: follow the latest again


@app.post("/api/models/{model_id:path}/pins")
async def pin_component(model_id: str, body: PinIn):
    """Use one component at a fixed version (Fusion's "break link"), or
    follow its latest again. A pinned component's changes do not travel
    to this model. Either way the model, and what uses it, is rebuilt."""
    try:
        out = await links.set_pin(db(), model_id, body.component, body.version)
    except KeyError as exc:
        raise HTTPException(404, f"no model {exc}") from exc
    except links.PinError as exc:
        raise HTTPException(400, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    if out.get("changed"):
        title = links.split(body.component)[1]
        await say(f"{model_id}: " + (f"{title} pinned at v{body.version}" if body.version is not None
                                     else f"{title} follows its latest again") + ", rebuilding", "work")
    return out


@app.post("/api/models/{model_id:path}/build")
async def build_model(model_id: str, detach: bool = False):
    """Build a model. The build is a process of its own (backend/buildjobs.py),
    so a reload of the API neither stops it nor loses its result. The
    request waits for it and answers what the build did; `detach=1`
    answers at once (202) with the job - follow it at GET /api/build-jobs/{job}."""
    from fastapi.responses import JSONResponse

    d = db()
    if not await d.models.find_one({"_id": model_id}, {"_id": 1}):
        raise HTTPException(404, repr(model_id))
    job = await _start_build(d, model_id, by="request")
    if detach:
        return JSONResponse(jsonable_encoder(buildjobs.view(job)), status_code=202)
    done = await buildjobs.wait(d.raw, job["_id"])
    if done.get("status") == "done":
        return buildjobs.result(done)
    raise HTTPException(done.get("code") or 500, done.get("detail"))


async def _start_build(d, model_id: str, by: str, link_token: str | None = None) -> dict:
    # The version this build is of, read before it starts: a save while it
    # runs makes another version, and the outcome is this one's (the runner
    # records it: build_outcome).
    version = await store.current_version(d, model_id)
    try:
        return await buildjobs.start(d.raw, model_id, workspace=scope.current(), by=by,
                                     link_token=link_token, version=version,
                                     actor=actors.CURRENT.get(), role=access.ROLE.get())
    except buildjobs.Busy as exc:
        if by == "link":
            raise
        raise HTTPException(409, {"detail": str(exc) + " - wait for it, or follow it with "
                                  f"GET /api/build-jobs/{exc.job['_id']}",
                                  "job": exc.job["_id"]})
    except OSError as exc:
        raise HTTPException(500, f"{model_id}: the build could not be started: {exc}")


async def build_outcome(d, job: dict, error: str | None) -> None:
    """What the runner records once a build has ended (backend/buildjobs.py).
    A saved version that does not build is kept marked failed: pins and
    "latest" skip it, the history says so (store.version_built). A link
    rebuild that breaks is not that version's own save breaking it."""
    if error is not None and job.get("by") == "link":
        return
    await _version_outcome(d, job.get("model"), job.get("version"), error)


@app.get("/api/build-jobs")
async def build_jobs_list(model: str, limit: int = 10):
    """A model's latest builds, newest first, without their results."""
    return await buildjobs.latest(db().raw, model, scope.current(), max(1, min(limit, 50)))


@app.get("/api/build-jobs/{job}")
async def build_job(job: str):
    """One build: running, done (with what the build answered), failed (with
    the status and detail the request would have answered) or lost."""
    doc = await buildjobs.get(db().raw, job)
    if not doc or doc.get("workspace") != scope.current():
        raise HTTPException(404, f"no build job {job}")
    return buildjobs.view(doc)


async def _version_outcome(d, model_id: str, version: int | None, error: str | None) -> None:
    try:
        await store.version_built(d, model_id, version, error)
    except Exception:                                # noqa: BLE001 - never fail a build over it
        LOG.exception("could not record how %s v%s built", model_id, version)


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
    room: str = Field(default="cad", pattern="^(cad|pcb|firmware)$")


class RunStart(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    revision: str | None = None
    model: str | None = None
    # Whose run: each room has its own, so agents in different rooms can
    # work at once without closing each other's.
    room: str = Field(default="cad", pattern="^(cad|pcb|firmware)$")
    # A note already running under another agent is refused (409) unless
    # this says it is being taken over on purpose; another note's run open
    # in the room is refused unless `force`. backend/runs.py.
    take_over: bool = False
    force: bool = False
    # The caller's Claude Code session, when it has one: the card's cost is
    # attributed by it (backend/usage.py).
    session: str | None = Field(default=None, max_length=100)


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

    if body.revision:
        from . import runs
        try:
            doc, what = await runs.start(
                db(), body.revision, body.title, body.room, actors.current(),
                session=body.session, model=body.model,
                take_over=body.take_over, force=body.force)
        except runs.Busy as exc:
            raise HTTPException(409, str(exc)) from exc
        if what == "taken-over":
            last = doc["taken_over"][-1]
            await actors.audit(db(), "take-over", f"runs/{body.revision}",
                               {"from": (last.get("from") or {}).get("name"),
                                "to": actors.current().get("name")})
        elif what == "started":
            try:
                await changes.started(db(), body.revision)  # the sources before the work
            except Exception as exc:
                LOG.warning("sources for %s not recorded: %s", body.revision, exc)
        return {**doc, "outcome": what}
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
        try:
            await changes.started(db(), body.revision)      # the sources before the work
        except Exception as exc:
            LOG.warning("sources for %s not recorded: %s", body.revision, exc)
    return doc


@app.post("/api/run/finish")
async def finish_run(status: str = "done", room: str = "cad"):
    from datetime import datetime, timezone

    patch = {"status": status, "percent": 100.0,
             "finished_at": datetime.now(timezone.utc).isoformat()}
    d = db()
    key = compute.run_key(room)
    cur = await d.runs.find_one({"_id": key}) or {}
    # A firmware note is done when the version holding the change has
    # built cleanly; its diff, build and picture go on the card here.
    if status == "done" and cur.get("revision") and cur.get("status") == "running":
        rdoc = await d.revisions.find_one({"_id": cur["revision"]}, {"kind": 1}) or {}
        if rdoc.get("kind") == fwnotes.KIND:
            try:
                await fwnotes.result(d, cur["revision"])
            except fwnotes.Refused as exc:
                raise HTTPException(409, f"not finished: {exc}") from exc
    await d.runs.update_one({"_id": key}, {"$set": patch}, upsert=True)
    rev = cur.get("revision")
    if rev:
        await d.runs.update_one({"_id": rev}, {"$set": patch}, upsert=False)
        try:
            await changes.finished(d, rev)                   # what the work changed
        except Exception as exc:
            LOG.warning("changes for %s not recorded: %s", rev, exc)
        # Freeze what the work cost. A failure here must not stop a run from
        # finishing, so it is logged and swallowed.
        try:
            await usage.store(d, rev, await d.runs.find_one({"_id": rev})
                              or {**cur, **patch})
        except Exception as exc:
            LOG.warning("analytics for %s skipped: %s", rev, exc)
    return await d.runs.find_one({"_id": key})


@app.get("/api/revisions/{rid}/changes")
async def revision_changes(rid: str):
    """What the work on a note changed: each file before and after (kept
    when the agent started and finished), and whether there are pictures."""
    got = await changes.detail(db(), rid)
    if got is None:
        raise HTTPException(404, rid)
    return got


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
    # What was on screen when the note was written: which parts were shown
    # and, from format 2 (v: 2), the clipping planes, the viewer tab, the
    # render, zebra and studio settings, the camera type and the canvas size
    # (frontend api.ts NoteView). Kept as the page sends it: the page puts it
    # back and tools/render.py checks it went in (view_hash). The camera
    # alone is only where it was seen from.
    view: dict | None = None
    camera: dict | None = None
    part: str | None = None
    model: str | None = None
    # "pcb" when the note is about a board. A board is not a model - it has
    # no camera, nothing to freeze, and `build` does not take it - so the
    # agent and the page both need to know which one they are holding.
    # "firmware": `model` is then a firmware's id (backend/fwnotes.py).
    kind: str | None = Field(default=None, pattern="^(cad|pcb|firmware)$")
    # What a firmware note is about: a pin or a net of the MCU, or lines
    # of a file - {kind: pin|net|code, pin, net, gpio, file, lines}.
    # Checked against the firmware when the note is filed.
    anchor: dict | None = None


def _out(d: dict, run: dict | None = None) -> dict:
    return {"id": d["_id"], "created_at": d["created_at"], "comment": d["comment"],
            "run": run,
            "camera": d.get("camera"), "part": d.get("part"), "model": d.get("model"),
            "kind": d.get("kind") or "cad",
            "view": d.get("view"),
            "status": d.get("status", "draft"), "queued_at": d.get("queued_at"),
            "edited_at": d.get("edited_at"), "archived": bool(d.get("archived")),
            "image_bytes": (d.get("image") or {}).get("bytes", 0),
            # The same view once the work is done, so the card can show
            # before and after side by side.
            "image_after_bytes": (d.get("image_after") or {}).get("bytes", 0),
            "summary": d.get("summary"),
            "comment_original": d.get("comment_original"),
            "summary_manual": bool(d.get("summary_manual")),
            # Who wrote it, and who last changed its status; older notes
            # predate attribution and say nothing.
            "created_by": d.get("created_by"), "status_by": d.get("status_by"),
            # Filed from a ```task block in a chat (backend/tasks.py): which
            # thread or conversation, and which line - the card links back.
            "from_chat": d.get("from_chat"),
            # What the work changed, file by file (backend/changes.py); null
            # for notes finished before that was kept.
            "changes": [{k: c.get(k) for k in ("kind", "id", "added", "removed")} for c in d["changes"]]
                       if d.get("changes") is not None else None,
            # A firmware note: what it is anchored to, and once finished the
            # diff, the build and its figures (backend/fwnotes.py).
            "anchor": d.get("anchor"), "fw_result": d.get("fw_result")}


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
            db(), _id=f"or:{uuid.uuid4().hex[:16]}", provider=used.get("provider") or "openrouter",
            surface=surface, kind=kind, model=used.get("model") or summarise.MODEL,
            input=used.get("prompt_tokens") or 0,
            output=used.get("completion_tokens") or 0,
            cache_read=0, cache_write=0, thinking=0,
            cost_usd=used.get("cost"), revision=rid,
            cost_basis="billed" if used.get("cost") is not None else "unpriced")
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
    anchor = None
    if body.kind == fwnotes.KIND:
        if not body.model:
            raise HTTPException(422, "a firmware note names its firmware (model)")
        try:
            anchor = await fwnotes.check_anchor(d, body.model, body.anchor)
        except fwnotes.Refused as exc:
            raise HTTPException(404 if str(exc).startswith("no firmware") else 422, str(exc)) from exc
    rid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    doc = {
        "_id": rid,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": actors.current(),
        "comment": body.comment, "camera": body.camera,
        "part": body.part, "model": body.model, "kind": body.kind or "cad",
        "status": "draft", "queued_at": None,
        "image": image,
        "view": body.view,
        **({"anchor": anchor} if body.kind == fwnotes.KIND else {}),
    }
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
    runs = await _runs_of([d["_id"] for d in rows if d.get("status") == "queued"])
    return [_out(d, runs.get(d["_id"])) for d in rows]


async def _runs_of(ids: list[str]) -> dict:
    """How the last run of each queued note ended: a note whose run is done
    but that nobody marked applied waits for review, it is not in the queue."""
    if not ids:
        return {}
    return {r["_id"]: {"status": r.get("status"), "finished_at": r.get("finished_at")}
            async for r in db().runs.find({"_id": {"$in": ids}}, {"status": 1, "finished_at": 1})}


@app.get("/api/queue")
async def queue():
    """What models read: queued revisions only, archived ones excluded."""
    return await list_revisions(status="queued", archived=False)


@app.get("/api/revisions/{rid}")
async def one_revision(rid: str):
    doc = await db().revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    runs = await _runs_of([rid] if doc.get("status") == "queued" else [])
    return _out(doc, runs.get(rid))


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


@app.post("/api/revisions/{rid}/firmware-result")
async def firmware_result(rid: str):
    """Finish a firmware note's work on its card: refused (409, why) until
    the version with the change has built cleanly; then the diff, the
    build's figures and a picture of the main hunk are kept on it."""
    try:
        return await fwnotes.result(db(), rid)
    except KeyError as exc:
        raise HTTPException(404, rid) from exc
    except fwnotes.Refused as exc:
        raise HTTPException(409, str(exc)) from exc


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
    patch["edited_by"] = actors.current()

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
DEFAULT_SETTINGS = store.DEFAULT_SETTINGS


@app.get("/api/settings")
async def get_settings():
    doc = await db().settings.find_one({"_id": scope.key(store.SETTINGS_ID)}) or {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in doc.items() if k != "_id"}}


@app.put("/api/settings")
async def put_settings(auto_archive: bool | None = None,
                       auto_translate: bool | None = None):
    patch = {k: v for k, v in (("auto_archive", auto_archive),
                               ("auto_translate", auto_translate))
             if v is not None}
    if patch:
        await db().settings.update_one({"_id": scope.key(store.SETTINGS_ID)}, {"$set": patch},
                                       upsert=True)
    return await get_settings()


# ---------------- boards ----------------
class BoardIn(BaseModel):
    source: str = Field(min_length=1, max_length=200_000)
    title: str | None = None
    entry: str | None = None
    if_match: str | None = Field(default=None, max_length=64)      # as for a model


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
    return {**doc, "rev": _rev(doc.get("source"))}


@app.put("/api/boards/{bid}")
async def save_board(bid: str, body: BoardIn):
    """Write the source. Building is a separate step, as for a model."""
    if body.if_match:
        cur = await db()[ato.BOARDS].find_one({"_id": bid}, {"source": 1})
        _stale_write((cur or {}).get("source"), body.if_match)
    patch = {"source": body.source, "saved_at": store.now(), "stale": True}
    if body.title:
        patch["title"] = body.title
    if body.entry:
        patch["entry"] = body.entry
    got = await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": patch}, upsert=True)
    if getattr(got, "upserted_id", None) is not None:
        await links.reindex(db())       # a new name a model can import
    if body.if_match:
        await actors.audit(db(), "edit", f"board {bid}", {"how": "code view"})
    return {"id": bid, "saved": True, "rev": _rev(body.source)}


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
async def layout_board(bid: str, detach: bool = False):
    """Place the built netlist and draw it. KiCad runs in a container, the
    work in a process of its own (backend/jobs.py): `detach=1` answers at
    once with the job to follow, without it the request waits for it."""
    return await _as_job("layout", bid, {}, detach)


async def _layout_board(bid: str):
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
    comp = out.get("component")
    if comp:
        # The board as a component: a new version only when the 3D changed,
        # and then every model that imports it is rebuilt (backend/links.py).
        await say(f"{bid}: 3D component v{comp.get('version')}"
                  + (" - new, the models that use it rebuild" if comp.get("changed") else " - unchanged"),
                  "done", room="pcb")
        if comp.get("queued"):
            await _say_propagation(bid, comp, room="cad")
    return out


# A board's drawings are made for a dark board. On a light theme the page
# asks for them with ?light=1 and gets the same drawing with the inks that
# vanish on white darkened - silkscreen, pad and hole white, the edge -
# as KiCad's own light theme draws them. Copper keeps its colour.
LIGHT_INKS = {
    # the layout: F.Cu, B.Cu, pads and holes, silkscreen, edge cuts, the board
    "C83434": "B42A2A", "D864FF": "8E3FD6", "FFFFFF": "3A4048", "F2EDA1": "1F2328",
    "D0D2CD": "5B6068", "000000": "F6F7F9",
    # the schematic: outlines, pin numbers, names, labels, bodies, wires, the page
    "D66060": "A83232", "AA7878": "7A4A4A", "5CC8C8": "13737A", "E6E6E6": "2A2F36",
    "261A1A": "FFF8EC", "6E6EF0": "3434B8", "48C774": "1E7E44", "111111": "FFFFFF",
}


def _light(svg: bytes) -> bytes:
    import re
    text = svg.decode("utf-8", errors="replace")
    ink = lambda m: m.group(1) + "#" + LIGHT_INKS.get(m.group(2).upper(), m.group(2))  # noqa: E731
    text = re.sub(r'((?:fill|stroke)(?::|=")\s*)#([0-9a-fA-F]{6})', ink, text)
    return text.encode()


@app.get("/api/boards/{bid}/layout.svg")
async def board_layout(bid: str, light: bool = False):
    try:
        raw = await store.get_artifact(db(), bid, "layout", ato.BOARDS)
    except KeyError:
        raise HTTPException(404, "no layout yet")
    if light:
        raw = _light(raw)
    return Response(raw, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/boards/{bid}/{which}.svg")
async def board_drawing(bid: str, which: str, light: bool = False):
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
    if light:
        raw = _light(raw)
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
    if kind in ("step", "stl"):
        # The board as a component (backend/board3d.py), to take away.
        try:
            raw = await store.get_artifact(db(), bid, kind, ato.BOARDS)
        except KeyError:
            raise HTTPException(404, f"no {kind} yet - lay the board out first")
        return Response(raw, media_type="model/step" if kind == "step" else "model/stl", headers={
            "Content-Disposition": f'attachment; filename="{bid}.{kind}"'})
    if kind == "kicad_sch":
        # Drawn in sheets: the root alone opens empty in KiCad, so all of
        # them, zipped, side by side.
        try:
            files = json.loads(await store.get_artifact(db(), bid, "schematic_files", ato.BOARDS))
        except KeyError:
            files = {}
        if len(files) > 1:
            import io
            import zipfile
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for name, text in files.items():
                    z.writestr(f"{bid}-schematic/{name}", text)
            return Response(buf.getvalue(), media_type="application/zip", headers={
                "Content-Disposition": f'attachment; filename="{bid}-schematic.zip"'})
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


@app.get("/api/boards/{bid}/sheets/{key}.svg")
async def board_sheet(bid: str, key: str, light: bool = False):
    """One sheet of the board's schematic, as KiCad drew it: an MCU's
    sheet, Power, Connectors & peripherals (backend/sheets.py). The root -
    the boxes of the sheets - is /schematic.svg."""
    if not re.match(r"^[a-z0-9-]{1,80}$", key):
        raise HTTPException(404, key)
    try:
        raw = await store.get_artifact(db(), bid, schematic.sheet_svg_label(key), ato.BOARDS)
    except KeyError:
        raise HTTPException(404, f"no sheet {key}")
    if light:
        raw = _light(raw)
    return Response(raw, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/boards/{bid}/mcus")
async def board_mcus(bid: str):
    """The board's programmable chips, as its schematic is drawn: each MCU,
    the sheet it is on (and that sheet's drawing), and which net every pin
    is on with the parts that share it - what a Firmware room starts from.
    Empty when the board has none, or its schematic is not drawn yet."""
    doc = await db()[ato.BOARDS].find_one({"_id": bid}, {"schematic": 1})
    if doc is None:
        raise HTTPException(404, bid)
    return schematic.mcus_of(doc)


@app.post("/api/boards/{bid}/schematic")
async def draw_schematic(bid: str, detach: bool = False):
    """Write the schematic from the last build, draw it, and run ERC.

    `detach=1`: as a job (backend/jobs.py), answered at once - it shows in
    Working now; the schematic alone, nothing else of the board is touched."""
    if detach:
        return await _as_job("schematic", bid, {}, True)
    return await _draw_schematic(bid)


async def _draw_schematic(bid: str):
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
    sheets = out.get("sheets") or []
    split = (f" on {len(sheets)} sheets ({', '.join(s['name'] for s in sheets)})" if sheets else "")
    await say(f"{bid}: schematic - {out['parts']} parts{split}, {out['labels']} pins joined, "
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


class EngineIn(BaseModel):
    engine: str


@app.put("/api/boards/{bid}/rules/engine")
async def save_board_engine(bid: str, body: EngineIn):
    """Which router the next run uses - the switch beside Build. Only the
    engine changes: the rest of the rules stay as they are, checked or not,
    for the rules tab to answer for."""
    if body.engine not in rules.ENGINES:
        raise HTTPException(400, f"engine: one of {', '.join(rules.ENGINES)}")
    doc = await db()[ato.BOARDS].find_one({"_id": bid}, {"rules": 1})
    if doc is None:
        raise HTTPException(404, bid)
    if doc.get("rules"):
        await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": {"rules.route.engine": body.engine}})
    else:
        # No rules kept yet: the ones the room shows, with the engine.
        merged = rules.merge(None, await _board_nets(bid) or [])
        merged["route"]["engine"] = body.engine
        await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": {"rules": merged}})
    await say(f"{bid}: routes with {body.engine} from the next run", "info", room="pcb")
    return {"engine": body.engine}


@app.post("/api/boards/{bid}/run")
async def run_board(bid: str, detach: bool = False):
    """The whole of it, in order: build the source, draw the schematic,
    place, route, pour, check. What a change to a board goes through,
    every time - so nothing downstream is ever older than the source.

    Minutes of KiCad and Freerouting, so it runs as a job of its own
    (backend/jobs.py) that a reload of the API does not stop or wait for.
    `detach=1`: answered at once (202) with the job; follow it at
    GET /api/boards/{bid}/jobs/{job}. Without it the request waits."""
    return await _as_job("run", bid, {}, detach)


async def _run_board(bid: str):
    import time as _time

    t0 = _time.monotonic()
    out = {"board": bid}
    await say(f"{bid}: running the pipeline - build, schematic, place, route, DRC",
              "work", room="pcb")
    out["build"] = await build_board(bid)
    # A board converted from an import: is the build still that circuit?
    eq = await convert.check(db(), bid)
    if eq is not None:
        out["equivalence"] = eq
        await say(f"{bid}: against the imported netlist - "
                  + ("the same circuit" if eq["equivalent"] else
                     f"{eq['nets']['only_imported']} imported nets differ"),
                  "info" if eq["equivalent"] else "warn", room="pcb")
    out["schematic"] = await _draw_schematic(bid)
    out["layout"] = await _layout_board(bid)
    took = round(_time.monotonic() - t0, 1)
    drc = (out["layout"] or {}).get("drc") or {}
    route = (out["layout"] or {}).get("route") or {}
    await say(f"{bid}: pipeline done in {took} s - unrouted {route.get('unrouted', '?')}, "
              f"DRC {drc.get('error_count', '?')} errors, "
              f"ERC {out['schematic'].get('erc', {}).get('error_count', '?')} errors",
              "done", room="pcb")
    out["seconds"] = took
    try:
        await insights.record_board_run(db(), bid, out)
    except Exception:
        LOG.exception("could not record the board run")
    return out


class ConvertIn(BaseModel):
    bom: str | None = Field(default=None, max_length=2_000_000)     # a BOM CSV, as text
    picks: dict[str, str | dict] | None = None                    # ref -> C-number
    force: bool = False           # write over hand edits (kept as a backup first)
    keep_edits: bool = False      # merge hand edits onto the new source


@app.post("/api/boards/{bid}/convert")
async def convert_board(bid: str, body: ConvertIn, detach: bool = False,
                        force: bool = False, keep_edits: bool = False):
    """Write an imported board as atopile source, build it, and check the
    build against the imported netlist (backend/convert.py). Run again
    with a BOM and its part numbers replace the guesses. A job, as a run
    is (`detach=1` answers at once).

    A source edited by hand since the last convert is not written over:
    409, naming the changed lines. `force=1` writes over it (the edited
    source kept as a backup revision first); `keep_edits=1` merges the
    edits onto the new source, 409 where they conflict. Either in the
    query or the body."""
    body.force = body.force or force
    body.keep_edits = body.keep_edits or keep_edits
    return await _as_job("convert", bid, body.model_dump(), detach)


async def _convert_board(bid: str, body: ConvertIn):
    async def tell(text: str, level: str = "info") -> None:
        await say(text, level, room="pcb")
    try:
        out = await convert.run(db(), bid, body.bom.encode() if body.bom else None,
                                body.picks, tell, force=body.force, keep_edits=body.keep_edits)
    except KeyError:
        raise HTTPException(404, bid)
    except convert.Edited as exc:
        await say(str(exc).splitlines()[0], "warn", room="pcb")
        raise HTTPException(409, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except lcsc.Refused as exc:
        await say(f"{bid}: LCSC is cooling off - {exc}", "warn", room="pcb")
        raise HTTPException(503, f"LCSC is cooling off, run it again later: {exc}")
    await actors.audit(db(), "convert", f"board {bid}", {"status": out.get("status")})
    return out


# ---------------- the long steps, as jobs (backend/jobs.py) ----------------
async def job_step(kind: str, bid: str, body: dict):
    """The work of one job, in the job's own process."""
    if kind == "run":
        return await _run_board(bid)
    if kind == "layout":
        return await _layout_board(bid)
    if kind == "convert":
        return await _convert_board(bid, ConvertIn(**body))
    if kind == "schematic":
        return await _draw_schematic(bid)
    raise HTTPException(400, f"no such job: {kind}")


async def _as_job(kind: str, bid: str, body: dict, detach: bool):
    """Start `kind` on a board as a job; answer with the job (detached) or,
    once it is done, with what the step itself would have answered."""
    from fastapi.responses import JSONResponse

    if not await db()[ato.BOARDS].find_one({"_id": bid}, {"_id": 1}):
        raise HTTPException(404, bid)
    try:
        job = await jobs.start(db().raw, kind, bid, body, workspace=scope.current(),
                               actor=actors.CURRENT.get(), role=access.ROLE.get(),
                               who=lcsc.WHO.get())
    except jobs.Busy as exc:
        raise HTTPException(409, {"detail": str(exc) + " - wait for it, or follow it with "
                                  f"GET /api/boards/{bid}/jobs/{exc.job['_id']}",
                                  "job": exc.job["_id"]})
    except OSError as exc:
        raise HTTPException(500, f"{bid}: the {kind} could not be started: {exc}")
    if detach:
        return JSONResponse(jsonable_encoder(jobs.view(job)), status_code=202)
    done = await jobs.wait(db().raw, job["_id"])
    if done.get("status") == "done":
        return jobs.result(done)
    raise HTTPException(done.get("code") or 500, done.get("detail"))


async def _own_job(bid: str, job: str) -> dict:
    doc = await jobs.get(db().raw, job)
    if not doc or doc.get("board") != bid or doc.get("workspace") != scope.current():
        raise HTTPException(404, f"no job {job} on {bid}")
    return doc


@app.get("/api/boards/{bid}/jobs")
async def board_jobs(bid: str, limit: int = 10):
    """The board's latest jobs, newest first, without their results."""
    return await jobs.latest(db().raw, bid, scope.current(), max(1, min(limit, 50)))


@app.get("/api/boards/{bid}/jobs/{job}")
async def board_job(bid: str, job: str):
    """One job: running, done (with what the step answered), failed (with
    the status and detail it would have answered) or lost."""
    return jobs.view(await _own_job(bid, job))


class HoldIn(BaseModel):
    placement: bool


@app.put("/api/boards/{bid}/hold")
async def hold_board(bid: str, body: HoldIn):
    """Keep a converted board's layout (the default) or let the placer
    lay it out afresh on the next run."""
    got = await db()[ato.BOARDS].update_one(
        {"_id": bid, "hold": {"$ne": None}}, {"$set": {"hold.placement": body.placement}})
    if not got.matched_count:
        raise HTTPException(404, f"{bid} has no layout to hold")
    await say(f"{bid}: " + ("placement held as imported" if body.placement
                            else "placement let go - the next run lays the board out afresh"),
              "info", room="pcb")
    return {"board": bid, "placement": body.placement}


class ChangesIn(BaseModel):
    nets: list[str] = []
    parts: list[str] = []
    why: str = ""
    clear: bool = False


@app.put("/api/boards/{bid}/changes")
async def board_changes(bid: str, body: ChangesIn):
    """Say that a converted board differs from its import on purpose: these
    nets (by name, in either netlist) and parts were changed by a note, for
    this reason. The comparison still lists every difference; these are
    marked as meant, so Board health does not call the board broken for
    them. `clear`: forget every change said so far (before adding these)."""
    nets = [n.strip() for n in body.nets if n.strip()]
    parts = [p.strip() for p in body.parts if p.strip()]
    if not body.clear and not (nets or parts):
        raise HTTPException(400, "name the nets or parts that were changed")
    if (nets or parts) and not body.why.strip():
        raise HTTPException(400, "say why (why): it is what the person reads")
    doc = await db()[ato.BOARDS].find_one({"_id": bid}, {"convert": 1})
    if not (doc or {}).get("convert"):
        raise HTTPException(404, f"{bid} was not converted from an import")
    changes = [] if body.clear else list(doc["convert"].get("changes") or [])
    if nets or parts:
        changes.append({"nets": nets, "parts": parts, "why": body.why.strip()[:500],
                        "by": actors.current(), "at": store.now()})
    await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": {"convert.changes": changes}})
    eq = await convert.check(db(), bid)
    await say(f"{bid}: " + (f"changed on purpose - {', '.join(nets + parts)}: {body.why.strip()[:160]}"
                            if nets or parts else "changes on purpose forgotten"),
              "info", room="pcb")
    return {"board": bid, "changes": changes, "equivalence": eq}


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
async def _who_acts(request, call_next):
    """Who this request is from: the person, or the agent named in the
    X-Redline-Actor header. Every delete and change of state goes into the
    audit trail with it, whatever route it came through."""
    who = actors.from_header(request.headers.get(actors.HEADER))
    ws = scope.DEFAULT
    role: str | None = "owner"          # local mode: the person at the machine
    # An agent's token, whatever the mode: it names the agent and its
    # workspace. A token that is wrong or revoked is refused outright.
    token = auth.bearer(request.headers)
    if token and request.url.path.startswith("/api/"):
        from fastapi.responses import JSONResponse
        agent = await auth.token_agent(db(), token)
        if not agent:
            return JSONResponse({"detail": "that agent token is unknown or revoked"}, status_code=401)
        who, ws, role = agent["actor"], agent["workspace"], agent["role"]
        # One token can serve several agents on one machine: each still says
        # who it is (REDLINE_AGENT), within what the token allows.
        named = actors.from_header(request.headers.get(actors.HEADER))
        if named["type"] == "agent" and named["name"] != "agent":
            who = {**who, "id": named["id"], "name": named["name"]}
    # Signed in, when sign-in is on: the session says who, and in which
    # workspace. Without one, only the few routes that sign in answer.
    elif auth.enabled() and auth.needs_session(request.method, request.url.path):
        from fastapi.responses import JSONResponse
        got = await auth.session_user(db(), request.cookies.get(auth.COOKIE))
        if not got:
            return JSONResponse({"detail": "sign in first"}, status_code=401)
        if not auth.csrf_ok(request.method, request.headers):
            return JSONResponse({"detail": "that change did not come from the app"}, status_code=403)
        who, ws, role = got["user"], got["workspace"], got["role"]
        # A password set by an admin must be changed before anything else
        # (backend/admin.py): until then only that, and signing out, answer.
        if got.get("must_change_password") and not got.get("page") \
                and request.url.path not in auth.BEFORE_NEW_PASSWORD:
            return JSONResponse({"detail": "choose a new password first", "refused": "password",
                                 "role": role}, status_code=403)
        # A headless browser's page session reads, and nothing else.
        if got.get("page") and not access.page_allowed(request.method, request.url.path,
                                                       dict(request.query_params)):
            return JSONResponse({"detail": "a page session only looks", "refused": "page",
                                 "role": role}, status_code=403)
    elif auth.enabled():
        role = None                     # signed out: only the open routes answer
    # What the request is, and whether the role may (backend/access.py).
    if request.url.path.startswith("/api/"):
        act = access.action(request.method, request.url.path, dict(request.query_params))
        if token and who.get("token"):
            # Counted in memory, written out a few seconds later (auth.py).
            auth.count_usage(db(), who["token"], ws, request.method, act)
        if not access.allowed(role, act):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": access.refusal(role or "nobody", act), "refused": act,
                                 "role": role}, status_code=403)
    who_token = actors.CURRENT.set(who)
    ws_token = scope.WORKSPACE.set(ws)
    role_token = access.ROLE.set(role)
    try:
        response = await call_next(request)
        kind = actors.audited(request.method, request.url.path)
        if kind and response.status_code < 400:
            await actors.audit(db(), kind, request.url.path,
                               {"method": request.method,
                                **({"query": str(request.url.query)} if request.url.query else {})},
                               actor=who)
        return response
    finally:
        actors.CURRENT.reset(who_token)
        scope.WORKSPACE.reset(ws_token)
        access.ROLE.reset(role_token)


@app.middleware("http")
async def _timed(request, call_next):
    """How long each API request took, by route, for the Analytics room."""
    import time as _t
    t0 = _t.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        if request.url.path.startswith("/api/"):
            route = getattr(request.scope.get("route"), "path", None) or request.url.path
            insights.record_request(request.method, route, status,
                                    (_t.perf_counter() - t0) * 1000)


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


# ---------------- signing in ----------------
class SetupIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    name: str = Field(default="", max_length=80)
    password: str = Field(min_length=1, max_length=200)


class LoginIn(BaseModel):
    email: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=200)
    # "Remember me": keep the account on this browser (backend/accounts.py)
    remember: bool = False


def _set_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=request.url.scheme == "https", path="/")


@app.get("/api/auth/state")
async def auth_state(request: Request):
    """Whether sign-in is on, whether anyone has an account yet, and who
    this browser is signed in as."""
    roles = {"roles": list(access.ROLES), "about": access.ABOUT, "actions": access.ACTIONS,
             "token_roles": list(access.TOKEN_ROLES)}
    if not auth.enabled():
        return {"mode": "off", "user": actors.local_user(),
                "role": "owner", "can": access.can("owner"), **roles}
    got = await auth.session_user(db(), request.cookies.get(auth.COOKIE))
    page = bool(got and got.get("page"))
    return {"mode": "on", "needs_setup": not await auth.any_user(db()),
            "user": got["user"] if got else None,
            "role": got["role"] if got else None, "can": access.can(got["role"] if got else None),
            "must_change_password": bool(got and got.get("must_change_password") and not page), **roles}


@app.post("/api/auth/setup")
async def auth_setup(body: SetupIn, request: Request, response: Response):
    """The first account, while there is none; it is the owner."""
    if not auth.enabled():
        raise HTTPException(400, "sign-in is off (REDLINE_REQUIRE_SIGNIN)")
    try:
        user = await auth.make_first_user(db(), body.email, body.name, body.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(409, str(exc)) from exc
    token = await auth.create_session(db(), user, scope.DEFAULT, request.headers.get("user-agent", ""),
                                      request.client.host if request.client else "")
    _set_cookie(response, request, token)
    await actors.audit(db(), "account", "setup", {"email": user["email"]},
                       actor={"type": "user", "id": user["_id"], "name": user["name"]})
    return {"user": {"id": user["_id"], "name": user["name"], "email": user["email"]}}


@app.post("/api/auth/login")
async def auth_login(body: LoginIn, request: Request, response: Response):
    if not auth.enabled():
        raise HTTPException(400, "sign-in is off (REDLINE_REQUIRE_SIGNIN)")
    email = body.email.strip().lower()
    if auth.locked_out(email):
        raise HTTPException(429, "too many tries - wait a quarter of an hour")
    got = await auth.check_login(db(), email, body.password)
    if not got:
        auth.failed(email)
        raise HTTPException(401, "that email and password do not match")
    auth.cleared(email)
    user, ws = got
    token = await auth.create_session(db(), user, ws, request.headers.get("user-agent", ""),
                                      request.client.host if request.client else "")
    _set_cookie(response, request, token)
    await actors.audit(db(), "sign-in", email, None,
                       actor={"type": "user", "id": user["_id"], "name": user.get("name") or email})
    remembered = await accounts_api.remember_here(request, response, user) if body.remember else False
    return {"user": {"id": user["_id"], "name": user.get("name"), "email": user["email"]},
            "remembered": remembered}


@app.post("/api/auth/page-session")
async def auth_page_session(request: Request):
    """Trade an agent's token for a page session: a cookie a headless
    browser (tools/render.py) can show the app with. Read-only, minutes
    long, in the token's workspace (backend/auth.py, page sessions).

    Only a bearer token buys one - not a person's cookie, and not another
    page session. The value comes back in the body, once, for the caller to
    hand its own browser; it is not set as a cookie on this response."""
    if not auth.enabled():
        raise HTTPException(400, "sign-in is off (REDLINE_REQUIRE_SIGNIN): the page needs no session")
    token = auth.bearer(request.headers)
    agent = await auth.token_agent(db(), token) if token else None
    if not agent:
        raise HTTPException(401, "a page session is traded for an agent token (Authorization: Bearer)")
    value, expires = await auth.create_page_session(
        db(), agent["workspace"], agent["actor"], token_id=agent["actor"]["token"],
        room=agent.get("room"))
    from fastapi.responses import JSONResponse
    await actors.audit(db(), "page-session", agent["actor"]["name"],
                       {"expires": expires.isoformat()}, actor=agent["actor"])
    return JSONResponse(
        {"cookie": auth.COOKIE, "value": value, "expires": expires.timestamp(),
         "role": auth.PAGE_ROLE, "workspace": agent["workspace"]},
        headers={"Cache-Control": "no-store"})


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    await auth.end_session(db(), request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE, path="/")
    return {"signed_out": True}


class NewPasswordIn(BaseModel):
    new: str = Field(min_length=1, max_length=400)


@app.post("/api/auth/new-password")
async def auth_new_password(body: NewPasswordIn, request: Request):
    """The password an admin set, replaced by the person's own at their
    first sign-in. Only while the account is asked to; every other session
    of it ends, this one stays."""
    who = actors.current()
    if not auth.enabled() or who.get("type") != "user" or who.get("page"):
        raise HTTPException(400, "only a signed-in person sets a new password here")
    try:
        ended = await auth.set_own_new_password(db().raw, who["id"], body.new,
                                                request.cookies.get(auth.COOKIE),
                                                request.cookies.get(auth.DEVICE_COOKIE))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(409, str(exc)) from exc
    await actors.audit(db(), "password", who.get("name") or who["id"],
                       {"how": "first sign-in", "signed_out": ended})
    return {"changed": True, "signed_out": ended}


# ---------------- agent tokens ----------------
class TokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    room: str | None = Field(default=None, max_length=20)
    role: str = Field(default="editor", max_length=20)
    # None: for good; else 1..3650 days (the page offers 7, 30 and 90).
    expires_days: int | None = Field(default=None, ge=1, le=3650)


def _people_only():
    if actors.current()["type"] != "user":
        raise HTTPException(403, "only a person can hand out or take back agent tokens")


@app.post("/api/agent-tokens")
async def make_agent_token(body: TokenIn):
    """A token for one agent: shown once, kept only as a hash."""
    _people_only()
    try:
        if access.rank(body.role) < access.rank(access.current() or "viewer"):
            raise ValueError(f"an agent cannot be more than you ({access.current()})")
        token, doc = await auth.create_agent_token(db(), body.name, scope.current(), body.room,
                                                   actors.current(), body.role, body.expires_days)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await actors.audit(db(), "token", body.name, {"room": body.room, "role": body.role,
                                                  "expires_days": body.expires_days})
    return {"token": token, **{k: v for k, v in doc.items() if k != "workspace"}}


@app.get("/api/agent-tokens")
async def agent_tokens():
    _people_only()
    # The space is the account's own: not something to show.
    return [{k: v for k, v in t.items() if k != "workspace"}
            for t in await auth.list_agent_tokens(db(), scope.current())]


def _day_keys(days: int) -> list[str]:
    today = datetime.now(timezone.utc).date()
    return [(today - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]


async def _usage_rows(days: int, token_id: str | None = None) -> list[dict]:
    await auth.flush_usage(db())
    first = _day_keys(days)[0]
    q: dict = {"workspace": scope.current(), "day": {"$gte": first}}
    if token_id:
        q["token"] = token_id
    return [d async for d in db()[auth.TOKEN_USAGE].find(q, {"_id": 0})]


def _series(rows: list[dict], keys: list[str], field: str = "n") -> list[int]:
    by = {}
    for r in rows:
        by[r["day"]] = by.get(r["day"], 0) + int(r.get(field) or 0)
    return [by.get(k, 0) for k in keys]


def _t0(keys: list[str]) -> int:
    return int(datetime.fromisoformat(keys[0]).replace(tzinfo=timezone.utc).timestamp())


@app.get("/api/agent-tokens/usage")
async def agent_tokens_usage(days: int = 30):
    """Requests by one's agent tokens, per day: the totals, the
    chart and each token's figures. Counts only - no token, no hash."""
    _people_only()
    days = max(1, min(int(days), auth.USAGE_KEEP_DAYS))
    keys = _day_keys(days)
    rows = await _usage_rows(days)
    tokens = await auth.list_agent_tokens(db(), scope.current())
    names = {t["id"]: t["name"] for t in tokens}
    per: dict[str, dict] = {}
    for tid in {r["token"] for r in rows} | set(names):
        mine = [r for r in rows if r["token"] == tid]
        series = _series(mine, keys)
        per[tid] = {"series": series, "today": series[-1], "d7": sum(series[-7:]), "d30": sum(series[-30:]),
                    "read": sum(int(r.get("read") or 0) for r in mine),
                    "write": sum(int(r.get("write") or 0) for r in mine)}
    total = _series(rows, keys)
    # The chart: the busiest tokens each a series, the rest together.
    ranked = sorted((t for t in per if per[t]["d30"]), key=lambda t: -per[t]["d30"])
    shown, rest = ranked[:6], ranked[6:]
    series = [{"name": names.get(t, "deleted token"), "values": per[t]["series"]} for t in shown]
    if rest:
        series.append({"name": "others", "values": [sum(per[t]["series"][i] for t in rest) for i in range(days)]})
    top = ranked[0] if ranked else None
    return {"days": keys,
            "totals": {"active": sum(1 for t in tokens if t["status"] == "active"), "tokens": len(tokens),
                       "today": total[-1], "d7": sum(total[-7:]), "d30": sum(total[-30:]),
                       "read": sum(int(r.get("read") or 0) for r in rows),
                       "write": sum(int(r.get("write") or 0) for r in rows)},
            "top": {"id": top, "name": names.get(top, "deleted token"), "d30": per[top]["d30"]} if top else None,
            "chart": {"t0": _t0(keys), "step": 86400, "n": days, "series": series},
            "per_token": per}


@app.get("/api/agent-tokens/{token_id}/usage")
async def agent_token_usage(token_id: str, days: int = 30):
    """One token in detail: requests per day, reads against writes, by
    action, what the audit trail has under it, and the LLM calls made for
    it (since calls carry the token - older ones do not)."""
    _people_only()
    tok = next((t for t in await auth.list_agent_tokens(db(), scope.current()) if t["id"] == token_id), None)
    if not tok:
        raise HTTPException(404, token_id)
    days = max(1, min(int(days), auth.USAGE_KEEP_DAYS))
    keys = _day_keys(days)
    rows = await _usage_rows(days, token_id)
    acts: dict[str, int] = {}
    for r in rows:
        for k, v in (r.get("acts") or {}).items():
            acts[k] = acts.get(k, 0) + int(v or 0)
    trail = [d async for d in db()[actors.AUDIT].find({"actor.token": token_id}, {"_id": 0})
             .sort("at", -1).limit(5000)]
    by_action: dict[str, int] = {}
    for a in trail:
        by_action[a.get("action") or "?"] = by_action.get(a.get("action") or "?", 0) + 1
    recent = [{"at": a.get("at"), "action": a.get("action"), "target": a.get("target"),
               "who": (a.get("actor") or {}).get("name"),
               "method": (a.get("detail") or {}).get("method") if isinstance(a.get("detail"), dict) else None}
              for a in trail[:20]]
    llm = {"calls": 0, "tokens": 0, "cost_usd": 0.0, "by_model": {}}
    async for c in db()[usage.CALLS].find({"agent_token": token_id},
                                          {"model": 1, "input": 1, "output": 1, "cost_usd": 1}):
        llm["calls"] += 1
        llm["tokens"] += int(c.get("input") or 0) + int(c.get("output") or 0)
        llm["cost_usd"] += float(c.get("cost_usd") or 0)
        m = c.get("model") or "?"
        llm["by_model"][m] = llm["by_model"].get(m, 0) + 1
    series = _series(rows, keys)
    return {"id": token_id, "name": tok["name"], "days": keys,
            "series": series, "reads": _series(rows, keys, "read"), "writes": _series(rows, keys, "write"),
            "chart": {"t0": _t0(keys), "step": 86400, "n": days,
                      "series": [{"name": "reads", "values": _series(rows, keys, "read")},
                                 {"name": "writes", "values": _series(rows, keys, "write")}]},
            "totals": {"n": sum(series), "read": sum(int(r.get("read") or 0) for r in rows),
                       "write": sum(int(r.get("write") or 0) for r in rows)},
            "acts": acts, "audit": {"by_action": by_action, "total": len(trail), "recent": recent},
            "llm": llm}


@app.delete("/api/agent-tokens/{token_id}")
async def revoke_agent_token(token_id: str, purge: bool = False):
    """Take a token back - or, with ?purge=1, delete it for good (taken
    back first if it was still good). Without purge, as it always was."""
    _people_only()
    if purge:
        doc = await auth.delete_agent_token(db(), token_id, scope.current())
        if not doc:
            raise HTTPException(404, token_id)
        await actors.audit(db(), "token-delete", doc["name"],
                           {"id": token_id, "was": auth.token_status(doc)})
        return {"deleted": token_id}
    tok = next((t for t in await auth.list_agent_tokens(db(), scope.current()) if t["id"] == token_id), None)
    if not await auth.revoke_agent_token(db(), token_id, scope.current()):
        raise HTTPException(404, token_id)
    await actors.audit(db(), "token-revoke", (tok or {}).get("name") or token_id, {"id": token_id})
    return {"revoked": token_id}


# ---------------- password-reset links ----------------
def _refused(exc: Exception) -> HTTPException:
    code = {ValueError: 400, PermissionError: 403, LookupError: 404}
    return HTTPException(next((c for t, c in code.items() if isinstance(exc, t)), 400), str(exc))


@app.get("/api/reset/{key}")
async def reset_page(key: str):
    """Which account a password-reset link is for - open, the link is the key."""
    info = await auth.reset_info(db(), key) if auth.enabled() else None
    if not info:
        raise HTTPException(404, "this link has expired or was used - make a new one")
    return info


class ResetIn(BaseModel):
    password: str = Field(min_length=1, max_length=400)


@app.post("/api/reset/{key}")
async def reset_password(key: str, body: ResetIn, request: Request, response: Response):
    if not auth.enabled():
        raise HTTPException(400, "sign-in is off (REDLINE_REQUIRE_SIGNIN)")
    try:
        user, ws = await auth.use_reset(db(), key, body.password)
    except (ValueError, PermissionError, LookupError) as exc:
        raise _refused(exc) from exc
    token = await auth.create_session(db(), user, ws, request.headers.get("user-agent", ""),
                                      request.client.host if request.client else "")
    _set_cookie(response, request, token)
    who = {"type": "user", "id": user["_id"], "name": user.get("name") or user["email"]}
    await actors.audit(db(), "password", user["email"], {"how": "reset link"}, actor=who)
    return {"user": {"id": user["_id"], "name": user.get("name"), "email": user["email"]}}


@app.get("/api/audit")
async def audit_trail(limit: int = 200):
    """Who deleted, changed or reset what, newest first."""
    rows = [d async for d in db()[actors.AUDIT].find({}, {"_id": 0}).sort("at", -1).limit(min(limit, 1000))]
    for r in rows:
        r["at"] = r["at"].isoformat() if hasattr(r.get("at"), "isoformat") else r.get("at")
    return rows


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


def _pdf_name(lcsc_id: str, mpn: str | None) -> str:
    """'C111607 STM32F103C8T6.pdf': ASCII only, nothing a header could choke on."""
    clean = re.sub(r"[^A-Za-z0-9._+-]+", "_", mpn or "").strip("._")[:60]
    return f"{lcsc_id} {clean}.pdf" if clean else f"{lcsc_id}.pdf"


@app.get("/api/parts/{lcsc_id}/datasheet")
async def part_datasheet(lcsc_id: str, fresh: bool = False):
    """The part's datasheet as LCSC publishes it, opened in the browser.

    Only ever on request: the first time it is two asks of LCSC (its product
    detail, then the PDF), through the same turn-taking, journal and proxy
    as everything else, and kept beside the part's other files after that.
    404 when LCSC has none; 502 when LCSC's answer is not what it was."""
    try:
        got = await lcsc.datasheet(lcsc_id, fresh=fresh)
    except lcsc.Refused as exc:
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except lcsc.OddAnswer as exc:
        raise HTTPException(502, str(exc))
    except (OSError, TimeoutError) as exc:
        raise HTTPException(502, f"LCSC did not answer: {exc}")
    headers = {**_KEEP,
               "Content-Disposition": f'inline; filename="{_pdf_name(lcsc_id, got.get("mpn"))}"'}
    if got.get("url") and got["url"].isascii():
        headers["X-Datasheet-Source"] = got["url"]
    headers["X-Datasheet-Cached"] = "1" if got.get("cached") else "0"
    return Response(got["pdf"], media_type="application/pdf", headers=headers)


@app.post("/api/parts/{lcsc_id}")
async def add_part(lcsc_id: str, force: bool = False, refresh: bool = False):
    """Fetch one part and keep it: footprint, and the 3D model if there is
    one. This is what makes it available to a board.

    `refresh=1`: a part already kept, fetched again - EasyEDA's record
    asked afresh, the footprint and 3D model downloaded, the model seated
    on its pads - and said plainly when EasyEDA has no 3D model for it."""
    if refresh:
        try:
            got = await lcsc.refresh(db(), lcsc_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        except (RuntimeError, TimeoutError, OSError, LookupError) as exc:
            await say(f"{lcsc_id}: could not be refreshed - {exc}", "warn", room="pcb")
            raise HTTPException(502, str(exc))
        await say(f"{lcsc_id} fetched again from LCSC - {got.get('name')}: {got['said']}",
                  "done" if got.get("model_kind") else "warn", room="pcb")
        return {**got, "has_3d": bool(got.get("model_kind"))}
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


# ---- adding a part from the page, step by step ----
# The page types a C-number and watches: each step the fetch takes is
# written onto a job it polls (GET /api/parts-add/{job}). Kept in memory:
# a job is a minute's worth of progress lines, not a record.
_ADDS: dict[str, dict] = {}


class PartAddIn(BaseModel):
    lcsc: str


class PlaceIn(BaseModel):
    group: str | None = None
    branch: str | None = None


def _add_step(job: dict, step: str, text: str) -> None:
    import time as _t
    job["steps"].append({"step": step, "text": text, "at": _t.time()})
    job["step"], job["text"] = step, text


async def _place_row(lcsc_id: str) -> dict:
    doc = await db()[lcsc.PARTS].find_one({"_id": lcsc_id}, {"drawer_manual": 1, "drawer_llm": 1}) or {}
    group, branch, by = lcsc.place_of(doc, lcsc._drawer_facts(lcsc_id))
    return {"group": group, "branch": branch, "by": by,
            "model": (doc.get("drawer_llm") or {}).get("model") if by == "llm" else None}


async def _run_add(job: dict) -> None:
    lcsc_id = job["lcsc"]
    lcsc.PATIENT.set(True)                 # somebody is watching: wait for the budget, say so
    lcsc.PROGRESS.set(lambda step, text: _add_step(job, step, text))
    try:
        _add_step(job, "ask", "asking LCSC…")
        await lcsc._component(lcsc_id)
        doc = await lcsc.fetch(db(), lcsc_id)
        await lcsc.categorise(db(), lcsc_id)
        place = await _place_row(lcsc_id)
        job["place"] = place
        job["name"] = doc.get("name")
        job["has_3d"] = bool((doc.get("artifacts") or {}).get("model")
                             or doc.get("model_step") or doc.get("model_wrl"))
        _add_step(job, "done", f"placed in {place['group']} › {place['branch']}")
        job["state"] = "done"
        await say(f"{lcsc_id} fetched from LCSC - {doc.get('name')}"
                  + (" with a 3D model" if job["has_3d"] else ", footprint only")
                  + f", in {place['group']} › {place['branch']}", "done", room="pcb")
    except LookupError as exc:
        job["state"], job["error"] = "error", str(exc)
    except lcsc.Refused as exc:
        job["state"], job["error"] = "error", str(exc)
    except (ValueError, RuntimeError, TimeoutError, OSError) as exc:
        job["state"], job["error"] = "error", f"could not fetch it: {str(exc)[:300]}"
    if job["state"] == "error":
        _add_step(job, "error", job["error"])


@app.post("/api/parts-add")
async def part_add_start(body: PartAddIn):
    """Start keeping a part and hand back a job to watch. One already in
    the drawer is a job finished at once, `already` set."""
    import asyncio as _asyncio
    import uuid as _uuid
    lcsc_id = (body.lcsc or "").strip().upper()
    if not lcsc.looks_like_a_part(lcsc_id):
        raise HTTPException(400, "not an LCSC number - they look like C25744")
    job = {"id": _uuid.uuid4().hex[:12], "lcsc": lcsc_id, "state": "running", "steps": [],
           "step": "", "text": "", "error": None, "place": None, "already": False}
    got = await db()[lcsc.PARTS].find_one({"_id": lcsc_id}, {"name": 1})
    if got:
        job.update(state="done", already=True, name=got.get("name"), place=await _place_row(lcsc_id))
        _add_step(job, "done", f"already in the drawer - {job['place']['group']} › {job['place']['branch']}")
    else:
        _ADDS[job["id"]] = job
        job["task"] = _asyncio.create_task(_run_add(job))
    for old in list(_ADDS)[:-50]:
        _ADDS.pop(old, None)
    return {k: v for k, v in job.items() if k != "task"}


@app.get("/api/parts-add/{job_id}")
async def part_add_status(job_id: str):
    job = _ADDS.get(job_id)
    if not job:
        raise HTTPException(404, "no such add")
    return {k: v for k, v in job.items() if k != "task"}


@app.get("/api/parts-places")
async def part_places():
    """Every drawer and its branches, in the drawer's order."""
    out: dict[str, list[str]] = {}
    for g, b in sorted(lcsc.PLACES, key=lambda p: (lcsc.DRAWER_ORDER.index(p[0])
                                                    if p[0] in lcsc.DRAWER_ORDER else 99, p[1])):
        out.setdefault(g, []).append(b)
    return [{"group": g, "branches": bs} for g, bs in out.items()]


@app.put("/api/parts/{lcsc_id}/place")
async def part_place(lcsc_id: str, body: PlaceIn):
    """Put a part in a drawer by hand; it wins over the rules and the model.
    Both empty: back to where the rules (or the model) put it."""
    if not await db()[lcsc.PARTS].find_one({"_id": lcsc_id}, {"_id": 1}):
        raise HTTPException(404, lcsc_id)
    try:
        await lcsc.set_place(db(), lcsc_id, body.group or None, body.branch or None)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return await _place_row(lcsc_id)


@app.get("/api/boards/{bid}/analytics")
async def board_analytics(bid: str):
    """The board room's Analytics tab: the board, its bill and its library,
    from what is already known - nothing is asked of LCSC."""
    from . import board_stats
    try:
        return await board_stats.summary(db(), bid)
    except KeyError:
        raise HTTPException(404, bid)


@app.get("/api/boards/{bid}/bom/cost")
async def board_bom_cost(bid: str, refresh: int = 0, qty: int = 10, force: int = 0):
    """What the board's parts cost at LCSC's price breaks, for 1 to 1000
    boards and for `qty`, and which parts are out of stock or short.

    Reads only what is on disk. `refresh=1` also starts fetching the
    offers that are missing or older than a day (`force=1`: older than ten
    minutes), one polite ask per part in the background; the answer
    carries the run's progress under `refresh`, to be polled."""
    from . import bom_cost
    try:
        lines = await bom_cost.board_lines(db(), bid)
    except KeyError:
        raise HTTPException(404, bid)
    if not 1 <= qty <= 1_000_000:
        raise HTTPException(400, "qty: 1 to 1000000 boards")
    if refresh:
        parts = sorted({l["lcsc"] for l in lines if l["lcsc"]})
        bom_cost.start_refresh(bid, parts, force=bool(force))
    offers = {l["lcsc"]: bom_cost.cached_offer(l["lcsc"]) for l in lines if l["lcsc"]}
    out = bom_cost.cost(lines, offers, qty)
    out["board"] = bid
    out["refresh"] = bom_cost.public(bom_cost.job(bid))
    out["budget"] = {k: v for k, v in lcsc.state().items()
                     if k in ("used", "budget", "window_s", "refused_until")}
    return out


@app.get("/api/boards/{bid}/bom/alternatives")
async def board_bom_alternatives(bid: str, lcsc_id: str, qty: int = 10):
    """In-stock parts like one of the board's: one LCSC search, kept for
    a day. Suggestions - nothing on the board changes."""
    from . import bom_cost
    try:
        lines = await bom_cost.board_lines(db(), bid)
    except KeyError:
        raise HTTPException(404, bid)
    line = next((l for l in lines if l["lcsc"] == lcsc_id), None)
    if not line:
        raise HTTPException(404, f"{lcsc_id} is not on {bid}")
    offer = bom_cost.cached_offer(lcsc_id) or {}
    line = {**line, "mpn": offer.get("mpn") or line.get("bom_mpn"), "package": offer.get("package")}
    need = line["qty"] * max(1, qty)
    out = await _look(bom_cost.find_alternatives, line, need)
    passive = bom_cost.passive_alternative(line, need)
    rows = ([passive] if passive else []) + [r for r in out.get("rows") or []
                                              if (r.get("stock") or 0) >= need
                                              and (not passive or r["lcsc"] != passive["lcsc"])]
    return {"lcsc": lcsc_id, "need": need, "term": out.get("term"), "at": out.get("at"), "rows": rows}


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
async def drop_board(bid: str, force: bool = False):
    # A board is a component too: a model that imports it would break.
    users = await links.users_of(db(), "board", bid)
    if users and not force:
        raise HTTPException(
            409, f"{bid} is imported by {', '.join(users)}; "
                 "deleting it breaks their build. Pass force=true to go ahead.")
    res = await db()[ato.BOARDS].delete_one({"_id": bid})
    if not res.deleted_count:
        raise HTTPException(404, bid)
    # Written down: a board went missing once with nothing to say when or
    # how, and a deletion is the one change there is no undoing.
    await say(f"{bid}: deleted", "warn", room="pcb")
    async for v in db()[links.VERSIONS].find({"kind": "board", "component": bid}, {"step": 1}):
        try:
            await store.bucket(db(), "model_files").delete(v["step"]["gridfs_id"])
        except Exception:                                   # noqa: BLE001
            pass
    await db()[links.VERSIONS].delete_many({"kind": "board", "component": bid})
    await links.reindex(db())
    return {"id": bid, "deleted": True, "was_imported_by": users}


@app.get("/api/boards/{bid}/component")
async def board_component(bid: str):
    """The board as a 3D component: its version, the named data a model
    reads (`import <module> as B`), who uses it and who pins it, and its
    version setting."""
    d = db()
    doc = await d[ato.BOARDS].find_one({"_id": bid}, {"component": 1, "title": 1,
                                                      links.EVERY_RUN: 1, "component_error": 1})
    if not doc:
        raise HTTPException(404, bid)
    try:
        data = json.loads(await store.get_artifact(d, bid, "board3d", ato.BOARDS))
    except KeyError:
        data = None
    g = await links.load(d)
    k = links.key("board", bid)
    mod = links.module_for("board", bid, g.table)
    states = await _model_states(d)
    return {"board": bid, "title": doc.get("title") or bid, "component": doc.get("component"),
            "module": mod, "line": f"import {mod} as B" if mod else None,
            "data": data,
            "every_run": bool(doc.get(links.EVERY_RUN)),
            "error": doc.get("component_error"),
            "used_by": [{"id": links.split(x)[1], "title": g.nodes[x]["title"],
                         "pinned": g.pins.get(x, {}).get(k),
                         "state": states.get(links.split(x)[1], {}).get("state")}
                        for x in g.used_by(k)],
            "pinned_by": links.pinned_by(g, k),
            "dependents": [links.split(x)[1] for x in g.dependents(k)]}


class ComponentSettingsIn(BaseModel):
    every_run: bool


@app.put("/api/boards/{bid}/component/settings")
async def board_component_settings(bid: str, body: ComponentSettingsIn):
    """How the board's 3D component is versioned. Off (the default): a
    layout that leaves the 3D as it was is no new version. On: every
    layout or run is one, so a model can pin "the board as of that run"."""
    got = await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": {links.EVERY_RUN: body.every_run}})
    if not got.matched_count:
        raise HTTPException(404, bid)
    await actors.audit(db(), "edit", f"board {bid}", {"every_run": body.every_run})
    return {"board": bid, "every_run": body.every_run}


@app.post("/api/boards/{bid}/component")
async def refresh_board_component(bid: str):
    """Make the board's 3D component from its current layout without
    placing or routing again (a layout does this on its own). Refused
    while a job runs on the board: it reads what the job is writing."""
    running = await db().raw[jobs.JOBS].find_one(
        {"board": bid, "workspace": scope.current(), "status": "running"})
    if running and jobs.alive(running):
        raise HTTPException(409, f"{bid}: a {running.get('kind')} is running - its layout makes the component")
    try:
        out = await kicad.refresh_component(db(), bid)
    except kicad.NoDocker as exc:
        raise HTTPException(503, str(exc))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except RuntimeError as exc:
        await db()[ato.BOARDS].update_one({"_id": bid}, {"$set": {"component_error": {
            "at": store.now(), "error": str(exc)[-1500:]}}})
        raise HTTPException(400, str(exc))
    await say(f"{bid}: 3D component v{out.get('version')}"
              + (" (new)" if out.get("changed") else " (unchanged)")
              + ((" - from the import's own STEP" if out.get("step_from") == "upload"
                  else " - from the import: the bare board, parts as boxes")
                 if out.get("from") == "import" else ""),
              "done", room="pcb")
    await _say_propagation(bid, out)
    return out


@app.get("/api/boards/{bid}/module.py")
async def board_module(bid: str):
    """The module a 3D model imports this board by, as the build writes it."""
    d = db()
    doc = await d[ato.BOARDS].find_one({"_id": bid}, {"component": 1, "title": 1})
    comp = (doc or {}).get("component") or {}
    if not comp.get("digest"):
        raise HTTPException(404, "no 3D yet - lay the board out first")
    data = json.loads(await store.get_artifact(d, bid, "board3d", ato.BOARDS))
    text = board3d.module_source(bid, doc.get("title") or bid, data, comp.get("version") or 1,
                                 comp["digest"], f"{bid}.step")
    return Response(text, media_type="text/x-python")


async def _link_build(d, model_id: str, job: str | None = None):
    """A rebuild a change elsewhere set off, said in the log either way."""
    link = ((await d.models.find_one({"_id": model_id}, {"link": 1})) or {}).get("link") or {}
    b = link.get("because") or {}
    why = f"{b.get('title') or b.get('id')} v{b.get('version')}"
    # A pin that moved is not the component changing.
    did = {"pinned": "was pinned", "follow": "is followed again"}.get(b.get("pin"), "changed")
    # A job of its own (backend/buildjobs.py); `job` is one a previous API
    # process started, which a reload did not stop - waited for, not redone.
    if job is None:
        await say(f"{model_id}: rebuilding because {why} {did}", "work")
        job = (await _start_build(d, model_id, by="link", link_token=link.get("token")))["_id"]
    done = await buildjobs.wait(d.raw, job)
    if done.get("status") == "lost":
        # Died with its runner, not because of the change: built again.
        await say(f"{model_id}: the rebuild was lost ({done.get('detail')}), queued again", "warn")
        raise buildjobs.Lost(done.get("detail") or "lost")
    if done.get("status") != "done":
        # Not marked failed: this version's own save is not what broke it
        # (build_outcome, in the runner).
        msg = str(done.get("detail") or done.get("status"))
        await say(f"{model_id}: broke after {why} {did} - {msg.splitlines()[-1][:200] if msg else 'failed'}",
                  "error")
        raise RuntimeError(msg)
    await say(f"{model_id}: rebuilt against {why}", "done")
    return buildjobs.result(done)


async def _link_job(d, model_id: str, token: str | None):
    """A link rebuild a previous API process started (links.recover)."""
    return await buildjobs.for_link(d.raw, model_id, scope.current(), token)


# ---------------- analytics ----------------
@app.on_event("startup")
async def _start_sampler():
    """The machine, once a minute, for the Analytics room's energy figures."""
    import asyncio
    if MONGODB_URI:
        asyncio.create_task(insights.sampler(db))
        # Changes travelling to what uses them (backend/links.py).
        # Builds a reload did not stop are seen through (backend/buildjobs.py);
        # those that died with the container are lost, and their orphaned
        # export_model.py killed, before the queue looks at them.
        try:
            # Accounts: the first one is the owner, everyone has a system
            # role and a private space (backend/auth.py migrate) - idempotent.
            got = await auth.migrate(db().raw)
            if got.get("updated"):
                LOG.warning("accounts migrated to system roles: %s updated", got["updated"])
        except Exception as exc:                       # noqa: BLE001 - the API still starts
            LOG.warning("accounts not migrated: %s", exc)
        try:
            if n := await scope.undouble(db().raw):
                LOG.warning("doubled workspace names made single: %s", n)
        except Exception as exc:                       # noqa: BLE001 - the API still starts
            LOG.warning("doubled workspace names not fixed: %s", exc)
        try:
            lost = await buildjobs.recover(db().raw)
            killed = await buildjobs.reap_orphans(db().raw)
            if lost or killed:
                LOG.warning("builds lost: %s; orphaned builds killed: %s", lost,
                            [(k["pid"], k["why"]) for k in killed])
        except Exception as exc:                       # noqa: BLE001 - the API still starts
            LOG.warning("build jobs not recovered: %s", exc)
        asyncio.create_task(links.loop(lambda: db().raw, _link_build,
                                       lookup=_link_job))
        try:
            # Command Code answers whose runner died with the container are
            # interrupted - kept as far as they got (backend/ccgen.py); those
            # a reload did not stop are left to finish.
            from . import ccgen
            cut = await ccgen.recover(db().raw)
            if cut:
                LOG.warning("Command Code answers interrupted: %s", cut)
        except Exception as exc:                       # noqa: BLE001 - the API still starts
            LOG.warning("Command Code answers not recovered: %s", exc)
        try:
            # The trash of the Command Code room empties itself after 30 days.
            await cc_chat.ensure_indexes(db().raw)       # the database itself: one index for every workspace
        except Exception as exc:                       # noqa: BLE001 - the trash still works, only fuller
            LOG.warning("Command Code trash index not made: %s", exc)
        try:
            # Its search reads every line through a text index (cc_chat.search).
            await cc_chat.ensure_search_index(db().raw)
        except Exception as exc:                       # noqa: BLE001 - search falls back to reading them all
            LOG.warning("Command Code search index not made: %s", exc)
        try:
            await llm.load(db())                       # the keys and the model each job uses
            from . import netmeter
            netmeter.bind(db)                          # every proxied byte, counted on the wire
            await netmeter.start()
            await netproxy.load(db())                  # the EasyEDA proxy, if one is set
            netproxy.bind(db)                          # its log, for Settings > Proxy
            asyncio.create_task(netproxy.health_loop())
            await fx.load(db())                        # the last exchange rates kept
            asyncio.create_task(fx.loop(db))           # and Frankfurter's, every hour
            from . import budgets
            asyncio.create_task(budgets.loop(lambda: db().raw))   # the month's budgets, and their alerts
            # The Command Code account every ten minutes: the usage chart's
            # points and the weekly window's alert (backend/llm.py cc_loop).
            asyncio.create_task(llm.cc_loop(lambda: db().raw))
            from . import tgbot
            tgbot.start(lambda: db().raw)              # Telegram: send queue, watcher, polling
        except Exception as exc:                       # noqa: BLE001 - .env keys still work
            LOG.warning("LLM / proxy settings not read: %s", exc)

        async def _tidy_releases():
            try:
                await release.abandoned(db().raw)      # every workspace's
            except Exception:
                pass
        asyncio.create_task(_tidy_releases())


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


@app.get("/api/insights/weekly")
async def insights_weekly():
    """The last seven days in a few lines, and the weekly write-ups kept so
    far (one each Monday, of the week before)."""
    async def span():
        return insights.parse_range("7d")
    data = await insights.overview_cached(db(), "7d", span)
    kept = [{"at": w["at"].isoformat() if hasattr(w["at"], "isoformat") else w["at"],
             "week": w.get("week"), "text": w.get("text")}
            async for w in db()[insights.WEEKLY].find({}).sort("at", -1).limit(12)]
    return {"now": insights.weekly_text(data), "kept": kept}


class InsightSettingsIn(BaseModel):
    kwh_price: float | None = Field(default=None, ge=0, le=10)
    plan_usd_month: float | None = Field(default=None, ge=0, le=100000)
    plan_name: str | None = Field(default=None, max_length=80)


@app.put("/api/insights/settings")
async def put_insight_settings(body: InsightSettingsIn):
    """The electricity price and the subscription the room compares with.
    Only the fields sent are changed; send null to clear one."""
    patch = body.model_dump(exclude_unset=True)
    await insights.set_settings(db(), patch)
    return await insights.settings(db())


@app.put("/api/insights/kwh-price")
async def put_kwh_price(body: KwhIn):
    """What a kilowatt-hour costs here, for the electricity figures."""
    await insights.set_kwh_price(db(), body.price)
    return {"kwh_price": body.price}


# ---------------- chat ----------------
class ChatIn(BaseModel):
    # May be empty when the line carries files (a pasted picture).
    text: str = Field(default="", max_length=4000)
    # Files of the Files tab the line carries - pasted, dropped or attached
    # in the composer - by id; kept on the line as chips (chat.file_chips).
    files: list[str] = Field(default_factory=list, max_length=8)
    # "Stop what you are doing", as opposed to "when you get a moment".
    urgent: bool = False
    # Which room's thread: each tab has its own.
    room: str = "cad"


@app.get("/api/chat")
async def chat_history(limit: int = 200, room: str | None = None):
    """The thread, oldest first - one room's, or all of them. The page
    polls its room's with the health."""
    return await chat.history(db(), limit, room)


@app.get("/api/chat/rooms")
async def chat_rooms():
    """Every room's agent thread in a few lines - the Chat tab's pinned
    "Rooms" list and its unread counts (chat.rooms)."""
    return await chat.rooms(db())


# ---------------- one search box ----------------
@app.get("/api/search")
async def search_everything(q: str = ""):
    """Code lines, notes, chats, revisions and parts that match - the Ctrl+K
    palette's half that the page cannot know by itself."""
    return await search.everything(db(), q[:200])


# ---------------- releases ----------------
class ReleaseIn(BaseModel):
    project: str = Field(min_length=1, max_length=80)
    tag: str = Field(min_length=1, max_length=32)
    notes: str = Field(default="", max_length=4000)


def _release_out(d: dict) -> dict:
    return {**{k: v for k, v in d.items() if k not in ("_id", "workspace_id", "zip_id")}, "id": d["_id"]}


@app.get("/api/releases")
async def releases(project: str | None = None):
    return [_release_out(d) for d in await release.listing(db(), project)]


@app.post("/api/releases")
async def release_make(body: ReleaseIn):
    """Pack a project as it stands under a tag - made in the background."""
    try:
        doc = await release.make(db(), body.project, body.tag, body.notes, actors.current())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await actors.audit(db(), "release", f"{body.project} {body.tag}")
    return _release_out(doc)


@app.get("/api/releases/{rid}")
async def release_one(rid: str):
    doc = await db()[release.COLL].find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    return _release_out(doc)


@app.get("/api/releases/{rid}/download")
async def release_download(rid: str):
    try:
        name, data = await release.download(db(), rid)
    except KeyError as exc:
        raise HTTPException(404, "no such release, or it is not ready") from exc
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.delete("/api/releases/{rid}")
async def release_delete(rid: str):
    if not await release.remove(db(), rid):
        raise HTTPException(404, rid)
    return {"deleted": rid}


@app.get("/api/models/{model_id:path}/drawing.pdf")
async def model_drawing(model_id: str):
    """A dimensioned technical drawing of a model (made from its STEP, in
    the drawing container; kept per STEP)."""
    try:
        pdf = await release.model_drawing(db(), model_id)
    except KeyError as exc:
        raise HTTPException(404, model_id) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(500, str(exc)) from exc
    name = model_id.split("/")[-1]
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{name}-drawing.pdf"'})


# ---------------- notes ----------------
class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    # Where it was written: the room, and what was open there.
    context: dict | None = None


class NotePatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=20_000)
    pinned: bool | None = None


def _note_out(d: dict) -> dict:
    return {**{k: v for k, v in d.items() if k not in ("_id", "workspace_id")}, "id": d["_id"]}


@app.get("/api/notes")
async def notes_list(q: str = "", tag: str = "", only: str = ""):
    rows = await notes.listing(db(), q=q, tag=tag, only=only, me=actors.current().get("id", ""))
    return [_note_out(d) for d in rows]


@app.get("/api/notes/tags")
async def notes_tags():
    return await notes.tags(db())


@app.post("/api/notes")
async def notes_create(body: NoteIn):
    ctx = {k: str(v)[:200] for k, v in (body.context or {}).items() if k in ("room", "model", "board") and v}
    return _note_out(await notes.create(db(), body.text, ctx, actors.current()))


@app.patch("/api/notes/{nid}")
async def notes_update(nid: str, body: NotePatch):
    doc = await notes.update(db(), nid, body.text, body.pinned)
    if not doc:
        raise HTTPException(404, nid)
    return _note_out(doc)


@app.delete("/api/notes/{nid}")
async def notes_delete(nid: str):
    doc = await db()[notes.COLL].find_one({"_id": nid}, {"by": 1})
    if not doc:
        raise HTTPException(404, nid)
    # Your own, always; someone else's, only if you may delete.
    if (doc.get("by") or {}).get("id") != actors.current().get("id") and not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await notes.remove(db(), nid)
    return {"deleted": nid}


class NoteSend(BaseModel):
    room: str = Field(pattern="^(cad|pcb)$")
    urgent: bool = False


@app.post("/api/notes/{nid}/send")
async def notes_send(nid: str, body: NoteSend):
    """Hand a note to a room's agent: it arrives in that room's thread."""
    doc = await db()[notes.COLL].find_one({"_id": nid})
    if not doc:
        raise HTTPException(404, nid)
    try:
        line = await chat.post(db(), notes.as_message(doc)[:4000], urgent=body.urgent, room=body.room)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await db()[notes.COLL].update_one({"_id": nid}, {"$set": {"sent": {"room": body.room, "at": notes._now()}}})
    return {"sent": body.room, "message": line}


# ---------------- files ----------------
# Anything the work needs that is not a model or a board: a BOM, a
# pick-and-place file, a datasheet, a photo (backend/files.py).
# Listing, uploading, reading (with ranges), renaming, folders, moving,
# deleting and the ZIP download are in backend/files_api.py.


class FileSend(BaseModel):
    room: str = Field(pattern="^(cad|pcb)$")


@app.post("/api/files/{fid}/send")
async def files_send(fid: str, body: FileSend):
    """Point a room's agent at a file: a line in that room's thread saying
    what it is and how to fetch it."""
    doc = await db()[files.COLL].find_one({"_id": fid})
    if not doc:
        raise HTTPException(404, fid)
    try:
        line = await chat.post(db(), files.as_message(doc)[:4000], room=body.room)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    sent = {"room": body.room, "at": files._now(), "by": actors.current().get("name")}
    # Every time it was sent, for the details pane; `sent` is the last one.
    log = [*(doc.get("sent_log") or ([doc["sent"]] if doc.get("sent") else [])), sent][-50:]
    await db()[files.COLL].update_one({"_id": fid}, {"$set": {"sent": sent, "sent_log": log}})
    return {"sent": body.room, "message": line}


class FileToModel(BaseModel):
    folder: str = Field(min_length=1, max_length=300)
    title: str | None = Field(default=None, max_length=120)


@app.post("/api/files/{fid}/to-model")
async def files_to_model(fid: str, body: FileToModel):
    """A STEP or mesh from the Files tab, added to a project as a model of
    its own: the bytes are copied into the model's CAD files (uploads), so
    the model stays whole if the file is later deleted from Files. Built at
    once, as a job."""
    try:
        doc, data = await files.get(db(), fid)
    except KeyError as exc:
        raise HTTPException(404, fid) from exc
    if doc.get("kind") not in ("step", "mesh"):
        raise HTTPException(400, "only a STEP or a mesh (STL, 3MF, OBJ) can become a 3D model")
    folder = body.folder.strip().strip("/")
    if not await db().folders.find_one({"_id": folder}) and not await db().models.find_one({"folder": folder}, {"_id": 1}):
        raise HTTPException(404, f"no folder {folder!r}")
    # An upload of the same name may be another model's part: never laid
    # over it - this one gets a name of its own.
    name = doc["name"]
    clean = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(name).stem).strip("_-") or "part"
    suffix, n, first = Path(name).suffix.lower(), 2, clean
    while await db().uploads.find_one({"_id": clean + suffix}, {"_id": 1}):
        clean, n = f"{first}_{n}", n + 1
    try:
        info = await store.put_upload(db(), clean + suffix, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    stem = Path(info["name"]).stem
    base = re.sub(r"[^a-z0-9_]+", "_", stem.lower()).strip("_") or "part"
    model_id, n = f"{folder}/{base}", 2
    while await db().models.find_one({"_id": model_id}, {"_id": 1}):
        model_id, n = f"{folder}/{base}_{n}", n + 1
    title = (body.title or "").strip() or Path(doc["name"]).stem
    source = starter_source(info["name"]).replace(f'TITLE = "{stem}"', f"TITLE = {json.dumps(title)}", 1)
    try:
        saved = await store.save_model(db(), model_id, source)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await actors.audit(db(), "file-to-model", doc["name"], {"file": fid, "model": model_id})
    await db()[files.COLL].update_one({"_id": fid}, {"$set": {"model": saved["_id"]}})
    await push_activity(ActivityIn(text=f"{doc['name']} added to {folder} as {title}", level="done"))
    job = await _start_build(db(), model_id, by="request")
    return {"model": saved["_id"], "title": title, "upload": info["name"], "build_job": job.get("_id")}


@app.post("/api/chat")
async def chat_post(body: ChatIn):
    """Say something to the agent. Its own replies come in over the CLI."""
    try:
        chips = await chat.file_chips(db(), body.files)
    except KeyError as exc:
        raise HTTPException(404, f"no file {exc.args[0]!r}") from exc
    try:
        return await chat.post(db(), body.text, urgent=body.urgent, room=body.room, mentions=chips)
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
    room: str | None = Field(default=None, pattern="^(cad|pcb|firmware)$")


class AnswerIn(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)


@app.get("/api/questions")
async def list_questions():
    """What the agent is waiting on. The page polls this with the health."""
    return await questions.with_rooms(db(), await questions.open_questions(db()))


@app.get("/api/questions/answered")
async def answered_questions(room: str | None = None, limit: int = 200):
    """The questions already answered - a room's thread keeps them in its
    log, resolved, with who answered what and when."""
    return await questions.answered(db(), room, max(1, min(limit, 1000)))


@app.post("/api/questions")
async def create_question(body: QuestionIn):
    return await questions.ask(db(), body.text, body.options, body.revision,
                               body.context, body.multi, body.room)


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
    await db().revisions.update_one({"_id": rid}, {"$set": {"status_by": actors.current()}})
    return {"id": rid, **patch}


@app.delete("/api/revisions/{rid}")
async def drop_revision(rid: str):
    d = db()
    doc = await d.revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    for key in ("image", "image_after"):           # the before and after pictures go with it
        if doc.get(key):
            try:
                await store.bucket(d, "shots").delete(doc[key]["gridfs_id"])
            except Exception:
                pass
    await d.revisions.delete_one({"_id": rid})
    return {"deleted": rid}


# compiled frontend, when present
_dist = ROOT / "frontend" / "dist" / "frontend" / "browser"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="ui")
