"""basic_tool: the Tools tab's calculators, computed on the server - so an
answer quotes a trace width, a via's current or a divider's output that
was worked out, not guessed.

Two steps, as the MCP server's find_tool and run_tool are: `task` picks
the best calculators for what is asked (backend/tool_router.py) and gives
each one's inputs - keys, units, defaults; `id` with `input` runs one
(backend/tools_api.py `run_kit`: the tool's own tool.js, the arithmetic
the Tools tab's page runs, in a throwaway offline container). Only the
kit tools run (a tool.js beside the manifest); the rest are interactive
pages, said to be so - their numbers are never made up here.
"""

from __future__ import annotations

from fastapi import HTTPException

from .. import tool_router, tools_api
from . import Ctx, Result, Tool, ToolError, clip

PICKS = 3
MAX_ROWS = 40                       # rows of one result table
MAX_OPTIONS = 12


def _manual(m: dict) -> str:
    """One calculator, as the model needs it to call it: its inputs."""
    out = [f"id: {m['id']} - {m.get('name')}: {m.get('blurb') or ''}"]
    if not m.get("runnable"):
        out.append("  interactive only (a page in the Tools tab): it cannot be computed here.")
        return "\n".join(out)
    if m.get("intro"):
        out.append("  " + str(m["intro"])[:500])
    for d in m.get("inputs") or []:
        line = f"  - {d.get('key')} ({d.get('type') or 'text'}"
        line += f", {d['unit']}" if d.get("unit") else ""
        line += f", default {d['default']!r}" if d.get("default") not in (None, "") else ""
        line += ")"
        if d.get("label"):
            line += f" {d['label']}"
        opts = d.get("options") or []
        if opts:
            vals = [str(o[0] if isinstance(o, list) else (o.get("value") if isinstance(o, dict) else o)) for o in opts]
            line += " one of: " + ", ".join(vals[:MAX_OPTIONS]) + (" ..." if len(vals) > MAX_OPTIONS else "")
        if d.get("columns"):
            line += " a table with columns " + ", ".join(str(c.get("key") if isinstance(c, dict) else c)
                                                         for c in d["columns"])
        if d.get("help"):
            line += f" - {str(d['help'])[:200]}"
        out.append(line)
    if m.get("example"):
        out.append(f"  example input: {m['example']}")
    return "\n".join(out)


def _result(name: str, got: dict) -> str:
    r = got.get("result") or {}
    out = [f"{name} ({got.get('tool')}), computed with input {got.get('input')}:"]
    for v in r.get("values") or []:
        out.append(f"- {v.get('label')}: {v.get('value')}{' ' + v['unit'] if v.get('unit') else ''}"
                   + (f" ({v['hint']})" if v.get("hint") else ""))
    for t in r.get("tables") or []:
        rows = t.get("rows") or []
        out.append(f"Table: {t.get('title') or ''}")
        out.append(" | ".join(str(c) for c in t.get("columns") or []))
        out += [" | ".join(str(c) for c in row) for row in rows[:MAX_ROWS]]
        if len(rows) > MAX_ROWS:
            out.append(f"... and {len(rows) - MAX_ROWS} more rows")
    for t in r.get("texts") or []:
        if isinstance(t, dict):
            out.append(f"{t.get('title') or 'Text'}:\n{str(t.get('text') or t.get('body') or '')[:4000]}")
        else:
            out.append(str(t)[:4000])
    if r.get("warnings"):
        out.append("Warnings: " + "; ".join(map(str, r["warnings"])))
    if r.get("notes"):
        out.append("Notes: " + " ".join(map(str, r["notes"])))
    return "\n".join(out)


def _first(got: dict) -> str:
    vals = (got.get("result") or {}).get("values") or []
    return "\n".join(f"{v.get('label')}: {v.get('value')}{' ' + v['unit'] if v.get('unit') else ''}"
                     for v in vals[:6])


async def _find(task: str) -> Result:
    catalog = tools_api.catalog()
    got = await tool_router.pick(task, catalog, PICKS)
    picks = [p["id"] for p in got.get("picks") or []] or [p["id"] for p in got.get("also") or []]
    if not picks:
        return Result(text=f"No calculator in the Tools tab fits {task!r}. Work it out step by step and say so.",
                      say="No calculator for “{task}”", vars={"task": task}, summary="none")
    mans = [await tools_api.manual(p, "chat") for p in picks]
    for p in picks:
        await tools_api._record(p, "find", "chat")
    names = ", ".join(m.get("name") or m["id"] for m in mans)
    text = ("Calculators for this task, best first. Run one with basic_tool, its `id` and an `input` object "
            "keyed by the inputs below (numbers may be strings in engineering notation, like '4k7' or '100n'; "
            "inputs left out take their default):\n\n" + "\n\n".join(_manual(m) for m in mans))
    return Result(text=clip(text), say="Found calculators for “{task}”: {names}", vars={"task": task, "names": names},
                  summary="\n".join(f"{m['id']}{'' if m.get('runnable') else ' (interactive)'}" for m in mans))


async def run(ctx: Ctx, args: dict) -> Result:
    tid = str(args.get("id") or "").strip()
    task = str(args.get("task") or "").strip()
    if not tid:
        if not task:
            raise ToolError("give `task` (what to compute) to find a calculator, or `id` and `input` to run one")
        return await _find(task)
    try:
        man = await tools_api.manual(tid, "chat")
    except HTTPException as exc:
        raise ToolError(f"no calculator {tid!r} - find one with `task`") from exc
    name = man.get("name") or tid
    given = args.get("input")
    if given is None:
        return Result(text=_manual(man) + "\nCall again with `input`.", say="Read the inputs of {name}",
                      vars={"id": tid, "name": name}, summary=", ".join(d["key"] for d in man.get("inputs") or []))
    if not isinstance(given, dict):
        raise ToolError("`input` is an object keyed by the calculator's inputs")
    if not man.get("runnable"):
        raise ToolError(f"{name} is interactive only (a page in the Tools tab): it cannot be computed here")
    try:
        got = await tools_api.run_kit(tid, given, "chat")
    except HTTPException as exc:
        raise ToolError(f"{name} could not run: {exc.detail}") from exc
    if not got.get("ok"):
        raise ToolError(f"{name}: {got.get('error') or 'it gave no answer'}")
    return Result(text=clip(_result(name, got)), say="Calculated with {name}", vars={"id": tid, "name": name},
                  summary=_first(got))


TOOL = Tool(
    name="basic_tool", level="read", order=55,
    label="Basic Tools calculators",
    about="Finds the right calculator in the Tools tab and computes with it.",
    description="Compute engineering numbers with the app's Basic Tools calculators instead of estimating "
                "them: trace width for a current, via current, LED series resistor, voltage divider, RC/LC "
                "filters, regulators, I2C pull-ups, battery life and ~200 more. Two steps: first `task` (what "
                "to compute, in words) returns the best calculators with their inputs (keys, units, "
                "defaults); then `id` and `input` run one and return its computed values, tables and notes. "
                "Quote the computed values and name the calculator.",
    schema={"type": "object", "properties": {
        "task": {"type": "string", "description": "What to compute, e.g. 'trace width for 1 A on 1 oz copper'"},
        "id": {"type": "string", "description": "A calculator's id from a `task` answer, like trace-width"},
        "input": {"type": "object", "description": "The calculator's inputs by key, e.g. {\"amps\": \"1\", \"oz\": \"1\"}"}}},
    running="Using the Basic Tools", failed="A Basic Tools calculator failed",
    run=run)
