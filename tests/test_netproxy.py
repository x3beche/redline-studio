"""The proxy for EasyEDA's API: only the part lookups use it, the asking
stays as polite, and the Drawer's order of routes (backend/netroutes.py)
says whether it goes first or only after a refusal."""
from __future__ import annotations

import asyncio
import io
import urllib.error

import pytest

from backend import lcsc, netproxy, netroutes

PROXY = {"scheme": "http", "host": "gw.example", "port": 2334,
         "username": "user-zone-custom", "password": "p@ss/word", "identify_exit": False}


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(lcsc, "GAP", 0.05)
    monkeypatch.setattr(lcsc, "COOL_OFF", 60)
    monkeypatch.setattr(netproxy, "_conf", {})
    monkeypatch.setattr(netroutes, "_orders", {})


def orders(**kw):
    netroutes._orders.update(kw)


def run(coro):
    return asyncio.run(coro)


def test_the_url_quotes_the_credentials():
    assert netproxy.url(PROXY) == "http://user-zone-custom:p%40ss%2Fword@gw.example:2334"
    # a session and a country ride in the username, the 2Captcha way
    assert netproxy.username({**PROXY, "country": "DE"}, "rl1") == "user-zone-custom-region-de-session-rl1"
    assert netproxy.url({"host": "gw.example"}) is None          # no port: no proxy


def test_active_when_set_up_and_in_an_order(monkeypatch):
    assert netproxy.active() is False
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    assert netproxy.active() is True                       # the default orders have it second
    orders(parts=["local"], catalog=["local", "jina"])
    assert netproxy.active() is False
    assert netroutes.plan("parts") == ["local"]


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


def test_proxy_first_sends_every_lookup_through_it(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    orders(parts=["proxy", "local"])
    seen = []
    run(lcsc._polite("search", "x", "u", lambda url: seen.append(lcsc._via()) or {}, "u"))
    assert seen == [True]


def test_proxy_first_turns_to_local_after_three_exits_refuse(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    orders(parts=["proxy", "local"])
    seen = []

    def fn(url):
        seen.append(lcsc._via())
        if lcsc._via():
            raise urllib.error.HTTPError(url, 429, "no", {}, io.BytesIO(b""))
        return {"ok": 1}
    assert run(lcsc._polite("component", "C1", "u", fn, "u")) == {"ok": 1}
    assert seen == [True, True, True, False]
    assert lcsc.state()["refused_until"] is None
    assert [r.get("via") for r in lcsc.journal(5) if r.get("source") == "net"][:2] == ["direct", "proxy"]


def test_a_network_failure_goes_to_the_next_route(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    seen = []

    def fn(url):
        seen.append(lcsc._via())
        if not lcsc._via():
            raise urllib.error.URLError("no route to host")
        return {"ok": 2}
    assert run(lcsc._polite("search", "x", "u", fn, "u")) == {"ok": 2} and seen == [False, True]
    # the last route's failure is the lookup's
    orders(parts=["local"])
    with pytest.raises(urllib.error.URLError):
        run(lcsc._polite("search", "y", "u", fn, "u"))


def test_an_order_without_the_proxy_never_uses_it(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", dict(PROXY))
    orders(parts=["local"])
    seen = []
    with pytest.raises(lcsc.Refused):
        run(lcsc._polite("component", "C1", "u", _refused_here_fine_there(seen), "u"))
    assert seen == [False]


# ---------------------------------------------------------------- the orders

def test_each_lookup_takes_only_its_own_routes():
    assert netroutes.CONSUMERS["parts"] == ("local", "proxy")          # JSON APIs: no Jina
    assert "jina" in netroutes.CONSUMERS["catalog"]
    assert netroutes.clean("parts", ["jina", "proxy", "proxy", "local"]) == ["proxy", "local"]
    assert netroutes.clean("parts", ["jina"]) is None and netroutes.clean("parts", []) is None
    assert netroutes.clean("catalog", ["jina", "local"]) == ["jina", "local"]


def test_the_old_modes_load_as_orders():
    assert {m: netroutes.clean("catalog", m) for m in netroutes.LEGACY} == {
        "off": ["local"], "fallback": ["local", "proxy"], "always": ["proxy", "local"],
        "jina": ["jina"], "jina_fallback": ["local", "jina", "proxy"]}
    assert netroutes.clean("parts", "jina_fallback") == ["local", "proxy"]
    assert netroutes._from_proxy({"enabled": True, "mode": "always"}) == {"catalog": ["proxy", "local"],
                                                                         "parts": ["proxy", "local"]}
    assert netroutes._from_proxy({"enabled": True}) == {"catalog": ["local", "proxy"], "parts": ["local", "proxy"]}
    assert netroutes._from_proxy({"enabled": False, "mode": "always"}) == {"catalog": ["local"], "parts": ["local"]}


def test_a_first_start_keeps_the_old_mode_and_a_saved_order_wins():
    from test_telegram import FakeDb
    db = FakeDb()
    assert run(netroutes.load(db, {"enabled": True, "mode": "always", "host": "h", "port": 1})) == \
        {"catalog": ["proxy", "local"], "parts": ["proxy", "local"]}
    # kept: a later change to the proxy's old fields does not move them
    assert run(netroutes.load(db, {"enabled": False})) == {"catalog": ["proxy", "local"], "parts": ["proxy", "local"]}
    run(netroutes.save(db, "catalog", ["jina", "local"]))
    assert run(netroutes.load(db, {})) == {"catalog": ["jina", "local"], "parts": ["proxy", "local"]}
    from fastapi import HTTPException
    for consumer, order in (("parts", ["jina"]), ("parts", []), ("nothing", ["local"])):
        with pytest.raises(HTTPException):
            run(netroutes.save(db, consumer, order))


def test_a_route_not_set_up_is_passed_over(monkeypatch):
    from backend import jina
    monkeypatch.setattr(jina, "_conf", {})
    assert netroutes.plan("catalog", ["jina", "proxy", "local"]) == ["local"]
    with pytest.raises(netroutes.NoRoute, match="Jina has no API key"):
        netroutes.plan("catalog", ["jina"])
    shown = netroutes.public()
    assert shown["routes"]["proxy"]["ready"] is False and "not set up" in shown["routes"]["proxy"]["why"]
    assert shown["consumers"]["parts"]["routes"] == ["local", "proxy"]


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
