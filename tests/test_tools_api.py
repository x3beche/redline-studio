"""The Tools tab's checks: the door to the tools image.

These test the door - what it refuses and how it calls Docker - not the
image, which is tried by building it (TOOLS.md says how).
"""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException

from backend import tools_api


def call(**body):
    return asyncio.run(tools_api.check(tools_api.CheckIn(**body)))


def test_an_unknown_kind_is_refused_by_name():
    with pytest.raises(HTTPException) as e:
        call(kind="rm -rf", input="")
    assert e.value.status_code == 400 and "sql" in e.value.detail


def test_a_huge_input_is_refused_before_docker_is_asked(monkeypatch):
    monkeypatch.setattr(tools_api, "have_image", lambda: pytest.fail("asked docker"))
    with pytest.raises(HTTPException) as e:
        call(kind="sql", input="x" * (tools_api.LIMIT + 1))
    assert e.value.status_code == 413


def test_no_image_says_how_to_build_it(monkeypatch):
    monkeypatch.setattr(tools_api, "have_image", lambda: False)
    with pytest.raises(HTTPException) as e:
        call(kind="sql", input="select 1")
    assert e.value.status_code == 503 and "docker build" in e.value.detail


def test_a_check_runs_offline_capped_and_as_the_user(monkeypatch):
    seen = {}

    class Proc:
        async def communicate(self, data):
            seen["stdin"] = json.loads(data)
            return json.dumps({"ok": True, "errors": [], "kind": "sql"}).encode(), b""

    async def fake_exec(*argv, **_):
        seen["argv"] = argv
        return Proc()

    monkeypatch.setattr(tools_api, "have_image", lambda: True)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    out = call(kind="regex", input="", extra={"pattern": r"\d+", "text": "a1"})
    argv = seen["argv"]
    assert out["ok"] is True
    assert argv[:4] == ("docker", "run", "--rm", "-i")
    assert argv[argv.index("--network") + 1] == "none"
    assert "--memory" in argv and "--user" in argv
    # The extras travel with the kind; the kind cannot be overridden by them.
    assert seen["stdin"]["pattern"] == r"\d+" and seen["stdin"]["kind"] == "regex"


def test_tool_pages_are_revalidated_so_an_update_shows_without_a_hard_refresh():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    tools_api.mount(app)
    r = TestClient(app).get("/api/tools/files/kit/kit.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers.get("etag")
