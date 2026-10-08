"""A ```task block in a chat, sent to the queue with one click.

The text is read from the stored message, filed through the note form's own
route and queued; which block became which note is kept on the message, so
the button stays spent after a reload and for everyone else, and a second
click is refused. The database is test_telegram's fake; sign-in is off.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import access, actors, auth, chat, scope, tasks
from test_telegram import FakeDb


def run(c):
    return asyncio.run(c)


# ---------------------------------------------------------------- parsing

def test_a_task_fence_with_its_header_lines():
    text = ("Here it is:\n\n```task\ntitle: Move the screen\ntarget: iot-fan/assemblies/base\n\n"
            "- above the wheel\n- 45 degrees\n```\n\nQueue it when you like.")
    [b] = tasks.parse(text)
    assert b == {"index": 0, "title": "Move the screen", "target": "iot-fan/assemblies/base",
                 "body": "- above the wheel\n- 45 degrees", "closed": True}
    assert tasks.note_text(b) == "Move the screen\n\n- above the wheel\n- 45 degrees"


def test_header_lines_are_optional_and_only_at_the_top():
    [b] = tasks.parse("```task\nJust do it.\ntitle: not a header here\n```")
    assert b["title"] is None and b["target"] is None
    assert b["body"] == "Just do it.\ntitle: not a header here"
    assert tasks.note_text(b) == b["body"]


def test_several_blocks_and_other_fences_left_alone():
    text = ("```python\nprint(1)\n```\n"
            "```task\nTITLE: one\nfirst\n```\n"
            "```\n```task\nthis is code, not a task\n```\n"
            "``` task\nsecond\n```\n"
            "```task\nthird, never closed")
    got = tasks.parse(text)
    assert [(b["index"], b["title"], b["body"], b["closed"]) for b in got] == [
        (0, "one", "first", True), (1, None, "second", True), (2, None, "third, never closed", False)]


def test_no_fence_no_task():
    assert tasks.parse("plain words\n```\ncode\n```") == []
    assert tasks.parse("") == []


# ---------------------------------------------------------------- through the app

@pytest.fixture
def app(monkeypatch):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(main, "schedule_note_work", lambda rid: None)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    d = scope.ScopedDb(fake, scope.DEFAULT)
    run(d.models.insert_one({"_id": "iot-fan/assemblies/base", "name": "base", "title": "Base"}))
    run(d.models.insert_one({"_id": "iot-fan/parts/lid", "name": "lid"}))
    run(d.boards.insert_one({"_id": "controller", "title": "Controller"}))
    yield TestClient(main.app), d
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])


def agent_line(d, text, room="cad"):
    return run(chat.post(d, text, role=chat.AGENT, room=room))["_id"]


TASK = "Sure:\n\n```task\ntitle: Seat the screen\ntarget: iot-fan/assemblies/base\nUse the real STEP.\n```\n"


def test_queueing_files_one_queued_note_and_keeps_it_on_the_message(app):
    client, d = app
    mid = agent_line(d, TASK)
    r = client.post(f"/api/chat/{mid}/task/0/queue", json={})
    assert r.status_code == 200, r.text
    out = r.json()
    rows = run(_all(d.revisions))
    assert len(rows) == 1
    note = rows[0]
    assert note["_id"] == out["note"]
    assert note["status"] == "queued" and note["queued_at"]
    assert note["comment"] == "Seat the screen\n\nUse the real STEP."
    assert note["model"] == "iot-fan/assemblies/base" and note["kind"] == "cad"
    assert note["image"] is None and note["camera"] is None             # text only
    assert note["from_chat"] == {"kind": "thread", "room": "cad", "message": mid, "index": 0,
                                 "title": "Seat the screen"}
    # On the message, for every later reader.
    line = next(m for m in client.get("/api/chat?room=cad").json() if m["_id"] == mid)
    assert line["tasks"]["0"]["note_id"] == note["_id"]
    assert line["tasks"]["0"]["at"] and line["tasks"]["0"]["by"]["name"]
    # The card says where it came from.
    card = client.get(f"/api/revisions/{note['_id']}").json()
    assert card["from_chat"]["message"] == mid and card["status"] == "queued"


async def _all(coll):
    return [r async for r in coll.find({})]


def test_a_second_click_is_refused(app):
    client, d = app
    mid = agent_line(d, TASK)
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={}).status_code == 200
    r = client.post(f"/api/chat/{mid}/task/0/queue", json={})
    assert r.status_code == 409 and r.json()["detail"]["message"] == "already queued"
    assert len(run(_all(d.revisions))) == 1


def test_the_text_is_the_servers_not_the_pages(app):
    client, d = app
    mid = agent_line(d, TASK)
    r = client.post(f"/api/chat/{mid}/task/0/queue", json={"comment": "something else", "text": "x"})
    assert r.status_code == 200
    assert run(_all(d.revisions))[0]["comment"].endswith("Use the real STEP.")


def test_a_task_can_be_rejected_instead_and_then_not_queued(app):
    client, d = app
    mid = agent_line(d, TASK)
    r = client.post(f"/api/chat/{mid}/task/0/reject")
    assert r.status_code == 200, r.text
    line = next(m for m in client.get("/api/chat?room=cad").json() if m["_id"] == mid)
    assert line["tasks"]["0"]["rejected"] is True and line["tasks"]["0"]["by"]["name"]
    q = client.post(f"/api/chat/{mid}/task/0/queue", json={})
    assert q.status_code == 409 and q.json()["detail"]["task"]["rejected"]
    assert run(_all(d.revisions)) == []
    assert client.post(f"/api/chat/{mid}/task/0/reject").status_code == 409


def test_a_rejection_can_be_undone_a_queued_task_cannot(app):
    client, d = app
    mid = agent_line(d, TASK)
    client.post(f"/api/chat/{mid}/task/0/reject")
    assert client.post(f"/api/chat/{mid}/task/0/reject?undo=true").status_code == 200
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={}).status_code == 200
    assert client.post(f"/api/chat/{mid}/task/0/reject").status_code == 409
    assert client.post(f"/api/chat/{mid}/task/0/reject?undo=true").status_code == 409
    assert len(run(_all(d.revisions))) == 1


def test_rejecting_is_the_same_right_as_queueing():
    from backend import access
    for path in ("/api/chat/m1/task/0/reject", "/api/cc/chats/c1/messages/r1/task/0/reject"):
        assert access.action("POST", path) == "run"


def test_no_such_block_or_message(app):
    client, d = app
    mid = agent_line(d, TASK)
    assert client.post(f"/api/chat/{mid}/task/1/queue", json={}).status_code == 404
    assert client.post("/api/chat/nope/task/0/queue", json={}).status_code == 404
    assert run(_all(d.revisions)) == []


def test_without_a_target_the_pages_hint_is_used_if_it_exists(app):
    client, d = app
    mid = agent_line(d, "```task\nMake the lid thicker.\n```")
    r = client.post(f"/api/chat/{mid}/task/0/queue", json={})
    assert r.status_code == 422 and r.json()["detail"]["need_target"] is True
    assert r.json()["detail"]["room"] == "cad"
    # A hint that is not a model of this room is no target either.
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={"target": "controller"}).status_code == 422
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={"target": "gone"}).status_code == 422
    assert run(_all(d.revisions)) == []
    r = client.post(f"/api/chat/{mid}/task/0/queue", json={"target": "iot-fan/parts/lid"})
    assert r.status_code == 200 and r.json()["target"] == "iot-fan/parts/lid"
    # A refusal does not spend the button; the success does.
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={"target": "iot-fan/parts/lid"}).status_code == 409


def test_a_board_rooms_task_is_a_board_note(app):
    client, d = app
    mid = agent_line(d, "```task\ntarget: controller\nRoute SDA/SCL by hand.\n```", room="pcb")
    r = client.post(f"/api/chat/{mid}/task/0/queue", json={})
    assert r.status_code == 200, r.text
    note = run(_all(d.revisions))[0]
    assert note["kind"] == "pcb" and note["model"] == "controller"


def test_two_blocks_are_queued_separately(app):
    client, d = app
    mid = agent_line(d, TASK + "\n```task\ntarget: iot-fan/parts/lid\nSecond.\n```")
    assert client.post(f"/api/chat/{mid}/task/1/queue", json={}).status_code == 200
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={}).status_code == 200
    line = run(d.chat.find_one({"_id": mid}))
    assert set(line["tasks"]) == {"0", "1"}
    assert {r["model"] for r in run(_all(d.revisions))} == {"iot-fan/parts/lid", "iot-fan/assemblies/base"}


def test_a_stuck_claim_is_free_again(app):
    client, d = app
    mid = agent_line(d, TASK)
    run(d.chat.update_one({"_id": mid}, {"$set": {"tasks.0": {"pending": True, "at": "2020-01-01T00:00:00+00:00"}}}))
    assert client.post(f"/api/chat/{mid}/task/0/queue", json={}).status_code == 200


# ---------------------------------------------------------------- who may

def test_queueing_from_a_chat_is_queueing_a_note():
    for path in ("/api/chat/m1/task/0/queue", "/api/cc/chats/c1/messages/m1/task/0/queue"):
        act = access.action("POST", path)
        assert act == access.action("PATCH", "/api/revisions/r1", {"status": "queued"}) == "run"
        assert access.allowed("editor", act) and access.allowed("user", act)
        assert not access.allowed("reviewer", act) and not access.allowed("viewer", act)
        assert not access.page_allowed("POST", path)
    assert access.allowed("viewer", access.action("GET", "/api/chat/task-targets"))


# ---------------------------------------------------------------- an AI conversation

def ai_chat(d, content):
    run(d.cc_chats.insert_one({"_id": "c1", "title": "Screen", "by": {"id": "local"}, "deleted_at": None,
                               "messages": [{"id": "u1", "role": "user", "content": "write a task"},
                                            {"id": "a1", "role": "assistant", "content": content}]}))


def test_an_ai_answers_task_goes_where_its_target_is(app):
    client, d = app
    ai_chat(d, "```task\ntarget: controller\nAdd test pads.\n```")
    r = client.post("/api/cc/chats/c1/messages/a1/task/0/queue", json={})
    assert r.status_code == 200, r.text
    note = run(_all(d.revisions))[0]
    assert note["kind"] == "pcb" and note["model"] == "controller" and note["status"] == "queued"
    assert note["from_chat"]["kind"] == "ai" and note["from_chat"]["chat"] == "c1"
    assert note["from_chat"]["message"] == "a1"
    # On the line, as the page reads the conversation.
    got = client.get("/api/cc/chats/c1").json()
    a1 = next(m for m in got["messages"] if m["id"] == "a1")
    assert a1["tasks"]["0"]["note_id"] == note["_id"]
    assert "tasks" not in got and "tasks" not in next(m for m in got["messages"] if m["id"] == "u1")
    assert client.post("/api/cc/chats/c1/messages/a1/task/0/queue", json={}).status_code == 409


def test_an_ai_task_without_a_target_needs_the_picker(app):
    client, d = app
    ai_chat(d, "```task\nMake it blue.\n```")
    r = client.post("/api/cc/chats/c1/messages/a1/task/0/queue", json={})
    assert r.status_code == 422 and r.json()["detail"]["need_target"]
    r = client.post("/api/cc/chats/c1/messages/a1/task/0/queue",
                    json={"room": "cad", "target": "iot-fan/parts/lid"})
    assert r.status_code == 200 and r.json()["room"] == "cad"
    # A person's own line is not an answer with tasks in it.
    assert client.post("/api/cc/chats/c1/messages/u1/task/0/queue", json={}).status_code in (400, 404)


def test_the_picker_lists_a_rooms_things(app):
    client, _ = app
    got = client.get("/api/chat/task-targets?room=cad").json()
    assert [t["id"] for t in got] == ["iot-fan/assemblies/base", "iot-fan/parts/lid"]
    assert {t["room"] for t in client.get("/api/chat/task-targets").json()} == {"cad", "pcb"}
    assert client.get("/api/chat/task-targets?room=nope").status_code == 400


def test_the_ai_chat_is_told_the_convention():
    from backend import cc_chat
    assert "```task" in cc_chat.SYSTEM and "title:" in cc_chat.SYSTEM and "target:" in cc_chat.SYSTEM


# ---------------------------------------------------------------- the page's half (markdown.ts)

def _ts(calls: list[tuple[str, str]]) -> list:
    """Run markdown.ts's splitTasks / toHtml / plain under node, as test_markdown does."""
    import json
    import re
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path

    from test_markdown import SOURCE
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    text = SOURCE.read_text()
    text = re.sub(r"import \{[^}]*\} from '@angular/core';\n", "", text)
    text = re.sub(r"@Pipe\(\{[\s\S]*?\n\}\n", "", text)
    work = Path(tempfile.mkdtemp(prefix="md-task-"))
    try:
        (work / "markdown.mts").write_text(text)
        (work / "run.mjs").write_text(
            "import * as md from './markdown.mts';\n"
            "const calls = JSON.parse(process.argv[2]);\n"
            "console.log(JSON.stringify(calls.map(([fn, t]) => md[fn](t))));\n")
        done = subprocess.run([node, "--experimental-strip-types", "--no-warnings",
                               str(work / "run.mjs"), json.dumps(calls)],
                              capture_output=True, text=True, timeout=60)
        assert done.returncode == 0, done.stderr[-800:]
        return json.loads(done.stdout)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def test_the_page_splits_blocks_as_the_server_does():
    texts = [TASK,
             "```python\nx = 1\n```\n```task\nTITLE: one\nfirst\n```\n```\n```task\ncode\n```\n``` task\nsecond\n```\n"
             "```task\nthird, never closed",
             "no tasks here\n```\ncode\n```"]
    got = _ts([("splitTasks", t) for t in texts])
    for text, segs in zip(texts, got):
        mine = [s["task"] for s in segs if "task" in s]
        assert mine == tasks.parse(text), text
    assert got[2] == [{"md": texts[2]}]


def test_a_task_fence_renders_as_a_box():
    html, plain_line, code = _ts([("toHtml", TASK), ("plain", TASK),
                                  ("toHtml", "```\n```task\nnot a task\n```")])
    assert '<div class="md-task">' in html and '<span class="md-task-label">Task</span>' in html
    assert '<b class="md-task-title">Seat the screen</b>' in html
    assert '<span class="md-task-target">iot-fan/assemblies/base</span>' in html
    assert '<div class="md-task-body md"><p>Use the real STEP.</p></div>' in html
    assert html.startswith("<p>Sure:</p>") and "```" not in html
    assert "Seat the screen" in plain_line and "```" not in plain_line
    assert "md-task" not in code and "<pre><code>```task\nnot a task</code></pre>" == code


# ---------------------------------------------------------------- translation: the agent's questions only

def test_only_the_question_cards_offer_translation():
    """The thread translates the agent's questions (text, context, options),
    with the language chosen on the card; ordinary lines are never
    translated, and the thread's header has no language picker."""
    import re
    from pathlib import Path
    src = (Path(__file__).resolve().parents[1] / "frontend/src/app/rooms/agent-thread.ts").read_text()
    header = src[src.index('<header class="tcv-cc-bar">'):src.index("</header>")]
    assert "rl-reading" not in header
    lines = src[src.index("@case ('line')"):src.index("@case ('q')")]
    assert "reading" not in lines and "rl-reading" not in lines
    card = src[src.index("@case ('q')"):src.index("@if (!items().length)")]
    assert "<rl-reading-pick" in card and 'kind="question"' in card
    for shown in ("tq?.text ?? q.text", "tq?.context ?? q.context", "tq?.options?.[k] ?? o"):
        assert shown in card, shown
    assert re.search(r"reading\.ensure\('question'", src)
    assert "'chat'" not in src.split("reading.ensure", 1)[1][:40]


# ---------------------------------------------------------------- answered questions stay in the thread

def test_answered_questions_are_kept_for_their_rooms_log(app):
    from backend import questions
    client, d = app
    q1 = run(questions.ask(d, "Which wall?", ["2.0 mm", "2.4 mm"], room="cad"))
    q2 = run(questions.ask(d, "Which net?", room="pcb"))
    q3 = run(questions.ask(d, "Still open?", room="cad"))
    q4 = run(questions.ask(d, "Withdrawn", room="cad"))
    assert client.post(f"/api/questions/{q1['_id']}/answer", json={"answer": "2.4 mm"}).status_code == 200
    assert client.post(f"/api/questions/{q2['_id']}/answer", json={"answer": "SDA"}).status_code == 200
    run(questions.drop(d, q4["_id"]))
    got = client.get("/api/questions/answered?room=cad").json()
    assert [q["_id"] for q in got] == [q1["_id"]]
    q = got[0]
    assert q["status"] == "answered" and q["answer"] == "2.4 mm" and q["answered_at"]
    assert q["answered_by"]["name"] and q["options"] == ["2.0 mm", "2.4 mm"] and q["room"] == "cad"
    assert [x["_id"] for x in client.get("/api/questions/answered?room=pcb").json()] == [q2["_id"]]
    # Still open is still the open list's, and only there.
    assert [x["_id"] for x in client.get("/api/questions").json()] == [q3["_id"]]
    assert access.allowed("viewer", access.action("GET", "/api/questions/answered"))


def _thread_src():
    from pathlib import Path
    return (Path(__file__).resolve().parents[1] / "frontend/src/app/rooms/agent-thread.ts").read_text()


def test_the_thread_keeps_answered_questions_in_time_order_with_their_answer():
    src = _thread_src()
    at = src.index("items = computed<ThreadItem[]>")
    items = src[at:src.index("\n  });", at)]
    # each answered question at its time, its answer at the answer's time, open ones last
    assert "kind: 'q'" in items and "kind: 'answer'" in items and "q.answered_at || q.at" in items
    assert "...open.map(" in items
    card = src[src.index("@case ('q')"):src.index("@if (!items().length)")]
    assert "chosen(q, o)" in card and "rl-reading-pick" in card and 'kind="question"' in card
    # answered: no controls - the chosen row (or the person's own words) marked, with who and when
    done = card[card.index("@if (!open) {"):card.index("} @else if (auth.can('draw'))")]
    assert "tcv-answer-mark" not in done and "<button" not in done.split("<div class=\"tcv-answers\">")[1]
    assert "<textarea" not in done and "whoAnswered(q)" in done and "@if (own)" in done
    answer = src[src.index("@case ('answer')"):src.index("@case ('q')")]
    assert "a.answer" in answer and "a.answered_by" in answer
    # answering keeps it in the room's log
    send = src[src.index("sendAnswer(q: Question"):]
    assert "this.answered.update(" in send


def test_one_avatar_per_run_questions_included():
    src = _thread_src()
    assert src.count("hide: same(i)") >= 4                # lines (agent, user), answers, questions
    assert "hide: false" not in src
    sender = src[src.index("export function sender"):src.index("}\n", src.index("export function sender"))]
    assert "if (it.kind === 'q') return 'agent';" in sender


def test_the_question_card_has_one_border_colour():
    import re
    from pathlib import Path
    css = (Path(__file__).resolve().parents[1] / "frontend/src/styles.css").read_text()
    rule = re.search(r"\.tcv-th-q \{[^}]*\}", css).group(0)
    assert "border: 1px solid var(--line)" in rule and "--pen" not in rule
