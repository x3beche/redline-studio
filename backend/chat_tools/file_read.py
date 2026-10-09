"""file_read: a file of the Files room - text, CSV, JSON and Markdown a page
at a time, a workbook's cells, a PDF's text by pages (backend/pdftext.py,
as datasheet_read reads a datasheet) or one page as a picture, an image
as a picture for a model that reads images, an archive's list - or the
files themselves, when none is named (backend/files.py)."""

from __future__ import annotations

import asyncio
import io

from .. import files, pdftext
from . import Ctx, Result, Tool, ToolError, clip, size
from ._things import SHOW
from .datasheet_read import FIND_PAGES, MAX_PAGES, best, span, thin

PAGE_CHARS = 12_000                 # characters of a text file a page
LIST = 60                           # files a list names
MAX_READ = pdftext.MAX_BYTES        # a file larger than this is described, not opened
IMAGE_PX = 1568                     # the longer side of an image handed to a model
TABLE_ROWS = 200
TEXTY = {"text", "table", "bom", "pick-place", "gerber", "drill"}
TEXT_TYPES = ("application/json", "application/xml", "application/x-yaml", "application/yaml")


def _pages_of(text: str) -> list[str]:
    """Text in pages of at most PAGE_CHARS, broken at line ends."""
    out, cur, n = [], [], 0
    for ln in text.splitlines(keepends=True):
        while len(ln) > PAGE_CHARS:                       # one huge line (minified JSON)
            if cur:
                out.append("".join(cur))
                cur, n = [], 0
            out.append(ln[:PAGE_CHARS])
            ln = ln[PAGE_CHARS:]
        if n + len(ln) > PAGE_CHARS and cur:
            out.append("".join(cur))
            cur, n = [], 0
        cur.append(ln)
        n += len(ln)
    if cur:
        out.append("".join(cur))
    return out or [""]


def _png(data: bytes) -> tuple[bytes, int, int]:
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        im.thumbnail((IMAGE_PX, IMAGE_PX))
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "PNG", compress_level=6)
        return buf.getvalue(), im.width, im.height


async def _find(ctx: Ctx, ref: str) -> dict:
    doc = await ctx.db[files.COLL].find_one({"_id": ref})
    if doc:
        return doc
    hits = await files.listing(ctx.db, q=ref, limit=SHOW)
    exact = [d for d in hits if (d.get("name") or "").lower() == ref.lower()]
    if len(exact) == 1 or len(hits) == 1:
        return (exact or hits)[0]
    if hits:
        raise ToolError(f"{len(hits)} files match {ref!r}: "
                        + "; ".join(f"{d['_id']} {d.get('name')}" for d in hits) + ". Ask again with one id.")
    raise ToolError(f"no file {ref!r} in this workspace's Files - list them with file_read and no file")


async def _listing(ctx: Ctx, q: str, kind: str) -> Result:
    found = await files.listing(ctx.db, q=q, kind=kind if kind in files.KINDS else "", limit=500)
    what = " ".join(x for x in (kind, f"matching {q!r}" if q else "") if x)
    if not found:
        return Result(text=f"No files{' ' + what if what else ''} in this workspace's Files.",
                      say="No files like that", vars={"query": q}, summary="none")
    lines = [f"{d['_id']}  {d.get('name')}  ({d.get('kind') or 'file'}, {size(d.get('bytes') or 0)})"
             + (f"  in {d['folder']}" if d.get("folder") else "") + f"  {str(d.get('created_at') or '')[:10]}"
             + (f"  note: {d['note'][:120]}" if d.get("note") else "") for d in found[:LIST]]
    more = f"\n... and {len(found) - LIST} more; narrow with `search` or `kind`" if len(found) > LIST else ""
    text = (f"{len(found)} file(s){' ' + what if what else ''} in Files, newest first (id, name, kind, size). "
            "Read one with file_read and its id:\n" + "\n".join(lines) + more)
    return Result(text=text, say="Listed {n} files", vars={"n": len(found), "query": q},
                  summary="\n".join(d.get("name") or d["_id"] for d in found[:20]))


async def _pdf(ctx: Ctx, d: dict, data: bytes, args: dict, v: dict) -> Result:
    spec = str(args.get("pages") or "").strip()
    query = str(args.get("query") or "").strip()
    image = args.get("image_page")
    name = d.get("name") or d["_id"]
    try:
        if image is not None:
            if not ctx.vision:
                raise ToolError("this model does not read images - read the page's text instead")
            png, meta = await asyncio.to_thread(pdftext.render_png, data, int(image), 110)
            return Result(text=f"Page {meta['n']} of {meta['count']} of {name}, as a picture (attached).",
                          say="Looked at page {page} of {name}", vars={**v, "page": meta["n"]},
                          summary=f"{meta['width']}×{meta['height']} px", image=png)
        if query and not spec:
            whole = await asyncio.to_thread(pdftext.text, data, "1-")
            ns = best(whole["pages"], query)
            if not ns:
                return Result(text=f"{query!r} is not in the text of {name} ({whole['count']} pages). Try other "
                                   "words, or read pages by number (a scanned page has no text: use image_page).",
                              say="Searched {name} for “{query}” · not found", vars={**v, "query": query},
                              summary="not found")
            got, count = [p for p in whole["pages"] if p["n"] in ns], whole["count"]
        else:
            out = await asyncio.to_thread(pdftext.text, data, spec or "1-3")
            got, count = out["pages"][:MAX_PAGES], out["count"]
    except (pdftext.PdfError, ValueError) as exc:
        raise ToolError(str(exc)) from exc
    ns = [p["n"] for p in got]
    body = "\n\n".join(f"--- page {p['n']} of {count} ---\n{p['text'] or p.get('error') or ''}"
                       + ("\n(next to no text on this page: it is a picture - look at it with image_page)"
                          if thin(p) else "") for p in got)
    more = f"\n\n(pages {span(ns)} of {count}; ask for others with `pages`)" if ns and ns[-1] < count else ""
    text = clip(f"{name}: a PDF of {count} pages. Cite pages as (p. N).\n\n" + body + more)
    v = {**v, "pages": span(ns), "count": count, "query": query}
    if query and not spec:
        return Result(text=text, say="Searched {name} for “{query}” · pages {pages}", vars=v,
                      summary=(got[0]["text"] if got else "")[:300])
    return Result(text=text, say="Read pages {pages} of {name}", vars=v, summary=(got[0]["text"] if got else "")[:300])


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("file") or "").strip()
    if not ref:
        return await _listing(ctx, str(args.get("search") or "").strip(), str(args.get("kind") or "").strip())
    d = await _find(ctx, ref)
    name, kind = d.get("name") or d["_id"], d.get("kind") or "other"
    ctype = (d.get("content_type") or "").split(";")[0].strip().lower()
    head = (f"File {d['_id']} `{name}` ({kind}, {ctype or '?'}, {size(d.get('bytes') or 0)}), uploaded "
            f"{d.get('created_at')} by {(d.get('by') or {}).get('name') or '?'}"
            + (f", in {d['folder']}" if d.get("folder") else "") + (f". Note: {d['note']}" if d.get("note") else ""))
    v = {"file": d["_id"], "name": name}
    readable = kind in TEXTY or kind in ("pdf", "image", "archive") or ctype.startswith("text/") or ctype in TEXT_TYPES
    if not readable:
        return Result(text=head + f"\nA {kind} file: its content is not readable as text here.",
                      say="Looked at {name}", vars=v, summary=f"{kind} · {size(d.get('bytes') or 0)}")
    if (d.get("bytes") or 0) > MAX_READ:
        return Result(text=head + f"\nToo large to open here (over {size(MAX_READ)}).", say="Looked at {name}",
                      vars=v, summary="too large to open")
    try:
        _, data = await files.get(ctx.db, d["_id"])
    except (KeyError, OSError) as exc:
        raise ToolError(f"the file {name} could not be read") from exc
    if kind == "pdf" or pdftext.is_pdf(data[:8]):
        return await _pdf(ctx, d, data, args, v)
    if kind == "image":
        if not ctx.vision:
            return Result(text=head + "\nAn image; this model does not read images, so it cannot be shown to you.",
                          say="Looked at {name}", vars=v, summary="image (not shown: the model reads no images)")
        try:
            png, w, h = await asyncio.to_thread(_png, data)
        except Exception as exc:                          # noqa: BLE001 - PIL's many failures, one answer
            raise ToolError(f"the image {name} could not be opened ({type(exc).__name__})") from exc
        return Result(text=head + f"\nThe image, {w}×{h} px, is attached.", say="Looked at the image {name}",
                      vars=v, summary=f"{w}×{h} px", image=png)
    if kind == "archive":
        try:
            ent = await asyncio.to_thread(files.entries_of, name, data)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc
        lines = [f"{e['name']}{'/' if e.get('dir') else ''}  {e['bytes']:,} bytes" for e in ent["entries"][:300]]
        text = head + f"\nAn archive of {ent['total']} entries:\n" + "\n".join(lines) + (
            f"\n... and {ent['total'] - 300} more" if ent["total"] > 300 else "")
        return Result(text=clip(text), say="Listed what is in {name}", vars=v, summary=f"{ent['total']} entries")
    if name.lower().endswith((".xlsx",)):
        try:
            t = await asyncio.to_thread(files.table_of, name, data, int(args.get("sheet") or 0))
        except (ValueError, TypeError) as exc:
            raise ToolError(str(exc)) from exc
        rows = ["\t".join(r) for r in t["rows"][:TABLE_ROWS]]
        text = head + (f"\nSheets: {', '.join(t['sheets'])}; sheet {t['sheet']}" if t["sheets"] else "") + \
            f"\n{t['total']} rows, tab-separated" + (f" (the first {TABLE_ROWS})" if t["total"] > TABLE_ROWS else "") + \
            ":\n" + "\n".join(rows)
        return Result(text=clip(text), say="Read {name}", vars=v, summary=f"{t['total']} rows")
    if b"\x00" in data[:4096]:
        return Result(text=head + "\nBinary content: not readable as text.", say="Looked at {name}", vars=v,
                      summary="binary")
    pages = _pages_of(files._decode(data))
    try:
        page = max(1, min(int(args.get("page") or 1), len(pages)))
    except (TypeError, ValueError):
        page = 1
    more = (f"\n(page {page} of {len(pages)}, {PAGE_CHARS:,} characters a page; ask for page {page + 1} for more)"
            if page < len(pages) else (f"\n(page {page} of {len(pages)})" if len(pages) > 1 else ""))
    text = clip(head + "\nContent:\n```\n" + pages[page - 1] + "\n```" + more)
    v = {**v, "page": page, "pages": len(pages)}
    say = "Read {name}" if len(pages) == 1 else "Read {name} · page {page} of {pages}"
    return Result(text=text, say=say, vars=v, summary=pages[page - 1][:300])


TOOL = Tool(
    name="file_read", level="read", order=70,
    label="Read a file",
    about="Reads a file from Files: text and tables, a PDF's pages, an image; or lists the files.",
    description="Read a file from this workspace's Files room. Text, CSV, JSON, Markdown, code, BOMs: the "
                f"content, {PAGE_CHARS:,} characters a `page`. A workbook (.xlsx): its cells (`sheet`). A PDF: "
                f"its text by `pages` like '1-3' (at most {MAX_PAGES} a call; the first 3 when not given), or "
                f"`query` for the {FIND_PAGES} pages where words appear; `image_page` gives one page as a picture "
                "for a model that reads images. An image: as a picture. An archive: what is in it. Without "
                "`file` it lists the files, newest first (`search` by name or note words, `kind` like pdf). "
                "A file may be named by its id or its name.",
    schema={"type": "object", "properties": {
        "file": {"type": "string", "description": "The file's id or name; leave out to list"},
        "page": {"type": "integer", "minimum": 1, "description": "Page of a text file, from 1"},
        "pages": {"type": "string", "description": "PDF pages, like '1-3' or '2,5'"},
        "query": {"type": "string", "description": "Words to find in a PDF"},
        "image_page": {"type": "integer", "minimum": 1, "description": "One PDF page, as a picture"},
        "sheet": {"type": "integer", "minimum": 0, "description": "A workbook's sheet, from 0"},
        "search": {"type": "string", "description": "When listing: words of the name or note"},
        "kind": {"type": "string", "enum": list(files.KINDS), "description": "When listing: only this kind"}}},
    running="Reading a file", failed="Could not read the file",
    run=run)
