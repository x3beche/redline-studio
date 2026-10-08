"""A name `scope.key()` already put in a workspace's form gets no second
suffix: the page and the agents (through the server) must find the same
settings document and the same room run, or the run card never shows and
auto-archive never sees its switch (backend/scope.py)."""
import re

from backend import compute, scope, store
from tests.test_scope import Coll, Cursor, run


def test_a_keyed_name_is_suffixed_once():
    ids = scope.Ids("u1")
    assert ids.inn("current@u1") == "current@u1"
    assert ids.inn("current") == "current@u1"
    assert ids.query({"_id": "app@u1"}) == {"_id": "app@u1"}


def test_the_page_and_the_agent_meet_on_one_run_and_one_settings_doc():
    raw = {"runs": Coll(), "settings": Coll()}
    db = scope.ScopedDb(raw, "u1")

    async def page_then_agent():
        tok = scope.WORKSPACE.set("u1")            # the page's request
        try:
            await db.settings.update_one({"_id": scope.key(store.SETTINGS_ID)},
                                         {"$set": {"auto_archive": True}}, upsert=True)
        finally:
            scope.WORKSPACE.reset(tok)
        # The agent, through the server: its own process is in "default", so
        # its key is the plain one and the server's Ids adds the suffix.
        await db.runs.update_one({"_id": compute.run_key("cad")},
                                 {"$set": {"status": "running"}}, upsert=True)
        tok = scope.WORKSPACE.set("u1")
        try:
            got_run = await db.runs.find_one({"_id": compute.run_key("cad")})
        finally:
            scope.WORKSPACE.reset(tok)
        return got_run, await store.settings(db)

    got_run, settings = run(page_then_agent())
    assert got_run and got_run["status"] == "running"
    assert settings["auto_archive"] is True
    assert sorted(r["_id"] for r in raw["settings"].rows) == ["app@u1"]


class _RegexColl(Coll):
    def find(self, q=None, *a, **k):
        want = (q or {}).get("_id")
        if isinstance(want, dict) and "$regex" in want:
            return Cursor([dict(r) for r in self.rows if re.search(want["$regex"], r["_id"])])
        return super().find(q, *a, **k)

    async def delete_one(self, q, *a, **k):
        await self.delete_many(q)


def test_doubled_names_from_before_are_made_single():
    raw = {
        "settings": _RegexColl([{"_id": "app@u1@u1", "auto_archive": True, "workspace_id": "u1"},
                                {"_id": "app@u2@u2", "auto_archive": True, "workspace_id": "u2"},
                                {"_id": "app@u2", "auto_archive": False, "workspace_id": "u2"}]),
        "runs": _RegexColl([{"_id": "current@u1@u1", "status": "done", "workspace_id": "u1"},
                            {"_id": "current@u1", "status": "running", "workspace_id": "u1"}]),
        "tool_data": _RegexColl([{"_id": "t:p@a@b"}]),
    }
    assert run(scope.undouble(raw)) == 3
    s = {r["_id"]: r for r in raw["settings"].rows}
    assert set(s) == {"app@u1", "app@u2"} and s["app@u1"]["auto_archive"] and s["app@u2"]["auto_archive"]
    assert [(r["_id"], r["status"]) for r in raw["runs"].rows] == [("current@u1", "running")]
    assert [r["_id"] for r in raw["tool_data"].rows] == ["t:p@a@b"]
    assert run(scope.undouble(raw)) == 0
