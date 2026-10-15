"""file_ocr: the words on a file that has no text layer - a photograph of a
document, a page off a scanner, a screenshot, a scan of a drawing - written
out by a model that sees the pages (backend/ocrtext.py, the "file_ocr" job).

Reading a page is a model call, so it is not instant: the tool waits up to
MAX_WAIT and, when the pages are still being read, tells the model to ask
again in a moment (the read goes on by itself and the words are kept).
backend/chat_tools/README.md lists it with the other Files tools.
"""

from __future__ import annotations

from .. import ocrtext
from . import Ctx, Result, Tool, ToolError, clip
from ._product import mentioned_files
from .file_read import PAGE_CHARS, _find, _pages_of

MAX_WAIT = 60.0                     # a first read of a few pages takes about this long; past it, ask again
LANG = 8                            # characters of the language code that mean anything


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("file") or "").strip()
    if not ref:
        got = await mentioned_files(ctx)
        if not got:
            raise ToolError("name the file to read - its id or its name - or attach it to your line")
        ref = got[0]
    d = await _find(ctx, ref)
    name = d.get("name") or d["_id"]
    lang = str(args.get("lang") or "").strip().lower()[:LANG]
    v = {"file": d["_id"], "name": name}
    state, got = await ocrtext.words(ctx.db, d, MAX_WAIT, lang)
    if state in ("making", "busy"):
        return Result(text=(f"The pages of {name} are still being read - a model is looking at them, or the read "
                            f"waits its turn. Call this again with the same file in about {ocrtext.RETRY_AFTER} "
                            "seconds: the words are kept once they are read, and the second call costs nothing."),
                      say="Still reading {name}", vars=v, summary="still reading")
    if state == "none":
        raise ToolError(f"no words could be read from {name}: {got}")
    parts = _pages_of(got)
    try:
        page = max(1, min(int(args.get("page") or 1), len(parts)))
    except (TypeError, ValueError):
        page = 1
    head = (f"The words on {name}: {len(got):,} characters, a page at a time. A page a model looked at is marked "
            "'--- page N ---'; a page a PDF carried as its own text is read from the PDF, its tables as rows. "
            "Cite a page as (p. N).")
    more = (f"\n\n(part {page} of {len(parts)}, {PAGE_CHARS:,} characters a part; ask for part {page + 1} for more)"
            if page < len(parts) else "")
    v = {**v, "page": page, "parts": len(parts), "chars": len(got)}
    say = "Read the words on {name} · part {page} of {parts}" if len(parts) > 1 else "Read the words on {name}"
    return Result(text=clip(head + "\n\n" + parts[page - 1] + more), say=say, vars=v, summary=got[:300])


TOOL = Tool(
    name="file_ocr", package="files", level="read", order=71,
    label="Read a file's text",
    about="Reads the words on a photographed or scanned page, by a model that looks at it (OCR); "
          "a PDF's own text is read first.",
    description="The words on a file that has no text layer: a photograph of a document, a page off a scanner, a "
                "screenshot, a scan of a drawing. A model that reads images looks at the pages and writes their "
                "words out as text (OCR; at most "
                f"{ocrtext.MAX_SHOTS} pages of pictures a call). A PDF has the pages that do carry text read "
                "straight from it, so only its pages that are pictures cost this, and a PDF that is all text costs "
                "nothing. Use it when file_read returns an empty or nearly empty page, or when the person says the "
                "file is a scan or a photo. A page the model read is marked '--- page N ---', tables come as rows; "
                "cite a page as (p. N). The first read takes a while (up to a minute for several pages) and the "
                "words are kept after that; a long text is read a `page` at a time.",
    schema={"type": "object", "properties": {
        "file": {"type": "string", "description": "The file's id or name; the one attached to the line when left out"},
        "page": {"type": "integer", "minimum": 1, "description": "Part of a long text, from 1"},
        "lang": {"type": "string", "description": "Write the words in this language ('tr', 'en'); leave out to keep "
                                                  "the language on the page"}}},
    running="Reading a file's words", failed="Could not read the file's words",
    run=run)
