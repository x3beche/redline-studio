"""The project wiki (backend/wiki.py): short Markdown pages per project,
every save a version (history, the difference, restore as a new version),
[[page]] links and @kind:id mentions read out of the text, a search, the
rights (viewers read, editors write), the routes, the Chat's tools (a
write always asks first and shows the change), the brief the rooms'
agents get with a note (bounded), and the addresses (/wiki/<project>/<page>)
on both the server's and the page's side."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import io
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from backend import access, actors, app_links, ccgen, chat_tools, scope, search, wiki, wiki_api
from backend.chat_tools import Ctx, ToolError

ME = {"type": "user", "id": "u1", "name": "Emir"}


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- a stand-in database

class Res:
    def __init__(self, matched=0, deleted=0):
        self.matched_count, self.deleted_count = matched, deleted


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, *a, **k):
        return self

    def limit(self, *a):
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Coll:
    """Enough of Mongo: equality, $lte, $in; _id unique."""

    def __init__(self):
        self.rows: dict = {}

    @staticmethod
    def _ok(row, q):
        for k, v in (q or {}).items():
            got = row.get(k)
            if isinstance(v, dict):
                if "$lte" in v and not (got is not None and got <= v["$lte"]):
                    return False
                if "$in" in v and got not in v["$in"]:
                    return False
            elif got != v:
                return False
        return True

    async def insert_one(self, doc):
        doc.setdefault("_id", f"auto{len(self.rows)}")
        if doc["_id"] in self.rows:
            raise Exception("E11000 duplicate key")
        self.rows[doc["_id"]] = copy.deepcopy(doc)

    async def find_one(self, q, projection=None):
        for r in self.rows.values():
            if self._ok(r, q):
                return copy.deepcopy(r)
        return None

    def find(self, q=None, projection=None):
        return Cursor([copy.deepcopy(r) for r in self.rows.values() if self._ok(r, q)])

    async def update_one(self, q, upd, upsert=False):
        for r in self.rows.values():
            if self._ok(r, q):
                r.update(copy.deepcopy(upd.get("$set") or {}))
                return Res(matched=1)
        return Res()

    async def delete_one(self, q):
        for k, r in list(self.rows.items()):
            if self._ok(r, q):
                del self.rows[k]
                return Res(deleted=1)
        return Res()

    async def delete_many(self, q):
        gone = [k for k, r in self.rows.items() if self._ok(r, q)]
        for k in gone:
            del self.rows[k]
        return Res(deleted=len(gone))


class Db(dict):
    def __missing__(self, name):
        self[name] = Coll()
        return self[name]

    def __getattr__(self, name):
        return self[name]


@pytest.fixture
def db(monkeypatch):
    d = Db()
    d["folders"].rows.update({"iot-fan": {"_id": "iot-fan", "name": "iot-fan", "parent": ""},
                              "iot-fan/parts": {"_id": "iot-fan/parts", "name": "parts", "parent": "iot-fan"}})
    d["models"].rows.update({"iot-fan/parts/lid": {"_id": "iot-fan/parts/lid", "folder": "iot-fan/parts"},
                             "pyro/parts/body": {"_id": "pyro/parts/body", "folder": "pyro/parts"},
                             "stand": {"_id": "stand", "folder": ""}})
    d["boards"].rows.update({"controller": {"_id": "controller", "folder": "aribax/electronics"},
                             "loose": {"_id": "loose"}})
    d["firmware"].rows.update({"fw1": {"_id": "fw1", "board": "controller"}})
    monkeypatch.setattr(actors, "current", lambda: ME)
    monkeypatch.setattr(access, "current", lambda: "owner")
    monkeypatch.setattr(wiki_api, "_db", lambda: d)
    return d


# ---------------------------------------------------------------- the text

def test_a_page_name_becomes_its_id():
    assert wiki.slug("Dimensions and limits") == "dimensions-and-limits"
    assert wiki.slug("  Açık sorular / İlk tur ") == "açık-sorular-ilk-tur"
    assert wiki.slug("!!!") == "" and wiki.slug("x" * 90) == "x" * 60


def test_links_and_mentions_are_read_out_of_the_text_but_not_out_of_code():
    got = wiki.parse("See [[Decisions]] and [[open-questions|what is open]], [[Decisions]] again.\n"
                     "The lid @model:iot-fan/parts/lid. On @board:controller with @part:C25744 and @firmware:fw1, "
                     "mail me@x.com.\n`[[not-a-link]] @model:no` and\n```\n[[nor-this]]\n```")
    assert got["links"] == ["decisions", "open-questions"]
    assert got["mentions"] == [{"kind": "model", "id": "iot-fan/parts/lid"}, {"kind": "board", "id": "controller"},
                               {"kind": "part", "id": "C25744"}, {"kind": "firmware", "id": "fw1"}]


# ---------------------------------------------------------------- pages and versions

def test_every_save_is_a_version_and_restore_is_a_new_one(db):
    p, changed = run(wiki.write(db, "iot-fan", "Decisions", text="# Lid\n- 3 mm: M3 inserts\n", summary="first"))
    assert changed and p["version"] == 1 and p["title"] == "Decisions" and p["slug"] == "decisions"
    assert p["created_by"]["name"] == "Emir" and p["updated_by"]["name"] == "Emir"
    assert db["audit"].rows and [r["action"] for r in db["audit"].rows.values()] == ["wiki.write"]
    p, _ = run(wiki.write(db, "iot-fan", "decisions", text="# Lid\n- 2.5 mm: lighter\n", summary="thinner", base=1))
    assert p["version"] == 2 and p["title"] == "Decisions"
    # Made on version 1 when it is at 2: refused, nothing written over.
    with pytest.raises(wiki.Refused) as e:
        run(wiki.write(db, "iot-fan", "decisions", text="stale", base=1))
    assert e.value.status == 409
    # The same text again is no version.
    _, changed = run(wiki.write(db, "iot-fan", "decisions", text="# Lid\n- 2.5 mm: lighter\n"))
    assert not changed and len(db["wiki_versions"].rows) == 2
    p, _ = run(wiki.write(db, "iot-fan", "decisions", append="- 2026-10-14: USB-C on the back", summary="usb"))
    assert p["version"] == 3 and p["text"].endswith("- 2.5 mm: lighter\n\n- 2026-10-14: USB-C on the back\n")
    hist = run(wiki.history(db, "iot-fan", "decisions"))
    assert [h["n"] for h in hist] == [3, 2, 1] and hist[1]["summary"] == "thinner"
    assert hist[1]["added"] == 1 and hist[1]["removed"] == 1
    cmp = run(wiki.compare(db, "iot-fan", "decisions", 2))
    assert cmp["from"] == 1 and cmp["to"] == 2
    assert [(r["op"], r["text"]) for r in cmp["rows"]] == [("=", "# Lid"), ("-", "- 3 mm: M3 inserts"),
                                                         ("+", "- 2.5 mm: lighter")]
    first = run(wiki.compare(db, "iot-fan", "decisions", 1))
    assert first["from"] == 0 and all(r["op"] == "+" for r in first["rows"])
    p = run(wiki.restore(db, "iot-fan", "decisions", 1))
    assert p["version"] == 4 and p["text"] == "# Lid\n- 3 mm: M3 inserts\n"
    h4 = run(wiki.history(db, "iot-fan", "decisions"))[0]
    assert h4["restored_from"] == 1 and h4["summary"] == "Restored version 1"
    assert [r["action"] for r in db["audit"].rows.values()][-1] == "wiki.restore"
    with pytest.raises(wiki.Refused):
        run(wiki.restore(db, "iot-fan", "decisions", 99))


def test_what_a_page_may_not_be(db):
    with pytest.raises(wiki.Refused) as e:
        run(wiki.write(db, "nowhere", "x", text="y"))
    assert e.value.status == 404                                   # a project is a top folder that is there
    for kw in ({"text": ""}, {"text": "x" * (wiki.MAX_TEXT + 1)}, {}, {"text": "a", "append": "b"}):
        with pytest.raises(wiki.Refused):
            run(wiki.write(db, "iot-fan", "x", **kw))
    with pytest.raises(wiki.Refused):
        run(wiki.write(db, "iot-fan", "???", text="a"))


def test_links_both_ways_pinned_first_and_delete(db):
    run(wiki.write(db, "iot-fan", "Sourcing", text="Fans from [[Decisions]]."))
    run(wiki.write(db, "iot-fan", "Decisions", text="See [[Sourcing]] and [[Nothing yet]]."))
    run(wiki.set_pinned(db, "iot-fan", "sourcing", True))
    d = run(wiki.get(db, "iot-fan", "Decisions"))
    assert d["linked_from"] == [{"slug": "sourcing", "title": "Sourcing"}]
    assert d["link_titles"] == {"sourcing": "Sourcing", "nothing-yet": None}
    assert [p["slug"] for p in run(wiki.pages(db, "iot-fan"))] == ["sourcing", "decisions"]
    assert run(wiki.remove(db, "iot-fan", "sourcing")) and not run(wiki.get(db, "iot-fan", "sourcing"))
    assert not [v for v in db["wiki_versions"].rows.values() if v["slug"] == "sourcing"]
    assert not run(wiki.remove(db, "iot-fan", "sourcing"))


def test_projects_are_the_top_folders_and_each_thing_has_one(db):
    run(wiki.write(db, "iot-fan", "Decisions", text="x"))
    got = {p["id"]: p["pages"] for p in run(wiki.projects(db))}
    assert got == {"aribax": 0, "iot-fan": 1, "pyro": 0}           # "stand" sits at the top: no project
    assert run(wiki.project_of(db, "model", "iot-fan/parts/lid")) == "iot-fan"
    assert run(wiki.project_of(db, "model", "stand")) is None
    assert run(wiki.project_of(db, "board", "controller")) == "aribax"
    assert run(wiki.project_of(db, "board", "loose")) is None
    assert run(wiki.project_of(db, "firmware", "fw1")) == "aribax"


def test_search_names_first_and_every_word(db):
    run(wiki.write(db, "iot-fan", "Noise", text="The fan is quiet below 60% PWM."))
    run(wiki.write(db, "iot-fan", "Decisions", text="PWM at 25 kHz, the noise page says why."))
    run(wiki.write(db, "pyro", "Decisions", text="no fans here, PWM for the heater"))
    hits = run(wiki.search(db, "noise pwm"))
    assert [h["slug"] for h in hits] == ["noise", "decisions"] and hits[0]["project"] == "iot-fan"
    assert [h["project"] for h in run(wiki.search(db, "pwm", "pyro"))] == ["pyro"]
    assert run(wiki.search(db, "  ")) == []
    # Ctrl+K's search has the pages too.
    got = run(search.everything(db, "heater"))
    assert [(h["kind"], h["id"], h["project"]) for h in got] == [("wiki", "decisions", "pyro")]


def test_the_pages_live_in_the_workspace():
    assert {"wiki_pages", "wiki_versions"} <= scope.SCOPED


# ---------------------------------------------------------------- rights and routes

def test_viewers_read_editors_write():
    reads = [("GET", "/api/wiki/projects"), ("GET", "/api/wiki/p/iot-fan"), ("GET", "/api/wiki/p/iot-fan/x"),
             ("GET", "/api/wiki/p/iot-fan/x/history"), ("GET", "/api/wiki/p/iot-fan/x/versions/2"),
             ("GET", "/api/wiki/search"), ("GET", "/api/wiki/for")]
    writes = [("PUT", "/api/wiki/p/iot-fan/x"), ("PATCH", "/api/wiki/p/iot-fan/x"), ("POST", "/api/wiki/p/iot-fan/x/restore")]
    for m, p in reads:
        assert access.action(m, p) == "view"
        assert all(access.allowed(r, "view") for r in access.ROLES)
    for m, p in writes:
        a = access.action(m, p)
        assert a == "edit"
        assert access.allowed("editor", a) and access.allowed("user", a)
        assert not access.allowed("viewer", a) and not access.allowed("reviewer", a)
    assert access.action("DELETE", "/api/wiki/p/iot-fan/x") == "delete"


def test_the_routes(db):
    with pytest.raises(HTTPException) as e:
        run(wiki_api.wiki_write("nowhere", "x", wiki_api.PageIn(text="a")))
    assert e.value.status_code == 404
    p = run(wiki_api.wiki_write("iot-fan", "dimensions-and-limits",
                                wiki_api.PageIn(text="- Lid: 3 mm", title="Dimensions and limits", summary="start")))
    assert p["changed"] and p["slug"] == "dimensions-and-limits" and p["title"] == "Dimensions and limits"
    # A new title keeps the page (its id stays).
    p = run(wiki_api.wiki_write("iot-fan", "dimensions-and-limits",
                                wiki_api.PageIn(text="- Lid: 3 mm", title="Limits", base=1)))
    assert p["version"] == 2 and p["title"] == "Limits" and len(run(wiki.pages(db, "iot-fan"))) == 1
    with pytest.raises(HTTPException) as e:
        run(wiki_api.wiki_write("iot-fan", "dimensions-and-limits", wiki_api.PageIn(text="b", base=1)))
    assert e.value.status_code == 409
    listing = run(wiki_api.wiki_pages("iot-fan"))
    assert listing["exists"] and [x["slug"] for x in listing["pages"]] == ["dimensions-and-limits"]
    assert "text" not in listing["pages"][0]
    assert run(wiki_api.wiki_page("iot-fan", "dimensions-and-limits"))["text"] == "- Lid: 3 mm\n"
    with pytest.raises(HTTPException):
        run(wiki_api.wiki_page("iot-fan", "nope"))
    assert run(wiki_api.wiki_pin("iot-fan", "dimensions-and-limits", wiki_api.PinIn(pinned=True)))["pinned"]
    assert [h["n"] for h in run(wiki_api.wiki_history("iot-fan", "dimensions-and-limits"))] == [2, 1]
    assert run(wiki_api.wiki_version("iot-fan", "dimensions-and-limits", 2, None))["from"] == 1
    assert run(wiki_api.wiki_restore("iot-fan", "dimensions-and-limits", wiki_api.RestoreIn(version=1)))["version"] == 3
    assert run(wiki_api.wiki_for("model", "iot-fan/parts/lid")) == {"project": "iot-fan"}
    assert [h["slug"] for h in run(wiki_api.wiki_search("lid", "iot-fan"))] == ["dimensions-and-limits"]
    assert run(wiki_api.wiki_delete("iot-fan", "dimensions-and-limits"))
    with pytest.raises(HTTPException):
        run(wiki_api.wiki_delete("iot-fan", "dimensions-and-limits"))


def test_the_routes_are_the_app_s():
    from backend.main import app
    paths = app.openapi()["paths"]
    assert {"/api/wiki/projects", "/api/wiki/p/{project}/{page}", "/api/wiki/p/{project}/{page}/restore"} <= set(paths)


# ---------------------------------------------------------------- the Chat's tools

def test_the_tools_are_a_package_of_their_own_and_writing_always_asks():
    t = chat_tools.tools()
    assert {t[n].package for n in ("wiki_search", "wiki_read", "wiki_write")} == {"wiki"}
    assert t["wiki_search"].level == t["wiki_read"].level == "read"
    w = t["wiki_write"]
    assert w.level == "change" and w.asks({}) and w.asks({"project": "x", "page": "y", "append": "z"})
    assert w.preview is not None
    assert "wiki" in chat_tools.PACKAGE


def test_a_line_about_decisions_gets_the_wiki_tools():
    from backend import cc_tools
    on = chat_tools.tools()
    for line in ("neden böyle karar verdik, wikiye bak", "What did we decide about the lid's dimensions?"):
        got = cc_tools.pick([{"role": "user", "content": line}], on)
        assert not got.all and "wiki" in got.groups and {"wiki_search", "wiki_read", "wiki_write"} <= got.names
    got = cc_tools.pick([{"role": "user", "content": "render the lid"}], on)
    assert "wiki" not in got.groups and "wiki_write" not in got.names


def _ctx(db):
    return Ctx(db=db, actor=ME, chat="c1")


def test_search_and_read(db):
    run(wiki.write(db, "iot-fan", "Decisions", text="## Lid\n3 mm for the M3 inserts"))
    t = chat_tools.tools()
    r = run(t["wiki_search"].run(_ctx(db), {"query": "inserts"}))
    assert "iot-fan / decisions" in r.text and "/wiki/iot-fan/decisions" in r.text and r.vars["count"] == 1
    r = run(t["wiki_search"].run(_ctx(db), {"project": "iot-fan"}))
    assert "decisions - Decisions" in r.text
    r = run(t["wiki_search"].run(_ctx(db), {}))
    assert "iot-fan: 1 pages" in r.text
    r = run(t["wiki_read"].run(_ctx(db), {"project": "iot-fan", "page": "Decisions"}))
    assert "version 1" in r.text and "3 mm for the M3 inserts" in r.text and r.vars["version"] == 1
    with pytest.raises(ToolError):
        run(t["wiki_read"].run(_ctx(db), {"project": "iot-fan", "page": "nope"}))


def test_a_write_waits_for_a_yes_and_shows_the_change_first(db):
    run(wiki.write(db, "iot-fan", "Decisions", text="- Lid: 3 mm"))
    tools = chat_tools.tools()
    args = {"project": "iot-fan", "page": "decisions", "append": "- Base: 4 mm", "summary": "base"}

    async def go(allow: bool):
        out = {"text": "", "steps": [], "rev": 0, "answers": {}}
        task = asyncio.create_task(ccgen.run_step({"name": "wiki_write", "arguments": json.dumps(args)}, tools,
                                                  _ctx(db), out))
        for _ in range(200):
            if out["steps"] and out["steps"][0]["status"] == "ask":
                break
            await asyncio.sleep(0.01)
        step = out["steps"][0]
        assert step["status"] == "ask"
        assert "version 1 -> 2" in step["preview"] and "+ - Base: 4 mm" in step["preview"]
        assert (await wiki.get(db, "iot-fan", "decisions"))["version"] == 1          # nothing written yet
        out["answers"][step["id"]] = allow
        return await task, step

    (said, err), step = run(go(False))
    assert err and step["status"] == "denied" and run(wiki.get(db, "iot-fan", "decisions"))["version"] == 1
    (said, err), step = run(go(True))
    assert not err and step["status"] == "done"
    d = run(wiki.get(db, "iot-fan", "decisions"))
    assert d["version"] == 2 and d["text"] == "- Lid: 3 mm\n\n- Base: 4 mm\n" and d["summary"] == "base"
    # What it changed is kept for the Chat's undo (backend/chat_undo.py).
    assert any(c["tool"] == "wiki_write" for c in db["cc_changes"].rows.values())


def test_a_write_that_cannot_be_done_is_not_asked(db, monkeypatch):
    tools = chat_tools.tools()

    async def go(args):
        out = {"text": "", "steps": [], "rev": 0, "answers": {}}
        res = await ccgen.run_step({"name": "wiki_write", "arguments": json.dumps(args)}, tools, _ctx(db), out)
        return res, out["steps"][0]

    (_, err), step = run(go({"project": "nowhere", "page": "x", "content": "y", "summary": "s"}))
    assert err and step["status"] == "error" and "no project" in step["error"]
    monkeypatch.setattr(access, "current", lambda: "viewer")     # a viewer may read, not write
    (_, err), step = run(go({"project": "iot-fan", "page": "x", "content": "y", "summary": "s"}))
    assert err and step["status"] == "error" and not db["wiki_pages"].rows
    r = run(tools["wiki_search"].run(_ctx(db), {}))
    assert "iot-fan" in r.text


# ---------------------------------------------------------------- the agents' brief

def test_the_brief_is_bounded_pinned_first_then_the_newest(db):
    for i in range(12):
        run(wiki.write(db, "iot-fan", f"Page {i}", text=f"page {i}\n" + ("x" * 70 + "\n") * 30))
    run(wiki.write(db, "iot-fan", "Decisions", text="- the lid is 3 mm"))
    run(wiki.set_pinned(db, "iot-fan", "page-0", True))
    lines = run(wiki.brief(db, "iot-fan"))
    text = "\n".join(lines)
    assert len(text) <= wiki.BRIEF_CHARS + 400
    heads = [x for x in lines if x.startswith("## ")]
    assert heads[0].startswith("## Page 0  [page-0] - pinned") and heads[1].startswith("## Decisions  [decisions]")
    assert lines[-1].startswith("not shown here") and "page-1" in lines[-1]
    # One huge page is cut, not dropped.
    run(wiki.write(db, "pyro", "Everything", text="y" * 19_000))
    one = "\n".join(run(wiki.brief(db, "pyro", budget=3000)))
    assert "## Everything" in one and len(one) <= 3000 + 200
    assert run(wiki.brief(db, "aribax")) == []


def test_show_prints_the_note_s_project_wiki(db, monkeypatch):
    from tools import revisions
    run(wiki.write(db, "iot-fan", "Decisions", text="- the lid is 3 mm (M3 inserts)"))
    db["revisions"].rows["r1"] = {"_id": "r1", "kind": "cad", "model": "iot-fan/parts/lid", "comment": "thinner lid",
                                  "status": "queued"}

    async def no_taste(*a, **k):
        return None
    monkeypatch.setattr(revisions, "_print_taste", no_taste)
    monkeypatch.setattr(revisions, "connect", lambda: db)
    buf = io.StringIO()
    import argparse
    with contextlib.redirect_stdout(buf):
        run(revisions.cmd_show(argparse.Namespace(id="r1", out=None)))
    out = buf.getvalue()
    assert 'wiki    : project "iot-fan"' in out and "## Decisions  [decisions]" in out
    assert "the lid is 3 mm (M3 inserts)" in out
    # A board note reaches its project the same way (the board's folder).
    lines = run(wiki.brief_for(db, [("board", "loose"), ("model", "iot-fan/parts/lid")]))
    assert lines[0] == "iot-fan" and lines[1]


def test_the_agents_are_told():
    agents = Path("AGENTS.md").read_text()
    assert "revisions.py wiki" in agents and "## The project's wiki" in agents
    for f in ("redline-3d.md", "redline-pcb.md", "redline-firmware.md"):
        assert "wiki" in (Path(".claude/agents") / f).read_text()


# ---------------------------------------------------------------- addresses

def test_links_into_the_wiki():
    assert app_links.room("wiki") == "/wiki"
    assert app_links.wiki() == "/wiki" and app_links.wiki("iot-fan") == "/wiki/iot-fan"
    assert app_links.wiki("iot-fan", "open-questions") == "/wiki/iot-fan/open-questions"
    assert app_links.wiki("a b", "ç d") == "/wiki/a%20b/%C3%A7%20d"


NAV = Path("frontend/src/app/nav-url.ts")
TEXT = Path("frontend/src/app/rooms/wiki-text.ts")


def _node(src: Path, harness: str, cases) -> list:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    work = Path(tempfile.mkdtemp(prefix="wiki-test-"))
    try:
        (work / (src.stem + ".mts")).write_text(src.read_text())
        (work / "run.mjs").write_text(harness)
        done = subprocess.run([node, "--experimental-strip-types", "--no-warnings", str(work / "run.mjs"),
                               json.dumps(cases)], capture_output=True, text=True, timeout=60)
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def test_the_page_s_addresses_match_the_server_s():
    harness = """
import { parse, build, isStep } from './nav-url.mts';
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map(p => {
  const u = new URL('http://x' + p);
  const v = parse(u.pathname, u.search);
  return [Object.fromEntries(v), build(v)];
})));
"""
    paths = ["/wiki", app_links.wiki("iot-fan"), app_links.wiki("iot-fan", "open-questions"),
             app_links.wiki("a b", "ç d")]
    got = _node(NAV, harness, paths)
    assert got[0] == [{"ws": "wiki"}, "/wiki"]
    assert got[1] == [{"ws": "wiki", "project": "iot-fan"}, "/wiki/iot-fan"]
    assert got[2] == [{"ws": "wiki", "project": "iot-fan", "page": "open-questions"}, "/wiki/iot-fan/open-questions"]
    assert got[3][0] == {"ws": "wiki", "project": "a b", "page": "ç d"} and got[3][1] == paths[3]
    step = """
import { parse, isStep } from './nav-url.mts';
const p = (s) => parse(s, '');
console.log(JSON.stringify([isStep(p('/wiki/a'), p('/wiki/a/x')), isStep(p('/wiki/a/x'), p('/wiki/a/y')),
                            isStep(p('/wiki'), p('/wiki/a')), isStep(p('/3d'), p('/wiki'))]));
"""
    # Another page is a step of its own; the room filling in its first project is not.
    assert _node(NAV, step, []) == [True, True, False, True]


def test_the_page_reads_links_and_mentions_as_the_server_does():
    harness = """
import { slug, parse } from './wiki-text.mts';
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map(t => [slug(t), parse(t)])));
"""
    cases = ["Dimensions and limits", "  Açık sorular / İlk tur ", "See [[Decisions]], [[open-questions|open]] "
             "@model:iot-fan/parts/lid. `[[code]]` @board:controller @part:C25744, me@x.com"]
    got = _node(TEXT, harness, cases)
    for c, (s, p) in zip(cases, got):
        assert s == wiki.slug(c)
        want = wiki.parse(c)
        assert p["links"] == want["links"] and p["mentions"] == want["mentions"]


def test_the_page_is_reached_from_more_not_a_tab():
    ws = Path("frontend/src/app/workspaces.ts").read_text()
    assert re.search(r"id: 'wiki'", ws)
    bar = Path("frontend/src/app/topbar.ts").read_text()
    assert re.search(r"MENU_ONLY = new Set<string>\(\['wiki'\]\)", bar)
    assert "@case ('wiki') { @defer { <app-room-wiki /> } }" in Path("frontend/src/app/app.ts").read_text()
