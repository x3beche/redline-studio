"""RustDesk on and off from the admin panel (backend/rustdesk.py): what the
page shows from `docker inspect`, and that only the owner and the admins
reach it."""

from __future__ import annotations

import re

import pytest
from fastapi import HTTPException

from backend import access, actors, rustdesk

TS = "100.83.189.61"


def info(running=True, host=TS, pw="secret-pass"):
    return {
        "State": {"Running": running, "Status": "running" if running else "exited",
                  "StartedAt": "2026-10-11T13:00:00Z", "FinishedAt": "2026-10-11T13:14:19Z"},
        "Config": {"Env": [f"RD_PASSWORD={pw}", "PATH=/usr/bin"]},
        "HostConfig": {"PortBindings": {"21118/tcp": [{"HostIp": host, "HostPort": "21118"}]}},
    }


def test_running_on_tailscale_only():
    d = rustdesk.describe(info(), TS)
    assert d["running"] and d["installed"]
    assert d["since"] == "2026-10-11T13:00:00Z"
    assert d["password"] == "secret-pass"
    assert d["tailscale_ip"] == TS and d["port"] == 21118
    assert d["tailscale_only"] is True


def test_stopped_shows_when_it_stopped():
    d = rustdesk.describe(info(running=False), TS)
    assert not d["running"]
    assert d["since"] == "2026-10-11T13:14:19Z"


def test_open_on_every_address_is_not_tailscale_only():
    d = rustdesk.describe(info(host=""), TS)
    assert d["bound_to"] == ["0.0.0.0"]
    assert d["tailscale_only"] is False


def test_tailscale_down_is_not_tailscale_only():
    d = rustdesk.describe(info(), None)
    assert d["tailscale_only"] is False and d["tailscale_ip"] is None


def test_no_container():
    d = rustdesk.describe(None, TS)
    assert d == {"installed": False, "running": False, "tailscale_ip": TS, "port": 21118}


def test_the_path_is_behind_the_admin_rule():
    src = open(access.__file__).read()
    pat = re.search(r'\("\*", "(/api/admin[^"]*)", "users"\)', src).group(1)
    assert re.fullmatch(pat, "/api/admin/rustdesk") and re.fullmatch(pat, "/api/admin/rustdesk/start")


@pytest.mark.parametrize("role", ["user", "editor", "viewer", "reviewer"])
def test_others_are_refused(monkeypatch, role):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "u1", "name": "U"})
    monkeypatch.setattr(access, "current", lambda: role)
    with pytest.raises(HTTPException) as e:
        rustdesk._me()
    assert e.value.status_code == 403


def test_a_page_session_is_refused_even_as_owner(monkeypatch):
    monkeypatch.setattr(actors, "current", lambda: {"type": "user", "id": "o", "page": True})
    monkeypatch.setattr(access, "current", lambda: "owner")
    with pytest.raises(HTTPException):
        rustdesk._me()
