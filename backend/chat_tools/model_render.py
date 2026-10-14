"""model_render: "show me the lid" - a 3D model photographed from the views
asked for, or a board's 3D, and shown in the Chat as pictures.

The pictures are taken the way the Taste room's reference renders are
(backend/taste.py `render_views`: tools/render.py in one headless browser,
the model's last build); a board's by tools/render.py board:<id>, the PCB
room's 3D tab - or, when the board has no 3D yet, its drawings of the top
and the bottom are shown instead.

Where they live: in Files, Chat/Renders, as PNGs kept by the asker with
their context (the model, the build version, the view, the size) - so the
step points at them by their Files ids, the conversation shows them again
when it is opened later, they open in the Chat's file viewer, and the same
view of the same build at the same size is never rendered twice (the cache
is that context, in any conversation; a file deleted is simply rendered
again). The first picture also goes to a model that reads images.

A model being built (or queued for a linked rebuild) or whose last build
failed is not photographed: the tool says so instead. Views are capped at
MAX_VIEWS and the size at the presets of SIZES."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path

from .. import actors, files, links, taste
from . import Ctx, Result, Tool, ToolError, size
from ._rights import need
from ._things import find

VIEWS = ("iso", "iso-back", "front", "right", "top", "detail")   # tools/render.py VIEWS
MAX_VIEWS = 4
SIZES = {"small": (640, 428), "medium": (960, 640), "large": (1200, 800)}
FOLDER = "Chat/Renders"
TIMEOUT = 150.0                     # under ccgen's TOOL_TIMEOUT: a clean "took too long" of its own
ROOT = Path(__file__).resolve().parents[2]


async def render_views(db, model: str, views: tuple[str, ...], wh: tuple[int, int]) -> dict[str, bytes]:
    """{view: PNG} of the model's last build (the Taste renders' way)."""
    return await taste.render_views(db, model, views, wh)


async def render_board(db, board: str, wh: tuple[int, int]) -> bytes:
    """The board's 3D as the PCB room's 3D tab shows it, one PNG."""
    try:
        session = await taste._page_session(db)
    except PermissionError as exc:
        raise RuntimeError(f"no page session for the browser: {exc}") from exc
    work = Path(tempfile.mkdtemp(prefix="redline-chatshot-"))
    env = {k: v for k, v in os.environ.items() if k not in ("REDLINE_TOKEN", "REDLINE_PAGE_SESSION")}
    env["REDLINE_API"] = f"http://127.0.0.1:{os.environ.get('API_PORT', '8000')}"
    env["REDLINE_TOKEN"] = ""
    if session:
        env["REDLINE_PAGE_SESSION"] = json.dumps(session)
    out = work / "board.png"
    argv = [sys.executable, str(ROOT / "tools" / "render.py"), f"board:{board}", "--width", str(wh[0]),
            "--height", str(wh[1]), "--free-aspect", "--no-wait", "--allow-stale", "-o", str(out)]
    try:
        async with taste._RENDERING:
            proc = await asyncio.create_subprocess_exec(*argv, env=env, cwd=str(ROOT), stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.STDOUT)
            try:
                said, _ = await proc.communicate()
            except asyncio.CancelledError:
                proc.send_signal(signal.SIGINT)        # render.py closes its browser
                try:
                    await asyncio.wait_for(proc.wait(), 20)
                except asyncio.TimeoutError:
                    proc.kill()
                raise
        if not out.exists():
            lines = [ln for ln in said.decode(errors="replace").splitlines() if ln.strip() and not ln.startswith(" ")]
            raise RuntimeError((lines[-1] if lines else f"render.py exited {proc.returncode}")[:300])
        return out.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _views(raw) -> list[str]:
    if raw in (None, "", []):
        return ["iso"]
    asked = [str(v).strip().lower() for v in (raw if isinstance(raw, list) else str(raw).split(","))]
    asked = [{"back": "iso-back", "side": "right", "close": "detail", "isometric": "iso"}.get(v, v)
             for v in asked if v]
    bad = [v for v in asked if v not in VIEWS]
    if bad:
        raise ToolError(f"no view {', '.join(bad)} - the views are {', '.join(VIEWS)}")
    seen = list(dict.fromkeys(asked))
    if len(seen) > MAX_VIEWS:
        raise ToolError(f"at most {MAX_VIEWS} views a time")
    return seen


async def _cached(db, key: str, version, view: str, wh: str) -> dict | None:
    return await db[files.COLL].find_one({"context.render": key, "context.version": version,
                                          "context.view": view, "context.size": wh})


async def _keep(ctx: Ctx, title: str, key: str, version, view: str, wh: str, png: bytes) -> dict:
    by = ctx.actor or actors.current() or {}
    folder = await files.make_path(ctx.db, FOLDER, by)
    name = f"{title} - {view} v{version}.png".replace("/", "-")[:120]
    context = {"room": "commandcode", "render": key, "version": version, "view": view, "size": wh,
               **({"chat": ctx.chat} if ctx.chat else {})}
    return await files.put(ctx.db, name, png, "image/png", context, by, note=f"Rendered for the Chat: {key} {view}",
                           folder=folder["_id"])


async def _model(ctx: Ctx, ref: str, views: list[str], wh: tuple[int, int]) -> Result:
    d = await find(ctx.db, "models", ref, ("title", "name"), "3D model")
    mid, title = d["_id"], d.get("title") or d.get("name") or d["_id"]
    if d.get("building") or (d.get("link") or {}).get("state") in links.UPDATING:
        raise ToolError(f"{title} is being built right now - nothing current to show; ask again when its build is done")
    if d.get("error"):
        raise ToolError(f"{title}'s last build failed, so there is no current shape to show - fix the build first "
                        f"(model_read says the error): {str(d['error']).strip().splitlines()[-1][:200]}")
    built = d.get("built") or {}
    if not (d.get("artifacts") or {}).get("viewer") or not built:
        raise ToolError(f"{title} has never been built - nothing to photograph")
    version, sz = built.get("version"), f"{wh[0]}x{wh[1]}"
    key = f"model:{mid}"
    got: dict[str, dict] = {}
    for v in views:
        hit = await _cached(ctx.db, key, version, v, sz)
        if hit:
            got[v] = hit
    todo = [v for v in views if v not in got]
    pngs: dict[str, bytes] = {}
    if todo:
        try:
            pngs = await asyncio.wait_for(render_views(ctx.db, mid, tuple(todo), wh), TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise ToolError(f"the render took longer than {TIMEOUT:.0f} s") from exc
        except RuntimeError as exc:
            raise ToolError(f"the renderer could not photograph {title}: {exc}") from exc
        for v, png in pngs.items():
            got[v] = await _keep(ctx, title, key, version, v, sz, png)
    shots = [(v, got[v]) for v in views if v in got]
    if not shots:
        raise ToolError(f"the renderer gave no picture of {title}")
    first = pngs.get(shots[0][0])
    if first is None and ctx.vision:
        _, first = await files.get(ctx.db, shots[0][1]["_id"])
    note = (f" It changed since that build (now v{d.get('version')}): the pictures show build v{version}."
            if d.get("stale") else "")
    text = (f"Rendered {title} ({mid}), build v{version}, {sz}: " + ", ".join(
        f"{v} -> file {f['_id']}" + (" (kept from before)" if v not in pngs else "") for v, f in shots)
        + f". The Chat shows the pictures under this step; they are kept in Files > {FOLDER}." + note)
    return Result(text=text, say="Rendered {title} · {n} views",
                  vars={"title": title, "model": mid, "n": len(shots), "version": version,
                        **{f"shot{i}": f"{v}:{f['_id']}" for i, (v, f) in enumerate(shots)}},
                  summary=f"{len(shots)} view(s) of v{version} · {size(sum(f.get('bytes') or 0 for _, f in shots))}"
                          + (f" · {len(shots) - len(pngs)} from the cache" if len(pngs) < len(shots) else ""),
                  image=first)


async def _board(ctx: Ctx, ref: str, wh: tuple[int, int]) -> Result:
    from .. import ato
    d = await find(ctx.db, ato.BOARDS, ref, ("title", "folder"), "board")
    bid, title = d["_id"], d.get("title") or d["_id"]
    if d.get("building") or (d.get("link") or {}).get("state") in links.UPDATING:
        raise ToolError(f"board {title} is being built right now - ask again when its build is done")
    arts = d.get("artifacts") or {}
    at = (arts.get("model3d") or {}).get("at")
    if not at:
        drawn = [(v, f"@{a}") for v, a in (("top", "layout"), ("bottom", "bottom")) if a in arts]
        if not drawn:
            raise ToolError(f"board {title} has no 3D and no drawing yet - build it first")
        return Result(text=f"Board {title} ({bid}) has no 3D model yet; the Chat shows its drawings of the "
                           f"{' and '.join(v for v, _ in drawn)} instead (/api/boards/{bid}/layout.svg).",
                      say="Showed the drawings of {title}",
                      vars={"title": title, "board": bid, "n": len(drawn),
                            **{f"shot{i}": f"{v}:{r}" for i, (v, r) in enumerate(drawn)}},
                      summary="no 3D yet: the board's drawings")
    sz, key = f"{wh[0]}x{wh[1]}", f"board:{bid}"
    hit = await _cached(ctx.db, key, at, "3d", sz)
    png = None
    if not hit:
        try:
            png = await asyncio.wait_for(render_board(ctx.db, bid, wh), TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise ToolError(f"the render took longer than {TIMEOUT:.0f} s") from exc
        except RuntimeError as exc:
            raise ToolError(f"the renderer could not photograph board {title}: {exc}") from exc
        hit = await _keep(ctx, title, key, at, "3d", sz, png)
    elif ctx.vision:
        _, png = await files.get(ctx.db, hit["_id"])
    return Result(text=f"Rendered board {title} ({bid}) in 3D as the PCB room shows it, {sz}: file {hit['_id']}. "
                       f"The Chat shows the picture under this step; it is kept in Files > {FOLDER}.",
                  say="Rendered {title} · {n} views",
                  vars={"title": title, "board": bid, "n": 1, "shot0": f"3d:{hit['_id']}"},
                  summary=f"3D of the board · {size(hit.get('bytes') or 0)}", image=png)


async def run(ctx: Ctx, args: dict) -> Result:
    wh = SIZES.get(str(args.get("size") or "medium").lower())
    if not wh:
        raise ToolError(f"size is one of {', '.join(SIZES)}")
    need("POST", "/api/files")
    if args.get("board"):
        return await _board(ctx, str(args["board"]), wh)
    if args.get("model"):
        return await _model(ctx, str(args["model"]), _views(args.get("views")), wh)
    raise ToolError("say which 3D model (model) or board (board) to show - model_read and board_read list them")


TOOL = Tool(
    name="model_render", package="cad", level="change", order=30, default=True,
    label="Show a model",
    about="Renders a 3D model or a board from the views asked for and shows the pictures in the Chat.",
    description="Show a 3D model (\"show me the lid\") or a board as pictures in the Chat: the model's last build "
                "photographed from up to 4 `views` (iso, iso-back, front, right, top, detail; default iso), or a "
                "board's 3D as the PCB room shows it (its top and bottom drawings when it has no 3D yet). The page "
                "shows the pictures under the step - do not link or describe them as files; you get the first one "
                "when you read images. A model being built or whose last build failed is not shown (it says so). "
                "Name the model or board by id or title words.",
    schema={"type": "object", "properties": {
        "model": {"type": "string", "description": "A 3D model's id or title words"},
        "board": {"type": "string", "description": "Or a board's id or title words"},
        "views": {"type": "array", "items": {"type": "string", "enum": list(VIEWS)}, "maxItems": MAX_VIEWS,
                  "description": "Which sides (default iso)"},
        "size": {"type": "string", "enum": list(SIZES), "description": "medium unless asked"}}},
    running="Rendering a model", failed="Could not render the model",
    run=run)
