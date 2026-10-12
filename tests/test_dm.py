"""Direct messages (backend/dm.py): people writing to each other in the Chat.

What matters: only the members of a conversation ever read it - every
route, the search, the live stream and the Chat tools; nothing calls a
model; what is unread is counted per person and cleared on reading; and a
thing sent along shows whole only to someone who may open it - anyone
else gets its kind and name, locked. Sign-in is on; the database is
test_telegram's fake, and the sessions are real ones (backend/auth.py)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import test_telegram
from backend import access, actors, auth, cc_chat, dm, scope
from test_telegram import FakeDb

PW = "a long password 1"


def run(c):
    return asyncio.run(c)


@pytest.fixture
def db(monkeypatch):
    from backend import main
    # Mongo's array match: {"members": "u-x"} finds a list holding it.
    plain = test_telegram._match_value

    def match_value(v, cond):
        if isinstance(v, list) and not isinstance(cond, (dict, list)):
            return cond in v
        return plain(v, cond)
    monkeypatch.setattr(test_telegram, "_match_value", match_value)
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)
    auth._CACHE.clear()
    now = datetime.now(timezone.utc)
    for uid, name, role, extra in (("u-ayse", "Ayşe", "user", {}), ("u-bora", "Bora", "user", {}),
                                   ("u-cem", "Cem", "admin", {}), ("u-gone", "Gone", "user", {"disabled": True})):
        run(fake["users"].insert_one({"_id": uid, "email": f"{uid}@example.com", "name": name, "role": role,
                                      "pw": auth.hash_password(PW), "created_at": now, **extra}))
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    cc_chat.HUB.subs.clear()
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    auth._CACHE.clear()
    cc_chat.HUB.subs.clear()


def client(fake, uid: str) -> TestClient:
    token = run(auth.create_session(fake, {"_id": uid}, "u" + uid, "Mozilla/5.0 Firefox/130.0"))
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.cookies.set(auth.COOKIE, token)
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def space(uid: str) -> str:
    return "u" + uid


# ---------------------------------------------------------------- the rules

def test_reading_is_looking_and_writing_is_chatting():
    assert access.action("GET", "/api/dm/state") == "view"
    assert access.action("GET", "/api/dm/items/s1") == "view"
    assert access.action("GET", "/api/dm/items/s1/blob/file") == "view"
    assert access.action("POST", "/api/dm/items/s1/add") == "edit"
    assert access.action("POST", "/api/dm/items/s1/unshare") == "draw"
    assert access.action("GET", "/api/dm/chats/dm-1") == "view"
    for m, p in (("POST", "/api/dm/chats"), ("POST", "/api/dm/chats/dm-1/messages"),
                 ("PATCH", "/api/dm/chats/dm-1/messages/x"), ("DELETE", "/api/dm/chats/dm-1/messages/x"),
                 ("POST", "/api/dm/chats/dm-1/read")):
        assert access.action(m, p) == "draw", (m, p)
        assert not access.page_allowed(m, p)
    assert access.page_allowed("GET", "/api/dm/state")


def test_only_people_write_to_each_other(db, monkeypatch):
    tok = actors.CURRENT.set(actors.agent("bot"))
    try:
        with pytest.raises(Exception) as e:
            dm.me()
        assert e.value.status_code == 403
    finally:
        actors.CURRENT.reset(tok)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    assert run(dm.state())["enabled"] is False


# ---------------------------------------------------------------- people and conversations

def test_people_are_everyone_else_without_their_address(db):
    r = client(db, "u-ayse").get("/api/dm/state")
    assert r.status_code == 200, r.text
    got = r.json()
    ids = [p["id"] for p in got["people"]]
    assert sorted(ids) == ["u-bora", "u-cem"]               # not me, not a disabled account
    assert "@example.com" not in r.text and "pw" not in r.text
    assert got["unread"] == {"total": 0, "senders": []}


def test_a_direct_conversation_is_one_per_pair(db):
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    one = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()
    two = b.post("/api/dm/chats", json={"people": ["u-ayse"]}).json()
    assert one["id"] == two["id"] and "title" not in one
    assert [m["id"] for m in one["members"]] == ["u-bora"]
    assert a.post("/api/dm/chats", json={"people": ["u-gone"]}).status_code == 404
    assert a.post("/api/dm/chats", json={"people": ["u-ayse"]}).status_code == 400
    # Person to person only: no conversation of three.
    assert a.post("/api/dm/chats", json={"people": ["u-bora", "u-cem"], "title": "Bench"}).status_code == 422


def test_an_old_group_conversation_stays_but_is_hidden(db):
    # Made before groups went: its documents are kept, no route shows or takes it.
    run(db["dm_chats"].insert_one({"_id": "dm-group1", "members": ["u-ayse", "u-bora", "u-cem"], "direct": False,
                                   "title": "Bench", "created_at": "2026-01-01T00:00:00Z",
                                   "updated_at": "2026-01-01T00:00:00Z", "last": None, "read": {}}))
    run(db["dm_messages"].insert_one({"_id": "m-g1", "chat": "dm-group1", "by": {"id": "u-bora", "name": "Bora"},
                                      "at": "2026-01-01T00:00:01Z", "text": "the group hinge"}))
    a = client(db, "u-ayse")
    st = a.get("/api/dm/state").json()
    assert st["chats"] == [] and st["unread"]["total"] == 0
    assert a.get("/api/dm/chats/dm-group1").status_code == 404
    assert a.post("/api/dm/chats/dm-group1/messages", json={"text": "hi"}).status_code == 404
    assert a.get("/api/dm/search", params={"q": "group hinge"}).json()["results"] == []
    assert run(db["dm_chats"].count_documents({})) == 1 and run(db["dm_messages"].count_documents({})) == 1


def test_nobody_else_reads_a_conversation(db):
    a, b, c = client(db, "u-ayse"), client(db, "u-bora"), client(db, "u-cem")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    mid = a.post(f"/api/dm/chats/{cid}/messages", json={"text": "the secret hinge"}).json()["id"]
    assert b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["text"] == "the secret hinge"
    # Cem - an admin, even - is not in it: the same 404 everywhere as for no conversation at all.
    assert c.get(f"/api/dm/chats/{cid}").status_code == 404
    assert c.post(f"/api/dm/chats/{cid}/messages", json={"text": "hi"}).status_code == 404
    assert c.post(f"/api/dm/chats/{cid}/read").status_code == 404
    assert c.patch(f"/api/dm/chats/{cid}/messages/{mid}", json={"text": "x"}).status_code == 404
    assert c.delete(f"/api/dm/chats/{cid}/messages/{mid}").status_code == 404
    assert c.get("/api/dm/search", params={"q": "secret"}).json()["results"] == []
    assert all(x["id"] != cid for x in c.get("/api/dm/state").json()["chats"])
    assert a.get("/api/dm/search", params={"q": "secret hinge"}).json()["results"][0]["chat_id"] == cid
    # Bora reads it, and may not change Ayşe's line.
    assert b.patch(f"/api/dm/chats/{cid}/messages/{mid}", json={"text": "x"}).status_code == 403
    assert b.delete(f"/api/dm/chats/{cid}/messages/{mid}").status_code == 403


def test_the_chat_tools_and_the_ai_list_never_see_one(db):
    from backend.chat_tools import Ctx, ToolError, chat_list, chat_read
    a = client(db, "u-ayse")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    a.post(f"/api/dm/chats/{cid}/messages", json={"text": "the secret hinge"})
    for ws in (space("u-ayse"), space("u-bora"), scope.DEFAULT):
        ctx = Ctx(db=scope.ScopedDb(db, ws))
        got = run(chat_list.run(ctx, {"query": "secret"})).text
        assert got.startswith("No conversation") and cid not in got
        assert cid not in run(chat_list.run(ctx, {})).text
        with pytest.raises(ToolError):
            run(chat_read.run(ctx, {"chat": cid}))
    # Nor do the AI conversations' own collection.
    assert run(db[cc_chat.COLL].count_documents({})) == 0


# ---------------------------------------------------------------- no model

def test_a_line_calls_no_model(db, monkeypatch):
    from backend import ccgen, llm

    def boom(*a, **kw):
        raise AssertionError("a model was asked")
    monkeypatch.setattr(llm, "stream", boom)
    monkeypatch.setattr(ccgen, "spawn", boom)
    a = client(db, "u-ayse")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    r = a.post(f"/api/dm/chats/{cid}/messages", json={"text": "@Redline what is 2+2?"})
    assert r.status_code == 200, r.text
    msgs = a.get(f"/api/dm/chats/{cid}").json()["messages"]
    assert [m["text"] for m in msgs] == ["@Redline what is 2+2?"]
    assert "role" not in msgs[0] or msgs[0]["role"] != "assistant"


# ---------------------------------------------------------------- unread

def test_unread_is_counted_per_person_and_cleared_on_reading(db):
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    cid = b.post("/api/dm/chats", json={"people": ["u-ayse"]}).json()["id"]
    b.post(f"/api/dm/chats/{cid}/messages", json={"text": "one"})
    b.post(f"/api/dm/chats/{cid}/messages", json={"text": "two"})
    st = a.get("/api/dm/state").json()
    assert st["unread"]["total"] == 2
    assert [(s["id"], s["n"]) for s in st["unread"]["senders"]] == [("u-bora", 2)]
    assert next(p for p in st["people"] if p["id"] == "u-bora")["unread"] == 2
    assert st["people"][0]["id"] == "u-bora"                # who wrote comes first
    assert next(x for x in st["chats"] if x["id"] == cid)["unread"] == 2
    # The writer's own lines are never unread to them.
    assert b.get("/api/dm/state").json()["unread"]["total"] == 0
    assert a.post(f"/api/dm/chats/{cid}/read").status_code == 200
    assert a.get("/api/dm/state").json()["unread"]["total"] == 0
    # A line taken back is not unread any more either.
    mid = b.post(f"/api/dm/chats/{cid}/messages", json={"text": "oops"}).json()["id"]
    assert a.get("/api/dm/state").json()["unread"]["total"] == 1
    b.delete(f"/api/dm/chats/{cid}/messages/{mid}")
    assert a.get("/api/dm/state").json()["unread"]["total"] == 0


def test_edits_and_deletes_reach_the_list(db):
    a = client(db, "u-ayse")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    mid = a.post(f"/api/dm/chats/{cid}/messages", json={"text": "frist"}).json()["id"]
    r = a.patch(f"/api/dm/chats/{cid}/messages/{mid}", json={"text": "first"})
    assert r.json()["text"] == "first" and r.json()["edited_at"]
    assert a.get("/api/dm/state").json()["chats"][0]["last"]["text"] == "first"
    a.delete(f"/api/dm/chats/{cid}/messages/{mid}")
    assert a.get("/api/dm/state").json()["chats"][0]["last"] is None
    assert a.post(f"/api/dm/chats/{cid}/messages", json={"text": "  "}).status_code == 400


# ---------------------------------------------------------------- things sent along

def put(fake, ws: str, coll: str, doc: dict):
    run(scope.ScopedDb(fake, ws)[coll].insert_one(doc))


def test_a_sent_thing_is_data_taken_when_it_is_sent(db):
    put(db, space("u-ayse"), "models", {"_id": "fan/base", "title": "Fan base", "version": 3, "built": {"v": 3},
                                       "source": "x = 1\n"})
    put(db, space("u-ayse"), "taste_palettes", {"_id": "tp1", "name": "Quiet", "description": "calm", "items": [
        {"text": "matte", "domain": "mechanical", "strength": "must"}, {"text": "round", "strength": "prefer"}]})
    put(db, space("u-ayse"), "manufacturers", {"_id": "m1", "name": "Acme", "products": [
        {"id": "p1", "name": "Hinge 40", "sku": "H40", "price": {"amount": 12.5, "currency": "TRY"}}]})
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    r = a.post(f"/api/dm/chats/{cid}/messages", json={"text": "look", "items": [
        {"kind": "model", "id": "fan/base"}, {"kind": "taste", "id": "tp1"}, {"kind": "product", "id": "m1:p1"}]})
    assert r.status_code == 200, r.text
    mine = a.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"]
    assert [i["kind"] for i in mine] == ["model", "taste", "product"]
    assert mine[0]["id"] == "fan/base" and mine[0]["label"] == "Fan base" and "v3" in mine[0]["facts"]
    assert "2 statements" in mine[1]["facts"]
    assert mine[2]["label"] == "Hinge 40" and "Acme" in mine[2]["facts"] and mine[2]["open"]["maker"] == "m1"
    assert all(i["own"] and i["snap"] and "space" not in i for i in mine)
    # Bora's card: the snapshot to view and add - never where the original lives.
    theirs = b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"]
    assert [i["snap"] for i in theirs] == [i["snap"] for i in mine]
    assert all(not i["own"] and "id" not in i and "open" not in i and i["add"] for i in theirs)
    # The sender changes and then deletes the palette: what was sent stays as it was.
    src = scope.ScopedDb(db, space("u-ayse"))
    run(src["taste_palettes"].update_one({"_id": "tp1"}, {"$set": {"name": "Loud", "items": []}}))
    got = b.get(f"/api/dm/items/{theirs[1]['snap']}").json()
    assert got["data"]["name"] == "Quiet" and [i["text"] for i in got["data"]["items"]] == ["matte", "round"]
    run(src["taste_palettes"].delete_one({"_id": "tp1"}))
    assert b.get(f"/api/dm/items/{theirs[1]['snap']}").json()["data"]["description"] == "calm"
    assert b.get(f"/api/dm/items/{theirs[0]['snap']}").json()["data"]["models"]["fan/base"]["source"] == "x = 1\n"
    assert b.get(f"/api/dm/items/{theirs[2]['snap']}").json()["data"]["product"]["sku"] == "H40"


def test_only_the_conversation_reads_what_was_sent(db):
    put(db, space("u-ayse"), "notes", {"_id": "n1", "title": "Tolerances", "text": "0.2 mm"})
    a, b, c = client(db, "u-ayse"), client(db, "u-bora"), client(db, "u-cem")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "note", "id": "n1"}]})
    sid = b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"][0]["snap"]
    assert b.get(f"/api/dm/items/{sid}").json()["data"]["text"] == "0.2 mm"
    assert c.get(f"/api/dm/items/{sid}").status_code == 404
    assert c.get(f"/api/dm/items/{sid}/blob/file").status_code == 404
    assert c.post(f"/api/dm/items/{sid}/add").status_code == 404
    assert b.get("/api/dm/items/nope").status_code == 404
    # The rest of Ayşe's space stays hers.
    assert b.get("/api/dm/item", params={"kind": "note", "id": "n1"}).status_code == 404


def test_add_makes_a_new_thing_in_the_readers_space(db):
    put(db, space("u-ayse"), "taste_palettes", {"_id": "tp1", "name": "Quiet", "description": "calm", "items": [
        {"id": "s1", "text": "matte", "domain": "mechanical", "strength": "must",
         "source": {"kind": "model", "id": "fan/base", "label": "Fan base"}}]})
    put(db, space("u-ayse"), "notes", {"_id": "n1", "title": "Tolerances", "text": "# Tolerances\n0.2 mm"})
    put(db, space("u-ayse"), "inventory", {"_id": "i1", "name": "M3 screw", "quantity": 40, "unit": "pcs"})
    put(db, space("u-ayse"), "manufacturers", {"_id": "m1", "name": "Acme", "domain": "acme.com", "url": "https://acme.com/",
                                              "products": [{"id": "p1", "name": "Hinge 40", "url": "https://acme.com/h40"}]})
    put(db, space("u-bora"), "taste_palettes", {"_id": "mine", "name": "Quiet", "items": []})
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    a.post(f"/api/dm/chats/{cid}/messages", json={"items": [
        {"kind": "taste", "id": "tp1"}, {"kind": "note", "id": "n1"}, {"kind": "inventory", "id": "i1"},
        {"kind": "product", "id": "m1:p1"}]})
    snaps = [i["snap"] for i in b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"]]
    bdb = scope.ScopedDb(db, space("u-bora"))
    r = b.post(f"/api/dm/items/{snaps[0]}/add")
    assert r.status_code == 200, r.text
    tp = run(bdb["taste_palettes"].find_one({"_id": r.json()["id"]}))
    assert tp["name"] == "Quiet (2)" and r.json()["label"] == "Quiet (2)"      # Bora had a Quiet already
    assert tp["items"][0]["text"] == "matte" and tp["items"][0]["source"] == "manual"
    assert tp["by"]["id"] == "u-bora" and tp["workspace_id"] == space("u-bora")
    note = run(bdb["notes"].find_one({"_id": b.post(f"/api/dm/items/{snaps[1]}/add").json()["id"]}))
    assert "0.2 mm" in note["text"]
    item = run(bdb["inventory"].find_one({"_id": b.post(f"/api/dm/items/{snaps[2]}/add").json()["id"]}))
    assert item["name"] == "M3 screw" and item["quantity"] == 0      # what it is, not the sender's stock
    got = b.post(f"/api/dm/items/{snaps[3]}/add").json()
    maker = run(bdb["manufacturers"].find_one({"_id": got["maker"]}))
    assert maker["domain"] == "acme.com" and [p["name"] for p in maker["products"]] == ["Hinge 40"]
    assert b.post(f"/api/dm/items/{snaps[3]}/add").json()["already"] is True
    # The sender's own things are untouched.
    assert run(scope.ScopedDb(db, space("u-ayse"))["inventory"].find_one({"_id": "i1"}))["quantity"] == 40


def test_a_snapshot_goes_with_its_line_or_when_taken_back(db):
    put(db, space("u-ayse"), "notes", {"_id": "n1", "title": "Tolerances", "text": "0.2 mm"})
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "note", "id": "n1"}]})
    two = a.post(f"/api/dm/chats/{cid}/messages", json={"text": "again", "items": [{"kind": "note", "id": "n1"}]}).json()
    one_sid = b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"][0]["snap"]
    two_sid = two["items"][0]["snap"]
    assert b.post(f"/api/dm/items/{one_sid}/unshare").status_code == 403      # only the sender
    assert a.post(f"/api/dm/items/{one_sid}/unshare").status_code == 200
    assert b.get(f"/api/dm/items/{one_sid}").status_code == 404
    assert b.post(f"/api/dm/items/{one_sid}/add").status_code == 404
    assert b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"][0] == \
        {"kind": "note", "label": "Tolerances", "revoked": True}
    assert b.get(f"/api/dm/items/{two_sid}").status_code == 200
    a.delete(f"/api/dm/chats/{cid}/messages/{two['id']}")
    assert b.get(f"/api/dm/items/{two_sid}").status_code == 404
    assert run(db[dm.ITEMS].count_documents({})) == 0


def test_a_file_is_sent_as_its_bytes(db, monkeypatch):
    from backend import files
    blobs = {"g1": b"hello,world\n"}

    async def get(dbx, fid):
        d = await dbx[files.COLL].find_one({"_id": fid})
        if not d:
            raise KeyError(fid)
        return d, blobs[d["gridfs_id"]]

    async def put_file(dbx, name, data, ctype, ctx, by, note="", folder=""):
        doc = {"_id": "f" + str(len(blobs)), "name": name, "bytes": len(data), "content_type": ctype, "kind": "table",
               "gridfs_id": "g" + str(len(blobs) + 1), "by": by, "note": note, "folder": folder}
        blobs[doc["gridfs_id"]] = data
        await dbx[files.COLL].insert_one(doc)
        return doc
    monkeypatch.setattr(files, "get", get)
    monkeypatch.setattr(files, "put", put_file)
    put(db, space("u-ayse"), "files", {"_id": "f0", "name": "bom.csv", "bytes": 12, "kind": "table",
                                      "content_type": "text/csv", "gridfs_id": "g1"})
    a, b, c = client(db, "u-ayse"), client(db, "u-bora"), client(db, "u-cem")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    sid = a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "file", "id": "f0"}]}).json()["items"][0]["snap"]
    blobs["g1"] = b"changed later"                                # the original changes: what was sent does not
    assert b.get(f"/api/dm/items/{sid}/blob/file").content == b"hello,world\n"
    shown = b.get(f"/api/dm/items/{sid}").json()["data"]
    assert shown["preview"] == "table" and shown["text"] == "hello,world\n"      # the viewer shows it as the Files tab would
    assert c.get(f"/api/dm/items/{sid}/blob/file").status_code == 404
    put(db, space("u-bora"), "files", {"_id": "fx", "name": "bom.csv", "folder": ""})
    got = b.post(f"/api/dm/items/{sid}/add").json()
    assert got["label"] == "bom (2).csv"
    monkeypatch.setattr(dm, "MAX_BLOB", 4)
    assert a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "file", "id": "f0"}]}).status_code == 413


def test_only_what_the_sender_can_see_can_be_sent(db):
    put(db, space("u-bora"), "models", {"_id": "bora/secret", "title": "Bora's secret"})
    a = client(db, "u-ayse")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    r = a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "model", "id": "bora/secret"}]})
    assert r.status_code == 404 and "secret" not in r.json()["detail"].replace("bora/secret", "")
    assert a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "rocket", "id": "x"}]}).status_code == 400
    assert a.get("/api/dm/item", params={"kind": "model", "id": "bora/secret"}).status_code == 404
    assert a.get(f"/api/dm/chats/{cid}").json()["messages"] == []
    # What can be sent is one's own.
    put(db, space("u-ayse"), "inventory", {"_id": "i1", "name": "M3 screw", "quantity": 40, "unit": "pcs"})
    got = a.get("/api/dm/shareables", params={"q": "screw"}).json()
    assert [(x["kind"], x["id"]) for x in got] == [("inventory", "i1")]
    assert a.get("/api/dm/shareables", params={"q": "secret"}).json() == []


def test_the_live_stream_carries_each_reader_their_own_card(db):
    put(db, space("u-ayse"), "notes", {"_id": "n1", "title": "Tolerances", "text": "0.2 mm"})
    a = client(db, "u-ayse")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    qa, qb, qc = (cc_chat.HUB.subscribe(dm.key(u)) for u in ("u-ayse", "u-bora", "u-cem"))
    a.post(f"/api/dm/chats/{cid}/messages", json={"text": "see", "items": [{"kind": "note", "id": "n1"}]})
    ea, eb = qa.get_nowait(), qb.get_nowait()
    assert ea["type"] == eb["type"] == "message" and ea["chat"] == cid
    assert ea["message"]["items"][0]["id"] == "n1"
    assert eb["message"]["items"][0]["snap"] == ea["message"]["items"][0]["snap"]
    assert ea["message"]["items"][0]["own"] and not eb["message"]["items"][0]["own"]
    assert qc.empty()                                      # not a member: told nothing
    assert dm.online("u-bora") and not dm.online("u-gone")


def test_a_picture_is_seen_by_those_one_writes_to(db):
    run(db["users"].update_one({"_id": "u-bora"}, {"$set": {"avatar": b"\xff\xd8jpeg", "avatar_v": 7}}))
    a, c = client(db, "u-ayse"), client(db, "u-cem")
    cem_admin_sees = c.get("/api/me/avatar/u-bora")
    assert cem_admin_sees.status_code == 200                     # the admin panel's rule, unchanged
    assert a.get("/api/me/avatar/u-bora").status_code == 404     # a stranger's, not yet
    row = next(p for p in a.get("/api/dm/state").json()["people"] if p["id"] == "u-bora")
    assert row["has_avatar"] is False                            # initials, no refused request
    a.post("/api/dm/chats", json={"people": ["u-bora"]})
    assert a.get("/api/me/avatar/u-bora").status_code == 200
    row = next(p for p in a.get("/api/dm/state").json()["people"] if p["id"] == "u-bora")
    assert row["has_avatar"] is True and row["avatar_v"] == 7


def test_a_model_is_sent_with_the_models_it_imports(db):
    src = scope.ScopedDb(db, space("u-ayse"))
    run(src["models"].insert_one({"_id": "fan/base", "title": "Fan base", "source": "from fan.lid import lid\nx = 1\n",
                                  "uses": [{"kind": "model", "id": "fan/lid"}]}))
    run(src["models"].insert_one({"_id": "fan/lid", "title": "Lid", "source": "lid = 2\n"}))
    run(src["models"].insert_one({"_id": "fan/other", "title": "Other", "source": "y = 3\n"}))
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    sid = a.post(f"/api/dm/chats/{cid}/messages", json={"items": [{"kind": "model", "id": "fan/base"}]}).json()["items"][0]["snap"]
    shown = b.get(f"/api/dm/items/{sid}").json()["data"]
    assert sorted(shown["models"]) == ["fan/base", "fan/lid"]
    r = b.post(f"/api/dm/items/{sid}/add")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == "fan/base" and sorted(r.json()["models"]) == ["fan/base", "fan/lid"]
    bdb = scope.ScopedDb(db, space("u-bora"))
    assert sorted(d["_id"] for d in run(bdb["models"].find({}).to_list())) == ["fan/base", "fan/lid"]
    # Again: a free name beside it, the imported one kept.
    again = b.post(f"/api/dm/items/{sid}/add").json()
    assert again["id"] == "fan/base_2" and again["kept"] == ["fan/lid"]


def test_a_line_from_before_snapshots_gets_one_when_read(db):
    put(db, space("u-ayse"), "taste_palettes", {"_id": "tp1", "name": "3D Project Design Taste", "items": [{"text": "x"}]})
    a, b = client(db, "u-ayse"), client(db, "u-bora")
    cid = a.post("/api/dm/chats", json={"people": ["u-bora"]}).json()["id"]
    run(db[dm.MSGS].insert_one({"_id": "old1", "chat": cid, "by": {"id": "u-ayse", "name": "Ayşe"}, "at": "2026-10-12T10:00:00+00:00",
                                "text": "", "items": [{"kind": "taste", "id": "tp1", "label": "3D Project Design Taste",
                                                       "facts": [], "space": space("u-ayse")}]}))
    card = b.get(f"/api/dm/chats/{cid}").json()["messages"][0]["items"][0]
    assert card["snap"] and card["add"] and not card["own"]
    assert b.get(f"/api/dm/items/{card['snap']}").json()["data"]["items"][0]["text"] == "x"
    assert b.post(f"/api/dm/items/{card['snap']}/add").status_code == 200


def test_a_board_is_sent_with_its_figures_never_as_raw_text():
    """The viewer draws tiles, checks, rules and the BOM from these, not from the agents' context lines."""
    d = {"layout": {"placed": 3, "size_mm": [40, 30], "holes": [{"ref": "H1"}]},
         "route": {"tracks": 20, "vias": 2, "length_mm": 120.5, "zones": 1, "unrouted": 0, "engine": "freerouting"},
         "drc": {"error_count": 1, "warning_count": 2, "errors": {"clearance": 1}, "warnings": {"silk_overlap": 2},
                 "examples": ["Clearance - Pad 1 of U1 / Track"]},
         "schematic": {"parts": 3, "wires": 9, "symbols": 2, "sheets": [{"name": "Power", "parts": 3, "refs": ["U1"]}],
                       "erc": {"error_count": 0, "warning_count": 0, "errors": {}, "warnings": {}}},
         "rules": {"classes": [{"name": "Default", "track": 0.25, "clearance": 0.15, "via": 0.6, "drill": 0.3, "nets": []}],
                   "board": {"layers": 2, "min_track": 0.15}, "pours": [{"net": "GND", "layers": ["F.Cu"]}]},
         "component": {"version": 4, "summary": {"thickness": 1.6}}}
    graph = {"counts": {"components": 3, "nets": 2}, "nets": [{"name": "GND", "nodes": [1, 2, 3]}, {"name": "NC", "nodes": [1]}],
             "bom": [{"designator": "R1, R2", "comment": "10k", "footprint": "0402", "lcsc": "C25744"}]}
    f = dm._board_facts(d, graph)
    assert f["layout"] == {"placed": 3, "size_mm": [40, 30], "holes": 1, "at": None}
    assert f["drc"]["errors"] == {"clearance": 1} and f["drc"]["examples"] == ["Clearance - Pad 1 of U1 / Track"]
    assert f["erc"]["error_count"] == 0 and f["schematic"]["sheets"] == [{"key": None, "name": "Power", "parts": 3}]
    assert f["rules"]["classes"][0]["name"] == "Default" and f["rules"]["board"]["layers"] == 2
    assert f["nets"][0] == {"name": "GND", "pins": 3} and f["single"] == ["NC"] and f["net_count"] == 2
    assert f["bom"] == [{"ref": "R1, R2", "value": "10k", "footprint": "0402", "lcsc": "C25744"}]
    assert f["thickness"] == 1.6 and f["version"] == 4
    assert dm._board_facts({}, None)["version"] is None                       # a board never laid out or built
