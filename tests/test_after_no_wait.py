"""An after shot says it does not wait for builds (--no-wait), rather than
render.py inferring it from REDLINE_REVISION - which stays as a fallback."""

from __future__ import annotations

import asyncio
import sys

import pytest

from tools import render, revisions


def test_the_after_shot_passes_no_wait(monkeypatch, tmp_path):
    argv = {}

    class Proc:
        returncode = 1

        async def communicate(self):
            return b"stopped here", None

    async def spawn(*a, **kw):
        argv["a"], argv["env"] = a, kw.get("env") or {}
        return Proc()

    monkeypatch.setattr(revisions.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(revisions.tempfile, "gettempdir", lambda: str(tmp_path))

    class Revs:
        async def find_one(self, *a, **kw):
            return {"_id": "r1", "view": {"states": {}}}

    class Db:
        revisions = Revs()

    with pytest.raises(SystemExit):
        asyncio.run(revisions._after_shot(Db(), "r1"))
    assert "--no-wait" in argv["a"]
    assert argv["env"].get("REDLINE_REVISION") == "r1"        # still set, for the fallback


def test_render_takes_no_wait_and_hands_it_on(monkeypatch, tmp_path):
    got = {}
    out = tmp_path / "shot.png"

    def fake(revision, path, *a):
        got["no_wait"] = a[8]
        path.write_bytes(b"png")
        return path

    from backend import compute
    monkeypatch.setattr(render, "render", fake)
    monkeypatch.setattr(compute, "record_sync", lambda *a, **kw: None)
    monkeypatch.delenv("REDLINE_REVISION", raising=False)
    for extra, want in (([], False), (["--no-wait"], True)):
        monkeypatch.setattr(sys, "argv", ["render.py", "r1", "-o", str(out), *extra])
        render.main()
        assert got["no_wait"] is want


def test_wait_false_does_not_wait_without_the_environment(monkeypatch):
    monkeypatch.delenv("REDLINE_REVISION", raising=False)
    entry = {"id": "p/b", "_id": "p/b", "data": True, "built_at": "t1", "building": True}

    def never(_s):
        raise AssertionError("waited")

    got = render.wait_built(lambda: {}, "p/b", 1200, find=lambda c, m: entry, sleep=never, wait=False)
    assert got is entry


def test_the_after_shot_can_name_another_model(monkeypatch, tmp_path):
    """A note that made a new model is pictured on that one (`after --model`)."""
    argv = {}

    class Proc:
        returncode = 1

        async def communicate(self):
            return b"stopped here", None

    async def spawn(*a, **kw):
        argv["a"] = a
        return Proc()

    monkeypatch.setattr(revisions.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(revisions.tempfile, "gettempdir", lambda: str(tmp_path))
    with pytest.raises(SystemExit):
        asyncio.run(revisions._after_shot(object(), "r1", model="new/assemblies/station_80"))
    a = list(argv["a"])
    assert a[a.index("--model") + 1] == "new/assemblies/station_80"


def test_render_hands_the_model_on(monkeypatch, tmp_path):
    got = {}

    def fake(revision, path, *a):
        got["on_model"] = a[9]
        path.write_bytes(b"png")
        return path

    from backend import compute
    monkeypatch.setattr(render, "render", fake)
    monkeypatch.setattr(compute, "record_sync", lambda *a, **kw: None)
    for extra, want in (([], None), (["--model", "p/m"], "p/m")):
        monkeypatch.setattr(sys, "argv", ["render.py", "r1", "-o", str(tmp_path / "s.png"), *extra])
        render.main()
        assert got["on_model"] == want

