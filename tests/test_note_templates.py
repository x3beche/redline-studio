"""One's own note templates (backend/note_templates.py): kept per person in
the workspace they were saved in, offered only to whoever saved them, and
changed or deleted only by them - anyone else is told there is no such
template. Saving takes the right to write a note (a viewer only looks), and
every save, change and delete is in the audit trail. The database is
test_telegram's fake; sign-in is on, and the cookie says who is asking."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import access, actors, auth, note_templates, scope
from test_telegram import FakeDb

PEOPLE = {
    "ayse": ({"type": "user", "id": "u-ayse", "name": "Ayşe"}, "uu-ayse", "user"),
    "deniz": ({"type": "user", "id": "u-deniz", "name": "Deniz"}, "default", "owner"),
    "ali": ({"type": "user", "id": "u-ali", "name": "Ali"}, "default", "admin"),
    # a read-only page session, and a reviewer's agent token, in the owner's space
    "look": ({"type": "agent", "id": "look", "name": "look", "token": "t2"}, "default", "viewer"),
    "rev": ({"type": "agent", "id": "rev", "name": "rev", "token": "t3"}, "default", "reviewer"),
}

GOOD = {"name": "Hole for an M3", "room": "cad", "text": "Add a hole to [part]\n- Size: Ø3.2 mm"}


@pytest.fixture
def db(monkeypatch):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)

    async def session_user(_db, token):
        if token not in PEOPLE:
            return None
        user, ws, role = PEOPLE[token]
        return {"user": user, "workspace": ws, "role": role}
    monkeypatch.setattr(auth, "session_user", session_user)
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield fake
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])


def as_(who: str) -> TestClient:
    c = TestClient(__import__("backend.main", fromlist=["app"]).app)
    c.cookies.set(auth.COOKIE, who)
    c.headers[auth.CSRF_HEADER] = "1"
    return c


def test_they_belong_to_a_space():
    assert "note_templates" in scope.SCOPED


def test_the_rights_are_a_notes():
    for role in access.ROLES:
        assert access.allowed(role, access.action("GET", "/api/note-templates"))
        for m, p in (("POST", "/api/note-templates"), ("PATCH", "/api/note-templates/abc"),
                     ("DELETE", "/api/note-templates/abc")):
            assert access.action(m, p) == "draw"
            assert access.allowed(role, access.action(m, p)) == (role != "viewer")


def test_what_a_template_must_be():
    assert note_templates.clean("  Move  a part ", "", "x\r\ny\n") == {"name": "Move a part", "room": "", "text": "x\ny"}
    for name, room, text, why in (("", "cad", "x", "name"), ("n" * 61, "cad", "x", "at most 60"),
                                  ("n", "kitchen", "x", "room is one of"), ("n", "cad", "  \n ", "its text"),
                                  ("n", "cad", "x" * 4001, "at most 4000")):
        with pytest.raises(ValueError, match=why):
            note_templates.clean(name, room, text)


def test_saved_listed_changed_and_deleted_by_its_maker_only(db):
    a = as_("ayse")
    r = a.post("/api/note-templates", json=GOOD)
    assert r.status_code == 200, r.text
    t = r.json()
    assert (t["name"], t["room"], t["text"]) == (GOOD["name"], "cad", GOOD["text"])
    (kept,) = db["note_templates"].docs.values()
    assert kept["by"] == {"type": "user", "id": "u-ayse", "name": "Ayşe"} and kept["workspace_id"] == "uu-ayse"
    assert [x["id"] for x in a.get("/api/note-templates").json()] == [t["id"]]

    # Someone else - even the owner of the machine, in their own space - neither sees nor touches it.
    d = as_("deniz")
    assert d.get("/api/note-templates").json() == []
    assert d.patch(f"/api/note-templates/{t['id']}", json={"name": "Mine now"}).status_code == 404
    assert d.delete(f"/api/note-templates/{t['id']}").status_code == 404

    r = a.patch(f"/api/note-templates/{t['id']}", json={"name": "M3 hole", "room": "pcb"})
    assert r.status_code == 200 and (r.json()["name"], r.json()["room"], r.json()["text"]) == ("M3 hole", "pcb", GOOD["text"])
    assert a.patch(f"/api/note-templates/{t['id']}", json={"room": "garden"}).status_code == 422
    assert a.delete(f"/api/note-templates/{t['id']}").status_code == 200
    assert a.get("/api/note-templates").json() == []
    assert a.delete(f"/api/note-templates/{t['id']}").status_code == 404


def test_two_people_in_one_space_keep_their_own(db):
    d, ali = as_("deniz"), as_("ali")
    mine = d.post("/api/note-templates", json=GOOD).json()
    theirs = ali.post("/api/note-templates", json={**GOOD, "name": "Ali's"}).json()
    assert [x["id"] for x in d.get("/api/note-templates").json()] == [mine["id"]]
    assert [x["id"] for x in ali.get("/api/note-templates").json()] == [theirs["id"]]
    # An admin may delete in general, but not someone else's template.
    assert ali.delete(f"/api/note-templates/{mine['id']}").status_code == 404


def test_a_viewer_only_looks_and_a_reviewer_may_save(db):
    v = as_("look")
    assert v.get("/api/note-templates").status_code == 200
    assert v.post("/api/note-templates", json=GOOD).status_code == 403
    assert not db["note_templates"].docs
    assert as_("rev").post("/api/note-templates", json=GOOD).status_code == 200


def test_bad_input_and_the_limit(db, monkeypatch):
    a = as_("ayse")
    assert a.post("/api/note-templates", json={**GOOD, "name": " "}).status_code == 422
    assert a.post("/api/note-templates", json={**GOOD, "room": "x"}).status_code == 422
    monkeypatch.setattr(note_templates, "MAX_PER_PERSON", 2)
    assert a.post("/api/note-templates", json=GOOD).status_code == 200
    assert a.post("/api/note-templates", json=GOOD).status_code == 200
    r = a.post("/api/note-templates", json=GOOD)
    assert r.status_code == 409 and "delete one first" in r.json()["detail"]


def test_every_change_is_in_the_trail(db):
    a = as_("ayse")
    t = a.post("/api/note-templates", json=GOOD).json()
    a.patch(f"/api/note-templates/{t['id']}", json={"name": "Again"})
    a.delete(f"/api/note-templates/{t['id']}")
    rows = list(db["audit"].docs.values())
    acts = [(r["action"], r["target"]) for r in rows]
    assert ("create", f"note template {t['id']}") in acts
    assert ("change", f"/api/note-templates/{t['id']}") in acts
    assert ("delete", f"/api/note-templates/{t['id']}") in acts
    assert all(r["actor"]["id"] == "u-ayse" for r in rows)
