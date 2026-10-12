"""web_read: one public web page through Jina Reader (backend/jina.py), as
Markdown - its script run on Jina's side, so a page that needs JavaScript
reads too. The address is checked first: http(s) to a public address only
(manufacturers.check), so the Chat cannot point Jina at this machine's
network."""

from __future__ import annotations

from .. import jina
from .. import manufacturers as mf
from . import Ctx, Result, Tool, ToolError, clip

MAX_CHARS = 20_000                    # of the page's Markdown, handed to the model
NOT_SET = ("Reading web pages is not set up: it goes through Jina Reader, and no Jina API key is saved "
           "(Settings > Proxy & Data). Say so to the person; an owner or admin can paste one there.")


async def run(ctx: Ctx, args: dict) -> Result:
    raw = str(args.get("url") or "").strip()
    if not raw:
        raise ToolError("say which page: its address")
    if "://" not in raw:
        raw = "https://" + raw
    try:
        url = await mf.check(raw)
    except mf.Refused as exc:
        raise ToolError(str(exc)) from exc
    if not jina.configured():
        raise ToolError(NOT_SET)
    got = await jina.read(url, who="chat", crawl=False)
    if not got["ok"]:
        raise ToolError(f"the page could not be read: {got['error']}")
    md = got["text"]
    title = got["title"] or url
    head = f"# {title}\nURL: {got['url'] or url}\n" + (f"{got['description']}\n" if got["description"] else "")
    text = head + "\n" + clip(md, MAX_CHARS)
    return Result(text=text + "\n\n(read through Jina Reader; link this page when you use it)",
                  say="Read the web page {title}", vars={"title": title[:120], "url": got["url"] or url,
                                                         "chars": len(md)},
                  summary=f"{title}\n{got['url'] or url}\n{len(md):,} characters")


TOOL = Tool(
    name="web_read", package="general", level="read", order=61,
    label="Read a web page",
    about="Reads one public web page through Jina Reader, as text (Markdown).",
    description="Read one public web page (Jina Reader, which runs the page's script, so pages that need "
                "JavaScript read too). Returns its title and its text as Markdown, menus and footers left out, "
                "clipped when long. Use it on a result of web_search or an address the person gives; quote "
                "and link it. Only http(s) pages on public addresses.",
    schema={"type": "object", "properties": {
        "url": {"type": "string", "description": "The page's address, e.g. https://www.example.com/product/123"}},
        "required": ["url"]},
    running="Reading the web page {url}", failed="Could not read the web page",
    run=run)
