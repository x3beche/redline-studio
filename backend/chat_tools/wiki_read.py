"""wiki_read: one page of a project's wiki (backend/wiki.py), whole, with
its version - which wiki_write's `base` names - and the pages linked
with it."""

from __future__ import annotations

from .. import app_links, wiki
from . import Ctx, Result, Tool, ToolError


async def run(ctx: Ctx, args: dict) -> Result:
    project = str(args.get("project") or "").strip()
    page = str(args.get("page") or "").strip()
    if not project:
        raise ToolError("name the project whose wiki to read (wiki_search lists them)")
    if not page:
        rows = await wiki.pages(ctx.db, project)
        if not rows:
            raise ToolError(f"{project}'s wiki has no pages" if await wiki.exists(ctx.db, project)
                            else f"there is no project {project!r} here")
        text = f"Name a page. {project}'s wiki has: " + ", ".join(f"{r['slug']} ({r['title']})" for r in rows)
        return Result(text=text, say="Listed {count} pages of {project}'s wiki",
                      vars={"count": len(rows), "project": project}, summary=text[:600])
    d = await wiki.get(ctx.db, project, page)
    if not d:
        names = [r["slug"] for r in await wiki.pages(ctx.db, project)]
        raise ToolError(f"no page {page!r} in {project}'s wiki" + (f" - it has: {', '.join(names)}" if names else ""))
    who = (d.get("updated_by") or {}).get("name") or "?"
    head = [f"# {d['title']}  ({project} / {d['slug']}, version {d['version']}, {str(d['updated_at'] or '')[:16]} "
            f"by {who}{', pinned' if d['pinned'] else ''})",
            f"link: {app_links.wiki(project, d['slug'])}"]
    if d["linked_from"]:
        head.append("linked from: " + ", ".join(x["slug"] for x in d["linked_from"]))
    text = "\n".join(head) + "\n\n" + d["text"]
    return Result(text=text, say="Read {title} in {project}'s wiki",
                  vars={"title": d["title"], "project": project, "page": d["slug"], "version": d["version"]},
                  summary=d["text"][:600])


TOOL = Tool(
    name="wiki_read", package="wiki", level="read", order=11,
    label="Read a wiki page",
    about="Reads one page of a project's wiki, with its version.",
    description="Read one page of a project's wiki in full (Markdown; [[page]] links another page, "
                "@model:id / @board:id / @part:C123 / @firmware:id point at things). Its version is what "
                "wiki_write's `base` takes. Without `page`, the project's pages are listed.",
    schema={"type": "object", "properties": {
        "project": {"type": "string", "description": "The project (a top folder, e.g. iot-fan)"},
        "page": {"type": "string", "description": "The page's id or name, e.g. decisions"}},
        "required": ["project"]},
    running="Reading the wiki page {page}", failed="Could not read the wiki page",
    run=run)
