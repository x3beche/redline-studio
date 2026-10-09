"""firmware_build: how a firmware's last builds went - status, errors and
warnings with file:line, flash and RAM use - as the Firmware room's
Status tab reads them (backend/fwbuild.py: the firmware's `build` summary
and the build jobs), or the workspace's firmwares when none is named."""

from __future__ import annotations

from .. import firmware, fwbuild
from . import Ctx, Result, Tool, clip
from ._things import find, rows

MAX_BUILDS = 5
MAX_DIAG = 30                       # errors (and warnings) written out per build


def _diag(items: list[dict]) -> list[str]:
    out = []
    for e in items[:MAX_DIAG]:
        where = e.get("file") or "?"
        if e.get("line"):
            where += f":{e['line']}" + (f":{e['col']}" if e.get("col") else "")
        out.append(f"  {where}: {e.get('text')}")
    if len(items) > MAX_DIAG:
        out.append(f"  ... and {len(items) - MAX_DIAG} more")
    return out


def _use(what: str, u: dict | None) -> str:
    return f"{what} {u['pct']}% ({u['used']:,} of {u['total']:,} bytes)" if u else f"{what} ?"


def _summary(b: dict) -> list[str]:
    out = [f"Last build: {b.get('state')} - firmware version {b.get('version')}, at {b.get('at')}, "
           f"{b.get('seconds')} s" + (f", because {b['why']}" if b.get("why") else "") + f" (job {b.get('job')})",
           f"{_use('Flash', b.get('flash'))}; {_use('RAM', b.get('ram'))}",
           f"{b.get('error_count', 0)} error(s), {b.get('warning_count', 0)} warning(s)"]
    if b.get("errors"):
        out += ["Errors:", *_diag(b["errors"])]
    if b.get("warnings"):
        out += ["Warnings:", *_diag(b["warnings"])]
    if b.get("detail"):
        out.append("Why it did not run: " + str(b["detail"])[:1500])
    if b.get("artifacts"):
        out.append(f"Files to flash from version {b.get('artifacts_version')}: "
                   + ", ".join(f"{k} {v.get('bytes'):,} bytes" for k, v in b["artifacts"].items()
                               if isinstance(v, dict) and v.get("bytes")))
    return out


async def _listing(ctx: Ctx) -> Result:
    found = await rows(ctx.db, firmware.COLL, ("title", "name", "board", "mcu_title", "build", "version"))
    if not found:
        return Result(text="There is no firmware in this workspace.", say="No firmware here", summary="none")
    lines = [f"{d['_id']}  \"{d.get('title')}\"  board {d.get('board')}  {d.get('mcu_title') or ''}  v{d.get('version')}"
             + (f"  last build {(d.get('build') or {}).get('state')} at {(d.get('build') or {}).get('at')}"
                if d.get("build") else "  never built") for d in found]
    text = f"{len(found)} firmware(s) in this workspace. Read one's builds with firmware_build and its id:\n" + "\n".join(lines)
    return Result(text=clip(text), say="Listed {n} firmwares", vars={"n": len(found)},
                  summary="\n".join(f"{d['_id']} {d.get('title')}" for d in found[:20]))


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("firmware") or "").strip()
    if not ref:
        return await _listing(ctx)
    try:
        n = max(1, min(int(args.get("builds") or 1), MAX_BUILDS))
    except (TypeError, ValueError):
        n = 1
    fw = await find(ctx.db, firmware.COLL, ref, ("title", "name", "board", "mcu_title"), "firmware")
    fid = fw["_id"]
    out = [f"Firmware {fid} \"{fw.get('title')}\" for board {fw.get('board')} ({fw.get('mcu')} "
           f"{fw.get('mcu_title') or ''}), {fw.get('platform') or '?'} {fw.get('framework') or ''} "
           f"env {fw.get('env') or '?'}; source version {fw.get('version')}"]
    b = fw.get("build") or {}
    out += _summary(b) if b else ["Never built."]
    raw, ws = getattr(ctx.db, "raw", ctx.db), getattr(ctx.db, "workspace", "default")
    jobs = await fwbuild.latest(raw, fid, ws, n + 1)
    if jobs and jobs[0].get("status") == "running":
        out.insert(1, f"A build is running now (job {jobs[0]['job']}, started {jobs[0].get('started_at')}).")
    older = [j for j in jobs if j["job"] != b.get("job") and j.get("status") != "running"][: max(0, n - 1)]
    for j in older:
        r = j.get("result") or {}
        out.append(f"Earlier build {j['job']}: {j.get('status')}, version {j.get('version')}, "
                   f"{j.get('started_at')}, {j.get('seconds')} s; "
                   + (f"{'ok' if r.get('ok') else 'failed'}, {r.get('error_count', 0)} error(s), "
                      f"{r.get('warning_count', 0)} warning(s); {_use('Flash', r.get('flash'))}; {_use('RAM', r.get('ram'))}"
                      if r else (j.get("detail") or "no result")[:400]))
        if r.get("errors"):
            out += _diag(r["errors"])[:10]
    v = {"firmware": fid, "title": fw.get("title") or fid, "state": b.get("state") or "never built",
         "errors": b.get("error_count", 0), "warnings": b.get("warning_count", 0)}
    summary = (f"{b.get('state')} · {b.get('error_count', 0)} errors · {b.get('warning_count', 0)} warnings · "
               f"{_use('flash', b.get('flash'))}" if b else "never built")
    say = "Read the last build of {title}: {state}" if b else "{title} was never built"
    return Result(text=clip("\n".join(out)), say=say, vars=v, summary=summary)


TOOL = Tool(
    name="firmware_build", level="read", order=66,
    label="Firmware builds",
    about="Reads a firmware's last builds: status, errors and warnings, flash and RAM.",
    description="How a firmware project (the Firmware room, PlatformIO) last built: ok / errors / failed, "
                "when and how long, each error and warning as file:line:col and message, flash and RAM use, "
                "the files to flash; `builds` > 1 also the earlier builds. It only reads - it never starts "
                "a build. Without `firmware` it lists the firmwares. Name it by id, title or board.",
    schema={"type": "object", "properties": {
        "firmware": {"type": "string", "description": "The firmware's id or title; leave out to list"},
        "builds": {"type": "integer", "minimum": 1, "maximum": MAX_BUILDS, "description": "How many builds (default 1)"}}},
    running="Reading the firmware builds", failed="Could not read the firmware builds",
    run=run)
