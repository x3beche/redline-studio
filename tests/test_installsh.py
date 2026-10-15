"""The one line that installs an agent (backend/installsh.py).

Sign-in is on; the database is test_telegram's fake. What is checked: the route
answers without a session and serves nothing else, this server's own address is
already in the script (from X-Forwarded-Host behind the site's proxy, or from
Host for a direct call, with the proxy's scheme), the seed it installs is the
one the agents are pointed at, and the shell accepts what is served."""

from __future__ import annotations

import asyncio
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from backend import agent_kit, auth, installsh, scope
from test_telegram import FakeDb


def run(c):
    return asyncio.run(c)


def app():
    return __import__("backend.main", fromlist=["app"]).app


def visitor(ip: str = "203.0.113.9", host: str | None = None, forwarded: bool = False) -> TestClient:
    """Anyone: the installer needs no session (it is fetched before there is an
    agent, and the token it carries is the one thing it needs)."""
    c = TestClient(app())
    c.headers["X-Forwarded-For"] = ip
    if host:
        c.headers["X-Forwarded-Host"] = host
        c.headers["X-Forwarded-Proto"] = "https"
    elif forwarded:
        c.headers["Host"] = host or "wb.example.com"
    return c


@pytest.fixture
def db(monkeypatch):
    from backend import main
    fake = FakeDb()
    monkeypatch.setattr(main, "db", lambda: scope.ScopedDb(fake, scope.current()))
    monkeypatch.setattr(auth, "enabled", lambda: True)
    for c in (auth._CACHE, auth._TOKEN_CACHE, auth._USAGE):
        c.clear()
    installsh.SH_HITS.clear()
    tokens = (scope.WORKSPACE.set(scope.DEFAULT),)
    yield fake
    scope.WORKSPACE.reset(tokens[0])


def test_the_installer_answers_anyone_and_serves_nothing_else(db):
    v = visitor(host="wb.example.com")
    r = v.get("/api/public/install.sh")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/x-shellscript")
    assert r.headers["x-robots-tag"] == "noindex, nofollow"
    # The folder is not a folder: another name is not served.
    assert v.get("/api/public/install.sh.bak").status_code == 404
    assert v.get("/api/public/install.ps1").status_code == 404


def test_this_server_is_already_in_the_script(db):
    """The address the script would otherwise need --api for: the public host
    behind the site's proxy, https because that is what the person speaks."""
    text = visitor(host="wb.example.com").get("/api/public/install.sh").text
    assert 'API="https://wb.example.com"' in text
    assert f'SEED="{agent_kit.SEED_URL}"' in text
    # A direct call has no forwarded host: the Host header is it, and the
    # scheme is the one we were asked on.
    direct = visitor().get("/api/public/install.sh").text
    assert 'API="http://testserver"' in direct


def test_the_proxy_may_say_which_scheme(db):
    c = visitor()
    c.headers["X-Forwarded-Host"] = "wb.example.com"
    c.headers["X-Forwarded-Proto"] = "http"
    assert 'API="http://wb.example.com"' in c.get("/api/public/install.sh").text


@pytest.mark.skipif(not shutil.which("bash"), reason="no bash here")
def test_the_shell_accepts_what_is_served(db):
    text = visitor(host="wb.example.com").get("/api/public/install.sh").text
    r = subprocess.run(["bash", "-n"], input=text, capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    # And it is a script, run through bash, not something else served as text.
    assert text.startswith("#!/usr/bin/env bash")
    assert "curl -fsSL" in text and "--token" in text
