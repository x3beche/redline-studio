"""The proxy for EasyEDA's API: only the part lookups use it, the asking
stays as polite, and a refusal is asked once more through it (fallback)."""
from __future__ import annotations

import asyncio
import io
import urllib.error

import pytest

from backend import lcsc, netproxy

PROXY = {"enabled": True, "mode": "fallback", "scheme": "http", "host": "gw.example", "port": 2334,
         "username": "user-zone-custom", "password": "p@ss/word"}


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(lcsc, "GAP", 0.05)
    monkeypatch.setattr(lcsc, "COOL_OFF", 60)
    monkeypatch.setattr(netproxy, "_conf", {})


def run(coro):
    return asyncio.run(coro)


def test_the_url_quotes_the_credentials():
    assert netproxy.url(PROXY) == "http://user-zone-custom:p%40ss%2Fword@gw.example:2334"
    assert netproxy.url({"host": "gw.example"}) is None          # no port: no proxy


def test_off_unless_enabled_and_complete(monkeypatch):
    assert netproxy.mode() is None
    monkeypatch.setattr(netproxy, "_conf", {**PROXY, "enabled": False})
    assert netproxy.mode() is None
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    assert netproxy.mode() == "fallback"


def test_the_page_never_sees_the_password(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    shown = netproxy.public()
    assert shown["password_set"] is True and "p@ss" not in repr(shown)


def test_a_tool_gets_the_proxy_only_when_asked(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    base = {"PATH": "/bin", "HTTPS_PROXY": "http://somewhere-else"}
    assert "HTTPS_PROXY" not in netproxy.env(False, base)            # direct: nothing leaks in
    assert netproxy.env(True, base)["HTTPS_PROXY"].endswith("@gw.example:2334")


def _refused_here_fine_there(seen):
    def fn(url):
        seen.append(lcsc._via())
        if not lcsc._via():
            raise urllib.error.HTTPError(url, 403, "no", {}, io.BytesIO(b""))
        return {"ok": 1}
    return fn


def test_fallback_asks_a_refused_lookup_once_more_through_the_proxy(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    seen = []
    out = run(lcsc._polite("component", "C1", "u", _refused_here_fine_there(seen), "u"))
    assert out == {"ok": 1} and seen == [False, True]
    assert lcsc.state()["refused_until"] is None, "a lookup the proxy answered is no refusal"


def test_without_a_proxy_a_refusal_still_cools_off():
    seen = []
    with pytest.raises(lcsc.Refused):
        run(lcsc._polite("component", "C1", "u", _refused_here_fine_there(seen), "u"))
    assert seen == [False]
    assert lcsc.state()["refused_until"] is not None


def test_always_sends_every_lookup_through_it(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", {**PROXY, "mode": "always"})
    seen = []
    run(lcsc._polite("search", "x", "u", lambda url: seen.append(lcsc._via()) or {}, "u"))
    assert seen == [True]
