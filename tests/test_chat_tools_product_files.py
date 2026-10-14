"""The Chat's tools for the files of Parts products (backend/chat_tools:
product_find, product_files_read, product_file_attach, product_file_detach,
product_set_main, product_to_model, product_files_missing,
product_to_my_items; backend/product_files.py).

What matters: a STEP the person attached in the Chat - an @-mention of its
Files id - goes on the product they mean as its 3D model, by its ids, by
words, or "this product" (the one the conversation last worked on); the
answer says what the STEP measured; several products fitting the words are
named for the model to ask; a viewer attaches nothing; the strings are
Turkish too; and a whole answer of a fake model runs the tool with the
attachment. No real model, no real site."""

from __future__ import annotations

import asyncio

import pytest

from backend import access, actors, catalog_own, cc_chat, chat_tools, files, scope
from backend import inventory as inv
from backend import manufacturers as mf
from backend import product_files as pf
from backend.chat_tools import Ctx, ToolError
from test_files_folders import Grid
from test_linked import STEP
from test_product_files import PAN, PDF, PNG
from test_telegram import FakeDb
from tests.test_cc_generation import answers, gen_doc, until  # noqa: F401
from tests.test_cc_mentions_live_search import env, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import tool_model

ME = {"id": "u-me", "name": "Me", "type": "person"}
NAMES = ("product_find", "product_files_read", "product_file_attach", "product_file_detach", "product_set_main",
         "product_to_model", "product_files_missing", "product_to_my_items")


def run(c):
    return asyncio.run(c)


def _tool(name):
    return chat_tools.tools()[name]


@pytest.fixture
def ws(monkeypatch):
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    fake = FakeDb()
    state = {"role": "reviewer", "who": ME}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    db = scope.ScopedDb(fake, "default")
    # a site's catalog, as a crawl leaves it
    run(db[mf.COLL].insert_one({"_id": "m1", "name": "Robo90", "domain": "robo90.com", "url": "https://www.robo90.com/",
                                "by": dict(ME), "products": [
                                    {"id": "p1", "name": "UB0228 Vida M3x30", "sku": "UB0228", "specs": {"Uzunluk": "30 mm"}},
                                    {"id": "p2", "name": "UB0229 Vida M3x20", "sku": "UB0229", "specs": {}},
                                    {"id": "p3", "name": "Menteşe 20 mm", "sku": "", "specs": {}}]}))
    return db, fake, state


def call(db, name, args, chat=""):
    return run(_tool(name).run(Ctx(db=db, actor=ME, chat=chat), args))


def put_file(db, name, data):
    return run(files.put(db, name, data, None, {"room": "chat"}, ME))["_id"]


# ---- what they are -----------------------------------------------------------------

def test_the_tools_are_parts_tools_at_their_levels():
    got = {n: (t.package, t.level, t.default) for n, t in chat_tools.tools().items() if n in NAMES}
    assert got == {"product_find": ("mfr", "read", True), "product_files_read": ("mfr", "read", True),
                   "product_file_attach": ("mfr", "change", True), "product_file_detach": ("mfr", "delete", True),
                   "product_set_main": ("mfr", "change", True), "product_to_model": ("mfr", "change", True),
                   "product_files_missing": ("mfr", "read", True), "product_to_my_items": ("mfr", "change", False)}
    att = _tool("product_file_attach").description
    # said so plainly that a small model picks it
    assert "attaches a STEP/STP" in att and "asks to add it to a product" in att and "3D model" in att
    note = chat_tools.SYSTEM_NOTE
    for n in NAMES:
        assert n in note
    assert "add this to this product as its 3D model" in note


def test_their_sentences_are_in_turkish_too():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()

    def has(s):
        return f"'{s}':" in tr or f"'{s.replace(chr(39), chr(92) + chr(39))}':" in tr
    for n in NAMES:
        t = _tool(n)
        for s in (t.label, t.about, t.running, t.failed):
            assert has(s), (n, s)
        assert f"{n}:" in icons, n
    for s in ("Found {n} products for {q}", "Nothing found for {q}", "Read the files of {product}",
              "Attached {file} to {product} - measuring it", "Attached {file} to {product}: {dims}",
              "Attached {file} to {product}", "Detached {file} from {product}", "Made {file} the picture of {product}",
              "Made {file} the 3D model of {product}", "Added {product} to {folder} as a model",
              "{n} products have no 3D model", "{n} products have no datasheet", "{n} products have no files",
              "Copied {product} to My Items"):
        assert has(s), s


# ---- finding the product -------------------------------------------------------------

def test_a_product_is_found_by_words_in_every_source(ws):
    db, _, _ = ws
    got = call(db, "product_find", {"query": "UB0228"})
    assert "m1:p1  UB0228 Vida M3x30" in got.text and got.vars["m"] == "m1" and got.vars["pid"] == "p1"
    many = call(db, "product_find", {"query": "vida"})
    assert many.vars["n"] == 2 and "m1:p1" in many.text and "m1:p2" in many.text and "ask the person" in many.text
    assert call(db, "product_find", {"query": "nothing like it"}).say == "Nothing found for {q}"


def test_several_products_fitting_the_words_are_named_to_ask(ws):
    db, _, _ = ws
    fid = put_file(db, "x.pdf", PDF)
    with pytest.raises(ToolError) as e:
        call(db, "product_file_attach", {"product": "vida", "files": [fid]})
    assert "2 products match" in str(e.value) and "m1:p1" in str(e.value) and "Ask the person which one" in str(e.value)
    with pytest.raises(ToolError, match="say which product"):
        call(db, "product_files_read", {})


# ---- attaching what the person attached ------------------------------------------------

def test_a_step_attached_in_the_chat_goes_on_the_product_and_is_measured(ws):
    pytest.importorskip("OCP")
    db, fake, _ = ws
    fid = put_file(db, "UB0228.STEP", PAN)
    run(db[cc_chat.COLL].insert_one({"_id": "c1", "title": "x", "messages": [
        {"id": "l1", "role": "user", "content": "add this to this product as its 3D model",
         "mentions": [{"kind": "file", "id": fid, "label": "UB0228.STEP"}]}]}))
    got = call(db, "product_file_attach", {"product": "UB0228"}, chat="c1")         # no `files`: the attachment
    assert "attached UB0228.STEP" in got.text and "it is the product's 3D model now" in got.text
    assert "Length: 25 mm under the head" in got.text and "MISMATCH" in got.text and "30 mm" in got.text
    assert got.say == "Attached {file} to {product}: {dims}" and got.vars["m"] == "m1" and got.vars["pid"] == "p1"
    assert len(fake["files"].docs) == 1                                             # referred to, not copied
    # read back
    r = call(db, "product_files_read", {"product": "m1:p1"})
    assert "UB0228.STEP" in r.text and "[its 3D model]" in r.text and "6 × 6 × 27.4 mm" in r.text
    # the same file again: once
    again = call(db, "product_file_attach", {"product": "m1:p1", "files": [fid]})
    assert "is attached already" in again.text


def test_this_product_is_the_one_the_conversation_last_worked_on(ws):
    db, _, _ = ws
    pdf = put_file(db, "UB0229 datasheet.pdf", PDF)
    run(db[cc_chat.COLL].insert_one({"_id": "c2", "title": "x", "messages": [
        {"id": "a1", "role": "assistant", "content": "", "steps": [
            {"tool": "product_find", "status": "done", "vars": {"q": "UB0229", "m": "m1", "pid": "p2"}}]},
        {"id": "l2", "role": "user", "content": "this is its datasheet",
         "mentions": [{"kind": "file", "id": pdf, "label": "UB0229 datasheet.pdf"}]}]}))
    got = call(db, "product_file_attach", {}, chat="c2")
    assert got.vars["product"] == "UB0229 Vida M3x20" and "as datasheet" in got.text
    assert got.say == "Attached {file} to {product}"


def test_nothing_to_attach_and_what_a_product_does_not_keep(ws):
    db, _, _ = ws
    with pytest.raises(ToolError, match="no file to attach"):
        call(db, "product_file_attach", {"product": "m1:p3"})
    txt = put_file(db, "notes.txt", b"hello")
    with pytest.raises(ToolError, match="a product keeps only those"):
        call(db, "product_file_attach", {"product": "m1:p3", "files": [txt]})
    with pytest.raises(ToolError, match="no file nope"):
        call(db, "product_file_attach", {"product": "m1:p3", "files": ["nope"]})


def test_a_viewer_attaches_nothing(ws):
    db, fake, state = ws
    fid = put_file(db, "x.pdf", PDF)
    state["role"] = "viewer"
    with pytest.raises(ToolError, match="as viewer you cannot"):
        call(db, "product_file_attach", {"product": "m1:p3", "files": [fid]})
    assert not fake[pf.COLL].docs


def test_a_picture_becomes_the_products_and_a_model_goes_to_a_project(ws, monkeypatch):
    db, _, state = ws
    pic = put_file(db, "hinge.png", PNG)
    stp = put_file(db, "hinge.step", STEP)
    call(db, "product_file_attach", {"product": "m1:p3", "files": [pic, stp]})
    got = call(db, "product_set_main", {"product": "m1:p3", "as": "image"})
    assert got.say == "Made {file} the picture of {product}"
    assert run(pf.of(db, "m1", "p3"))["picture"]["file"] == pic
    seen = {}

    async def files_to_model(fid, body):
        seen.update(fid=fid, folder=body.folder, title=body.title)
        return {"model": f"{body.folder}/hinge", "title": body.title, "upload": "hinge.step", "build_job": "j1"}
    from backend import main
    monkeypatch.setattr(main, "files_to_model", files_to_model)
    with pytest.raises(ToolError, match="as reviewer you cannot"):              # it changes the design: "edit"
        call(db, "product_to_model", {"product": "m1:p3", "folder": "lamp/purchased"})
    state["role"] = "editor"
    got = call(db, "product_to_model", {"product": "m1:p3", "folder": "lamp/purchased"})
    assert seen == {"fid": stp, "folder": "lamp/purchased", "title": "Robo90 Menteşe 20 mm"}
    assert got.say == "Added {product} to {folder} as a model" and "lamp/purchased/hinge" in got.text
    with pytest.raises(ToolError, match="no 3D model attached"):
        call(db, "product_to_model", {"product": "m1:p2", "folder": "lamp"})


def test_detaching_and_whats_missing(ws):
    db, fake, _ = ws
    stp = put_file(db, "a.step", STEP)
    call(db, "product_file_attach", {"product": "m1:p1", "files": [stp]})
    miss = call(db, "product_files_missing", {})
    assert miss.vars["n"] == 2 and "m1:p2" in miss.text and "m1:p1" not in miss.text
    assert miss.say == "{n} products have no 3D model"
    assert call(db, "product_files_missing", {"missing": "datasheet"}).vars["n"] == 3
    got = call(db, "product_file_detach", {"product": "m1:p1", "file": stp})
    assert "It has no 3D model now" in got.text and "stays in Files" in got.text and stp in fake["files"].docs
    with pytest.raises(ToolError, match="is not attached"):
        call(db, "product_file_detach", {"product": "m1:p1", "file": stp})


def test_a_product_copied_to_my_items_takes_its_stock_and_files(ws):
    db, _, _ = ws
    stp = put_file(db, "a.step", STEP)
    call(db, "product_file_attach", {"product": "m1:p1", "files": [stp]})
    item, _ = run(inv.from_catalog(db, "m1", "p1", 40, location="Shelf A", by=ME))
    got = call(db, "product_to_my_items", {"product": "m1:p1"})
    own = got.vars["pid"]
    assert got.vars["m"] == catalog_own.MID and "1 stock line(s)" in got.text
    assert run(inv.get(db, item["_id"]))["catalog"]["product"] == own
    assert run(pf.of(db, "own", own))["cad"]["file"] == stp
    assert run(pf.of(db, "m1", "p1"))["cad"]["file"] == stp          # the original keeps its file too


# ---- in a whole answer, with the attachment -------------------------------------------

def test_the_chat_attaches_the_step_the_person_sent(env, monkeypatch):  # noqa: F811
    raw, state = env
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    seed_chat(raw)
    db = scope.ScopedDb(raw, "default")
    run(db[mf.COLL].insert_one({"_id": "m1", "name": "Robo90", "domain": "robo90.com", "url": "https://www.robo90.com/",
                                "products": [{"id": "p1", "name": "UB0228 Vida", "sku": "UB0228", "specs": {}}]}))
    fid = run(files.put(db, "UB0228.STEP", STEP, None, {"room": "chat"}, ME))["_id"]
    tool_model(monkeypatch, state, [("", [("product_file_attach", {"product": "UB0228"})]),
                                    ("Added it as its 3D model.", [])])

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="add this to this product as its 3D model", client="tab1",
                                                     mentions=[{"kind": "file", "id": fid}]))
        await until(lambda: answers(raw))
        async for _ in resp.body_iterator:
            pass
    asyncio.run(go())
    (step,) = answers(raw)[-1]["steps"]
    assert step["tool"] == "product_file_attach" and step["status"] == "done", step
    assert step["vars"]["product"] == "UB0228 Vida" and step["vars"]["file"] == "UB0228.STEP"
    sent = state["rounds"][0]
    assert any(t["name"] == "product_file_attach" for t in sent["tools"])
    assert f'kind="file" id="{fid}"' in str(sent["messages"])                        # the model saw the Files id
    doc = next(iter(raw[pf.COLL].rows.values()))
    assert doc["cad"]["file"] == fid and doc["mid"] == "m1" and doc["pid"] == "p1"


def test_an_unnamed_product_is_the_one_the_files_name_names(ws):
    db, _, _ = ws
    fid = put_file(db, "UB0229.STEP", STEP)
    run(db[cc_chat.COLL].insert_one({"_id": "c3", "title": "x", "messages": [
        {"id": "l1", "role": "user", "content": "bunu bu ürüne 3d model olarak ekler misin",
         "mentions": [{"kind": "file", "id": fid, "label": "UB0229.STEP"}]}]}))
    got = call(db, "product_file_attach", {}, chat="c3")
    assert got.vars["pid"] == "p2" and "the file's name (UB0229) names this one" in got.text


def test_a_stock_line_read_names_this_product(ws):
    db, _, _ = ws
    run(inv.from_catalog(db, "m1", "p3", 2, by=ME))
    got = call(db, "inventory_search", {"query": "menteşe"})
    assert got.vars["m"] == "m1" and got.vars["pid"] == "p3"
