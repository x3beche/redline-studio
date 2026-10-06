"""The proxy for EasyEDA's API: only the part lookups use it, the asking
stays as polite, and a refusal is asked once more through it (fallback)."""
from __future__ import annotations

import asyncio
import io
import urllib.error

import pytest

from backend import lcsc, netproxy

PROXY = {"enabled": True, "mode": "fallback", "scheme": "http", "host": "gw.example", "port": 2334,
         "username": "user-zone-custom", "password": "p@ss/word", "identify_exit": False}


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(lcsc, "GAP", 0.05)
    monkeypatch.setattr(lcsc, "COOL_OFF", 60)
    monkeypatch.setattr(netproxy, "_conf", {})


def run(coro):
    return asyncio.run(coro)


def test_the_url_quotes_the_credentials():
    assert netproxy.url(PROXY) == "http://user-zone-custom:p%40ss%2Fword@gw.example:2334"
    # a session and a country ride in the username, the 2Captcha way
    assert netproxy.username({**PROXY, "country": "DE"}, "rl1") == "user-zone-custom-region-de-session-rl1"
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
    assert "HTTPS_PROXY" not in netproxy.env(False, None, base)      # direct: nothing leaks in
    assert netproxy.env(True, None, base)["HTTPS_PROXY"].endswith("@gw.example:2334")


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


def test_usage_counts_each_way_and_what_the_proxy_carried(monkeypatch):
    lcsc._record("component", "C1", "net", status=200, size=1000, via="direct")
    lcsc._record("component", "C2", "net", status=200, size=500, via="proxy")
    lcsc._record("component", "C3", "net", status=403, via="direct")
    lcsc._record("download", "C4", "refused", error="budget")
    lcsc._record("component", "C5", "disk", size=10)
    lcsc._record("search", "x", "wait", error="waiting")                 # not an ask
    out = run(netproxy.usage(days=1))
    t = out["totals"]
    assert (t["lookups"], t["direct"], t["proxy"], t["refused"], t["disk"]) == (4, 1, 1, 2, 1)
    assert (t["bytes_direct"], t["bytes_proxy"]) == (1000, 500)
    assert {s["name"] for s in out["lookups"]["series"]} == {"direct", "proxy", "refused", "failed"}
    assert out["recent"][0]["target"] == "x"
