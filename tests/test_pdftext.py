"""Reading a PDF for an agent (backend/pdftext.py): its text page by page,
a page as a PNG, the routes over Files uploads and a part's kept datasheet,
and `revisions.py pdf text|page`.

The PDF is written here by hand - two pages of Helvetica - so nothing is
read from the network or the real LCSC cache (conftest moves it).
"""

from __future__ import annotations

import io
import sys

import pytest

from backend import lcsc, pdftext


def make_pdf(pages: list[list[str]]) -> bytes:
    """A small, valid PDF: each page a list of lines of text, one under the
    other, plus a filled box so a render has something dark on it."""
    objs: list[bytes] = []
    n = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_no = 3 + 2 * n
    for i, lines in enumerate(pages):
        ops = ["0 0 0 rg 72 600 200 40 re f", "BT /F1 18 Tf 72 720 Td 22 TL"]
        for ln in lines:
            ops.append(f"({ln}) Tj T*")
        ops.append("ET")
        stream = "\n".join(ops).encode()
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 {font_no} 0 R >> >> /Contents {4 + 2 * i} 0 R >>".encode())
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for k, body in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % k + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


PDF = make_pdf([["OLED 0.91 inch", "Glass height 1.45 mm"], ["Page two", "Mechanical drawing"]])


# ---- the library ----------------------------------------------------------------

def test_text_comes_page_by_page_with_its_line_breaks():
    got = pdftext.text(PDF)
    assert got["count"] == 2 and [p["n"] for p in got["pages"]] == [1, 2]
    one = got["pages"][0]["text"]
    assert "OLED 0.91 inch" in one and "Glass height 1.45 mm" in one
    assert one.index("OLED") < one.index("Glass") and "\n" in one and "\r" not in one
    assert "Mechanical drawing" in got["pages"][1]["text"]
    assert [p["n"] for p in pdftext.text(PDF, "2")["pages"]] == [2]
    assert pdftext.page_count(PDF) == 2


def test_a_page_is_rendered_as_a_png_at_the_dpi_asked():
    from PIL import Image
    png, meta = pdftext.render_png(PDF, 1, 72)
    assert png.startswith(b"\x89PNG")
    with Image.open(io.BytesIO(png)) as im:
        assert im.size == (612, 792) == (meta["width"], meta["height"])
        # the filled box is dark, the margin is white
        assert im.convert("L").getpixel((100, 792 - 620)) < 50
        assert im.convert("L").getpixel((10, 10)) > 200
    _, meta = pdftext.render_png(PDF, 2, 144)
    assert (meta["width"], meta["height"]) == (1224, 1584) and meta["count"] == 2


def test_dpi_and_size_are_capped(monkeypatch):
    _, meta = pdftext.render_png(PDF, 1, 10_000)
    assert meta["dpi"] == pytest.approx(300) and max(meta["width"], meta["height"]) <= pdftext.MAX_PX
    assert pdftext.render_png(PDF, 1, 1)[1]["dpi"] == pdftext.MIN_DPI
    monkeypatch.setattr(pdftext, "MAX_PX", 500)
    _, meta = pdftext.render_png(PDF, 1, 300)
    assert max(meta["width"], meta["height"]) <= 500 and meta["dpi"] < 50


def test_a_page_that_is_not_there():
    with pytest.raises(pdftext.PdfError, match="no page 3 - the PDF has 2 pages"):
        pdftext.render_png(PDF, 3)
    with pytest.raises(pdftext.PdfError, match="no page"):
        pdftext.render_png(PDF, 0)
    with pytest.raises(pdftext.PdfError, match="no page"):
        pdftext.text(PDF, "5-9")


@pytest.mark.parametrize("spec, count, want", [
    (None, 3, [1, 2, 3]), ("", 3, [1, 2, 3]), ("all", 2, [1, 2]),
    ("1-3", 9, [1, 2, 3]), ("2", 9, [2]), ("1,4,7-9", 9, [1, 4, 7, 8, 9]),
    ("5-", 7, [5, 6, 7]), ("-2", 9, [1, 2]), ("3, 1 ,3", 9, [1, 3]),
    ("8-20", 9, [8, 9]),                        # past the end is dropped
    ("1-1000000", 120, list(range(1, 51))),     # cut to MAX_PAGES
])
def test_page_ranges(spec, count, want):
    assert pdftext.parse_pages(spec, count) == want


@pytest.mark.parametrize("spec", ["abc", "3-1", "0", "0-2", "1;2", "1-2-3"])
def test_what_is_not_a_page_range(spec):
    with pytest.raises(pdftext.PdfError):
        pdftext.parse_pages(spec, 9)


def test_not_a_pdf_and_a_broken_one_are_said_plainly():
    with pytest.raises(pdftext.PdfError, match="not a PDF"):
        pdftext.text(b"PK\x03\x04 a zip")
    with pytest.raises(pdftext.PdfError, match="damaged"):
        pdftext.text(b"%PDF-1.4\nnothing else")


def test_a_password_is_said_plainly(monkeypatch):
    import pypdfium2 as pdfium

    def locked(*a, **k):
        raise pdfium.PdfiumError("Failed to load document (PDFium: Incorrect password error).", err_code=4)
    monkeypatch.setattr(pdfium, "PdfDocument", locked)
    with pytest.raises(pdftext.PdfError, match="password"):
        pdftext.text(PDF)


def test_too_large_is_not_opened(monkeypatch):
    monkeypatch.setattr(pdftext, "MAX_BYTES", 100)
    with pytest.raises(pdftext.PdfError, match="not opened"):
        pdftext.page_count(PDF)


def test_unmapped_glyphs_and_soft_hyphens_are_cleaned():
    raw = "\x01\x04\x05\r\n\r\n\r\n\r\nwww.irf.com 1   \r\nLead-\x02\r\nFree￾"
    assert pdftext._clean(raw) == "www.irf.com 1\nLead--\nFree"


# ---- the routes ---------------------------------------------------------------------

@pytest.fixture
def web(monkeypatch):
    from fastapi.testclient import TestClient

    from backend import auth, files
    from backend import main as M
    from test_files_folders import Grid
    from test_links import FakeDb

    grid, db = Grid(), FakeDb()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return TestClient(M.app)


def test_a_files_pdf_is_read_through_the_api(web):
    from test_files_folders import up
    f = up(web, "oled.pdf", PDF, ctype="application/pdf")
    r = web.get(f"/api/files/{f['id']}/pdf", params={"pages": "1"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["count"] == 2 and got["name"] == "oled.pdf" and [p["n"] for p in got["pages"]] == [1]
    assert "Glass height 1.45 mm" in got["pages"][0]["text"]
    r = web.get(f"/api/files/{f['id']}/pdf/page/2.png", params={"dpi": 72})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.content.startswith(b"\x89PNG") and r.headers["x-pdf-pages"] == "2"
    assert r.headers["x-pdf-size"] == "612x792" and "oled-p2.png" in r.headers["content-disposition"]
    assert web.get(f"/api/files/{f['id']}/pdf/page/7.png").status_code == 404
    assert web.get(f"/api/files/{f['id']}/pdf", params={"pages": "x"}).status_code == 422


def test_a_file_that_is_not_a_pdf_is_refused(web):
    from test_files_folders import up
    f = up(web, "notes.txt", b"hello")
    assert web.get(f"/api/files/{f['id']}/pdf").status_code == 415
    assert web.get(f"/api/files/{f['id']}/pdf/page/1.png").status_code == 415
    assert web.get("/api/files/nope/pdf").status_code == 404


def test_a_parts_kept_datasheet_is_read_without_asking_lcsc(web, monkeypatch):
    (lcsc.LOOK / "C111607").mkdir()
    (lcsc.LOOK / "C111607" / "datasheet.pdf").write_bytes(PDF)
    monkeypatch.setattr(lcsc, "_ask_site", lambda url: pytest.fail("LCSC was asked"))
    r = web.get("/api/parts/C111607/datasheet/text", params={"pages": "2"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["part"] == "C111607" and got["cached"] is True and got["count"] == 2
    assert "Mechanical drawing" in got["pages"][0]["text"]
    r = web.get("/api/parts/C111607/datasheet/page/1.png", params={"dpi": 100})
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG") and r.headers["x-pdf-dpi"] == "100.0"


def test_a_datasheet_never_fetched_is_fetched_first(web, monkeypatch):
    asked = []
    monkeypatch.setattr(lcsc, "_ask_site", lambda url: asked.append(url) or {
        "code": 200, "result": {"pdfUrl": "https://datasheet.lcsc.com/x.pdf", "productModel": "SSD1306"}})
    monkeypatch.setattr(lcsc, "_get_pdf", lambda url: asked.append(url) or PDF)
    r = web.get("/api/parts/C2040/datasheet/text")
    assert r.status_code == 200 and r.json()["mpn"] == "SSD1306" and r.json()["cached"] is False
    assert len(asked) == 2 and (lcsc.LOOK / "C2040" / "datasheet.pdf").read_bytes() == PDF
    assert web.get("/api/parts/C2040/datasheet/text").json()["cached"] is True and len(asked) == 2


def test_the_routes_are_looks():
    from backend import access
    for path in ("/api/files/abc/pdf", "/api/files/abc/pdf/page/2.png",
                 "/api/parts/C111607/datasheet/text", "/api/parts/C111607/datasheet/page/3.png"):
        assert access.action("GET", path, "") == "view", path


# ---- the command line -----------------------------------------------------------------

def run_cli(monkeypatch, *argv):
    from tools import revisions
    monkeypatch.setattr(sys, "argv", ["revisions.py", *argv])
    revisions.main()


def test_pdf_text_of_a_local_file(monkeypatch, tmp_path, capsys):
    p = tmp_path / "oled.pdf"
    p.write_bytes(PDF)
    run_cli(monkeypatch, "pdf", "text", str(p), "--pages", "1-2")
    out = capsys.readouterr().out
    assert "2 pages (showing 1-2)" in out
    assert "===== page 1 / 2 =====" in out and "===== page 2 / 2 =====" in out
    assert out.index("Glass height 1.45 mm") < out.index("===== page 2 / 2")
    assert "little or no text" in out                    # these pages are short


def test_pdf_page_of_a_local_file(monkeypatch, tmp_path, capsys):
    p = tmp_path / "oled.pdf"
    p.write_bytes(PDF)
    out = tmp_path / "o.png"
    run_cli(monkeypatch, "pdf", "page", str(p), "2", "--dpi", "72", "-o", str(out))
    said = capsys.readouterr().out
    assert out.read_bytes().startswith(b"\x89PNG")
    assert said.splitlines()[0] == str(out) and "page 2 of 2, 612x792 px at 72.0 dpi" in said


def test_pdf_page_default_path():
    from tools import revisions
    assert str(revisions.pdf_page_out("C111607", "part", 8, None)) == "/tmp/C111607-p8.png"
    assert str(revisions.pdf_page_out("/x/y/My sheet.pdf", "local", 1, None)) == "/tmp/My_sheet-p1.png"


def test_ids_go_through_the_api(monkeypatch, tmp_path, capsys):
    from tools import revisions
    calls = []

    def api_call(path, method="GET", body=None, timeout=60):
        calls.append(path)
        return {"count": 9, "name": "ssd1306.pdf",
                "pages": [{"n": 2, "text": "Glass height 1.45 mm\n" + "x" * 100}]}

    def api_bytes(path, timeout=300):
        calls.append(path)
        return b"\x89PNG fake", {"x-pdf-pages": "9", "x-pdf-dpi": "200.0", "x-pdf-size": "1700x2200"}

    monkeypatch.setattr(revisions, "api_call", api_call)
    monkeypatch.setattr(revisions, "api_bytes", api_bytes)
    monkeypatch.chdir(tmp_path)
    run_cli(monkeypatch, "pdf", "text", "f0a1b2c3", "--pages", "2")
    run_cli(monkeypatch, "pdf", "text", "c111607")
    run_cli(monkeypatch, "pdf", "page", "C111607", "8", "--dpi", "200", "-o", str(tmp_path / "p.png"))
    run_cli(monkeypatch, "pdf", "page", "f0a1b2c3", "1", "-o", str(tmp_path / "q.png"))
    assert calls == ["/api/files/f0a1b2c3/pdf?pages=2",
                     "/api/parts/C111607/datasheet/text",
                     "/api/parts/C111607/datasheet/page/8.png?dpi=200",
                     "/api/files/f0a1b2c3/pdf/page/1.png?dpi=150"]
    out = capsys.readouterr().out
    assert "# ssd1306.pdf - 9 pages (showing 2)" in out and "===== page 2 / 9 =====" in out
    assert "little or no text" not in out.split("# ssd1306.pdf")[1].split("#")[0]
    assert "page 8 of 9, 1700x2200 px at 200.0 dpi" in out
    assert (tmp_path / "p.png").read_bytes() == b"\x89PNG fake"


def test_a_missing_local_pdf_is_said(monkeypatch, tmp_path):
    with pytest.raises(SystemExit) as e:
        run_cli(monkeypatch, "pdf", "text", str(tmp_path / "nope.pdf"))
    assert "no such file" in str(e.value.code)


def test_a_local_file_that_is_not_a_pdf(monkeypatch, tmp_path):
    p = tmp_path / "a.pdf"
    p.write_bytes(b"hello")
    with pytest.raises(SystemExit) as e:
        run_cli(monkeypatch, "pdf", "page", str(p), "1")
    assert "not a PDF" in str(e.value.code)
