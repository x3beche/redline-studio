"""drawer_add: an LCSC part into the drawer - the path the Parts page's
"Add" takes (backend/main.py `_run_add`): EasyEDA's record, the footprint
and 3D model, its drawer place."""

from __future__ import annotations

from .. import lcsc
from . import Ctx, Result, Tool, ToolError
from ._parts import code, in_drawer, why


async def run(ctx: Ctx, args: dict) -> Result:
    c = code(args)
    got = await in_drawer(ctx.db, c)
    if got:
        return Result(text=f"{c} ({got.get('name') or '?'}) is already in the drawer.",
                      say="{lcsc} is already in the drawer", vars={"lcsc": c, "name": got.get("name") or ""},
                      summary=got.get("name") or "")
    try:
        await lcsc._component(c)
        doc = await lcsc.fetch(ctx.db, c)
        await lcsc.categorise(ctx.db, c)
    except (ValueError, RuntimeError, TimeoutError, OSError, LookupError) as exc:
        raise ToolError(why(exc)) from exc
    group, branch, _by = lcsc.place_of(doc, lcsc._drawer_facts(c))
    has_3d = bool((doc.get("artifacts") or {}).get("model") or doc.get("model_step") or doc.get("model_wrl"))
    try:
        from ..main import say
        await say(f"{c} fetched from LCSC by the Chat - {doc.get('name')}"
                  + (" with a 3D model" if has_3d else ", footprint only") + f", in {group} › {branch}",
                  "done", room="pcb")
    except Exception:                                      # noqa: BLE001 - the log line is a nicety
        pass
    name = doc.get("name") or c
    return Result(text=f"Added {c} ({name}) to the drawer, in {group} › {branch}"
                       + ("; it has a 3D model." if has_3d else "; footprint only, no 3D model."),
                  say="Added {lcsc} to the drawer", vars={"lcsc": c, "name": name, "place": f"{group} › {branch}"},
                  summary=f"{name} · {group} › {branch}" + (" · 3D" if has_3d else ""))


TOOL = Tool(
    name="drawer_add", level="change", order=30,
    about="Adds an LCSC part to the drawer, footprint and 3D model included.",
    label="Add to the drawer",
    description="Add an LCSC part to this workspace's parts drawer (its footprint and 3D model are "
                "downloaded), so boards can use it and its datasheet sits with it. Use the LCSC number "
                "from lcsc_search. A part already there is left as it is.",
    schema={"type": "object", "properties": {
        "lcsc": {"type": "string", "description": "The LCSC part number, like C111607"}},
        "required": ["lcsc"]},
    running="Adding {lcsc} to the drawer", failed="Could not add {lcsc} to the drawer",
    run=run)
