"""The Chat's PDFs (backend/pdfdoc.py): Markdown printed as an engineering
document (the default theme) or in Workbench's plain white one.

What matters: what the model writes is text, never markup of its own (no
script, no raw HTML, no javascript: link); a picture is only ever a Files
file or a public address fetched here, re-encoded, and handed to the page
as a data: URL - nothing private is reached, and the browser fetches
nothing; tables put their numbers to the right, '- [ ]' are boxes. And,
where Docker and the Chromium image are there, a real document prints
with its header - page 1 the big one with every field, the other pages the
compact one - and a true "Page N of M"; the plain theme with the Workbench
mark, the title, the author, its purpose and "Page N of M" on its pages.
"""

from __future__ import annotations

import asyncio
import io
import re
import shutil
import subprocess
from datetime import datetime, timezone

import pytest

from backend import files, manufacturers, pdfdoc


def run(coro):
    return asyncio.run(coro)


def _png(w=30, h=20, colour="red") -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(buf, "PNG")
    return buf.getvalue()


# ---------------------------------------------------------------- Markdown -> HTML

def test_raw_html_and_scripts_are_text():
    out = pdfdoc.md_html('<script>alert(1)</script>\n\nHi <img src=x onerror=alert(1)> <b>bold</b>')
    assert "<script" not in out and "<img" not in out and "<b>" not in out
    assert "&lt;script&gt;" in out and "&lt;img" in out


def test_only_http_and_mailto_links_are_links():
    out = pdfdoc.md_html("[a](https://lcsc.com/x) [b](javascript:alert(1)) [c](file:///etc/passwd) "
                         "[d](/api/files/abc123) [e](mailto:me@example.com) [f](data:text/html,hi)")
    assert '<a href="https://lcsc.com/x">a</a>' in out
    assert '<a href="mailto:me@example.com">e</a>' in out
    assert "javascript:" not in out.replace("[b](javascript:alert(1))", "")
    assert 'href="file:' not in out and 'href="/api' not in out and 'href="data:' not in out
    assert '<span class="link">d</span>' in out


def test_tables_put_numbers_right_and_keep_text_left():
    out = pdfdoc.md_html("| Part | Qty | Price | Vds |\n|---|---|---|---|\n| AO3400A | 2 | $0.03 | 30 V |\n"
                         "| SS34 | 10 | $0.05 | - |\n")
    assert '<th class="num">Qty</th>' in out and '<td class="num">$0.03</td>' in out
    assert '<td class="num">30 V</td>' in out and "<th>Part</th>" in out and "<td>AO3400A</td>" in out
    assert out.startswith('<div class="table"><table>')
    # A column the Markdown aligns keeps that.
    al = pdfdoc.md_html("| a | b |\n|:---:|---|\n| 1 | 2 |\n")
    assert 'style="text-align:center"' in al and '<td class="num">2</td>' in al


def test_task_lists_alerts_figures_and_page_breaks():
    out = pdfdoc.md_html("- [x] priced\n- [ ] swap U2\n\n> [!WARNING]\n> Gate at 3.3 V\n\n\\pagebreak\n\n"
                         "![The board](files:abc123 \"Top side\")", {"files:abc123": "data:image/png;base64,AA=="})
    assert '<li class="task done"><span class="box on"' in out and '<li class="task"><span class="box"' in out
    assert "[x]" not in out and "[ ]" not in out
    assert '<blockquote class="alert warning">\n<div class="alert-label">Warning</div><p>Gate at 3.3 V</p>' in out
    assert "[!WARNING]" not in out
    assert '<div class="pagebreak">' in out
    assert '<figure><img src="data:image/png;base64,AA==" alt="The board"><figcaption>Top side</figcaption></figure>' in out


def test_a_picture_that_was_not_had_is_a_note_not_a_fetch():
    out = pdfdoc.md_html("![schematic](http://10.0.0.5/x.png)")
    assert "<img" not in out and "schematic - picture not available" in out


def test_the_page_allows_nothing_from_outside_and_escapes_its_fields():
    doc = pdfdoc.Doc(title="A <b>title</b>", purpose="Why & how", author="<script>x</script>", project="p<1>")
    page = pdfdoc.page_html(doc, "<p>x</p>")
    assert "default-src 'none'; img-src data:; font-src data:" in page
    assert "A &lt;b&gt;title&lt;/b&gt;" in page and "&lt;script&gt;" in page and "<script>" not in page
    assert "font/woff2;base64," in page                       # the app's fonts, inside the page
    foot = pdfdoc.footer_html(doc)
    assert '<span class="pageNumber"></span>' in foot and '<span class="totalPages"></span>' in foot
    assert "&lt;script&gt;x&lt;/script&gt;" in foot and "Why &amp; how" in foot and "p&lt;1&gt;" in foot
    head = pdfdoc.header_html(doc)
    assert pdfdoc.MARK in head and ">Workbench</span>" in head


def test_the_document_header_fills_its_defaults_and_never_prints_an_address():
    when = datetime(2026, 10, 15, 11, 32, tzinfo=timezone.utc)          # 14:32 in Istanbul
    f = pdfdoc.fields(pdfdoc.Doc(title="Brief", purpose="Why it is", author="ann.k@example.com", created=when))
    assert f["number"] == "WB-20261015-1432" and f["revision"] == "0" and f["applicability"] == "—"
    assert f["prepared"] == "Workbench" and f["date"] == "2026-10-15" and f["subject"] == "Why it is"
    assert f["author"] == "ann.k"                                         # a name that is an address: its name part
    tr = pdfdoc.fields(pdfdoc.Doc(title="Rapor", lang="tr", created=when, author="Ayşe <ayse@example.com>",
                                  prepared="Donanım ekibi (hw@example.com)", number="FC-1", revision="B"))
    assert tr["date"] == "15.10.2026" and tr["subject"] == "Rapor" and tr["author"] == "Ayşe"
    assert tr["prepared"] == "Donanım ekibi" and (tr["number"], tr["revision"]) == ("FC-1", "B")


def test_page_one_has_the_big_header_and_the_others_the_compact_one():
    doc = pdfdoc.Doc(title="Clock <speed>", number="FC-STM001", revision="2", applicability="STM32F4DISCOVERY",
                     prepared="Firmware team", subject="Clock tree", author="Ann <ann@example.com>",
                     date="9.12.2021")
    big = pdfdoc.first_header_html(doc)
    for label, value in (("Number", "FC-STM001"), ("Date of Writing", "9.12.2021"), ("Revision", "2"),
                         ("Applicability", "STM32F4DISCOVERY"), ("Prepared", "Firmware team"),
                         ("Subject", "Clock tree"), ("Author", "Ann")):
        assert f'<span class="l">{label}</span>' in big and value in big
    assert '<span class="pageNumber"></span> of <span class="totalPages"></span>' in big
    assert "Clock &lt;speed&gt;" in big and pdfdoc.MARK in big and "@" not in big.split("</style>", 1)[1]
    small = pdfdoc.compact_header_html(doc)
    assert "Clock &lt;speed&gt;" in small and "<b>FC-STM001</b>" in small and "<b>2</b>" in small
    assert "Page <b><span class=\"pageNumber\"></span> of <span class=\"totalPages\"></span></b>" in small
    assert "Applicability" not in small
    # Chromium fills an element of class "title", "date" or "url" in a template with its own text.
    for t in (big, small, pdfdoc.doc_footer_html(doc)):
        assert not re.search(r'class="(title|date|url)"', t)
    foot = pdfdoc.doc_footer_html(doc)
    for label in ("Prepared", "Number", "Revision", "Printed", "Page"):
        assert f'<span class="l">{label}</span>' in foot
    assert "Firmware team" in foot and "FC-STM001" in foot and '<span class="totalPages"></span>' in foot
    # the frame's side rules continue from the header's table and into the footer's
    assert big.count('class="rail"') == small.count('class="rail"') == foot.count('class="rail"') == 1
    assert '<span class="l">Project</span>' in pdfdoc.doc_footer_html(pdfdoc.Doc(title="T", project="fan-ctrl"))
    tr = pdfdoc.first_header_html(pdfdoc.Doc(title="Rapor", lang="tr"))
    assert '<span class="l">Basım</span>' in pdfdoc.doc_footer_html(pdfdoc.Doc(title="Rapor", lang="tr"))
    for label in ("Numara", "Sayfa", "Yazım tarihi", "Revizyon", "Uygulama alanı", "Hazırlayan", "Konu"):
        assert f'<span class="l">{label}</span>' in tr
    assert '<span class="pageNumber"></span> / <span class="totalPages"></span>' in tr


def test_the_document_page_puts_the_extra_rows_on_one_line_and_floats_a_right_figure():
    page = pdfdoc.doc_page_html(pdfdoc.Doc(title="T", meta=[("Models", "m1"), ("Empty", "")]), "<p>x</p>")
    assert '<p class="doc-meta"><b>Models</b> m1</p>' in page and "Empty" not in page
    assert "@page :first { margin-top: __WB_TOP1__; }" in page and '<div class="frame"></div><main>' in page
    assert ".frame { position: fixed;" in page
    out = pdfdoc.md_html('![Clock path](files:abc123 "right")', {"files:abc123": "data:image/png;base64,AA=="})
    assert out.startswith('<figure class="right"><img') and "<figcaption>Clock path</figcaption>" in out


def test_sections_follow_the_body():
    doc = pdfdoc.Doc(title="t", body="Summary.", sections=[{"title": "Costs", "body": "| a |\n|---|\n| 1 |"},
                                                         {"title": "", "body": "Tail."}])
    assert pdfdoc.body_markdown(doc) == "Summary.\n\n## Costs\n\n| a |\n|---|\n| 1 |\n\nTail."


# ---------------------------------------------------------------- pictures

def test_pictures_from_files_are_read_through_the_workspace(monkeypatch):
    seen = []

    async def get(db, fid):
        seen.append((db, fid))
        if fid == "abc123":
            return {"_id": fid}, _png()
        raise KeyError(fid)
    monkeypatch.setattr(files, "get", get)
    db = object()
    got, missing = run(pdfdoc.resolve_images(["files:abc123", "/api/files/zzz999?inline=1", "notes.png"], db))
    assert got["files:abc123"].startswith("data:image/png;base64,")
    assert seen == [(db, "abc123"), (db, "zzz999")]
    assert any("no file zzz999" in m for m in missing) and any("notes.png" in m and "only Files" in m for m in missing)


@pytest.mark.parametrize("url", ["http://127.0.0.1/a.png", "http://localhost:8000/api/files/x", "http://10.1.2.3/x.png",
                                 "http://169.254.169.254/latest/meta-data", "http://[::1]/x.png", "ftp://example.com/x.png",
                                 "http://192.168.1.1/x.png", "file:///etc/passwd"])
def test_private_and_odd_addresses_are_never_fetched(monkeypatch, url):
    import httpx

    def no(*a, **k):
        raise AssertionError("fetched " + url)
    monkeypatch.setattr(httpx.AsyncClient, "stream", no)
    got, missing = run(pdfdoc.resolve_images([url]))
    assert got == {} and len(missing) == 1


def test_a_public_picture_is_fetched_checked_on_every_hop_and_re_encoded(monkeypatch):
    import httpx
    checked = []

    async def check(url):
        checked.append(url)
        if "internal" in url:
            raise manufacturers.Refused("internal is a private or local address")
        return url
    monkeypatch.setattr(manufacturers, "check", check)
    pic = _png(40, 10, "blue")

    def handler(req: httpx.Request):
        if req.url.path == "/hop":
            return httpx.Response(302, headers={"location": "https://cdn.example.com/p.png"})
        if req.url.path == "/bad":
            return httpx.Response(302, headers={"location": "http://internal/secret"})
        if req.url.path == "/script":
            return httpx.Response(200, content=b"<html><script>alert(1)</script></html>")
        return httpx.Response(200, content=pic)
    real = httpx.AsyncClient.__init__

    def init(self, *a, **k):
        k["transport"] = httpx.MockTransport(handler)
        real(self, *a, **k)
    monkeypatch.setattr(httpx.AsyncClient, "__init__", init)
    got, missing = run(pdfdoc.resolve_images(["https://lcsc.com/hop", "https://lcsc.com/bad", "https://lcsc.com/script"]))
    assert list(got) == ["https://lcsc.com/hop"] and got["https://lcsc.com/hop"].startswith("data:image/png;base64,")
    assert checked[:2] == ["https://lcsc.com/hop", "https://cdn.example.com/p.png"]
    assert "http://internal/secret" in checked
    assert any("private" in m for m in missing) and any("not a picture" in m for m in missing)


def test_clean_image_keeps_pixels_only():
    assert pdfdoc.clean_image(b"GIF89a-not-really") is None
    assert pdfdoc.clean_image(b"%PDF-1.7 ...") is None
    assert pdfdoc.clean_image(_png()).startswith("data:image/png;base64,")


# ---------------------------------------------------------------- printed for real

def _engine() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", pdfdoc.IMAGE], capture_output=True,
                              timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


SAMPLE = """**Summary.** Option B is 31 % cheaper per board.

## Cost per board

| Option | Lines | Cost / board |
|---|---:|---:|
| A - original | 14 | $4.82 |
| B - LCSC basic | 14 | $3.31 |

- [x] Price both options
- [ ] Swap the footprints

\\pagebreak

## Appendix

> [!NOTE]
> Prices as of 12 Oct 2026.
"""


@pytest.mark.skipif(not _engine(), reason="no docker or no Chromium image to print with")
def test_a_document_prints_with_its_header_footer_and_page_count():
    import pypdfium2 as pdfium
    doc = pdfdoc.Doc(title="Fan controller BOM comparison", purpose="Pick the cheaper build for 100 boards",
                     body=SAMPLE, author="Ann Example", project="fan-ctrl-b", theme="simple")
    made = run(pdfdoc.make(doc))
    assert made.pdf.startswith(b"%PDF") and made.pages == 2 and made.missing == []
    pdf = pdfium.PdfDocument(made.pdf)
    try:
        assert len(pdf) == 2
        w, h = pdf[0].get_size()
        assert abs(w - 595) < 2 and abs(h - 842) < 2                      # A4 in points
        texts = [pdf[i].get_textpage().get_text_range() for i in range(2)]
    finally:
        pdf.close()
    one, two = texts
    assert "Fan controller BOM comparison" in one and "Pick the cheaper build for 100 boards" in one
    for i, page in enumerate(texts, 1):
        assert "Workbench" in page and "Ann Example" in page and "fan-ctrl-b" in page
        assert f"Page {i} of 2" in page
    assert "$3.31" in one and "Appendix" in two and "Prices as of 12 Oct 2026." in two


def _frame_ok(pdf_bytes: bytes) -> list[bool]:
    """Per page: A4 to the point, and a rule 5 mm in from the left and right
    edges on every row from the header's top to the footer's bottom."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        out = []
        for i in range(len(pdf)):
            w, h = pdf[i].get_size()
            im = pdf[i].render(scale=2).to_pil().convert("L")       # 144 dpi: 5 mm = 28 px
            W, H = im.size
            band = lambda xs, y: any(im.getpixel((x, y)) < 140 for x in xs)
            rows = range(32, H - 32)
            out.append(abs(w - 595.28) < .05 and abs(h - 841.89) < .05
                       and all(band(range(24, 33), y) and band(range(W - 33, W - 24), y) for y in rows)
                       and band(range(24, 33), 20) is False)
        return out
    finally:
        pdf.close()


def _overlaps(pdf_bytes: bytes) -> list[int]:
    """Per page: how many pairs of text lines on different baselines are drawn
    over each other (a value over its label), and how many text boxes lie
    outside the frame (5 mm from the edges)."""
    import pypdfium2 as pdfium
    mm = 72 / 25.4
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        out = []
        for i in range(len(pdf)):
            page = pdf[i]
            w, h = page.get_size()
            tp = page.get_textpage()
            rects = [tp.get_rect(k) for k in range(tp.count_rects())]
            bad = sum(1 for l, b, r, t in rects if l < 5 * mm or r > w - 5 * mm or b < 5 * mm or t > h - 5 * mm)
            for a in range(len(rects)):
                l, b, r, t = rects[a]
                for L, B, R, T in rects[a + 1:]:
                    if min(r, R) - max(l, L) > 1 and min(t, T) - max(b, B) > 1 and abs(b - B) > 1.5:
                        bad += 1
            out.append(bad)
        return out
    finally:
        pdf.close()


LONG = "Arducam UB0228 Canon EOS → C-Mount lens adaptörü ve 1/2.3 inç sensör için uzatma halkası seti"


@pytest.mark.skipif(not _engine(), reason="no docker or no Chromium image to print with")
@pytest.mark.parametrize("lang", ["en", "tr"])
def test_long_values_wrap_in_their_cells_and_the_rows_grow(lang):
    fields = {"number": "FC-STM001-REV-B-DRAFT-2026-10-15-0001", "revision": "B3 draft for review",
              "date": "15 October 2026 (draft)", "applicability": LONG,
              "prepared": "Firmware team, embedded systems group, Istanbul office",
              "subject": "Clock configuration of the STM32F407 with HAL drivers, the PLL from the 8 MHz crystal",
              "author": "Emir Pehlevan and the whole firmware review board",
              "project": "iot-fan-controller-second-generation-prototype"}
    doc = pdfdoc.Doc(title="A very long title about the clock tree of the STM32F407 and the HAL drivers that set it up",
                     body=SAMPLE, lang=lang, **fields)
    made = run(pdfdoc.make(doc))
    assert made.pages == 2
    assert _overlaps(made.pdf) == [0, 0]
    assert _frame_ok(made.pdf) == [True, True]
    one, two = _texts(made.pdf)
    squash = lambda t: re.sub(r"[\s\-\ufffe\u00ad]", "", t)   # a line broken at a hyphen
    for k, v in fields.items():                       # every value whole: wrapped, never cut
        if k == "subject":                            # set in capitals, the document's (i -> İ in Turkish)
            v = (v.replace("i", "İ") if lang == "tr" else v).upper()
        assert squash(v) in squash(one), k
    for k in ("number", "revision", "project"):       # the footer's cells on every page
        assert squash(fields[k]) in squash(two), k
    assert "Cost per board" in one and "Appendix" in two


def _texts(pdf_bytes: bytes) -> list[str]:
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        return [" ".join(pdf[i].get_textpage().get_text_range().split()) for i in range(len(pdf))]
    finally:
        pdf.close()


@pytest.mark.skipif(not _engine(), reason="no docker or no Chromium image to print with")
def test_a_document_prints_its_big_header_on_page_one_and_the_compact_one_after():
    body = SAMPLE + "\n\n\\pagebreak\n\n## Third\n\nThe end.\n"
    doc = pdfdoc.Doc(title="STM32F4 clock speed with HAL", body=body, number="FC-STM001", revision="0",
                     applicability="STM32F4DISCOVERY", prepared="Firmware team", subject="Clock tree setup",
                     author="Ann Example <ann@example.com>", date="9.12.2021")
    made = run(pdfdoc.make(doc))
    assert made.pages == 3
    one, two, three = _texts(made.pdf)
    for words in ("STM32F4 CLOCK SPEED WITH HAL", "Number", "FC-STM001", "Page", "1 of 3", "Date of Writing",
                  "9.12.2021", "Revision", "Applicability", "STM32F4DISCOVERY", "Prepared", "Firmware team",
                  "Subject", "CLOCK TREE SETUP", "Author", "Ann Example", "$3.31"):
        assert words in one, words
    assert one.count("1 of 3") == 2 and "Printed" in one                # header and footer
    assert _frame_ok(made.pdf) == [True, True, True]
    for i, page in ((2, two), (3, three)):
        assert f"Page {i} of 3" in page and "No. FC-STM001" in page and "Rev. 0" in page
        assert f"{i} of 3" in page.replace(f"Page {i} of 3", "", 1) and "Printed" in page
        assert "STM32F4 CLOCK SPEED WITH HAL" in page
        assert "Date of Writing" not in page and "Applicability" not in page
    assert "Appendix" in two and "The end." in three
    assert all("@" not in t for t in (one, two, three))


@pytest.mark.skipif(not _engine(), reason="no docker or no Chromium image to print with")
def test_a_turkish_document_has_turkish_labels():
    made = run(pdfdoc.make(pdfdoc.Doc(title="Ölçüm raporu", body="Özet.\n\n\\pagebreak\n\nSon.", lang="tr",
                                      created=datetime(2026, 10, 15, 9, 0, tzinfo=timezone.utc))))
    one, two = _texts(made.pdf)
    for words in ("ÖLÇÜM RAPORU", "Numara", "WB-20261015-1200", "Sayfa", "1 / 2", "Yazım tarihi", "15.10.2026",
                  "Revizyon", "Uygulama alanı", "Hazırlayan", "Workbench", "Konu"):
        assert words in one, words
    assert "Sayfa 2 / 2" in two and "Yazım tarihi" not in two and "Basım" in two
    assert _frame_ok(made.pdf) == [True, True]


@pytest.mark.skipif(not _engine(), reason="no docker or no Chromium image to print with")
def test_letter_size():
    import pypdfium2 as pdfium
    made = run(pdfdoc.make(pdfdoc.Doc(title="Letter", body="One line.", size="Letter")))
    pdf = pdfium.PdfDocument(made.pdf)
    try:
        w, h = pdf[0].get_size()
    finally:
        pdf.close()
    assert abs(w - 612) < 2 and abs(h - 792) < 2 and made.pages == 1


def test_no_title_or_too_long_is_refused():
    with pytest.raises(pdfdoc.RenderError, match="title"):
        run(pdfdoc.make(pdfdoc.Doc(title=" ", body="x")))
    with pytest.raises(pdfdoc.RenderError, match="longer"):
        run(pdfdoc.make(pdfdoc.Doc(title="t", body="x" * (pdfdoc.MAX_MD + 1))))
