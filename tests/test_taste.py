"""Taste palettes (backend/taste.py): named lists of design statements, kept
per workspace, attached to projects, handed to the agents, and proposed
from a finished project by a model - never saved without review."""

from __future__ import annotations

import asyncio
import json

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
    assert p["counts"] == {"form": 0, "mechanical": 1, "pcb": 0, "firmware": 0, "general": 0}
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
    assert [{k: a[k] for k in ("kind", "id", "label")} for a in p["attached"]] == [
        {"kind": "model", "id": "case", "label": "Fan case"}, {"kind": "board", "id": "ctl", "label": "Controller"}]
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
        'Design taste to follow (palette "IoT"):', "Priority: " + taste.PRIORITY,
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
    assert len(taste.parse_proposals(str([{"text": f"t{n}"} for n in range(40)]).replace("'", '"'), SRC)) == 30
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
    assert a.post("/api/taste/extract", json={"kind": "folder", "id": "nope"}).status_code == 404
    assert a.put("/api/taste/x/attached", json={"attached": [{"kind": "folder", "id": "f"}]}).status_code == 422


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


# ---------------------------------------------------------------- extraction as a job

def _answer(text='[{"text": "Walls 2 mm", "domain": "mechanical", "strength": "must"},'
                 ' {"text": "walls 2 mm"}, {"text": ""}]', usage=None):
    async def complete(messages, **kw):
        return {"choices": [{"message": {"content": text}}], "usage": usage or {"prompt_tokens": 900,
                                                                                "completion_tokens": 120},
                "provider": "commandcode", "model": "m"}
    return complete


async def _nothing(db, **kw):
    pass


def _mock_llm(monkeypatch, complete):
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", _nothing)
    monkeypatch.setattr(llm, "route", lambda job: ("commandcode", "m"))


def _until_done(fake, jid):
    async def go():
        t = taste._TASKS.get(jid)
        if t:
            await t
        return await taste.job(fake, jid)
    return go


def test_the_steps_are_told_as_they_happen(monkeypatch):
    fake = FakeDb()
    _project(fake)
    _mock_llm(monkeypatch, _answer())
    track = taste.Tracker()
    got = run(taste.extract(fake, "model", "case", track))
    assert [s["id"] for s in track.steps] == ["read:model:case", "ask", "parse"]
    read, ask, parse = track.steps
    assert read["state"] == "done" and read["project"]["label"] == "Fan case" and read["chars"] > 20
    assert read["revisions"] == 1 and read["notes"] == 1 and read["clipped"] is False
    assert ask["state"] == "done" and ask["provider"] == "commandcode" and ask["model"] == "m"
    assert ask["prompt_chars"] > read["chars"] and ask["tokens_in"] == 900 and ask["sent_at"]
    assert parse == {**parse, "state": "done", "parsed": 1, "rows": 3, "duplicates": 1, "invalid": 1}
    assert all("seconds" in s and s["finished_at"] for s in track.steps)
    assert track.totals["tokens_out"] == 120 and track.totals["projects"] == 1
    assert len(got["proposals"]) == 1


def test_a_folder_run_has_a_step_per_project(monkeypatch):
    fake = FakeDb()
    run(fake["models"].insert_one({"_id": "fan/lid", "folder": "fan", "title": "Lid", "source": "x" * 9000}))
    run(fake["boards"].insert_one({"_id": "ctl", "folder": "fan", "title": "Controller", "source": "i2c"}))
    _mock_llm(monkeypatch, _answer())
    monkeypatch.setattr(taste, "FOLDER_CHARS", 8_000)
    track = taste.Tracker()
    run(taste.extract(fake, "folder", "fan", track))
    reads = [s for s in track.steps if s["kind"] == "read"]
    assert [s["project"]["label"] for s in reads] == ["Lid", "Controller"]
    assert reads[0]["clipped"] is True and reads[0]["state"] == "done"
    assert track.totals["projects"] == 2


def test_a_job_runs_in_the_background_and_keeps_its_proposals(monkeypatch):
    fake = FakeDb()
    _project(fake)
    _mock_llm(monkeypatch, _answer())

    async def go():
        doc, started = await taste.start_job(fake, "model", "case", {"id": "a", "name": "A"})
        assert started and doc["status"] == "queued"
        again, started2 = await taste.start_job(fake, "model", "case")
        assert not started2 and again["_id"] == doc["_id"]          # the same run, not a second
        return await _until_done(fake, doc["_id"])()

    d = run(go())
    assert d["status"] == "done" and d["finished_at"] and d["seconds"] is not None
    assert [s["id"] for s in d["steps"]] == ["read:model:case", "ask", "parse", "done"]
    assert d["proposals"][0]["text"] == "Walls 2 mm" and d["by"]["id"] == "a"
    out = taste.job_out(d)
    assert out["count"] == 1 and out["proposals"] and "worker" not in out
    assert "proposals" not in taste.job_out(d, full=False)
    assert fake["taste_palettes"].docs == {}


def test_a_failed_job_says_why_on_the_step_and_the_run(monkeypatch):
    fake = FakeDb()
    _project(fake)

    async def boom(messages, **kw):
        raise RuntimeError("HTTP 500 upstream")

    _mock_llm(monkeypatch, boom)

    async def go():
        doc, _ = await taste.start_job(fake, "model", "case")
        return await _until_done(fake, doc["_id"])()

    d = run(go())
    assert d["status"] == "failed" and "HTTP 500 upstream" in d["error"]
    ask = next(s for s in d["steps"] if s["id"] == "ask")
    assert ask["state"] == "failed" and "HTTP 500 upstream" in ask["reason"]
    assert next(s for s in d["steps"] if s["kind"] == "read")["state"] == "done"

    import httpx

    async def slow(messages, **kw):
        raise httpx.ReadTimeout("")

    monkeypatch.setattr(llm, "complete", slow)
    d = run(go())
    assert d["status"] == "failed" and "did not answer within 180 s" in d["error"]


def test_a_job_can_be_cancelled(monkeypatch):
    fake = FakeDb()
    _project(fake)

    async def forever(messages, **kw):
        await asyncio.sleep(60)

    _mock_llm(monkeypatch, forever)

    async def go():
        doc, _ = await taste.start_job(fake, "model", "case")
        for _ in range(50):
            await asyncio.sleep(0.01)
            if (await taste.job(fake, doc["_id"]))["status"] == "asking":
                break
        d = await taste.cancel_job(fake, doc["_id"], {"id": "a"})
        assert d["status"] == "cancelled"
        await asyncio.sleep(0.05)
        return await taste.job(fake, doc["_id"])

    d = run(go())
    assert d["status"] == "cancelled" and d["cancelled_by"] == {"id": "a"} and not d["error"]
    assert next(s for s in d["steps"] if s["id"] == "ask")["state"] == "cancelled"
    assert d["_id"] not in taste._TASKS


def test_a_job_left_running_by_a_restart_fails_plainly(monkeypatch):
    fake = FakeDb()
    old = {"host": taste.WORKER["host"], "pid": 999_999_999, "boot": "gone"}
    run(fake[taste.JOBS].insert_one({"_id": "j1", "status": "asking", "project": {"kind": "model", "id": "case"},
                                     "started_at": taste._now(), "beat": taste._now(), "worker": old,
                                     "steps": [{"id": "ask", "kind": "ask", "state": "running",
                                                "started_at": taste._now()}]}))
    # Another host, not heard from for long: lost too.
    run(fake[taste.JOBS].insert_one({"_id": "j2", "status": "reading", "project": {"kind": "model", "id": "x"},
                                     "started_at": "2026-01-01T00:00:00+00:00", "beat": "2026-01-01T00:00:00+00:00",
                                     "worker": {"host": "elsewhere", "pid": 1, "boot": "b"}, "steps": []}))
    # Another host, heard from just now: still running.
    run(fake[taste.JOBS].insert_one({"_id": "j3", "status": "asking", "project": {"kind": "model", "id": "y"},
                                     "started_at": taste._now(), "beat": taste._now(),
                                     "worker": {"host": "elsewhere", "pid": 1, "boot": "b"}, "steps": []}))
    d = run(taste.job(fake, "j1"))
    assert d["status"] == "failed" and d["error"] == taste.GONE and d["finished_at"]
    assert d["steps"][0]["state"] == "failed" and d["steps"][0]["reason"] == taste.GONE
    got = {r["_id"]: r["status"] for r in run(taste.jobs(fake))}
    assert got == {"j1": "failed", "j2": "failed", "j3": "asking"}


def test_a_restart_during_the_run_ends_it_as_interrupted(monkeypatch):
    fake = FakeDb()
    _project(fake)

    async def forever(messages, **kw):
        await asyncio.sleep(60)

    _mock_llm(monkeypatch, forever)

    async def go():
        doc, _ = await taste.start_job(fake, "model", "case")
        await asyncio.sleep(0.05)
        t = taste._TASKS[doc["_id"]]
        t.cancel()                                       # what the process going away does
        with pytest.raises(asyncio.CancelledError):
            await t
        return await taste.job(fake, doc["_id"])

    d = run(go())
    assert d["status"] == "failed" and d["error"] == taste.GONE


def test_jobs_through_the_api(db, monkeypatch):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    started = []

    async def work(dbx, jid, kind, ref):
        started.append((kind, ref))

    monkeypatch.setattr(taste, "_work", work)
    a.post("/api/taste", json={"name": "tmp"})
    ws_a = next(iter(db["taste_palettes"].docs.values()))["workspace_id"]
    from backend import scope
    run(scope.ScopedDb(db, ws_a)["models"].insert_one({"_id": "case", "title": "Fan case"}))
    r = a.post("/api/taste/extract", json={"kind": "model", "id": "case"}).json()
    jid = r["job_id"]
    assert r["status"] == "queued" and r["project"]["label"] == "Fan case" and r["started"]
    assert started == [("model", "case")]
    import types
    monkeypatch.setitem(taste._TASKS, jid, types.SimpleNamespace(done=lambda: False, cancel=lambda: None))
    assert [j["id"] for j in a.get("/api/taste/jobs").json()] == [jid]
    assert b.get("/api/taste/jobs").json() == [] and b.get(f"/api/taste/jobs/{jid}").status_code == 404
    assert a.delete(f"/api/taste/jobs/{jid}").status_code == 409            # still running
    assert a.post(f"/api/taste/jobs/{jid}/cancel").json()["status"] == "cancelled"
    p = a.patch(f"/api/taste/jobs/{jid}", json={"saved_to": {"id": "p1", "name": "Fan", "count": 3}}).json()
    assert p["saved_to"]["name"] == "Fan"
    assert a.delete(f"/api/taste/jobs/{jid}").json() == {"deleted": jid}
    assert a.get(f"/api/taste/jobs/{jid}").status_code == 404


def test_job_routes_read_for_viewers_write_for_drawers():
    for m, p in (("POST", "/api/taste/jobs/j1/cancel"), ("PATCH", "/api/taste/jobs/j1"),
                 ("DELETE", "/api/taste/jobs/j1")):
        assert not access.page_allowed(m, p), (m, p)
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))
    for p in ("/api/taste/jobs", "/api/taste/jobs/j1"):
        assert access.page_allowed("GET", p) and access.allowed("viewer", access.action("GET", p))


def test_a_palette_goes_to_another_person_as_a_file(db):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    p = a.post("/api/taste", json={"name": "House style", "description": "how we build", "items": [
        {"text": "Walls 2 mm", "domain": "mechanical", "strength": "must", "why": "stiff"},
        {"text": "No vias in pads", "domain": "pcb", "strength": "avoid"}]}).json()
    f = a.get(f"/api/taste/{p['id']}/export").json()
    assert f["format"] == "redline-taste" and f["version"] == 2 and len(f["items"]) == 2
    assert "attached" not in f and "id" not in f["items"][0]
    got = b.post("/api/taste/import", json=f)
    assert got.status_code == 200, got.text
    g = got.json()
    assert g["name"] == "House style" and [i["text"] for i in g["items"]] == ["Walls 2 mm", "No vias in pads"]
    assert g["items"][1]["strength"] == "avoid" and g["imported"]["count"] == 2
    # The same file again: a second palette, its name marked.
    assert b.post("/api/taste/import", json=f).json()["name"] == "House style (imported)"
    assert b.post("/api/taste/import", json={"format": "nope"}).status_code == 400
    assert b.post("/api/taste/import", json={"format": "redline-taste", "version": 1, "items": [{"text": ""}]}).status_code == 400


# ---------------------------------------------------------------- form, scope, layers, renders

def test_items_have_a_scope_an_exception_and_a_layer_and_old_ones_read_as_all():
    it = taste.clean_item({"text": "Overhangs at least 45 deg", "domain": "mechanical", "strength": "must",
                           "applies_to": "Hidden", "exception": "visible openings keep their shape",
                           "layer": "language", "example": "iot-fan: 45 deg chamfer under the lid"})
    assert it["applies_to"] == "hidden" and it["exception"].startswith("visible openings")
    assert it["layer"] == "language" and it["example"].startswith("iot-fan")
    assert taste.clean_item({"text": "x", "applies_to": "openings in visible walls"})["applies_to"] == \
        "openings in visible walls"
    assert taste.clean_item({"text": "x", "applies_to": "outside", "layer": "nonsense"})["applies_to"] == "visible"
    assert taste.clean_item({"text": "x", "domain": "form"})["domain"] == "form"
    # A palette from before: no scope, no layer - everything everywhere, design language.
    old = {"id": "1", "text": "Walls 2 mm", "domain": "mechanical", "strength": "must", "source": "manual"}
    assert taste.item_out(old)["applies_to"] == "all" and taste.item_out(old)["layer"] == "language"
    assert taste.out({"_id": "p", "items": [old]})["items"][0]["applies_to"] == "all"
    assert taste.out({"_id": "p", "items": [old]})["priority"] == taste.PRIORITY


def test_scope_and_exception_reach_the_api_and_the_edit(db):  # noqa: F811
    a = person(db, "a")
    p = a.post("/api/taste", json={"name": "Look", "items": [
        {"text": "Outer corners R6", "domain": "form", "strength": "must", "applies_to": "visible"}]}).json()
    it = p["items"][0]
    assert (it["domain"], it["applies_to"], it["layer"]) == ("form", "visible", "language")
    assert p["counts"]["form"] == 1
    p = a.patch(f"/api/taste/{p['id']}/items/{it['id']}", json={"exception": "inside the battery bay",
                                                                 "layer": "specific"}).json()
    assert p["items"][0]["exception"] == "inside the battery bay" and p["items"][0]["layer"] == "specific"
    p = a.patch(f"/api/taste/{p['id']}", json={"priority": "Looks first."}).json()
    assert p["priority"] == "Looks first." and not p["priority_default"]
    p = a.patch(f"/api/taste/{p['id']}", json={"priority": ""}).json()
    assert p["priority"] == taste.PRIORITY and p["priority_default"]


def test_the_answer_says_layer_scope_and_how_many_projects_show_it():
    raw = json.dumps([
        {"text": "4-pin fan connector", "domain": "pcb", "layer": "project", "strength": "must", "seen_in": 1},
        {"text": "Outer corners about 6% of the smallest side", "domain": "form", "layer": "language",
         "strength": "must", "applies_to": "visible", "exception": "", "example": "enclosure R4 / 67 mm",
         "seen_in": 3},
        {"text": "Overhangs at least 45 deg", "domain": "mechanical", "strength": "must", "applies_to": "hidden",
         "exception": "visible openings: bridge or chamfer, or ask", "seen_in": "two"}])
    got = taste.parse_proposals(raw, SRC, projects=3)
    assert [i["text"][:5] for i in got] == ["Outer", "4-pin", "Overh"]            # seen in more first
    assert got[0]["seen"] == {"n": 3, "m": 3} and got[0]["example"] == "enclosure R4 / 67 mm"
    assert got[1]["layer"] == "specific" and got[1]["seen"] == {"n": 1, "m": 3}
    assert got[2]["applies_to"] == "hidden" and "bridge" in got[2]["exception"] and "seen" not in got[2]
    assert "seen" not in taste.parse_proposals(raw, SRC)[0]                     # one project: no tally


FAN = {"_id": "fan1", "name": "Fan taste", "origins": [{"kind": "folder", "id": "iot-fan", "label": "iot-fan",
                                                         "product": "iot-fan"}],
       "references": [{"id": "r1", "view": "iso", "model": "iot-fan/assemblies/station", "gridfs_id": "g1"}],
       "items": [
           {"id": "1", "text": "Outer corners R6-8 mm, the same on all", "domain": "form", "strength": "must",
            "applies_to": "visible", "example": "station R4 on 67 mm"},
           {"id": "2", "text": "Overhangs at least 45 deg", "domain": "mechanical", "strength": "must",
            "applies_to": "hidden", "exception": "visible openings keep their shape"},
           {"id": "3", "text": "Fan connector 4-pin with PWM and tach", "domain": "pcb", "strength": "must",
            "layer": "specific"}]}


def test_product_lines():
    assert taste.same_line("iot-fan", "iot-fan") and taste.same_line("iot-fan", "iot-fan-80mm")
    assert taste.same_line("iot-fan_v2", "iot-fan") and taste.same_line("iot-fan2", "iot-fan")
    assert not taste.same_line("iot-fan", "pyro") and not taste.same_line("iot-fanatic", "iot-fan")
    assert not taste.same_line("", "iot-fan")


def test_the_agent_block_for_the_same_product_and_for_another():
    mine = taste.agent_text([FAN], product="iot-fan-80mm")
    lines = mine.splitlines()
    assert lines[1] == "Priority: " + taste.PRIORITY                            # first, after the name
    assert "AND the project-specific items" in mine and "APPLY: this work is on that product" in mine
    assert "- MUST [visible surfaces]: Outer corners R6-8 mm, the same on all (e.g. station R4 on 67 mm)" in mine
    assert "- MUST [hidden surfaces]: Overhangs at least 45 deg (except: visible openings keep their shape)" in mine
    assert mine.index("Form language:") < mine.index("Mechanical:") < mine.index("PROJECT-SPECIFIC")
    assert "/api/taste/fan1/refs/r1" in mine and "taste-check" in mine and "Taste check" in mine
    other = taste.agent_text([FAN], product="pyro")
    assert "follow the design language only" in other and "background only, not carried over" in other
    assert "Apply the design language to whatever product" in other
    # A note that names the product brings them in; the person's switch wins over both.
    assert "AND the project-specific items" in taste.agent_text([FAN], product="pyro", note="make it like the iot-fan")
    assert "design language only" in taste.agent_text([FAN], product="iot-fan", overrides={"fan1": False})
    assert "AND the project-specific" in taste.agent_text([FAN], product="pyro", overrides={"fan1": True})
    # No project-specific items: nothing said about them; no form and no renders: no check asked for.
    plain = {"_id": "p", "name": "p", "items": [{"id": "1", "text": "No vias in pads", "domain": "pcb",
                                                 "strength": "avoid"}]}
    assert "project-specific" not in taste.block(plain) and "taste-check" not in taste.agent_text([plain])


def test_attached_specifics_switch_through_the_api(db):  # noqa: F811
    a = person(db, "a")
    a.post("/api/taste", json={"name": "tmp"})
    ws_a = next(iter(db["taste_palettes"].docs.values()))["workspace_id"]
    from backend import scope
    mine = scope.ScopedDb(db, ws_a)
    run(mine["models"].insert_one({"_id": "iot-fan/assemblies/station", "title": "Station"}))
    run(mine["models"].insert_one({"_id": "pyro/parts/body", "title": "Pyro body"}))
    src = {"kind": "folder", "id": "iot-fan", "label": "iot-fan"}
    p = a.post("/api/taste", json={"name": "Fan", "items": [
        {"text": "Outer corners R6", "domain": "form", "strength": "must", "source": src},
        {"text": "18650 cell in a holder", "domain": "mechanical", "strength": "must", "layer": "specific",
         "source": src}]}).json()
    p = a.put(f"/api/taste/{p['id']}/attached", json={"attached": [
        {"kind": "model", "id": "iot-fan/assemblies/station"}, {"kind": "model", "id": "pyro/parts/body"}]}).json()
    assert [x["specifics_default"] for x in p["attached"]] == [True, False]
    assert p["sources"][0]["product"] == "iot-fan"
    fan = a.get("/api/taste/attached?kind=model&id=iot-fan/assemblies/station").json()["text"]
    pyro = a.get("/api/taste/attached?kind=model&id=pyro/parts/body").json()["text"]
    assert "AND the project-specific items" in fan and "design language only" in pyro
    a.put(f"/api/taste/{p['id']}/attached", json={"attached": [
        {"kind": "model", "id": "pyro/parts/body", "specifics": True}]})
    assert "AND the project-specific" in a.get("/api/taste/attached?kind=model&id=pyro/parts/body").json()["text"]


@pytest.fixture()
def shots(monkeypatch):
    """GridFS stand-in: the stored renders by id."""
    from backend import store
    kept: dict = {}

    async def put_shot(db, png):
        gid = f"g{len(kept) + 1}"
        kept[gid] = png
        return {"gridfs_id": gid, "bytes": len(png)}

    async def get_shot(db, gid):
        return kept[gid]

    class Bucket:
        async def delete(self, gid):
            kept.pop(gid, None)

    monkeypatch.setattr(store, "put_shot", put_shot)
    monkeypatch.setattr(store, "get_shot", get_shot)
    monkeypatch.setattr(store, "bucket", lambda db, name: Bucket())
    return kept


def _png(colour=(40, 40, 40)) -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (60, 40), colour).save(buf, "PNG")
    return buf.getvalue()


def _built(fake):
    run(fake["models"].insert_one({"_id": "case", "title": "Fan case", "source": "wall = 2.0",
                                   "artifacts": {"viewer": {"gridfs_id": "v"}, "step": {"gridfs_id": "s"}}}))


def test_a_model_is_photographed_and_measured_and_the_pictures_go_to_the_model(monkeypatch, shots):
    fake = FakeDb()
    _built(fake)
    seen = {}

    async def render_views(db, model, views=taste.LOOK_VIEWS, size=taste.RENDER_SIZE):
        seen["render"] = (model, views)
        return {v: _png() for v in views}

    async def measure_parts(db, models):
        seen["measure"] = models
        return {"case": {"size": [100, 60, 30], "vertical_corners": [[6.0, 4]], "fillets_convex": [[6.0, 4]],
                         "chamfers": [[0.6, 12]], "recessed": [[0.8, 3]], "colours": {"#2c2c2c": 90, "#c0c0c0": 10}}}

    async def complete(messages, **kw):
        seen["messages"], seen["kw"] = messages, kw
        return {"choices": [{"message": {"content": json.dumps([
            {"text": "Outer vertical corners R6, the same on all", "domain": "form", "strength": "must",
             "applies_to": "visible", "layer": "language", "example": "case R6 on 30 mm (20%)"}])}}],
            "usage": {}, "provider": "commandcode", "model": "m"}

    async def vision_route():
        return "commandcode", "m", True

    monkeypatch.setattr(taste, "render_views", render_views)
    monkeypatch.setattr(taste, "measure_parts", measure_parts)
    monkeypatch.setattr(taste, "vision_route", vision_route)
    _mock_llm(monkeypatch, complete)
    track = taste.Tracker()
    got = run(taste.extract(fake, "model", "case", track))
    assert seen["render"] == ("case", taste.LOOK_VIEWS) and seen["measure"] == ["case"]
    assert [s["id"] for s in track.steps] == ["read:model:case", "render:case", "measure", "ask", "parse"]
    user = seen["messages"][1]["content"]
    assert isinstance(user, list) and sum(1 for p in user if p["type"] == "image_url") == len(taste.LOOK_VIEWS)
    assert user[1]["text"].startswith("Render: Fan case, iso view")
    assert "rounded vertical corners R6 x4 (R/smallest side 20%)" in user[0]["text"]
    assert "chamfers 0.6 mm x12" in user[0]["text"] and "#2c2c2c 90%" in user[0]["text"]
    assert "pictures" in seen["messages"][0]["content"] and seen["kw"]["provider"] == "commandcode"
    assert got["vision"] and got["notice"] == "" and len(got["references"]) == len(taste.LOOK_VIEWS)
    assert got["proposals"][0]["domain"] == "form" and len(shots) == len(taste.LOOK_VIEWS)


def test_without_a_model_that_reads_images_it_says_so(monkeypatch, shots):
    fake = FakeDb()
    _built(fake)

    async def render_views(db, model, views=taste.LOOK_VIEWS, size=taste.RENDER_SIZE):
        return {"iso": _png()}

    async def measure_parts(db, models):
        raise RuntimeError("the drawing image is not built")

    seen = {}

    async def complete(messages, **kw):
        seen["messages"] = messages
        return await _answer()(messages, **kw)

    async def vision_route():
        return "commandcode", "m", False

    monkeypatch.setattr(taste, "render_views", render_views)
    monkeypatch.setattr(taste, "measure_parts", measure_parts)
    monkeypatch.setattr(taste, "vision_route", vision_route)
    _mock_llm(monkeypatch, complete)
    track = taste.Tracker()
    got = run(taste.extract(fake, "model", "case", track))
    assert isinstance(seen["messages"][1]["content"], str)                       # text only
    assert track.row("measure")["state"] == "failed" and "not built" in track.row("measure")["reason"]
    assert got["notice"].startswith("Extracted from text only") and "reads images" in got["notice"]
    assert "not built" in got["notice"] and len(got["references"]) == 1           # kept all the same


def test_renders_go_with_the_palette_are_served_exported_and_imported(db, monkeypatch, shots):  # noqa: F811
    a, b = person(db, "a"), person(db, "b")
    a.post("/api/taste", json={"name": "tmp"})
    ws_a = next(iter(db["taste_palettes"].docs.values()))["workspace_id"]
    from backend import scope
    mine = scope.ScopedDb(db, ws_a)
    shots["g1"], shots["g2"] = _png((10, 10, 10)), _png((200, 10, 10))
    run(mine[taste.JOBS].insert_one({
        "_id": "j1", "status": "done", "project": {"kind": "folder", "id": "iot-fan", "label": "iot-fan"},
        "product": "iot-fan", "started_at": "2026-10-13T00:00:00+00:00", "finished_at": "2026-10-13T00:01:00+00:00",
        "steps": [], "totals": {}, "proposals": [], "measures": "enclosure: R4", "notice": "", "by": {"id": "a"},
        "references": [{"id": "r1", "view": "iso", "model": "iot-fan/assemblies/station", "gridfs_id": "g1"},
                       {"id": "r2", "view": "front", "model": "iot-fan/assemblies/station", "gridfs_id": "g2"}]}))
    j = a.get("/api/taste/jobs/j1").json()
    assert [r["url"] for r in j["references"]] == ["/api/taste/jobs/j1/refs/r1", "/api/taste/jobs/j1/refs/r2"]
    assert "gridfs_id" not in j["references"][0]
    assert a.get("/api/taste/jobs/j1/refs/r1").content == shots["g1"]
    p = a.post("/api/taste", json={"name": "Fan look", "items": [
        {"text": "Outer corners R6", "domain": "form", "strength": "must"}]}).json()
    a.patch("/api/taste/jobs/j1", json={"saved_to": {"id": p["id"], "name": "Fan look", "count": 1}})
    p = a.get(f"/api/taste/{p['id']}").json()
    assert [r["view"] for r in p["references"]] == ["iso", "front"] and p["measures"] == "enclosure: R4"
    assert p["sources"][0]["product"] == "iot-fan"
    r = a.get(p["references"][1]["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content == shots["g2"]
    assert b.get(p["references"][1]["url"]).status_code == 404                  # another space's
    # The file carries the pictures; importing it elsewhere keeps them.
    f = a.get(f"/api/taste/{p['id']}/export").json()
    assert f["version"] == 2 and len(f["references"]) == 2 and f["references"][0]["png"]
    assert f["items"][0]["applies_to"] == "all" and f["origins"][0]["id"] == "iot-fan"
    g = b.post("/api/taste/import", json=f).json()
    assert [x["view"] for x in g["references"]] == ["iso", "front"] and g["measures"] == "enclosure: R4"
    assert b.get(g["references"][0]["url"]).status_code == 200 and len(shots) == 4
    bad = {**f, "references": [{"view": "iso", "png": "bm90IGEgcGljdHVyZQ=="}]}
    assert b.post("/api/taste/import", json=bad).status_code == 400
    # Deleted: the palette's pictures go, unless a run still has them.
    assert b.delete(f"/api/taste/{g['id']}").status_code == 200 and len(shots) == 2
    a.delete(f"/api/taste/{p['id']}")
    assert len(shots) == 2                                                     # the run j1 holds them
    a.delete("/api/taste/jobs/j1")
    assert shots == {}


def test_a_folder_is_photographed_from_its_main_assembly(monkeypatch):
    fake = FakeDb()
    v = {"viewer": {"gridfs_id": "v"}, "step": {"gridfs_id": "s"}}
    for mid, folder, uses in (
            ("fan/parts/lid", "fan/parts", []), ("fan/parts/case", "fan/parts", []),
            ("fan/purchased/screw", "fan/purchased", []),
            ("fan/assemblies/base", "fan/assemblies", ["fan/parts/lid", "fan/parts/case", "fan/purchased/screw"]),
            ("fan/assemblies/station", "fan/assemblies", ["fan/assemblies/base", "fan/parts/lid"])):
        run(fake["models"].insert_one({"_id": mid, "folder": folder, "artifacts": v,
                                       "uses": [{"kind": "model", "id": u} for u in uses]}))
    renders, parts = run(taste.look_targets(fake, "folder", "fan"))
    assert renders == ["fan/assemblies/station"] and parts == ["fan/parts/case", "fan/parts/lid"]
    renders, parts = run(taste.look_targets(fake, "model", "fan/assemblies/station"))
    assert renders == ["fan/assemblies/station"] and parts == ["fan/parts/case", "fan/parts/lid"]


def test_a_folder_of_several_products_counts_where_an_item_is_seen():
    assert taste.product_in("fan", "fan/parts/lid") == "fan"
    assert taste.product_in("line", "line/lamp/parts/arm") == "line/lamp"
    assert taste.product_in("line", "line/charger/assemblies/body") == "line/charger"
    assert taste.product_in("line", "line/top") == "line"


def test_the_reference_views_are_views_render_py_takes():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    import render
    assert set(taste.LOOK_VIEWS) <= set(render.VIEWS) and set(taste.MORE_VIEWS) <= set(render.VIEWS)
    js = render.view_js("detail")
    assert "setCameraPosition" in js and "box.min.y" in js
    assert render.view_js("iso") == render.side_js("iso")
