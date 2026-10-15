"""Many things changed at once in Parts: the selection bar's Edit over
products (backend/manufacturers.py `bulk_edit`) and over stock lines
(backend/inventory.py `bulk_edit`), and the way back (backend/bulk_undo.py).

What matters: one call changes products of several makers (My Items too),
each as its single edit would - kept through the next exploration, the
price's history - while what is not edited here (the LCSC drawer) or does
not change is said, not touched; the stock lines' place and minimum go
into each line's log; the audit trail has it; the undo puts back only what
is still as the edit left it, and only for its maker or someone with the
right to delete; the place of a stock line is searched, suggested and said
by the Chat's tools. Everything runs on the tests' fake databases."""

from __future__ import annotations

import pytest

from backend import access, actors, bulk_undo, catalog_lcsc, catalog_own, chat_tools  # noqa: F401 - lcsc registers
from backend import inventory as inv
from backend import manufacturers as mf
from backend.chat_tools import Ctx
from test_parts_trash import ME, YOU, grid, line, run, ws  # noqa: F401 - grid, ws are fixtures
from test_product_files import maker, site  # noqa: F401 - site is a fixture
from test_users_admin import db, person  # noqa: F401 - db is a fixture


def prods(d, mid="m1"):
    return {p["id"]: p for p in run(mf.get(d, mid))["products"]}


def priced(d):
    """p1 with a price in TRY, VAT excluded; p2 without one."""
    run(mf.edit_product(d, "m1", "p1", {"price": "362,60", "currency": "TRY", "vat": "excl"}, ME))


async def _audit(d):
    return [r async for r in d[actors.AUDIT].find({})]


def audit(d):
    return _audit(d)


# ---------------------------------------------------------------- products

def test_one_call_changes_products_of_several_makers_each_as_its_single_edit(ws):
    d, _, _ = ws
    priced(d)
    own = run(catalog_own.add(d, {"name": "PETG black 1 kg", "price": "450", "currency": "TRY"}, ME))
    got = run(mf.bulk_edit(d, [{"manufacturer": "m1", "product": "p1"}, {"manufacturer": "m1", "product": "p2"},
                               {"manufacturer": "own", "product": own["id"]},
                               {"manufacturer": "lcsc", "product": "C25744"},
                               {"manufacturer": "m1", "product": "nope"}],
                           {"category": "Screws", "currency": "usd", "vat": "incl"}, ME))
    assert sorted(c["product"] for c in got["changed"]) == sorted(["p1", "p2", own["id"]])
    assert {s["product"]: s["why"] for s in got["skipped"]} == {"C25744": "not edited here", "nope": "not in the catalog"}
    p = prods(d)
    assert p["p1"]["category"] == p["p2"]["category"] == "Screws"
    # the currency and VAT of a price there is; the amount kept, the change in the price's history
    assert (p["p1"]["price"]["amount"], p["p1"]["price"]["currency"], p["p1"]["price"]["vat"]) == (362.6, "USD", "incl")
    assert p["p1"]["history"][-1]["currency"] == "USD"
    assert not p["p2"].get("price")                                  # no price: only the category
    assert p["p1"]["edited"] and mf.by_hand(p["p2"]) and p["p2"]["edited_by"]["id"] == ME["id"]
    mine = run(catalog_own.products(d))[0]
    assert (mine["category"], mine["price"]["currency"]) == ("Screws", "USD")
    # the same again changes nothing, and says so
    again = run(mf.bulk_edit(d, [{"manufacturer": "m1", "product": "p1"}], {"category": "Screws"}, ME))
    assert (again["changed"], again["unchanged"], again["undo"]) == ([], 1, None)
    rows = run(audit(d))
    assert len(rows) == 1 and rows[0]["target"] == "parts: 3 products" and rows[0]["detail"]["undo"] == got["undo"]


def test_what_to_change_is_checked():
    for bad in ({}, {"currency": "dollars"}, {"vat": "maybe"}, {"name": "x"}):
        with pytest.raises(ValueError):
            mf.bulk_fields(bad)
    assert mf.bulk_fields({"category": "  Hinges  ", "vat": ""}) == {"category": "Hinges", "vat": ""}


def test_the_undo_puts_back_what_is_still_as_the_edit_left_it(ws):
    d, _, _ = ws
    priced(d)
    before = prods(d)
    got = run(mf.bulk_edit(d, [{"manufacturer": "m1", "product": "p1"}, {"manufacturer": "m1", "product": "p2"}],
                           {"category": "Fasteners", "vat": ""}, ME))
    assert prods(d)["p1"]["price"]["vat"] is None
    run(mf.edit_product(d, "m1", "p2", {"name": "UB0229 Vida M3x20 (new)"}, ME))     # changed since by hand
    back = run(mf.bulk_undo_edit(d, got["undo"]))
    assert [r["product"] for r in back["restored"]] == ["p1"]
    assert back["conflict"] == [{"manufacturer": "m1", "product": "p2", "name": "UB0229 Vida M3x20",
                                 "why": "changed since"}]
    now = prods(d)
    assert now["p1"] == before["p1"]                                # whole, as it was
    assert now["p2"]["category"] == "Fasteners" and now["p2"]["name"] == "UB0229 Vida M3x20 (new)"
    with pytest.raises(LookupError):                                # once only
        run(mf.bulk_undo_edit(d, got["undo"]))


def test_someone_elses_undo_needs_the_right_to_delete(ws):
    d, _, state = ws
    got = run(mf.bulk_edit(d, [{"manufacturer": "m1", "product": "p1"}], {"category": "A"}, ME))
    state["who"], state["role"] = YOU, "reviewer"
    with pytest.raises(PermissionError):
        run(mf.bulk_undo_edit(d, got["undo"]))
    state["role"] = "editor"
    assert run(mf.bulk_undo_edit(d, got["undo"]))["restored"]


def test_the_rights_a_bulk_edit_needs():
    for path in ("/api/manufacturers/products/bulk-edit", "/api/manufacturers/products/bulk-undo",
                 "/api/inventory/bulk-edit", "/api/inventory/bulk-undo"):
        act = access.action("POST", path, {})
        assert act == "draw" and not access.allowed("viewer", act) and access.allowed("reviewer", act)
    assert access.action("GET", "/api/inventory/locations", {}) == "view"


# ---------------------------------------------------------------- stock lines

def test_stock_lines_get_one_place_and_minimum_logged_and_undone(ws):
    d, _, _ = ws
    a, b = line(d, pid="p1"), line(d, pid="p2")
    run(inv.patch(d, b, {"location": "Shelf A", "min_stock": 5}, ME))
    got = run(inv.bulk_edit(d, [a, b, "gone"], {"location": "Drawer 3, box B", "min_stock": "2"}, ME))
    assert {c["id"] for c in got["changed"]} == {a, b} and got["skipped"] == [{"id": "gone", "why": "not in stock"}]
    x = run(inv.get(d, a))
    assert (x["location"], x["min_stock"]) == ("Drawer 3, box B", 2)
    assert x["log"][-1]["kind"] == "edited" and x["log"][-1]["changes"]["location"] == ["", "Drawer 3, box B"]
    assert run(audit(d))[-1]["target"] == "stock: 2 lines"
    back = run(inv.bulk_undo_edit(d, got["undo"], ME))
    assert len(back["restored"]) == 2 and not back["conflict"]
    y = run(inv.get(d, b))
    assert (y["location"], y["min_stock"], y["log"][-1]["kind"]) == ("Shelf A", 5, "edited")
    assert (run(inv.get(d, a))["location"], run(inv.get(d, a))["min_stock"]) == ("", None)
    with pytest.raises(ValueError):
        run(inv.bulk_edit(d, [a], {"notes": "x"}, ME))


def test_a_lines_place_is_suggested_searched_and_said_by_the_chat(ws):
    d, _, _ = ws
    a, b = line(d, pid="p1"), line(d, pid="p2", qty=1)
    run(inv.bulk_edit(d, [a], {"location": "Drawer 3, box B"}, ME))
    run(inv.patch(d, b, {"location": "drawer 3,  box b ", "min_stock": 4}, ME))
    assert inv.places(run(inv.everything(d))) == [{"location": "Drawer 3, box B", "lines": 2}]
    assert run(inv.api_locations("box"))[0]["lines"] == 2 and run(inv.api_locations("shelf")) == []
    assert [x["_id"] for x in run(inv.listing(d, q="drawer 3"))] == [a, b]
    tool = chat_tools.tools()
    found = run(tool["inventory_search"].run(Ctx(db=d, actor=ME), {"location": "box b"}))
    assert "Drawer 3, box B" in found.text
    low = run(tool["stock_low"].run(Ctx(db=d, actor=ME), {"location": "drawer 3"}))
    assert "at drawer 3" in low.text.lower() and low.vars["location"] == "drawer 3" and low.vars["n"] == 1
    assert run(tool["stock_low"].run(Ctx(db=d, actor=ME), {"location": "shelf"})).vars["n"] == 0
    assert "location" in tool["stock_low"].schema["properties"]


# ---------------------------------------------------------------- through the API

def test_the_page_edits_and_undoes_through_the_api(db, grid, site):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    mid, (p1, p2) = maker(a, products=({"name": "Hinge", "sku": "H-1"}, {"name": "Latch"}))
    items = [{"manufacturer": mid, "product": p1}, {"manufacturer": mid, "product": p2}]
    r = a.post("/api/manufacturers/products/bulk-edit", json={"items": items, "set": {"category": "Hardware"}})
    assert r.status_code == 200 and len(r.json()["changed"]) == 2
    assert {p["category"] for p in a.get(f"/api/manufacturers/{mid}").json()["products"]} == {"Hardware"}
    assert a.post("/api/manufacturers/products/bulk-edit", json={"items": items, "set": {}}).status_code == 400
    # another space has neither the products nor the undo
    assert b.post("/api/manufacturers/products/bulk-undo", json={"undo": r.json()["undo"]}).status_code == 404
    assert len(a.post("/api/manufacturers/products/bulk-undo", json={"undo": r.json()["undo"]}).json()["restored"]) == 2
    assert {p.get("category", "") for p in a.get(f"/api/manufacturers/{mid}").json()["products"]} == {""}
    i = a.post("/api/inventory", json={"name": "Hinge", "quantity": 2, "catalog": {"manufacturer": mid, "product": p1}}).json()
    s = a.post("/api/inventory/bulk-edit", json={"ids": [i["item"]["id"]], "set": {"location": "Bin 4"}}).json()
    assert a.get("/api/inventory/locations").json() == [{"location": "Bin 4", "lines": 1}]
    assert a.get("/api/inventory?location=bin").json()[0]["location"] == "Bin 4"
    a.post("/api/inventory/bulk-undo", json={"undo": s["undo"]})
    assert a.get("/api/inventory/locations").json() == []
    assert bulk_undo.KEEP_HOURS == 24
