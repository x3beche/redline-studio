"""pdf_report: a document written as sections of parts (backend/pdfparts.py).

The same sheet as pdf_make (backend/pdfdoc.py, the "document" theme) but built
the other way round: instead of prose with a few tables in it, the model gives
a title, its header fields, a short summary and a list of sections - and each
section carries its own text and the parts it argues with (bodies of structured
values drawn by the parts).

Why a second tool rather than a longer pdf_make: a model writes a measurement
table, a BOM or a pinout far more reliably as fields than as Markdown, and a
part cannot leave a number looking measured when the method is missing. Use it
for anything a person will read as a document - a test report, a bench
measurement, a design note, a BOM with a build; pdf_make stays the free one,
for prose.

The values are still the model's: a part draws what it is given and says what
is missing (see pdf_parts)."""

from __future__ import annotations

from .. import actors, files, pdfdoc, pdfparts
from . import Ctx, Result, Tool, ToolError, size
from ._rights import need
from .pdf_make import FOLDER, HEADER, _free, _line, filename, guess_lang

MAX_SECTIONS = 40
MAX_PARTS = 60


def _sections(raw) -> list[dict]:
    """The sections, each with its prose and its parts, as the fence blocks the
    renderer draws (backend/pdfdoc.py)."""
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list):
        raise ToolError("`sections` is a list of {title, text, parts}")
    out = []
    for s in raw[:MAX_SECTIONS]:
        if not isinstance(s, dict):
            raise ToolError("every section is an object: {title, text, parts}")
        parts, total = [], 0
        for p in (s.get("parts") or []):
            if not isinstance(p, dict):
                raise ToolError("every part is an object with a `part` name (see pdf_parts)")
            name = str(p.get("part") or "").strip()
            if name not in pdfparts.PARTS:
                raise ToolError(f"no part {name!r} - read pdf_parts for the list and their fields")
            total += 1
            if total > MAX_PARTS:
                break
            body = {k: v for k, v in p.items() if k != "part"}
            parts.append(pdfdoc.part_fence(name, body))
        body = str(s.get("text") or "").strip()
        if not body and not parts:
            continue
        out.append({"title": _line(s.get("title"), 200), "text": body,
                    "fence": "\n\n".join(parts)})
    return out


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/files")
    title = " ".join(str(args.get("title") or "").split())[:200]
    if not title:
        raise ToolError("the document needs a title")
    sections = _sections(args.get("sections"))
    summary = " ".join(str(args.get("summary") or "").split())[:2000]
    if not summary and not sections:
        raise ToolError("the document has nothing in it - write `summary`, or a `sections` list")
    page = str(args.get("page_size") or "A4").strip()
    page = {"a4": "A4", "letter": "Letter"}.get(page.lower(), page)
    if page not in pdfdoc.SIZES:
        raise ToolError(f"page_size is one of {', '.join(pdfdoc.SIZES)}")
    lang = str(args.get("language") or "").strip().lower()[:2] or guess_lang(summary or title)
    by = ctx.actor or actors.current() or {}
    author = pdfdoc.no_email(_line(args.get("author"), 120) or str(by.get("name") or ""))
    purpose = " ".join(str(args.get("purpose") or "").split())[:300]
    project = " ".join(str(args.get("project") or "").split())[:120]
    # The prose first, then each section under '## ', its parts under it.
    body = summary
    pieces = []
    for s in sections:
        chunk = (f"## {s['title']}" if s["title"] else "## ")
        if s["text"]:
            chunk += "\n\n" + s["text"]
        if s["fence"]:
            chunk += "\n\n" + s["fence"]
        pieces.append(chunk)
    body = "\n\n".join([p for p in [body] + pieces if p.strip()])
    doc = pdfdoc.Doc(title=title, body=body, purpose=purpose, author=author, project=project, size=page,
                     lang=lang if lang in pdfdoc.LABELS else "en", theme="document",
                     **{k: _line(args.get(k), 40 if k in ("number", "revision", "date") else 160)
                        for k in HEADER})
    try:
        made = await pdfdoc.make(doc, ctx.db)
    except pdfdoc.RenderError as exc:
        raise ToolError(str(exc)) from exc
    asked = str(args.get("folder") or "").strip().strip("/")
    if asked and asked.split("/")[0].lower() != "chat":
        asked = f"{FOLDER}/{asked}"
    where = asked or (f"{FOLDER}/{project.replace('/', '-')}" if project else FOLDER)
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
    parts = sum(s["fence"].count("part:") for s in sections)
    lines = [f"Made {name}: {made.pages} page{'s' if made.pages != 1 else ''}, {size(len(made.pdf))}, "
             f"{len(sections)} section(s) and {parts} part(s), kept in Files > {folder.get('path') or where} "
             f"(file id {d['_id']}).",
             f"Link it in your answer as [{name}]({link}) - it opens in the Chat's PDF viewer."]
    if made.missing:
        lines.append("Pictures left out (shown as a note in the PDF): " + "; ".join(made.missing[:8]))
    return Result(text="\n".join(lines), say="Made {name} · {pages} pages",
                  vars={"name": name, "pages": made.pages, "file": d["_id"], "size": size(len(made.pdf)),
                        "folder": folder.get("path") or where},
                  summary=f"{name} · {made.pages} pages · {size(len(made.pdf))} · Files > "
                          f"{folder.get('path') or where}")


TOOL = Tool(
    name="pdf_report", package="pdf", level="change", order=35, default=True,
    label="Write a report",
    about="A document built from parts: measurements, a BOM, a pinout, a pass/fail matrix.",
    description="Write a document as sections of parts - the workhorse for a test report, a bench measurement, a "
                "design note, a BOM with a build. Read pdf_parts first: it lists every part and its fields. "
                "`title` a few words; `purpose` one line saying what it is for; `summary` the answer or the "
                "recommendation in two or three sentences (it opens the document); `sections` in order, each "
                "{title, text, parts} - `text` is Markdown prose for that section, `parts` is the list of blocks "
                "the section argues with, each {part: '<name>', ...its fields}. Everything a part prints is a "
                "value you gave it, so gather the numbers first from the tools that know them (drawer, "
                "datasheets, LCSC, builds, a measurement) rather than from memory - and leave out a value you do "
                "not have: a part says what is missing instead of inventing it. Header fields (subject, number, "
                "revision, applicability, prepared, date, author) as in pdf_make - fill them from the content, "
                "do not ask the person. It returns the file's id and its link: link it in your answer as "
                "[name](/api/files/<id>?inline=1).",
    schema={"type": "object", "properties": {
        "title": {"type": "string", "description": "The document's title, a few words"},
        "purpose": {"type": "string", "description": "One line: what the document is for"},
        "summary": {"type": "string", "description": "The answer or the recommendation, two or three sentences, "
                                                     "Markdown; it opens the document"},
        "sections": {"type": "array", "description": "The document, in order",
                     "items": {"type": "object", "properties": {
                         "title": {"type": "string", "description": "The section's heading"},
                         "text": {"type": "string", "description": "That section's prose, Markdown"},
                         "parts": {"type": "array", "description": "The parts it argues with (see pdf_parts)",
                                   "items": {"type": "object",
                                             "properties": {"part": {"type": "string",
                                                                     "description": "A part name, e.g. "
                                                                                    "measurement-table"}},
                                             "required": ["part"]}}}},
                     "required": ["title"]},
        "subject": {"type": "string", "description": "One line: what the document is about (header's Subject)"},
        "number": {"type": "string", "description": "Document number from the content, e.g. FC-STM001"},
        "revision": {"type": "string", "description": "Revision, 0 for a first issue"},
        "applicability": {"type": "string", "description": "The board, product, part or scope it applies to"},
        "prepared": {"type": "string", "description": "The team or role that prepared it, from the content"},
        "date": {"type": "string", "description": "Only when not today: the date as it should be printed"},
        "author": {"type": "string", "description": "Only to name someone else than the person asking"},
        "project": {"type": "string", "description": "The board, model or project it is about"},
        "folder": {"type": "string", "description": "A Files folder path to keep it in instead"},
        "filename": {"type": "string", "description": "The file's name (the title otherwise)"},
        "page_size": {"type": "string", "enum": ["A4", "Letter"], "description": "A4 unless asked"},
        "language": {"type": "string", "enum": ["en", "tr"],
                     "description": "The language the document is written in"}},
        "required": ["title"]},
    running="Writing “{title}”", failed="Could not write “{title}”",
    run=run)
