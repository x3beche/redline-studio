"""task_list: the scheduled tasks of this space (the Tasks tab), each with its
schedule in words, its next run and how its last one went; and, asked, the
task types with their inputs."""

from __future__ import annotations

from fastapi import HTTPException

from .. import app_links
from . import Ctx, Result, Tool
from ._tasks import line, refused


async def run(ctx: Ctx, args: dict) -> Result:
    from ..sched import api
    try:
        got = await api.listing()
        tasks = got["tasks"]
        text = [f"{len(tasks)} scheduled task{'s' if len(tasks) != 1 else ''} (the Tasks tab, {app_links.task()}); "
                f"the scheduler is {'on' if got['settings']['on'] else 'switched off'}:"]
        text += [line(t) for t in tasks] or ["(none yet)"]
        if args.get("types"):
            ty = await api.types()
            text.append("\nTask types (type id: what it does; inputs):")
            for k in ty["types"]:
                ins = ", ".join(f"{p['name']} ({p['kind']}{', default ' + repr(p['default']) if p['default'] not in (None, '', []) else ''})"
                                for p in k["params"]) or "none"
                text.append(f"- {k['id']}: {k['about']} Inputs: {ins}."
                            + ("" if k["allowed"] else " (not allowed for you)")
                            + (" COSTS MONEY each run; made paused." if k["llm"] else ""))
            text.append(f"Telegram linked: {'yes' if ty['telegram'] else 'no'}. Default time zone {ty['tz']}.")
    except HTTPException as exc:
        raise refused(exc) from None
    return Result(text="\n".join(text), say="Listed {n} scheduled tasks", vars={"n": len(tasks)},
                  summary="; ".join(t["name"] for t in tasks)[:300])


TOOL = Tool(
    name="task_list", package="tasks", level="read", order=10,
    label="Scheduled tasks",
    about="Lists the scheduled tasks: when each runs next and how its last run went.",
    description="List the scheduled tasks of this space (the Tasks tab): each one's id, type, schedule in words, "
                "time zone, on or paused, next run, last result and where it delivers. With types=true also the "
                "task types and their inputs - read them before task_create.",
    schema={"type": "object", "properties": {
        "types": {"type": "boolean", "description": "Also list the task types and their inputs"}}},
    running="Reading the scheduled tasks", failed="Could not read the scheduled tasks",
    run=run)
