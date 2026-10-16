"""pdf_make: a document written by the model, printed as a PDF (backend/pdfdoc.py:
by default the "document" theme - an engineering document's ruled header
of logo, title, number, page, date, revision, applicability, prepared,
subject and author on page 1, a one-row header on the others) and kept in the Files room - in
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
    "Make a PDF document - a report, a datasheet summary, a BOM, a comparison, a spec, a test plan - printed as an "
    "engineering document (page 1 opens with a ruled header: the Workbench logo, the title in capitals, and the "
    "fields Number, Page N of M, Date of writing, Revision, Applicability, Prepared, Subject and Author; the "
    "other pages have a one-row header with the title, number, revision and page) and kept in the Chat's own area of Files (In the app > Chat - not in the person's "
    "My files: when they ask to keep it in their files, copy it there with file_save_to_my_files). Use it when the person asks for a PDF, a report or a "
    "document to keep or share; not for a short answer. Gather the facts first with the other tools (drawer, "
    "datasheets, LCSC, boards, BOM cost, stock...) and only then write it: every value in it comes from them, "
    "not from memory. How to write it: `title` a few words; `purpose` one line saying what the document is for "
    "(it goes under the title and in every page's footer); `body` Markdown that opens with a short summary - the "
    "answer or the recommendation in two or three sentences - then sections under '## ' headings ('### ' under "
    "them), tables for comparisons, BOMs and specs with the units in the header or the cells and one row per "
    "part, '- [ ] ' for open actions, '> ' for a note that matters ('> [!WARNING]' for a risk), ``` for "
    "commands or code, and the sources cited where they are used (e.g. 'datasheet p. 4', an LCSC number, a link). "
    "Header fields: fill them yourself every time, from the document's content and the conversation - do not ask "
    "the person for them: `subject` one line saying what it is about (in the document's language), `number` a "
    "document number when the content or the person gives one (else leave it out: an automatic WB-<date>-<time> "
    "is printed), `revision` 0 for a first issue (or the revision the content says), `applicability` the board, "
    "product, part or scope it applies to ('—' when general), `prepared` the team or role implied by the content "
    "(e.g. 'Firmware team', 'Hardware team', 'Purchasing'; 'Workbench' when none), `date` only when the document "
    "is dated otherwise than today. `author` is the signed-in person by default: set it only to name someone else. "
    "Never put an e-mail address in any of them. Set `language` to the language you write the document in (tr "
    "prints Turkish labels and dates as dd.mm.yyyy). "
    "Pictures: ![caption](files:<id>) for a file of the Files room, or a public https address; "
    "![caption](files:<id> \"right\") floats it at the right beside the text. A line with only "
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


# The document theme's header fields the model fills (pdfdoc.fields has their defaults).
HEADER = ("number", "revision", "date", "applicability", "prepared", "subject")
_TR = re.compile(r"[çğışöüÇĞİŞÖÜ]")


def _line(raw, n: int) -> str:
    return " ".join(str(raw or "").split())[:n]


def guess_lang(text: str) -> str:
    """tr when the text is plainly Turkish (its letters), en otherwise."""
    letters = sum(c.isalpha() for c in text[:4000])
    return "tr" if letters and len(_TR.findall(text[:4000])) * 60 >= letters else "en"


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
    lang = str(args.get("language") or "").strip().lower()[:2] or guess_lang(body)
    theme = str(args.get("theme") or "document").strip().lower()
    if theme not in pdfdoc.THEMES:
        raise ToolError(f"theme is one of {', '.join(pdfdoc.THEMES)}")
    by = ctx.actor or actors.current() or {}
    author = pdfdoc.no_email(_line(args.get("author"), 120) or str(by.get("name") or ""))
    purpose = " ".join(str(args.get("purpose") or "").split())[:300]
    project = " ".join(str(args.get("project") or "").split())[:120]
    asked = str(args.get("folder") or "").strip().strip("/")
    if asked and asked.split("/")[0].lower() != "chat":
        asked = f"{FOLDER}/{asked}"
    where = asked or (f"{FOLDER}/{project.replace('/', '-')}"
                                                                 if project else FOLDER)
    doc = pdfdoc.Doc(title=title, body=body, purpose=purpose, author=author, project=project, size=page,
                     lang=lang if lang in pdfdoc.LABELS else "en", sections=sections, theme=theme,
                     **{k: _line(args.get(k), 40 if k in ("number", "revision", "date") else 160) for k in HEADER})
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
    name="pdf_make", package="pdf", level="change", order=40, default=True,
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
        "subject": {"type": "string", "description": "One line: what the document is about (header's Subject)"},
        "number": {"type": "string", "description": "Document number from the content, e.g. FC-STM001; "
                                                    "left out: WB-<yyyymmdd>-<hhmm>"},
        "revision": {"type": "string", "description": "Revision, 0 for a first issue"},
        "applicability": {"type": "string", "description": "The board, product, part or scope it applies to"},
        "prepared": {"type": "string", "description": "The team or role that prepared it, from the content "
                                                      "(e.g. Firmware team); left out: Workbench"},
        "date": {"type": "string", "description": "Only when not today: the date as it should be printed"},
        "author": {"type": "string", "description": "Only to name someone else than the person asking (no "
                                                    "e-mail address)"},
        "theme": {"type": "string", "enum": list(pdfdoc.THEMES),
                  "description": "document (default): the engineering header; simple: the plain one"},
        "project": {"type": "string", "description": "The board, model or project it is about: on every page, "
                                                     "and its folder Documents/<project>"},
        "folder": {"type": "string", "description": "A Files folder path to keep it in instead (made if missing)"},
        "filename": {"type": "string", "description": "The file's name (the title otherwise)"},
        "page_size": {"type": "string", "enum": ["A4", "Letter"], "description": "A4 unless asked"},
        "language": {"type": "string", "enum": ["en", "tr"],
                     "description": "The language the document is written in (its printed labels and date)"}},
        "required": ["title", "body"]},
    running="Making the PDF “{title}”", failed="Could not make the PDF “{title}”",
    run=run)
