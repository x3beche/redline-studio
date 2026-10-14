"""wiki_write: write a page of a project's wiki (backend/wiki.py) - its
whole new text, or lines appended to it. It always asks the person first
(`asks`): the step waits with Allow / Deny, and shows the change it would
make (`preview`, a line diff against the page as it is) so the person
reads what goes into their wiki before it does. Allowed, it is a new
version of the page, audited, and undone like any chat tool's change."""

from __future__ import annotations

from .. import app_links, wiki
from . import Ctx, Result, Tool, ToolError
from ._rights import need


def _args(args: dict) -> tuple[str, str, str | None, str | None, str, int | None]:
    project = str(args.get("project") or "").strip()
    page = str(args.get("page") or "").strip()
    if not project or not page:
        raise ToolError("name the project and the page (a new name makes a new page)")
    content, append = args.get("content"), args.get("append")
    if (content is None) == (append is None):
        raise ToolError("give either `content` (the page's whole new text) or `append` (lines to add at its end)")
    base = args.get("base")
    try:
        base = int(base) if base not in (None, "") else None
    except (TypeError, ValueError):
        base = None
    return project, page, (str(content) if content is not None else None), \
        (str(append) if append is not None else None), str(args.get("summary") or "").strip(), base


async def preview(ctx: Ctx, args: dict) -> str:
    """What the write would change, shown while it waits to be allowed."""
    project, page, content, append, summary, _ = _args(args)
    need("PUT", f"/api/wiki/p/{project}/{wiki.slug(page)}")
    cur = await wiki.get(ctx.db, project, page)
    if cur is None and not await wiki.exists(ctx.db, project):
        raise ToolError(f"there is no project {project!r} here - a project is a top folder of the tree")
    before = (cur or {}).get("text") or ""
    if append is not None:
        add = append.strip("\n")
        after = before.rstrip("\n") + "\n\n" + add if before.strip() else add
    else:
        after = content or ""
    head = (f"{project} / {(cur or {}).get('slug') or wiki.slug(page)}: "
            + (f"version {cur['version']} -> {cur['version'] + 1}" if cur else "a new page")
            + (f" - {summary}" if summary else ""))
    return head + "\n" + wiki.diff_text(before, after)


async def run(ctx: Ctx, args: dict) -> Result:
    project, page, content, append, summary, base = _args(args)
    need("PUT", f"/api/wiki/p/{project}/{wiki.slug(page)}")
    if not summary:
        summary = "Written in the Chat"
    try:
        d, changed = await wiki.write(ctx.db, project, page, text=content, append=append, summary=summary,
                                      title=None if wiki.slug(page) == page else page, base=base,
                                      by=ctx.actor or None)
    except wiki.Refused as exc:
        raise ToolError(str(exc)) from exc
    link = app_links.wiki(project, d["slug"])
    text = (f"{'Saved' if changed else 'Unchanged (the same text)'}: {project} / {d['slug']} "
            f"\"{d['title']}\", now version {d['version']}. Link it as [{d['title']}]({link}).")
    return Result(text=text, say="Wrote {title} in {project}'s wiki (version {version})",
                  vars={"title": d["title"], "project": project, "page": d["slug"], "version": d["version"]},
                  summary=text[:600])


TOOL = Tool(
    name="wiki_write", package="wiki", level="change", order=12,
    label="Write a wiki page",
    about="Writes or adds to a page of a project's wiki - always asking first, with the change shown.",
    description="Write a page of a project's wiki: `content` is its whole new text (read it with wiki_read "
                "first and keep what should stay; pass its version as `base`), or `append` adds lines at its "
                "end (a decision, a limit, an answered question). A name that is no page yet makes a new one. "
                "The wiki holds the project's facts - what was decided and why, dimensions and limits, "
                "sourcing, open questions, production notes - in short Markdown pages: '## ' sections, lists, "
                "tables with units, dates on decisions, [[page]] links, @model:id / @board:id / @part:C123 "
                "for things; never general design preferences (those are Taste). `summary` says the change in "
                "a few words. The person is always asked before it is written, and sees the change.",
    schema={"type": "object", "properties": {
        "project": {"type": "string", "description": "The project (a top folder, e.g. iot-fan)"},
        "page": {"type": "string", "description": "The page's id or name; a new name makes a new page"},
        "content": {"type": "string", "description": "The page's whole new text (Markdown)"},
        "append": {"type": "string", "description": "Lines to add at the page's end, instead of content"},
        "summary": {"type": "string", "description": "The change in a few words, for the page's history"},
        "base": {"type": "integer", "description": "The version read with wiki_read (refused if it moved on)"}},
        "required": ["project", "page", "summary"]},
    running="Writing the wiki page {page}", failed="Could not write the wiki page",
    asks=lambda args: True,
    preview=preview,
    run=run)
