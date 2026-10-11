"""Taste palettes (backend/taste.py): named lists of design statements, kept
per workspace, attached to projects, handed to the agents, and proposed
from a finished project by a model - never saved without review."""

from __future__ import annotations

import asyncio

import pytest

from backend import access, cc_context, llm, taste
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401  (the fixture)


def run(c):
    return asyncio.run(c)


ITEMS = [
    {"text": "Walls 2 mm, outside edges filleted 1 mm", "domain": "mechanical", "strength": "must"},
    {"text": "Self-tapping screws into PLA", "domain": "mechanical", "strength": "avoid", "why": "they strip"},
    {"text": "Decoupling caps within 2 mm of the pin", "domain": "pcb", "strength": "prefer"},
]


# ---------------------------------------------------------------- the API

def test_a_palette_from_start_to_finish(db):  # noqa: F811
    a = person(db, "a")
    p = a.post("/api/taste", json={"name": "Compact IoT enclosures", "items": ITEMS[:1]}).json()
    assert p["name"] == "Compact IoT enclosures" and p["by"]["id"] == "a"
    assert p["counts"] == {"mechanical": 1, "pcb": 0, "firmware": 0, "general": 0}
    pid = p["id"]
    # Items: added (several at once), edited, reordered, removed.
    p = a.post(f"/api/taste/{pid}/items", json={"items": ITEMS[1:]}).json()
    assert [i["text"] for i in p["items"]] == [i["text"] for i in ITEMS]
    assert p["items"][1]["why"] == "they strip" and p["items"][1]["source"] == "manual"
    first, second, third = (i["id"] for i in p["items"])
    p = a.patch(f"/api/taste/{pid}/items/{third}", json={"strength": "must", "domain": "nonsense"}).json()
    assert p["items"][2]["strength"] == "must" and p["items"][2]["domain"] == "general"
    p = a.put(f"/api/taste/{pid}/order", json={"ids": [third, first]}).json()
    assert [i["id"] for i in p["items"]] == [third, first, second]
    p = a.delete(f"/api/taste/{pid}/items/{first}").json()
    assert [i["id"] for i in p["items"]] == [third, second]
    # Renamed, described, pinned; listed; found by an item's words.
    p = a.patch(f"/api/taste/{pid}", json={"name": "Enclosures", "description": "printed", "pinned": True}).json()
    assert (p["name"], p["description"], p["pinned"]) == ("Enclosures", "printed", True)
    assert [x["id"] for x in a.get("/api/taste").json()] == [pid]
    assert [x["id"] for x in a.get("/api/taste?q=self-tapping").json()] == [pid]
    assert a.get("/api/taste?q=bluetooth").json() == []
    assert a.get(f"/api/taste/{pid}").json()["name"] == "Enclosures"
    assert a.delete(f"/api/taste/{pid}").json() == {"deleted": pid}
    assert a.get(f"/api/taste/{pid}").status_code == 404


def test_an_item_needs_words(db):  # noqa: F811
    a = person(db, "a")
    pid = a.post("/api/taste", json={"name": "x"}).json()["id"]
    assert a.post(f"/api/taste/{pid}/items", json={"items": [{"text": ""}]}).status_code == 422
    assert a.patch(f"/api/taste/{pid}/items/nope", json={"text": "y"}).status_code == 404


def test_each_workspace_has_its_own(db):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    pid = a.post("/api/taste", json={"name": "mine", "items": ITEMS}).json()["id"]
    assert b.get("/api/taste").json() == []
    assert b.get(f"/api/taste/{pid}").status_code == 404
    assert b.patch(f"/api/taste/{pid}", json={"name": "taken"}).status_code == 404
    assert b.delete(f"/api/taste/{pid}").status_code == 404
    assert a.get(f"/api/taste/{pid}").json()["name"] == "mine"


def test_attached_to_a_project_of_the_workspace_only(db):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    a.post("/api/taste", json={"name": "tmp"})                   # the space exists
    ws_a = next(iter(db["taste_palettes"].docs.values()))["workspace_id"]
    from backend import scope
    mine = scope.ScopedDb(db, ws_a)
    run(mine["models"].insert_one({"_id": "case", "title": "Fan case"}))
    run(mine["boards"].insert_one({"_id": "ctl", "title": "Controller"}))
    pid = a.post("/api/taste", json={"name": "Enclosures", "items": ITEMS}).json()["id"]
    p = a.put(f"/api/taste/{pid}/attached", json={"attached": [{"kind": "model", "id": "case"},
                                                               {"kind": "board", "id": "ctl"}]}).json()
    assert p["attached"] == [{"kind": "model", "id": "case", "label": "Fan case"},
                             {"kind": "board", "id": "ctl", "label": "Controller"}]
    got = a.get("/api/taste/attached?kind=model&id=case").json()
    assert [x["id"] for x in got["palettes"]] == [pid]
    assert 'palette "Enclosures"' in got["text"] and "MUST: Walls 2 mm" in got["text"]
    assert a.get("/api/taste/attached?kind=firmware&id=case").json()["palettes"] == []
    # Another space's model is not there to attach to.
    q = b.post("/api/taste", json={"name": "b's"}).json()["id"]
    assert b.put(f"/api/taste/{q}/attached", json={"attached": [{"kind": "model", "id": "case"}]}).status_code == 404
    assert {r["id"] for r in a.get("/api/taste/projects").json()} == {"case", "ctl"}
    assert b.get("/api/taste/projects").json() == []


# ---------------------------------------------------------------- who may

def test_page_sessions_only_read_and_viewers_do_not_write():
    for m, p in (("POST", "/api/taste"), ("PATCH", "/api/taste/p1"), ("DELETE", "/api/taste/p1"),
                 ("POST", "/api/taste/p1/items"), ("PATCH", "/api/taste/p1/items/i1"),
                 ("DELETE", "/api/taste/p1/items/i1"), ("PUT", "/api/taste/p1/order"),
                 ("PUT", "/api/taste/p1/attached"), ("POST", "/api/taste/extract")):
        assert not access.page_allowed(m, p), (m, p)
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))
    for p in ("/api/taste", "/api/taste/p1", "/api/taste/projects", "/api/taste/attached"):
        assert access.page_allowed("GET", p)


def test_someone_elses_palette_is_deleted_only_with_the_right(db, monkeypatch):  # noqa: F811
    from backend import actors
    fake = FakeDb()
    doc = run(taste.create(fake, "theirs", by={"id": "x", "name": "X"}))
    monkeypatch.setattr(taste, "_db", lambda: fake)
    monkeypatch.setattr(actors, "current", lambda: {"id": "me", "type": "user"})
    monkeypatch.setattr(access, "current", lambda: "reviewer")
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        run(taste.api_delete(doc["_id"]))
    assert e.value.status_code == 403
    monkeypatch.setattr(access, "current", lambda: "editor")
    assert run(taste.api_delete(doc["_id"])) == {"deleted": doc["_id"]}


# ---------------------------------------------------------------- what the agent reads

def test_the_block_groups_by_domain_must_first():
    doc = {"_id": "p", "name": "IoT", "items": [
        {"id": "1", "text": "Prefer Wi-Fi off when idle", "domain": "firmware", "strength": "prefer"},
        {"id": "2", "text": "Vias in pads", "domain": "pcb", "strength": "avoid", "why": "solder wicks"},
        {"id": "3", "text": "Every task feeds the watchdog", "domain": "firmware", "strength": "must"},
        {"id": "4", "text": "Walls 2 mm", "domain": "mechanical", "strength": "must"}]}
    text = taste.block(doc)
    assert text.splitlines() == [
        'Design taste to follow (palette "IoT"):',
        "Mechanical:", "- MUST: Walls 2 mm",
        "PCB:", "- AVOID: Vias in pads (why: solder wicks)",
        "Firmware:", "- MUST: Every task feeds the watchdog", "- PREFER: Prefer Wi-Fi off when idle"]


def test_a_long_palette_is_clipped_and_says_so():
    doc = {"_id": "p", "name": "big", "items": [
        {"id": str(n), "text": f"statement number {n} " + "x" * 80, "domain": "general", "strength": "must"}
        for n in range(200)]}
    text = taste.block(doc, 2000)
    assert len(text) < 2100 and text.endswith("more items of this palette left out]")


def test_a_palette_is_a_mention_and_rides_along_with_its_project():
    fake = FakeDb()
    run(fake["models"].insert_one({"_id": "case", "title": "Fan case", "version": 3, "source": "box = Box(1,1,1)"}))
    p = run(taste.create(fake, "Enclosures", items=ITEMS, by={"id": "a", "name": "A"}))
    run(taste.attach(fake, p["_id"], [{"kind": "model", "id": "case"}]))
    assert "taste" in cc_context.KINDS
    rows = run(cc_context.candidates(fake, "enclos", "taste"))
    assert rows[0]["kind"] == "taste" and rows[0]["label"] == "Enclosures" and "3 items" in rows[0]["sub"]
    # Mentioned on its own.
    text, chips, _ = run(cc_context.expand(fake, [{"kind": "taste", "id": p["_id"]}], vision=False))
    assert 'kind="taste"' in text and "MUST: Walls 2 mm" in text and "should follow it" in text
    assert chips[0]["kind"] == "taste" and not chips[0].get("auto")
    # The model mentioned: its palette comes too, marked as such.
    text, chips, _ = run(cc_context.expand(fake, [{"kind": "model", "id": "case"}], vision=False))
    assert [c["kind"] for c in chips] == ["model", "taste"]
    assert chips[1]["auto"] and chips[1]["via"] == "model case"
    assert "AVOID: Self-tapping screws into PLA (why: they strip)" in text
    # Mentioned and attached: once.
    _, chips, _ = run(cc_context.expand(fake, [{"kind": "model", "id": "case"}, {"kind": "taste", "id": p["_id"]}],
                                        vision=False))
    assert [c["kind"] for c in chips] == ["model", "taste"] and not chips[1].get("auto")


def test_a_room_agent_reads_the_palettes_of_its_notes_project():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    import revisions
    assert revisions._note_projects({"kind": "pcb", "model": "ctl"}) == [("board", "ctl")]
    assert revisions._note_projects({"kind": "cad", "model": "case"}) == [("model", "case")]
    assert revisions._note_projects({"kind": "firmware", "model": "fw1"}) == [("firmware", "fw1")]
    fake = FakeDb()
    run(fake["models"].insert_one({"_id": "case", "title": "Fan case"}))
    p = run(taste.create(fake, "Enclosures", items=ITEMS, by={"id": "a"}))
    run(taste.attach(fake, p["_id"], [{"kind": "model", "id": "case"}]))
    text = taste.agent_text(run(taste.attached_to(fake, "model", "case")))
    assert "MUST: Walls 2 mm" in text and "never do AVOID items" in text


# ---------------------------------------------------------------- extraction

SRC = {"kind": "model", "id": "case", "label": "Fan case"}


def test_proposals_are_read_out_of_what_the_model_wrote():
    raw = ('Here you go:\n```json\n[{"text": "Walls 2 mm", "domain": "mechanical", "strength": "must", "why": "stiff"},'
           ' {"text": "walls 2 mm", "domain": "mechanical"},'
           ' {"text": "  Heat-set inserts  ", "domain": "Mechanical", "strength": "PREFER"},'
           ' {"text": "", "domain": "pcb"}, "Label every connector", 7]\n```')
    got = taste.parse_proposals(raw, SRC)
    assert [(i["text"], i["domain"], i["strength"]) for i in got] == [
        ("Walls 2 mm", "mechanical", "must"), ("Heat-set inserts", "mechanical", "prefer"),
        ("Label every connector", "general", "prefer")]
    assert got[0]["why"] == "stiff" and got[0]["source"] == SRC
    assert len({i["id"] for i in got}) == 3
    assert [i["text"] for i in taste.parse_proposals('{"items": [{"text": "a"}]}', SRC)] == ["a"]
    assert len(taste.parse_proposals(str([{"text": f"t{n}"} for n in range(40)]).replace("'", '"'), SRC)) == 20
    with pytest.raises(ValueError):
        taste.parse_proposals("I cannot help with that.", SRC)


def _project(fake):
    run(fake["models"].insert_one({"_id": "case", "title": "Fan case", "version": 2,
                                   "source": "wall = 2.0\nbox = Box(60, 40, 20)"}))
    run(fake["revisions"].insert_one({"_id": "r1", "model": "case", "comment": "make the walls 2 mm, they flex",
                                      "status": "applied", "created_at": "2026-10-01"}))
    run(fake["notes"].insert_one({"_id": "n1", "text": "use M3 heat-set inserts", "context": {"model": "case"}}))


def test_extraction_reads_the_project_and_saves_nothing(monkeypatch):
    fake = FakeDb()
    _project(fake)
    seen = {}

    async def complete(messages, **kw):
        seen["messages"], seen["kw"] = messages, kw
        return {"choices": [{"message": {"content": '[{"text": "Walls 2 mm", "domain": "mechanical", '
                                                    '"strength": "must", "why": "they flexed at 1.2"}]'}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "provider": "commandcode", "model": "m"}

    recorded = []

    async def record(db, **kw):
        recorded.append(kw)

    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", record)
    got = run(taste.extract(fake, "model", "case"))
    assert got["project"] == SRC and got["proposals"][0]["text"] == "Walls 2 mm"
    assert got["proposals"][0]["source"] == SRC
    user = seen["messages"][1]["content"]
    assert "wall = 2.0" in user and "they flex" in user and "heat-set inserts" in user
    assert seen["kw"]["job"] == taste.JOB
    assert recorded and recorded[0]["kind"] == "taste"
    assert fake["taste_palettes"].docs == {}                    # proposals only


def test_extraction_says_what_is_wrong(monkeypatch):
    fake = FakeDb()
    _project(fake)
    monkeypatch.setattr(llm, "key", lambda p: None)
    with pytest.raises(taste.ExtractError, match="Settings > LLM settings"):
        run(taste.extract(fake, "model", "case"))
    with pytest.raises(LookupError):
        run(taste.extract(fake, "board", "nope"))

    async def boom(messages, **kw):
        raise RuntimeError("HTTP 500 upstream")

    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "complete", boom)
    with pytest.raises(taste.ExtractError, match="HTTP 500 upstream"):
        run(taste.extract(fake, "model", "case"))

    async def prose(messages, **kw):
        return {"choices": [{"message": {"content": "Sorry, no."}}], "usage": {}}

    async def record(db, **kw):
        pass

    monkeypatch.setattr(llm, "complete", prose)
    monkeypatch.setattr(llm, "record", record)
    with pytest.raises(taste.ExtractError, match="JSON"):
        run(taste.extract(fake, "model", "case"))


def test_extraction_through_the_api_refuses_plainly(db, monkeypatch):  # noqa: F811
    a = person(db, "a")
    monkeypatch.setattr(llm, "key", lambda p: None)
    assert a.post("/api/taste/extract", json={"kind": "model", "id": "nope"}).status_code == 404
    assert a.post("/api/taste/extract", json={"kind": "drawing", "id": "x"}).status_code == 422


def test_reviewed_proposals_are_saved_with_their_source(db):  # noqa: F811
    a = person(db, "a")
    p = a.post("/api/taste", json={"name": "From the fan case", "items": [
        {"text": "Walls 2 mm", "domain": "mechanical", "strength": "must", "source": SRC}]}).json()
    assert p["items"][0]["source"] == SRC


def test_taste_is_a_job_in_the_llm_settings():
    assert llm.JOBS[taste.JOB]["label"] == "Taste extraction"
    assert llm.job_label("taste") == "Taste extraction"


def test_a_folder_is_read_whole_bought_parts_left_out(monkeypatch):
    fake = FakeDb()
    run(fake["models"].insert_one({"_id": "fan/parts/lid", "folder": "fan/parts", "title": "Lid", "source": "lid = 2.4"}))
    run(fake["models"].insert_one({"_id": "fan/purchased/m3", "folder": "fan/purchased", "title": "M3", "source": "screw"}))
    run(fake["models"].insert_one({"_id": "other/x", "folder": "other", "title": "X", "source": "elsewhere"}))
    run(fake["boards"].insert_one({"_id": "ctl", "folder": "fan/electronics", "title": "Controller", "source": "i2c = 400k"}))
    assert run(taste.folder_projects(fake, "fan")) == [("model", "fan/parts/lid"), ("board", "ctl")]
    rows = {f["id"]: f["sub"] for f in run(taste.folder_list(fake))}
    assert rows["fan"] == "1 model · 1 board" and "fan/purchased" not in rows
    assert [r["kind"] for r in run(taste.projects(fake, "fan", folders=True))][:1] == ["folder"]
    assert all(r["kind"] != "folder" for r in run(taste.projects(fake, "fan")))
    seen = {}

    async def complete(messages, **kw):
        seen["messages"], seen["kw"] = messages, kw
        return {"choices": [{"message": {"content": str([{"text": f"rule {n}", "domain": "pcb"} for n in range(50)])
                                         .replace("'", '"')}}], "usage": {}}

    async def record(db, **kw):
        pass

    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", record)
    got = run(taste.extract(fake, "folder", "fan"))
    user = seen["messages"][1]["content"]
    assert "lid = 2.4" in user and "Controller" in user and "screw" not in user and "elsewhere" not in user
    assert "whole project folder" in seen["messages"][0]["content"]
    assert len(got["proposals"]) == taste.FOLDER_PROPOSALS[1]
    assert got["proposals"][0]["source"] == {"kind": "folder", "id": "fan", "label": "fan"}
    with pytest.raises(LookupError):
        run(taste.extract(fake, "folder", "nothing-here"))
