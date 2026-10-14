"""McMaster-Carr and GrabCAD as search-and-link sources (backend/linked.py,
mcmaster.py, grabcad.py): part numbers and model pages read out of web
search results - never the sites themselves -, the parts and models a
workspace saves with the CAD files dropped on them, the Chat's find and save
tools, the catalog's built-in sources, and the McMaster API's credentials
kept write-only behind an adapter that is not wired yet.

No real Jina, McMaster or GrabCAD is reached: the search goes to a fake
transport that fails the test if any other host is asked."""

from __future__ import annotations

import asyncio
import io
import zipfile

import httpx
import pytest

from backend import access, chat_tools, files, grabcad, jina, linked, mcmaster, scope
from backend.chat_tools import Ctx, ToolError
from test_files_folders import Grid
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401 - db is a fixture

KEY = "jina_" + "e" * 40 + "Abcd"            # a made-up key
STEP = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"


def run(c):
    return asyncio.run(c)


MCM_ROWS = [
    {"title": "Socket Head Screw | McMaster-Carr", "url": "https://www.mcmaster.com/91290A115/",
     "description": "18-8 Stainless Steel Socket Head Screw, M3 x 0.5 mm Thread, 10 mm Long. Packs of 100. $9.88 per pack"},
    {"title": "Metric Socket Head Screws | McMaster-Carr", "url": "https://www.mcmaster.com/screws/socket-head-screws/",
     "description": "Choose from 91290A113, 91290A115 and 92196A540. Black-Oxide Alloy Steel, M3 x 0.5 mm Thread, 8 mm Long"},
    {"title": "Ball Bearing", "url": "https://www.mcmaster.com/products/bearings/ball-bearing~/5972K91",
     "description": "Trade Number 608, for 8 mm Shaft Diameter, 22 mm OD"},
    {"title": "elsewhere", "url": "https://example.com/91290A999", "description": "not McMaster"},
    {"title": "M3x10 screw 608zz 10mm", "url": "https://www.mcmaster.com/m3/", "description": "m3x10 608ZZ"},
]
GC_ROWS = [
    {"title": "NEMA 17 Stepper Motor | 3D CAD Model Library | GrabCAD",
     "url": "https://grabcad.com/library/nema-17-stepper-motor-23",
     "description": "NEMA 17 stepper motor by John Smith. STEP / IGES, SOLIDWORKS. 1,204 Downloads 87 Likes"},
    {"title": "NEMA 17 | GrabCAD", "url": "https://grabcad.com/library/nema-17-stepper-motor-23/details?folder_id=1",
     "description": "the same model again"},
    {"title": "Software: STEP / IGES", "url": "https://grabcad.com/library/software/step-slash-iges", "description": "x"},
    {"title": "Questions", "url": "https://grabcad.com/questions/how-to-x", "description": "not a model"},
]


@pytest.fixture
def fake_search(monkeypatch):
    """Jina Search, faked: each search answers the rows in state['rows']; any
    other host fails the test (nothing may read mcmaster.com or grabcad.com)."""
    state = {"calls": [], "rows": MCM_ROWS}

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.host == "s.jina.ai", f"asked {req.url.host}"
        state["calls"].append(req)
        return httpx.Response(200, json={"code": 200, "data": state["rows"], "meta": {"usage": {"tokens": 10000}}})

    monkeypatch.setattr(jina, "_client", lambda timeout=jina.TIMEOUT: httpx.AsyncClient(
        transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(jina, "_conf", {"key": KEY})
    monkeypatch.setattr(jina, "_db_getter", None)
    return state


@pytest.fixture
def grid(monkeypatch):
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    return g


# ---------------------------------------------------------------- reading results

def test_mcmaster_part_numbers_out_of_search_results():
    got = mcmaster.parse(MCM_ROWS)
    assert [h["key"] for h in got] == ["91290A115", "91290A113", "92196A540", "5972K91"]
    first = got[0]
    assert first["title"] == "Socket Head Screw" and first["url"] == "https://www.mcmaster.com/91290A115/"
    assert first["specs"] == {"Thread": "M3 x 0.5 mm", "Length": "10 mm", "Pack": "100",
                              "Price": "$9.88 per pack", "Material": "18-8 Stainless Steel"}
    # a part a category page names: its snippet's sentence, the page as where it came from
    assert got[1]["title"].startswith("Choose from 91290A113") and got[1]["source"].endswith("socket-head-screws/")
    bearing = got[3]
    assert bearing["specs"]["Trade no."] == "608" and bearing["specs"]["Shaft"] == "8 mm" and bearing["specs"]["OD"] == "22 mm"
    # pasted numbers and links
    assert mcmaster.part_of("91290a115") == "91290A115"
    assert mcmaster.part_of("https://www.mcmaster.com/91290A115/") == "91290A115"
    assert mcmaster.part_of("https://www.mcmaster.com/products/screws/~/5972K91?x=1") == "5972K91"
    for bad in ("", "M3x10", "608ZZ", "10mm", "https://example.com/x"):
        assert mcmaster.part_of(bad) is None, bad


def test_grabcad_models_out_of_search_results():
    got = grabcad.parse(GC_ROWS)
    assert [h["key"] for h in got] == ["nema-17-stepper-motor-23"]
    h = got[0]
    assert h["title"] == "NEMA 17 Stepper Motor" and h["author"] == "John Smith"
    assert h["url"] == "https://grabcad.com/library/nema-17-stepper-motor-23"
    assert h["specs"] == {"Formats": "STEP / IGES, SOLIDWORKS", "Downloads": "1,204", "Likes": "87"}
    assert grabcad.slug_of("https://grabcad.com/library/608-bearing-12/details") == "608-bearing-12"
    assert grabcad.slug_of("608-bearing-12") == "608-bearing-12"
    assert grabcad.slug_of("https://grabcad.com/library/software") is None and grabcad.slug_of("608 bearing") is None


def test_a_second_search_only_when_the_first_finds_too_little(fake_search):
    got = run(linked.find(mcmaster.KIND, "  M3x10   socket head  ", who="chat"))
    assert got["ok"] and len(fake_search["calls"]) == 1
    req = fake_search["calls"][0]
    assert req.url.params["site"] == "mcmaster.com" and req.url.params["q"] == "M3x10 socket head"
    fake_search["rows"] = MCM_ROWS[2:3]
    got = run(linked.find(mcmaster.KIND, "608 bearing"))
    assert [r["key"] for r in got["results"]] == ["5972K91"] and len(fake_search["calls"]) == 3
    assert fake_search["calls"][-1].url.params["q"] == "608 bearing McMaster-Carr part number"
    jina._conf.clear()
    assert "not set up" in run(linked.find(mcmaster.KIND, "x"))["error"]


# ---------------------------------------------------------------- the Chat's tools

def test_the_find_tools(fake_search):
    t = chat_tools.tools()["mcmaster_find"]
    assert (t.package, t.level, t.default) == ("commandcode", "read", True)
    got = run(t.run(Ctx(db=None), {"query": "socket head cap screw", "material": "stainless", "thread": "M3"}))
    assert fake_search["calls"][0].url.params["q"] == "socket head cap screw stainless M3"
    assert "1. 91290A115 - Socket Head Screw" in got.text and "https://www.mcmaster.com/91290A115/" in got.text
    assert "CAD → 3-D STEP → Download" in got.text and got.vars["n"] == 4
    fake_search["rows"] = []
    got = run(t.run(Ctx(db=None), {"query": "unobtainium widget"}))
    assert got.vars["n"] == 0 and "Try other words" in got.text
    g = chat_tools.tools()["grabcad_find"]
    assert (g.package, g.level, g.default) == ("commandcode", "read", True)
    fake_search["rows"] = GC_ROWS
    got = run(g.run(Ctx(db=None), {"query": "NEMA 17"}))
    assert "nema-17-stepper-motor-23 - NEMA 17 Stepper Motor (by John Smith)" in got.text
    assert "needs a free GrabCAD login" in got.text and "licence" in got.text
    with pytest.raises(ToolError):
        run(t.run(Ctx(db=None), {"query": " "}))


def test_the_save_tools_keep_parts_to_the_workspace(grid):
    fake = FakeDb()
    a = scope.ScopedDb(fake, "wa")
    s = chat_tools.tools()["mcmaster_save"]
    assert (s.package, s.level) == ("mfr", "change")
    got = run(s.run(Ctx(db=a, actor={"id": "me", "name": "Me"}), {"items": [
        {"key": "91290A115", "title": "Socket Head Screw", "tags": ["fasteners"], "quantity": 20},
        {"key": "https://www.mcmaster.com/5972K91/"}, {"key": "nope"}]}))
    assert got.vars["keys"] == "91290A115, 5972K91" and "Not saved: 'nope'" in got.text
    # again: kept, its empty fields filled, tags added to
    run(s.run(Ctx(db=a), {"items": [{"key": "91290a115", "notes": "lid", "tags": ["lamp"], "quantity": 5}]}))
    (doc,) = [d for d in run(linked.listing(a, mcmaster.KIND)) if d["key"] == "91290A115"]
    assert doc["notes"] == "lid" and doc["tags"] == ["fasteners", "lamp"] and doc["quantity"] == 20
    assert doc["by"]["id"] == "me"
    gs = chat_tools.tools()["grabcad_save"]
    run(gs.run(Ctx(db=a), {"items": [{"key": "https://grabcad.com/library/nema-17-stepper-motor-23",
                                      "author": "John Smith", "licence": "CC BY"}]}))
    (m,) = run(linked.listing(a, grabcad.KIND))
    assert (m["key"], m["author"], m["licence"]) == ("nema-17-stepper-motor-23", "John Smith", "CC BY")
    # another workspace sees none of it
    assert run(linked.listing(scope.ScopedDb(fake, "wb"), mcmaster.KIND)) == []


def test_the_tools_strings_are_translated():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    for n in ("mcmaster_find", "grabcad_find", "mcmaster_save", "grabcad_save"):
        t = chat_tools.tools()[n]
        for s in (t.label, t.about, t.running, t.failed):
            assert "'" + s.replace("'", "\\'") + "':" in tr, s
    for s in ("Looked on McMaster-Carr for “{query}” · {n} parts", "Looked on McMaster-Carr for “{query}” · nothing found",
              "Looked on GrabCAD for “{query}” · {n} models", "Looked on GrabCAD for “{query}” · nothing found",
              "Saved {keys} to McMaster-Carr", "Saved {keys} to GrabCAD"):
        assert f"'{s}':" in tr, s


# ---------------------------------------------------------------- the routes

def test_saved_parts_from_start_to_finish(db, grid, fake_search):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    r = a.post("/api/linked/mcmaster/parts", json={"key": "https://www.mcmaster.com/91290A115/", "title": "Screw",
                                                    "tags": "fasteners, lamp", "quantity": "12"}).json()
    assert r["new"] and r["part"]["key"] == "91290A115" and r["part"]["tags"] == ["fasteners", "lamp"]
    assert r["part"]["url"] == "https://www.mcmaster.com/91290A115/" and r["part"]["cad"] is None
    assert a.post("/api/linked/mcmaster/parts", json={"key": "91290a115"}).json()["new"] is False
    assert a.post("/api/linked/mcmaster/parts", json={"key": "M3 screw"}).status_code == 400
    assert a.post("/api/linked/nowhere/parts", json={"key": "x"}).status_code == 404
    p = a.patch("/api/linked/mcmaster/parts/91290A115", json={"notes": "for the lid", "quantity": None}).json()
    assert p["notes"] == "for the lid" and p["quantity"] is None
    # the STEP dropped on it: kept in Files, named for an import, and the part's cad
    bad = a.post("/api/linked/mcmaster/parts/91290A115/files", files={"upload": ("x.step", b"not a step")})
    assert bad.status_code == 400 and "ISO-10303-21" in bad.text
    assert a.post("/api/linked/mcmaster/parts/91290A115/files", files={"upload": ("x.stl", b"solid")}).status_code == 400
    s = a.post("/api/linked/mcmaster/parts/91290A115/files",
               files={"upload": ("91290A115_Socket Head Screw.STEP", STEP)}).json()
    assert s["cad"]["name"] == "mcmaster_91290A115.step" and s["cad"]["kind"] == "step" and s["cad"]["has_thumb"] is None
    kept = a.get("/api/files").json()
    folders = {f["id"]: f["path"] for f in a.get("/api/files/folders").json()}
    assert [(f["name"], folders[f["folder"]]) for f in kept] == [("mcmaster_91290A115.step", "McMaster-Carr")]
    # the catalog lists it as McMaster-Carr's product, for every workspace even when empty
    every = a.get("/api/manufacturers").json()
    assert [x["id"] for x in every if x.get("builtin")] == ["lcsc", "mcmaster", "grabcad", "own"]
    m = a.get("/api/manufacturers/mcmaster").json()
    assert m["view"] == "linked" and m["products"][0]["id"] == "91290A115" and m["products"][0]["specs"]["CAD"]
    assert [(x["id"], x["product_count"]) for x in b.get("/api/manufacturers").json() if x.get("builtin")] == \
        [("lcsc", 0), ("mcmaster", 0), ("grabcad", 0), ("own", 0)]
    # another workspace cannot reach it
    assert b.get("/api/linked/mcmaster/parts").json() == []
    assert b.patch("/api/linked/mcmaster/parts/91290A115", json={"notes": "x"}).status_code == 404
    assert b.delete("/api/linked/mcmaster/parts/91290A115").status_code == 404
    # the search marks what is saved
    got = a.get("/api/linked/mcmaster/search?q=socket head").json()
    assert {r["key"]: r["saved"] for r in got["results"]}["91290A115"] is True and got["how"] == mcmaster.HOW
    assert a.delete("/api/linked/mcmaster/parts/91290A115").json() == {"deleted": "91290A115"}
    assert a.get("/api/linked/mcmaster/parts").json() == []
    assert len(a.get("/api/files").json()) == 1                # its STEP stays in Files
    assert "linked_parts" in scope.SCOPED


def test_a_grabcad_zip_is_unpacked_to_its_cad_files(db, grid):  # noqa: F811
    a = person(db, "a")
    a.post("/api/linked/grabcad/parts", json={"key": "nema-17-stepper-motor-23", "licence": "unknown"})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("NEMA17/readme.txt", "hi")
        z.writestr("NEMA17/motor.STEP", STEP)
        z.writestr("NEMA17/motor.stl", b"solid m\nendsolid m\n")
        z.writestr("__MACOSX/._motor.STEP", b"junk")
    r = a.post("/api/linked/grabcad/parts/nema-17-stepper-motor-23/files", files={"upload": ("m.zip", buf.getvalue())})
    got = r.json()
    assert sorted(f["name"] for f in got["files"]) == ["grabcad_nema-17-stepper-motor-23_motor.STEP",
                                                       "grabcad_nema-17-stepper-motor-23_motor.stl"]
    assert got["cad"]["kind"] == "step" and got["licence"] == "unknown"
    empty = io.BytesIO()
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("readme.txt", "hi")
    r = a.post("/api/linked/grabcad/parts/nema-17-stepper-motor-23/files", files={"upload": ("e.zip", empty.getvalue())})
    assert r.status_code == 400 and "no STEP" in r.text


def test_who_may(monkeypatch):
    for m, p, want in (("GET", "/api/linked/mcmaster/parts", "view"), ("GET", "/api/linked/grabcad/search", "draw"),
                       ("POST", "/api/linked/mcmaster/parts", "draw"), ("POST", "/api/linked/mcmaster/parts/X/files", "draw"),
                       ("PATCH", "/api/linked/mcmaster/parts/X", "draw"), ("DELETE", "/api/linked/grabcad/parts/x", "draw"),
                       ("POST", "/api/linked/mcmaster/parts/X/to-model", "edit"),
                       ("PUT", "/api/mcmaster/settings", "settings"), ("POST", "/api/mcmaster/settings/cert", "settings"),
                       ("DELETE", "/api/mcmaster/settings/cert", "settings"), ("POST", "/api/mcmaster/test", "settings"),
                       ("GET", "/api/mcmaster/settings", "view")):
        assert access.action(m, p) == want, (m, p)


# ---------------------------------------------------------------- the McMaster API, later

def test_the_api_credentials_are_kept_write_only_and_nothing_is_called(db, grid, monkeypatch):  # noqa: F811
    o, a = person(db, "o"), person(db, "a")
    assert a.put("/api/mcmaster/settings", json={"username": "u"}).status_code == 403
    s = o.get("/api/mcmaster/settings").json()
    assert s["filled"] is False and s["connected"] is False and s["wired"] is False
    assert o.post("/api/mcmaster/test").status_code == 400
    secret = "pa" + "ss-" + "1234"
    s = o.put("/api/mcmaster/settings", json={"username": "me@example.com", "password": secret,
                                              "cert_password": secret, "auto_step": True}).json()
    assert s["password_set"] and s["cert_password_set"] and secret not in str(s)
    s = o.post("/api/mcmaster/settings/cert", files={"upload": ("me.pfx", b"\x30\x82fake")}).json()
    assert s["cert"]["name"] == "me.pfx" and s["filled"] is True and "data" not in s["cert"]
    t = o.post("/api/mcmaster/test").json()
    assert t["implemented"] is False and t["message"].startswith("not implemented yet")
    # never in the audit trail
    assert secret not in str(list(db["audit"].docs.values()) if hasattr(db["audit"], "docs") else db["audit"].rows)
    # "Download STEP" through the API says what to do instead; so does a part saved with auto_step on
    r = o.get("/api/mcmaster/parts/91290A115/cad")
    assert r.status_code == 501 and "https://www.mcmaster.com/91290A115/" in r.text
    p = o.post("/api/linked/mcmaster/parts", json={"key": "91290A115"}).json()["part"]
    assert "not wired" in p["fetch"]["error"] and p["cad"] is None
    o.put("/api/mcmaster/settings", json={"password": ""})
    assert o.get("/api/mcmaster/parts/91290A115/cad").status_code == 409
    assert o.delete("/api/mcmaster/settings/cert").json()["cert"] is None


def test_the_cad_agents_list_them_and_make_a_model_of_one(monkeypatch, capsys):
    import argparse

    from tools import revisions
    asked = []
    parts = {"mcmaster": [{"key": "91290A115", "title": "Socket Head Screw", "url": mcmaster.url_of("91290A115"),
                           "quantity": 4, "files": [{}], "cad": {"name": "mcmaster_91290A115.step", "kind": "step",
                                                                 "bytes": 20480, "file": "f1"}},
                          {"key": "5972K91", "title": "Ball Bearing", "url": mcmaster.url_of("5972K91"), "cad": None}],
             "grabcad": []}

    def api_call(path, method="GET", body=None, timeout=60):
        asked.append((method, path, body))
        if method == "GET":
            return parts[path.split("/")[3]]
        return {"model": "lamp/purchased/mcmaster_91290a115", "title": body.get("title") or "x",
                "upload": "mcmaster_91290A115.step", "build_job": "j1"}
    monkeypatch.setattr(revisions, "api_call", api_call)
    ns = dict(what="list", target=None, source=None, all=False, folder=None, title=None)
    revisions.cmd_linked(argparse.Namespace(**ns))
    out = capsys.readouterr().out
    assert "mcmaster:91290A115" in out and "CAD: mcmaster_91290A115.step (step, 20 kB, file f1)" in out
    assert "5972K91" not in out
    revisions.cmd_linked(argparse.Namespace(**{**ns, "all": True}))
    assert "no CAD file yet" in capsys.readouterr().out
    revisions.cmd_linked(argparse.Namespace(**{**ns, "what": "to-model", "target": "mcmaster:91290A115",
                                               "folder": "lamp/purchased"}))
    assert asked[-1] == ("POST", "/api/linked/mcmaster/parts/91290A115/to-model", {"folder": "lamp/purchased"})
    assert "model lamp/purchased/mcmaster_91290a115" in capsys.readouterr().out


def test_a_part_without_a_cad_file_says_where_to_get_it(db, grid):  # noqa: F811
    a = person(db, "a")
    a.post("/api/linked/mcmaster/parts", json={"key": "5972K91"})
    r = a.post("/api/linked/mcmaster/parts/5972K91/to-model", json={"folder": "lamp/purchased"})
    assert r.status_code == 409 and "https://www.mcmaster.com/5972K91/" in r.text and "CAD → 3-D STEP → Download" in r.text


def test_mcmaster_category_pages_come_up_after_parts():
    """A web search finds McMaster's category pages far more often than one
    part's page: they come back as categories (not saved as parts), with the
    filters their address already holds, after any part numbers."""
    from backend import mcmaster
    rows = [{"url": "https://www.mcmaster.com/products/screws/thread-size~m3/", "title": "M3 Screws | McMaster-Carr", "description": "..."},
            {"url": "https://www.mcmaster.com/products/phillips-pan-head-machine-screws/", "title": "Phillips Pan Head Machine Screws", "description": ""},
            {"url": "https://www.mcmaster.com/91290A115/", "title": "Socket Head Screw M3 x 0.5 mm Thread, 10 mm Long", "description": ""},
            {"url": "https://www.mcmaster.com/products/screws/thread-size~m3/", "title": "dup", "description": ""}]
    got = mcmaster.parse(rows)
    assert got[0]["key"] == "91290A115" and "kind" not in got[0]
    cats = [r for r in got if r.get("kind") == "category"]
    assert [c["key"] for c in cats] == ["cat:screws+thread-size~m3", "cat:phillips-pan-head-machine-screws"]
    assert cats[0]["specs"] == {"Thread size": "M3"} and cats[0]["url"] == "https://www.mcmaster.com/products/screws/thread-size~m3/"


def test_mcmaster_categories_open_on_the_size_asked_for():
    """The words searched become the filters McMaster writes in its addresses,
    so a category opens on that size; categories carrying more of the words
    come first."""
    from backend import mcmaster
    assert [f[0] for f in mcmaster.filters_of("m3 10mm phillips head")] == \
        ["system-of-measurement~metric", "length~10-mm", "thread-size~m3"]
    assert [f[0] for f in mcmaster.filters_of("M2.5 x 6 mm")] == \
        ["system-of-measurement~metric", "length~6-mm", "thread-size~m2-5"]
    items = [{"key": "cat:mil-spec-machine-screws", "kind": "category", "title": "Mil. Spec. Machine Screws", "url": "", "specs": {}},
             {"key": "cat:screws+thread-size~m3", "kind": "category", "title": "M3 Screws", "url": "", "specs": {"Thread size": "M3"}},
             {"key": "cat:phillips-pan-head-machine-screws", "kind": "category", "title": "Phillips Pan Head Machine Screws", "url": "", "specs": {}}]
    got = mcmaster.refine(items, "m3 10mm philiphs pan head")
    assert got[0]["title"] == "Phillips Pan Head Machine Screws"
    assert got[0]["url"] == ("https://www.mcmaster.com/products/phillips-pan-head-machine-screws/"
                             "system-of-measurement~metric/length~10-mm/thread-size~m3/")
    m3 = next(c for c in got if c["title"] == "M3 Screws")
    assert m3["url"].count("thread-size~m3") == 1 and m3["filtered"]


def test_mcmaster_reads_turkish_and_guesses_no_length_without_a_thread():
    """McMaster's catalog is English: common Turkish hardware names are put in
    its words; a millimetre figure is a length only beside a metric thread
    (a rail's width, a bearing's bore otherwise); categories of another
    thread size are left out."""
    from backend import mcmaster
    assert mcmaster.english("lineer ray 15mm") == "linear rail 15mm"
    assert mcmaster.english("bilyalı mil 12mm") == "ball screw 12mm"
    assert mcmaster.english("608 rulman") == "608 ball bearing"
    assert mcmaster.english("M3x10 socket head") == "M3x10 socket head"
    assert mcmaster.filters_of("linear rail 15 mm") == []
    items = [{"key": "cat:standoffs+thread-size~m10", "kind": "category", "title": "M10 Standoffs", "url": "", "specs": {}},
             {"key": "cat:standoffs+thread-size~m3", "kind": "category", "title": "M3 Standoffs", "url": "", "specs": {}},
             {"key": "cat:standoffs+thread-size~m3-5", "kind": "category", "title": "M3.5 Standoffs", "url": "", "specs": {}}]
    assert [c["title"] for c in mcmaster.refine(items, "M3 standoff 10 mm")] == ["M3 Standoffs"]


def test_a_part_saved_by_its_number_takes_its_name_from_the_file():
    """A STEP dropped on the page saves the part by the number in its name;
    the rest of the name, else the STEP's own product name, is its title."""
    from backend import linked
    assert linked.title_from_file("92000A130", [("92000A130_Passivated 18-8 Stainless Steel Pan Head Phillips Screws.STEP", b"")]) \
        == "Passivated 18-8 Stainless Steel Pan Head Phillips Screws"
    step = b"ISO-10303-21;\nDATA;\n#5=PRODUCT('92000A130','Pan Head Phillips Screw M3','',(#2));\nENDSEC;"
    assert linked.title_from_file("92000A130", [("92000A130.STEP", step)]) == "Pan Head Phillips Screw M3"
    assert linked.title_from_file("92000A130", [("drawing.STEP", b"ISO-10303-21;")]) == ""
    # Downloaded twice, the browser numbers the file: not the part's name.
    assert linked.title_from_file("92000A130", [("92000A130_Pan Head Phillips Screws (1).STEP", b"")]) == "Pan Head Phillips Screws"
    assert linked.title_from_file("92000A130", [("92000A130_Pan Head Phillips Screws - Copy.STEP", b"")]) == "Pan Head Phillips Screws"


def test_a_saved_mcmaster_category_becomes_the_part_its_step_is_of(db, grid):  # noqa: F811
    """A category card saved from a search, its filters in its key, takes the
    part number of the STEP dropped on it: key, link and title become the
    part's, its sizes stay; a part saved already takes the files instead."""
    a = person(db, "a")
    key = "cat:phillips-pan-head-machine-screws+system-of-measurement~metric+length~25-mm+thread-size~m3"
    r = a.post("/api/linked/mcmaster/parts", json={"key": key, "title": "Phillips Pan Head Machine Screws",
                                                  "specs": {"Thread size": "M3", "Length": "25 mm"}})
    it = r.json()["part"]
    assert it["url"].endswith("/products/phillips-pan-head-machine-screws/system-of-measurement~metric/length~25-mm/thread-size~m3/")
    r = a.post(f"/api/linked/mcmaster/parts/{it['id']}/files",
               files={"upload": ("92000A130_Passivated 18-8 Stainless Steel Pan Head Phillips Screws.STEP", STEP)})
    got = r.json()
    assert got["key"] == "92000A130" and got["url"] == "https://www.mcmaster.com/92000A130/"
    assert got["title"] == "Passivated 18-8 Stainless Steel Pan Head Phillips Screws"
    assert got["specs"]["Thread size"] == "M3" and got["specs"]["Length"] == "25 mm"
    assert got["cad"]["kind"] == "step"
    # Another category whose STEP is of the same part: the part takes it, the category goes.
    it2 = a.post("/api/linked/mcmaster/parts", json={"key": "cat:screws+thread-size~m3", "title": "M3 Screws"}).json()["part"]
    got2 = a.post(f"/api/linked/mcmaster/parts/{it2['id']}/files", files={"upload": ("92000A130.STEP", STEP)}).json()
    assert got2["key"] == "92000A130" and len(got2["files"]) == 2
    keys = [p["key"] for p in a.get("/api/linked/mcmaster/parts").json()]
    assert keys == ["92000A130"]
