"""The Chat's pdf_make tool (backend/chat_tools/pdf_make.py).

What matters: the document is kept in the asker's own Files (the
workspace's), by the asker, in Documents (or Documents/<project>, or the
folder asked for), under a name that is not already there; it needs the
right to add a file (draw) - a viewer gets nothing; the step carries the
file so the page can open it, and the model is told how to link it.
Nothing is printed here: the renderer is faked (test_pdfdoc.py prints for
real), and so is GridFS.
"""

from __future__ import annotations

import pytest

from backend import cc_chat, chat_tools, files, pdfdoc
from backend.chat_tools import Ctx, ToolError
from tests.test_cc_generation import answers
from tests.test_cc_mentions_live_search import env, events, seed_chat  # noqa: F401 - env is a fixture
from tests.test_chat_tools import run, tool_model

ME = {"id": "u-me", "name": "Me", "type": "person"}


@pytest.fixture
def fake_print(monkeypatch):
    made = []

    async def make(doc, db=None):
        made.append((doc, db))
        return pdfdoc.Made(pdf=b"%PDF-1.7 fake" + b"x" * 3000, pages=3, missing=[])
    monkeypatch.setattr(pdfdoc, "make", make)

    class Bucket:
        async def upload_from_stream(self, name, data):
            return "grid-" + name
    monkeypatch.setattr(files, "_bucket", lambda db: Bucket())
    return made


def _tool():
    return chat_tools.tools()["pdf_make"]


def test_it_is_a_files_change_tool_on_by_default_with_its_writing_guide():
    t = _tool()
    assert (t.package, t.level, t.default) == ("commandcode", "change", True)
    for words in ("summary", "'## '", "units", "datasheet p.", "Gather the facts first", "/api/files/<id>?inline=1"):
        assert words in t.description
    assert "pdf_make" in chat_tools.SYSTEM_NOTE


def test_it_keeps_the_pdf_in_the_askers_files(env, fake_print):
    raw, state = env
    db = cc_chat._db()
    got = run(_tool().run(Ctx(db=db, actor=ME, chat="c1"), {
        "title": "Fan BOM comparison", "purpose": "Pick the cheaper build", "body": "**Summary.** B.",
        "page_size": "letter", "sections": [{"title": "Costs", "body": "| a |\n|---|\n| 1 |"}]}))
    (doc, used_db), = fake_print
    assert used_db is db and doc.author == "Me" and doc.size == "Letter" and doc.purpose == "Pick the cheaper build"
    assert doc.sections == [{"title": "Costs", "body": "| a |\n|---|\n| 1 |"}]
    (f,) = raw["files"].rows.values()
    assert f["name"] == "Fan BOM comparison.pdf" and f["content_type"] == "application/pdf" and f["kind"] == "pdf"
    assert f["workspace_id"] == "default" and f["by"] == ME and f["note"] == "Pick the cheaper build"
    assert f["context"] == {"room": "commandcode", "chat": "c1"}
    # the Chat's own (Files > In the app > Chat): kept under the Chat folder, not in My files
    folder = next(x for x in raw["file_folders"].rows.values() if x["_id"] == f["folder"])
    assert folder["path"] == "Chat/Documents" and folder["workspace_id"] == "default"
    assert got.say == "Made {name} · {pages} pages"
    assert got.vars == {"name": "Fan BOM comparison.pdf", "pages": 3, "file": f["_id"], "size": "3 KB",
                        "folder": "Chat/Documents"}
    assert f"[Fan BOM comparison.pdf](/api/files/{f['_id']}?inline=1)" in got.text

    # The same title again: a name of its own, beside the first.
    again = run(_tool().run(Ctx(db=db, actor=ME), {"title": "Fan BOM comparison", "body": "x"}))
    assert again.vars["name"] == "Fan BOM comparison (2).pdf"
    # A project: its own folder under Documents; a folder asked for wins; a name asked for is cleaned.
    p = run(_tool().run(Ctx(db=db, actor=ME), {"title": "Spec", "body": "x", "project": "fan-ctrl-b",
                                               "author": "Ann", "filename": "../../etc/spec v2"}))
    assert p.vars["folder"] == "Chat/Documents/fan-ctrl-b" and p.vars["name"] == "etc spec v2.pdf"
    assert fake_print[-1][0].author == "Ann" and fake_print[-1][0].project == "fan-ctrl-b"
    q = run(_tool().run(Ctx(db=db, actor=ME), {"title": "Q", "body": "x", "folder": "Reports/2026"}))
    assert q.vars["folder"] == "Chat/Documents/Reports/2026"


def test_another_workspace_does_not_see_it(env, fake_print):
    raw, state = env
    state["ws"] = "team2"
    run(_tool().run(Ctx(db=cc_chat._db(), actor=ME), {"title": "T", "body": "x"}))
    (f,) = raw["files"].rows.values()
    assert f["workspace_id"] == "team2"
    state["ws"] = "default"
    assert run(cc_chat._db()[files.COLL].find_one({"_id": f["_id"]})) is None


def test_a_viewer_may_not_and_nothing_is_printed(env, fake_print):
    raw, state = env
    state["role"] = "viewer"
    with pytest.raises(ToolError, match="draw|may not|not allowed|viewer"):
        run(_tool().run(Ctx(db=cc_chat._db(), actor=ME), {"title": "T", "body": "x"}))
    assert fake_print == [] and not raw["files"].rows


def test_what_it_refuses(env, fake_print):
    db = cc_chat._db()
    with pytest.raises(ToolError, match="title"):
        run(_tool().run(Ctx(db=db), {"title": " ", "body": "x"}))
    with pytest.raises(ToolError, match="no text"):
        run(_tool().run(Ctx(db=db), {"title": "T", "body": "  "}))
    with pytest.raises(ToolError, match="page_size"):
        run(_tool().run(Ctx(db=db), {"title": "T", "body": "x", "page_size": "A3"}))


def test_a_printing_failure_is_the_steps_error(env, fake_print, monkeypatch):
    raw, _ = env

    async def make(doc, db=None):
        raise pdfdoc.RenderError("the PDF took longer than 90 s")
    monkeypatch.setattr(pdfdoc, "make", make)
    with pytest.raises(ToolError, match="longer than 90 s"):
        run(_tool().run(Ctx(db=cc_chat._db()), {"title": "T", "body": "x"}))
    assert not raw["files"].rows


def test_the_model_makes_one_and_the_step_carries_the_file(env, monkeypatch, fake_print):
    raw, state = env
    seed_chat(raw)
    tool_model(monkeypatch, state, [
        ("", [("pdf_make", {"title": "Report", "purpose": "Why", "body": "Summary."})]),
        ("Here it is.", []),
    ])
    events(cc_chat.say("c1", cc_chat.SayIn(text="Make me a PDF", client="tab1")))
    (last,) = answers(raw)
    (step,) = last["steps"]
    assert step["tool"] == "pdf_make" and step["status"] == "done" and step["level"] == "change"
    fid = step["vars"]["file"]
    assert step["vars"]["name"] == "Report.pdf" and step["vars"]["pages"] == 3 and fid in raw["files"].rows
    assert "pdf_make" in {t["name"] for t in state["rounds"][0]["tools"]}
