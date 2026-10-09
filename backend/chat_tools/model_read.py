"""model_read: a 3D model's version, last build (when, how long, its size
and its parts' sizes), last build error and its source a page at a time -
the block an @-mention of it gives (backend/cc_context.py `model_parts`) -
or the workspace's models when none is named."""

from __future__ import annotations

from .. import cc_context
from . import Ctx, Result, Tool, clip
from ._things import find, rows

LINES = 250                         # source lines a page
MAX_LINES = 600


async def _listing(ctx: Ctx) -> Result:
    found = await rows(ctx.db, "models", ("title", "name", "version", "built", "error", "stale"))
    if not found:
        return Result(text="There are no 3D models in this workspace.", say="No 3D models here", summary="none")
    lines = [f"{d['_id']}  \"{d.get('title') or d.get('name') or d['_id']}\"  v{d.get('version')}"
             + (f"  built v{(d.get('built') or {}).get('version')} at {(d.get('built') or {}).get('at')}"
                if d.get("built") else "  not built")
             + ("  (changed since)" if d.get("stale") else "") + ("  LAST BUILD FAILED" if d.get("error") else "")
             for d in found]
    text = (f"{len(found)} 3D model(s) in this workspace. Read one with model_read and its id:\n" + "\n".join(lines))
    return Result(text=clip(text), say="Listed {n} 3D models", vars={"n": len(found)},
                  summary="\n".join(d["_id"] for d in found[:20]))


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("model") or "").strip()
    if not ref:
        return await _listing(ctx)
    try:
        page = max(1, int(args.get("page") or 1))
        per = max(20, min(int(args.get("lines") or LINES), MAX_LINES))
    except (TypeError, ValueError):
        page, per = 1, LINES
    doc = await find(ctx.db, "models", ref, ("title", "name"), "3D model")
    got = await cc_context.model_parts(ctx.db, doc["_id"])
    d = got["doc"]
    src = got["source"].splitlines()
    pages = max(1, -(-len(src) // per))
    page = min(page, pages)
    body = list(got["lines"])
    if src:
        first = (page - 1) * per
        shown = src[first:first + per]
        body.append(f"Source, lines {first + 1}-{first + len(shown)} of {len(src)} (page {page} of {pages}"
                    + (f"; ask for page {page + 1} for more" if page < pages else "") + "):")
        body.append("```python\n" + "\n".join(f"{first + i + 1:4d}  {ln}" for i, ln in enumerate(shown)) + "\n```")
    else:
        body.append("No source.")
    built = d.get("built") or {}
    v = {"model": d["_id"], "title": d.get("title") or d.get("name") or d["_id"], "version": d.get("version"),
         "page": page, "pages": pages}
    summary = (f"v{d.get('version')}" + (f" · built v{built.get('version')} {built.get('at')}" if built else " · not built")
               + (" · last build failed" if d.get("error") else ""))
    return Result(text=clip("\n".join(body)), say="Read 3D model {model} · v{version}", vars=v, summary=summary)


TOOL = Tool(
    name="model_read", level="read", order=62,
    label="Read a 3D model",
    about="Reads a 3D model: its source, version, last build with its sizes, and its last error.",
    description="Read one of this workspace's 3D models (the 3D room, build123d Python): its version, the "
                "latest build (when, how long it took, the overall size in mm and every part's size), the "
                "last build error, what it uses, and its source with line numbers, a page at a time "
                f"({LINES} lines a page). Without `model` it lists the models. A model may be named by its "
                "id (like iot-fan/assemblies/base) or by words of its title.",
    schema={"type": "object", "properties": {
        "model": {"type": "string", "description": "The model's id; leave out to list"},
        "page": {"type": "integer", "minimum": 1, "description": "Page of the source, from 1"},
        "lines": {"type": "integer", "minimum": 20, "maximum": MAX_LINES, "description": "Source lines a page"}}},
    running="Reading a 3D model", failed="Could not read the 3D model",
    run=run)
