"""The Chat's tools that write to the Product Catalog (backend/chat_tools:
catalog_read_page, catalog_add_product, catalog_edit_product,
catalog_remove_product, catalog_add_maker).

What matters: a page given in the Chat is read into the catalog of the
maker kept for its site - or one made for that site, as the tab's "Only
this page" makes it - by the same page-run as the tab's, under the
crawler's rules (public addresses only); the tool hands back the run's link
at once or waits a short while and says what was added; products by hand
go through the tab's own code (duplicates refused); removing asks first;
and a viewer changes nothing. No real site and no real model are reached:
the HTTP goes to a fake transport, the names to a fake resolver, the model
is a stub."""

from __future__ import annotations

import asyncio
import copy

import httpx
import pytest

from backend import access, actors, cc_chat, ccgen, chat_tools, llm, netproxy, scope
from backend import manufacturers as mf
from backend.chat_tools import Ctx, ToolError
from backend.chat_tools import catalog_read_page as crp
from test_manufacturers import PUBLIC, web  # noqa: F401 - web is a fixture
from test_telegram import FakeDb
from tests.test_cc_generation import answers, gen_doc, until
from tests.test_cc_mentions_live_search import env, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import run, tool_model

ME = {"id": "u-me", "name": "Me", "type": "person"}
NAMES = ("catalog_read_page", "catalog_add_product", "catalog_edit_product", "catalog_remove_product",
         "catalog_add_maker")
PAGE = "https://www.robo90.com/robo90-gri-eco-pla-filament-175mm-1-kg"
FILAMENT = "Robo90 Gri Eco PLA Filament 1.75mm 1 kg"


def _tool(name):
    return chat_tools.tools()[name]


# ---- a fake shop and a fake model ------------------------------------------------

def shop(seen: list):
    """www.robo90.com, as the fake transport serves it: one product page."""
    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        if req.url.host == "www.robo90.com" and req.url.path == "/robo90-gri-eco-pla-filament-175mm-1-kg":
            body = (f"<html><head><title>{FILAMENT}</title></head><body><h1>{FILAMENT}</h1>"
                    "<p>Stok kodu: R90-PLA-GRI</p><p>Fiyat: 449,90 TL</p><p>Çap 1.75 mm, 1 kg</p></body></html>")
            return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404, text="nope")
    return handle


def fake_model(monkeypatch, empty=False, calls=None):
    async def complete(messages, **kw):
        if calls is not None:
            calls.append(messages)
        user = messages[1]["content"]
        prods = [] if empty or f"=== PAGE {PAGE}" not in user else [
            {"name": FILAMENT, "category": "Filament", "sku": "R90-PLA-GRI", "url": PAGE,
             "specs": {"Çap": "1.75 mm", "Ağırlık": "1 kg", "Fiyat": "449,90 TL"}}]
        import json
        text = json.dumps({"company": {"name": "Robo90", "description": "3D yazıcı malzemeleri.",
                                       "categories": ["Filament"]}, "products": prods})
        return {"choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                "provider": "commandcode", "model": "m"}

    async def nothing(db, **kw):
        pass
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", nothing)
    monkeypatch.setattr(llm, "route", lambda job: ("commandcode", "m"))


@pytest.fixture
def ws(web, monkeypatch):  # noqa: F811
    """A workspace's database as the tools get it, who is asking, the fake
    shop on the fake internet, the stub model, and no proxy set up."""
    monkeypatch.setitem(PUBLIC, "www.robo90.com", ["93.184.216.40"])
    web["site"] = shop(web["seen"])
    monkeypatch.setattr(netproxy, "_conf", {})
    fake_model(monkeypatch)
    fake = FakeDb()
    state = {"role": "reviewer", "who": ME}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    return scope.ScopedDb(fake, "default"), web, state


def call(db, name, args):
    return run(_tool(name).run(Ctx(db=db, actor=ME), args))


def makers(db):
    return run(mf.listing(db))


def _maker(db, url="https://www.robo90.com/", name="Robo90", products=()):
    doc = run(mf.create(db, url, name, by=ME))
    if products:
        run(db[mf.COLL].update_one({"_id": doc["_id"]}, {"$set": {"products": list(products)}}))
    return doc["_id"]


# ---- what they are -----------------------------------------------------------------

def test_the_tools_are_in_the_catalog_package_at_their_levels():
    got = {n: (t.package, t.level, t.default) for n, t in chat_tools.tools().items() if n in NAMES}
    assert got == {"catalog_read_page": ("mfr", "change", True), "catalog_add_product": ("mfr", "change", True),
                   "catalog_edit_product": ("mfr", "change", False),
                   "catalog_remove_product": ("mfr", "delete", True), "catalog_add_maker": ("mfr", "change", False)}
    order = list(chat_tools.tools())
    assert order.index("manufacturer_search") < order.index("catalog_read_page") < order.index("inventory_search")
    note = chat_tools.SYSTEM_NOTE
    for n in NAMES:
        assert n in note
    assert "product or shop page" in note and "then inventory_add can stock it" in note


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
    for s in ("A run of {name} is already going", "Reading the page into {name}",
              "Added {product} to the catalog of {name}", "Added {n} products to the catalog of {name}",
              "Changed {fields} of {product} in the catalog", "Removed {products} from the catalog of {name}",
              "{name} is already in the catalog", "Added {name} to the Product Catalog",
              "Added {name} and started exploring its site"):
        assert has(s), s


# ---- a page read into the catalog ---------------------------------------------------

def test_a_shop_page_makes_its_maker_and_waits_for_the_products(ws):
    db, web, _ = ws
    got = call(db, "catalog_read_page", {"urls": [PAGE]})
    (m,) = makers(db)
    # made as the tab's "Only this page" makes it: the site's root, named from the host
    assert m["url"] == "https://www.robo90.com/" and m["name"] == "robo90.com" and m["domain"] == "robo90.com"
    assert m["proxy"] == "off" and m["by"]["id"] == ME["id"]
    (p,) = m["products"]
    assert p["name"] == FILAMENT and p["sku"] == "R90-PLA-GRI" and p["url"] == PAGE
    (j,) = run(mf.jobs(db, 5, m["_id"]))
    assert j["kind"] == "page" and j["only"] == [PAGE] and not j["follow"] and j["status"] == "done"
    assert got.say == "Added {product} to the catalog of {name}"
    assert got.vars["product"] == FILAMENT and got.vars["name"] == "robo90.com" and got.vars["run"] == j["_id"]
    assert got.vars["link"] == f"/?ws=catalog&m={m['_id']}&run={j['_id']}"
    assert "A new manufacturer was made" in got.text and f"[{p['id']}] {FILAMENT}" in got.text
    assert "code R90-PLA-GRI" in got.text and "Fiyat: 449,90 TL" in got.text and "1 added" in got.text
    assert "449,90 TL" in got.summary
    # only that page (and its robots.txt) was fetched
    assert web["seen"] == ["https://www.robo90.com/robots.txt", PAGE]


def test_a_page_goes_to_the_maker_kept_for_its_site_or_the_one_named(ws):
    db, web, _ = ws
    mid = _maker(db, products=[{"id": "o1", "name": "Siyah PLA", "category": "", "description": "", "specs": {},
                                "sku": "R90-PLA-SYH", "url": "", "image": ""}])
    other = _maker(db, "https://www.dogus.com.tr/", "Doğuş Kalıp")
    got = call(db, "catalog_read_page", {"urls": [PAGE.replace("https://", "")]})       # no scheme: https
    assert len(makers(db)) == 2 and got.vars["m"] == mid and "new manufacturer" not in got.text
    m = run(mf.get(db, mid))
    assert [p["name"] for p in m["products"]] == ["Siyah PLA", FILAMENT]                  # added, nothing dropped
    # read again: nothing doubled, and it says so
    again = call(db, "catalog_read_page", {"urls": [PAGE], "manufacturer": "robo90"})
    assert again.vars["n"] == 0 and "0 added" in again.text and len(run(mf.get(db, mid))["products"]) == 2
    # a distributor's page into the maker it is named for
    got = call(db, "catalog_read_page", {"urls": [PAGE], "manufacturer": "doğuş"})
    assert got.vars["m"] == other and [p["name"] for p in run(mf.get(db, other))["products"]] == [FILAMENT]
    with pytest.raises(ToolError, match="no manufacturer 'nobody'"):
        call(db, "catalog_read_page", {"urls": [PAGE], "manufacturer": "nobody"})


def test_without_waiting_it_hands_back_the_run_and_its_link(ws, monkeypatch):
    db, _, _ = ws

    async def go():
        got = await _tool("catalog_read_page").run(Ctx(db=db, actor=ME), {"urls": [PAGE], "wait": False})
        jid = got.vars["run"]
        assert (await mf.job(db, jid))["status"] in mf.ACTIVE                        # returned at once
        busy = await _tool("catalog_read_page").run(Ctx(db=db, actor=ME), {"urls": [PAGE]})
        await mf._TASKS[jid]
        return got, busy, await mf.job(db, jid)
    got, busy, j = run(go())
    mid = makers(db)[0]["_id"]
    assert got.say == "Reading the page into {name}" and got.vars["link"] == f"/?ws=catalog&m={mid}&run={j['_id']}"
    assert got.vars["link"] in got.text and "background" in got.text
    # one maker runs one at a time: the second ask is told so, with the run's link
    assert busy.say == "A run of {name} is already going" and busy.vars["run"] == j["_id"]
    assert len(makers(db)) == 1 and j["status"] == "done" and len(makers(db)[0]["products"]) == 1


def test_a_run_longer_than_the_wait_goes_on_in_the_background(ws, monkeypatch):
    db, _, _ = ws
    monkeypatch.setattr(crp, "WAIT", 0.0)

    async def go():
        got = await _tool("catalog_read_page").run(Ctx(db=db, actor=ME), {"urls": [PAGE], "follow": True})
        await mf._TASKS[got.vars["run"]]
        return got
    got = run(go())
    assert got.say == "Reading the page into {name}" and "still going" in got.text and got.vars["link"] in got.text
    j = run(mf.job(db, got.vars["run"]))
    assert j["follow"] and j["status"] == "done"


def test_a_run_that_finds_nothing_fails_and_says_why(ws, monkeypatch):
    db, _, _ = ws
    fake_model(monkeypatch, empty=True)
    with pytest.raises(ToolError, match="found no products on the page.*made for the site and is kept"):
        call(db, "catalog_read_page", {"urls": [PAGE]})
    assert len(makers(db)) == 1


def test_only_public_pages_are_read(ws):
    db, web, _ = ws
    for bad in ("http://127.0.0.1/x", "http://10.0.0.5/admin", "http://inside.example/", "http://meta.example/latest",
                "ftp://www.robo90.com/x", "http://localhost:8000/api", "javascript:alert(1)"):
        with pytest.raises(ToolError):
            call(db, "catalog_read_page", {"urls": [bad]})
    with pytest.raises(ToolError, match="different sites"):
        call(db, "catalog_read_page", {"urls": [PAGE, "https://www.dogus.com.tr/Urun/mentese/1"]})
    with pytest.raises(ToolError, match="at most 10"):
        call(db, "catalog_read_page", {"urls": [f"{PAGE}?v={i}" for i in range(11)]})
    with pytest.raises(ToolError, match="give `urls`"):
        call(db, "catalog_read_page", {"urls": []})
    assert makers(db) == [] and web["seen"] == []


# ---- products by hand -----------------------------------------------------------------

def test_products_by_hand_added_edited_and_removed(ws):
    db, _, _ = ws
    mid = _maker(db)
    got = call(db, "catalog_add_product", {"manufacturer": "Robo90", "products": [
        {"name": "Gri PLA", "code": "R90-PLA-GRI", "category": "Filament", "specs": {"Çap": 1.75, "Fiyat": "449 TL"},
         "url": "www.robo90.com/gri", "image": "https://www.robo90.com/gri.jpg"},
        {"name": "Beyaz PLA", "sku": "r90-pla-gri"},                                 # the same code: refused
        {"name": ""},
        {"name": "Siyah PETG", "description": "PETG"}]})
    m = run(mf.get(db, mid))
    assert [p["name"] for p in m["products"]] == ["Gri PLA", "Siyah PETG"]
    gri = m["products"][0]
    assert gri["source"] == "manual" and gri["sku"] == "R90-PLA-GRI" and gri["specs"] == {"Çap": "1.75", "Fiyat": "449 TL"}
    assert gri["url"] == "https://www.robo90.com/gri" and gri["added_by"]["id"] == ME["id"]
    assert got.say == "Added {n} products to the catalog of {name}" and got.vars["n"] == 2
    assert "NOT added \"Beyaz PLA\"" in got.text and "already in the catalog" in got.text and "NOT added \"?\": name:" in got.text
    with pytest.raises(ToolError, match="nothing was added"):
        call(db, "catalog_add_product", {"manufacturer": mid, "products": [{"name": "gri pla", "sku": "R90-PLA-GRI"}]})
    # no maker named: the one for the products' pages' site; none at all - say which
    one = call(db, "catalog_add_product", {"products": [{"name": "Mavi PLA", "url": "https://www.robo90.com/mavi"}]})
    assert one.say == "Added {product} to the catalog of {name}" and one.vars["m"] == mid
    with pytest.raises(ToolError, match="say which manufacturer"):
        call(db, "catalog_add_product", {"products": [{"name": "x"}]})
    # a maker made for a site, when asked to
    got = call(db, "catalog_add_product", {"site": "https://www.dogus.com.tr/", "maker_name": "Doğuş Kalıp",
                                           "products": [{"name": "Menteşe 20 mm", "sku": "DK-1"}]})
    dogus = next(d for d in makers(db) if d["domain"] == "dogus.com.tr")
    assert dogus["name"] == "Doğuş Kalıp" and got.vars["m"] == dogus["_id"] and "new manufacturer" in got.text
    with pytest.raises(ToolError, match="private or local"):
        call(db, "catalog_add_product", {"site": "http://10.0.0.5/", "products": [{"name": "x"}]})

    # edit: only the fields given; specs added to, unless replaced
    got = call(db, "catalog_edit_product", {"manufacturer": "robo90", "product": "R90-PLA-GRI",
                                            "set": {"category": "PLA", "specs": {"Fiyat": "429 TL"}}})
    gri = next(p for p in run(mf.get(db, mid))["products"] if p["sku"] == "R90-PLA-GRI")
    assert gri["category"] == "PLA" and gri["specs"] == {"Çap": "1.75", "Fiyat": "429 TL"} and gri["edited"]
    assert got.say == "Changed {fields} of {product} in the catalog" and got.vars["fields"] == "category, specs"
    call(db, "catalog_edit_product", {"manufacturer": mid, "product": gri["id"], "set": {"specs": {"Renk": "Gri"}},
                                      "replace_specs": True})
    assert next(p for p in run(mf.get(db, mid))["products"] if p["id"] == gri["id"])["specs"] == {"Renk": "Gri"}
    with pytest.raises(ToolError, match="already in the catalog"):
        call(db, "catalog_edit_product", {"manufacturer": mid, "product": "petg", "set": {"sku": "R90-PLA-GRI"}})
    with pytest.raises(ToolError, match="2 products of Robo90 match 'pla'"):
        call(db, "catalog_edit_product", {"manufacturer": mid, "product": "pla", "set": {"category": "x"}})

    # remove (asked first in a real answer: its level)
    got = call(db, "catalog_remove_product", {"manufacturer": "robo90", "products": ["Siyah PETG", gri["id"]]})
    assert got.say == "Removed {products} from the catalog of {name}" and got.vars["n"] == 2
    assert [p["name"] for p in run(mf.get(db, mid))["products"]] == ["Mavi PLA"]
    with pytest.raises(ToolError, match="no product 'nope'"):
        call(db, "catalog_remove_product", {"manufacturer": mid, "products": ["nope"]})


def test_a_maker_by_its_site_and_its_exploration_only_when_asked(ws, monkeypatch):
    db, _, _ = ws
    started = []

    async def work(dbx, jid, mid, choice, reuse=None):
        started.append(jid)
    monkeypatch.setattr(mf, "_work", work)
    got = call(db, "catalog_add_maker", {"url": "www.dogus.com.tr", "name": "Doğuş Kalıp", "notes": "molds"})
    (m,) = makers(db)
    assert m["name"] == "Doğuş Kalıp" and m["notes"] == "molds" and m["url"] == "https://www.dogus.com.tr/"
    assert got.say == "Added {name} to the Product Catalog" and not started and not run(mf.jobs(db, 5))
    same = call(db, "catalog_add_maker", {"url": "https://dogus.com.tr/x", "explore": True})
    assert same.say == "{name} is already in the catalog" and len(makers(db)) == 1 and not started
    got = call(db, "catalog_add_maker", {"url": "https://www.robo90.com/", "explore": True})
    (j,) = run(mf.jobs(db, 5))
    assert started == [j["_id"]] and j["kind"] == "site" and got.vars["run"] == j["_id"]
    assert got.say == "Added {name} and started exploring its site" and "100 pages" in got.text
    assert "up to 100 pages" in _tool("catalog_add_maker").description and "costs LLM tokens" in _tool("catalog_add_maker").description
    with pytest.raises(ToolError, match="private or local"):
        call(db, "catalog_add_maker", {"url": "http://inside.example/"})


# ---- rights -------------------------------------------------------------------------

def test_a_viewer_changes_nothing(ws):
    db, web, state = ws
    mid = _maker(db, products=[{"id": "o1", "name": "Siyah PLA", "category": "", "description": "", "specs": {},
                                "sku": "", "url": "", "image": ""}])
    state["role"] = "viewer"
    for name, args in (("catalog_read_page", {"urls": [PAGE]}),
                       ("catalog_add_product", {"manufacturer": mid, "products": [{"name": "x"}]}),
                       ("catalog_edit_product", {"manufacturer": mid, "product": "o1", "set": {"name": "y"}}),
                       ("catalog_remove_product", {"manufacturer": mid, "products": ["o1"]}),
                       ("catalog_add_maker", {"url": "https://www.dogus.com.tr/"})):
        with pytest.raises(ToolError, match="as viewer you cannot"):
            call(db, name, args)
    assert [d["_id"] for d in makers(db)] == [mid] and run(mf.get(db, mid))["products"][0]["name"] == "Siyah PLA"
    assert not run(mf.jobs(db, 5)) and web["seen"] == []
    # the rights are the Product Catalog API's: "draw"
    for m, p in (("POST", "/api/manufacturers"), ("POST", f"/api/manufacturers/{mid}/read-page"),
                 ("POST", f"/api/manufacturers/{mid}/products"), ("DELETE", f"/api/manufacturers/{mid}/products/o1")):
        assert access.action(m, p) == "draw"


# ---- removing asks first, in a real answer --------------------------------------------

@pytest.mark.parametrize("allow", [True, False])
def test_removing_waits_for_a_yes(env, monkeypatch, allow):  # noqa: F811
    raw, state = env
    seed_chat(raw)
    raw[mf.COLL].rows["m1"] = {"_id": "m1", "workspace_id": "default", "name": "Robo90", "domain": "robo90.com",
                               "url": "https://www.robo90.com/", "by": dict(ME), "products": [
                                   {"id": "p1", "name": "Gri PLA", "sku": "R90", "specs": {}}]}
    tool_model(monkeypatch, state, [("", [("catalog_remove_product", {"manufacturer": "m1", "products": ["p1"]})]),
                                    ("Done.", [])])

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="remove the grey PLA from the catalog", client="tab1"))
        step = await until(lambda: next((s for s in (gen_doc(raw) or {}).get("steps") or []
                                         if s["status"] == "ask"), None))
        assert raw[mf.COLL].rows["m1"]["products"]                     # asked, not run
        gen = gen_doc(raw)
        await cc_chat.answer_step("c1", step["id"], cc_chat.StepIn(allow=allow))
        raw[ccgen.GENS].rows[gen["_id"]]["answers"] = {step["id"]: allow}
        await until(lambda: answers(raw))
        async for _ in resp.body_iterator:
            pass
    asyncio.run(go())
    (step,) = answers(raw)[-1]["steps"]
    sent = {t["name"] for t in state["rounds"][0]["tools"]}
    assert {"catalog_read_page", "catalog_add_product", "catalog_remove_product"} <= sent
    assert not {"catalog_edit_product", "catalog_add_maker"} & sent           # off until the person turns them on
    prods = copy.deepcopy(raw[mf.COLL].rows["m1"]["products"])
    if allow:
        assert step["status"] == "done" and prods == []
        assert step["say"] == "Removed {products} from the catalog of {name}"
    else:
        assert step["status"] != "done" and [p["id"] for p in prods] == ["p1"]
