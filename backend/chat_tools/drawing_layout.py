"""drawing_layout: a 3D model's technical drawing layout read, set or put
back to the automatic one (backend/drawlayout.py, as the 3D room's layout
editor saves it: PUT /api/models/{id}/drawing/layout), and optionally the
drawing made with it (POST .../drawing?again=1) - with the rights those
routes need. The drawing is made by a process of its own
(_drawing_job.py, as drawing_get's Make now): this tool runs in the
answer's runner, which ends with the answer."""

from __future__ import annotations

import json

from .. import chat_undo, drawlayout, release
from . import Ctx, Result, Tool, ToolError, clip
from . import _drawing_job as job
from ._rights import need
from ._things import find


def _said(layout: dict, status: dict | None) -> str:
    lines = []
    if layout["spec"]:
        lines.append(f"Layout version {layout['version']} (set by hand):\n" + json.dumps(layout["spec"], indent=1))
    else:
        lines.append("No layout of its own: the sheet is laid out automatically (largest standard scale that fits; "
                     "FRONT top left, RIGHT beside it, TOP under it, ISO in the rest; A4 if 1:1 fits, else A3).")
    made = (status or {}).get("made") or {}
    if made:
        lines.append(f"The drawing as made now: {made.get('sheet')}, scale {made.get('scale')}, "
                     f"views {', '.join(made.get('views') or [])}.")
        if made.get("boxes"):
            lines.append("Its boxes (a start for a layout of its own): " + json.dumps(made["boxes"]))
        if made.get("parts"):
            lines.append("Part names it knows (for parts.hide / parts.highlight): " + ", ".join(made["parts"][:200]))
        if made.get("unmatched"):
            lines.append("Names in the layout that are no part: " + ", ".join(made["unmatched"]))
    elif status:
        lines.append(f"The drawing for this layout is {status.get('state')} (not made yet with it).")
    if layout.get("names") and not made.get("parts"):
        lines.append("Part names: " + ", ".join(layout["names"][:200]))
    return "\n".join(lines)


async def run(ctx: Ctx, args: dict) -> Result:
    action = str(args.get("action") or "get")
    if action not in ("get", "set", "reset"):
        raise ToolError("action is get, set or reset")
    doc = await find(ctx.db, "models", str(args.get("model") or ""), ("title", "name"), "3D model")
    mid = doc["_id"]
    title = doc.get("title") or doc.get("name") or mid
    if action != "get":
        need("PUT", f"/api/models/{mid}/drawing/layout")
        spec = None
        if action == "set":
            spec = args.get("spec")
            if not isinstance(spec, dict):
                raise ToolError("give `spec`: the whole layout (sheet, views, parts, title, notes)")
        try:
            await drawlayout.write(ctx.db, mid, spec, actor=ctx.actor or None)
        except drawlayout.LayoutError as exc:
            raise ToolError(str(exc)) from exc
        except drawlayout.Stale as exc:
            raise ToolError("someone saved the layout at the same moment - read it again") from exc
    started = False
    if action != "get" and args.get("make"):
        need("POST", f"/api/models/{mid}/drawing")
        db = chat_undo.inner(ctx.db)
        now = await release.drawing_status(db, mid)
        if now["state"] == "no_step":
            raise ToolError("this model has no STEP to draw from - its script does not export one")
        # Under way with this layout already (the room's, or another answer's): not twice.
        if now["state"] != "making" and not (now["state"] == "queued" and (now.get("job") or {}).get("by") == "chat"):
            await job.start(db, mid, again=True)
        started = True
    layout = await drawlayout.read(ctx.db, mid)
    try:
        status = await release.drawing_status(ctx.db, mid)
    except KeyError:
        status = None
    text = _said(layout, status)
    if started:
        text += "\nThe drawing is being made with it now (the 3D room's Model tab shows it when done)."
    say = {"get": "Read the drawing layout of {model}", "set": "Set the drawing layout of {model}",
           "reset": "Put the drawing layout of {model} back to automatic"}[action]
    return Result(text=clip(text), say=say, vars={"model": title, "id": mid},
                  summary=("automatic" if not layout["spec"] else
                           f"v{layout['version']} · {len(layout['spec']['views'])} views")
                  + (" · drawing started" if started else ""))


_BOX = {"type": "object", "properties": {
    "view": {"type": "string", "enum": list(drawlayout.VIEWS)},
    "x": {"type": "number", "minimum": 0, "maximum": 1}, "y": {"type": "number", "minimum": 0, "maximum": 1},
    "w": {"type": "number", "minimum": 0.05, "maximum": 1}, "h": {"type": "number", "minimum": 0.05, "maximum": 1},
    "scale": {"type": "string", "enum": ["auto", *drawlayout.SCALES]},
    "hidden_lines": {"type": "boolean"}, "dims": {"type": "boolean"}},
    "required": ["view", "x", "y", "w", "h"]}

TOOL = Tool(
    name="drawing_layout", package="cad", level="change", order=64, default=False,
    label="Lay out a technical drawing",
    about="Reads or changes how a 3D model's technical drawing sheet is laid out, and can make it again.",
    description="Read or change the layout of a 3D model's technical drawing (the PDF sheet the 3D room makes from "
                "its STEP). action=get (default) returns the layout - or says it is automatic - with the boxes of "
                "the drawing as made now and the part names it knows. action=set saves `spec`, the WHOLE layout: "
                "sheet {size: auto|A4|A3, orientation: landscape|portrait}; views: a list of boxes {view: "
                "front|back|top|bottom|left|right|iso, x, y, w, h as fractions of the sheet from its top left "
                "(keep them inside the border, about 0.03 from the edges, and above the title block, which takes "
                "the bottom ~0.17 on landscape A4), scale: auto (one standard scale the auto boxes share) or "
                "1:1, 2:1, 1:2, 1:5..., hidden_lines, dims}; parts {hide: [names], highlight: [names]} for "
                "assemblies (highlighted parts are drawn heavier); title and notes to replace the title block's. "
                "action=reset goes back to the automatic layout. With make=true the drawing is made again with "
                "it in the background. A model may be named by its id or words of its title. Change it only "
                "when asked to.",
    schema={"type": "object", "properties": {
        "model": {"type": "string", "description": "The model's id or title"},
        "action": {"type": "string", "enum": ["get", "set", "reset"]},
        "spec": {"type": "object", "description": "The whole layout, for action=set", "properties": {
            "sheet": {"type": "object", "properties": {
                "size": {"type": "string", "enum": list(drawlayout.SIZES)},
                "orientation": {"type": "string", "enum": list(drawlayout.ORIENTATIONS)}}},
            "views": {"type": "array", "items": _BOX, "maxItems": drawlayout.MAX_VIEWS},
            "parts": {"type": "object", "properties": {
                "hide": {"type": "array", "items": {"type": "string"}},
                "highlight": {"type": "array", "items": {"type": "string"}}}},
            "title": {"type": "string"}, "notes": {"type": "string"}}},
        "make": {"type": "boolean", "description": "Make the drawing again with the layout after saving it"}},
        "required": ["model"]},
    running="Working on a drawing layout", failed="Could not change the drawing layout",
    run=run)
