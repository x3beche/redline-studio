"""The Tools tab's checks: what a tool wrote, tried for real.

Every check runs in the one tools image (docker/tools/tools.Dockerfile),
offline - `--network none` - as the host's user, with a memory cap, and is
thrown away afterwards. The image does the work (`check.py` in it); this is
only the door to it. The tool pages call it when they are shown inside the
app; opened on their own, they do without.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from collections import Counter

from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/tools")

# The tool pages themselves. Served from disk by the API rather than as the
# UI's static assets, so a tool added while the dev server runs is there at
# once, and the same path works in the production build.
PAGES = Path(__file__).resolve().parent.parent / "frontend" / "public" / "tools"


def mount(app: FastAPI) -> None:
    app.include_router(router)
    app.mount("/api/tools/files", StaticFiles(directory=PAGES, html=True), name="tool-files")

IMAGE = os.environ.get("X3_TOOLS_IMAGE", "redline-tools")
KINDS = ("sql", "prisma", "ts", "openapi", "mermaid", "regex", "cron", "pdftext")
BUILD = "docker build -f docker/tools/tools.Dockerfile -t redline-tools docker/tools"
LIMIT = 400_000                  # characters: a check is for a tool's output, not a dump
PDF_LIMIT = 20_000_000           # a datasheet PDF, as base64
TIMEOUT = 180
# Two at a time: a check starts a database or a browser, and a person
# pressing Check twice should not start four.
_slots = asyncio.Semaphore(2)


def have_image() -> bool:
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE],
                              capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


@router.get("/status")
def status() -> dict:
    return {"image": IMAGE, "ready": have_image(), "kinds": list(KINDS),
            "build": BUILD}


class CheckIn(BaseModel):
    kind: str
    input: str = ""
    # Kind-specific extras: regex {pattern, text, flags, python, pcre},
    # cron {tz, start, count}, ts {files}, mermaid {theme}.
    extra: dict = Field(default_factory=dict)


@router.post("/check")
async def check(body: CheckIn) -> dict:
    if body.kind not in KINDS:
        raise HTTPException(400, f"unknown check {body.kind!r}; one of {', '.join(KINDS)}")
    req = {**body.extra, "kind": body.kind, "input": body.input}
    payload = json.dumps(req)
    limit = PDF_LIMIT if body.kind == "pdftext" else LIMIT
    if len(payload) > limit:
        raise HTTPException(413, f"too large to check ({len(payload)} characters, "
                                 f"the limit is {limit})")
    if not have_image():
        raise HTTPException(503, f"the tools image is not built: {BUILD}")
    argv = ["docker", "run", "--rm", "-i", "--network", "none",
            "--user", f"{os.getuid()}:{os.getgid()}", "--memory", "2g", "--cpus", "2",
            "--pids-limit", "512", IMAGE]
    async with _slots:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(payload.encode()), TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(504, f"the check took longer than {TIMEOUT}s")
    try:
        return json.loads(out.decode() or "{}")
    except ValueError:
        raise HTTPException(500, "the check said nothing readable: "
                                 + (err.decode(errors="replace")[-400:] or "no output"))


# ================= the catalog, usage, running a tool, picking one =================
# Every tool has a manifest.json in its folder under PAGES - the kit tools
# (their folder also holds tool.js, which runs) and the older pages and
# calculators (a manifest only, so they can be found and described). The
# catalog is those manifests; nothing else lists the tools.

import re as _re
import time as _time
from datetime import datetime, timedelta, timezone

from . import tool_router

ID = _re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
EVENTS = ("open", "run", "copy", "check", "find", "manual", "favourite", "unfavourite")
USAGE = "tool_usage"
DATA = "tool_data"
_cache: dict = {"key": None, "tools": []}


def _db():
    from .main import db
    return db()


def catalog() -> list[dict]:
    files = sorted(PAGES.glob("*/manifest.json"))
    key = tuple((str(f), f.stat().st_mtime_ns) for f in files)
    if _cache["key"] == key:
        return _cache["tools"]
    tools = []
    for f in files:
        try:
            m = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        tid = m.get("id") or f.parent.name
        runnable = (f.parent / "tool.js").exists()
        tools.append({
            "id": tid, "name": m.get("name", tid), "blurb": m.get("blurb", ""),
            "group": m.get("group", "code"), "rooms": m.get("rooms") or [],
            "keywords": m.get("keywords") or [],
            # Where the page is: a kit tool's folder, an older single page, or
            # an Angular calculator (the app knows those by id).
            "src": m.get("page") or (f"/api/tools/files/{tid}/" if runnable else None),
            "native": bool(m.get("native")),
            "runnable": runnable,
        })
    tools.sort(key=lambda t: t["name"].lower())
    _cache.update(key=key, tools=tools)
    return tools


def manifest_of(tid: str) -> dict:
    if not ID.match(tid):
        raise HTTPException(400, "bad tool id")
    f = PAGES / tid / "manifest.json"
    if not f.exists():
        raise HTTPException(404, f"no tool called {tid}")
    return json.loads(f.read_text())


async def _record(tid: str, event: str, surface: str, extra: dict | None = None) -> None:
    """One use of a tool, stamped with who: the person, or the agent named
    by the request (X-Redline-Actor), as the audit trail stamps them."""
    try:
        from . import actors
        who = actors.current()
        await _db()[USAGE].insert_one({"tool": tid, "event": event, "surface": surface,
                                       "at": datetime.now(timezone.utc), "by": who, **(extra or {})})
    except Exception:                                    # noqa: BLE001 - never fatal
        pass


@router.get("/catalog")
async def get_catalog(days: int = 30) -> dict:
    tools = catalog()
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))
    counts: dict = {}
    try:
        async for row in _db()[USAGE].aggregate([
                {"$match": {"at": {"$gte": since}, "event": {"$in": ["open", "run"]}}},
                {"$group": {"_id": "$tool", "n": {"$sum": 1}, "last": {"$max": "$at"}}}]):
            counts[row["_id"]] = row
    except Exception:                                    # noqa: BLE001
        pass
    return {"tools": [{**t, "uses": counts.get(t["id"], {}).get("n", 0)} for t in tools],
            "days": days}


class UsageIn(BaseModel):
    id: str
    event: str
    surface: str = "ui"


@router.post("/usage", status_code=204)
async def post_usage(body: UsageIn) -> None:
    if not ID.match(body.id) or body.event not in EVENTS or body.surface not in ("ui", "mcp", "api"):
        raise HTTPException(400, "bad usage event")
    await _record(body.id, body.event, body.surface)


@router.get("/usage/summary")
async def usage_summary(days: int = 30) -> dict:
    """For the Analytics tab: which tools are used, how, by whom, and when."""
    days = max(1, min(days, 365))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    names = {t["id"]: t["name"] for t in catalog()}
    groups = {t["id"]: t["group"] for t in catalog()}
    by_tool: dict = {}
    by_day: Counter = Counter()
    by_surface: Counter = Counter()
    by_event: Counter = Counter()
    async for r in _db()[USAGE].find({"at": {"$gte": since}}, {"_id": 0}):
        t = by_tool.setdefault(r["tool"], {"id": r["tool"], "name": names.get(r["tool"], r["tool"]),
                                           "group": groups.get(r["tool"]), "total": 0})
        t[r["event"]] = t.get(r["event"], 0) + 1
        t["total"] += 1
        by_day[r["at"].strftime("%Y-%m-%d")] += 1
        by_surface[r.get("surface", "ui")] += 1
        by_event[r["event"]] += 1
    tools = sorted(by_tool.values(), key=lambda t: -t["total"])
    return {"days": days, "total": sum(by_event.values()), "tools_available": len(names),
            "tools_used": len(tools), "tools": tools,
            "by_day": [{"day": d, "n": by_day[d]} for d in sorted(by_day)],
            "by_surface": dict(by_surface), "by_event": dict(by_event),
            "unused": sorted(set(names) - set(by_tool))[:500]}


@router.get("/{tid}/manual")
async def manual(tid: str, surface: str = "api") -> dict:
    """Everything an agent needs to call a tool: what it answers, its inputs
    with units and defaults, an example, and how to run it."""
    m = manifest_of(tid)
    runnable = (PAGES / tid / "tool.js").exists()
    await _record(tid, "manual", surface if surface in ("ui", "mcp", "api") else "api")
    return {
        "id": tid, "name": m.get("name"), "blurb": m.get("blurb"), "rooms": m.get("rooms"),
        "intro": m.get("intro"), "usage": m.get("usage"), "sources": m.get("sources"),
        "inputs": [{k: d.get(k) for k in ("key", "label", "type", "unit", "default", "options",
                                          "help", "columns") if d.get(k) is not None}
                   for d in m.get("inputs") or []],
        "example": (m.get("examples") or [{}])[0].get("input"),
        "runnable": runnable,
        "how": ("Call run_tool with this id and an input object keyed by the inputs above. "
                "Numbers accept engineering notation as strings ('4k7', '100n'). "
                "The answer is {values, tables, texts, charts, warnings, notes}."
                if runnable else
                "This tool is interactive: open it in the Tools tab. It cannot be run by an agent."),
    }


class RunIn(BaseModel):
    id: str
    input: dict = Field(default_factory=dict)
    surface: str = "api"


@router.post("/run")
async def run_tool(body: RunIn) -> dict:
    if not ID.match(body.id) or not (PAGES / body.id / "tool.js").exists():
        raise HTTPException(404, f"no runnable tool called {body.id}")
    payload = json.dumps(body.input)
    if len(payload) > LIMIT:
        raise HTTPException(413, "input too large")
    if not have_image():
        raise HTTPException(503, f"the tools image is not built: {BUILD}")
    argv = ["docker", "run", "--rm", "-i", "--network", "none",
            "--user", f"{os.getuid()}:{os.getgid()}", "--memory", "512m", "--cpus", "1",
            "--pids-limit", "64", "-v", f"{PAGES}:/tools:ro", "--entrypoint", "node",
            IMAGE, "/tools/kit/cli.mjs", body.id]
    t0 = _time.monotonic()
    async with _slots:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(payload.encode()), 60)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(504, "the tool took longer than 60 s")
    await _record(body.id, "run", body.surface if body.surface in ("ui", "mcp", "api") else "api",
                  {"ms": round((_time.monotonic() - t0) * 1000)})
    try:
        return json.loads(out.decode() or "{}")
    except ValueError:
        raise HTTPException(500, "the tool said nothing readable: "
                                 + (err.decode(errors="replace")[-400:] or "no output"))


class FindIn(BaseModel):
    task: str
    room: str | None = None
    limit: int = 3
    surface: str = "api"


@router.post("/find")
async def find(body: FindIn) -> dict:
    """The best tools for a task, each with its manual - what an agent reads
    instead of the whole catalog."""
    if not body.task.strip():
        raise HTTPException(400, "describe the task")
    tools = catalog()
    res = await tool_router.pick(body.task, tools, max(1, min(body.limit, 5)), body.room)
    used = res.pop("usage", None)
    if used:
        try:
            from . import usage as _usage
            import uuid
            await _usage.record_call(
                _db(), _id=f"or:{uuid.uuid4().hex[:16]}", provider="openrouter",
                surface="tools", kind="tool-router", model=tool_router.summarise.MODEL,
                input=used.get("prompt_tokens") or 0, output=used.get("completion_tokens") or 0,
                cache_read=0, cache_write=0, thinking=0, cost_usd=used.get("cost"),
                cost_basis="billed", revision=None)
        except Exception:                                # noqa: BLE001
            pass
        res["prompt_tokens"] = used.get("prompt_tokens")
    surface = body.surface if body.surface in ("ui", "mcp", "api") else "api"
    res["picks"] = [{**p, "manual": await manual(p["id"], surface)} for p in res["picks"]]
    for p in res["picks"]:
        await _record(p["id"], "find", surface)
    return res


# ---------------- a project's shared notes, for the project tools ----------------
# Interface Contract, Project Constants, the Decision Log and their kind keep
# one document per tool and project here, so every room - and every agent,
# through the MCP server - reads the same thing.
class DataIn(BaseModel):
    data: dict


@router.get("/data/{tid}")
async def get_data(tid: str, project: str = "default") -> dict:
    manifest_of(tid)
    from . import scope
    doc = await _db()[DATA].find_one({"_id": scope.key(f"{tid}:{project}")}) or {}
    return {"id": tid, "project": project, "data": doc.get("data") or {},
            "updated": doc.get("updated")}


@router.put("/data/{tid}")
async def put_data(tid: str, body: DataIn, project: str = "default") -> dict:
    manifest_of(tid)
    blob = json.dumps(body.data)
    if len(blob) > 500_000:
        raise HTTPException(413, "too large")
    now = datetime.now(timezone.utc)
    from . import scope
    await _db()[DATA].update_one({"_id": scope.key(f"{tid}:{project}")},
                                 {"$set": {"data": body.data, "updated": now}}, upsert=True)
    return {"ok": True, "updated": now.isoformat()}
