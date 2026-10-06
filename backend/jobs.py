"""The long board steps - a run, a conversion, a layout - apart from the API.

A board run is minutes of KiCad and Freerouting. It used to be done inside
the request that asked for it, and the request stayed open until the end.
That held the whole API hostage: uvicorn --reload restarts the server on
every save of a backend file, and a restart waits for open requests to
finish ("Waiting for connections to close") - with the listening socket
still held by the reloader, so every new connection queued unanswered on
port 8000 until the run was done. 2026-10-06: a save at 11:14:51, the run
it waited for finished at 11:19:55, and for those five minutes nothing
answered. The event loop itself was never blocked - the request timings
show the page polling normally all through a 17-minute run when no save
came.

So the work is done by a process of its own (`python -m backend.jobs
<id>`, started in its own session): the API starts it, writes down that it
is running, and answers at once. A reload restarts the API around it; the
job carries on, and writes its result into `board_jobs` when it is done.
Whoever asked reads it from there (GET /api/boards/{id}/jobs/{job}) - or,
for a caller that wants the old behaviour, the request waits for it, which
a reload can now cut short without losing the work.

One job per board at a time: a second run of the same board while the
first is routing is refused, not queued - two at once fought over the
machine and froze it.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

JOBS = "board_jobs"                 # the machine's, not a workspace's: holds its workspace
KINDS = ("run", "convert", "layout")
ROOT = Path(__file__).resolve().parent.parent
BEAT = 10.0                         # a runner says it is alive this often, s
LOST = 120.0                        # a running job not heard from for this long has died
POLL = 1.0                          # how often a waiting request looks, s
LOGS = Path(tempfile.gettempdir()) / "redline-jobs"


class Busy(RuntimeError):
    """This board already has a job running."""

    def __init__(self, job: dict):
        self.job = job
        super().__init__(f"{job.get('board')}: a {job.get('kind')} is already running "
                         f"(job {job.get('_id')}, started {job.get('started_at')})")


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(t) -> datetime | None:
    if t is None:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def alive(job: dict, at: datetime | None = None) -> bool:
    """A running job is alive while its runner keeps saying so."""
    if job.get("status") != "running":
        return False
    beat = _aware(job.get("beat") or job.get("started_at"))
    return beat is not None and ((at or now()) - beat).total_seconds() < LOST


def view(job: dict) -> dict:
    """A job as the API shows it: the result decoded, the bookkeeping not."""
    out = {"job": job["_id"], "kind": job.get("kind"), "board": job.get("board"),
           "status": job.get("status"), "started_at": job.get("started_at"),
           "finished_at": job.get("finished_at"), "seconds": job.get("seconds")}
    if job.get("status") == "done":
        out["result"] = result(job)
    elif job.get("status") in ("failed", "lost"):
        out["code"] = job.get("code") or 500
        out["detail"] = job.get("detail")
    return out


def result(job: dict):
    raw = job.get("result_json")
    return json.loads(raw) if raw else None


def runner_argv(job_id: str) -> list[str]:
    return [sys.executable, "-m", "backend.jobs", job_id]


def _popen(job_id: str) -> int:
    """Start the runner: its own session, so neither a reload's signal nor
    the server's exit reaches it; reaped by a thread while this process
    lives, so it does not linger as a zombie."""
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / f"{job_id}.log", "ab") as log:
        proc = subprocess.Popen(runner_argv(job_id), cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                env=os.environ.copy())
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc.pid


async def spawn(db, job_id: str) -> int:
    """Start the runner for a job. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, job_id)


async def _lose(col, job: dict, why: str) -> dict:
    patch = {"status": "lost", "code": 500, "finished_at": now(), "detail": why}
    await col.update_one({"_id": job["_id"], "status": "running"}, {"$set": patch})
    return {**job, **patch}


async def start(db, kind: str, board: str, body: dict | None, *, workspace: str,
                actor: dict | None = None, role: str | None = None,
                who: str | None = None) -> dict:
    """Write the job down and start its runner. Raises Busy when the board
    already has one running."""
    if kind not in KINDS:
        raise ValueError(f"no such job: {kind}")
    col = db[JOBS]
    old = await col.find_one({"board": board, "workspace": workspace, "status": "running"})
    if old:
        if alive(old):
            raise Busy(old)
        await _lose(col, old, "its runner stopped answering (the container restarted?)")
    t = now()
    job = {"_id": uuid.uuid4().hex[:16], "kind": kind, "board": board, "workspace": workspace,
           "body": body or {}, "actor": actor, "role": role, "who": who,
           "status": "running", "started_at": t, "beat": t, "host": socket.gethostname()}
    await col.insert_one(job)
    try:
        pid = await spawn(db, job["_id"])
    except OSError as exc:
        await col.update_one({"_id": job["_id"]}, {"$set": {
            "status": "failed", "code": 500, "finished_at": now(),
            "detail": f"the job could not be started: {exc}"}})
        raise
    await col.update_one({"_id": job["_id"]}, {"$set": {"pid": pid}})
    return {**job, "pid": pid}


async def get(db, job_id: str) -> dict | None:
    doc = await db[JOBS].find_one({"_id": job_id})
    if doc and doc.get("status") == "running" and not alive(doc):
        doc = await _lose(db[JOBS], doc, "its runner stopped answering (the container restarted?)")
    return doc


async def wait(db, job_id: str, poll: float = POLL) -> dict:
    """Until the job is no longer running; its document then."""
    while True:
        doc = await get(db, job_id)
        if doc is None:
            raise KeyError(job_id)
        if doc.get("status") != "running":
            return doc
        await asyncio.sleep(poll)


async def latest(db, board: str, workspace: str, limit: int = 10) -> list[dict]:
    rows = [d async for d in db[JOBS].find({"board": board, "workspace": workspace})
            .sort("started_at", -1).limit(limit)]
    return [{k: v for k, v in view(d).items() if k != "result"} for d in rows]


# ---------------------------------------------------------------- the runner

async def _beat(col, job_id: str) -> None:
    while True:
        await asyncio.sleep(BEAT)
        try:
            await col.update_one({"_id": job_id, "status": "running"}, {"$set": {"beat": now()}})
        except Exception:                                        # noqa: BLE001 - next beat
            pass


async def execute(db, job: dict, step) -> dict:
    """Run one job's step and write down how it ended. `step(kind, board,
    body)` is the work (backend/main.py's job_step); an HTTPException from
    it is kept as the status and detail the request would have answered."""
    from fastapi import HTTPException
    from fastapi.encoders import jsonable_encoder

    col = db[JOBS]
    beat = asyncio.create_task(_beat(col, job["_id"]))
    t0 = time.monotonic()
    try:
        got = await step(job["kind"], job["board"], job.get("body") or {})
        patch = {"status": "done", "result_json": json.dumps(jsonable_encoder(got))}
    except HTTPException as exc:
        patch = {"status": "failed", "code": exc.status_code, "detail": jsonable_encoder(exc.detail)}
    except Exception as exc:                                     # noqa: BLE001 - said, not lost
        patch = {"status": "failed", "code": 500, "detail": f"{type(exc).__name__}: {exc}"[:2000],
                 "trace": traceback.format_exc()[-4000:]}
    finally:
        beat.cancel()
    patch.update(finished_at=now(), seconds=round(time.monotonic() - t0, 1))
    await col.update_one({"_id": job["_id"]}, {"$set": patch})
    return {**job, **patch}


async def _main(job_id: str) -> int:
    from . import access, actors, lcsc, llm, main, netproxy, scope

    raw = main.db().raw                 # the jobs are the machine's, not a workspace's
    job = await raw[JOBS].find_one({"_id": job_id})
    if not job or job.get("status") != "running":
        print(f"job {job_id}: not waiting to run", file=sys.stderr)
        return 1
    # The request's context, as the middleware set it for the API.
    scope.WORKSPACE.set(job.get("workspace") or scope.DEFAULT)
    actors.CURRENT.set(job.get("actor"))
    access.ROLE.set(job.get("role"))
    if job.get("who"):
        lcsc.WHO.set(job["who"])
    # What the server reads at startup and the work leans on: the LLM keys,
    # and the EasyEDA proxy a conversion's lookups go through.
    try:
        await llm.load(main.db())
        await netproxy.load(main.db())
        netproxy.bind(main.db)
    except Exception as exc:                                     # noqa: BLE001
        print(f"job {job_id}: settings not read: {exc}", file=sys.stderr)
    print(f"job {job_id}: {job['kind']} {job['board']} (pid {os.getpid()})", flush=True)
    done = await execute(raw, job, main.job_step)
    print(f"job {job_id}: {done['status']} in {done.get('seconds')} s", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("python -m backend.jobs <job id>")
    sys.exit(asyncio.run(_main(sys.argv[1])))
