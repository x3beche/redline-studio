"""The inventory (backend/inventory.py): what is on hand, kept per
workspace - items with a quantity in a unit and a place, part numbers and
links to the Product Catalog and LCSC, a minimum below which they are low,
and a log of every quantity change with who and why. Adding the same thing
again tops it up instead of doubling it; a file of items goes out and
comes back in the same way.

Everything runs on the tests' fake database; nothing real is reached."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from backend import access, actors, scope
from backend import inventory as inv
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401  (the fixture)

ME = {"id": "me", "name": "Me", "type": "user"}


def run(c):
    return asyncio.run(c)


# ---------------------------------------------------------------- the store

def test_fields_are_cleaned_and_checked():
    f = inv.clean({"name": "  M3x8   screw ", "quantity": "2,5", "unit": "Adet", "currency": "tl", "lcsc": "c25744",
                   "tags": "#mech, fasteners  mech", "min_stock": ""})
    assert f["name"] == "M3x8 screw" and f["quantity"] == 2.5 and f["unit"] == "pcs"
    assert f["currency"] == "TRY" and f["lcsc"] == "C25744" and f["tags"] == ["mech", "fasteners"]
    assert f["min_stock"] is None and f["price"] is None and f["catalog"] is None
    assert inv.unit_of("Meters") == "m" and inv.unit_of("") == "pcs" and inv.unit_of("spool") == "spool"
    for bad in ({"name": "", "quantity": 1}, {"name": "x", "quantity": -1}, {"name": "x", "quantity": "lots"},
                {"name": "x", "quantity": float("inf")}, {"name": "x", "lcsc": "12345"},
                {"name": "x", "currency": "dollars"}, {"name": "x", "quantity": True}):
        with pytest.raises(ValueError):
            inv.clean(bad)
    # A change names only what it changes.
    assert inv.clean({"location": "Shelf B"}, partial=True) == {"location": "Shelf B"}


def test_adding_the_same_thing_again_tops_it_up():
    fake = FakeDb()
    a, merged = run(inv.add(fake, {"name": "IRL540N", "quantity": 10, "mpn": "IRL540NPBF", "location": "Bin 4"}, ME))
    assert not merged and a["quantity"] == 10 and a["log"][0]["kind"] == "added"
    # The same MPN under another name: merged, its empty fields filled.
    b, merged = run(inv.add(fake, {"name": "MOSFET N 100V", "quantity": 5, "mpn": "irl540npbf", "lcsc": "C111607",
                                   "category": "MOSFETs"}, ME, "order 1043"))
    assert merged and b["_id"] == a["_id"] and b["quantity"] == 15 and b["name"] == "IRL540N"
    assert b["lcsc"] == "C111607" and b["category"] == "MOSFETs" and b["location"] == "Bin 4"
    assert b["log"][-1] | {"id": "", "at": ""} == {"id": "", "at": "", "by": {"id": "me", "name": "Me"}, "kind": "merged",
                                                  "delta": 5.0, "after": 15.0, "reason": "order 1043",
                                                  "filled": ["category", "lcsc"]}
    # The same name in the same unit: merged; in another unit: a thing of its own.
    _, merged = run(inv.add(fake, {"name": "Heat shrink 3mm", "quantity": 2, "unit": "m"}, ME))
    c, merged = run(inv.add(fake, {"name": "heat shrink 3MM", "quantity": 1.5, "unit": "meters"}, ME))
    assert merged and c["quantity"] == 3.5
    d, merged = run(inv.add(fake, {"name": "Heat shrink 3mm", "quantity": 1, "unit": "roll"}, ME))
    assert not merged and d["_id"] != c["_id"]
    # Different MPNs under one name are different things.
    _, merged = run(inv.add(fake, {"name": "IRL540N", "quantity": 1, "mpn": "OTHER-1"}, ME))
    assert not merged
    # Asked not to merge: a new one.
    _, merged = run(inv.add(fake, {"name": "IRL540N", "quantity": 1, "mpn": "IRL540NPBF"}, ME, merge=False))
    assert not merged
    assert len(fake["inventory"].docs) == 5


def test_several_at_once_say_which_were_merged_and_which_failed():
    fake = FakeDb()
    run(inv.add(fake, {"name": "M3 nut", "quantity": 100}, ME))
    got = run(inv.add_many(fake, [{"name": "M3 nut", "quantity": 50}, {"name": "M3 washer", "quantity": 80},
                                  {"name": "", "quantity": 1}, {"name": "m3 WASHER", "quantity": 20}], ME))
    assert [r.get("merged") for r in got] == [True, False, None, True]
    assert got[2]["error"] == "an item needs a name"
    assert sorted((d["name"], d["quantity"]) for d in fake["inventory"].docs.values()) == [("M3 nut", 150),
                                                                                          ("M3 washer", 100)]


def test_a_quantity_changes_with_a_reason_and_never_below_zero():
    fake = FakeDb()
    a, _ = run(inv.add(fake, {"name": "Fan 40mm", "quantity": 6, "min_stock": 3}, ME))
    a = run(inv.adjust(fake, a["_id"], -4, "used 4 for the fan board", ME))
    assert a["quantity"] == 2 and inv.is_low(a)
    line = a["log"][-1]
    assert (line["kind"], line["delta"], line["after"], line["reason"], line["by"]["name"]) == \
        ("adjusted", -4.0, 2.0, "used 4 for the fan board", "Me")
    with pytest.raises(ValueError, match="only 2 pcs on hand"):
        run(inv.adjust(fake, a["_id"], -3, "x", ME))
    with pytest.raises(ValueError, match="zero"):
        run(inv.adjust(fake, a["_id"], 0, "x", ME))
    assert run(inv.adjust(fake, "nope", 1, "x", ME)) is None
    # A quantity set by hand is a change like any other, with its difference.
    a = run(inv.patch(fake, a["_id"], {"quantity": 10, "location": "Drawer 2"}, ME, "counted again"))
    kinds = [(x["kind"], x.get("delta"), x.get("fields")) for x in a["log"][-2:]]
    assert kinds == [("adjusted", 8.0, None), ("edited", None, ["location"])]
    assert a["log"][-1]["changes"] == {"location": ["", "Drawer 2"]} and not inv.is_low(a)


def test_the_log_keeps_the_newest():
    fake = FakeDb()
    a, _ = run(inv.add(fake, {"name": "Solder", "quantity": 1000, "unit": "g"}, ME))
    for i in range(inv.MAX_LOG + 5):
        a = run(inv.adjust(fake, a["_id"], -1, f"joint {i}", ME))
    assert len(a["log"]) == inv.MAX_LOG and a["log"][-1]["reason"] == f"joint {inv.MAX_LOG + 4}"


def test_search_filters_and_figures():
    fake = FakeDb()
    for raw in ({"name": "Menteşe 20mm", "quantity": 4, "category": "Hardware", "location": "Shelf A / box 2",
                 "price": 12.5, "currency": "TRY"},
                {"name": "ESP32-C3 module", "quantity": 2, "category": "Modules", "location": "Shelf B", "min_stock": 5,
                 "price": 3, "currency": "USD", "tags": ["wifi"]},
                {"name": "PLA filament", "quantity": 0, "unit": "roll", "category": "Filament", "min_stock": 1}):
        run(inv.add(fake, raw, ME))
    names = lambda **kw: [d["name"] for d in run(inv.listing(fake, **kw))]  # noqa: E731
    assert names() == ["ESP32-C3 module", "Menteşe 20mm", "PLA filament"]
    assert names(q="mentese") == ["Menteşe 20mm"]               # Turkish letters fold
    assert names(q="wifi esp") == ["ESP32-C3 module"]           # tags count, every word must be there
    assert names(category="hardware") == ["Menteşe 20mm"]
    assert names(location="shelf") == ["ESP32-C3 module", "Menteşe 20mm"]
    assert names(low=True) == ["ESP32-C3 module", "PLA filament"]
    st = inv.stats(run(inv.everything(fake)))
    assert st["items"] == 3 and st["low"] == 2 and st["out"] == 1
    assert st["value"] == {"TRY": 50.0, "USD": 6.0} and st["units"] == {"pcs": 6.0, "roll": 0.0}
    assert st["categories"] == ["Filament", "Hardware", "Modules"]


def test_a_catalog_link_must_point_at_a_product_of_the_workspace():
    fake = FakeDb()
    run(fake["manufacturers"].insert_one({"_id": "dogus", "name": "Doğuş", "url": "https://dogus.example",
                                          "products": [{"id": "p1", "name": "Menteşe 20", "sku": "MN-20",
                                                        "url": "https://dogus.example/mn20"}]}))
    a, _ = run(inv.add(fake, {"name": "Hinge", "quantity": 4, "catalog": {"manufacturer": "dogus", "product": "p1"}}, ME))
    assert a["catalog"] == {"manufacturer": "dogus", "manufacturer_name": "Doğuş", "product": "p1",
                            "product_name": "Menteşe 20", "url": "https://dogus.example/mn20", "sku": "MN-20"}
    assert a["manufacturer"] == "Doğuş" and a["mpn"] == "MN-20"
    with pytest.raises(ValueError, match="no product"):
        run(inv.add(fake, {"name": "x", "quantity": 1, "catalog": {"manufacturer": "dogus", "product": "zz"}}, ME))
    with pytest.raises(ValueError, match="no manufacturer"):
        run(inv.add(fake, {"name": "x", "quantity": 1, "catalog": {"manufacturer": "nobody"}}, ME))


def test_export_and_import_round_trip():
    fake = FakeDb()
    run(inv.add(fake, {"name": "M3 nut", "quantity": 100, "location": "A1", "tags": ["mech"]}, ME))
    run(inv.add(fake, {"name": "LED red", "quantity": 30, "lcsc": "C2286", "price": 0.01, "currency": "USD"}, ME))
    data = inv.export_doc(run(inv.listing(fake)))
    assert data["format"] == inv.FORMAT and len(data["items"]) == 2
    assert "log" not in data["items"][0] and "by" not in data["items"][0]
    other = FakeDb()
    got = run(inv.import_doc(other, data, ME))
    assert (got["added"], got["merged"], got["skipped"]) == (2, 0, [])
    # Again: the same things, topped up.
    got = run(inv.import_doc(other, data, ME))
    assert (got["added"], got["merged"]) == (0, 2)
    assert sorted(d["quantity"] for d in other["inventory"].docs.values()) == [60, 200]
    assert all(d["log"][-1]["reason"] == "imported from a file" for d in other["inventory"].docs.values())
    for bad in ({}, {"format": "redline-taste"}, {"format": inv.FORMAT, "version": 9, "items": [{}]},
                {"format": inv.FORMAT, "items": []}):
        with pytest.raises(ValueError):
            run(inv.import_doc(other, bad, ME))
    # A catalog link to nothing here is dropped, not fatal.
    got = run(inv.import_doc(other, {"format": inv.FORMAT, "items": [
        {"name": "Hinge", "quantity": 1, "catalog": {"manufacturer": "gone", "product": "p"}}]}, ME))
    assert got["added"] == 1 and got["items"][0]["catalog"] is None


# ---------------------------------------------------------------- the API, per workspace

def test_an_item_from_start_to_finish(db):  # noqa: F811
    a = person(db, "a")
    r = a.post("/api/inventory", json={"name": "Fan 40mm", "quantity": 6, "location": "Shelf C", "min_stock": 2}).json()
    assert r["merged"] is False and r["item"]["by"]["id"] == "a" and r["item"]["low"] is False
    iid = r["item"]["id"]
    r = a.post("/api/inventory", json={"name": "fan 40MM", "quantity": 2}).json()
    assert r["merged"] is True and r["item"]["id"] == iid and r["item"]["quantity"] == 8
    it = a.post(f"/api/inventory/{iid}/adjust", json={"delta": -7, "reason": "fan boards"}).json()
    assert it["quantity"] == 1 and it["low"] is True and it["log"][0]["reason"] == "fan boards"   # newest first
    assert a.post(f"/api/inventory/{iid}/adjust", json={"delta": -5}).status_code == 400
    it = a.patch(f"/api/inventory/{iid}", json={"category": "Fans", "price": "1.5", "currency": "usd"}).json()
    assert (it["category"], it["price"], it["currency"], it["value"]) == ("Fans", 1.5, "USD", 1.5)
    assert a.patch(f"/api/inventory/{iid}", json={"name": ""}).status_code == 400
    it = a.patch(f"/api/inventory/{iid}", json={"price": None}).json()              # cleared
    assert it["price"] is None and it["value"] is None
    assert [x["id"] for x in a.get("/api/inventory?q=fan").json()] == [iid]
    assert a.get("/api/inventory?low=true").json()[0]["id"] == iid
    assert a.get("/api/inventory?category=nothing").json() == []
    listed = a.get("/api/inventory").json()[0]
    assert "log" not in listed and listed["last"]["kind"] == "edited"
    assert a.get("/api/inventory/stats").json()["low"] == 1
    assert a.get(f"/api/inventory/{iid}").json()["name"] == "Fan 40mm"
    assert a.post("/api/inventory", json={"name": "x", "quantity": -1}).status_code == 400
    assert a.post("/api/inventory", json={"quantity": 1}).status_code == 422
    assert a.delete(f"/api/inventory/{iid}").json() == {"deleted": iid}
    assert a.get(f"/api/inventory/{iid}").status_code == 404


def test_bulk_add_bulk_delete_export_import(db):  # noqa: F811
    a = person(db, "a")
    r = a.post("/api/inventory/bulk", json={"items": [{"name": "M3 nut", "quantity": 10}, {"name": "M3 nut", "quantity": 5},
                                                      {"name": "", "quantity": 1}]}).json()["results"]
    assert [x.get("merged") for x in r] == [False, True, None] and r[2]["error"]
    file = a.get("/api/inventory/export").json()
    assert [x["quantity"] for x in file["items"]] == [15]
    got = a.post("/api/inventory/import", json=file).json()
    assert got["merged"] == 1 and got["items"][0]["quantity"] == 30
    assert a.post("/api/inventory/import", json={"format": "nope"}).status_code == 400
    ids = [x["id"] for x in a.get("/api/inventory").json()]
    assert a.post("/api/inventory/bulk-delete", json={"ids": ids + ["nope"]}).json() == {"deleted": ids}
    assert a.get("/api/inventory").json() == []


def test_each_workspace_has_its_own(db):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    iid = a.post("/api/inventory", json={"name": "mine", "quantity": 1}).json()["item"]["id"]
    assert b.get("/api/inventory").json() == []
    assert b.get(f"/api/inventory/{iid}").status_code == 404
    assert b.patch(f"/api/inventory/{iid}", json={"name": "taken"}).status_code == 404
    assert b.post(f"/api/inventory/{iid}/adjust", json={"delta": 5}).status_code == 404
    assert b.delete(f"/api/inventory/{iid}").status_code == 404
    assert b.post("/api/inventory/bulk-delete", json={"ids": [iid]}).json() == {"deleted": []}
    assert b.get("/api/inventory/export").json()["items"] == []
    # The same name in b's space is b's own thing, not a's topped up.
    assert b.post("/api/inventory", json={"name": "mine", "quantity": 1}).json()["merged"] is False
    assert a.get(f"/api/inventory/{iid}").json()["quantity"] == 1
    ws = {d["workspace_id"] for d in db["inventory"].docs.values()}
    assert len(ws) == 2 and "inventory" in scope.SCOPED


# ---------------------------------------------------------------- who may

def test_reading_is_looking_writing_is_drawing():
    for m, p in (("POST", "/api/inventory"), ("POST", "/api/inventory/bulk"), ("POST", "/api/inventory/import"),
                 ("POST", "/api/inventory/bulk-delete"), ("PATCH", "/api/inventory/i1"),
                 ("POST", "/api/inventory/i1/adjust"), ("DELETE", "/api/inventory/i1")):
        assert not access.page_allowed(m, p), (m, p)
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))
    for p in ("/api/inventory", "/api/inventory/i1", "/api/inventory/stats", "/api/inventory/export"):
        assert access.page_allowed("GET", p) and access.allowed("viewer", access.action("GET", p))


def test_someone_elses_item_is_deleted_only_with_the_right(monkeypatch):
    fake = FakeDb()
    doc, _ = run(inv.add(fake, {"name": "theirs", "quantity": 1}, {"id": "x", "name": "X"}))
    mine, _ = run(inv.add(fake, {"name": "mine", "quantity": 1}, ME))
    monkeypatch.setattr(inv, "_db", lambda: fake)
    monkeypatch.setattr(actors, "current", lambda: ME)
    monkeypatch.setattr(access, "current", lambda: "reviewer")
    for call in (lambda: inv.api_delete(doc["_id"]), lambda: inv.api_bulk_delete(inv.IdsIn(ids=[mine["_id"], doc["_id"]]))):
        with pytest.raises(HTTPException) as e:
            run(call())
        assert e.value.status_code == 403
    assert len(fake["inventory"].docs) == 2                 # nothing went, not even one's own
    assert run(inv.api_delete(mine["_id"])) == {"deleted": mine["_id"]}
    monkeypatch.setattr(access, "current", lambda: "editor")
    assert run(inv.api_delete(doc["_id"])) == {"deleted": doc["_id"]}


# ---------------------------------------------------------------- from the Product Catalog

def _catalog(db_):
    run(db_["manufacturers"].insert_one({"_id": "dogus", "name": "Doğuş Kalıp", "domain": "dogus.com.tr",
                                         "url": "https://www.dogus.com.tr", "products": [
        {"id": "p1", "name": "Menteşe 20 mm", "sku": "MN-20", "category": "Bağlantı", "url": "https://dogus.example/mn20"},
        {"id": "p2", "name": "Menteşe 40 mm", "sku": "MN-40", "category": "Bağlantı"},
        {"id": "p3", "name": "Rulman 608", "sku": "608ZZ", "category": "Rulman"}]}))


def test_a_catalog_product_goes_into_stock_once_and_is_topped_up_after():
    fake = FakeDb()
    _catalog(fake)
    a, merged = run(inv.from_catalog(fake, "dogus", "p1", 20, "", "Shelf B", "for the lids", ME))
    assert not merged and (a["name"], a["mpn"], a["category"], a["manufacturer"], a["location"], a["notes"]) == \
        ("Menteşe 20 mm", "MN-20", "Bağlantı", "Doğuş Kalıp", "Shelf B", "for the lids")
    assert a["catalog"] == {"manufacturer": "dogus", "manufacturer_name": "Doğuş Kalıp", "product": "p1",
                            "product_name": "Menteşe 20 mm", "url": "https://dogus.example/mn20", "sku": "MN-20"}
    assert a["log"][0]["reason"] == "for the lids"
    # The same product again - even renamed by hand, even in words: topped up.
    run(inv.patch(fake, a["_id"], {"name": "Lid hinge"}, ME))
    b, merged = run(inv.from_catalog(fake, "doğuş", "menteşe 20", 5, by=ME))
    assert merged and b["_id"] == a["_id"] and b["quantity"] == 25 and b["log"][-1]["kind"] == "merged"
    # A plain add naming the product links to the same item.
    _, merged = run(inv.add(fake, {"name": "x", "quantity": 1, "catalog": {"manufacturer": "dogus", "product": "p1"}}, ME))
    assert merged and len(fake["inventory"].docs) == 1
    # Words that fit several products, or none, say which.
    with pytest.raises(ValueError, match="2 product.*p1 Menteşe 20 mm.*p2 Menteşe 40 mm"):
        run(inv.resolve_catalog(fake, "dogus", "menteşe"))
    with pytest.raises(ValueError, match="no product"):
        run(inv.resolve_catalog(fake, "dogus", "vida"))
    with pytest.raises(ValueError, match="no manufacturer"):
        run(inv.resolve_catalog(fake, "acme", "p1"))
    assert run(inv.resolve_catalog(fake, "dogus.com.tr", "608zz"))[1]["id"] == "p3"


def test_the_stock_of_a_catalog_in_one_read():
    fake = FakeDb()
    _catalog(fake)
    run(inv.from_catalog(fake, "dogus", "p1", 20, by=ME))
    run(inv.from_catalog(fake, "dogus", "p3", 2, by=ME))
    run(inv.patch(fake, run(inv.listing(fake, q="rulman"))[0]["_id"], {"min_stock": 4}, ME))
    run(inv.add(fake, {"name": "Unlinked", "quantity": 3}, ME))
    st = run(inv.stock_of(fake, "dogus"))
    assert set(st) == {"dogus"} and set(st["dogus"]) == {"p1", "p3"}
    assert (st["dogus"]["p1"]["quantity"], st["dogus"]["p1"]["unit"], st["dogus"]["p3"]["low"]) == (20, "pcs", True)
    assert run(inv.stock_of(fake, "other")) == {}


def test_the_catalog_routes(db):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    a.post("/api/inventory", json={"name": "tmp", "quantity": 1})                  # the space exists
    ws_a = next(iter(db["inventory"].docs.values()))["workspace_id"]
    _catalog(scope.ScopedDb(db, ws_a))
    r = a.post("/api/inventory/from-catalog", json={"manufacturer": "dogus", "product": "p1", "quantity": 20,
                                                   "location": "Shelf B", "note": "order 7"}).json()
    assert r["merged"] is False and r["item"]["catalog"]["product"] == "p1" and r["item"]["quantity"] == 20
    r = a.post("/api/inventory/from-catalog/bulk", json={"manufacturer": "dogus", "products": ["p1", "p2", "nope"],
                                                        "quantity": 2}).json()["results"]
    assert [(x["product"], x.get("merged")) for x in r] == [("p1", True), ("p2", False), ("nope", None)]
    assert "no product" in r[2]["error"]
    st = a.get("/api/inventory/stock?manufacturer=dogus").json()
    assert {k: v["quantity"] for k, v in st.items()} == {"p1": 22, "p2": 2}
    assert set(a.get("/api/inventory/stock").json()) == {"dogus"}
    assert a.post("/api/inventory/from-catalog", json={"manufacturer": "dogus", "product": "p1",
                                                       "quantity": -1}).status_code == 400
    # Another space has no such catalog, and sees none of this stock.
    assert b.post("/api/inventory/from-catalog", json={"manufacturer": "dogus", "product": "p1"}).status_code == 400
    assert b.get("/api/inventory/stock").json() == {}
    for m, p in (("POST", "/api/inventory/from-catalog"), ("POST", "/api/inventory/from-catalog/bulk")):
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))
    assert access.page_allowed("GET", "/api/inventory/stock")
