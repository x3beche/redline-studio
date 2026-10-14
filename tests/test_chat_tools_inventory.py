"""The Chat's tools for the Inventory tab (backend/chat_tools: inventory_search,
inventory_read, inventory_add, inventory_adjust, inventory_edit,
inventory_remove).

What matters: they read and write the asker's workspace with the rights the
Inventory API needs; adding the same thing again tops it up and says so,
and an item can come with its Product Catalog product or LCSC part; a
quantity changes only with a reason and never below zero; removing is a
delete-level tool, so nothing goes before the person says yes.
Everything runs on the tests' fake databases; no model is reached.
"""

from __future__ import annotations

import asyncio
import copy

import pytest

from backend import access, actors, cc_chat, ccgen, chat_tools, lcsc, scope
from backend import inventory as inv
from backend.chat_tools import Ctx, ToolError
from test_telegram import FakeDb
from tests.test_cc_generation import answers, gen_doc, until
from tests.test_cc_mentions_live_search import Coll, env, match, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import run, tool_model

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}
NAMES = ("inventory_search", "inventory_read", "inventory_add", "inventory_adjust", "inventory_edit", "inventory_remove")


def _tool(name):
    return chat_tools.tools()[name]


@pytest.fixture
def ws(monkeypatch):
    """A workspace's database as the tools get it, and who is asking."""
    fake = FakeDb()
    state = {"role": "reviewer", "who": ME}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    return scope.ScopedDb(fake, "default"), fake, state


def call(db, name, args, actor=ME):
    return run(_tool(name).run(Ctx(db=db, actor=actor), args))


def test_the_tools_are_in_their_package_at_their_levels():
    got = {n: (t.package, t.level, t.default) for n, t in chat_tools.tools().items() if n in NAMES}
    assert got == {"inventory_search": ("mfr", "read", True), "inventory_read": ("mfr", "read", True),
                   "inventory_add": ("mfr", "change", True), "inventory_adjust": ("mfr", "change", True),
                   "inventory_edit": ("mfr", "change", False), "inventory_remove": ("mfr", "delete", True)}
    # Stock is a part of the Parts page, not a tab of its own: its tools are the Parts package's, after the catalog's.
    assert "inventory" not in chat_tools.PACKAGE and chat_tools.PACKAGE["mfr"].label == "Parts"
    order = list(chat_tools.tools())
    assert order.index("catalog_read_page") < order.index("inventory_search") < order.index("inventory_remove")
    tabs = open("frontend/src/app/workspaces.ts", encoding="utf-8").read()
    assert "id: 'mfr'" in tabs and "id: 'inventory'" not in tabs
    for n in NAMES:
        assert n in chat_tools.SYSTEM_NOTE


def test_their_sentences_are_in_turkish_too():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()
    for n in NAMES:
        t = _tool(n)
        for s in (t.label, t.about, t.running, t.failed):
            assert f"'{s}':" in tr or f'"{s}":' in tr, (n, s)
        assert f"{n}:" in icons, n
    for s in ("Parts", "Found {n} items on hand",
              "Nothing on hand matches {q}", "Nothing is in stock yet", "Read the stock of {name}",
              "Topped up {name} in stock", "Added {name} to stock",
              "Added {n} lines to stock ({m} merged)", "{name}: {change}, now {now}",
              "Changed {fields} of {name}", "Removed {names} from stock"):
        assert f"'{s}':" in tr, s


def test_add_tops_up_what_is_kept_and_says_which(ws):
    db, fake, _ = ws
    run(inv.add(db, {"name": "M3 nut", "quantity": 100, "location": "A1"}, YOU))
    got = call(db, "inventory_add", {"items": [{"name": "m3 nut", "quantity": 50},
                                               {"name": "M3 washer", "quantity": 80, "location": "A2"},
                                               {"name": "", "quantity": 3}], "reason": "order 1043 arrived"})
    assert got.say == "Added {n} lines to stock ({m} merged)" and got.vars["n"] == 2 and got.vars["m"] == 1
    assert "1 added, 1 merged into lines already kept, 1 not added" in got.text
    assert "merged into the stock line already kept" in got.text and "+50, now 150 pcs at A1" in got.text
    assert "added new stock line" in got.text and "NOT added" in got.text
    rows = {d["name"]: d for d in run(inv.everything(db))}
    assert rows["M3 nut"]["quantity"] == 150 and rows["M3 nut"]["log"][-1]["reason"] == "order 1043 arrived"
    assert rows["M3 washer"]["by"]["id"] == ME["id"]
    one = call(db, "inventory_add", {"items": [{"name": "M3 washer", "quantity": 1}]})
    assert one.say == "Topped up {name} in stock" and one.vars["name"] == "M3 washer"
    with pytest.raises(ToolError, match="nothing was added"):
        call(db, "inventory_add", {"items": [{"name": "x", "quantity": -1}]})
    with pytest.raises(ToolError, match="give `items`"):
        call(db, "inventory_add", {})
    # Everything written is this workspace's.
    assert {d["workspace_id"] for d in fake["inventory"].docs.values()} == {"default"}


def test_add_links_a_catalog_product_or_an_lcsc_part(ws, monkeypatch):
    db, _, _ = ws
    run(db["manufacturers"].insert_one({"_id": "dogus", "name": "Doğuş", "products": [
        {"id": "p1", "name": "Menteşe 20", "sku": "MN-20", "url": "https://dogus.example/mn20"}]}))

    async def holds(db_, c, ws=None):
        return {"_id": c, "name": "IRL540N TO-220"} if c == "C111607" else None
    monkeypatch.setattr(lcsc, "holds", holds)

    async def known(db_):
        return [{"lcsc": "C111607", "name": "IRL540N TO-220", "mpn": "IRL540N", "group": "Discretes", "branch": "MOSFETs"}]
    monkeypatch.setattr(lcsc, "known", known)
    got = call(db, "inventory_add", {"items": [{"quantity": 4, "catalog": {"manufacturer": "dogus", "product": "p1"},
                                                "location": "Shelf A"},
                                               {"quantity": 10, "lcsc": "c111607"}]})
    assert got.vars["n"] == 2
    # Each line names the Parts product it counts: the site's, and the drawer's part the LCSC number names.
    assert "counts the Parts product Doğuş / Menteşe 20 [dogus:p1]" in got.text
    assert "[lcsc:C111607]" in got.text and "made in My Items" not in got.text
    rows = {d["name"]: d for d in run(inv.everything(db))}
    hinge, fet = rows["Menteşe 20"], rows["IRL540N TO-220"]
    assert hinge["catalog"]["product_name"] == "Menteşe 20" and hinge["mpn"] == "MN-20" and hinge["manufacturer"] == "Doğuş"
    assert fet["lcsc"] == "C111607" and fet["catalog"]["manufacturer"] == "lcsc"
    read = call(db, "inventory_read", {"item": "mentese"})
    assert "Parts product: Doğuş / Menteşe 20  https://dogus.example/mn20  (id dogus:p1)" in read.text
    assert "https://www.lcsc.com/product-detail/C111607.html" in call(db, "inventory_read", {"item": fet["_id"]}).text
    with pytest.raises(ToolError, match="no product"):
        call(db, "inventory_add", {"items": [{"name": "x", "quantity": 1, "catalog": {"manufacturer": "dogus",
                                                                                      "product": "nope"}}]})


def test_a_thing_no_site_sells_becomes_an_own_item(ws):
    db, _, _ = ws
    got = call(db, "inventory_add", {"items": [{"name": "PETG black 1 kg", "quantity": 2, "unit": "roll",
                                                "category": "Filament", "location": "Cabinet"}]})
    assert "made in My Items" in got.text and "[own:" in got.text
    line = run(inv.everything(db))[0]
    assert line["catalog"]["manufacturer"] == "own" and line["catalog"]["product_name"] == "PETG black 1 kg"
    # Again, by its name: the same My Items product, topped up - no second product, no second line.
    again = call(db, "inventory_add", {"items": [{"name": "petg black 1 KG", "quantity": 1, "unit": "roll"}]})
    assert again.vars["name"] == "PETG black 1 kg" and "merged" in again.text
    assert len(run(inv.everything(db))) == 1
    # What it is belongs to the product: inventory_edit says where to change it.
    with pytest.raises(ToolError, match="catalog_edit_product"):
        call(db, "inventory_edit", {"item": line["_id"], "set": {"name": "PETG"}})
    # The catalog tools reach My Items by its name.
    edited = call(db, "catalog_edit_product", {"manufacturer": "My Items", "product": "petg",
                                               "set": {"sku": "PETG-BK-1"}})
    assert "PETG-BK-1" in edited.text


def test_search_and_read(ws):
    db, _, _ = ws
    empty = call(db, "inventory_search", {})
    assert empty.say == "Nothing is in stock yet"
    for raw in ({"name": "ESP32-C3 module", "quantity": 2, "min_stock": 5, "location": "Shelf B", "category": "Modules"},
                {"name": "PLA filament", "quantity": 3, "unit": "roll", "location": "Cabinet", "category": "Filament"}):
        run(inv.add(db, raw, ME))
    got = call(db, "inventory_search", {})
    assert got.say == "Found {n} items on hand" and got.vars == {"n": 2}
    assert "\"ESP32-C3 module\"  2 pcs  at Shelf B  LOW (minimum 5)" in got.text and "3 roll  at Cabinet" in got.text
    low = call(db, "inventory_search", {"low": True})
    assert low.vars == {"n": 1} and "PLA" not in low.text
    none = call(db, "inventory_search", {"query": "stepper"})
    assert none.say == "Nothing on hand matches {q}" and "Categories: Filament, Modules" in none.text
    run(inv.adjust(db, run(inv.everything(db))[0]["_id"], -1, "a prototype", ME))
    read = call(db, "inventory_read", {"item": "esp32"})
    assert read.say == "Read the stock of {name}" and "adjusted -1 -> 1 by Me: a prototype" in read.text
    with pytest.raises(ToolError, match="no stock line"):
        call(db, "inventory_read", {"item": "nothing like it"})


def test_adjust_needs_a_reason_and_stops_at_zero(ws):
    db, _, _ = ws
    d, _ = run(inv.add(db, {"name": "Fan 40mm", "quantity": 6, "min_stock": 2}, ME))
    got = call(db, "inventory_adjust", {"item": "fan", "change": -4, "reason": "used 4 for the fan board"})
    assert got.say == "{name}: {change}, now {now}" and got.vars["change"] == "-4" and got.vars["now"] == "2 pcs"
    assert "LOW" in got.text
    assert run(inv.get(db, d["_id"]))["log"][-1]["reason"] == "used 4 for the fan board"
    with pytest.raises(ToolError, match="reason"):
        call(db, "inventory_adjust", {"item": "fan", "change": 1})
    with pytest.raises(ToolError, match="only 2 pcs on hand"):
        call(db, "inventory_adjust", {"item": "fan", "change": -5, "reason": "x"})


def test_edit_changes_fields_but_not_the_quantity(ws):
    db, _, _ = ws
    d, _ = run(inv.add(db, {"name": "Fan 40mm", "quantity": 6}, ME))
    got = call(db, "inventory_edit", {"item": d["_id"], "set": {"location": "Drawer 3", "tags": ["fans"]}})
    assert got.say == "Changed {fields} of {name}" and got.vars["fields"] == "location, tags"
    assert run(inv.get(db, d["_id"]))["location"] == "Drawer 3"
    with pytest.raises(ToolError, match="inventory_adjust"):
        call(db, "inventory_edit", {"item": d["_id"], "set": {"quantity": 1}})
    with pytest.raises(ToolError, match="no field"):
        call(db, "inventory_edit", {"item": d["_id"], "set": {"colour": "red"}})
    with pytest.raises(ToolError, match="belong to the Parts product"):
        call(db, "inventory_edit", {"item": d["_id"], "set": {"name": ""}})


def test_a_viewer_reads_but_changes_nothing(ws):
    db, _, state = ws
    d, _ = run(inv.add(db, {"name": "Fan 40mm", "quantity": 6}, ME))
    state["role"] = "viewer"
    assert call(db, "inventory_search", {}).vars == {"n": 1}
    for name, args in (("inventory_add", {"items": [{"name": "x", "quantity": 1}]}),
                       ("inventory_adjust", {"item": d["_id"], "change": 1, "reason": "x"}),
                       ("inventory_edit", {"item": d["_id"], "set": {"location": "y"}}),
                       ("inventory_remove", {"items": [d["_id"]]})):
        with pytest.raises(ToolError, match="as viewer you cannot"):
            call(db, name, args)
    assert [x["quantity"] for x in run(inv.everything(db))] == [6]


def test_remove_keeps_someone_elses_item_to_those_who_may_delete(ws):
    db, _, state = ws
    theirs, _ = run(inv.add(db, {"name": "Their scope", "quantity": 1}, YOU))
    mine, _ = run(inv.add(db, {"name": "My meter", "quantity": 1}, ME))
    with pytest.raises(ToolError, match="added by You"):
        call(db, "inventory_remove", {"items": [mine["_id"], theirs["_id"]]})
    assert len(run(inv.everything(db))) == 2                  # nothing went, not even one's own
    got = call(db, "inventory_remove", {"items": ["my meter"]})
    assert got.say == "Removed {names} from stock" and got.vars["names"] == "My meter"
    state["role"] = "editor"
    call(db, "inventory_remove", {"items": [theirs["_id"]]})
    assert run(inv.everything(db)) == []


# ---- removing asks first, in a real answer --------------------------------------------

@pytest.fixture
def writes(monkeypatch):
    """What the chat tests' stand-in database lacks for the inventory."""
    async def count_documents(self, query=None, **kw):
        return sum(1 for r in self.rows.values() if match(r, query or {}))

    async def delete_one(self, query, **kw):
        for k, r in list(self.rows.items()):
            if match(r, query):
                del self.rows[k]
                return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()
    monkeypatch.setattr(Coll, "count_documents", count_documents, raising=False)
    monkeypatch.setattr(Coll, "delete_one", delete_one, raising=False)


def _seed(raw):
    raw["inventory"].rows["i1"] = {"_id": "i1", "workspace_id": "default", "name": "Old relay", "quantity": 3,
                                   "unit": "pcs", "by": dict(ME), "log": []}


@pytest.mark.parametrize("allow", [True, False])
def test_removing_waits_for_a_yes(env, writes, monkeypatch, allow):
    raw, state = env
    seed_chat(raw)
    _seed(raw)
    tool_model(monkeypatch, state, [("", [("inventory_remove", {"items": ["i1"]})]), ("Done.", [])])

    async def go():
        resp = await cc_chat.say("c1", cc_chat.SayIn(text="remove the old relay", client="tab1"))
        step = await until(lambda: next((s for s in (gen_doc(raw) or {}).get("steps") or []
                                         if s["status"] == "ask"), None))
        assert "i1" in raw["inventory"].rows                       # asked, not run
        gen = gen_doc(raw)
        await cc_chat.answer_step("c1", step["id"], cc_chat.StepIn(allow=allow))
        # (the stand-in database keeps dotted keys flat: the runner's read is set here)
        raw[ccgen.GENS].rows[gen["_id"]]["answers"] = {step["id"]: allow}
        await until(lambda: answers(raw))
        async for _ in resp.body_iterator:
            pass
    asyncio.run(go())
    (step,) = answers(raw)[-1]["steps"]
    sent = {t["name"] for t in state["rounds"][0]["tools"]}
    assert {"inventory_search", "inventory_add", "inventory_adjust", "inventory_remove"} <= sent
    assert "inventory_edit" not in sent                             # off until the person turns it on
    if allow:
        assert step["status"] == "done" and "i1" not in raw["inventory"].rows
        assert step["say"] == "Removed {names} from stock"
    else:
        assert step["status"] != "done" and copy.deepcopy(raw["inventory"].rows["i1"])["quantity"] == 3


def _catalog(db):
    run(db["manufacturers"].insert_one({"_id": "dogus", "name": "Doğuş Kalıp", "domain": "dogus.com.tr",
                                        "url": "https://www.dogus.com.tr", "products": [
        {"id": "p1", "name": "Menteşe 20 mm", "sku": "MN-20", "category": "Bağlantı"},
        {"id": "p2", "name": "Menteşe 40 mm", "sku": "MN-40", "category": "Bağlantı"}]}))


def test_add_takes_a_catalog_product_by_words_and_the_catalog_shows_the_stock(ws):
    db, _, _ = ws
    _catalog(db)
    with pytest.raises(ToolError, match="no product"):         # "hinge" is in no product: said, nothing kept
        call(db, "inventory_add", {"items": [{"quantity": 20, "catalog": {"manufacturer": "Doğuş Kalıp",
                                                                          "product": "20 mm hinge"}}]})
    got = call(db, "inventory_add", {"items": [{"quantity": 20, "location": "shelf B",
                                                "catalog": {"manufacturer": "dogus", "product": "menteşe 20"}},
                                               {"quantity": 1, "catalog": {"manufacturer": "dogus", "product": "menteşe"}}]})
    assert "added new stock line" in got.text and "counts the Parts product Doğuş Kalıp / Menteşe 20 mm" in got.text
    assert "NOT added" in got.text and "p1 Menteşe 20 mm" in got.text      # several fit: the ids, to ask again with
    (item,) = run(inv.everything(db))
    assert (item["name"], item["mpn"], item["category"], item["location"]) == ("Menteşe 20 mm", "MN-20", "Bağlantı", "shelf B")
    again = call(db, "inventory_add", {"items": [{"quantity": 5, "catalog": {"manufacturer": "dogus", "product": "p1"}}]})
    assert again.say == "Topped up {name} in stock" and "now 25 pcs" in again.text
    # The catalog, as the model reads it: each product's id and what is on hand of it.
    found = call(db, "manufacturer_search", {"query": "menteşe"})
    assert "- Doğuş Kalıp (dogus): [p1] Menteşe 20 mm" in found.text and "[in stock: 25 pcs]" in found.text
    assert "[p2] Menteşe 40 mm" in found.text and found.text.count(" pcs]") == 1
    whole = call(db, "manufacturer_search", {"manufacturer": "dogus"})
    assert "- [p1] Menteşe 20 mm" in whole.text and "[in stock: 25 pcs]" in whole.text
    assert "manufacturer_search" in chat_tools.SYSTEM_NOTE and "what is in stock" in chat_tools.SYSTEM_NOTE
