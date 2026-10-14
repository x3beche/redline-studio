"""Files on any Parts product (backend/product_files.py): a site's product,
a My Items one, a saved McMaster-Carr item - a STEP as its 3D model,
measured as a saved McMaster part's is (backend/linked_measure.py), a PDF
as its datasheet or drawing, a picture; kept once in Files and referred
to; a ZIP unpacked; a file from an address fetched under the crawler's
rules and never from McMaster-Carr or GrabCAD; the rights; a site read
again never dropping a product that holds files or stock; export and
import carrying the references; a mesh's box; the Turkish words a spec
says a length in.

No real site is reached (the fake transport of test_manufacturers); the
STEPs are tests/fixtures/step's screws, measured by OpenCascade when it is
installed."""

from __future__ import annotations

import asyncio
import io
import struct
import zipfile
from pathlib import Path

import httpx
import pytest

from backend import access, actors, files, linked_measure, scope
from backend import manufacturers as mf
from backend import product_files as pf
from test_files_folders import Grid
from test_linked import STEP
from test_manufacturers import PUBLIC, web  # noqa: F401 - web is a fixture
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401 - db is a fixture

FIX = Path(__file__).resolve().parent / "fixtures" / "step"
PAN = (FIX / "pan_m3x25.step").read_bytes()
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def run(c):
    return asyncio.run(c)


def stl(size=(10.0, 20.0, 5.0)) -> bytes:
    """A binary STL of one box corner to corner: two triangles are enough for a box."""
    x, y, z = size
    tris = [((0, 0, 0), (x, 0, 0), (0, y, z)), ((x, y, z), (0, y, 0), (x, 0, z))]
    out = b"\0" * 80 + struct.pack("<I", len(tris))
    for t in tris:
        out += struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *v) for v in t) + b"\0\0"
    return out


@pytest.fixture
def grid(monkeypatch):
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    return g


@pytest.fixture
def site(monkeypatch):
    monkeypatch.setitem(PUBLIC, "www.robo90.com", ["93.184.216.40"])
    monkeypatch.setattr(mf, "_resolve", lambda host: _addr(host))


async def _addr(host):
    if host not in PUBLIC:
        raise OSError("no such host")
    return PUBLIC[host]


def maker(c, name="Robo90", products=({"name": "Vida M3x30 Yıldız", "specs": {"Uzunluk": "30 mm"}},)) -> tuple[str, list]:
    """A site's maker, not explored, with products added by hand - through the page's own routes."""
    m = c.post("/api/manufacturers", json={"url": "https://www.robo90.com/", "name": name, "explore": False}).json()
    mid = m["manufacturer"]["id"]
    ids = [c.post(f"/api/manufacturers/{mid}/products", json=p).json()["product"]["id"] for p in products]
    return mid, ids


def wait(c, url, tries=200):
    for _ in range(tries):
        got = c.get(url).json()
        if not (got.get("measured") or {}).get("pending"):
            return got
    return got


# ---------------------------------------------------------------- what a file is to a product

def test_the_role_comes_from_the_kind_and_the_name():
    assert pf.role_of("UB0228.STEP", "step") == "model" and pf.role_of("x.stp") == "model"
    assert pf.role_of("bracket.3mf", "mesh") == "model" and pf.role_of("b.STL") == "model"
    assert pf.role_of("ds.pdf", "pdf") == "datasheet" and pf.role_of("teknik_cizim.pdf", "pdf") == "drawing"
    assert pf.role_of("Olculer.PDF") == "drawing" and pf.role_of("plate.dxf") == "drawing"
    assert pf.role_of("photo.JPG", "image") == "image"
    assert pf.role_of("notes.txt", "text") is None and pf.role_of("a.zip", "archive") is None


def test_a_mesh_has_a_box_and_its_unit_said():
    from backend.imports import meshmeasure as mm
    got = mm.measure("b.stl", stl((10, 20, 5)))
    assert got["size"] == [10.0, 20.0, 5.0] and got["unit"] == "assumed mm"
    ascii_stl = b"solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1.5 0 0\nvertex 0 2 3\nendloop\nendfacet\nendsolid"
    assert mm.measure("a.stl", ascii_stl)["size"] == [1.5, 2.0, 3.0]
    assert mm.measure("o.obj", b"v 0 0 0\nv 4 5 6\nf 1 2 2\n")["size"] == [4.0, 5.0, 6.0]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("3D/3dmodel.model", '<model unit="inch"><mesh><vertices><vertex x="0" y="0" z="0"/>'
                                       '<vertex x="1" y="2" z="0.5"/></vertices></mesh></model>')
    assert mm.measure("p.3mf", buf.getvalue()) == {"size": [25.4, 50.8, 12.7], "unit": "mm", "vertices": 2}
    with pytest.raises(ValueError):
        mm.measure("m.glb", b"glTF")
    with pytest.raises(ValueError):
        mm.measure("e.stl", b"nothing")


def test_turkish_specs_and_a_name_say_what_the_model_is_held_against():
    item = {"cad": {"kind": "step", "sha256": "s"}, "title": "Vida M3 yıldız", "tags": [],
            "specs": {"Uzunluk": "30 mm", "Diş": "M4"},
            "measured": {"v": linked_measure.VERSION, "sha256": "s", "size": [6, 6, 27.4],
                         "screw": {"length": 25, "head": 2.4, "head_d": 6, "shank": 3, "countersunk": False}}}
    v = linked_measure.view(item)
    assert {b["what"]: b["said"] for b in v["mismatch"]} == {"Length": "30 mm", "Thread": "M4"}
    assert linked_measure.title_specs("Vida M3x10 Yıldız") == {"Thread size": "M3", "Length": "10 mm"}
    box = {"cad": {"kind": "step", "sha256": "s"}, "title": "Kutu", "specs": {"Boyut": "20 x 30 x 10 mm"},
           "measured": {"v": linked_measure.VERSION, "sha256": "s", "size": [30, 10, 20], "solids": 3}}
    v = linked_measure.view(box)
    assert v["mismatch"] == [] and ["Solids", "3 (an assembly: the size is all of them)"] in v["rows"]
    box["measured"]["size"] = [30, 10, 25]
    assert linked_measure.view(box)["mismatch"][0]["what"] == "Size"


# ---------------------------------------------------------------- on a site's product, through the page's routes

def test_a_step_on_a_site_product_is_kept_once_measured_and_listed(db, grid, site):  # noqa: F811
    pytest.importorskip("OCP")
    a = person(db, "a")
    mid, (pid,) = maker(a)
    url = f"/api/manufacturers/{mid}/products/{pid}/files"
    assert a.get(url).json()["files"] == []
    r = a.post(url, files={"upload": ("UB0228.STEP", PAN)}).json()
    (rep,) = r["report"]
    assert rep["status"] == "attached" and rep["role"] == "model" and rep["main"] is True
    assert r["cad"]["name"] == "UB0228.STEP" and r["measured"]["pending"] is True
    got = wait(a, url)
    m = got["measured"]
    assert m["rows"][0] == ["Size", "6 × 6 × 27.4 mm"] and m["rows"][1] == ["Length", "25 mm under the head"]
    # the site's words (Turkish "Uzunluk") say 30 mm: a mismatch
    assert m["mismatch"] == [{"what": "Length", "said": "30 mm", "measured": "25 mm"}]
    # kept in Files once, in Parts/<maker>; the same bytes again are not kept twice
    folders = {f["id"]: f["path"] for f in a.get("/api/files/folders").json()}
    assert [(f["name"], folders[f["folder"]]) for f in a.get("/api/files").json()] == [("UB0228.STEP", "Parts/Robo90")]
    again = a.post(url, files={"upload": ("copy.step", PAN)}).json()
    assert again["report"][0]["status"] == "already" and len(again["files"]) == 1
    assert len(a.get("/api/files").json()) == 1
    # the badge's summary
    s = a.get("/api/product-files/summary").json()
    assert s["products"][f"{mid}:{pid}"]["cad"] == "step" and s["products"][f"{mid}:{pid}"]["box"] == [6, 6, 27.4]
    # a file already in Files attached by its id: a PDF is its datasheet, one named a drawing its drawing
    ds = a.post("/api/files", files={"upload": ("UB0228 datasheet.pdf", PDF)}).json()
    dr = a.post("/api/files", files={"upload": ("UB0228 teknik çizim.pdf", PDF + b" ")}).json()
    fid = (ds[0] if isinstance(ds, list) else ds)["id"]
    did = (dr[0] if isinstance(dr, list) else dr)["id"]
    r = a.post(url + "/attach", json={"files": [fid, did]}).json()
    assert [(x["role"], x["status"]) for x in r["report"]] == [("datasheet", "attached"), ("drawing", "attached")]
    assert r["cad"]["name"] == "UB0228.STEP"                       # a PDF never becomes the model
    # what a product does not keep, and what is not a STEP
    bad = a.post(url, files={"upload": ("notes.txt", b"hello")})
    assert bad.status_code == 400 and "a product keeps only those" in bad.text
    bad = a.post(url, files={"upload": ("fake.step", b"not a step")})
    assert bad.status_code == 400 and "ISO-10303-21" in bad.text
    assert a.post(url, files={"upload": ("empty.pdf", b"")}).status_code == 400


def test_a_new_step_replaces_the_model_and_a_mesh_does_not(db, grid, site):  # noqa: F811
    a = person(db, "a")
    mid, (pid,) = maker(a, products=({"name": "Bracket"},))
    url = f"/api/manufacturers/{mid}/products/{pid}/files"
    a.post(url, files={"upload": ("old.step", STEP)})
    r = a.post(url, files={"upload": ("bracket.stl", stl())}).json()
    assert r["cad"]["name"] == "old.step" and r["report"][0]["main"] is False
    r = a.post(url, files={"upload": ("new.step", STEP + b"\n")}).json()
    assert r["cad"]["name"] == "new.step" and r["report"][0]["replaced"] == "old.step"
    assert {f["name"] for f in r["files"]} == {"old.step", "bracket.stl", "new.step"}   # the old one stays attached
    # a STEP with no geometry: attached, its measurement says why
    got = wait(a, url)
    assert got["measured"]["error"] == "the STEP has no geometry in it"
    # the mesh made the model by hand: measured as a box, its unit said
    stl_id = next(f["file"] for f in r["files"] if f["name"] == "bracket.stl")
    r = a.patch(f"{url}/{stl_id}", json={"main": True}).json()
    assert r["cad"]["kind"] == "mesh"
    got = wait(a, url)
    assert got["measured"]["rows"] == [["Size", "10 × 20 × 5 mm (assumed)"]] and got["measured"]["kind"] == "mesh"
    # detaching the model: the next STEP attached is the model again
    d = a.delete(f"{url}/{stl_id}").json()
    assert d["removed"] == "bracket.stl" and d["product"]["cad"]["name"] == "new.step" and d["deleted"] is False
    assert any(f["name"] == "bracket.stl" for f in a.get("/api/files").json())       # stays in Files


def test_a_zip_gives_its_steps_and_pdfs_the_first_step_the_model(db, grid, site):  # noqa: F811
    a = person(db, "a")
    mid, (pid,) = maker(a, products=({"name": "Motor"},))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("m/readme.txt", "hi")
        z.writestr("m/datasheet.pdf", PDF)
        z.writestr("m/a.STEP", STEP)
        z.writestr("m/b.stp", STEP + b" ")
        z.writestr("__MACOSX/._a.STEP", b"junk")
    r = a.post(f"/api/manufacturers/{mid}/products/{pid}/files", files={"upload": ("motor.zip", buf.getvalue())}).json()
    assert sorted(f["name"] for f in r["files"]) == ["a.STEP", "b.stp", "datasheet.pdf"]
    assert r["cad"]["name"] == "a.STEP"
    assert not any(f["name"] == "motor.zip" for f in a.get("/api/files").json())


def test_my_items_and_a_saved_mcmaster_part_take_files_too(db, grid):  # noqa: F811
    a = person(db, "a")
    own = a.post("/api/manufacturers/own/products", json={"name": "Lamp bracket"}).json()["product"]["id"]
    r = a.post(f"/api/manufacturers/own/products/{own}/files", files={"upload": ("lamp.3mf", _3mf())}).json()
    assert r["cad"]["kind"] == "mesh" and r["maker"] == "own"
    # a McMaster part: its files are its own (linked.py) - a PDF joins them, the STEP stays its model
    a.post("/api/linked/mcmaster/parts", json={"key": "91290A115", "title": "Socket Head Screw"})
    a.post("/api/linked/mcmaster/parts/91290A115/files", files={"upload": ("91290A115.STEP", STEP)})
    r = a.post("/api/manufacturers/mcmaster/products/91290A115/files", files={"upload": ("91290A115.pdf", PDF)}).json()
    assert r["linked"] is True and r["cad"]["name"] == "mcmaster_91290A115.step"
    assert [f["role"] for f in r["files"]] == ["datasheet", "model"]
    item = a.get("/api/linked/mcmaster/parts/91290A115").json()
    assert {f["name"] for f in item["files"]} == {"mcmaster_91290A115.step", "91290A115.pdf"}
    assert item["cad"]["name"] == "mcmaster_91290A115.step"
    # a McMaster item has no picture of its own to set: its CAD file's picture is shown
    pdf_id = next(f["file"] for f in r["files"] if f["role"] == "datasheet")
    assert a.patch(f"/api/manufacturers/mcmaster/products/91290A115/files/{pdf_id}", json={}).status_code == 400


def _3mf() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("3D/3dmodel.model", '<model unit="millimeter"><vertex x="0" y="0" z="0"/><vertex x="2" y="3" z="4"/></model>')
    return buf.getvalue()


def test_another_workspace_sees_none_of_it_and_who_may(db, grid, site):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    mid, (pid,) = maker(a, products=({"name": "Hinge"},))
    url = f"/api/manufacturers/{mid}/products/{pid}/files"
    a.post(url, files={"upload": ("h.pdf", PDF)})
    assert b.get(url).status_code == 404
    assert b.post(url, files={"upload": ("x.pdf", PDF)}).status_code == 404
    mine = b.post("/api/files", files={"upload": ("b.pdf", PDF + b"b")}).json()
    bid = (mine[0] if isinstance(mine, list) else mine)["id"]
    # a's product cannot take b's file: there is no such file in a's Files
    r = a.post(url + "/attach", json={"files": [bid]}).json()
    assert r["report"][0]["status"] == "refused" and "no file" in r["report"][0]["why"]
    assert b.get("/api/product-files/summary").json() == {"products": {}, "orphans": []}
    for m, p, want in (("GET", url, "view"), ("POST", url, "draw"), ("POST", url + "/attach", "draw"),
                       ("PATCH", url + "/f1", "draw"), ("DELETE", url + "/f1", "draw"),
                       ("POST", f"/api/manufacturers/{mid}/products/{pid}/to-model", "edit"),
                       ("GET", "/api/product-files/summary", "view")):
        assert access.action(m, p) == want, (m, p)
    assert not access.page_allowed("POST", url) and access.page_allowed("GET", url)
    assert "product_files" in scope.SCOPED


def test_detaching_someone_elses_file_needs_the_right_to_delete(grid, monkeypatch):
    fake = FakeDb()
    d = scope.ScopedDb(fake, "default")
    state = {"role": "editor", "who": {"id": "u1", "name": "One"}}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    own = run(_own(d, "Bench cable"))
    other = run(_own(d, "Spare cable"))
    _, reps = run(pf.put(d, "own", own, "cable.pdf", PDF, measure=False))
    fid = reps[0]["file"]
    run(pf.attach(d, "own", other, [fid], measure=False))          # the same file on two products, kept once
    assert len(fake["files"].docs) == 1
    state["who"] = {"id": "u2", "name": "Two"}
    state["role"] = next(r for r in access.ROLES if access.allowed(r, "draw") and not access.allowed(r, "delete"))
    with pytest.raises(PermissionError):
        run(pf.detach(d, "own", own, fid))
    state["role"] = "owner"
    got = run(pf.detach(d, "own", own, fid, delete_file=True))
    # another product still refers to it: it stays in Files
    assert got["deleted"] is False and f"own:{other}" in got["kept_because"]
    got = run(pf.detach(d, "own", other, fid, delete_file=True))
    assert got["deleted"] is True and not fake["files"].docs


async def _own(d, name):
    from backend import catalog_own
    return (await catalog_own.add(d, {"name": name}, {"id": "u1", "name": "One"}))["id"]


# ---------------------------------------------------------------- the catalog read again, deleted, exported

def test_a_site_read_again_keeps_a_product_with_files_or_stock():
    have = [{"id": "p1", "name": "Gone with files", "specs": {}}, {"id": "p2", "name": "Gone", "specs": {}},
            {"id": "p3", "name": "Stays", "specs": {}}]
    found = [{"name": "Stays", "specs": {}}, {"name": "New", "specs": {}}]
    out, added = mf.fold_in(have, found, "2026-10-14T00:00:00", replace=True, keep={"p1"})
    assert [p["name"] for p in out] == ["Gone with files", "Stays", "New"] and added == 1
    assert next(p for p in out if p["name"] == "Stays")["id"] == "p3"


def test_kept_ids_are_those_with_files_or_stock(grid, monkeypatch):
    fake = FakeDb()
    d = scope.ScopedDb(fake, "default")
    run(d[pf.COLL].insert_one({"_id": "h1", "mid": "m1", "pid": "p1", "files": [{"file": "f"}]}))
    run(d[pf.COLL].insert_one({"_id": "h2", "mid": "m1", "pid": "p2", "files": []}))
    run(d["inventory"].insert_one({"_id": "i1", "name": "x", "quantity": 3,
                                   "catalog": {"manufacturer": "m1", "product": "p3"}}))
    assert run(pf.kept_ids(d, "m1")) == {"p1", "p3"}


def test_a_deleted_product_leaves_its_files_and_the_export_carries_them(db, grid, site):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    mid, (p1, p2) = maker(a, products=({"name": "Hinge", "sku": "H-1"}, {"name": "Latch"}))
    a.post(f"/api/manufacturers/{mid}/products/{p1}/files", files={"upload": ("hinge.step", STEP)})
    a.post(f"/api/manufacturers/{mid}/products/{p2}/files", files={"upload": ("latch.pdf", PDF)})
    ex = a.get(f"/api/manufacturers/{mid}/export").json()
    hinge = next(p for p in ex["products"] if p["name"] == "Hinge")
    assert hinge["attachments"][0]["name"] == "hinge.step" and hinge["attachments"][0]["main"] is True
    # imported where Files holds the same bytes: attached again; where it does not: said missing
    b.post("/api/files", files={"upload": ("my hinge.step", STEP)})
    got = b.post("/api/manufacturers/import", json=ex).json()
    files_said = got.get("imported", {}).get("files") or {}
    assert files_said.get("linked") == 1 and files_said.get("missing") == ["latch.pdf"]
    pb = next(p for p in got["products"] if p["name"] == "Hinge")
    assert b.get(f"/api/manufacturers/{got['id']}/products/{pb['id']}/files").json()["cad"]["name"] == "my hinge.step"
    # deleted by hand: the files stay in Files, their references go to Parts' Deleted with it - no orphan
    a.delete(f"/api/manufacturers/{mid}/products/{p2}")
    s = a.get("/api/product-files/summary").json()
    assert s["orphans"] == [] and any(f["name"] == "latch.pdf" for f in a.get("/api/files").json())
    unit = a.get("/api/manufacturers/trash").json()["units"][0]
    assert unit["name"] == "Latch" and [f["name"] for f in unit["files"]] == ["latch.pdf"]


# ---------------------------------------------------------------- from an address

def test_a_file_from_an_address_is_fetched_under_the_crawlers_rules(web, grid, monkeypatch):  # noqa: F811
    monkeypatch.setitem(PUBLIC, "files.example.com", ["93.184.216.41"])
    monkeypatch.setitem(PUBLIC, "www.mcmaster.com", ["93.184.216.42"])

    def handle(req: httpx.Request) -> httpx.Response:
        web["seen"].append(str(req.url))
        if req.url.path == "/ds":
            return httpx.Response(302, headers={"location": "/files/UB0228.pdf"})
        if req.url.path == "/files/UB0228.pdf":
            return httpx.Response(200, content=PDF, headers={"content-type": "application/pdf"})
        if req.url.path == "/page":
            return httpx.Response(200, text="<html>hi</html>", headers={"content-type": "text/html"})
        if req.url.path == "/download":
            return httpx.Response(200, content=STEP, headers={"content-type": "application/octet-stream"})
        if req.url.path == "/big.step":
            return httpx.Response(200, content=STEP * 10, headers={"content-type": "application/octet-stream"})
        return httpx.Response(404)
    web["site"] = handle
    name, data = run(pf.fetch("https://files.example.com/ds"))
    assert name == "UB0228.pdf" and data == PDF
    assert run(pf.fetch("https://files.example.com/download"))[0] == "download.step"   # a STEP known by its bytes
    with pytest.raises(pf.Refused, match="web page"):
        run(pf.fetch("https://files.example.com/page"))
    with pytest.raises(pf.Refused, match="never downloads from mcmaster.com"):
        run(pf.fetch("https://www.mcmaster.com/91290A115/"))
    with pytest.raises(pf.Refused, match="private or local"):
        PUBLIC["intranet.example.com"] = ["10.0.0.5"]
        try:
            run(pf.fetch("https://intranet.example.com/x.step"))
        finally:
            PUBLIC.pop("intranet.example.com")
    monkeypatch.setattr(pf, "FETCH_MAX", len(STEP) * 2)
    with pytest.raises(pf.Refused, match="more than 0.0 MB"):
        run(pf.fetch("https://files.example.com/big.step"))
    assert not any("mcmaster" in u for u in web["seen"])


def test_a_dm_card_says_a_product_holds_files(grid, monkeypatch):
    fake = FakeDb()
    d = scope.ScopedDb(fake, "default")
    monkeypatch.setattr(actors, "current", lambda: {"id": "u1", "name": "One"})
    pid = run(_own(d, "Cable"))
    assert run(pf.card_line(d, "own", pid)) == ""
    run(pf.put(d, "own", pid, "c.step", STEP, measure=False))
    run(pf.put(d, "own", pid, "c.pdf", PDF, measure=False))
    assert run(pf.card_line(d, "own", pid)) == "3D model (STEP) + 1 file"


def test_the_agents_read_attach_and_model_a_products_files(monkeypatch, capsys):
    import argparse

    from tools import revisions
    asked = []
    view = {"name": "UB0228 Vida", "maker": "m1", "product": "p1", "maker_name": "Robo90",
            "files": [{"file": "f1", "name": "UB0228.STEP", "role": "model", "kind": "step", "bytes": 20480}],
            "cad": {"file": "f1"}, "measured": {"rows": [["Size", "6 × 6 × 27.4 mm"]],
                                                "mismatch": [{"what": "Length", "said": "30 mm", "measured": "25 mm"}]}}

    def api_call(path, method="GET", body=None, timeout=60):
        asked.append((method, path, body))
        if path.endswith("/to-model"):
            return {"model": "lamp/p/ub0228", "title": "x", "upload": "UB0228.STEP", "build_job": "j1"}
        return {**view, "report": [{"status": "attached", "name": "UB0228.STEP", "role": "model", "main": True}]}
    monkeypatch.setattr(revisions, "api_call", api_call)
    ns = dict(target="m1:p1", file=None, url=None, folder=None, title=None)
    revisions.cmd_product(argparse.Namespace(what="files", **ns))
    out = capsys.readouterr().out
    assert asked[-1] == ("GET", "/api/manufacturers/m1/products/p1/files", None)
    assert "f1  UB0228.STEP  model, step, 20 kB [3D model]" in out and "MISMATCH Length" in out
    revisions.cmd_product(argparse.Namespace(what="attach", **{**ns, "file": ["f1"]}))
    assert asked[-1] == ("POST", "/api/manufacturers/m1/products/p1/files/attach", {"files": ["f1"]})
    assert "its 3D model now" in capsys.readouterr().out
    revisions.cmd_product(argparse.Namespace(what="to-model", **{**ns, "folder": "lamp/p"}))
    assert asked[-1] == ("POST", "/api/manufacturers/m1/products/p1/to-model", {"folder": "lamp/p"})
    # `linked to-model` takes any source's product too
    revisions.cmd_linked(argparse.Namespace(what="to-model", target="own:abc", source=None, all=False,
                                            folder="lamp/p", title=None))
    assert asked[-1][1] == "/api/manufacturers/own/products/abc/to-model"


def test_an_orphans_files_go_to_another_product_or_are_let_go(db, grid, site):  # noqa: F811
    a = person(db, "a")
    mid, (p1, p2, p3) = maker(a, products=({"name": "Hinge"}, {"name": "Latch"}, {"name": "Hinge v2"}))
    a.post(f"/api/manufacturers/{mid}/products/{p1}/files", files={"upload": ("hinge.step", STEP)})
    a.post(f"/api/manufacturers/{mid}/products/{p1}/files", files={"upload": ("hinge datasheet.pdf", PDF)})
    a.post(f"/api/manufacturers/{mid}/products/{p2}/files", files={"upload": ("latch.pdf", PDF + b" ")})
    assert a.get("/api/product-files/orphans").json() == []
    # deleted the way products were before Parts' Deleted: out of the catalog's document only
    run(mf.drop_products(scope.ScopedDb(db, "ua"), mid, [p1, p2]))
    got = a.get("/api/product-files/orphans").json()
    assert {o["pid"] for o in got} == {p1, p2}
    hinge = next(o for o in got if o["pid"] == p1)
    assert hinge["name"] == "Hinge" and hinge["maker_name"] == "Robo90"
    assert sorted(f["name"] for f in hinge["files"]) == ["hinge datasheet.pdf", "hinge.step"]
    assert all(f["in_files"] for f in hinge["files"]) and hinge["cad"]
    # attached to another product: its STEP its model, the orphan gone
    r = a.post(f"/api/manufacturers/orphan-files/{mid}/{p1}/adopt", json={"maker": mid, "product": p3}).json()
    assert r["left"] == 0 and r["product"]["cad"]["name"] == "hinge.step" and len(r["product"]["files"]) == 2
    assert [o["pid"] for o in a.get("/api/product-files/orphans").json()] == [p2]
    # a product still in Parts is no orphan
    assert a.post(f"/api/manufacturers/orphan-files/{mid}/{p3}/adopt", json={"maker": mid, "product": p3}).status_code == 400
    assert a.delete(f"/api/manufacturers/orphan-files/{mid}/{p3}").status_code == 400
    # let go with its file removed from Files - nothing else refers to it, and its uploader asks
    r = a.delete(f"/api/manufacturers/orphan-files/{mid}/{p2}?delete_files=true").json()
    assert r == {"removed": ["latch.pdf"], "kept": []}
    assert a.get("/api/product-files/orphans").json() == []
    assert not any(f["name"] == "latch.pdf" for f in a.get("/api/files").json())
    assert a.delete(f"/api/manufacturers/orphan-files/{mid}/{p2}").status_code == 404
