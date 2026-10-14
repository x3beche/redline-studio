"""board_route: "lay out the fan board" - a board's placing and routing
started as the PCB room starts them (main.py `_as_job`: a job of its own,
backend/jobs.py, that a reload of the API neither stops nor waits for),
and, if asked, waited for a while; or a board job read by its id.

`both` is the room's Build: the whole pipeline - build the source, draw
the schematic, place, route, pour, DRC (POST /api/boards/{id}/run).
`place` and `route` are the layout step on its own (POST .../layout): from
the last build, placed and routed by the board's router - KiCad places
and the router follows in the one step; a board whose layout is held
keeps its placement and is only routed.

Freerouting only. A board set to route with TraceMaker in the room is not
started from here - TraceMaker runs are started by a person, in the room,
watching them - and the answer says so. One job per board at a time, as
in the room: a second is refused and the running one named.

What a job changes is the board's layout, made again from its source; it
is not undone (nothing written is set back), and the step says so."""

from __future__ import annotations

import asyncio
import json

from fastapi import HTTPException

from .. import ato, chat_undo, jobs, rules
from . import Ctx, Result, Tool, ToolError
from ._rights import need
from ._things import find

MAX_WAIT = 150                      # seconds a call may wait (ccgen.TOOL_TIMEOUT is 180)
STEPS = {"both": "run", "place": "layout", "route": "layout"}
FIGURE = {"unrouted": "unrouted nets", "drc": "DRC errors", "drc_warn": "DRC warnings", "erc": "ERC errors",
          "placed": "parts placed", "size": "mm", "engine": "router"}
SAID = {"run": "build, schematic, place, route, DRC", "layout": "place and route"}


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


def outcome(kind: str, got: dict | None) -> dict:
    """What came of a run or a layout: unrouted nets, DRC and ERC counts, the size."""
    got = got or {}
    lay = got.get("layout") if kind == "run" else got
    lay = lay or {}
    route, drc = lay.get("route") or {}, lay.get("drc") or {}
    erc = ((got.get("schematic") or {}).get("erc") or {}) if kind == "run" else {}
    return {k: v for k, v in {
        "unrouted": route.get("unrouted"), "drc": drc.get("error_count"), "drc_warn": drc.get("warning_count"),
        "erc": erc.get("error_count"), "placed": lay.get("placed"),
        "size": "x".join(str(x) for x in lay["size_mm"]) if isinstance(lay.get("size_mm"), list) else None,
        "engine": route.get("engine")}.items() if v is not None}


def _told(job: dict, title: str, bid: str) -> Result:
    st, jid, kind, secs = job.get("status"), job["_id"], job.get("kind") or "?", job.get("seconds")
    v = {"title": title, "board": bid, "job": jid, "kind": kind, "state": st}
    if st == "running":
        return Result(text=f"The {kind} of board {title} ({bid}) is running ({SAID.get(kind, kind)}): job {jid}, "
                           f"started {job.get('started_at')}. It goes on by itself; the PCB room's log follows it. "
                           "Read how it went with board_route and this job.",
                      say="Laying out {title}", vars=v, summary=f"running · {kind} · job {jid}")
    if st == "done":
        got = outcome(kind, jobs.result(job))
        v.update(state="ok", seconds=secs or 0, **got)
        figures = ", ".join(f"{got[k]} {FIGURE[k]}" if k != "engine" else f"{FIGURE[k]} {got[k]}"
                            for k in FIGURE if k in got)
        return Result(text=f"The {kind} of board {title} ({bid}) is done in {secs} s (job {jid}): "
                           + (figures or "no figures") + ". board_read gives the DRC and routing in full.",
                      say="Laid out {title} · {unrouted} unrouted · DRC {drc}" if "unrouted" in got
                          else "Laid out {title}", vars=v,
                      summary=f"ok · {secs} s · job {jid}" + (f"\n{figures}" if figures else ""))
    detail = job.get("detail")
    why = detail if isinstance(detail, str) else json.dumps(detail)[:1500] if detail else ""
    lines = [ln for ln in (why or "").strip().splitlines() if ln.strip()][-12:]
    v.update(state="failed", seconds=secs or 0, error=(lines[-1] if lines else "")[:80])
    return Result(text=f"The {kind} of board {title} ({bid}) {'was lost' if st == 'lost' else 'failed'} after "
                       f"{secs} s (job {jid}):\n" + ("\n".join(lines) or "(no error text)"),
                  say="Laying out {title} failed", vars=v, summary=f"{st} · job {jid}\n" + "\n".join(lines)[-400:])


async def start(kind: str, bid: str) -> dict:
    """The PCB room's own start of a job (main.py `_as_job`, detached): the job as it answers."""
    from .. import main
    got = await main._as_job(kind, bid, {}, True)
    return json.loads(bytes(got.body))


async def run(ctx: Ctx, args: dict) -> Result:
    db = chat_undo.inner(ctx.db)
    raw = getattr(db, "raw", db)
    jid = str(args.get("job") or "").strip()
    if jid:
        doc = await jobs.get(raw, jid)
        if not doc or doc.get("workspace") != getattr(db, "workspace", doc.get("workspace")):
            raise ToolError(f"no board job {jid} in this workspace")
        need("GET", f"/api/boards/{doc.get('board')}/jobs/{jid}")
        return _told(doc, doc.get("board") or "?", doc.get("board") or "?")
    ref = str(args.get("board") or "").strip()
    if not ref:
        raise ToolError("say which board (its id or title words - board_read lists them), or give a job to read")
    step = str(args.get("step") or "both").strip().lower()
    if step not in STEPS:
        raise ToolError("step is place, route or both")
    kind, wait = STEPS[step], _wait(args)
    d = await find(ctx.db, ato.BOARDS, ref, ("title", "folder"), "board")
    bid, title = d["_id"], d.get("title") or d["_id"]
    need("POST", f"/api/boards/{bid}/{kind}")
    if d.get("kind") == "imported":
        raise ToolError(f"board {title} was imported: it has no source to place and route - convert it in the PCB "
                        "room first")
    engine = ((d.get("rules") or {}).get("route") or {}).get("engine") or rules.ROUTE["engine"]
    if engine != "freerouting":
        raise ToolError(f"board {title} is set to route with {engine} in the PCB room. The Chat starts Freerouting "
                        "only - a TraceMaker run is started by a person in the room; or switch the board's router "
                        "to Freerouting there and ask again")
    try:
        started = await start(kind, bid)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {"detail": exc.detail}
        if exc.status_code == 409 and detail.get("job"):
            running = await jobs.get(raw, detail["job"]) or {"_id": detail["job"], "status": "running"}
            got = _told(running, title, bid)
            got.text = f"Not started: board {title} has a job running already. " + got.text
            got.vars["busy"] = 1
            return got
        raise ToolError(str(detail.get("detail") or exc.detail)[:400]) from None
    job = await jobs.get(raw, started["job"]) or {"_id": started["job"], "kind": kind, "status": "running",
                                                  "started_at": started.get("started_at")}
    if wait:
        try:
            job = await asyncio.wait_for(jobs.wait(raw, job["_id"]), wait)
        except asyncio.TimeoutError:
            job = await jobs.get(raw, job["_id"]) or job
            got = _told(job, title, bid)
            if job.get("status") == "running":
                got.text = f"Still running after {wait} s. " + got.text
            return got
    return _told(job, title, bid)


TOOL = Tool(
    name="board_route", package="pcb", level="change", order=42, default=False,
    undo="a layout is made again from the board's source and changes nothing written - there is nothing to undo",
    label="Place and route a board",
    about="Starts a board's placing and routing (Freerouting) as the PCB room does, and can wait for the result.",
    description="Place and route a board as the PCB room does, with Freerouting: step `both` (default) is the room's "
                "Build - build the source, draw the schematic, place, route, pour, DRC; `place` or `route` is the "
                "layout step alone, from the last build (KiCad places, the router follows; a held layout is only "
                "routed). It runs on the server for minutes. With `wait` (seconds, at most 150) the answer waits and "
                "says how it went - unrouted nets, DRC and ERC errors, the size - or the end of its error; else, or "
                "when it takes longer, it gives the job: read it later with `job` alone. A board set to TraceMaker "
                "is not started (a person starts those in the room); one job per board at a time. Use it only when "
                "asked to lay out or route a board. Not undoable (nothing to undo).",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id or title words"},
        "step": {"type": "string", "enum": list(STEPS), "description": "both (the room's Build), place or route"},
        "wait": {"type": "integer", "minimum": 0, "maximum": MAX_WAIT,
                 "description": "Seconds to wait for the result (0: answer at once with the job)"},
        "job": {"type": "string", "description": "Instead: a board job's id, to read how it went"}}},
    running="Starting the board's layout", failed="Could not lay out the board",
    run=run)
