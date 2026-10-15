"""A Chat conversation written out (backend/chat_export.py): as Markdown or
as a PDF through the PDF printer (backend/pdfdoc.py, faked here - the real
one is printed in test_pdfdoc.py).

What matters: the title, the day and the models are there; every line in
order with who wrote it - a person by name, never by e-mail address - and
when; its Markdown as written (code stays code); each tool step in one
line; the pictures sent with a line and those a render took; the model's
thinking and the context read for a mention stay out. The file is the
Chat's, kept in Files under Chat/Exports with the conversation, by whoever
exported it, and the trail says so. Exporting takes the draw right.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend import access, actors, chat_export, files, pdfdoc
from tests.test_chat_tools import run
from tests.test_cc_mentions_live_search import env, line, seed_chat  # noqa: F401 - env is a fixture

AYSE = {"id": "u-ayse", "name": "ayse.k@example.com", "type": "user"}


@pytest.fixture
def fake_print(monkeypatch):
    made = []

    async def make(doc, db=None):
        made.append((doc, db))
        return pdfdoc.Made(pdf=b"%PDF-1.7 fake" + b"x" * 2000, pages=2, missing=[])
    monkeypatch.setattr(pdfdoc, "make", make)

    class Bucket:
        async def upload_from_stream(self, name, data):
            Bucket.kept[name] = data
            return "grid-" + name
    Bucket.kept = {}
    monkeypatch.setattr(files, "_bucket", lambda db: Bucket())
    trail = []

    async def audit(db, action, target, detail=None, actor=None):
        trail.append((action, target, detail))
    monkeypatch.setattr(actors, "audit", audit)
    return made, Bucket.kept, trail


def _seed(raw):
    ask = {**line("m1", "user", "Render the bracket and make a PDF.\n\n```py\nprint('hi')\n```", by=AYSE,
                  at="2026-10-12T11:03:00+00:00"),
           "context": "SECRET CONTEXT OF THE MENTION",
           "mentions": [{"kind": "file", "id": "pic123", "label": "bench.jpg", "image": True},
                        {"kind": "board", "id": "ctrl", "label": "Controller"}]}
    answer = {**line("m2", "assistant", "Here are the views.Then the PDF.", at="2026-10-12T11:04:00+00:00"),
              "model": "anthropic/claude-haiku-5-5", "provider": "openrouter", "thinking": "SECRET THOUGHTS",
              "steps": [
                  {"id": "s1", "tool": "model_render", "status": "done", "pos": 0, "say": "Took {n} pictures of {title}",
                   "vars": {"title": "Bracket", "n": 2, "shot0": "iso:shotA1", "shot1": "top:shotB2"},
                   "result": "SECRET RESULT"},
                  {"id": "s2", "tool": "pdf_make", "status": "done", "pos": 19, "say": "Made {name} · {pages} pages",
                   "vars": {"name": "Bracket.pdf", "pages": 3, "file": "pdf999"}},
                  {"id": "s3", "tool": "web_search", "status": "error", "pos": 19, "say": "Could not search the web",
                   "error": "no key"}]}
    second = {**line("m3", "assistant", "A follow-up.", at="2026-10-12T11:06:00+00:00"), "model": "qwen3.8-flash"}
    seed_chat(raw, "c1", [ask, answer, second], title="Bracket review", created_at="2026-10-12T11:00:00+00:00")


def _md(raw, kept) -> tuple[dict, str]:
    (f,) = raw["files"].rows.values()
    return f, kept[f["name"]].decode()


def test_the_rule_is_draw_and_a_viewer_may_not():
    act = access.action("POST", "/api/cc/chats/abc/export")
    assert act == "draw"
    assert not access.allowed("viewer", act) and access.allowed("reviewer", act)


def test_markdown_holds_the_conversation_and_is_kept_in_chat_exports(env, fake_print):
    raw, state = env
    _seed(raw)
    got = run(chat_export.export_chat("c1", chat_export.ExportIn(format="md")))
    f, md = _md(raw, fake_print[1])
    assert got["format"] == "md" and got["id"] == f["_id"] and got["folder"] == "Chat/Exports"
    assert f["name"].startswith("Bracket review ") and f["name"].endswith(".md") and f["content_type"].startswith("text/markdown")
    assert f["context"] == {"room": "commandcode", "chat": "c1"} and f["by"]["id"] == state["who"]["id"]
    folder = next(x for x in raw["file_folders"].rows.values() if x["_id"] == f["folder"])
    assert folder["path"] == "Chat/Exports"

    assert md.startswith("# Bracket review\n")
    assert "Date: 12 Oct 2026" in md and "Models: claude-haiku-5-5, qwen3.8-flash" in md and "Lines: 3" in md
    # who wrote it, by name - never the address
    assert "### ayse.k · 12 Oct 2026, 14:03" in md and "example.com" not in md
    assert "### claude-haiku-5-5 · 12 Oct 2026, 14:04" in md
    # the Markdown as written: the code block stays one
    assert "```py\nprint('hi')\n```" in md
    # a step is one line, in place, with the page's sentence filled in
    assert "- *Took 2 pictures of Bracket*" in md and "- *Could not search the web (no key)* · failed" in md
    assert "Made Bracket.pdf · 3 pages*" in md and "no key" in md and "· failed" in md
    assert md.index("Took 2 pictures") < md.index("Here are the views") < md.index("Bracket.pdf") < md.index("Then the PDF")
    # the pictures: the one sent, and the render's two, side by side
    assert "![bench.jpg](/api/files/pic123?inline=1)" in md
    assert "![Bracket iso](/api/files/shotA1?inline=1) ![Bracket top](/api/files/shotB2?inline=1)" in md
    assert "Files: Controller" in md
    # what stays out
    for secret in ("SECRET THOUGHTS", "SECRET CONTEXT", "SECRET RESULT"):
        assert secret not in md
    # the trail
    (a,) = [r for r in fake_print[2] if r[0] == "export"]
    assert a[1] == "chat c1" and a[2]["format"] == "md" and a[2]["file"] == f["_id"]


def test_turkish_labels_and_the_pages_own_step_sentences(env, fake_print):
    raw, _ = env
    _seed(raw)
    run(chat_export.export_chat("c1", chat_export.ExportIn(format="md", lang="tr",
                                                         lines={"s1": "Bracket için 2 resim çekti"})))
    _, md = _md(raw, fake_print[1])
    assert "Tarih: 12 Oct 2026" in md and "Modeller: claude-haiku-5-5" in md and "Satır: 3" in md
    assert "- *Bracket için 2 resim çekti*" in md and "· başarısız" in md


def test_a_second_export_gets_a_name_of_its_own(env, fake_print):
    raw, _ = env
    _seed(raw)
    a = run(chat_export.export_chat("c1", chat_export.ExportIn(format="md")))
    b = run(chat_export.export_chat("c1", chat_export.ExportIn(format="md")))
    assert b["name"] == a["name"][:-3] + " (2).md"


def test_pdf_goes_through_the_printer_with_title_date_and_models(env, fake_print):
    raw, _ = env
    _seed(raw)
    got = run(chat_export.export_chat("c1", chat_export.ExportIn(format="pdf", size="Letter")))
    (doc, used_db), = fake_print[0]
    assert used_db is not None
    assert doc.title == "Bracket review" and doc.author == "" and doc.size == "Letter" and doc.lang == "en"
    assert doc.created.isoformat().startswith("2026-10-12T11:00")
    assert ("Models", "claude-haiku-5-5, qwen3.8-flash") in doc.meta and ("Lines", "3") in doc.meta
    # the title is printed by the page, not repeated in the body; no address anywhere
    assert not doc.body.startswith("# ") and "### ayse.k" in doc.body and "example.com" not in doc.body
    assert "![bench.jpg](/api/files/pic123?inline=1)" in doc.body
    (f,) = raw["files"].rows.values()
    assert got == {"id": f["_id"], "name": f["name"], "bytes": f["bytes"], "folder": "Chat/Exports",
                   "format": "pdf", "pages": 2}
    assert f["name"].endswith(".pdf") and f["content_type"] == "application/pdf"


def test_the_pdf_title_block_shows_the_extra_rows():
    page = pdfdoc.page_html(pdfdoc.Doc(title="T", meta=[("Models", "m1, m2"), ("Empty", "")]), "<p>x</p>")
    assert "<dt>Models</dt><dd>m1, m2</dd>" in page and "Empty" not in page


def test_a_printing_failure_keeps_nothing(env, fake_print, monkeypatch):
    raw, _ = env
    _seed(raw)

    async def make(doc, db=None):
        raise pdfdoc.RenderError("the PDF took longer than 90 s")
    monkeypatch.setattr(pdfdoc, "make", make)
    with pytest.raises(HTTPException) as e:
        run(chat_export.export_chat("c1", chat_export.ExportIn(format="pdf")))
    assert e.value.status_code == 502 and "90 s" in e.value.detail
    assert not raw["files"].rows


def test_what_it_refuses(env, fake_print):
    raw, _ = env
    _seed(raw)
    seed_chat(raw, "empty", [])
    seed_chat(raw, "gone", [line("x", "user", "hi")], deleted_at="2026-10-12T11:00:00+00:00")
    for cid, fmt, code in (("c1", "docx", 422), ("nope", "md", 404), ("gone", "md", 404), ("empty", "md", 409)):
        with pytest.raises(HTTPException) as e:
            run(chat_export.export_chat(cid, chat_export.ExportIn(format=fmt)))
        assert e.value.status_code == code, (cid, fmt)
    assert not raw["files"].rows


def test_another_workspace_cannot_export_it(env, fake_print):
    raw, state = env
    _seed(raw)
    state["ws"] = "team2"
    with pytest.raises(HTTPException) as e:
        run(chat_export.export_chat("c1", chat_export.ExportIn(format="md")))
    assert e.value.status_code == 404


def test_a_step_without_a_sentence_is_its_tools_name():
    lab = chat_export.LABELS["en"]
    assert chat_export.step_line({"id": "s", "tool": "pdf_make", "status": "done"}, lab) == "- *Make a PDF*"
    assert chat_export.step_line({"id": "s", "tool": "pdf_make", "status": "denied"}, lab) == "- *Make a PDF* · not allowed"
    # what a step says is text, never markup of its own
    assert chat_export.step_line({"id": "s", "tool": "x", "say": "a *b* [c](d)"}, lab) == "- *a \\*b\\* \\[c\\](d)*"
