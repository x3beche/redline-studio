"""Board import over HTTP: `/api/boards/import...` (SPEC §5).

    POST /api/boards/import            multipart: files (one zip or several
                                       files), project, folder, name
                                       -> {"job": id}
    GET  /api/boards/import/{job}      progress, then the board and the
                                       account of what was found / missing
    GET  /api/boards/import/files/{board}/{name}
                                       what an import keeps beside the usual
                                       artifacts: layers.pdf, placement.json,
                                       pads.json, sources.zip (the upload)

The work runs as a background task: Gerbers parse in a thread, the STEP
converts in a process of its own and KiCad in its container, so the
request that started it returns at once.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile

from .. import scope, store
from ..ato import BOARDS
from . import pipeline

router = APIRouter()

MAX_UPLOAD = 200 * 1024 * 1024
KEEP_JOBS = 50
JOBS: dict[str, dict] = {}


def _db():
    from ..main import db              # late: main imports the routers
    return db()


async def _say(text: str, level: str = "info") -> None:
    try:
        from ..main import say
        await say(text, level, room="pcb")
    except Exception:                  # noqa: BLE001 - the log is a courtesy
        pass


def title_from(names: list[str]) -> str:
    """`Gerber_PCB_DemoBoard_0_254_routed_2026-09-29.zip` -> `DemoBoard 0 254 routed`."""
    for n in names:
        stem = re.sub(r"\.[A-Za-z0-9_]+$", "", n.rsplit("/", 1)[-1])
        stem = re.sub(r"^(gerber|3d|pcb|bom|pickandplace|fabrication)[_ -]+", "", stem, flags=re.I)
        stem = re.sub(r"^(gerber|3d|pcb)[_ -]+", "", stem, flags=re.I)
        stem = re.sub(r"[_ -]+\d{4}-\d{2}-\d{2}([_ -]\d+)?$", "", stem)
        stem = re.sub(r"[_]+", " ", stem).strip()
        if stem:
            return stem[:80]
    return "Imported board"


def _prune() -> None:
    done = sorted((j for j in JOBS.values() if j["status"] != "running"),
                  key=lambda j: j["started"])
    for j in done[:max(0, len(JOBS) - KEEP_JOBS)]:
        JOBS.pop(j["id"], None)


async def _run(job: dict, uploads: list[tuple[str, bytes]], title: str, folder: str) -> None:
    async def progress(stage: str) -> None:
        job["stage"] = stage
        job["log"].append({"at": round(time.monotonic() - job["t0"], 1), "stage": stage})

    try:
        await _say(f"importing {title}: {', '.join(n for n, _ in uploads)[:160]}", "work")
        res = await pipeline.analyse(uploads, title, progress)
        if not res.artifacts.get("layout") and not res.artifacts.get("graph"):
            job.update(status="failed", stage="nothing to import",
                       error="nothing in the upload could be read as a board",
                       summary=res.summary())
            await _say(f"import of {title} found nothing to make a board of", "error")
            return
        await progress("storing the board")
        db = _db()
        folder = await pipeline.ensure_folder(db, folder)
        bid = await pipeline.store_board(db, res, title, folder)
        doc = await db[BOARDS].find_one({"_id": bid}, {"imported": 1, "layout": 1})
        job.update(status="done", stage="done", board=bid, folder=folder,
                   summary=doc["imported"], size_mm=(doc.get("layout") or {}).get("size_mm"),
                   seconds=round(time.monotonic() - job["t0"], 1))
        size = job["size_mm"]
        await _say(f"{bid}: imported - " + (f"{size[0]} x {size[1]} mm, " if size else "")
                   + f"{len(doc['imported']['found'])} things found, "
                   f"{len(doc['imported']['missing'])} missing, in {job['seconds']} s", "done")
    except Exception as exc:                                    # noqa: BLE001
        job.update(status="failed", error=f"{type(exc).__name__}: {exc}"[:400])
        await _say(f"import of {title} failed - {str(exc).splitlines()[0][:160]}", "error")


@router.post("/api/boards/import")
async def start_import(files: list[UploadFile] = File(...), project: str = Form(""),
                       folder: str = Form(""), name: str = Form("")):
    """Start an import. The board goes in `<project>/<folder>` (either may
    be empty); its title is `name`, or one made from the file names."""
    uploads, total = [], 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > MAX_UPLOAD:
            raise HTTPException(413, "the upload is over 200 MB")
        if data:
            uploads.append((f.filename or "upload", data))
    if not uploads:
        raise HTTPException(400, "no files")
    path = "/".join(p for p in (project.strip("/"), folder.strip("/")) if p)
    if path and not all(store.SAFE.match(p) for p in path.split("/")):
        raise HTTPException(400, "project and folder names may only use letters, digits, - and _")
    title = name.strip()[:80] or title_from([n for n, _ in uploads])
    job = {"id": uuid.uuid4().hex[:12], "status": "running", "stage": "queued", "log": [],
           "title": title, "files": [n for n, _ in uploads], "started": store.now(),
           "t0": time.monotonic(), "workspace": scope.current(), "board": None}
    JOBS[job["id"]] = job
    _prune()
    # The task inherits this request's context, so the work is filed
    # under the workspace that asked for it.
    job["task"] = asyncio.create_task(_run(job, uploads, title, path))
    return {"job": job["id"], "title": title}


def _public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in ("task", "t0", "workspace")} | {
        "elapsed": round(time.monotonic() - job["t0"], 1)}


@router.get("/api/boards/import/{job_id}")
async def import_status(job_id: str):
    job = JOBS.get(job_id)
    if not job or job["workspace"] != scope.current():
        raise HTTPException(404, "no such import")
    return _public(job)


FILES = {"layers.pdf": ("layers_pdf", "application/pdf"),
         "placement.json": ("placement", "application/json"),
         "pads.json": ("pads", "application/json"),
         "sources.zip": ("sources", "application/zip")}


@router.get("/api/boards/import/files/{bid}/{name}")
async def import_file(bid: str, name: str):
    if name not in FILES:
        raise HTTPException(404, name)
    label, kind = FILES[name]
    try:
        raw = await store.get_artifact(_db(), bid, label, BOARDS)
    except KeyError:
        raise HTTPException(404, f"no {name} for {bid}")
    head = {"Content-Disposition": f'inline; filename="{bid}-{name}"'}
    return Response(raw, media_type=kind, headers=head)
