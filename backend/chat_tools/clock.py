"""clock: the date and time now - where the server keeps time (REDLINE_TZ,
Istanbul by default) or in any IANA time zone asked for."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .. import cc_chat
from . import Ctx, Result, Tool, ToolError


async def run(ctx: Ctx, args: dict) -> Result:
    tz = str(args.get("timezone") or "").strip() or None
    try:
        line = cc_chat.now_line(tz)
        now = datetime.now(ZoneInfo(tz)) if tz else None
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ToolError(f"no time zone {tz!r} - give an IANA name like Europe/Istanbul or America/New_York") from exc
    text = line + (f" ISO: {now.isoformat(timespec='seconds')}." if now else "")
    return Result(text=text, say="Read the clock: {line}", vars={"line": line}, summary=line)


TOOL = Tool(
    name="clock", package="commandcode", level="read", order=50,
    label="Date and time",
    about="Says the date and time now, here or in another time zone.",
    description="The current date and time. Each of the person's lines already starts with it; use this tool "
                "for another time zone (an IANA name like America/New_York) or to read the exact time again in a "
                "long answer.",
    schema={"type": "object", "properties": {
        "timezone": {"type": "string", "description": "An IANA time zone, like Europe/Istanbul; leave out for the server's"}}},
    running="Reading the clock", failed="Could not read the clock",
    run=run)
