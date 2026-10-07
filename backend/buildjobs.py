"""Model builds as jobs of their own, apart from the API (as backend/jobs.py
does for the board steps).

A build used to run as a child of the uvicorn worker that was asked for
it. uvicorn --reload restarts that worker on every save of a backend file:
the request was cut, the build's bookkeeping with it, and the
`export_model.py` underneath carried on as an orphan that nobody would
ever read - minutes of booleans and gigabytes of memory for nothing
(2026-10-07: three orphaned station builds killed by hand).

So a build is done by a process of its own (`python -m backend.buildjobs
<id>`, its own session): the API writes the job down, starts it, and
either answers at once (`?detach=1`, 202) or waits for the result in
`build_jobs` - which a reload can cut short without losing the build. The
runner says it is alive every BEAT seconds; one not heard from for LOST
seconds is lost. The link scheduler (backend/links.py) waits for its
rebuilds the same way and, after a restart, takes over the ones still
running (or finished meanwhile) instead of starting them again.

At startup, `export_model.py` processes whose job is not running are
killed (`reap_orphans`): a runner that died leaves its build behind, and
builds from before this module ran inside the worker.

One build per model at a time: a second is refused (409), not queued.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

from . import jobs
from .jobs import BEAT, LOST, alive, now  # noqa: F401 - one clock for both kinds

JOBS = "build_jobs"                 # the machine's, like board_jobs: holds its workspace
ENV = "REDLINE_BUILD_JOB"           # set on the runner, so on its export_model.py
SCRIPT = "export_model.py"
POLL = 1.0
ROOT = jobs.ROOT
LOGS = jobs.LOGS


class Busy(RuntimeError):
    """This model is already being built."""

    later = True                    # the link scheduler queues its rebuild again (links.py)

    def __init__(self, job: dict):
        self.job = job
        super().__init__(f"{job.get('model')}: a build is already running "
                         f"(job {job.get('_id')}, started {job.get('started_at')})")


class Lost(RuntimeError):
    """The build's runner died with it (a container restart): built again,
    not counted as the model failing."""

    later = True


def _pid_ns() -> str | None:
    """Which process namespace this is: a pid means something only in its own."""
    try:
        return os.readlink("/proc/self/ns/pid")
    except OSError:
        return None


def view(job: dict) -> dict:
    out = {"job": job["_id"], "kind": "build", "model": job.get("model"), "by": job.get("by"),
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
    return [sys.executable, "-m", "backend.buildjobs", job_id]


def _popen(job_id: str) -> int:
    """Its own session, so a reload's signal does not reach it; reaped by a
    thread while this process lives."""
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / f"build-{job_id}.log", "ab") as log:
        proc = subprocess.Popen(runner_argv(job_id), cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                env={**os.environ, ENV: job_id})
    threading.Thread(target=proc.wait, daemon=True).start()
    return proc.pid


async def spawn(db, job_id: str) -> int:
    """Start the runner. Its own function so a test can stand in."""
    return await asyncio.to_thread(_popen, job_id)


async def _lose(raw, job: dict, why: str) -> dict:
    patch = {"status": "lost", "code": 500, "finished_at": now(), "detail": why}
    got = await raw[JOBS].update_one({"_id": job["_id"], "status": "running"}, {"$set": patch})
    if getattr(got, "modified_count", 1):
        # build() clears the flag in its finally - which a killed runner
        # never reached. Only this build's flag: build() marks it with the job.
        from . import scope
        await scope.ScopedDb(raw, job.get("workspace") or scope.DEFAULT).models.update_one(
            {"_id": job.get("model"), "building": True, "build_job": job["_id"]},
            {"$set": {"building": False}, "$unset": {"build_started": "", "build_job": ""}})
    return {**job, **patch}


GONE = "its runner stopped answering (the API container restarted?)"


async def start(raw, model_id: str, *, workspace: str, by: str = "request",
                link_token: str | None = None, version: int | None = None,
                actor: dict | None = None, role: str | None = None) -> dict:
    """Write the build down and start its runner. Raises Busy while the
    model already has one running."""
    col = raw[JOBS]
    old = await col.find_one({"model": model_id, "workspace": workspace, "status": "running"})
    if old:
        if alive(old) and not _dead_here(old):
            raise Busy(old)
        await _lose(raw, old, GONE)
    t = now()
    job = {"_id": uuid.uuid4().hex[:16], "kind": "build", "model": model_id,
           "workspace": workspace, "by": by, "link_token": link_token, "version": version,
           "actor": actor, "role": role, "status": "running", "started_at": t, "beat": t,
           "host": socket.gethostname(), "ns": _pid_ns()}
    await col.insert_one(job)
    try:
        pid = await spawn(raw, job["_id"])
    except OSError as exc:
        await col.update_one({"_id": job["_id"]}, {"$set": {
            "status": "failed", "code": 500, "finished_at": now(),
            "detail": f"the build could not be started: {exc}"}})
        raise
    await col.update_one({"_id": job["_id"]}, {"$set": {"pid": pid}})
    return {**job, "pid": pid}


async def get(raw, job_id: str) -> dict | None:
    doc = await raw[JOBS].find_one({"_id": job_id})
    if doc and doc.get("status") == "running" and not alive(doc):
        doc = await _lose(raw, doc, GONE)
    return doc


async def wait(raw, job_id: str, poll: float | None = None) -> dict:
    """Until the build is no longer running; its document then."""
    while True:
        doc = await get(raw, job_id)
        if doc is None:
            raise KeyError(job_id)
        if doc.get("status") != "running":
            return doc
        await asyncio.sleep(POLL if poll is None else poll)


async def latest(raw, model_id: str, workspace: str, limit: int = 10) -> list[dict]:
    rows = [d async for d in raw[JOBS].find({"model": model_id, "workspace": workspace})
            .sort("started_at", -1).limit(limit)]
    return [{k: v for k, v in view(d).items() if k != "result"} for d in rows]


async def for_link(raw, model_id: str, workspace: str, token: str | None) -> dict | None:
    """The link rebuild of `model_id` for `token` that a previous API
    process started - still running, or finished since - if any. Lost ones
    are not: those are built again."""
    if not token:
        return None
    rows = [d async for d in raw[JOBS].find({"model": model_id, "workspace": workspace,
                                             "link_token": token})
            .sort("started_at", -1).limit(1)]
    if not rows:
        return None
    doc = await get(raw, rows[0]["_id"])
    if doc and doc.get("status") == "running" and _dead_here(doc):
        doc = await _lose(raw, doc, GONE)
    return doc if doc and doc.get("status") in ("running", "done", "failed") else None


# ---------------------------------------------------------------- startup

def _dead_here(job: dict) -> bool:
    """A running job's runner was in this process namespace and is gone -
    known now, without waiting LOST seconds for its beat to go stale."""
    pid, ns = job.get("pid"), job.get("ns")
    if not pid or not ns or ns != _pid_ns():
        return False
    try:
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return True
    return job["_id"].encode() not in args


async def recover(raw) -> list[str]:
    """After a restart: running builds whose runner is gone are lost now."""
    out = []
    async for job in raw[JOBS].find({"status": "running"}):
        if _dead_here(job) or not alive(job):
            await _lose(raw, job, GONE)
            out.append(job["_id"])
    return out


def _builds() -> list[dict]:
    """Every export_model.py in this namespace: pid, parent, its job."""
    out = []
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            args = (p / "cmdline").read_bytes().split(b"\0")
            if not any(a.endswith(SCRIPT.encode()) for a in args):
                continue
            stat = (p / "stat").read_text()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
            env = dict(x.split(b"=", 1) for x in (p / "environ").read_bytes().split(b"\0")
                       if b"=" in x)
        except (OSError, ValueError, IndexError):
            continue
        job = env.get(ENV.encode())
        out.append({"pid": int(p.name), "ppid": ppid, "job": job.decode() if job else None})
    return out


async def reap_orphans(raw, procs=None, kill=os.kill) -> list[dict]:
    """Kill the export_model.py processes nobody will read: their job is
    not running (or is lost), or - from before builds were jobs - their
    parent is gone (re-parented to init). A build the CLI or an agent runs
    has its parent and no job, and is left alone."""
    killed = []
    for p in (_builds() if procs is None else procs):
        if p["pid"] == os.getpid():
            continue
        if p["job"]:
            job = await get(raw, p["job"])
            if job and job.get("status") == "running" and not _dead_here(job):
                continue
            why = f"its job {p['job']} is {(job or {}).get('status') or 'unknown'}"
        elif p["ppid"] in (0, 1):
            why = "orphaned (its parent is gone)"
        else:
            continue
        try:
            kill(p["pid"], signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            continue
        killed.append({**p, "why": why})
    # Our own children that have ended (a runner whose thread is gone).
    try:
        while os.waitpid(-1, os.WNOHANG)[0]:
            pass
    except ChildProcessError:
        pass
    return killed


# ---------------------------------------------------------------- the runner

async def _beat(col, job_id: str) -> None:
    while True:
        await asyncio.sleep(BEAT)
        try:
            await col.update_one({"_id": job_id, "status": "running"}, {"$set": {"beat": now()}})
        except Exception:                                        # noqa: BLE001 - next beat
            pass


def failure(exc: BaseException) -> dict:
    """How a build that raised is answered: what the route used to answer."""
    if isinstance(exc, KeyError):
        return {"code": 404, "detail": str(exc)}
    if isinstance(exc, (ValueError, RuntimeError, TimeoutError, MemoryError, InterruptedError)):
        return {"code": 500, "detail": str(exc)}
    return {"code": 500, "detail": f"{type(exc).__name__}: {exc}"[:2000]}


async def execute(raw, job: dict, work) -> dict:
    """Run `work()` (the build) and write down how it ended."""
    from fastapi.encoders import jsonable_encoder

    col = raw[JOBS]
    beat = asyncio.create_task(_beat(col, job["_id"]))
    t0 = time.monotonic()
    try:
        got = await work()
        patch = {"status": "done", "result_json": json.dumps(jsonable_encoder(got))}
    except Exception as exc:                                     # noqa: BLE001 - said, not lost
        patch = {"status": "failed", **failure(exc), "trace": traceback.format_exc()[-4000:]}
    finally:
        beat.cancel()
    patch.update(finished_at=now(), seconds=round(time.monotonic() - t0, 1))
    await col.update_one({"_id": job["_id"]}, {"$set": patch})
    return {**job, **patch}


async def _outcome(main, job: dict, error: str | None) -> None:
    try:
        await main.build_outcome(main.db(), job, error)
    except Exception as exc:                                     # noqa: BLE001 - the build stands
        print(f"build {job['_id']}: outcome not recorded: {exc}", file=sys.stderr)


async def run(raw, job_id: str) -> dict | None:
    """The runner's work, in whatever process runs it: the build, how it
    ended written to the job, the version's outcome to the model."""
    from . import access, actors, build, main, scope

    job = await raw[JOBS].find_one({"_id": job_id})
    if not job or job.get("status") != "running":
        return None
    scope.WORKSPACE.set(job.get("workspace") or scope.DEFAULT)
    actors.CURRENT.set(job.get("actor"))
    access.ROLE.set(job.get("role"))
    build.JOB.set(job_id)

    async def work():
        try:
            out = await build.build(main.db(), job["model"], main.EXPORT_SCRIPT)
        except Exception as exc:
            await _outcome(main, job, str(exc) or type(exc).__name__)
            raise
        await _outcome(main, job, None)
        return out

    return await execute(raw, job, work)


async def _main(job_id: str) -> int:
    from . import main

    os.environ[ENV] = job_id            # inherited by export_model.py: reap_orphans reads it
    print(f"build {job_id}: pid {os.getpid()}", flush=True)
    done = await run(main.db().raw, job_id)
    if done is None:
        print(f"build {job_id}: not waiting to run", file=sys.stderr)
        return 1
    print(f"build {job_id}: {done['model']} {done['status']} in {done.get('seconds')} s", flush=True)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("python -m backend.buildjobs <job id>")
    sys.exit(asyncio.run(_main(sys.argv[1])))
