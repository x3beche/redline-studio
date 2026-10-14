"""wiki_search: the projects' wikis (backend/wiki.py) - pages with the
words, in one project or all; with no words, a project's pages, or the
projects that have a wiki."""

from __future__ import annotations

from .. import app_links, wiki
from . import Ctx, Result, Tool


async def run(ctx: Ctx, args: dict) -> Result:
    project = str(args.get("project") or "").strip()
    query = str(args.get("query") or "").strip()
    if query:
        hits = await wiki.search(ctx.db, query, project or None, limit=20)
        if not hits:
            where = f"{project}'s wiki" if project else "any project's wiki"
            text = f"Nothing in {where} has “{query}”."
        else:
            text = "\n".join(f"- {h['project']} / {h['slug']} - {h['title']}"
                             + (f" (line {h['line']})" if h["line"] else "") + f": {h['snippet']}"
                             f"  [{app_links.wiki(h['project'], h['slug'])}]" for h in hits)
        return Result(text=text, say="Found {count} wiki pages for “{query}”",
                      vars={"count": len(hits), "query": query}, summary=text[:600])
    if project:
        rows = await wiki.pages(ctx.db, project)
        if not rows:
            text = (f"{project}'s wiki has no pages yet." if await wiki.exists(ctx.db, project)
                    else f"There is no project {project!r} here.")
        else:
            text = f"{project}'s wiki ({len(rows)} pages, pinned first, then the newest):\n" + "\n".join(
                f"- {r['slug']} - {r['title']}" + (" (pinned)" if r["pinned"] else "")
                + f", v{r['version']}, {str(r['updated_at'] or '')[:10]}, {r['chars']} characters" for r in rows)
        return Result(text=text, say="Listed {count} pages of {project}'s wiki",
                      vars={"count": len(rows), "project": project}, summary=text[:600])
    rows = await wiki.projects(ctx.db)
    text = "The projects and their wikis:\n" + "\n".join(
        f"- {p['id']}: {p['pages']} pages" for p in rows) if rows else "There are no projects here yet."
    return Result(text=text, say="Listed the wikis of {count} projects", vars={"count": len(rows)},
                  summary=text[:600])


TOOL = Tool(
    name="wiki_search", package="wiki", level="read", order=10,
    label="Search the wiki",
    about="Finds pages in the projects' wikis by their words, or lists a project's pages.",
    description="Search the projects' wikis - short pages of a project's decisions, dimensions and limits, "
                "sourcing, open questions and production notes. With `query`, pages with those words (in "
                "`project` only, or in every project); without it, a project's pages, or every project with "
                "how many pages its wiki has. Read a page with wiki_read. Look here before answering what was "
                "decided on a project, why, or what its limits are.",
    schema={"type": "object", "properties": {
        "project": {"type": "string", "description": "A project (a top folder of the tree, e.g. iot-fan); "
                                                    "leave out for every project"},
        "query": {"type": "string", "description": "Words to find; leave out to list pages"}}},
    running="Searching the wiki", failed="Could not search the wiki",
    run=run)
