"""The coding rooms' API: projects, their pictures, their diffs, their tests.

Its own router rather than more of main.py: the other rooms are being
worked on in the same file at the same time, and this is a whole room's
worth of routes.
"""

from __future__ import annotations

import asyncio
import base64
import re
import subprocess

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import apps, compute, store, webshot

router = APIRouter(prefix="/api/apps")


def _db():
    # Late: main imports this module, and db() lives there with the one
    # connection string.
    from .main import db
    return db()


async def _say(text: str, level: str = "info") -> None:
    from .main import say
    try:
        await say(text, level)
    except Exception:                                # noqa: BLE001
        pass


async def _app(aid: str) -> dict:
    doc = await _db()[apps.APPS].find_one({"_id": aid})
    if not doc:
        raise HTTPException(404, aid)
    return doc


def _public(a: dict) -> dict:
    """A project as the page sees it. The test output's tail stays out of
    the list; the tests pane asks for it."""
    last = a.get("last_test")
    return {"_id": a["_id"], "title": a.get("title") or a["_id"],
            "platform": a.get("platform") or "web", "folder": a.get("folder", ""),
            "repo": a.get("repo"), "cwd": a.get("cwd") or "",
            "url": a.get("url"), "dev": a.get("dev"), "test": a.get("test"),
            "routes": a.get("routes") or ["/"],
            "last_test": ({k: v for k, v in last.items() if k != "tail"}
                          if last else None)}


class AppIn(BaseModel):
    title: str | None = None
    platform: str = "web"
    repo: str
    cwd: str | None = None
    url: str | None = None
    dev: str | None = None
    test: str | None = None
    routes: list[str] | None = None
    folder: str | None = None


@router.get("")
async def list_apps():
    rows = [a async for a in _db()[apps.APPS].find({})]
    rows.sort(key=lambda a: a["_id"])
    return [_public(a) for a in rows]


@router.get("/{aid}")
async def one_app(aid: str):
    return _public(await _app(aid))


@router.put("/{aid}")
async def save_app(aid: str, body: AppIn):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", aid):
        raise HTTPException(400, "id: letters, digits, - and _")
    try:
        patch = apps.clean(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    patch.setdefault("title", aid)
    patch["saved_at"] = store.now()
    await _db()[apps.APPS].update_one({"_id": aid}, {"$set": patch}, upsert=True)
    return _public(await _app(aid))


@router.post("/{aid}/move")
async def move_app(aid: str, folder: str = ""):
    """Put a project in a folder. Like a board, its id is not a path."""
    d = _db()
    if folder and not await d.folders.find_one({"_id": folder}):
        raise HTTPException(404, f"no folder {folder}")
    got = await d[apps.APPS].update_one({"_id": aid}, {"$set": {"folder": folder}})
    if not got.matched_count:
        raise HTTPException(404, aid)
    return {"app": aid, "folder": folder}


@router.delete("/{aid}")
async def drop_app(aid: str):
    """Forget the project. The checkout on disk is not touched."""
    got = await _db()[apps.APPS].delete_one({"_id": aid})
    if not got.deleted_count:
        raise HTTPException(404, aid)
    return {"id": aid, "deleted": True}


@router.get("/{aid}/status")
async def app_status(aid: str):
    """Is it serving, and what state is the checkout in."""
    a = await _app(aid)
    up = await asyncio.to_thread(apps.answers, a.get("url") or "")
    try:
        sha = await asyncio.to_thread(apps.head, a["repo"])
        br = await asyncio.to_thread(apps.branch, a["repo"])
        dirty = await asyncio.to_thread(apps.dirty, a["repo"])
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        return {"up": up, "git": None, "error": str(exc)}
    return {"up": up, "git": {"head": sha, "short": sha[:8], "branch": br,
                              "dirty": len(dirty)}}


@router.post("/{aid}/serve")
async def serve_app(aid: str):
    a = await _app(aid)
    out = await asyncio.to_thread(apps.serve, a)
    if out.get("started"):
        await _db()[apps.APPS].update_one({"_id": aid},
                                          {"$set": {"served_pid": out["pid"]}})
        await _say(f"{aid}: starting the dev server - {a.get('dev')}", "work")
    return out


@router.get("/{aid}/server-log")
async def app_server_log(aid: str, limit: int = 200):
    await _app(aid)
    return {"lines": apps.server_log(aid, limit)}


# ---------------- the picture ----------------
class ShotIn(BaseModel):
    route: str = "/"
    width: int = Field(default=1280, ge=240, le=3840)
    height: int = Field(default=800, ge=240, le=2400)


def _page_url(a: dict, route: str) -> str:
    base = (a.get("url") or "").rstrip("/")
    if not base:
        raise HTTPException(400, f"{a['_id']}: no url to photograph")
    if not route.startswith("/"):
        route = "/" + route
    return base + route


async def take_shot(db, a: dict, route: str, width: int, height: int) -> dict:
    """Photograph a route and keep the inventory for the marks. Shared by
    the freeze button and the agent's after shot."""
    url = _page_url(a, route)
    job: dict = {}
    try:
        shot = await asyncio.to_thread(webshot.shoot, url, width, height,
                                       25, job)
    finally:
        if job:
            try:
                await compute.record(db, "shot", await compute.current_revision(db),
                                     model=a["_id"], **job)
            except Exception:                        # noqa: BLE001
                pass
    try:
        base = await asyncio.to_thread(apps.head, a["repo"])
        dirty = await asyncio.to_thread(apps.dirty, a["repo"])
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        base, dirty = None, {}
    sid = webshot.keep(shot, {"app": a["_id"], "route": route,
                              "base": base, "dirty": dirty})
    return {"shot": sid, "png": shot["png"], "width": width, "height": height,
            "elements": len(shot["elements"]), "title": shot.get("title"),
            "base": base, "wall_s": job.get("wall_s")}


@router.post("/{aid}/shot")
async def shoot_app(aid: str, body: ShotIn):
    """Freeze: a real screenshot of the route at this size.

    The picture comes back inline so the page can draw on it at once; the
    element list stays here, and the marks are laid on it by `/under`.
    """
    a = await _app(aid)
    try:
        got = await take_shot(_db(), a, body.route, body.width, body.height)
    except (RuntimeError, TimeoutError, OSError) as exc:
        raise HTTPException(502, f"could not photograph it: {exc}")
    png = got.pop("png")
    await _say(f"{aid}: froze {body.route} at {body.width}x{body.height} - "
               f"{got['elements']} elements on it", "info")
    return {**got, "image": "data:image/png;base64,"
            + base64.b64encode(png).decode()}


class MarkBox(BaseModel):
    box: list[float] = Field(min_length=4, max_length=4)
    tip: list[float] | None = None


class UnderIn(BaseModel):
    marks: list[MarkBox]


@router.post("/shots/{sid}/under")
async def under_marks(sid: str, body: UnderIn):
    """What the marks landed on, as a note keeps it."""
    try:
        s = webshot.recall(sid)
    except KeyError:
        raise HTTPException(404, "that picture is gone - freeze again")
    a = await _app(s["app"])
    hits = webshot.under(s["elements"], [m.model_dump() for m in body.marks],
                         width=s.get("width"), height=s.get("height"))
    rows = [webshot.describe(a["repo"], e) for e in hits]
    return {"dom": rows, "labels": [webshot.label(r) for r in rows]}


@router.get("/shots/{sid}.png")
async def shot_png(sid: str):
    try:
        return Response(webshot.picture(sid), media_type="image/png")
    except KeyError:
        raise HTTPException(404, sid)


# ---------------- the diff ----------------
async def note_diff(db, rid: str) -> dict:
    """What changed since a note was drawn. Frozen onto the note when it
    is done, so the card still shows its own change after the checkout
    has moved on."""
    doc = await db.revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    frozen = (doc.get("artifacts") or {}).get("diff")
    if frozen:
        import json
        raw = await store.get_artifact(db, rid, "diff", "revisions")
        return {**json.loads(raw), "frozen": True}
    code = doc.get("code") or {}
    a = await _app(doc.get("model") or "")
    base = code.get("base")
    if not base:
        raise HTTPException(400, "this note has no base commit to diff against")
    paths = await asyncio.to_thread(apps.changed_since, a["repo"], base,
                                    code.get("dirty") or {})
    text = await asyncio.to_thread(apps.patch, a["repo"], base, paths)
    return {**apps.parse(text), "base": base, "frozen": False,
            "note": rid, "patch_bytes": len(text)}


@router.get("/{aid}/diff")
async def app_diff(aid: str, note: str | None = None):
    """The working tree against HEAD, or one note's own change."""
    if note:
        return await note_diff(_db(), note)
    a = await _app(aid)
    try:
        base = await asyncio.to_thread(apps.head, a["repo"])
        dirty = await asyncio.to_thread(apps.dirty, a["repo"])
        text = await asyncio.to_thread(apps.patch, a["repo"], base, sorted(dirty))
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(400, str(exc))
    return {**apps.parse(text), "base": base, "frozen": False, "note": None,
            "patch_bytes": len(text)}


# ---------------- the check ----------------
@router.post("/{aid}/test")
async def test_app(aid: str):
    a = await _app(aid)
    await _say(f"{aid}: running the tests - {a.get('test')}", "work")
    try:
        out = await apps.run_test(_db(), a)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    c = out["counts"]
    said = ", ".join(f"{v} {k}" for k, v in c.items()) or f"exit {out['rc']}"
    await _say(f"{aid}: tests {'passed' if out['ok'] else 'FAILED'} - {said} "
               f"in {out['wall_s']:.1f} s", "done" if out["ok"] else "error")
    return out


@router.get("/{aid}/test")
async def last_test(aid: str):
    a = await _app(aid)
    last = a.get("last_test")
    if not last:
        return None
    try:
        now = await asyncio.to_thread(apps.tree_digest, a["repo"])
        head = await asyncio.to_thread(apps.head, a["repo"])
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        now, head = None, None
    # A pass is only worth something for the tree it ran on.
    return {**last, "current": last.get("tree") == now and last.get("head") == head}


@router.get("/{aid}/compute")
async def app_compute(aid: str, limit: int = 12):
    """What this project's shots and test runs have cost the machine."""
    rows = [r async for r in _db()[compute.JOBS]
            .find({"model": aid}, {"_id": 0}).sort("at", -1).limit(limit)]
    total = {"jobs": len(rows),
             "wall_s": round(sum(r.get("wall_s") or 0 for r in rows), 2),
             "cpu_s": round(sum(r.get("cpu_s") or 0 for r in rows), 2)}
    return {"app": aid, "jobs": rows, "total": total}
