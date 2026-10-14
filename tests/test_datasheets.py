"""The datasheet library (backend/datasheets.py) and the Chat's datasheet
tools over it (backend/chat_tools: datasheet_search, datasheet_read,
datasheet_get).

What matters: a datasheet is read once and kept - its pages' text with
its tables as rows, the same PDF once however many parts share it, read
again when its source changes; a question about limits finds the Absolute
Maximum Ratings page first (not the contents, not the prose that only
talks about maximums); the tools answer with page numbers in bounded
text; each workspace has its own library; fetching needs the right that
asking the Chat needs. Nothing goes to the network: LCSC's copy is put on
disk by the test, a link's download is stood in for.
"""

from __future__ import annotations

import asyncio
import io
import json

import pytest

from backend import access, chat_tools, datasheets as ds, lcsc, pdftext, scope
from backend.chat_tools import Ctx, ToolError
from tests.test_telegram import FakeDb


def run(coro):
    return asyncio.run(coro)


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def table_pdf(pages: list[list], image_pages: tuple[int, ...] = ()) -> bytes:
    """A small PDF whose lines are rows of cells set at their own x - as a
    datasheet's tables are. A row is a string (one cell at the margin) or a
    list of (x, text). A page in `image_pages` is a picture and nothing else."""
    objs: list[bytes] = []
    n = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_no = 3 + 2 * n
    for i, rows in enumerate(pages):
        if i + 1 in image_pages:
            px = "ff00" * 32
            ops = [f"q 400 0 0 500 100 150 cm BI /W 8 /H 8 /CS /G /BPC 8 /F /AHx ID {px}> EI Q"]
        else:
            ops, y = [], 740
            for row in rows:
                cells = [(72, row)] if isinstance(row, str) else row
                for x, text in cells:
                    ops.append(f"BT /F1 10 Tf {x} {y} Td ({_esc(text)}) Tj ET")
                y -= 16
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


# A buck converter's datasheet in five pages: its features, its contents, its ratings, its
# characteristics, and an application note that talks a lot about maximum current - the decoy.
BUCK = table_pdf([
    ["TPX100 2-A Step-Down Converter", "1 Features",
     "Up to 2-A continuous output current", "Input voltage range 4.5 V to 28 V", "2 Applications",
     "Set-top boxes and LCD displays"],
    ["Table of Contents",
     "1 Features ........................................ 1", "2 Applications .................................... 1",
     "6.1 Absolute Maximum Ratings ........................ 3", "6.2 Recommended Operating Conditions ............... 3",
     "6.3 Electrical Characteristics ...................... 4", "8 Application Information ......................... 5"],
    ["6 Specifications", "6.1 Absolute Maximum Ratings",
     [(72, "PARAMETER"), (260, "MIN"), (320, "MAX"), (380, "UNIT")],
     [(72, "Input voltage VIN"), (260, "-0.3"), (320, "30"), (380, "V")],
     [(72, "Output current IOUT"), (320, "3.5"), (380, "A")],
     [(72, "Junction temperature TJ"), (260, "-40"), (320, "150"), (380, "C")],
     "6.2 Recommended Operating Conditions",
     [(72, "Input voltage VIN"), (260, "4.5"), (320, "28"), (380, "V")],
     [(72, "Output current IOUT"), (260, "0"), (320, "2"), (380, "A")]],
    ["6.3 Electrical Characteristics",
     [(72, "Current limit ILIM"), (260, "2.6"), (320, "3.2"), (380, "A")],
     [(72, "Quiescent current IQ"), (260, "3"), (320, "5"), (380, "mA")]],
    ["8 Application Information",
     "The maximum output current depends on the maximum ambient temperature, and the maximum",
     "current through the inductor must stay below the maximum current limit of the device. Choose",
     "the inductor for the maximum output current at the maximum input voltage."],
])


def keep(code="C9864", blob=BUCK, mpn="TPX100"):
    folder = lcsc.LOOK / code
    folder.mkdir(parents=True, exist_ok=True)
    (folder / lcsc.DATASHEET).write_bytes(blob)
    (folder / lcsc.DATASHEET_FROM).write_text(json.dumps({"url": f"https://datasheet.lcsc.com/{code}.pdf", "mpn": mpn}))
    (folder / "component.json").write_text(json.dumps({"result": {"dataStr": {"head": {"c_para": {
        "Manufacturer Part": mpn, "Manufacturer": "TX"}}}, "description": "buck converter"}}))


def space(ws="default"):
    return scope.ScopedDb(FakeDb(), ws)


@pytest.fixture(autouse=True)
def _fresh_cache():
    ds._CACHE.clear()


# ---- reading a PDF once --------------------------------------------------------

def test_a_table_comes_back_as_rows_of_cells():
    got = pdftext.layout(BUCK, "3")
    text = got["pages"][0]["text"]
    assert "Output current IOUT | 3.5 | A" in text
    assert "Input voltage VIN | -0.3 | 30 | V" in text
    assert got["count"] == 5 and got["pages"][0]["images"] == 0


def test_headings_make_the_contents_and_a_contents_page_is_not_a_section():
    chunks, toc = ds.structure(pdftext.layout(BUCK)["pages"])
    heads = {(h["t"], h["p"], h["k"]) for h in toc}
    assert ("6.1 Absolute Maximum Ratings", 3, "absmax") in heads
    assert ("6.2 Recommended Operating Conditions", 3, "recommended") in heads
    assert ("6.3 Electrical Characteristics", 4, "electrical") in heads
    assert ("1 Features", 1, "features") in heads
    assert [c["kind"] for c in chunks if c["page"] == 2] == ["toc"]
    assert not ds.heading("Input voltage VIN | -0.3 | 30 | V") and not ds.heading("1.22 V with 1.5% accuracy")


def test_a_page_that_is_a_picture_is_called_a_scan():
    scan = table_pdf([["Absolute Maximum Ratings"], []], image_pages=(2,))
    got = ds._extract(scan)
    assert [p["scanned"] for p in got["pages"]] == [False, True]


# ---- the electrical-limits helper ------------------------------------------------

def test_a_maximum_current_question_finds_the_absolute_maximum_ratings_page_first():
    keep()
    db = space()
    run(ds.ensure(db, ds.lcsc_ref("C9864")))
    for q in ("what is the maximum current of this IC?", "absolute maximum output current",
              "bu entegrenin maksimum akımı ne?"):
        got = run(ds.search(db, q, ["lcsc:C9864"]))
        assert got["hits"][0]["page"] == 3 and got["hits"][0]["kind"] == "absmax", (q, got["hits"][:3])
        assert "3.5" in got["hits"][0]["snippet"]
        kinds = [h["kind"] for h in got["hits"]]
        assert "toc" not in kinds[:3] and kinds.index("absmax") < kinds.index("other")
    pins = run(ds.search(db, "recommended operating input voltage", ["lcsc:C9864"]))
    assert pins["hits"][0]["kind"] == "recommended" and pins["hits"][0]["page"] == 3


def test_a_question_is_searched_in_english_and_in_chinese():
    terms = ds.query_terms("bu entegrenin maksimum akımı ne?")
    assert "maximum" in terms and "current" in terms and "bu" not in terms and "entegre" not in terms
    assert "最大" in terms and "电流" in terms
    assert ds.boosts(ds.query_terms("max current"))["absmax"] > ds.boosts(ds.query_terms("max current"))["electrical"]


# ---- the library: kept once, read again when it changes -------------------------

def test_a_datasheet_is_kept_once_and_two_parts_sharing_it_share_its_pages():
    keep("C1001")
    keep("C1002")
    db = space()
    e1, how1 = run(ds.ensure(db, ds.lcsc_ref("C1001")))
    assert how1 == "indexed" and e1["pages"] == 5 and e1["indexed"] == 5 and e1["source"]["kind"] == "lcsc"
    again, how = run(ds.ensure(db, ds.lcsc_ref("C1001")))
    assert how == "library" and again["_id"] == e1["_id"]
    e2, _ = run(ds.ensure(db, ds.lcsc_ref("C1002")))
    assert e2["sha"] == e1["sha"] and e2["_id"] != e1["_id"]
    assert run(db[ds.PAGES].count_documents({})) == 5                     # one PDF, its pages once
    assert run(db[ds.COLL].count_documents({})) == 2
    assert {h["lcsc"] for h in run(ds.search(db, "absolute maximum ratings"))["hits"]} == {"C1001", "C1002"}


def test_a_changed_source_is_read_again_and_its_old_pages_go():
    keep("C1001")
    db = space()
    e, _ = run(ds.ensure(db, ds.lcsc_ref("C1001")))
    new = table_pdf([["TPX100 rev B", "6.1 Absolute Maximum Ratings", [(72, "Output current IOUT"), (320, "4"), (380, "A")]]])
    keep("C1001", new)
    e2, how = run(ds.ensure(db, ds.lcsc_ref("C1001")))
    assert how == "refreshed" and e2["_id"] == e["_id"] and e2["pages"] == 1 and e2["sha"] != e["sha"]
    assert run(db[ds.PAGES].count_documents({})) == 1


def test_refresh_asks_the_source_again(monkeypatch):
    keep("C1001")
    asked = []

    async def datasheet(c, fresh=False):
        asked.append(fresh)
        return {"pdf": BUCK, "url": "u", "mpn": "TPX100", "cached": not fresh}
    monkeypatch.setattr(lcsc, "datasheet", datasheet)
    db = space()
    run(ds.ensure(db, ds.lcsc_ref("C1001")))
    _, how = run(ds.ensure(db, ds.lcsc_ref("C1001"), refresh=True))
    assert asked == [False, True] and how == "fetched"


def test_a_link_is_fetched_into_files_and_becomes_the_parts_datasheet(monkeypatch):
    from backend import files, product_files as pf
    keep("C1001")
    got = []

    async def fetch(url):
        got.append(url)
        return "tpx100-en.pdf", BUCK

    async def put(db, name, data, ctype, context, by, note="", folder=""):
        return {"_id": "f1", "name": name}

    async def make_path(db, path, by):
        return {"_id": "dir1", "path": path}

    async def get(db, fid):
        return {"_id": fid}, BUCK
    monkeypatch.setattr(pf, "fetch", fetch)
    monkeypatch.setattr(files, "put", put)
    monkeypatch.setattr(files, "make_path", make_path)
    monkeypatch.setattr(files, "get", get)
    db = space()
    e, how = run(ds.ensure(db, ds.lcsc_ref("C1001"), url="https://maker.example/tpx100.pdf"))
    assert how == "fetched" and e["source"] == {"kind": "url", "url": "https://maker.example/tpx100.pdf", "file": "f1"}
    # From then on it is that copy, not LCSC's.
    again, how = run(ds.ensure(db, ds.lcsc_ref("C1001")))
    assert how == "library" and again["source"]["kind"] == "url" and got == ["https://maker.example/tpx100.pdf"]
    assert run(ds.pdf_of(db, again)) == BUCK


def test_a_product_with_no_pdf_has_nothing_to_fetch(monkeypatch):
    with pytest.raises(ds.NoDatasheet, match="give its PDF link"):
        run(ds.ensure(space(), ds.Ref(key="prod:m1:p1", name="Fan 40mm", mid="m1", pid="p1")))


# ---- each workspace its own -------------------------------------------------------

def test_each_workspace_has_its_own_library():
    keep("C1001")
    raw = FakeDb()
    mine, theirs = scope.ScopedDb(raw, "default"), scope.ScopedDb(raw, "team2")
    run(ds.ensure(mine, ds.lcsc_ref("C1001")))
    assert run(ds.search(mine, "absolute maximum ratings"))["hits"]
    assert run(ds.search(theirs, "absolute maximum ratings")) == {"terms": ds.query_terms("absolute maximum ratings"),
                                                                   "sheets": 0, "hits": []}
    e, how = run(ds.ensure(theirs, ds.lcsc_ref("C1001")))
    assert how == "indexed"                                 # read for them too, into their own library
    assert run(theirs[ds.COLL].count_documents({})) == 1 and run(mine[ds.COLL].count_documents({})) == 1


# ---- the tools --------------------------------------------------------------------

def test_the_tools_are_described_with_the_citation_rule_and_bounded():
    t = chat_tools.tools()
    for name in ("datasheet_search", "datasheet_read", "datasheet_get"):
        assert name in t and "(datasheet p. N)" in t[name].description
        assert t[name].schema["type"] == "object"
    assert t["datasheet_search"].schema["required"] == ["query"] and t["datasheet_search"].level == "read"
    assert t["datasheet_get"].level == "change" and t["datasheet_get"].undo is False
    assert "datasheet_ask" not in t                                       # the model answers, no second model
    assert "no separate datasheet answering tool" in chat_tools.SYSTEM_NOTE


def test_search_answers_with_parts_pages_and_sections_in_little_text():
    keep()
    db = space()
    got = run(chat_tools.tools()["datasheet_search"].run(Ctx(db=db), {"query": "maximum output current", "part": "C9864"}))
    assert got.text.index("[1] TPX100 (C9864) p. 3, 6.1 Absolute Maximum Ratings") < got.text.index("[2]")
    assert "(datasheet p. N)" in got.text and len(got.text) < 6000
    assert got.vars["ref0"].endswith(":3:TPX100") and got.say.startswith("Searched the datasheet of {part}")
    # The whole library, by MPN.
    lib = run(chat_tools.tools()["datasheet_search"].run(Ctx(db=db), {"query": "quiescent current", "limit": 50}))
    assert "p. 4" in lib.text.split("\n\n", 1)[1].split("\n")[0]
    empty = run(chat_tools.tools()["datasheet_search"].run(Ctx(db=space()), {"query": "current"}))
    assert empty.say == "The datasheet library is empty"


def test_read_gives_a_section_or_pages_bounded():
    keep()
    db = space()
    tool = chat_tools.tools()["datasheet_read"]
    sec = run(tool.run(Ctx(db=db), {"part": "C9864", "section": "absolute maximum ratings"}))
    assert sec.vars["pages"] == "3" and "Output current IOUT | 3.5 | A" in sec.text
    assert "Quiescent" not in sec.text                                    # that section only
    by_mpn = run(tool.run(Ctx(db=db), {"part": "TPX100", "pages": "4"}))  # the library knows it by its MPN now
    assert by_mpn.say == "Read datasheet page {pages}" and "ILIM" in by_mpn.text
    many = run(tool.run(Ctx(db=db), {"part": "C9864", "pages": "1-5"}))
    assert many.vars["pages"] == "1–4"                                    # at most four pages a call
    with pytest.raises(ToolError, match="no page"):
        run(tool.run(Ctx(db=db), {"part": "C9864", "pages": "9"}))
    gone = run(tool.run(Ctx(db=db), {"part": "C9864", "section": "ordering information"}))
    assert gone.say == "No section “{section}” in the datasheet" and "Absolute Maximum Ratings" in gone.text


def test_get_lists_the_headings_and_says_where_it_came_from():
    keep()
    db = space()
    got = run(chat_tools.tools()["datasheet_get"].run(Ctx(db=db), {"part": "C9864"}))
    assert "p. 3  6.1 Absolute Maximum Ratings" in got.text and "from LCSC" in got.text
    assert got.vars["pages"] == 5 and got.vars["how"] == "indexed"


def test_fetching_needs_the_right_asking_the_chat_needs(monkeypatch):
    keep()
    assert access.action("POST", "/api/datasheets/product/lcsc/C9864") == "draw"
    assert access.action("GET", "/api/datasheets/x/pdf") == "view"
    monkeypatch.setattr(access, "current", lambda: "viewer")
    db = space()
    with pytest.raises(ToolError, match="draw notes"):
        run(chat_tools.tools()["datasheet_get"].run(Ctx(db=db), {"part": "C9864"}))
    # Searching is looking: a viewer may, and the part's datasheet is read into the library for it.
    got = run(chat_tools.tools()["datasheet_search"].run(Ctx(db=db), {"query": "absolute maximum", "part": "C9864"}))
    assert got.vars["n"] >= 1


def test_the_page_routes(monkeypatch):
    from backend import main
    keep()
    db = space()
    monkeypatch.setattr(main, "db", lambda: db)
    assert run(ds.api_product("lcsc", "C9864")) == {"entry": None, "source": "lcsc"}
    got = run(ds.api_fetch("lcsc", "C9864"))
    assert got["how"] == "indexed" and got["entry"]["pages"] == 5 and got["entry"]["label"] == "TPX100"
    assert run(ds.api_product("lcsc", "C9864"))["entry"]["id"] == got["entry"]["id"]
    pdf = run(ds.api_pdf(got["entry"]["id"]))
    assert pdf.body == BUCK and pdf.media_type == "application/pdf"
    assert run(ds.api_list())["items"][0]["key"] == "lcsc:C9864"
    hits = run(ds.api_search("absolute maximum current", "C9864"))["hits"]
    assert hits[0]["page"] == 3
