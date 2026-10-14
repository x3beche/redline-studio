"""pdf_make: a document written by the model, printed as a PDF in Workbench's
white theme (backend/pdfdoc.py) and kept in the Files room - in
"Documents", or "Documents/<project>" when it is about one, or the folder
asked for - by the asker, as an upload would keep it (files.put).

The step shows the file (its id, name, pages, size): the page opens it in
the Chat's PDF viewer, and the model links it in its answer.

SKILL below is how to write one; it is the tool's description, so the
model has it whenever it has the tool."""

from __future__ import annotations

import re

from .. import actors, files, pdfdoc
from . import Ctx, Result, Tool, ToolError, size
from ._rights import need

# What the Chat makes is the Chat's (Files > In the app > Chat), kept under the Chat folder;
# it reaches My files only as a copy (file_save_to_my_files).
FOLDER = "Chat/Documents"
NAME_MAX = 120

SKILL = (
    "Make a PDF document - a report, a datasheet summary, a BOM, a comparison, a spec, a test plan - printed in "
    "Workbench's white theme (the Workbench mark at the top of every page; the author, date and time, purpose and "
    "page N of M at the bottom) and kept in the Chat's own area of Files (In the app > Chat - not in the person's "
    "My files: when they ask to keep it in their files, copy it there with file_save_to_my_files). Use it when the person asks for a PDF, a report or a "
    "document to keep or share; not for a short answer. Gather the facts first with the other tools (drawer, "
    "datasheets, LCSC, boards, BOM cost, stock...) and only then write it: every value in it comes from them, "
    "not from memory. How to write it: `title` a few words; `purpose` one line saying what the document is for "
    "(it goes under the title and in every page's footer); `body` Markdown that opens with a short summary - the "
    "answer or the recommendation in two or three sentences - then sections under '## ' headings ('### ' under "
    "them), tables for comparisons, BOMs and specs with the units in the header or the cells and one row per "
    "part, '- [ ] ' for open actions, '> ' for a note that matters ('> [!WARNING]' for a risk), ``` for "
    "commands or code, and the sources cited where they are used (e.g. 'datasheet p. 4', an LCSC number, a link). "
    "Pictures: ![caption](files:<id>) for a file of the Files room, or a public https address. A line with only "
    "\\pagebreak starts a new page. No filler, no repeated headings, no closing pleasantries. Do not put the "
    "title in the body (it is printed above it). `sections` adds parts after the body, e.g. one per tool result "
    "you summarise. It returns the file's id and its link: link the PDF in your answer as "
    "[name](/api/files/<id>?inline=1) - the page opens it in its PDF viewer.")


def filename(raw: str) -> str:
    """A file name from the asked-for name or the title: no path, no
    control or reserved characters, ending in .pdf."""
    n = re.sub(r"[\x00-\x1f\\/:*?\"<>|]+", " ", str(raw or ""))
    n = re.sub(r"\s+", " ", n).strip(" .")
    if n.lower().endswith(".pdf"):
        n = n[:-4].rstrip()
    n = n[: NAME_MAX - 4].rstrip() or "Document"
    return n + ".pdf"


async def _free(db, folder: str, name: str) -> str:
    """`name`, or `name (2)`, ... - not one already in the folder."""
    stem, n = name[:-4], 1
    cand = name
    while await db[files.COLL].find_one({"folder": folder, "name": cand}, {"_id": 1}):
        n += 1
        cand = f"{stem} ({n}).pdf"
        if n > 200:
            break
    return cand


def _sections(raw) -> list[dict]:
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list):
        raise ToolError("`sections` is a list of {title, body}")
    out = []
    for s in raw[:40]:
        if isinstance(s, dict):
            out.append({"title": str(s.get("title") or "")[:200], "body": str(s.get("body") or "")})
        elif isinstance(s, str):
            out.append({"title": "", "body": s})
    return out


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/files")
    title = " ".join(str(args.get("title") or "").split())[:200]
    if not title:
        raise ToolError("the document needs a title")
    body = str(args.get("body") or "")
    sections = _sections(args.get("sections"))
    if not body.strip() and not any(s["body"].strip() for s in sections):
        raise ToolError("the document has no text - write its body as Markdown")
    page = str(args.get("page_size") or "A4").strip()
    page = {"a4": "A4", "letter": "Letter"}.get(page.lower(), page)
    if page not in pdfdoc.SIZES:
        raise ToolError(f"page_size is one of {', '.join(pdfdoc.SIZES)}")
    lang = str(args.get("language") or "en").strip().lower()[:2]
    by = ctx.actor or actors.current() or {}
    author = " ".join(str(args.get("author") or "").split())[:120] or str(by.get("name") or "")
    purpose = " ".join(str(args.get("purpose") or "").split())[:300]
    project = " ".join(str(args.get("project") or "").split())[:120]
    asked = str(args.get("folder") or "").strip().strip("/")
    if asked and asked.split("/")[0].lower() != "chat":
        asked = f"{FOLDER}/{asked}"
    where = asked or (f"{FOLDER}/{project.replace('/', '-')}"
                                                                 if project else FOLDER)
    doc = pdfdoc.Doc(title=title, body=body, purpose=purpose, author=author, project=project, size=page,
                     lang=lang if lang in pdfdoc.LABELS else "en", sections=sections)
    try:
        made = await pdfdoc.make(doc, ctx.db)
    except pdfdoc.RenderError as exc:
        raise ToolError(str(exc)) from exc
    try:
        folder = await files.make_path(ctx.db, where, by)
    except (ValueError, KeyError) as exc:
        raise ToolError(f"the folder {where!r}: {exc}") from exc
    name = await _free(ctx.db, folder["_id"], filename(args.get("filename") or title))
    context = {"room": "commandcode", **({"chat": ctx.chat} if ctx.chat else {})}
    try:
        d = await files.put(ctx.db, name, made.pdf, "application/pdf", context, by, note=purpose,
                            folder=folder["_id"])
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    link = f"/api/files/{d['_id']}?inline=1"
    lines = [f"Made {name}: {made.pages} page{'s' if made.pages != 1 else ''}, {size(len(made.pdf))}, "
             f"kept in Files > {folder.get('path') or where} (file id {d['_id']}).",
             f"Link it in your answer as [{name}]({link}) - it opens in the Chat's PDF viewer."]
    if made.missing:
        lines.append("Pictures left out (shown as a note in the PDF): " + "; ".join(made.missing[:8]))
    return Result(text="\n".join(lines), say="Made {name} · {pages} pages",
                  vars={"name": name, "pages": made.pages, "file": d["_id"], "size": size(len(made.pdf)),
                        "folder": folder.get("path") or where},
                  summary=f"{name} · {made.pages} pages · {size(len(made.pdf))} · Files > "
                          f"{folder.get('path') or where}")


TOOL = Tool(
    name="pdf_make", package="commandcode", level="change", order=40, default=True,
    label="Make a PDF",
    about="Writes a document as a PDF in Workbench's theme and keeps it in Files.",
    description=SKILL,
    schema={"type": "object", "properties": {
        "title": {"type": "string", "description": "The document's title, a few words"},
        "purpose": {"type": "string", "description": "One line: what the document is for"},
        "body": {"type": "string", "description": "The document as Markdown: a short summary first, then '## ' "
                                                  "sections, GFM tables (units in them), '- [ ] ' tasks, sources"},
        "sections": {"type": "array", "description": "More parts after the body, in order",
                     "items": {"type": "object", "properties": {
                         "title": {"type": "string"}, "body": {"type": "string", "description": "Markdown"}}}},
        "author": {"type": "string", "description": "Only to name someone else than the person asking"},
        "project": {"type": "string", "description": "The board, model or project it is about: on every page, "
                                                     "and its folder Documents/<project>"},
        "folder": {"type": "string", "description": "A Files folder path to keep it in instead (made if missing)"},
        "filename": {"type": "string", "description": "The file's name (the title otherwise)"},
        "page_size": {"type": "string", "enum": ["A4", "Letter"], "description": "A4 unless asked"},
        "language": {"type": "string", "enum": ["en", "tr"],
                     "description": "The language the document is written in (its printed labels)"}},
        "required": ["title", "body"]},
    running="Making the PDF “{title}”", failed="Could not make the PDF “{title}”",
    run=run)
