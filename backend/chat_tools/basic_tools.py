"""The Basic Tools tab's calculators, each a Chat tool of its own in the
"tools" package - off for everyone until they turn one on (there are some
two hundred: the Tools panel's Basic Tools card holds them, with a search).

One tool per calculator that runs on the server (a tool.js beside its
manifest, frontend/public/tools/<id>/): its inputs from the manifest become
the tool's input, and running it is the Tools tab's own arithmetic in a
throwaway offline container (backend/tools_api.py `run_kit`), the way the
parked basic_tool.py runs one. Made when the registry first loads, so a new
calculator is a tool from the next restart on.
"""

from __future__ import annotations

from fastapi import HTTPException

from .. import tools_api
from . import Ctx, Result, Tool, ToolError, clip
from .basic_tool import MAX_OPTIONS, _first, _result

PREFIX = "calc_"


def _value(o) -> str:
    return str(o[0] if isinstance(o, list) else (o.get("value") if isinstance(o, dict) else o))


def _prop(d: dict) -> dict:
    """One manifest input as a JSON Schema property."""
    kind = d.get("type") or "text"
    say = [str(d.get("label") or d.get("key"))]
    if d.get("unit"):
        say.append(f"in {d['unit']}")
    if d.get("default") not in (None, ""):
        say.append(f"default {str(d['default'])[:80]!r}")
    if d.get("help"):
        say.append(str(d["help"])[:200])
    if kind == "bool":
        prop: dict = {"type": "boolean"}
    elif kind == "select" and d.get("options"):
        vals = [_value(o) for o in d["options"]]
        prop = {"type": "string", "enum": vals} if len(vals) <= 60 else {"type": "string"}
        if len(vals) > 60:
            say.append("one of: " + ", ".join(vals[:MAX_OPTIONS]) + " ...")
    elif kind == "table":
        cols = [str(c.get("key") if isinstance(c, dict) else c) for c in d.get("columns") or []]
        prop = {"type": "array", "items": {"type": "object", "properties": {c: {"type": "string"} for c in cols}}}
        say.append("rows with " + ", ".join(cols))
    elif kind == "number":
        # A string, so engineering notation goes through as written: 4k7, 100n, 2.2u.
        prop = {"type": "string"}
        say.append("a number, engineering notation allowed (4k7, 100n)")
    else:
        prop = {"type": "string"}
    prop["description"] = "; ".join(say)
    return prop


def _make(entry: dict) -> Tool | None:
    tid = entry["id"]
    try:
        man = tools_api.manifest_of(tid)
    except HTTPException:
        return None
    name = man.get("name") or tid
    inputs = [d for d in man.get("inputs") or [] if d.get("key")]

    async def run(ctx: Ctx, args: dict) -> Result:
        try:
            got = await tools_api.run_kit(tid, dict(args), "chat")
        except HTTPException as exc:
            raise ToolError(f"{name} could not run: {exc.detail}") from exc
        if not got.get("ok"):
            raise ToolError(f"{name}: {got.get('error') or 'it gave no answer'}")
        return Result(text=clip(_result(name, got)), say="Calculated with {name}", vars={"id": tid, "name": name},
                      summary=_first(got))

    blurb = man.get("blurb") or entry.get("blurb") or ""
    intro = str(man.get("intro") or "")[:600]
    return Tool(
        name=PREFIX + tid.replace("-", "_"), package="tools", level="read", default=False, order=1000,
        label=name, about=blurb,
        description=(f"{name} (the Basic Tools tab's calculator {tid}): {blurb}. {intro} "
                     "Inputs left out take their default; numbers may be written in engineering notation.").strip(),
        schema={"type": "object", "properties": {d["key"]: _prop(d) for d in inputs}},
        running="Calculating with " + name, failed="Could not calculate with " + name,
        run=run)


def _all() -> list[Tool]:
    out = []
    for entry in tools_api.catalog():
        if entry.get("runnable"):
            t = _make(entry)
            if t:
                out.append(t)
    return out


TOOLS = _all()
