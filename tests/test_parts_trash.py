"""Parts' Deleted (backend/parts_trash.py): a product deleted - by hand, by
the Chat, by an agent, with its maker, out of the drawer - goes with its
stock lines (their logs) and its files' references, as one unit, restorable
for KEEP_DAYS; restored, all of it comes back (to a product found again, or
to My Items when its maker is gone for good); purged, its files go to
Files' trash only when they were made for it and nothing else refers to
them. A line in Deleted is in no stock read, and no line can be written to
count a product that is not in Parts. Everything runs on the tests' fake
databases."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from backend import access, actors, agent_api, catalog_own, chat_tools, files, lcsc, linked, parts_trash, scope
from backend import inventory as inv
from backend import manufacturers as mf
from backend import product_files as pf
from backend.chat_tools import Ctx
from test_files_folders import Grid
from test_linked import STEP
from test_product_files import PDF, maker, site  # noqa: F401 - site is a fixture
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401 - db is a fixture

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}


def run(c):
    return asyncio.run(c)


@pytest.fixture
def grid(monkeypatch):
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    return g


@pytest.fixture
def ws(monkeypatch, grid):
    fake = FakeDb()
    state = {"role": "editor", "who": ME}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    d = scope.ScopedDb(fake, "default")
    from backend import main
    monkeypatch.setattr(main, "db", lambda: d)
    run(d[mf.COLL].insert_one({"_id": "m1", "name": "Robo90", "domain": "robo90.com", "url": "https://www.robo90.com/",
                               "by": dict(ME), "products": [
                                   {"id": "p1", "name": "UB0228 Vida M3x30", "sku": "UB0228", "specs": {}},
                                   {"id": "p2", "name": "UB0229 Vida M3x20", "sku": "UB0229", "specs": {}}]}))
    return d, fake, state


def line(d, mid="m1", pid="p1", qty=10, name=None):
    doc, _ = run(inv.add(d, {"name": name or f"{pid} line", "quantity": qty,
                             "catalog": {"manufacturer": mid, "product": pid}}, ME, merge=False))
    return doc["_id"]


def names(d, mid="m1"):
    return [p["name"] for p in run(mf.get(d, mid))["products"]]


def units(d):
    return run(parts_trash.listing(d))


# ---------------------------------------------------------------- a product, with what is its

def test_a_product_goes_with_its_stock_and_files_and_comes_back_whole(ws):
    d, fake, _ = ws
    i1 = line(d)
    run(inv.adjust(d, i1, -3, "fan board", ME))
    line(d, pid="p2")
    run(pf.put(d, "m1", "p1", "vida.step", STEP, measure=False))
    run(pf.put(d, "m1", "p1", "vida.pdf", PDF, measure=False))
    said = run(parts_trash.goes_with(d, "m1", ["p1"]))
    assert (said["products"], said["stock"], said["files"], said["days"]) == (1, 1, 2, parts_trash.KEEP_DAYS)
    assert said["lines"] == ["p1 line (7 pcs)"]

    assert run(mf.delete_products(d, "m1", ["p1"])) == 1
    assert names(d) == ["UB0229 Vida M3x20"]
    # out of every stock read: the listing, the product's count, the search the Chat makes
    assert [x["name"] for x in run(inv.listing(d))] == ["p2 line"]
    assert "p1" not in run(inv.stock_of(d, "m1")).get("m1", {})
    got = run(chat_tools.tools()["inventory_search"].run(Ctx(db=d, actor=ME), {"query": "p1"}))
    assert "p1 line" not in got.text
    assert run(d[pf.COLL].find_one({"mid": "m1", "pid": "p1"})) is None
    assert len(fake[files.COLL].docs) == 2                                  # Files keeps them
    (u,) = units(d)
    assert (u["kind"], u["name"], u["maker_name"], u["how"]) == ("product", "UB0228 Vida M3x30", "Robo90", "hand")
    assert [s["name"] for s in u["stock"]] == ["p1 line"] and u["stock"][0]["log"] == 2 and u["nfiles"] == 2
    assert u["days_left"] == parts_trash.KEEP_DAYS and u["deleted_by"]["id"] == "u-me" and u["may"]

    back = run(parts_trash.restore(d, u["id"]))
    assert back["stock"] == 1 and back["files"] == 2 and back["to"] == []
    assert names(d) == ["UB0229 Vida M3x20", "UB0228 Vida M3x30"]
    got = run(inv.get(d, i1))
    assert got["quantity"] == 7 and [ln["kind"] for ln in got["log"]] == ["added", "adjusted", "edited"]
    assert got["log"][-1]["reason"] == "restored from Parts' Deleted"
    assert len(run(pf.of(d, "m1", "p1"))["files"]) == 2
    assert units(d) == []


def test_a_bulk_delete_is_a_unit_a_product_and_a_product_found_again_takes_them_back(ws):
    d, _, _ = ws
    line(d, pid="p1")
    line(d, pid="p2")
    assert run(mf.delete_products(d, "m1", ["p1", "p2", "nope"])) == 2
    assert sorted(u["name"] for u in units(d)) == ["UB0228 Vida M3x30", "UB0229 Vida M3x20"]
    # the site is read again: the same code comes back under a new id - the lines count that one, not a double
    doc = run(mf.get(d, "m1"))
    run(d[mf.COLL].update_one({"_id": "m1"}, {"$set": {"products": [*doc["products"],
                                                                      {"id": "p9", "name": "UB0228 (new page)", "sku": "UB0228"}]}}))
    u = next(x for x in units(d) if x["product"]["id"] == "p1")
    assert run(parts_trash.restore(d, u["id"]))["to"] == ["m1:p9"]
    assert names(d) == ["UB0228 (new page)"]
    (ln,) = [x for x in run(inv.everything(d)) if x["name"] == "p1 line"]
    assert ln["catalog"]["product"] == "p9" and ln["catalog"]["product_name"] == "UB0228 (new page)"


def test_a_makers_delete_takes_its_catalog_stock_and_files_as_one_unit(ws):
    d, _, _ = ws
    line(d, pid="p1")
    line(d, pid="p2")
    run(pf.put(d, "m1", "p2", "vida.pdf", PDF, measure=False))
    said = run(parts_trash.goes_with(d, "m1"))
    assert (said["products"], said["stock"], said["files"]) == (2, 2, 1)
    assert run(parts_trash.trash_maker(d, "m1"))
    assert run(mf.get(d, "m1")) is None and run(inv.everything(d)) == []
    (u,) = units(d)
    assert (u["kind"], u["products"], len(u["stock"]), u["nfiles"]) == ("maker", 2, 2, 1)
    run(parts_trash.restore(d, u["id"]))
    assert names(d) == ["UB0228 Vida M3x30", "UB0229 Vida M3x20"] and len(run(inv.everything(d))) == 2
    assert len(run(pf.of(d, "m1", "p2"))["files"]) == 1


def test_a_product_whose_maker_is_deleted_waits_for_it_or_comes_back_to_my_items(ws):
    d, _, _ = ws
    i1 = line(d, pid="p1")
    run(mf.delete_products(d, "m1", ["p1"]))
    run(parts_trash.trash_maker(d, "m1"))
    pu = next(u for u in units(d) if u["kind"] == "product")
    mu = next(u for u in units(d) if u["kind"] == "maker")
    with pytest.raises(parts_trash.Refused, match="restore the maker first"):
        run(parts_trash.restore(d, pu["id"]))
    # the maker gone for good: the product comes back as a My Items product, its line counting it
    run(parts_trash.purge(d, mu["id"]))
    back = run(parts_trash.restore(d, pu["id"]))
    (own,) = run(catalog_own.products(d))
    assert back["to"] == [f"own:{own['id']}"] and own["name"] == "UB0228 Vida M3x30" and own["specs"]["Maker"] == "Robo90"
    assert run(inv.get(d, i1))["catalog"]["manufacturer"] == "own"


def test_my_items_saved_parts_and_the_drawer_go_the_same_way(ws):
    d, fake, _ = ws
    own = run(catalog_own.add(d, {"name": "PLA grey 1 kg"}, ME))
    line(d, mid="own", pid=own["id"])
    assert run(parts_trash.trash_products(d, "own", [own["id"]])) == 1
    assert run(catalog_own.products(d)) == [] and run(inv.everything(d)) == []
    run(parts_trash.restore(d, units(d)[0]["id"]))
    assert [p["name"] for p in run(catalog_own.products(d))] == ["PLA grey 1 kg"] and len(run(inv.everything(d))) == 1

    run(d[linked.COLL].insert_one({"_id": "l1", "source": "mcmaster", "key": "91290A115", "title": "Socket Head Screw",
                                   "files": [{"file": "f9", "name": "screw.step"}], "by": dict(ME)}))
    line(d, mid="mcmaster", pid="91290A115")
    assert run(parts_trash.trash_products(d, "mcmaster", ["91290A115"])) == 1
    assert run(d[linked.COLL].find_one({"key": "91290A115"})) is None
    u = next(x for x in units(d) if x["mid"] == "mcmaster")
    assert u["nfiles"] == 1 and len(u["stock"]) == 1
    run(parts_trash.restore(d, u["id"]))
    assert run(d[linked.COLL].find_one({"key": "91290A115"}))["files"][0]["name"] == "screw.step"

    # an LCSC part: the cache keeps it, held by none, while it is in Deleted
    run(fake[lcsc.PARTS].insert_one({"_id": "C25744", "name": "10k 0402"}))          # held by the default space
    run(d[inv.COLL].insert_one({"_id": "i3", "name": "10k", "quantity": 100, "unit": "pcs", "log": [],
                                "catalog": {"manufacturer": "lcsc", "product": "C25744"}}))
    assert run(parts_trash.trash_products(d, "lcsc", ["C25744", "C1"])) == 1
    assert fake[lcsc.PARTS].docs["C25744"]["spaces"] == []
    u = next(x for x in units(d) if x["mid"] == "lcsc")
    run(parts_trash.restore(d, u["id"]))
    assert fake[lcsc.PARTS].docs["C25744"]["spaces"] == ["default"]
    assert any(x["catalog"]["product"] == "C25744" for x in run(inv.everything(d)))
    fake[lcsc.PARTS].docs["C25744"].pop("spaces")
    run(parts_trash.trash_products(d, "lcsc", ["C25744"]))
    run(parts_trash.purge(d, next(x for x in units(d) if x["mid"] == "lcsc")["id"]))
    assert "C25744" not in fake[lcsc.PARTS].docs


# ---------------------------------------------------------------- for good

def test_purged_after_its_days_its_own_unused_files_go_to_files_trash(ws):
    d, fake, _ = ws
    run(pf.put(d, "m1", "p1", "vida.step", STEP, measure=False))           # made for p1
    run(pf.put(d, "m1", "p1", "shared.pdf", PDF, measure=False))           # made for p1, but p2 uses it too
    mine = run(files.put(d, "my.pdf", PDF + b" ", None, {"room": "files"}, ME))   # the person's own
    shared = next(f["file"] for f in run(pf.of(d, "m1", "p1"))["files"] if f["name"] == "shared.pdf")
    run(pf.attach(d, "m1", "p2", [shared], measure=False))
    run(pf.attach(d, "m1", "p1", [mine["_id"]], measure=False))
    run(mf.delete_products(d, "m1", ["p1"]))
    (u,) = units(d)
    run(d[parts_trash.COLL].update_one({"_id": u["id"]}, {"$set": {
        "purge_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}}))
    assert units(d) == []                                                   # swept on reading
    left = sorted(x["name"] for x in fake[files.COLL].docs.values())
    assert left == ["my.pdf", "shared.pdf"]
    assert [x["name"] for x in fake[files.TRASH].docs.values()] == ["vida.step"]   # restorable from Files a while


def test_the_sweep_purges_each_workspace_in_its_own(grid, monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(actors, "current", lambda: ME)
    for ws_ in ("default", "w2"):
        tok = scope.WORKSPACE.set(ws_)
        d = scope.ScopedDb(fake, ws_)
        run(d[catalog_own.COLL].insert_one({"_id": "o1", "name": f"thing {ws_}", "source": "manual"}))
        run(parts_trash.trash_products(d, "own", ["o1"]))
        scope.WORKSPACE.reset(tok)
    for doc in fake[parts_trash.COLL].docs.values():
        if doc["workspace_id"] == "w2":
            doc["purge_at"] = "2000-01-01T00:00:00+00:00"
    assert run(parts_trash.sweep_all(fake)) == 1
    assert [x["workspace_id"] for x in fake[parts_trash.COLL].docs.values()] == ["default"]


# ---------------------------------------------------------------- the Chat, its undo, the agents

def test_the_chats_remove_goes_to_deleted_and_its_undo_brings_the_whole_unit_back(ws, monkeypatch):
    from backend import cc_chat, chat_undo
    d, _, state = ws
    state["role"] = "reviewer"
    monkeypatch.setattr(chat_undo, "_db", lambda: d)
    monkeypatch.setattr(chat_undo, "_SWEPT", -1e9)
    run(d[cc_chat.COLL].insert_one({"_id": "c1", "title": "Chat", "by": dict(ME), "messages": []}))
    i1 = line(d, pid="p1")
    run(pf.put(d, "m1", "p1", "vida.step", STEP, measure=False))
    state["role"] = "editor"
    tool = chat_tools.tools()["catalog_remove_product"]
    run(tool.run(Ctx(db=d, actor=ME, chat="c1", step="s1"), {"manufacturer": "m1", "products": ["p1"]}))
    (u,) = units(d)
    assert u["how"] == "chat" and len(u["stock"]) == 1 and u["nfiles"] == 1
    assert run(inv.get(d, i1)) is None
    (c,) = run(chat_undo.list_changes("c1"))["changes"]
    r = run(chat_undo.undo_changes("c1", chat_undo.UndoIn(ids=[c["id"]])))
    assert r["conflict"] is None
    assert names(d) == ["UB0228 Vida M3x30", "UB0229 Vida M3x20"]
    assert run(inv.get(d, i1))["quantity"] == 10 and len(run(pf.of(d, "m1", "p1"))["files"]) == 1
    assert units(d) == []


def test_an_agents_database_delete_goes_to_deleted_too(ws):
    d, _, _ = ws
    line(d, pid="p1")
    line(d, pid="p2")
    # a product taken out of the catalog's document by a write
    got = run(agent_api._run({"coll": "manufacturers", "op": "update_one", "args": {
        "filter": {"_id": "m1"}, "update": {"$set": {"products": [run(mf.get(d, "m1"))["products"][1]]}}}}))
    assert names(d) == ["UB0229 Vida M3x20"] and b'"matched_count"' in got.body
    (u,) = units(d)
    assert (u["name"], u["how"], len(u["stock"])) == ("UB0228 Vida M3x30", "agent", 1)
    # the maker deleted
    run(agent_api._run({"coll": "manufacturers", "op": "delete_one", "args": {"filter": {"_id": "m1"}}}))
    assert run(mf.get(d, "m1")) is None and run(inv.everything(d)) == []
    assert sorted(u["kind"] for u in units(d)) == ["maker", "product"]
    # a stock line that counts nothing in Parts is refused
    with pytest.raises(HTTPException) as e:
        run(agent_api._run({"coll": "inventory", "op": "insert_one", "args": {"doc": {
            "_id": "i9", "name": "x", "quantity": 1, "catalog": {"manufacturer": "m1", "product": "p1"}}}}))
    assert e.value.status_code == 400 and "no manufacturer" in e.value.detail


def test_no_line_is_written_to_count_a_product_not_in_parts(ws):
    d, fake, _ = ws
    with pytest.raises(ValueError, match="has no product"):
        run(inv.add(d, {"name": "x", "quantity": 1, "catalog": {"manufacturer": "m1", "product": "gone"}}, ME))
    # a line written around it (straight into the database) cannot be counted on
    run(d[inv.COLL].insert_one({"_id": "i7", "name": "Old", "quantity": 4, "unit": "pcs", "log": [],
                                "catalog": {"manufacturer": "m1", "product": "gone", "product_name": "Gone"}}))
    with pytest.raises(ValueError, match="not in Parts any more"):
        run(inv.adjust(d, "i7", -1, "", ME))
    with pytest.raises(ValueError, match="not in Parts any more"):
        run(inv.patch(d, "i7", {"location": "A"}, ME))
    # linked to a product that is there, it is a line again
    assert run(inv.patch(d, "i7", {"catalog": {"manufacturer": "m1", "product": "p2"}}, ME))["catalog"]["product"] == "p2"


# ---------------------------------------------------------------- the rights, the routes

def test_restoring_or_purging_someone_elses_needs_the_right_to_delete(ws):
    d, _, state = ws
    run(mf.delete_products(d, "m1", ["p1"]))
    (u,) = units(d)
    state["who"], state["role"] = YOU, "reviewer"
    assert not units(d)[0]["may"]
    for route in (parts_trash.api_restore, parts_trash.api_purge):
        with pytest.raises(HTTPException) as e:
            run(route(parts_trash.UnitsIn(ids=[u["id"]])))
        assert e.value.status_code == 403
    state["role"] = "editor"                                          # may delete
    assert run(parts_trash.api_restore(parts_trash.UnitsIn(ids=[u["id"]])))["restored"][0]["name"] == "UB0228 Vida M3x30"
    state["who"], state["role"] = ME, "reviewer"                      # one's own: the catalog's right is enough
    run(mf.delete_products(d, "m1", ["p1"]))
    assert run(parts_trash.api_purge(parts_trash.UnitsIn(ids=[units(d)[0]["id"]])))["purged"]


def test_the_page_deletes_asks_and_restores_through_the_api(db, grid, site):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    mid, (p1, p2) = maker(a, products=({"name": "Hinge", "sku": "H-1"}, {"name": "Latch"}))
    a.post(f"/api/manufacturers/{mid}/products/{p1}/files", files={"upload": ("hinge.step", STEP)})
    a.post("/api/inventory", json={"name": "Hinge", "quantity": 2, "catalog": {"manufacturer": mid, "product": p1}})
    said = a.get(f"/api/manufacturers/trash/goes-with?maker={mid}&products={p1}").json()
    assert (said["products"], said["stock"], said["files"]) == (1, 1, 1)
    assert a.delete(f"/api/manufacturers/{mid}/products/{p1}").json()["deleted"] == p1
    assert a.get("/api/inventory").json() == []
    got = a.get("/api/manufacturers/trash").json()
    assert got["days"] == parts_trash.KEEP_DAYS and [u["name"] for u in got["units"]] == ["Hinge"]
    assert b.get("/api/manufacturers/trash").json()["units"] == []          # another space sees none of it
    r = a.post("/api/manufacturers/trash/restore", json={"ids": [got["units"][0]["id"]]}).json()
    assert r["refused"] == [] and r["restored"][0]["stock"] == 1
    assert len(a.get(f"/api/manufacturers/{mid}/products/{p1}/files").json()["files"]) == 1
    # the maker: one unit, purged on asking
    a.delete(f"/api/manufacturers/{mid}")
    (u,) = a.get("/api/manufacturers/trash").json()["units"]
    assert u["kind"] == "maker" and u["products"] == 2
    assert a.post("/api/manufacturers/trash/purge", json={"ids": [u["id"]]}).json()["purged"][0]["files"] == 1
    assert a.get("/api/manufacturers/trash").json()["units"] == []


# ---------------------------------------------------------------- the site read again, what was left before

def test_a_site_that_stops_listing_a_kept_product_marks_it_gone_until_it_lists_it_again():
    have = [{"id": "p1", "name": "Held", "specs": {}}, {"id": "p2", "name": "Mine", "source": "manual", "specs": {}},
            {"id": "p3", "name": "Plain", "specs": {}}]
    out, _ = mf.fold_in(have, [{"name": "New", "specs": {}}], "2026-10-14T00:00:00", replace=True, keep={"p1"})
    by = {p["name"]: p for p in out}
    assert set(by) == {"Held", "Mine", "New"} and by["Held"]["gone_at"] == "2026-10-14T00:00:00"
    assert "gone_at" not in by["Mine"] and "gone_at" not in by["New"]
    again, _ = mf.fold_in(out, [{"name": "Held", "specs": {}}], "2026-10-15T00:00:00", replace=True, keep={"p1"})
    assert "gone_at" not in next(p for p in again if p["name"] == "Held")


def test_orphans_from_before_move_in_as_units_dry_run_first(ws):
    d, fake, _ = ws
    run(d[inv.COLL].insert_one({"_id": "i5", "name": "Arducam UB0228", "quantity": 1, "unit": "pcs",
                                "log": [{"kind": "added"}] * 5,
                                "catalog": {"manufacturer": "445c3c004a58", "product": "09de", "product_name": "UB0228 adapter",
                                            "manufacturer_name": "welectron.com"}}))
    run(d[pf.COLL].insert_one({"_id": "h1", "mid": "445c3c004a58", "pid": "09de", "name": "UB0228 adapter",
                               "files": [{"file": "f1", "name": "ub.pdf"}]}))
    run(d["audit"].insert_one({"action": "delete", "target": "/api/manufacturers/445c3c004a58",
                               "at": datetime(2026, 10, 14, 13, 10)}))
    line(d, pid="p1")                                                      # not an orphan
    dry = run(parts_trash.adopt_orphans(d))
    assert [(g["name"], g["note"], g["files"], g["unit"]) for g in dry] == [
        ("UB0228 adapter", "deleted with welectron.com on 2026-10-14", 1, None)]
    assert units(d) == [] and run(inv.get(d, "i5"))                       # nothing moved
    (g,) = run(parts_trash.adopt_orphans(d, apply=True))
    (u,) = units(d)
    assert u["id"] == g["unit"] and u["how"] == "migrated" and u["stock"][0]["log"] == 5 and u["nfiles"] == 1
    assert u["days_left"] == parts_trash.KEEP_DAYS and run(inv.get(d, "i5")) is None
    assert run(pf.orphans(d)) == [] and len(run(inv.everything(d))) == 1
    assert run(parts_trash.adopt_orphans(d)) == []                         # again: nothing left
