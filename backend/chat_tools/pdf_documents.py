"""The document kinds, each its own tool (backend/pdfdoc.py, pdfparts.py).

Four shapes of one thing: a document a person asks for by name. Each builds the
sections and the parts it needs - the BOM's bill of materials, a plan's
pass/fail matrix with nothing measured yet, a comparison table, a datasheet's
key facts - and hands the whole thing to pdf_report's own `run`, so every one of
them prints the same sheet, is kept in the same place, and is undone the same
way. Nothing here fetches anything: the values come from the model, gathered
first with the tools that know them (the drawer, LCSC, datasheets, builds).

They exist because a model writes the right blocks more reliably when a tool
tells it what the document is: a BOM is not a table it invents, it is
`rows: [{ref, part, value, package, qty, lcsc}]`, and a plan's checks come out
"not checked" until somebody measures them - which is the truth about a plan.
"""

from __future__ import annotations

from . import Ctx, Result, Tool, ToolError
from . import pdf_report


def _rows(args: dict, key: str = "rows") -> list[dict]:
    raw = args.get(key)
    if not isinstance(raw, list) or not raw:
        raise ToolError(f"`{key}` is the list of rows this document is made of")
    out = []
    for r in raw[:200]:
        if not isinstance(r, dict):
            raise ToolError(f"every row of `{key}` is an object")
        out.append(r)
    return out


def _head(args: dict) -> dict:
    """The header fields every document kind shares."""
    return {k: args[k] for k in ("number", "revision", "date", "applicability", "prepared", "subject",
                                 "author", "project", "folder", "filename", "page_size", "language")
            if args.get(k) is not None}


async def _write(ctx: Ctx, args: dict, summary: str, sections: list[dict]) -> Result:
    title = " ".join(str(args.get("title") or "").split())[:200]
    if not title:
        raise ToolError("the document needs a title")
    return await pdf_report.run(ctx, {"title": title, "purpose": args.get("purpose"),
                                      "summary": summary, "sections": sections, **_head(args)})


async def _bom(ctx: Ctx, args: dict) -> Result:
    rows = _rows(args)
    part = {"part": "bom", "title": args.get("board") or "", "rows": rows,
            "per_board": args.get("per_board", True)}
    fields = [{"label": k, "value": v} for k, v in (args.get("fields") or {}).items()]
    sections = [{"title": "Bill of materials", "parts": [part]}]
    if fields:
        sections.append({"title": "Numbers", "parts": [{"part": "fields", "rows": fields}]})
    if args.get("notes"):
        sections.append({"title": "Notes", "text": str(args["notes"])})
    total = sum(int(float(str(r.get("qty") or 0).replace(",", "."))) for r in rows
                if str(r.get("qty") or "").strip().replace(".", "", 1).isdigit() or str(r.get("qty") or "").isdigit())
    return await _write(ctx, args,
                        str(args.get("summary") or
                            f"The build list: {len(rows)} lines, {total} pieces" +
                            (" per board." if args.get("per_board", True) else " for the whole build.")),
                        sections)


async def _test_plan(ctx: Ctx, args: dict) -> Result:
    checks = _rows(args, "checks")
    matrix = {"part": "pass-fail-matrix", "title": args.get("board") or "", "rows": checks}
    sections = [{"title": "Checks", "parts": [matrix]}]
    if args.get("steps"):
        sections.insert(0, {"title": "Procedure", "text":
                            "\n".join(f"{i}. {s}" for i, s in enumerate(args["steps"], 1))})
    if args.get("measurements"):
        sections.append({"title": "Measurements to take", "parts": [
            {"part": "measurement-table", "title": args.get("board") or "", "rows": args["measurements"]}]})
    return await _write(ctx, args,
                        str(args.get("summary") or
                            f"{len(checks)} check(s) to run; nothing is measured yet, so the "
                            f"matrices read \"not checked\" until they are."),
                        sections)


async def _compare(ctx: Ctx, args: dict) -> Result:
    options = [str(o) for o in (args.get("options") or [])][:8]
    if not options:
        raise ToolError("`options` are the things compared, in the order of the columns")
    rows = _rows(args, "criteria")
    head = "| | " + " | ".join(options) + " |\n|" + "---|" * (len(options) + 1)
    lines = [head]
    for r in rows:
        cells = r.get("values")
        if not isinstance(cells, list):
            cells = [r.get(o) for o in options]
        cells = [(str(c) if c not in (None, "") else "—") for c in cells][:len(options)]
        cells += ["—"] * (len(options) - len(cells))
        lines.append(f"| **{str(r.get('what') or '').strip()}** | " + " | ".join(cells) + " |")
    body = "\n".join(lines)
    sections = [{"title": "Comparison", "text": body}]
    if args.get("measurements"):
        sections.append({"title": "Numbers", "parts": [
            {"part": "measurement-table", "rows": args["measurements"]}]})
    if args.get("verdict"):
        sections.append({"title": "Recommendation", "text": str(args["verdict"])})
    return await _write(ctx, args,
                        str(args.get("summary") or
                            f"{len(options)} option(s) against {len(rows)} criteria."), sections)


async def _datasheet(ctx: Ctx, args: dict) -> Result:
    fields = [{"label": k, "value": v} for k, v in (args.get("fields") or {}).items()]
    sections = []
    if fields:
        sections.append({"title": "Key facts", "parts": [{"part": "fields", "rows": fields}]})
    for s in (args.get("sections") or []):
        if isinstance(s, dict):
            sections.append({"title": s.get("heading") or s.get("title") or "", "text": str(s.get("text") or "")})
    if not sections:
        raise ToolError("a datasheet summary needs `fields` (the key facts) and/or `sections`")
    part = args.get("part") or ""
    return await _write(ctx, args,
                        str(args.get("summary") or
                            f"What {part or 'the part'} is and the numbers that matter, from its datasheet."
                            if part else "What the part is and the numbers that matter."), sections)


HEADER = {
    "subject": {"type": "string", "description": "One line: what the document is about"},
    "number": {"type": "string", "description": "Document number from the content"},
    "revision": {"type": "string", "description": "Revision, 0 for a first issue"},
    "applicability": {"type": "string", "description": "The board, product, part or scope it applies to"},
    "prepared": {"type": "string", "description": "The team or role that prepared it"},
    "date": {"type": "string", "description": "Only when not today"},
    "author": {"type": "string", "description": "Only to name someone else than the person asking"},
    "project": {"type": "string", "description": "The board, model or project it is about"},
    "folder": {"type": "string", "description": "A Files folder path to keep it in instead"},
    "filename": {"type": "string", "description": "The file's name (the title otherwise)"},
    "page_size": {"type": "string", "enum": ["A4", "Letter"]},
    "language": {"type": "string", "enum": ["en", "tr"], "description": "The language of the document"},
}
GEN = ("title", "purpose", "summary")

TOOLS = [
    Tool(name="pdf_bom", package="pdf", level="change", order=45, default=True,
         label="Write a BOM",
         about="A build list as a document: lines, quantities, LCSC numbers, a total.",
         description="A bill of materials printed as a document and kept in Files > Documents, with the LCSC "
                     "numbers and a line total. Give `rows` - one per line: {ref, part, value, package, qty, "
                     "lcsc} - from the drawer, the board's BOM or LCSC, never from memory; `per_board` false when "
                     "the quantities are for the whole build. `fields` prints a specification block beside it "
                     "(board, revision, cost). It returns the file's id and its link: link it in your answer.",
         schema={"type": "object", "properties": {
             "title": {"type": "string"}, "purpose": {"type": "string"}, "summary": {"type": "string"},
             "board": {"type": "string", "description": "What the build is, printed above the table"},
             "rows": {"type": "array", "description": "One per line of the BOM", "items": {
                 "type": "object", "properties": {
                     "ref": {"type": "string"}, "part": {"type": "string"}, "value": {"type": "string"},
                     "package": {"type": "string"}, "qty": {"type": "string"}, "lcsc": {"type": "string"}}}},
             "per_board": {"type": "boolean", "description": "Quantities are for one board (default)"},
             "fields": {"type": "object", "description": "{label: value} printed beside the table"},
             "notes": {"type": "string"}, **HEADER},
             "required": ["title", "rows"]},
         running="Writing “{title}”", failed="Could not write “{title}”", run=_bom),

    Tool(name="pdf_test_plan", package="pdf", level="change", order=46, default=True,
         label="Write a test plan",
         about="A plan of checks and measurements, to be filled in on the bench.",
         description="A test plan as a document: what will be checked and what each check should read, printed as "
                     "a pass/fail matrix that says \"not checked\" until somebody measures it - which is the truth "
                     "about a plan. `checks`: [{what, expected}] from the design (the board's nets, the firmware's "
                     "behaviour), `steps` the procedure in order, `measurements`: [{what, unit, limit, method}] the "
                     "numbers to take. It returns the file's id and its link.",
         schema={"type": "object", "properties": {
             "title": {"type": "string"}, "purpose": {"type": "string"}, "summary": {"type": "string"},
             "board": {"type": "string"},
             "checks": {"type": "array", "items": {"type": "object", "properties": {
                 "what": {"type": "string"}, "expected": {"type": "string"}}}},
             "steps": {"type": "array", "items": {"type": "string"}},
             "measurements": {"type": "array", "items": {"type": "object", "properties": {
                 "what": {"type": "string"}, "unit": {"type": "string"}, "limit": {"type": "string"},
                 "method": {"type": "string"}}}}, **HEADER},
             "required": ["title", "checks"]},
         running="Writing “{title}”", failed="Could not write “{title}”", run=_test_plan),

    Tool(name="pdf_compare", package="pdf", level="change", order=47, default=True,
         label="Write a comparison",
         about="Options against criteria, as a table with a recommendation.",
         description="A comparison printed as a document: `options` are the things compared (one column each, at "
                     "most eight), `criteria` the rows - {what, values: [one per option]} or {what, <option>: "
                     "cell}. `verdict` is the recommendation in a sentence. Prices and facts in the cells come "
                     "from the tools that know them (LCSC's price breaks, a datasheet's table), never from memory, "
                     "and a cell nobody knows prints as an em dash rather than a guess. It returns the file's id "
                     "and its link.",
         schema={"type": "object", "properties": {
             "title": {"type": "string"}, "purpose": {"type": "string"}, "summary": {"type": "string"},
             "options": {"type": "array", "items": {"type": "string"}},
             "criteria": {"type": "array", "items": {"type": "object", "properties": {
                 "what": {"type": "string"}, "values": {"type": "array", "items": {"type": "string"}}}}},
             "verdict": {"type": "string", "description": "The recommendation, in a sentence"},
             "measurements": {"type": "array", "items": {"type": "object"}}, **HEADER},
             "required": ["title", "options", "criteria"]},
         running="Writing “{title}”", failed="Could not write “{title}”", run=_compare),

    Tool(name="pdf_datasheet_summary", package="pdf", level="change", order=48, default=True,
         label="Summarise a datasheet",
         about="A part's key facts and limits, page by page, as a document.",
         description="A part's datasheet summary printed as a document: `fields` is the key-facts block "
                     "({label: value}, e.g. 'Supply voltage': '1.7–3.6 V', 'Iq': '2.1 µA typ.'), `sections` its "
                     "prose by heading. Every number must come from the datasheet the model read "
                     "(datasheet_get / datasheet_read, part datasheet), cited by page in the text - a figure "
                     "without its page is not taken from anywhere. It returns the file's id and its link.",
         schema={"type": "object", "properties": {
             "title": {"type": "string"}, "purpose": {"type": "string"}, "summary": {"type": "string"},
             "part": {"type": "string", "description": "The part it is about (LCSC number or MPN)"},
             "fields": {"type": "object", "description": "{label: value}, the key facts and limits"},
             "sections": {"type": "array", "items": {"type": "object", "properties": {
                 "heading": {"type": "string"}, "text": {"type": "string"}}}}, **HEADER},
             "required": ["title"]},
         running="Writing “{title}”", failed="Could not write “{title}”", run=_datasheet),
]
