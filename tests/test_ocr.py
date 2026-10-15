"""The words on a page that has no text layer (backend/ocrtext.py): a model
that reads images is shown the pages and writes their words out, a PDF's own
pages come from PDFium instead, the words are kept by the file's content -
made once, for every copy of it - a file that kept no words is kept as such,
a read that has not finished says so (202 and "making"), a read with no model
that sees, or with no key, says which to set, and the words go with the last
copy of the file.

No model is called: llm.complete and the vision check are faked, so nothing
leaves the machine. The routes run over the in-memory Mongo and GridFS
stand-ins of test_files_folders.
"""

from __future__ import annotations

import asyncio
import io

import pytest
from fastapi.testclient import TestClient

from backend import access, auth, files, llm, ocrtext, taste
from backend import main as M
from test_files_folders import H, Grid, up
from test_links import FakeDb
from test_pdftext import make_pdf

ANSWER = "--- page 1 ---\nGLASS HEIGHT 1.45 mm"
WORDS = "GLASS HEIGHT 1.45 mm"
PDF = make_pdf([["OLED 0.91 inch", "Glass height 1.45 mm"]])


def scan() -> bytes:
    """A page with no text layer at all: a picture written into a PDF."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (595, 842), (255, 255, 255)).save(buf, "PDF")
    return buf.getvalue()


def png(size=(600, 800)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, (250, 250, 250)).save(buf, "PNG")
    return buf.getvalue()


class Model:
    """A model that reads images, faked: what it answers, and what it was asked."""

    def __init__(self, answer: str = ANSWER):
        self.answer, self.calls = answer, []

    def install(self, monkeypatch, vision: bool = True, key: str | None = "a-key"):
        async def complete(messages, **kw):
            self.calls.append((messages, kw))
            return {"choices": [{"message": {"content": self.answer}}], "usage": {"prompt_tokens": 9},
                    "provider": kw.get("provider"), "model": kw.get("model")}

        async def reads_images(prov: str, model: str) -> bool:
            return vision

        async def record(db, **kw):
            pass

        monkeypatch.setattr(llm, "complete", complete)
        monkeypatch.setattr(llm, "record", record)
        monkeypatch.setattr(taste, "reads_images", reads_images)
        monkeypatch.setattr(llm, "key", lambda p: key)


@pytest.fixture
def env(monkeypatch):
    db, grid = FakeDb(), Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    monkeypatch.setattr(ocrtext, "_running", {})
    return {"db": db, "web": TestClient(M.app)}


def words(web, fid, **kw):
    return web.get(f"/api/files/{fid}/text", params=kw)


# ---------------------------------------------------------------- read, and kept

def test_a_scanned_page_is_read_by_a_model_that_sees_it(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")
    r = words(web, f["id"], wait=30)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["text"] == WORDS and got["chars"] == len(WORDS)      # a one-page file has no page line
    assert got["name"] == "scan.pdf" and got["id"] == f["id"]
    (messages, kw), = model.calls
    assert kw["job"] == "file_ocr" and kw["provider"] == "openrouter"
    assert kw["model"] == "google/gemini-3.1-flash-lite"          # the job's own default
    system, user = messages
    assert "'--- page N ---'" in system["content"] and "language it is written in" in system["content"]
    assert user["content"][0] == {"type": "text", "text": "--- page 1 ---"}
    url = user["content"][1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,") and len(url) > 1000
    kept, = db[ocrtext.COLL].rows
    assert kept["sha256"] == f["sha256"] and kept["kind"] == "pdf" and kept["text"] == WORDS


def test_the_words_are_of_the_content_so_every_copy_shares_them(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    a = up(web, "scan.pdf", scan(), ctype="application/pdf")
    b = up(web, "the same scan again.pdf", scan(), ctype="application/pdf")
    assert words(web, a["id"], wait=30).status_code == 200
    assert words(web, b["id"], wait=30).json()["text"] == WORDS
    assert len(model.calls) == 1                                  # one read for the content, not per file
    assert len(db[ocrtext.COLL].rows) == 1

    async def no(*a, **kw):
        pytest.fail("read again")
    monkeypatch.setattr(ocrtext, "_ask", no)
    assert words(web, a["id"]).json()["text"] == WORDS             # and it is not read again


def test_an_image_is_the_models_one_page(env, monkeypatch):
    web = env["web"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "photo.png", png(), ctype="image/png")
    r = words(web, f["id"], wait=30)
    assert r.status_code == 200, r.text
    # The page line is the model's own: a one-page file reads as plain words.
    assert r.json()["text"] == WORDS
    assert len(model.calls) == 1


def test_a_pdf_that_carries_its_own_text_costs_no_call(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "sheet.pdf", PDF, ctype="application/pdf")
    r = words(web, f["id"], wait=30)
    assert r.status_code == 200, r.text
    assert "Glass height 1.45 mm" in r.json()["text"]             # PDFium's own page
    assert model.calls == [] and len(db[ocrtext.COLL].rows) == 1


def test_the_language_asked_for_is_read_of_its_own(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")
    assert words(web, f["id"], wait=30, lang="en").status_code == 200
    assert words(web, f["id"], wait=30).status_code == 200
    assert len(model.calls) == 2 and len(db[ocrtext.COLL].rows) == 2
    assert "in English" in model.calls[0][0][0]["content"]
    assert model.calls[0][1] == {**model.calls[1][1]}             # same job, same model, only the words differ


# ---------------------------------------------------------------- a read that takes a while

def test_a_read_that_has_not_finished_says_so(env, monkeypatch):
    web = env["web"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")

    async def making(db, doc, wait=1.5, lang=""):
        return "making", None

    async def busy(db, doc, wait=1.5, lang=""):
        return "busy", None

    monkeypatch.setattr(ocrtext, "words", making)
    r = words(web, f["id"])
    assert r.status_code == 202 and r.json() == {"state": "making"}
    assert int(r.headers["retry-after"]) == ocrtext.RETRY_AFTER and "no-store" in r.headers["cache-control"]
    monkeypatch.setattr(ocrtext, "words", busy)
    r = words(web, f["id"])
    assert r.status_code == 202 and r.json() == {"state": "busy"}


def test_the_first_asker_starts_it_and_the_next_gets_the_words(monkeypatch):
    monkeypatch.setattr(ocrtext, "_running", {})
    db = FakeDb()
    model = Model()
    model.install(monkeypatch)
    doc = {"_id": "f1", "name": "scan.pdf", "kind": "pdf", "bytes": 1000, "sha256": "s1"}

    async def slow(db_, prov, model_, pages, lang):
        await asyncio.sleep(0.05)
        return ANSWER

    async def read(db_, doc_):
        return scan()

    monkeypatch.setattr(ocrtext, "_ask", slow)
    monkeypatch.setattr(ocrtext, "_read", read)

    async def go():
        assert await ocrtext.words(db, doc, 0) == ("making", None)      # the read goes on without the asker
        return await ocrtext.words(db, doc, 30)
    state, got = asyncio.run(go())
    assert state == "ready" and got == WORDS


def test_past_the_queue_the_answer_is_busy(monkeypatch):
    monkeypatch.setattr(ocrtext, "_running", {})
    monkeypatch.setattr(ocrtext, "QUEUE_MAX", 0)
    doc = {"_id": "f1", "name": "scan.pdf", "kind": "pdf", "bytes": 1000, "sha256": "s1"}
    assert asyncio.run(ocrtext.words(FakeDb(), doc, 5)) == ("busy", None)


# ---------------------------------------------------------------- what cannot be read

def test_a_file_that_kept_no_words_keeps_that_too(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "broken.pdf", b"%PDF-1.4 nothing", ctype="application/pdf")
    r = words(web, f["id"], wait=30)
    assert r.status_code == 404 and r.json()["detail"]
    kept, = db[ocrtext.COLL].rows
    assert kept["none"] and not kept.get("text")

    async def no(*a, **kw):
        pytest.fail("tried again")
    monkeypatch.setattr(ocrtext, "_ask", no)
    assert words(web, f["id"], wait=30).status_code == 404       # not tried again on every view


def test_a_kind_no_one_reads_words_from(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "notes.txt", b"hello")
    r = words(web, f["id"])
    assert r.status_code == 404 and "picture or a PDF" in r.json()["detail"]
    assert model.calls == [] and db[ocrtext.COLL].rows == []


def test_without_a_model_that_reads_images_it_says_which_to_pick(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch, vision=False)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")
    r = words(web, f["id"], wait=30)
    assert r.status_code == 404 and "no configured model reads images" in r.json()["detail"]
    assert "Settings > LLM settings" in r.json()["detail"]
    assert model.calls == [] and db[ocrtext.COLL].rows == []      # not kept: a model can be chosen any moment


def test_without_a_key_it_says_where_to_add_one(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch, key=None)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")
    r = words(web, f["id"], wait=30)
    assert r.status_code == 404 and "OpenRouter" in r.json()["detail"]
    assert model.calls == [] and db[ocrtext.COLL].rows == []


# ---------------------------------------------------------------- rights, places, and going

def test_the_words_go_with_the_last_copy(env, monkeypatch):
    from test_files_virtual import ArrDb
    db = ArrDb()
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    web = env["web"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")
    assert words(web, f["id"], wait=30).status_code == 200
    assert web.delete(f"/api/files/{f['id']}", headers=H).status_code == 200
    assert words(web, f["id"]).status_code == 200                 # Deleted files are still read
    assert len(db[ocrtext.COLL].rows) == 1
    assert web.post("/api/files/trash/purge", headers=H, json={"files": [f["id"]]}).status_code == 200
    assert db[ocrtext.COLL].rows == []                            # gone with the last copy
    assert words(web, f["id"]).status_code == 404


def test_another_workspace_gets_nothing(env, monkeypatch):
    web, db = env["web"], env["db"]
    model = Model()
    model.install(monkeypatch)
    f = up(web, "scan.pdf", scan(), ctype="application/pdf")
    row = next(r for r in db["files"].rows if r["_id"] == f["id"])
    row["workspace_id"] = "team2"                                 # now it is not ours
    assert words(web, f["id"]).status_code == 404
    assert words(web, "nope").status_code == 404
    assert db[ocrtext.COLL].rows == [] and model.calls == []


def test_reading_a_file_is_looking_and_a_page_session_may():
    assert access.action("GET", "/api/files/abc/text") == "view"
    assert access.page_allowed("GET", "/api/files/abc/text")


def test_a_room_files_pages_are_read_too(env, monkeypatch):
    """A model's drawing is a PDF in Files' read-only folders (v: ids)."""
    from backend import files_virtual
    web = env["web"]
    model = Model()
    model.install(monkeypatch)
    data = scan()

    async def doc(db, v, data_=True, **kw):
        if v != "v:md:x":
            raise KeyError(v)
        out = {"_id": v, "id": v, "name": "drawing.pdf", "kind": "pdf", "content_type": "application/pdf",
               "bytes": len(data), "sha256": "", "ro": True, "at": "2026-10-01T10:00:00+00:00"}
        if kw.get("data", data_):
            out["_data"] = data
        return out
    monkeypatch.setattr(files_virtual, "doc", doc)
    r = words(web, "v:md:x", wait=30)
    assert r.status_code == 200 and r.json()["text"] == WORDS
    assert words(web, "v:md:y").status_code == 404


# ---------------------------------------------------------------- what the model wrote

def test_the_model_wrote_page_lines_are_what_the_pages_are():
    raw = "I looked at the pages.\n--- page 2 ---\nSecond page\n--- page 1 ---\nFirst page\n"
    assert ocrtext.written(raw, [1, 2, 3]) == {1: "First page", 2: "Second page"}
    assert ocrtext.written("--- page 1 ---\n(no text)", [1]) == {1: ""}
    assert ocrtext.written("plain words, no page line", [1]) == {1: "plain words, no page line"}
    assert ocrtext.written("nothing to go on", [1, 2]) == {}       # several pages and no line: unknown which


def test_the_pages_of_a_scan_are_named_only_when_there_are_several():
    pages = [{"n": 1, "url": "data:"}, {"n": 2, "url": "data:"}]
    assert ocrtext.joined(pages, {1: "One", 2: "Two"}) == "--- page 1 ---\nOne\n\n--- page 2 ---\nTwo"
    assert ocrtext.joined([{"n": 1, "text": "One page"}], {}) == "One page"
    got = ocrtext.joined(pages, {1: "One"})                            # the page it did not write out says so
    assert "--- page 1 ---" in got and ocrtext.NOT_WRITTEN in got


def test_long_words_are_cut():
    long = ocrtext.joined([{"n": 1, "text": "x" * (ocrtext.MAX_CHARS + 50)}], {})
    assert len(long) < ocrtext.MAX_CHARS + 100 and "the rest of this file's words are cut" in long


def test_a_file_is_read_by_its_kind_and_its_content():
    assert ocrtext.kind_of({"name": "a.PDF"}) == "pdf"
    assert ocrtext.kind_of({"name": "a.jpg"}) == "image" and ocrtext.kind_of({"name": "a.svg"}) is None
    assert ocrtext.kind_of({"name": "a.step", "kind": "step"}) is None
    assert ocrtext.kind_of({"name": "x", "content_type": "application/pdf"}) == "pdf"
    assert ocrtext.key_of({"sha256": "s"}, "en") == f"s:en:v{ocrtext.VERSION}"
    assert ocrtext.key_of({"sha256": "s"}) != ocrtext.key_of({"sha256": "s"}, "en")
    assert ocrtext.key_of({"_id": "f1", "bytes": 3, "at": "now"}) == f"f1.3.now::v{ocrtext.VERSION}"
