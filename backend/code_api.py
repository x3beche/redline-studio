"""The coding rooms' API: projects, their pictures, their diffs, their tests.

Its own router rather than more of main.py: the other rooms are being
worked on in the same file at the same time, and this is a whole room's
worth of routes.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
import subprocess

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from . import apps, compute, firmware, phone, sandbox, store, webshot

router = APIRouter(prefix="/api/apps")


def _db():
    # Late: main imports this module, and db() lives there with the one
    # connection string.
    from .main import db
    return db()


async def _say(text: str, level: str = "info", room: str = "web") -> None:
    """A line in the coding room's own log. Each of the three has one, the
    way the board room has its own."""
    from .main import say
    try:
        await say(text, level, room)
    except Exception:                                # noqa: BLE001
        pass


async def _app(aid: str) -> dict:
    doc = await _db()[apps.APPS].find_one({"_id": aid})
    if not doc:
        raise HTTPException(404, aid)
    return doc


def _room(a: dict) -> str:
    return a.get("platform") or "web"


def _public(a: dict) -> dict:
    """A project as the page sees it. The test output's tail stays out of
    the list; the tests pane asks for it."""
    last = a.get("last_test")
    return {"_id": a["_id"], "title": a.get("title") or a["_id"],
            "platform": a.get("platform") or "web", "folder": a.get("folder", ""),
            "repo": a.get("repo"), "cwd": a.get("cwd") or "",
            "url": a.get("url"), "dev": a.get("dev"), "test": a.get("test"),
            "routes": a.get("routes") or ["/"],
            "build": a.get("build"), "firmware": a.get("firmware"),
            "target": firmware.target_of(a) if (a.get("platform") == "embedded") else None,
            "flashed": a.get("flashed"), "package": a.get("package"),
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
    # Firmware: stm32 or esp32; the build command, with $BUILD for
    # Redline's own output directory; the .elf in it when there is more
    # than one; and how to program a board ($ELF, $BUILD, $PORT).
    target: str | None = None
    build: str | None = None
    elf: str | None = None
    flash: str | None = None
    # A phone app: the Android package and activity to launch; without
    # them the url is opened in the phone's browser.
    package: str | None = None
    activity: str | None = None


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
    """Start the dev server, in the tab's container. For the agent."""
    a = await _app(aid)
    try:
        out = await asyncio.to_thread(apps.serve, a)
    except sandbox.NoImage as exc:
        raise HTTPException(503, str(exc))
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    if out.get("started"):
        await _say(f"{aid}: starting the dev server - {a.get('dev')}", "work",
                   _room(a))
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
    # Firmware's page is the one this server draws of it.
    if (a.get("platform") or "web") == "embedded":
        port = os.environ.get("API_PORT", "8000")
        return f"http://127.0.0.1:{port}/api/apps/{a['_id']}/firmware.html"
    base = (a.get("url") or "").rstrip("/")
    if not base:
        raise HTTPException(400, f"{a['_id']}: no url to photograph")
    if not route.startswith("/"):
        route = "/" + route
    return base + route


def _phone_shot(a: dict, route: str) -> dict:
    """The phone's screen, after bringing the project up on it, and what is
    on it: views from uiautomator, and a page's elements from Chrome."""
    st = phone.state()
    if not st["booted"]:
        raise RuntimeError("the phone is not running - the agent starts it "
                           "(revisions.py code phone)")
    phone.open_app(a, route)
    import time as _t
    _t.sleep(2.5)                     # let the screen settle after the launch
    png = phone.screen()
    w, h = phone.png_size(png)
    native = phone.parse_dump(phone.dump())
    elements = native
    if not a.get("package") and a.get("url"):
        try:
            elements = phone.web_inventory(a["url"], native, h) + [
                e for e in native if (e["own"].get("package") or "") != "com.android.chrome"]
            for i, e in enumerate(elements):
                e["i"] = i
        except (OSError, ValueError, RuntimeError, TimeoutError):
            pass                      # the views alone, if Chrome will not say
    return {"png": png, "width": w, "height": h, "title": a.get("title"),
            "url": a.get("url"), "elements": elements}


async def take_shot(db, a: dict, route: str, width: int, height: int) -> dict:
    """Photograph a route and keep the inventory for the marks. Shared by
    the freeze button and the agent's after shot."""
    job: dict = {}
    try:
        if (a.get("platform") or "web") == "mobile":
            shot = await asyncio.to_thread(_phone_shot, a, route)
        else:
            shot, job = await webshot.shoot_in_container(
                _page_url(a, route), width, height)
    finally:
        if job:
            try:
                await compute.record(db, "shot", await compute.current_revision(db, _room(a)),
                                     model=a["_id"], **job)
            except Exception:                        # noqa: BLE001
                pass
    try:
        base = await asyncio.to_thread(apps.head, a["repo"])
        dirty = await asyncio.to_thread(apps.dirty, a["repo"])
        await asyncio.to_thread(apps.snapshot, a["repo"], dirty)
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        base, dirty = None, {}
    sid = webshot.keep(shot, {"app": a["_id"], "route": route,
                              "base": base, "dirty": dirty})
    return {"shot": sid, "png": shot["png"], "width": shot.get("width", width),
            "height": shot.get("height", height),
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
    except sandbox.NoImage as exc:
        raise HTTPException(503, str(exc))
    except (RuntimeError, TimeoutError, OSError) as exc:
        raise HTTPException(502, f"could not photograph it: {exc}")
    png = got.pop("png")
    await _say(f"{aid}: froze {body.route} at {got['width']}x{got['height']} - "
               f"{got['elements']} elements on it", "info", _room(a))
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


def enrich(code: dict) -> dict:
    """Complete a note's code block from the shot it was drawn on.

    The page knows the route, the size and the marks; the server knows
    what the checkout looked like at the freeze - the commit and which
    files were already dirty - because it wrote that down when it took the
    picture. The dirty files are what keep somebody else's work out of the
    note's diff later, so they are copied onto the note rather than left in
    a cache that is pruned.
    """
    out = dict(code)
    sid = code.get("shot")
    if sid:
        try:
            s = webshot.recall(str(sid))
        except KeyError:
            return out
        out["dirty"] = s.get("dirty") or {}
        out["base"] = out.get("base") or s.get("base")
        out["app"] = s.get("app")
    return out


# ---------------- the diff ----------------
async def note_patch(db, doc: dict) -> tuple[str, bool]:
    """A note's change as a unified diff, and whether it was frozen.

    Live until the note is done: the files that moved since it was drawn,
    from its base commit. Done, it is the patch as it stood then, kept in
    GridFS - the checkout moves on and the card should still show its own
    change.
    """
    if (doc.get("artifacts") or {}).get("diff"):
        raw = await store.get_artifact(db, doc["_id"], "diff", "revisions")
        return raw.decode(errors="replace"), True
    code = doc.get("code") or {}
    a = await db[apps.APPS].find_one({"_id": doc.get("model") or ""})
    if not a:
        raise KeyError(f"no project {doc.get('model')}")
    base = code.get("base")
    if not base:
        raise ValueError("this note has no base commit to diff against")
    then = code.get("dirty") or {}
    paths = await asyncio.to_thread(apps.changed_since, a["repo"], base, then)
    return await asyncio.to_thread(apps.patch, a["repo"], base, paths, then), False


async def freeze_patch(db, rid: str, text: str) -> dict:
    """Keep a done note's patch. Text, gzipped into GridFS like every other
    generated file - a patch can be megabytes and the link is slow."""
    return await store.put_artifact(db, rid, "diff", text.encode(), "revisions")


async def note_diff(db, rid: str) -> dict:
    doc = await db.revisions.find_one({"_id": rid})
    if not doc:
        raise HTTPException(404, rid)
    try:
        text, frozen = await note_patch(db, doc)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {**apps.parse(text), "base": (doc.get("code") or {}).get("base"),
            "frozen": frozen, "note": rid, "patch_bytes": len(text)}


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
    await _say(f"{aid}: running the tests - {a.get('test')}", "work", _room(a))
    try:
        out = await apps.run_test(_db(), a)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    c = out["counts"]
    said = ", ".join(f"{v} {k}" for k, v in c.items()) or f"exit {out['rc']}"
    await _say(f"{aid}: tests {'passed' if out['ok'] else 'FAILED'} - {said} "
               f"in {out['wall_s']:.1f} s", "done" if out["ok"] else "error",
               _room(a))
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


# ---------------- the phone ----------------
@router.get("/phone/state")
async def phone_state():
    return await asyncio.to_thread(phone.state)


@router.post("/phone/boot")
async def phone_boot():
    """For the agent: the room has no power button either."""
    try:
        return await asyncio.to_thread(phone.boot)
    except sandbox.NoImage as exc:
        raise HTTPException(503, str(exc))
    except (TimeoutError, subprocess.CalledProcessError) as exc:
        raise HTTPException(502, str(exc))


@router.get("/phone/screen.png")
async def phone_screen():
    """The phone's screen now. The room polls this for its live view."""
    st = await asyncio.to_thread(phone.state)
    if not st["booted"]:
        raise HTTPException(503, "the phone is not running")
    png = await asyncio.to_thread(phone.screen)
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


# ---------------- firmware ----------------
@router.post("/{aid}/build")
async def build_app(aid: str):
    """Build firmware in the Embedded image. For the agent: the room has
    no build button, the person marks and the agent builds."""
    a = await _app(aid)
    if (a.get("platform") or "web") != "embedded":
        raise HTTPException(400, f"{aid} is not firmware")
    await _say(f"{aid}: building - {a.get('build')}", "work", "embedded")
    try:
        out = await firmware.build(_db(), a)
    except sandbox.NoImage as exc:
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    s = out.get("summary") or {}
    flash = next((r for r in s.get("regions", []) if r["name"].upper() == "FLASH"), None)
    await _say(f"{aid}: build {'done' if out['ok'] else 'FAILED'} in "
               f"{out.get('wall_s') or 0:.1f} s"
               + (f" - flash {flash['pct']:.2f}%" if flash else ""),
               "done" if out["ok"] else "error", "embedded")
    return {k: v for k, v in out.items() if k != "log"}


@router.get("/hardware/boards")
async def list_boards():
    """STM32 probes and ESP32 boards plugged into this machine."""
    return await asyncio.to_thread(firmware.boards)


@router.get("/{aid}/firmware.json")
async def firmware_json(aid: str):
    """The last build as data: regions, symbols with their files, and the
    build before it, for the room's own firmware pane."""
    await _app(aid)
    try:
        raw = await store.get_artifact(_db(), aid, "firmware", apps.APPS)
    except KeyError:
        return None
    return Response(raw, media_type="application/json")


@router.post("/{aid}/flash")
async def flash_app(aid: str, port: str | None = None):
    """Program the board. For the agent; the room has no button."""
    a = await _app(aid)
    try:
        out = await firmware.flash(_db(), a, port)
    except sandbox.NoImage as exc:
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await _say(f"{aid}: programmed the {out['target']} "
               + ("- verified" if out["ok"] else "FAILED"),
               "done" if out["ok"] else "error", "embedded")
    return out


@router.get("/{aid}/firmware.elf")
async def firmware_elf(aid: str):
    """The last build's image, for a debugger or a programmer of one's own."""
    a = await _app(aid)
    fw = a.get("firmware") or {}
    path = firmware.build_dir(aid) / (fw.get("elf") or "")
    if not fw.get("ok") or not path.is_file():
        raise HTTPException(404, "not built")
    return Response(path.read_bytes(), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{path.name}"'})


@router.get("/{aid}/firmware.html")
async def firmware_page(aid: str):
    a = await _app(aid)
    try:
        import json as _json
        data = _json.loads(await store.get_artifact(_db(), aid, "firmware", apps.APPS))
    except KeyError:
        data = {}
    return Response(firmware.page(a.get("title") or aid, data),
                    media_type="text/html")


@router.get("/{aid}/build-log")
async def build_log(aid: str):
    a = await _app(aid)
    return {"lines": (a.get("firmware_log") or "").splitlines()[-300:],
            "firmware": a.get("firmware")}


@router.get("/{aid}/compute")
async def app_compute(aid: str, limit: int = 12):
    """What this project's shots and test runs have cost the machine."""
    rows = [r async for r in _db()[compute.JOBS]
            .find({"model": aid}, {"_id": 0}).sort("at", -1).limit(limit)]
    total = {"jobs": len(rows),
             "wall_s": round(sum(r.get("wall_s") or 0 for r in rows), 2),
             "cpu_s": round(sum(r.get("cpu_s") or 0 for r in rows), 2)}
    return {"app": aid, "jobs": rows, "total": total}
