"""Undo for what the Chat's tools changed (backend/chat_undo.py).

What matters: every writing tool run as a step keeps what it changed, under
the conversation and the step; undo sets it back - stock, catalog products,
a product's files, notes, the conversation's title - only while the target
is as the tool left it (else it says what changed, field by field), only
for someone with the rights the change needed, and is itself kept, so it
can be redone. A file a tool removed from Files keeps its bytes for the
undo window. Everything runs on the tests' fake databases.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from backend import access, actors, cc_chat, chat_tools, chat_undo, files, notes, scope
from backend import inventory as inv
from backend import manufacturers as mf
from backend import product_files as pf
from backend.chat_tools import Ctx
from test_files_folders import Grid
from test_linked import STEP
from test_telegram import FakeDb
from tests.test_cc_generation import answers  # noqa: F401
from tests.test_cc_mentions_live_search import env, events, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import tool_model

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}


def run(c):
    return asyncio.run(c)


@pytest.fixture
def ws(monkeypatch):
    g = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: g)
    fake = FakeDb()
    state = {"role": "reviewer", "who": ME, "grid": g}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: state["who"])
    db = scope.ScopedDb(fake, "default")
    monkeypatch.setattr(chat_undo, "_db", lambda: db)
    monkeypatch.setattr(chat_undo, "_SWEPT", -1e9)
    run(db[cc_chat.COLL].insert_one({"_id": "c1", "title": "Chat", "by": dict(ME), "messages": []}))
    run(db[mf.COLL].insert_one({"_id": "m1", "name": "Robo90", "domain": "robo90.com", "url": "https://www.robo90.com/",
                                "by": dict(ME), "products": [
                                    {"id": "p1", "name": "UB0228 Vida M3x30", "sku": "UB0228", "specs": {}},
                                    {"id": "p2", "name": "UB0229 Vida M3x20", "sku": "UB0229", "specs": {}}]}))
    return db, fake, state


STEPS = iter(f"s{i}" for i in range(1, 10_000))


def call(db, name, args, step=None):
    """A tool as a step of an answer in c1 runs it (ccgen.run_step sets the step)."""
    return run(chat_tools.tools()[name].run(Ctx(db=db, actor=ME, chat="c1", step=step or next(STEPS)), args))


def changes(db):
    return run(chat_undo.list_changes("c1"))["changes"]


def last(db):
    return changes(db)[-1]


def undo(*ids):
    return run(chat_undo.undo_changes("c1", chat_undo.UndoIn(ids=list(ids))))


# ---- how it is made ----------------------------------------------------------------

def test_every_writing_tool_says_how_it_is_undone():
    for n, t in chat_tools.tools().items():
        if t.level == "read":
            continue
        assert t.undo is None or t.undo is False or isinstance(t.undo, str) or callable(t.undo), n
    t = chat_tools.tools()
    assert t["datasheet_get"].undo is False                         # a cache: nothing kept
    assert isinstance(t["product_to_model"].undo, str) and callable(t["drawer_add"].undo)
    readme = open("backend/chat_tools/README.md", encoding="utf-8").read()
    assert "## Undo" in readme and "chat_undo" in readme


def test_a_tool_outside_an_answer_keeps_nothing(ws):
    db, fake, _ = ws
    run(chat_tools.tools()["inventory_add"].run(Ctx(db=db, actor=ME, chat="c1"), {"items": [{"name": "M3", "quantity": 1}]}))
    assert not fake[chat_undo.COLL].docs


def test_reading_keeps_nothing(ws):
    db, fake, _ = ws
    call(db, "inventory_search", {"query": "x"})
    assert not fake[chat_undo.COLL].docs


# ---- stock ---------------------------------------------------------------------------

def test_stock_added_adjusted_edited_and_removed_comes_back(ws):
    db, fake, _ = ws
    call(db, "inventory_add", {"items": [{"name": "M3x8 screw", "quantity": 100, "location": "Bin 4"}]}, step="a1")
    (line,) = run(inv.everything(db))
    lid = line["_id"]
    c = last(db)
    assert c["step"] == "a1" and c["tool"] == "inventory_add" and c["by"]["id"] == "u-me" and c["may"]
    assert {"kind": "stock line", "name": "M3x8 screw", "op": "added"} in c["things"]
    add = c["id"]

    call(db, "inventory_adjust", {"item": lid, "change": -4, "reason": "fan board"}, step="a2")
    call(db, "inventory_edit", {"item": lid, "set": {"location": "Shelf B"}}, step="a2")
    got = run(inv.get(db, lid))
    assert got["quantity"] == 96 and got["location"] == "Shelf B" and len(got["log"]) == 3
    adj, edit = [x["id"] for x in changes(db)[1:]]

    r = undo(adj, edit)                                              # newest first
    assert r["done"] == [edit, adj] and r["conflict"] is None
    got = run(inv.get(db, lid))
    assert got["quantity"] == 100 and got["location"] == "Bin 4" and len(got["log"]) == 1

    call(db, "inventory_remove", {"items": [lid]}, step="a3")
    assert run(inv.get(db, lid)) is None
    undo(last(db)["id"])
    assert run(inv.get(db, lid))["quantity"] == 100                  # put back whole, its log too

    undo(add)
    assert run(inv.get(db, lid)) is None
    assert [x["undone"] is not None for x in changes(db)] == [True, True, True, True]
    # the undos are kept too, and the audit trail has them
    kinds = [d["kind"] for d in fake[chat_undo.COLL].docs.values()]
    assert kinds.count("undo") == 4
    assert any(d.get("action") == "chat-undo" for d in fake[actors.AUDIT].docs.values())


def test_a_top_up_undone_takes_off_only_what_it_added(ws):
    db, _, _ = ws
    call(db, "inventory_add", {"items": [{"name": "Nut M3", "quantity": 10}]})
    call(db, "inventory_add", {"items": [{"name": "Nut M3", "quantity": 5}]})
    (line,) = run(inv.everything(db))
    assert line["quantity"] == 15
    undo(last(db)["id"])
    assert run(inv.get(db, line["_id"]))["quantity"] == 10


# ---- conflicts -----------------------------------------------------------------------

def test_a_target_changed_since_is_a_conflict_said_field_by_field(ws):
    db, _, state = ws
    call(db, "inventory_add", {"items": [{"name": "Washer", "quantity": 20}]})
    (line,) = run(inv.everything(db))
    call(db, "inventory_adjust", {"item": line["_id"], "change": -2, "reason": "used"})
    adj = last(db)["id"]
    # someone else changes it on the Parts page afterwards
    state["who"] = YOU
    run(inv.adjust(db, line["_id"], -3, "used more", YOU))
    r = undo(adj)
    assert r["done"] == [] and r["conflict"]["id"] == adj
    rows = r["conflict"]["rows"]
    assert any(x["field"] == "quantity" and x["then"] == "18.0" and x["now"] == "15.0" for x in rows), rows
    assert run(inv.get(db, line["_id"]))["quantity"] == 15           # nothing was undone
    assert not last(db)["undone"]


def test_undo_all_stops_at_the_first_conflict_and_keeps_what_it_did(ws):
    db, _, _ = ws
    call(db, "note_write", {"text": "Lid screws\nM3 x 8"}, step="b1")
    call(db, "inventory_add", {"items": [{"name": "Spacer", "quantity": 4}]}, step="b1")
    note_change, add_change = [x["id"] for x in changes(db)]
    (n,) = run(_notes(db))
    run(notes.update(db, n["_id"], "Lid screws\nM3 x 10"))           # the note is edited by hand since
    r = undo(note_change, add_change)
    assert r["done"] == [add_change] and r["conflict"]["id"] == note_change
    assert any(x["field"] == "text" for x in r["conflict"]["rows"])


async def _notes(db):
    return [d async for d in db[notes.COLL].find({})]


def test_a_deleted_target_and_one_made_again_are_conflicts(ws):
    db, _, _ = ws
    call(db, "inventory_add", {"items": [{"name": "Bolt", "quantity": 1}]})
    (line,) = run(inv.everything(db))
    call(db, "inventory_edit", {"item": line["_id"], "set": {"location": "A"}})
    run(inv.remove(db, line["_id"]))
    r = undo(last(db)["id"])
    assert r["conflict"]["rows"][0]["why"] == "deleted since"


# ---- rights --------------------------------------------------------------------------

def test_undo_needs_the_rights_the_change_needed(ws):
    db, fake, state = ws
    call(db, "inventory_add", {"items": [{"name": "Cable", "quantity": 2}]})
    c = last(db)
    stored = fake[chat_undo.COLL].docs[c["id"]]
    assert stored["rights"] == [["POST", "/api/inventory/bulk"]]
    state["role"] = "viewer"
    assert not last(db)["may"]
    with pytest.raises(HTTPException) as e:
        undo(c["id"])
    assert e.value.status_code == 403
    # a change that needed more than drawing (a project's model) is not a reviewer's to undo
    stored["rights"].append(["POST", "/api/manufacturers/m1/products/p1/to-model"])
    state["role"] = "reviewer"
    with pytest.raises(HTTPException):
        undo(c["id"])
    state["role"] = "editor"
    assert undo(c["id"])["done"] == [c["id"]]
    assert access.action("POST", "/api/cc/chats/c1/changes/undo") == "draw"
    assert access.action("POST", "/api/cc/chats/c1/changes/abc/redo") == "draw"


# ---- redo, never, the window -----------------------------------------------------------

def test_an_undo_can_be_redone_and_undone_again(ws):
    db, _, _ = ws
    call(db, "catalog_edit_product", {"manufacturer": "m1", "product": "p1", "set": {"sku": "NEW-1"}})
    c = last(db)
    assert {"kind": "product", "name": "UB0228 Vida M3x30", "op": "changed"} in c["things"]
    sku = lambda: next(p for p in run(mf.get(db, "m1"))["products"] if p["id"] == "p1")["sku"]  # noqa: E731
    assert sku() == "NEW-1"
    undo(c["id"])
    assert sku() == "UB0228"
    r = run(chat_undo.redo_change("c1", c["id"]))
    assert r["done"] == [c["id"]] and sku() == "NEW-1" and not last(db)["undone"] and last(db)["redone"]
    undo(c["id"])
    assert sku() == "UB0228"


def test_a_change_past_the_window_is_kept_as_history_without_undo(ws):
    db, fake, state = ws
    stp = run(files.put(db, "a.step", STEP, None, {}, ME))["_id"]
    call(db, "product_file_attach", {"product": "m1:p1", "files": [stp]})
    call(db, "product_file_detach", {"product": "m1:p1", "file": stp, "delete_file": True})
    assert stp not in fake["files"].docs
    held = fake[chat_undo.COLL].docs[last(db)["id"]]["held"]
    assert held and held[0] in state["grid"].blobs                   # the bytes stay for the window
    for d in fake[chat_undo.COLL].docs.values():
        d["expires"] = "2000-01-01T00:00:00+00:00"
    assert run(chat_undo.sweep(db, force=True)) == 2
    assert held[0] not in state["grid"].blobs
    c = last(db)
    assert c["why"].startswith("older than") and c["things"] == []
    r = undo(c["id"])
    assert r["conflict"]["why"].startswith("older than")


def test_a_tool_that_cannot_be_undone_says_why(ws, monkeypatch):
    db, fake, _ = ws
    t = chat_tools.tools()["note_write"]
    monkeypatch.setattr(t, "undo", "a note is kept for good")
    call(db, "note_write", {"text": "Kept"})
    c = last(db)
    assert c["why"] == "a note is kept for good"
    assert undo(c["id"])["conflict"]["why"] == "a note is kept for good"


# ---- the families ------------------------------------------------------------------------

def test_catalog_products_added_and_removed_come_back_in_place(ws):
    db, _, _ = ws
    call(db, "catalog_add_product", {"manufacturer": "m1", "products": [{"name": "Hinge 20 mm", "sku": "H20"}]})
    add = last(db)
    assert {"kind": "product", "name": "Hinge 20 mm", "op": "added"} in add["things"]
    call(db, "catalog_remove_product", {"manufacturer": "m1", "products": ["p1"]})
    names = lambda: [p["name"] for p in run(mf.get(db, "m1"))["products"]]  # noqa: E731
    assert names() == ["UB0229 Vida M3x20", "Hinge 20 mm"]
    undo(last(db)["id"])
    assert names() == ["UB0228 Vida M3x30", "UB0229 Vida M3x20", "Hinge 20 mm"]
    undo(add["id"])
    assert names() == ["UB0228 Vida M3x30", "UB0229 Vida M3x20"]


def test_a_products_files_attached_detached_and_made_main_come_back(ws):
    db, fake, _ = ws
    stp = run(files.put(db, "a.step", STEP, None, {}, ME))["_id"]
    call(db, "product_file_attach", {"product": "m1:p1", "files": [stp]})
    att = last(db)
    assert run(pf.of(db, "m1", "p1"))["cad"]["file"] == stp
    call(db, "product_file_detach", {"product": "m1:p1", "file": stp, "delete_file": True})
    assert run(pf.of(db, "m1", "p1"))["cad"] is None and stp not in fake["files"].docs
    undo(last(db)["id"])
    assert stp in fake["files"].docs                                  # the Files file is back, bytes and all
    assert run(files.get(db, stp))[1] == STEP
    assert run(pf.of(db, "m1", "p1"))["cad"]["file"] == stp
    undo(att["id"])
    assert run(pf.of(db, "m1", "p1"))["files"] == []


def test_notes_written_edited_and_ticked_come_back(ws):
    db, _, _ = ws
    call(db, "note_write", {"text": "Fan curve\n- [ ] measure at 40C"})
    wrote = last(db)
    (n,) = run(_notes(db))
    call(db, "note_todo", {"note": n["_id"], "todo": 1, "done": True})
    call(db, "note_edit", {"note": n["_id"], "text": "Fan curve v2\n- [x] measure at 40C"})
    tick, edit = [x["id"] for x in changes(db)[1:]]
    undo(tick, edit)
    assert run(_notes(db))[0]["text"] == "Fan curve\n- [ ] measure at 40C"
    undo(wrote["id"])
    assert run(_notes(db)) == []


def test_a_rename_undone_tells_the_open_pages(ws):
    db, _, _ = ws
    call(db, "rename_chat", {"title": "Fan board power"})
    cid = last(db)["id"]

    async def go():
        q = cc_chat.HUB.subscribe(cc_chat.live_key("c1"))
        try:
            await chat_undo.undo_changes("c1", chat_undo.UndoIn(ids=[cid]))
            return q.get_nowait()
        finally:
            cc_chat.HUB.unsubscribe(cc_chat.live_key("c1"), q)
    ev = asyncio.run(go())
    assert run(db[cc_chat.COLL].find_one({"_id": "c1"}))["title"] == "Chat"
    assert ev == {"type": "title", "gen": None, "title": "Chat"}


def test_the_drawer_add_undoes_with_its_own_inverse(ws, monkeypatch):
    db, _, state = ws
    from backend import lcsc
    from backend.chat_tools import drawer_add
    held = {"C1": True}

    async def in_drawer(d, c):
        return {"name": "Part"} if held.get(c) else None

    async def let_go(d, c, ws_=None):
        held.pop(c, None)
        return True
    monkeypatch.setattr(drawer_add, "in_drawer", in_drawer)
    monkeypatch.setattr(lcsc, "let_go", let_go)
    e = {"_id": "x", "kind": "tool", "chat": "c1", "tool": "drawer_add", "custom": True, "vars": {"lcsc": "C1"},
         "docs": [{"coll": "lcsc_parts", "id": "C1", "op": "insert", "a": {"_id": "C1"}}], "level": "change",
         "expires": "2999-01-01", "rights": []}
    run(db[chat_undo.COLL].insert_one(e))
    with pytest.raises(HTTPException):                               # out of the drawer is the delete right's
        undo("x")
    state["role"] = "editor"
    assert undo("x")["done"] == ["x"] and not held
    e2 = {**e, "_id": "y"}
    run(db[chat_undo.COLL].insert_one(e2))
    assert "not in the drawer" in undo("y")["conflict"]["why"]


# ---- in a whole answer ---------------------------------------------------------------------

def test_a_model_s_tool_step_keeps_its_change_under_the_step(env, monkeypatch):  # noqa: F811
    raw, state = env
    seed_chat(raw)
    monkeypatch.setattr(chat_undo, "_db", cc_chat._db)
    tool_model(monkeypatch, state, [("", [("rename_chat", {"title": "Fan board power"})]), ("Renamed.", [])])
    events(cc_chat.say("c1", cc_chat.SayIn(text="call this chat Fan board power", client="tab1")))
    (ans,) = answers(raw)
    step = ans["steps"][0]["id"]
    (c,) = run(chat_undo.list_changes("c1"))["changes"]
    assert c["step"] == step and c["tool"] == "rename_chat" and c["say"] == "Renamed this chat to “{title}”"
    assert c["things"] == [{"kind": "chat", "name": "Fan board power", "op": "changed", "fields": ["title"]}]
    run(chat_undo.undo_changes("c1", chat_undo.UndoIn(ids=[c["id"]])))
    assert raw["cc_chats"].rows["c1"]["title"] == "Chat"


def test_a_product_copied_to_my_items_goes_back_with_its_stock(ws):
    db, fake, _ = ws
    from backend import catalog_own
    item, _ = run(inv.from_catalog(db, "m1", "p1", 40, location="Shelf A", by=ME))
    call(db, "product_to_my_items", {"product": "m1:p1"})
    c = last(db)
    assert run(inv.get(db, item["_id"]))["catalog"]["manufacturer"] == catalog_own.MID
    assert {x["kind"] for x in c["things"]} >= {"stock line"}
    undo(c["id"])
    assert run(inv.get(db, item["_id"]))["catalog"] == item["catalog"]
    assert not fake[catalog_own.COLL].docs


def test_an_archived_chat_comes_back(ws):
    db, _, _ = ws
    call(db, "chat_archive", {})
    assert run(db[cc_chat.COLL].find_one({"_id": "c1"})).get("archived")
    undo(last(db)["id"])
    assert not run(db[cc_chat.COLL].find_one({"_id": "c1"})).get("archived")
