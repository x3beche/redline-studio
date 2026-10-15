"""A technical drawing under way is a row in the database (release.JOBS),
not the API's memory: every process sees it - the 3D room, the Chat's own
drawing processes (chat_tools/_drawing_job.py), draw_later. The row is the
claim: one making per drawing; a second caller waits for it and gets its
drawing (or its failure); a row whose maker died (no beat for STALE_S, or
its process gone on this machine) is taken over. The drawing container is
faked: nothing real is drawn."""

from __future__ import annotations

import asyncio
import subprocess
import time

import pytest

from backend import release, scope, store
from backend.chat_tools import _drawing_job
from test_telegram import FakeDb

SHA = "ab" * 32
KEY = f"{SHA[:24]}-v{release.DRAW_VERSION}"
JID = f"default|p/lid|{KEY}"


def run(coro):
    return asyncio.run(coro)


class EachALock(dict):
    """No lock shared inside the process: each caller is as if in a process of its own."""

    def setdefault(self, key, default=None):
        return default


@pytest.fixture
def env(monkeypatch, tmp_path):
    fake = FakeDb()
    db = scope.ScopedDb(fake, "default")
    run(db["models"].insert_one({"_id": "p/lid", "title": "Lid", "artifacts": {"step": {"sha256": SHA, "bytes": 10}}}))
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    monkeypatch.setattr(release, "_MAKING", EachALock())
    monkeypatch.setattr(release, "_DUE", {})
    monkeypatch.setattr(release, "BEAT_S", 0.01)
    monkeypatch.setattr(release, "WAIT_S", 0.01)
    drawn: list[str] = []

    async def get_artifact(d, mid, kind):
        return b"STEP"
    monkeypatch.setattr(store, "get_artifact", get_artifact)

    async def drawing(step, out, *, on_progress=None, **kw):
        drawn.append(out.name)
        on_progress(50, "projecting the front view")
        await asyncio.sleep(0.1)
        out.write_bytes(b"%PDF" + str(len(drawn)).encode())
    monkeypatch.setattr(release, "drawing", drawing)
    return db, fake, drawn, tmp_path


def rows(fake, coll=release.JOBS):
    return list(fake[coll].docs.values())


def other(state="making", **kw):
    """A row written by another process (another machine's, so only its beat counts)."""
    return {"_id": JID, "workspace_id": "default", "model": "p/lid", "key": KEY, "sha": SHA, "state": state,
            "by": "chat", "token": "theirs", "pid": 1, "host": "elsewhere", "pct": 20, "stage": "reading the STEP",
            "started_at": "2026-10-15T10:00:00+00:00", "beat": time.time(), **kw}


def test_two_callers_at_once_make_it_once(env):
    db, fake, drawn, _ = env

    async def both():
        return await asyncio.gather(release.model_drawing(db, "p/lid", by="room"),
                                    release.model_drawing(db, "p/lid", by="chat"))
    a, b = run(both())
    assert a == b == b"%PDF1" and len(drawn) == 1
    assert rows(fake) == []                                       # made: no row left
    # One drawing, one notification.
    assert [(r["state"], r["model"]) for r in rows(fake, release.DRAWN)] == [("done", "p/lid")]


def test_again_while_one_is_under_way_joins_it(env):
    db, fake, drawn, _ = env

    async def both():
        first = asyncio.create_task(release.model_drawing(db, "p/lid", again=True))
        await asyncio.sleep(0.03)
        return await asyncio.gather(first, release.model_drawing(db, "p/lid", again=True))
    a, b = run(both())
    assert a == b and len(drawn) == 1


def test_a_caller_waits_for_another_process_and_gets_its_drawing(env):
    db, fake, drawn, kept = env
    fake[release.JOBS].docs[JID] = other()

    async def go():
        waiting = asyncio.create_task(release.model_drawing(db, "p/lid"))
        await asyncio.sleep(0.05)
        assert not waiting.done()
        st = await release.drawing_status(db, "p/lid")
        assert (st["state"], st["pct"], st["job"]["by"]) == ("making", 20, "chat")
        (kept / f"{KEY}.pdf").write_bytes(b"%PDF-theirs")             # the other one finishes
        del fake[release.JOBS].docs[JID]
        return await waiting
    assert run(go()) == b"%PDF-theirs" and drawn == []


def test_its_failure_is_the_waiters_too(env):
    db, fake, drawn, _ = env
    fake[release.JOBS].docs[JID] = other()

    async def go():
        waiting = asyncio.create_task(release.model_drawing(db, "p/lid"))
        await asyncio.sleep(0.05)
        fake[release.JOBS].docs[JID].update(state="failed", error="out of memory", ended=time.time())
        return await waiting
    with pytest.raises(RuntimeError, match="out of memory"):
        run(go())
    assert drawn == []


def test_a_stale_row_is_taken_over(env):
    db, fake, drawn, _ = env
    fake[release.JOBS].docs[JID] = other(beat=time.time() - release.STALE_S - 5)
    st = run(release.drawing_status(db, "p/lid"))
    assert st["state"] == "none" and "job" not in st                 # dead: not shown as under way
    assert run(release.model_drawing(db, "p/lid")) == b"%PDF1" and len(drawn) == 1


def test_a_row_whose_process_is_gone_here_is_taken_over_at_once(env):
    db, fake, drawn, _ = env
    gone = subprocess.Popen(["true"])
    gone.wait()
    fake[release.JOBS].docs[JID] = other(host=release._HOST, pid=gone.pid)
    assert run(release.drawing_status(db, "p/lid"))["state"] == "none"
    assert run(release.model_drawing(db, "p/lid")) == b"%PDF1"


def test_a_failure_stays_on_the_row_and_is_recorded(env, monkeypatch):
    db, fake, drawn, _ = env

    async def broken(step, out, **kw):
        return "the projection failed"
    monkeypatch.setattr(release, "drawing", broken)
    with pytest.raises(RuntimeError):
        run(release.model_drawing(db, "p/lid", auto=True))
    st = run(release.drawing_status(db, "p/lid"))
    assert st["state"] == "failed" and st["failed"]["reason"] == "the projection failed" and st["failed"]["by"] == "auto"
    assert [(r["state"], r["auto"]) for r in rows(fake, release.DRAWN)] == [("failed", True)]


def test_a_chat_started_drawing_shows_in_the_room_and_make_now_joins_it(env, monkeypatch):
    db, fake, drawn, _ = env
    started = []

    async def spawn(ws, mid, again):
        started.append((ws, mid, again))
        return 1                                                  # pid 1: alive on any machine
    monkeypatch.setattr(_drawing_job, "spawn", spawn)
    run(_drawing_job.start(db, "p/lid", again=False))
    assert started == [("default", "p/lid", False)]
    st = run(release.drawing_status(db, "p/lid"))
    assert st["state"] == "queued" and st["job"]["by"] == "chat"

    # The Chat's process claims it (over its own queued row) and draws; meanwhile the room's Make now.
    async def go():
        chat = asyncio.create_task(release.model_drawing(db, "p/lid", by="chat"))
        await asyncio.sleep(0.05)
        now = await release.drawing_status(db, "p/lid")
        assert (now["state"], now["job"]["by"], now["pct"]) == ("making", "chat", 50)
        room = await release.start_drawing(db, "p/lid")
        assert room["state"] == "making" and not release._STARTED  # nothing new started
        return await chat
    assert run(go()) == b"%PDF1" and len(drawn) == 1
    assert run(release.drawing_status(db, "p/lid"))["state"] == "ready"


def test_the_rooms_make_now_shows_making_at_once(env):
    db, fake, drawn, _ = env

    async def go():
        st = await release.start_drawing(db, "p/lid")
        assert st["state"] == "making" and st["job"]["by"] == "room"
        await asyncio.gather(*release._STARTED)
    run(go())
    assert len(drawn) == 1


def test_draw_later_waits_its_turn_in_the_database(env, monkeypatch):
    db, fake, drawn, _ = env
    monkeypatch.setattr(release, "DRAW_AFTER_BUILD_S", 0)

    async def go():
        sem = asyncio.Semaphore(1)
        monkeypatch.setattr(release, "_DRAW_ONE", sem)
        await sem.acquire()                                       # another drawing goes first
        release.draw_later(db, "p/lid")
        await asyncio.sleep(0.05)
        st = await release.drawing_status(db, "p/lid")
        assert st["state"] == "queued" and st["job"]["by"] == "auto"
        sem.release()
        while release._DRAW_LATER:
            await asyncio.sleep(0.01)
    run(go())
    assert len(drawn) == 1 and rows(fake) == []
    assert [(r["state"], r["auto"]) for r in rows(fake, release.DRAWN)] == [("done", True)]
