"""The Chat's file_ocr tool (backend/chat_tools/file_ocr.py): the words on a
file that has no text layer - a scan, a photograph of a document, a
screenshot - written out by a model that sees the pages (backend/ocrtext.py,
the file_ocr job).

What matters: it is a Files tool that only reads and is on by default; the
file is named by its id or by what the person's line attached; the words come
back in `Result.text` (never as a picture of them); a long text is read a part
at a time; a read that has not finished says to ask again; a file whose words
cannot be read is a ToolError; and its sentences are Turkish too, with an
icon. No model is called: llm.complete and the vision check are faked.
"""

from __future__ import annotations

import asyncio

import pytest

from backend import cc_chat, chat_tools, files, llm, ocrtext, scope, taste
from backend.chat_tools import Ctx, ToolError
from test_links import FakeDb

ME = {"id": "u-me", "name": "Me", "type": "person"}
WORDS = "GLASS HEIGHT 1.45 mm"


def run(c):
    return asyncio.run(c)


def _tool():
    return chat_tools.tools()["file_ocr"]


@pytest.fixture
def ws(monkeypatch):
    """A workspace with the tool's own store, and no read left from another test."""
    monkeypatch.setattr(ocrtext, "_running", {})
    return scope.ScopedDb(FakeDb(), "default")


def put(db, fid: str = "f1", name: str = "scan.pdf", **kw):
    doc = {"_id": fid, "name": name, "kind": "pdf", "content_type": "application/pdf", "bytes": 1000,
           "sha256": "s" + fid, "created_at": "2026-10-01T10:00:00+00:00", "folder": "", **kw}
    run(db[files.COLL].insert_one(doc))
    return doc


def ctx(db, chat: str = "", vision: bool = True) -> Ctx:
    return Ctx(db=db, vision=vision, actor=ME, chat=chat)


def reading(text: str, state: str = "ready"):
    """The read, faked: what the tool says to the model, and what it was asked."""
    asked = {}

    async def words(db, doc, wait=1.5, lang=""):
        asked.update({"doc": doc, "wait": wait, "lang": lang})
        return (state, text if state == "ready" else text) if state != "ready" else ("ready", text)
    return words, asked


def test_it_is_a_files_tool_that_only_reads_and_is_on_by_default():
    t = _tool()
    assert (t.package, t.level, t.default) == ("files", "read", True)
    assert t.label and t.about and t.running and t.failed and t.description
    assert "file_ocr" in chat_tools.SYSTEM_NOTE
    for words in ("no text layer", "OCR", "(p. N)"):
        assert words in t.description, words
    # In the Files package, between the file tools the model already has.
    order = list(chat_tools.tools())
    assert order.index("file_read") < order.index("file_ocr") < order.index("files_restore")


def test_a_file_is_named_by_its_id_or_by_what_the_line_attached(ws, monkeypatch):
    db = ws
    put(db, "f1")
    put(db, "f2", "photo.png", kind="image", content_type="image/png")
    words, asked = reading(WORDS)
    monkeypatch.setattr(ocrtext, "words", words)
    got = run(_tool().run(ctx(db), {"file": "f2"}))
    assert got.text.splitlines()[0] and WORDS in got.text and asked["doc"]["_id"] == "f2"
    assert got.vars == {"file": "f2", "name": "photo.png", "page": 1, "parts": 1, "chars": len(WORDS)}
    assert got.say == "Read the words on {name}"
    assert got.summary == WORDS
    # No file named: the one the person's latest line carried.
    run(db[cc_chat.COLL].insert_one({"_id": "c1", "messages": [
        {"role": "user", "content": "what does this say?", "mentions": [{"kind": "file", "id": "f1"}]}]}))
    got = run(_tool().run(ctx(db, chat="c1"), {}))
    assert asked["doc"]["_id"] == "f1" and WORDS in got.text


def test_with_no_file_named_or_attached_it_says_which_to_give(ws, monkeypatch):
    monkeypatch.setattr(ocrtext, "words", reading(WORDS)[0])
    with pytest.raises(ToolError, match="attach"):
        run(_tool().run(ctx(ws, chat="c1"), {}))
    with pytest.raises(ToolError, match="no file"):
        run(_tool().run(ctx(ws), {"file": "nothing like it"}))


def test_the_words_come_back_as_text_and_a_long_one_a_part_at_a_time(ws, monkeypatch):
    db = ws
    put(db)
    long = "A" * 100 + "\n" + "B" * 20_000               # three parts of PAGE_CHARS, the last line cut
    monkeypatch.setattr(ocrtext, "words", reading(long)[0])
    got = run(_tool().run(ctx(db), {"file": "f1"}))
    assert got.vars["parts"] == 3 and got.vars["page"] == 1
    assert got.say == "Read the words on {name} · part {page} of {parts}"
    assert len(got.text) < 15_000 and "ask for part 2" in got.text
    assert "A" * 100 in got.text and "B" not in got.text            # only the first part
    assert got.image is None                                        # the text, never a picture of it
    two = run(_tool().run(ctx(db), {"file": "f1", "page": 2}))
    assert two.vars["page"] == 2 and two.text.count("B") == 12_000 and "ask for part 3" in two.text


def test_a_read_that_has_not_finished_says_to_ask_again(ws, monkeypatch):
    db = ws
    put(db)
    monkeypatch.setattr(ocrtext, "words", reading("", "making")[0])
    got = run(_tool().run(ctx(db), {"file": "f1"}))
    assert got.say == "Still reading {name}" and got.vars == {"file": "f1", "name": "scan.pdf"}
    assert str(ocrtext.RETRY_AFTER) in got.text and "costs nothing" in got.text
    assert got.summary == "still reading"


def test_a_file_whose_words_cannot_be_read_is_an_error(ws, monkeypatch):
    db = ws
    put(db, "f1", "notes.txt", kind="text", content_type="text/plain")
    monkeypatch.setattr(ocrtext, "words", reading("the words here are read from a picture or a PDF", "none")[0])
    with pytest.raises(ToolError, match="nothing like it|no words|picture or a PDF"):
        run(_tool().run(ctx(db), {"file": "f1"}))


def test_it_reads_a_scanned_page_with_a_model(ws, monkeypatch):
    """The whole way: the tool, backend/ocrtext.py and the model call (faked)."""
    import io

    from PIL import Image
    db = ws
    put(db)
    buf = io.BytesIO()
    Image.new("RGB", (595, 842), (255, 255, 255)).save(buf, "PDF")
    data = buf.getvalue()

    async def get(db_, fid):
        return {"_id": fid, "name": "scan.pdf"}, data

    async def complete(messages, **kw):
        assert kw["job"] == "file_ocr" and messages[1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg")
        return {"choices": [{"message": {"content": "--- page 1 ---\n" + WORDS}}], "usage": {},
                "provider": kw["provider"], "model": kw["model"]}

    async def reads_images(prov, model):
        return True

    async def record(db_, **kw):
        pass

    monkeypatch.setattr(files, "get", get)
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "record", record)
    monkeypatch.setattr(llm, "key", lambda p: "a-key")
    monkeypatch.setattr(taste, "reads_images", reads_images)
    got = run(_tool().run(ctx(db), {"file": "f1"}))
    assert WORDS in got.text and "a model looked at" in got.text and "(p. N)" in got.text
    assert got.say == "Read the words on {name}" and got.image is None


def test_its_sentences_are_in_turkish_too():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()

    def has(s):
        return f"'{s}':" in tr or f"'{s.replace(chr(39), chr(92) + chr(39))}':" in tr
    t = _tool()
    for s in (t.label, t.about, t.running, t.failed):
        assert has(s), s
    assert "file_ocr:" in icons
    for s in ("Still reading {name}", "Read the words on {name}", "Read the words on {name} · part {page} of {parts}"):
        assert has(s), s
    # The job it uses, and the prompt it sends, are on the settings page in Turkish too.
    for s in ("Read a file's text (OCR)", "the words on a picture or a scanned page"):
        assert has(s), s
