"""A part's datasheet, from LCSC, only when somebody asks (backend/lcsc.py).

LCSC's product detail is not a published API, so what has to hold is that
every way its answer can be wrong is said plainly, that only a PDF is ever
kept or served, and that a datasheet fetched once is read from disk after.
No test here reaches the network: the two asks are stood in for.
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
import urllib.error

import pytest
from fastapi import HTTPException

from backend import lcsc

PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n%%EOF"
LINK = "https://datasheet.lcsc.com/datasheet/pdf/abc.pdf?productCode=C111607"


def run(coro):
    return asyncio.run(coro)


def detail(**result):
    return {"code": 200, "msg": None, "result": {"productCode": "C111607", **result}}


@pytest.fixture
def lcsc_site(monkeypatch):
    """The two asks, stood in for, and counted."""
    asked = {"detail": 0, "pdf": 0}
    answer = {"detail": detail(pdfUrl=LINK, productModel="STM32F103C8T6"), "pdf": PDF}

    def ask_site(url):
        asked["detail"] += 1
        assert url == lcsc.DETAIL.format("C111607")
        return answer["detail"]

    def get_pdf(url):
        asked["pdf"] += 1
        got = answer["pdf"]
        if isinstance(got, Exception):
            raise got
        return got

    monkeypatch.setattr(lcsc, "_ask_site", ask_site)
    monkeypatch.setattr(lcsc, "_get_pdf", get_pdf)
    return asked, answer


# ---- reading LCSC's answer -------------------------------------------------

def test_the_link_and_the_mpn_are_read():
    assert lcsc.datasheet_link(detail(pdfUrl=LINK, productModel=" STM32F103C8T6 "), "C111607") \
        == (LINK, "STM32F103C8T6")


def test_a_protocol_relative_link_is_made_https():
    url, _ = lcsc.datasheet_link(detail(pdfUrl="//datasheet.lcsc.com/x.pdf"), "C1")
    assert url == "https://datasheet.lcsc.com/x.pdf"


@pytest.mark.parametrize("body", [
    detail(productModel="X"),                      # no pdfUrl at all
    detail(pdfUrl="", productModel="X"),           # an empty one
    detail(pdfUrl=None),
    {"code": 404, "msg": "product not found", "result": None},
    {"code": 200, "result": None},
])
def test_no_datasheet_is_a_lookup_error(body):
    with pytest.raises(lcsc.NoDatasheet):
        lcsc.datasheet_link(body, "C111607")


@pytest.mark.parametrize("body", [
    [], "html", None,                              # not an object
    {"result": {"pdfUrl": LINK}},                  # no code
    {"code": 200, "result": ["a"]},                # result not an object
    detail(pdfUrl=["a"]),                          # pdfUrl not a string
    detail(pdfUrl="https://evil.example/x.pdf"),   # not LCSC's host
    detail(pdfUrl="https://lcsc.com.evil.example/x.pdf"),
    detail(pdfUrl="file:///etc/passwd"),
])
def test_an_odd_shape_is_said_plainly(body):
    with pytest.raises(lcsc.OddAnswer):
        lcsc.datasheet_link(body, "C111607")


def test_a_pdf_is_told_by_its_magic():
    assert lcsc.is_pdf(PDF)
    assert lcsc.is_pdf(b"\n\n" + PDF)
    assert not lcsc.is_pdf(b"<html>no</html>")
    assert not lcsc.is_pdf(b"")
    assert lcsc.pdf_pages(PDF) == 2
    assert lcsc.pdf_pages(b"%PDF-1.7 compressed") is None


# ---- the fetch and the kept copy ---------------------------------------------

def test_fetched_once_then_read_from_disk(lcsc_site):
    asked, _ = lcsc_site
    got = run(lcsc.datasheet("C111607"))
    assert got["pdf"] == PDF and got["url"] == LINK and got["mpn"] == "STM32F103C8T6"
    assert not got["cached"]
    folder = lcsc.LOOK / "C111607"
    assert (folder / "datasheet.pdf").read_bytes() == PDF
    assert json.loads((folder / "datasheet.json").read_text())["url"] == LINK
    assert asked == {"detail": 1, "pdf": 1}

    again = run(lcsc.datasheet("C111607"))
    assert again["cached"] and again["pdf"] == PDF and again["url"] == LINK
    assert asked == {"detail": 1, "pdf": 1}, "a kept datasheet is not asked for again"
    kinds = [(r["kind"], r["source"]) for r in lcsc.journal()]
    assert ("datasheet", "disk") in kinds
    assert ("datasheet link", "net") in kinds and ("datasheet", "net") in kinds

    run(lcsc.datasheet("C111607", fresh=True))
    assert asked == {"detail": 2, "pdf": 2}


def test_a_broken_copy_on_disk_is_fetched_again(lcsc_site):
    asked, _ = lcsc_site
    folder = lcsc.LOOK / "C111607"
    folder.mkdir(parents=True)
    (folder / "datasheet.pdf").write_bytes(b"<html>")
    assert not run(lcsc.datasheet("C111607"))["cached"]
    assert asked["pdf"] == 1


def test_what_is_not_a_pdf_is_not_kept(lcsc_site):
    _, answer = lcsc_site
    answer["pdf"] = b"<!doctype html><title>blocked</title>"
    with pytest.raises(lcsc.OddAnswer, match="not a PDF"):
        run(lcsc.datasheet("C111607"))
    assert not (lcsc.LOOK / "C111607" / "datasheet.pdf").exists()


def test_a_pdf_too_big_is_refused(monkeypatch):
    monkeypatch.setattr(lcsc, "DATASHEET_MAX", 10)

    class R(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): pass
    monkeypatch.setattr(lcsc, "_open", lambda req, timeout: R(PDF))
    with pytest.raises(lcsc.OddAnswer, match="over"):
        lcsc._get_pdf(LINK)


def test_a_gone_file_is_no_datasheet(lcsc_site):
    _, answer = lcsc_site
    answer["pdf"] = urllib.error.HTTPError(LINK, 404, "gone", {}, io.BytesIO(b""))
    with pytest.raises(lcsc.NoDatasheet):
        run(lcsc.datasheet("C111607"))


def test_a_refusal_from_lcsc_does_not_cool_off_easyeda(lcsc_site):
    _, answer = lcsc_site
    answer["pdf"] = urllib.error.HTTPError(LINK, 403, "no", {}, io.BytesIO(b""))
    with pytest.raises(urllib.error.HTTPError):
        run(lcsc.datasheet("C111607"))
    assert lcsc.state()["refused_until"] is None


def test_not_a_part_number_asks_nothing(lcsc_site):
    asked, _ = lcsc_site
    with pytest.raises(ValueError):
        run(lcsc.datasheet("100nF"))
    assert asked == {"detail": 0, "pdf": 0}


# ---- the route ---------------------------------------------------------------

def test_the_route_serves_it_inline(lcsc_site):
    from backend import main
    r = run(main.part_datasheet("C111607"))
    assert r.media_type == "application/pdf" and r.body == PDF
    assert r.headers["content-disposition"] == 'inline; filename="C111607 STM32F103C8T6.pdf"'
    assert r.headers["x-datasheet-source"] == LINK


def test_the_route_says_404_when_lcsc_has_none(lcsc_site):
    from backend import main
    _, answer = lcsc_site
    answer["detail"] = detail(productModel="X")
    with pytest.raises(HTTPException) as e:
        run(main.part_datasheet("C111607"))
    assert e.value.status_code == 404 and "no datasheet" in e.value.detail


def test_the_route_says_502_when_the_shape_changed(lcsc_site):
    from backend import main
    _, answer = lcsc_site
    answer["detail"] = {"whatever": 1}
    with pytest.raises(HTTPException) as e:
        run(main.part_datasheet("C111607"))
    assert e.value.status_code == 502


def test_the_route_is_a_look():
    from backend import access
    assert access.action("GET", "/api/parts/C111607/datasheet", "") == "view"


def test_a_file_name_is_plain_ascii():
    from backend import main
    assert main._pdf_name("C1", 'a"b/ç d') == "C1 a_b_d.pdf"
    assert main._pdf_name("C1", None) == "C1.pdf"


# ---- the command line ----------------------------------------------------------

def test_the_command_writes_the_file(lcsc_site, monkeypatch, tmp_path, capsys):
    from tools import revisions
    out = tmp_path / "ds.pdf"
    monkeypatch.setenv("REDLINE_TRANSPORT", "")
    monkeypatch.setattr(sys, "argv", ["revisions.py", "part", "datasheet", "c111607", "-o", str(out)])
    revisions.main()
    assert out.read_bytes() == PDF
    said = capsys.readouterr().out
    assert str(out) in said and "2 pages" in said and LINK in said


def test_the_command_defaults_to_tmp():
    from tools import revisions
    assert str(revisions.datasheet_out("C111607", None)) == "/tmp/C111607-datasheet.pdf"


def test_the_command_says_when_there_is_none(lcsc_site, monkeypatch, tmp_path):
    from tools import revisions
    _, answer = lcsc_site
    answer["detail"] = detail(productModel="X")
    monkeypatch.setenv("REDLINE_TRANSPORT", "")
    monkeypatch.setattr(sys, "argv", ["revisions.py", "part", "datasheet", "C111607",
                                      "-o", str(tmp_path / "x.pdf")])
    with pytest.raises(SystemExit) as e:
        revisions.main()
    assert "no datasheet" in str(e.value.code)
    assert not (tmp_path / "x.pdf").exists()
