"""Pictures sent straight from a chat composer.

A pasted, dropped or attached picture is uploaded through the Files tab's
own upload (into its "Chat" folder) and then carried by the line as a file
mention: in a room's thread as `files` on POST /api/chat, in a
conversation as an @-mention. These check the server's half - the folder,
the chips a line keeps, and what a room's agent reads in its thread.
"""

from __future__ import annotations

import argparse
import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import auth, cc_context, chat, files, search
from backend import main as M
from test_files_folders import Grid
from test_links import FakeDb

H = {"x-redline-csrf": "1"}
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


@pytest.fixture
def env(monkeypatch):
    db = FakeDb()
    grid = Grid()
    monkeypatch.setattr(files, "_bucket", lambda d: grid)
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return {"db": db, "web": TestClient(M.app)}


def up(web, name, data=PNG, ctype="image/png", **form):
    r = web.post("/api/files", headers=H, data=form, files={"upload": (name, data, ctype)})
    assert r.status_code == 200, r.text
    return r.json()[0]


def test_chat_pictures_go_into_one_chat_folder_made_when_missing(env):
    web = env["web"]
    a = up(web, "shot-1.png", folder_path="Chat")
    b = up(web, "shot-2.png", folder_path="Chat")
    folders = web.get("/api/files/folders").json()
    assert [f["path"] for f in folders] == ["Chat"]
    assert a["folder"] == b["folder"] == folders[0]["id"]
    assert a["kind"] == "image" and a["bytes"] == len(PNG)          # the bytes as they came


def test_a_room_line_carries_a_picture_as_a_file_mention(env):
    web = env["web"]
    f = up(web, "screen.png", folder_path="Chat")
    r = web.post("/api/chat", headers=H, json={"text": "", "room": "pcb", "files": [f["id"]]})
    assert r.status_code == 200, r.text
    line = r.json()
    assert line["text"] == "" and line["room"] == "pcb"
    (chip,) = line["mentions"]
    assert chip["kind"] == "file" and chip["id"] == f["id"] and chip["label"] == "screen.png"
    assert chip["image"] is True
    # in the history the page reads, as sent
    hist = web.get("/api/chat", params={"room": "pcb"}).json()
    assert hist[-1]["mentions"][0]["id"] == f["id"]
    # the rooms list shows what it carries when it says nothing
    pcb = next(x for x in web.get("/api/chat/rooms").json() if x["room"] == "pcb")
    assert pcb["last"]["text"] == "screen.png"


def test_a_room_line_needs_words_or_a_file_and_the_file_must_be_there(env):
    web = env["web"]
    assert web.post("/api/chat", headers=H, json={"text": "  ", "room": "cad"}).status_code == 400
    assert web.post("/api/chat", headers=H, json={"text": "x", "room": "cad", "files": ["nope"]}).status_code == 404
    assert web.post("/api/chat", headers=H, json={"text": "x", "files": ["a"] * 9}).status_code == 422


def test_the_agent_reads_the_file_id_and_the_command_that_fetches_it():
    doc = {"text": "is this pad right?", "mentions": [
        {"kind": "file", "id": "abc123", "label": "Ekran görüntüsü.png", "image": True},
        {"kind": "file", "id": "def456", "label": "bom.csv"}]}
    out = chat.agent_text(doc)
    assert out.startswith("is this pad right?\n")
    assert "[attached image: Ekran görüntüsü.png, file id abc123" in out
    assert "tools/revisions.py files get abc123 -o /tmp/Ekran_g" in out
    assert "Read tool" in out
    assert "[attached file: bom.csv, file id def456" in out
    # an older chip without the flag is still a picture by its name
    assert "attached image" in chat.agent_text({"text": "", "mentions": [{"kind": "file", "id": "x", "label": "a.JPG"}]})
    assert chat.agent_text({"text": "plain"}) == "plain"


def test_revisions_chat_prints_the_picture_for_the_agent(env, monkeypatch, capsys):
    from tools import revisions
    web, db = env["web"], env["db"]
    f = up(web, "pad.png", folder_path="Chat")
    assert web.post("/api/chat", headers=H, json={"text": "look", "room": "pcb", "files": [f["id"]]}).status_code == 200
    monkeypatch.setattr(revisions, "connect", lambda: db)
    asyncio.run(revisions.cmd_chat(argparse.Namespace(limit=50, room="pcb", keep_unread=True)))
    out = capsys.readouterr().out
    assert "look" in out and f"files get {f['id']}" in out and "attached image: pad.png" in out


def test_a_thread_line_is_found_by_the_name_of_its_picture(env):
    web, db = env["web"], env["db"]
    f = up(web, "gerber-hata.png", folder_path="Chat")
    web.post("/api/chat", headers=H, json={"room": "cad", "files": [f["id"]]})
    hits = asyncio.run(search.everything(db, "gerber-hata"))
    assert any(h["kind"] == "chat" and "gerber-hata.png" in h["text"] for h in hits)


def test_a_conversation_mention_of_a_picture_says_it_is_one(env):
    web, db = env["web"], env["db"]
    f = up(web, "board.png", folder_path="Chat")
    ctx, chips, pics = asyncio.run(cc_context.expand(db, [{"kind": "file", "id": f["id"]}], vision=False))
    assert chips[0]["image"] is True and pics == []
    assert "does not read images" in ctx                       # picturesAsText, said to the model too
    ctx, chips, pics = asyncio.run(cc_context.expand(db, [{"kind": "file", "id": f["id"]}], vision=True))
    assert pics and pics[0]["id"] == f["id"] and chips[0]["images"] == 1
