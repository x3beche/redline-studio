"""model_build: "rebuild the lid" - a 3D model built again, as the 3D room's
Rebuild does (POST /api/models/{id}/build: main.py `_start_build`, the
build a process of its own in backend/buildjobs.py), and, if asked, waited
for a while; or a build job read by its id.

The room's rules hold as they are: one build per model at a time (a second
is refused, and the one running is named so it can be followed), the
build's own runner, its own limits. The wait is bounded (MAX_WAIT, under
ccgen's TOOL_TIMEOUT): a build that takes longer goes on, and the answer
gives its job to read again with `job`.

A build changes no source and nothing a person wrote: it makes the model's
shape again from its script. So it is not undone - there is nothing to set
back - and the step says so."""

from __future__ import annotations

import asyncio

from fastapi import HTTPException

from .. import buildjobs, chat_undo, links
from . import Ctx, Result, Tool, ToolError, size
from ._rights import need
from ._things import find

MAX_WAIT = 150                      # seconds a call may wait for the build (ccgen.TOOL_TIMEOUT is 180)
ERROR_LINES = 12                    # lines of a failed build's error the model gets


def _excerpt(detail) -> str:
    """The end of a build's error, where the cause is."""
    text = detail if isinstance(detail, str) else str((detail or {}).get("detail") if isinstance(detail, dict) else detail)
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()]
    return "\n".join(lines[-ERROR_LINES:])[:1500]


def _wait(args: dict) -> int:
    raw = args.get("wait")
    if raw in (None, False, ""):
        return 0
    if raw is True:
        return MAX_WAIT
    try:
        return max(0, min(int(raw), MAX_WAIT))
    except (TypeError, ValueError):
        raise ToolError(f"wait is a number of seconds, 0 to {MAX_WAIT}") from None


def _told(job: dict, title: str, mid: str) -> Result:
    """A build job as the model and the page are told it."""
    st, jid, secs = job.get("status"), job["_id"], job.get("seconds")
    v = {"title": title, "model": mid, "job": jid, "state": st}
    if st == "running":
        v["state"] = "running"
        return Result(text=f"The build of {title} ({mid}) is running: job {jid}, started {job.get('started_at')}. "
                           "It goes on by itself; read how it went with model_build and this job.",
                      say="Building {title}", vars=v, summary=f"running · job {jid}")
    if st == "done":
        got = buildjobs.result(job) or {}
        arts = got.get("artifacts") or {}
        v.update(state="ok", seconds=secs or 0, artifacts=len(arts))
        files = ", ".join(f"{k} {size(int(n))}" for k, n in arts.items() if isinstance(n, (int, float)) and n)
        return Result(text=f"{title} ({mid}) built in {secs} s (job {jid})."
                           + (f" It made: {files}." if files else "")
                           + " The 3D room shows the new shape; model_render photographs it.",
                      say="Built {title} · {seconds} s", vars=v,
                      summary=f"ok · {secs} s · {len(arts)} files · job {jid}")
    why = _excerpt(job.get("detail"))
    v.update(state="failed", seconds=secs or 0, error=(why.splitlines() or [""])[-1][:80])
    return Result(text=f"The build of {title} ({mid}) {'was lost' if st == 'lost' else 'failed'} after {secs} s "
                       f"(job {jid}). The end of its error:\n{why or '(no error text)'}",
                  say="The build of {title} failed", vars=v,
                  summary=f"{st} · {secs} s · job {jid}\n{why[-400:]}")


async def start(db, model_id: str) -> dict:
    """The 3D room's own start of a build (main.py `_start_build`)."""
    from .. import main
    return await main._start_build(db, model_id, by="request")


async def run(ctx: Ctx, args: dict) -> Result:
    db = chat_undo.inner(ctx.db)
    raw = getattr(db, "raw", db)
    jid = str(args.get("job") or "").strip()
    if jid:
        need("GET", f"/api/build-jobs/{jid}")
        job = await buildjobs.get(raw, jid)
        if not job or job.get("workspace") != getattr(db, "workspace", job.get("workspace")):
            raise ToolError(f"no build job {jid} in this workspace")
        return _told(job, job.get("model") or "?", job.get("model") or "?")
    ref = str(args.get("model") or "").strip()
    if not ref:
        raise ToolError("say which 3D model to build (its id or title words - model_read lists them), "
                        "or give a build's job to read")
    wait = _wait(args)
    d = await find(ctx.db, "models", ref, ("title", "name"), "3D model")
    mid, title = d["_id"], d.get("title") or d.get("name") or d["_id"]
    need("POST", f"/api/models/{mid}/build")
    if (d.get("link") or {}).get("state") in links.UPDATING:
        # A linked rebuild is already on its way for it: the same build, sooner or later.
        raise ToolError(f"{title} is queued for a rebuild already (a part it uses changed) - it builds by itself; "
                        "read it with model_read")
    try:
        job = await start(db, mid)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {"detail": exc.detail}
        if exc.status_code == 409 and detail.get("job"):
            running = await buildjobs.get(raw, detail["job"]) or {"_id": detail["job"], "status": "running"}
            got = _told(running, title, mid)
            got.text = f"Not started: {title} is being built already. " + got.text
            got.vars["busy"] = 1
            return got
        raise ToolError(str(detail.get("detail") or exc.detail)[:400]) from None
    if wait:
        try:
            job = await asyncio.wait_for(buildjobs.wait(raw, job["_id"]), wait)
        except asyncio.TimeoutError:
            job = await buildjobs.get(raw, job["_id"]) or job
            got = _told(job, title, mid)
            if job.get("status") == "running":
                got.text = f"Still building after {wait} s. " + got.text
            return got
    return _told(job, title, mid)


TOOL = Tool(
    name="model_build", package="cad", level="change", order=32, default=False,
    undo="a build makes the shape again from its script and changes nothing written - there is nothing to undo",
    label="Build a model",
    about="Builds a 3D model again, as the 3D room's Rebuild does, and can wait for how it went.",
    description="Build a 3D model again (\"rebuild the lid\"), exactly as the 3D room's Rebuild does: the build runs "
                "on the server by itself, one per model at a time. With `wait` (seconds, at most 150) the answer "
                "waits for it and says ok or failed, how long it took, what it made or the end of its error; "
                "without it, or when it takes longer, the answer gives the build's job - read how it went later "
                "with `job` alone. A model already building is not built twice: the running build is named. Use it "
                "only when the person asks for a build. It changes no source and cannot be undone (nothing to undo).",
    schema={"type": "object", "properties": {
        "model": {"type": "string", "description": "The 3D model's id or title words"},
        "wait": {"type": "integer", "minimum": 0, "maximum": MAX_WAIT,
                 "description": "Seconds to wait for the result (0: answer at once with the job)"},
        "job": {"type": "string", "description": "Instead: a build job's id, to read how it went"}}},
    running="Building a model", failed="Could not build the model",
    run=run)
