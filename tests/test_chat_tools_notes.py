"""The Chat's tools for the Notes tab's notes, the rooms' queues and the
Chat's own conversations (backend/chat_tools: notes_search, note_read,
note_write, note_todo, note_edit, queue_list, queue_read, rename_chat,
chat_list, chat_read, chat_archive).

What matters: the notes are read and written through the asker's
workspace and with the rights the Notes API needs; a to-do is ticked in
the note's own text; the queue says each note's state as the room's card
does, with what is being worked on now; and renaming the conversation
goes the list's own way, so every page that has it open hears of it.
Everything runs on the tests' fake database; no model is reached.
"""

from __future__ import annotations

import asyncio
import copy

import pytest

from backend import cc_chat, ccgen, chat_tools, notes
from backend.chat_tools import Ctx, ToolError
from tests.test_cc_generation import answers
from tests.test_cc_mentions_live_search import Coll, env, events, match, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import run, tool_model

ME = {"id": "u-me", "name": "Me", "type": "person"}
YOU = {"id": "u-you", "name": "You", "type": "person"}


def _tool(name):
    return chat_tools.tools()[name]


@pytest.fixture
def edits(monkeypatch):
    """What the fake database lacks for notes.update."""
    async def find_one_and_update(self, query, update, **kw):
        for r in self.rows.values():
            if match(r, query):
                for k, v in (update.get("$set") or {}).items():
                    r[k] = copy.deepcopy(v)
                return copy.deepcopy(r)
        return None
    monkeypatch.setattr(Coll, "find_one_and_update", find_one_and_update, raising=False)


def _note(raw, nid, text, at, by=ME, ws="default", **extra):
    raw["notes"].rows[nid] = {"_id": nid, "workspace_id": ws, "text": text, **notes.read(text), "context": {},
                              "pinned": False, "by": dict(by), "created_at": at, "updated_at": at, **extra}


def _notes(raw):
    _note(raw, "n1", "Fan curve #pwm\n\n- [ ] measure at 40C\n- [x] order the NTC", "2026-10-01T09:00:00+00:00",
          context={"room": "pcb", "board": "ctrl"})
    _note(raw, "n2", "Lid screws #mech\nM3 x 8, four of them", "2026-10-05T09:00:00+00:00", by=YOU, pinned=True)
    _note(raw, "n3", "Buzzer #pwm\n- [x] pick a part", "2026-10-03T09:00:00+00:00")
    _note(raw, "theirs", "Secret plan #pwm", "2026-10-09T09:00:00+00:00", ws="team2")


def test_the_tools_are_in_their_packages_at_their_levels():
    want = {"notes_search": ("notes", "read", True), "note_read": ("notes", "read", True),
            "note_write": ("notes", "change", False), "note_todo": ("notes", "change", False),
            "note_edit": ("notes", "change", False), "queue_list": ("general", "read", True),
            "queue_read": ("general", "read", True), "rename_chat": ("commandcode", "change", True),
            "chat_list": ("commandcode", "read", True), "chat_read": ("commandcode", "read", True),
            "chat_archive": ("commandcode", "change", False)}
    got = {n: (t.package, t.level, t.default) for n, t in chat_tools.tools().items() if n in want}
    assert got == want
    names = [p.name for p in chat_tools.PACKAGES]
    assert names[names.index("mfr") + 1] == "commandcode" and names[0] == "general"
    for n in ("notes_search", "queue_list", "rename_chat", "chat_list"):
        assert n in chat_tools.SYSTEM_NOTE


def test_the_note_writing_tools_ask_for_a_well_set_page():
    for n in ("note_write", "note_edit"):
        d = chat_tools.tools()[n].description
        assert "title line" in d and "'## '" in d and "'- [ ] '" in d and "table" in d and "units" in d
    assert "'## ' sections" in chat_tools.SYSTEM_NOTE and "no filler" in chat_tools.SYSTEM_NOTE


def test_notes_search_lists_newest_first_in_the_workspace_and_filters(env):
    raw, state = env
    _notes(raw)
    db = cc_chat._db()
    tool = _tool("notes_search")
    got = run(tool.run(Ctx(db=db, actor=ME), {}))
    assert got.vars["n"] == 3 and "Secret plan" not in got.text            # another account's space is not read
    order = [ln.split()[0] for ln in got.text.splitlines()[1:] if not ln.startswith(" ")]
    assert order == ["n2", "n3", "n1"]                                    # newest first
    assert "#pwm" in got.text and "to-dos 1 open, 1 done" in got.text and "written in PCB ctrl" in got.text
    assert run(tool.run(Ctx(db=db, actor=ME), {"tag": "#PWM"})).vars["n"] == 2
    assert run(tool.run(Ctx(db=db, actor=ME), {"query": "screws four"})).vars["n"] == 1
    assert "n1" in run(tool.run(Ctx(db=db, actor=ME), {"todo": "open"})).text
    done = run(tool.run(Ctx(db=db, actor=ME), {"todo": "done"}))
    assert done.vars["n"] == 1 and "n3" in done.text
    mine = run(tool.run(Ctx(db=db, actor=YOU), {"mine": True}))
    assert mine.vars["n"] == 1 and "n2" in mine.text
    assert run(tool.run(Ctx(db=db, actor=ME), {"pinned": True})).vars["n"] == 1
    none = run(tool.run(Ctx(db=db, actor=ME), {"query": "gearbox"}))
    assert none.say == "No notes like that"


def test_note_read_gives_the_whole_note_with_its_todos_numbered(env):
    raw, _ = env
    _notes(raw)
    db = cc_chat._db()
    got = run(_tool("note_read").run(Ctx(db=db), {"note": "fan curve"}))       # by words of its title
    assert got.vars == {"title": "Fan curve", "note": "n1"}
    assert "1. [ ] measure at 40C" in got.text and "2. [x] order the NTC" in got.text
    assert got.text.endswith("--- the note ---\nFan curve #pwm\n\n- [ ] measure at 40C\n- [x] order the NTC")
    with pytest.raises(ToolError, match="no note 'theirs'"):
        run(_tool("note_read").run(Ctx(db=db), {"note": "theirs"}))


def test_note_write_keeps_a_note_by_the_asker_with_the_rights_of_the_api(env):
    raw, state = env
    db = cc_chat._db()
    tool = _tool("note_write")
    got = run(tool.run(Ctx(db=db, actor=ME), {"text": "Check the 12V rail #power\n- [ ] scope it", "board": "ctrl"}))
    (d,) = raw["notes"].rows.values()
    assert d["_id"] == got.vars["note"] and d["workspace_id"] == "default" and d["by"] == ME
    assert d["title"] == "Check the 12V rail" and d["tags"] == ["power"] and d["todo"] == {"open": 1, "done": 0}
    assert d["context"] == {"room": "commandcode", "board": "ctrl"}
    assert got.say == "Wrote note {title}"
    state["role"] = "viewer"                                    # may look, may not write a note
    with pytest.raises(ToolError, match="as viewer you cannot"):
        run(tool.run(Ctx(db=db, actor=ME), {"text": "x"}))
    with pytest.raises(ToolError):
        state["role"] = "reviewer"
        run(tool.run(Ctx(db=db, actor=ME), {"text": " "}))
    assert len(raw["notes"].rows) == 1


def test_note_todo_ticks_and_unticks_one_line_of_the_text(env, edits):
    raw, state = env
    _notes(raw)
    db = cc_chat._db()
    tool = _tool("note_todo")
    got = run(tool.run(Ctx(db=db), {"note": "n1", "todo": "40C"}))
    n1 = raw["notes"].rows["n1"]
    assert n1["text"] == "Fan curve #pwm\n\n- [x] measure at 40C\n- [x] order the NTC"
    assert n1["todo"] == {"open": 0, "done": 2} and got.say == "Ticked “{todo}”"
    got = run(tool.run(Ctx(db=db), {"note": "n1", "todo": "2", "done": False}))
    assert raw["notes"].rows["n1"]["text"].endswith("- [ ] order the NTC") and got.say == "Unticked “{todo}”"
    with pytest.raises(ToolError, match="no to-do 'paint'.*1. \\[x\\] measure at 40C"):
        run(tool.run(Ctx(db=db), {"note": "n1", "todo": "paint"}))
    with pytest.raises(ToolError, match="no to-dos"):
        run(tool.run(Ctx(db=db), {"note": "n2", "todo": "1"}))
    state["role"] = "viewer"
    with pytest.raises(ToolError, match="as viewer you cannot"):
        run(tool.run(Ctx(db=db), {"note": "n1", "todo": "1"}))


def test_note_edit_saves_the_new_text_and_reads_it_again(env, edits):
    raw, state = env
    _notes(raw)
    db = cc_chat._db()
    got = run(_tool("note_edit").run(Ctx(db=db), {"note": "n2", "text": "Lid screws #mech #bom\nM3 x 10, four"}))
    n2 = raw["notes"].rows["n2"]
    assert n2["text"] == "Lid screws #mech #bom\nM3 x 10, four" and n2["tags"] == ["bom", "mech"]
    assert n2["by"] == YOU and got.vars["note"] == "n2"                         # still the author's note
    with pytest.raises(ToolError, match="whole new text"):
        run(_tool("note_edit").run(Ctx(db=db), {"note": "n2", "text": ""}))
    with pytest.raises(ToolError, match="no note"):
        run(_tool("note_edit").run(Ctx(db=db), {"note": "theirs", "text": "mine now"}))
    assert raw["notes"].rows["theirs"]["text"] == "Secret plan #pwm"


# ---- the rooms' queues -------------------------------------------------------------

def _rev(raw, rid, kind, status, at, comment, ws="default", **extra):
    raw["revisions"].rows[rid] = {"_id": rid, "workspace_id": ws, "kind": kind, "status": status, "created_at": at,
                                  "comment": comment, "model": {"cad": "iot-fan/parts/lid", "pcb": "ctrl",
                                                                "firmware": "fan-fw"}[kind],
                                  "created_by": dict(ME), **extra}


def _queue(raw):
    _rev(raw, "r1", "cad", "queued", "2026-10-01T09:00:00+00:00", "Make the lid 2 mm thicker",
         queued_at="2026-10-01T09:01:00+00:00")
    _rev(raw, "r2", "pcb", "queued", "2026-10-02T09:00:00+00:00", "Widen the 12V track")
    _rev(raw, "r3", "pcb", "queued", "2026-10-03T09:00:00+00:00", "Move C1 closer to U1")
    _rev(raw, "r4", "firmware", "draft", "2026-10-04T09:00:00+00:00", "Slow the fan at night")
    _rev(raw, "r5", "cad", "applied", "2026-09-20T09:00:00+00:00", "Round the edges", applied_at="2026-09-21T10:00:00+00:00")
    _rev(raw, "r6", "cad", "queued", "2026-10-05T09:00:00+00:00", "Old one", archived=True)
    _rev(raw, "their", "cad", "queued", "2026-10-06T09:00:00+00:00", "Their secret", ws="team2")
    run_ = {"workspace_id": "default", "revision": "r2", "title": "Widening the track", "status": "running",
            "room": "pcb", "percent": 40.0, "started_at": "2026-10-11T08:00:00+00:00", "by": {"name": "pcb-agent"},
            "holders": [{"by": {"name": "pcb-agent"}}]}
    raw["runs"].rows["current:pcb"] = {"_id": "current:pcb", **run_}
    raw["runs"].rows["r2"] = {"_id": "r2", **run_}
    raw["runs"].rows["r3"] = {"_id": "r3", "workspace_id": "default", "revision": "r3", "status": "done", "room": "pcb"}


def test_queue_list_says_each_notes_state_by_room_and_what_runs_now(env):
    raw, _ = env
    _queue(raw)
    db = cc_chat._db()
    tool = _tool("queue_list")
    got = run(tool.run(Ctx(db=db), {}))
    assert got.vars == {"n": 5, "working": 1}
    assert got.text.startswith("Working now: \n  r2  PCB room  \"Widening the track\"  40%  by pcb-agent")
    assert "Their secret" not in got.text and "Old one" not in got.text            # another space; archived
    assert "r1  [queued]" in got.text and "r2  [working now]" in got.text and "r3  [done, waiting for review]" in got.text
    assert "r4  [draft]" in got.text and "r5  [applied]" in got.text
    pcb = got.text.index("PCB room -")
    assert got.text.index("r3") < got.text.index("r2", pcb)                         # newest first in a room
    assert got.text.index("3D room -") < pcb < got.text.index("Firmware room -")
    only = run(tool.run(Ctx(db=db), {"room": "pcb", "status": "review"}))
    assert only.vars["n"] == 1 and "r3" in only.text and "r1" not in only.text
    assert run(tool.run(Ctx(db=db), {"archived": True})).vars["n"] == 1
    assert run(tool.run(Ctx(db=db), {"query": "12v"})).vars["n"] == 1


def test_queue_read_gives_one_note_whole_with_its_run(env):
    raw, _ = env
    _queue(raw)
    db = cc_chat._db()
    got = run(_tool("queue_read").run(Ctx(db=db), {"note": "r2"}))
    assert got.vars["state"] == "working now" and got.vars["room"] == "pcb"
    assert "Note r2 in the PCB room's queue: working now" in got.text and "About board ctrl" in got.text
    assert "Run: running \"Widening the track\", 40%" in got.text and "worked on by pcb-agent" in got.text
    assert got.text.endswith("--- the note ---\nWiden the 12V track")
    assert "applied 2026-09-21 10:00" in run(_tool("queue_read").run(Ctx(db=db), {"note": "r5"})).text
    with pytest.raises(ToolError, match="no queued note 'their'"):
        run(_tool("queue_read").run(Ctx(db=db), {"note": "their"}))


# ---- renaming the conversation -------------------------------------------------------

def test_rename_chat_goes_the_lists_way_and_tells_the_open_pages(env):
    raw, state = env
    seed_chat(raw, gen="g1")
    raw[ccgen.GENS].rows["g1"] = {"_id": "g1", "chat": "c1", "status": "running"}
    db = cc_chat._db()

    async def go():
        q = cc_chat.HUB.subscribe(cc_chat.live_key("c1"))
        try:
            got = await _tool("rename_chat").run(Ctx(db=db, chat="c1"), {"title": " “Fan board  power” "})
            return got, q.get_nowait()
        finally:
            cc_chat.HUB.unsubscribe(cc_chat.live_key("c1"), q)
    got, ev = asyncio.run(go())
    assert raw["cc_chats"].rows["c1"]["title"] == "Fan board power" and got.vars == {"title": "Fan board power"}
    assert ev == {"type": "title", "gen": None, "title": "Fan board power"}
    assert raw[ccgen.GENS].rows["g1"]["title"] == "Fan board power"                 # the answer's tail says it too
    with pytest.raises(ToolError, match="new title"):
        run(_tool("rename_chat").run(Ctx(db=db, chat="c1"), {"title": "  "}))
    with pytest.raises(ToolError, match="gone"):
        run(_tool("rename_chat").run(Ctx(db=db, chat="nope"), {"title": "x"}))
    state["role"] = "viewer"
    with pytest.raises(ToolError, match="as viewer you cannot"):
        run(_tool("rename_chat").run(Ctx(db=db, chat="c1"), {"title": "x"}))
    # The list's own rename is the same path.
    state["role"] = "reviewer"
    run(cc_chat.patch_chat("c1", cc_chat.ChatPatch(title="By hand", pinned=True)))
    assert raw["cc_chats"].rows["c1"]["title"] == "By hand" and raw["cc_chats"].rows["c1"]["pinned"] is True


def test_a_model_renames_the_conversation_while_it_answers(env, monkeypatch):
    raw, state = env
    seed_chat(raw)
    tool_model(monkeypatch, state, [("", [("rename_chat", {"title": "Fan board power"})]), ("Renamed.", [])])
    evs = events(cc_chat.say("c1", cc_chat.SayIn(text="call this chat Fan board power", client="tab1")))
    (last,) = answers(raw)
    assert last["content"] == "Renamed." and last["steps"][0]["tool"] == "rename_chat"
    assert last["steps"][0]["status"] == "done" and last["steps"][0]["say"] == "Renamed this chat to “{title}”"
    assert raw["cc_chats"].rows["c1"]["title"] == "Fan board power"
    assert {"type": "title", "title": "Fan board power"} in evs                    # the asker's page hears it


def test_a_rename_during_the_first_answer_is_not_undone_by_the_naming(env, monkeypatch):
    raw, state = env
    seed_chat(raw, title=cc_chat.DEFAULT_TITLE)
    tool_model(monkeypatch, state, [("", [("rename_chat", {"title": "Fan board power"})]), ("Done.", [])])
    evs = events(cc_chat.say("c1", cc_chat.SayIn(text="name this chat Fan board power", client="tab1")))
    assert raw["cc_chats"].rows["c1"]["title"] == "Fan board power"
    titles = [e["title"] for e in evs if e["type"] == "title"]
    assert titles and set(titles) == {"Fan board power"}


def _chats(raw):
    lines = [{"id": f"m{i}", "role": "user" if i % 2 == 0 else "assistant", "content": f"line {i} about the fan",
              "at": f"2026-10-0{1 + i // 10}T10:00:00+00:00", **({"by": dict(ME)} if i % 2 == 0 else {"model": "m1"})}
             for i in range(25)]
    lines[3]["steps"] = [{"tool": "board_read"}]
    seed_chat(raw, "c1", title="Fan board power", messages=lines, updated_at="2026-10-05T10:00:00+00:00")
    seed_chat(raw, "c2", title="Lid screws", messages=[{"id": "x", "role": "user", "content": "M3 or M4?", "by": dict(ME)}],
              updated_at="2026-10-08T10:00:00+00:00")
    seed_chat(raw, "c3", title="Old fan idea", archived=True, updated_at="2026-10-09T10:00:00+00:00")
    seed_chat(raw, "c4", title="Binned fan", deleted_at="2026-10-10T10:00:00+00:00", updated_at="2026-10-10T10:00:00+00:00")
    seed_chat(raw, "c5", ws="team2", title="Their fan", updated_at="2026-10-11T10:00:00+00:00")


def test_chat_list_lists_the_workspaces_conversations_newest_first(env):
    raw, _ = env
    _chats(raw)
    db = cc_chat._db()
    tool = _tool("chat_list")
    got = run(tool.run(Ctx(db=db, chat="c2"), {}))
    assert got.vars["n"] == 2 and [ln.split()[0] for ln in got.text.splitlines()[1:]] == ["c2", "c1"]
    assert "25 lines (13 asked)" in got.text and "this conversation" in got.text
    assert "Their fan" not in got.text and "Binned" not in got.text and "Old fan" not in got.text
    assert run(tool.run(Ctx(db=db), {"query": "fan"})).vars["n"] == 1              # in a line, not the title
    assert run(tool.run(Ctx(db=db), {"query": "fan", "archived": "also"})).vars["n"] == 2
    only = run(tool.run(Ctx(db=db), {"archived": "only"}))
    assert only.vars["n"] == 1 and "c3" in only.text
    binned = run(tool.run(Ctx(db=db), {"trash": True}))
    assert binned.vars["n"] == 1 and "c4" in binned.text and "deleted 2026-10-10" in binned.text
    assert run(tool.run(Ctx(db=db), {"query": "gearbox"})).say == "No conversations like that"


def test_chat_read_pages_a_conversations_lines(env):
    raw, _ = env
    _chats(raw)
    db = cc_chat._db()
    tool = _tool("chat_read")
    last = run(tool.run(Ctx(db=db), {"chat": "c1"}))
    assert last.vars == {"title": "Fan board power", "page": 2, "pages": 2, "chat": "c1"}
    assert "[21] user (Me)" in last.text and "line 24 about the fan" in last.text and "line 19" not in last.text
    first = run(tool.run(Ctx(db=db, chat="c1"), {"page": 1}))                       # this conversation by default
    assert "[1] user (Me) 2026-10-01 10:00:\nline 0 about the fan" in first.text and "(this conversation)" in first.text
    assert "[4] assistant (m1) 2026-10-01 10:00 - used board_read" in first.text
    assert run(tool.run(Ctx(db=db), {"chat": "lid screws"})).vars["chat"] == "c2"   # by words of its title
    with pytest.raises(ToolError, match="in the trash"):
        run(tool.run(Ctx(db=db), {"chat": "c4"}))
    with pytest.raises(ToolError, match="no conversation"):
        run(tool.run(Ctx(db=db), {"chat": "c5"}))                                  # another account's


def test_chat_archive_archives_this_conversation(env):
    raw, state = env
    _chats(raw)
    db = cc_chat._db()
    tool = _tool("chat_archive")
    got = run(tool.run(Ctx(db=db, chat="c2"), {}))
    assert raw["cc_chats"].rows["c2"]["archived"] is True and got.say == "Archived this chat"
    with pytest.raises(ToolError, match="gone"):
        run(tool.run(Ctx(db=db, chat="c4"), {}))
    state["role"] = "viewer"
    with pytest.raises(ToolError, match="as viewer you cannot"):
        run(tool.run(Ctx(db=db, chat="c1"), {}))
    assert not raw["cc_chats"].rows["c1"].get("archived")
