"""Reading a PDF: its text a page at a time, and a page as a picture.

A datasheet's numbers sit in tables and drawings - an OLED panel's glass
height is a dimension line on its mechanical drawing, not a sentence - so an
agent reads the text first and looks at the page when the text is not
enough. Both are done here, on the server, so an agent with only a token
(REDLINE_TRANSPORT=api) reads the same PDFs as one on the machine.

pypdfium2 (Apache-2.0 / BSD-3) carries PDFium in its wheel: nothing to
install on the system. PDFium is not safe to call from two threads at once,
so every use goes through one lock.

Errors are `PdfError` (ValueError) with a sentence that says what is wrong:
not a PDF, protected by a password, damaged, a page that is not there.
"""

from __future__ import annotations

import io
import re
import threading

MAX_BYTES = 60 * 1024 * 1024      # a PDF larger than this is not opened
MAX_PAGES = 50                    # pages of text in one answer
MAX_PAGE_CHARS = 60_000           # one page's text, beyond which it is cut
MAX_DPI = 300
MIN_DPI = 36
MAX_PX = 4000                     # the longer side of a rendered page

_LOCK = threading.RLock()
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class PdfError(ValueError):
    """The PDF cannot be read as asked; the message says why."""


def is_pdf(blob: bytes) -> bool:
    return isinstance(blob, (bytes, bytearray)) and b"%PDF-" in bytes(blob[:1024])


def parse_pages(spec: str | None, count: int, limit: int = MAX_PAGES) -> list[int]:
    """Page numbers (1-based) from "1-3", "2", "1,4,7-9", "5-" (to the end),
    "-3" (the first three) or ""/None/"all" (from the first). Pages past the
    end are dropped; more than `limit` are cut to the first `limit`.
    Raises PdfError for what is not a range or names no page there is."""
    if count <= 0:
        raise PdfError("the PDF has no pages")
    text = (spec or "").strip().lower()
    if text in ("", "all", "*"):
        text = "1-"
    want: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        m = re.fullmatch(r"(\d*)\s*-\s*(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else count
        elif re.fullmatch(r"\d+", part):
            a = b = int(part)
        else:
            raise PdfError(f"{spec!r} is not a page range (like 1-3, 2, 1,4,7-9 or 5-)")
        if a < 1 or b < a:
            raise PdfError(f"{part!r} is not a page range (pages count from 1)")
        want.update(range(a, min(b, count) + 1))
        if len(want) > limit * 4:          # "1-999999" is not a reason to build a huge set
            break
    if not want:
        raise PdfError(f"no page {spec} - the PDF has {count} page{'s' if count != 1 else ''}")
    return sorted(want)[:limit]


def _open(blob: bytes):
    import pypdfium2 as pdfium

    if not is_pdf(blob):
        raise PdfError("not a PDF (it does not start with %PDF-)")
    if len(blob) > MAX_BYTES:
        raise PdfError(f"the PDF is over {MAX_BYTES // (1024 * 1024)} MB - not opened")
    try:
        return pdfium.PdfDocument(bytes(blob))
    except pdfium.PdfiumError as exc:
        code = getattr(exc, "err_code", None)
        if code == 4:                                  # FPDF_ERR_PASSWORD
            raise PdfError("the PDF is protected by a password - it cannot be read here") from exc
        if code == 6:                                  # FPDF_ERR_SECURITY
            raise PdfError("the PDF uses a security handler PDFium does not support") from exc
        raise PdfError(f"the PDF is damaged or not a PDF PDFium can read ({exc})") from exc


def _clean(text: str) -> str:
    """PDFium's text with its line breaks kept: \\r\\n to \\n, a hyphen PDFium
    marks at a line's end (\\x02) back to "-", no trailing spaces, at most one
    blank line in a row, no control characters (glyphs PDFium could not
    map to text)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x02\n", "-\n")
    text = _CONTROL.sub("", text).translate({0xFFFE: None, 0xFEFF: None, 0xFFFD: None})
    lines = [ln.rstrip() for ln in text.split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip("\n")
    if len(text) > MAX_PAGE_CHARS:
        text = text[:MAX_PAGE_CHARS] + "\n[... the rest of this page's text is cut]"
    return text


def page_count(blob: bytes) -> int:
    with _LOCK:
        pdf = _open(blob)
        try:
            return len(pdf)
        finally:
            pdf.close()


def text(blob: bytes, pages: str | None = None) -> dict:
    """{"count": N, "pages": [{"n": 1, "text": "..."}, ...]} for the pages
    asked for (parse_pages), at most MAX_PAGES of them."""
    with _LOCK:
        pdf = _open(blob)
        try:
            count = len(pdf)
            out = []
            for n in parse_pages(pages, count):
                page = pdf[n - 1]
                try:
                    tp = page.get_textpage()
                    try:
                        out.append({"n": n, "text": _clean(tp.get_text_range())})
                    finally:
                        tp.close()
                except Exception as exc:                # noqa: BLE001 - one bad page, not the whole PDF
                    out.append({"n": n, "text": "", "error": f"page {n} could not be read ({exc})"})
                finally:
                    page.close()
            return {"count": count, "pages": out}
        finally:
            pdf.close()


def clamp_dpi(dpi: float | int | None) -> float:
    try:
        d = float(dpi) if dpi is not None else 150.0
    except (TypeError, ValueError):
        d = 150.0
    if d != d:                                          # NaN
        d = 150.0
    return max(float(MIN_DPI), min(float(MAX_DPI), d))


def render_png(blob: bytes, n: int, dpi: float | int | None = 150) -> tuple[bytes, dict]:
    """Page `n` (1-based) as a PNG, at `dpi` (36..300), made smaller if its
    longer side would pass MAX_PX. Returns the PNG and {"n", "count",
    "dpi", "width", "height"} - the dpi it was actually drawn at."""
    with _LOCK:
        pdf = _open(blob)
        try:
            count = len(pdf)
            if not isinstance(n, int) or n < 1 or n > count:
                raise PdfError(f"no page {n} - the PDF has {count} page{'s' if count != 1 else ''}")
            page = pdf[n - 1]
            try:
                w_pt, h_pt = page.get_size()
                dpi_used = clamp_dpi(dpi)
                longest = max(w_pt, h_pt, 1.0) / 72.0 * dpi_used
                if longest > MAX_PX:
                    dpi_used = dpi_used * MAX_PX / longest
                bitmap = page.render(scale=dpi_used / 72.0, may_draw_forms=True)
                try:
                    im = bitmap.to_pil()
                finally:
                    bitmap.close()
            except PdfError:
                raise
            except Exception as exc:                    # noqa: BLE001 - PDFium's failure, said plainly
                raise PdfError(f"page {n} could not be drawn ({exc})") from exc
            finally:
                page.close()
        finally:
            pdf.close()
    buf = io.BytesIO()
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.save(buf, "PNG", optimize=False, compress_level=6)
    return buf.getvalue(), {"n": n, "count": count, "dpi": round(dpi_used, 1),
                            "width": im.width, "height": im.height}
