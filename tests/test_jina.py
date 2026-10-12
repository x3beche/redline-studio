"""Jina AI (backend/jina.py): the key kept on the server and never shown
whole, the balance read from Jina's dashboard, Reader as a way for the
Product Catalog's crawler to read a page (the "jina" route of its order,
backend/netroutes.py), Search and Reader as the Chat's web_search and web_read,
and Workbench's own count of every call.

No real Jina is reached and no real key is used: the HTTP goes to fake
transports, the names to the crawler tests' fake resolver."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend import access, chat_tools, jina, netproxy
from backend import manufacturers as mf
from backend.chat_tools import Ctx, ToolError
from test_manufacturers import site, web  # noqa: F401 - web is a fixture
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401 - db is a fixture

KEY = "jina_" + "f" * 40 + "Wxyz"            # a made-up key


def run(c):
    return asyncio.run(c)


MD = ("# Menteşe M20\n\n[Ana sayfa](https://www.dogus.com.tr/) | [Kelepçe](https://www.dogus.com.tr/Urun/kelepce/3)\n\n"
      "![Image 1: Menteşe](https://www.dogus.com.tr/img/mentese.jpg)\n\n"
      "| Boy | 20 mm |\n|---|---|\n| Malzeme | AISI 304 |\n\nKalıp elemanı, paslanmaz. " + "Uzun açıklama. " * 20)


@pytest.fixture
def fake_jina(monkeypatch):
    """Jina's three hosts, faked: what was asked, and what each answers."""
    state = {"calls": [], "reader": None, "search": None, "balance": None}

    def handler(req: httpx.Request) -> httpx.Response:
        state["calls"].append(req)
        if req.url.host == "r.jina.ai":
            if state["reader"]:
                return state["reader"](req)
            target = str(req.url)[len("https://r.jina.ai/"):]
            return httpx.Response(200, json={"code": 200, "status": 20000, "data": {
                "title": "Menteşe M20", "description": "Kalıp elemanı", "url": target, "content": MD,
                "httpStatus": 200, "usage": {"tokens": 321}}})
        if req.url.host == "s.jina.ai":
            if state["search"]:
                return state["search"](req)
            return httpx.Response(200, json={"code": 200, "status": 20000, "data": [
                {"title": "M20 menteşe", "url": "https://www.dogus.com.tr/Urun/mentese/1", "description": "Kalıp menteşesi",
                 "usage": {"tokens": 1000}},
                {"title": "Başka", "url": "https://other.example/x", "description": "x"}],
                "meta": {"usage": {"tokens": 10000}}})
        if req.url.host == "embeddings-dashboard-api.jina.ai":
            if state["balance"]:
                return state["balance"](req)
            return httpx.Response(200, json={"user_id": "u", "wallet": {
                "total_balance": 10_000_000, "trial_balance": 10_000_000, "regular_balance": 0}})
        return httpx.Response(404)

    def client(timeout=jina.TIMEOUT):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)

    monkeypatch.setattr(jina, "_client", client)
    monkeypatch.setattr(jina, "_conf", {"key": KEY})
    monkeypatch.setattr(jina, "_db_getter", None)
    jina._account.clear()
    return state


def jina_calls(state, host="r.jina.ai"):
    return [r for r in state["calls"] if r.url.host == host]


# ---------------------------------------------------------------- the key

def test_the_key_is_kept_and_only_its_last_four_are_shown(db, monkeypatch):  # noqa: F811
    monkeypatch.setattr(jina, "_conf", {})
    o, a = person(db, "o"), person(db, "a")
    assert a.put("/api/jina/settings", json={"key": KEY}).status_code == 403
    r = o.put("/api/jina/settings", json={"key": KEY})
    assert r.status_code == 200 and KEY not in r.text
    assert r.json()["set"] and r.json()["hint"] == "…Wxyz"
    for c in (o, a):
        got = c.get("/api/jina/settings")
        assert got.status_code == 200 and KEY not in got.text and got.json()["hint"] == "…Wxyz"
    assert jina.key() == KEY
    # the audit trail says it changed, never what it is
    assert KEY not in json.dumps([d for d in db["audit"].docs.values()], default=str)
    assert o.put("/api/jina/settings", json={"key": "has a space"}).status_code == 400
    r = o.put("/api/jina/settings", json={"key": ""}).json()
    assert r["set"] is False and r["hint"] is None and not jina.configured()


def test_the_routes_follow_the_settings_rules():
    for m, p in (("PUT", "/api/jina/settings"), ("POST", "/api/jina/test")):
        assert access.action(m, p) == "settings"
        assert not access.page_allowed(m, p)
        for role in ("owner", "admin"):
            assert access.allowed(role, access.action(m, p))
        for role in ("editor", "user", "reviewer", "viewer"):
            assert not access.allowed(role, access.action(m, p)), (role, m, p)
    for p in ("/api/jina/settings", "/api/jina/account", "/api/jina/usage"):
        assert access.action("GET", p) == "view" and access.page_allowed("GET", p)


# ---------------------------------------------------------------- the balance

def test_the_balance_is_read_from_jinas_dashboard(fake_jina):
    assert jina.parse_balance({"wallet": {"total_balance": 10_000_000, "trial_balance": 10_000_000,
                                          "regular_balance": 0}}) == {"total": 10_000_000, "trial": 10_000_000,
                                                                      "regular": 0}
    assert jina.parse_balance({"wallet": {"trial_balance": "250", "regular_balance": 50}})["total"] == 300
    assert jina.parse_balance({"detail": "nope"}) is None and jina.parse_balance([]) is None
    got = run(jina.balance())
    assert got["ok"] and got["balance"]["total"] == 10_000_000
    (req,) = jina_calls(fake_jina, "embeddings-dashboard-api.jina.ai")
    assert req.url.path == "/api/v1/api_key/user" and req.url.params["api_key"] == KEY
    run(jina.balance())                               # kept a minute: not asked again
    assert len(jina_calls(fake_jina, "embeddings-dashboard-api.jina.ai")) == 1


def test_the_key_check(fake_jina):
    assert run(jina.check_key())["valid"] is True
    fake_jina["balance"] = lambda req: httpx.Response(401, json={"detail": "Invalid API key"})
    got = run(jina.check_key())
    assert got["valid"] is False and "not accepted" in got["error"] and KEY not in json.dumps(got)
    # the balance says nothing: one small Reader call decides
    fake_jina["balance"] = lambda req: httpx.Response(500, text="oops")
    fake_jina["reader"] = lambda req: httpx.Response(402, json={"code": 402, "message": "Insufficient balance"})
    got = run(jina.check_key())
    assert got["valid"] is True and got.get("empty") and "used up" in got["error"]


# ---------------------------------------------------------------- Reader

def test_reader_is_asked_for_markdown_with_the_key(fake_jina):
    got = run(jina.read("https://www.dogus.com.tr/Urun/mentese/1"))
    (req,) = jina_calls(fake_jina)
    assert req.method == "GET" and str(req.url) == "https://r.jina.ai/https://www.dogus.com.tr/Urun/mentese/1"
    assert req.headers["authorization"] == f"Bearer {KEY}" and req.headers["x-return-format"] == "markdown"
    assert req.headers["accept"] == "application/json" and req.headers["x-robots-txt"] == mf.USER_AGENT
    assert got["ok"] and got["title"] == "Menteşe M20" and got["tokens"] == 321
    # the Markdown is the text: the table kept, a link as its words, the pictures apart
    assert "| Boy | 20 mm |" in got["text"] and "Kelepçe" in got["text"] and "](" not in got["text"]
    assert ("https://www.dogus.com.tr/Urun/kelepce/3", "Kelepçe") in got["links"]
    assert got["images"] == [("https://www.dogus.com.tr/img/mentese.jpg", "Image 1: Menteşe")]


def test_reader_plain_text_answer_and_errors(fake_jina):
    fake_jina["reader"] = lambda req: httpx.Response(200, text=(
        "Title: Robo90 PLA\nURL Source: https://www.robo90.com/pla\n\nMarkdown Content:\n# PLA\n\nMarka: Robo90\n"
        + "Ürün Kodu: R006532. " * 20), headers={"content-type": "text/plain"})
    got = run(jina.read("https://www.robo90.com/pla?x=1"))
    assert got["ok"] and got["title"] == "Robo90 PLA" and got["url"] == "https://www.robo90.com/pla"
    assert got["text"].startswith("# PLA") and got["tokens"] > 0
    fake_jina["reader"] = lambda req: httpx.Response(422, json={"code": 422, "readableMessage": "No content"})
    got = run(jina.read("https://www.robo90.com/pla"))
    assert not got["ok"] and got["error"].startswith("Jina 422") and KEY not in got["error"]

    def slow(req):
        raise httpx.ReadTimeout("slow", request=req)
    fake_jina["reader"] = slow
    got = run(jina.read("https://www.robo90.com/pla"))
    assert not got["ok"] and "did not answer" in got["error"]
    jina._conf.clear()
    got = run(jina.read("https://www.robo90.com/pla"))
    assert not got["ok"] and "not set up" in got["error"]


# ---------------------------------------------------------------- the crawler

def _crawl(choice, start="https://www.dogus.com.tr/", only=None):
    track = mf.Tracker()

    async def go():
        f = mf.Fetcher(choice, "s1")
        try:
            return await mf.crawl(start, track, f, 6, only=only), f
        finally:
            await f.close()
    got, f = run(go())
    return got, track, f


def test_jina_mode_reads_the_pages_through_reader_and_robots_directly(web, fake_jina):  # noqa: F811
    got, track, f = _crawl(["jina"])
    direct = web["seen"]
    # robots.txt and the sitemap are read here, never through Jina
    assert "https://www.dogus.com.tr/robots.txt" in direct and "https://www.dogus.com.tr/sitemap.xml" in direct
    assert not [u for u in direct if not u.endswith((".txt", ".xml"))]
    asked = [str(r.url)[len("https://r.jina.ai/"):] for r in jina_calls(fake_jina)]
    assert asked and asked[0] == "https://www.dogus.com.tr/"
    assert all(a.startswith("https://www.dogus.com.tr/") for a in asked)
    # robots.txt's Disallow holds through Jina too
    assert not [a for a in asked if "/gizli" in a]
    rows = track.meta["pages"]
    assert rows and all(r["via"] == "jina" for r in rows)
    page = got["pages"][0]
    assert page["title"] == "Menteşe M20" and "| Malzeme | AISI 304 |" in page["text"]
    assert ("https://www.dogus.com.tr/Urun/kelepce/3", "Kelepçe") in page["links"]
    assert f.stats["jina"]["requests"] == len(asked) and f.stats["jina"]["tokens"] == 321 * len(asked)
    assert f.stats["direct"]["requests"] == 2


def test_jina_is_never_asked_for_a_private_address(web, fake_jina):  # noqa: F811
    f = mf.Fetcher(["jina"])
    for u in ("http://inside.example/", "http://127.0.0.1/x", "http://meta.example/latest", "file:///etc/passwd"):
        got = run(f._jina(u, lambda x: True))
        assert got["error"] and got["error_kind"] == "refused" and got["status"] is None, u
    assert not jina_calls(fake_jina)
    run(f.close())


def test_jina_needs_its_key(web, fake_jina, monkeypatch):  # noqa: F811
    jina._conf.clear()
    with pytest.raises(mf.Refused, match="Jina has no API key"):
        mf.Fetcher(["jina"])
    assert "Jina has no API key" in mf.choice_problem(["jina"])
    assert mf.choice_problem(["local", "jina"]) is None and mf.choice_problem(None) is None
    assert mf.Fetcher(["jina", "local"]).order == ["local"]           # passed over, not refused
    st = mf.proxy_state()
    assert st["jina"] is False and "no API key" in st["ready"]["jina"]


def test_jina_fallback_reads_a_refused_page_through_jina_then_stays(web, fake_jina, monkeypatch):  # noqa: F811
    monkeypatch.setattr(netproxy, "_conf", {})
    monkeypatch.setattr(mf, "THIN_TEXT", 0)           # the fake site's pages are short: none is "thin" here
    web["site"] = site(web["seen"], {"/Urunler/10/baglanti": httpx.Response(429, text="slow down")})
    got, track, f = _crawl(["local", "jina", "proxy"])
    rows = track.meta["pages"]
    first = next(i for i, r in enumerate(rows) if r["url"].endswith("/Urunler/10/baglanti"))
    assert rows[first]["via"] == "jina" and rows[first]["fallback"] and rows[first]["status"] == 200
    # the site turned us away: every page after it goes through Jina, without asking directly first
    assert all(r["via"] == "jina" for r in rows[first:]) and len(rows) > first + 1
    assert not [u for u in web["seen"][web["seen"].index("https://www.dogus.com.tr/Urunler/10/baglanti") + 1:]
                if not u.endswith((".txt", ".xml"))]
    assert f.jina_since and f.stats["direct"]["refused"] == 1 and f.proxy_url is None


def test_jina_fallback_reads_a_page_written_by_its_script(web, fake_jina, monkeypatch):  # noqa: F811
    monkeypatch.setattr(netproxy, "_conf", {})
    web["site"] = site(web["seen"], {"/": ("text/html", "<html><body><div id=app></div><script>render()</script></body></html>")})
    got, track, f = _crawl(["local", "jina", "proxy"], only=["https://www.dogus.com.tr/"])
    (row,) = track.meta["pages"]
    assert row["via"] == "jina" and row["fallback"] and "AISI 304" in got["pages"][0]["text"]
    assert not f.jina_since                            # a thin page does not switch the run over


def test_jina_fallback_goes_to_the_proxy_when_jina_fails_too(web, fake_jina, monkeypatch):  # noqa: F811
    monkeypatch.setattr(netproxy, "_conf", {"host": "proxy.test", "port": 8000})
    monkeypatch.setattr(netproxy, "log", lambda row: None)
    web["site"] = site(web["seen"], {"/": httpx.Response(403, text="no")})
    web["proxy_site"] = site([])
    fake_jina["reader"] = lambda req: httpx.Response(451, json={"code": 451, "message": "blocked"})
    got, track, f = _crawl(["local", "jina", "proxy"], only=["https://www.dogus.com.tr/"])
    (row,) = track.meta["pages"]
    assert row["via"] == "proxy" and row["status"] == 200 and row["fallback"]
    assert f.stats["jina"]["failed"] == 1 and web["proxied"]


def test_jina_first_then_local_when_jina_cannot(web, fake_jina, monkeypatch):  # noqa: F811
    fake_jina["reader"] = lambda req: httpx.Response(429, json={"code": 429, "message": "slow down"})
    got, track, f = _crawl(["jina", "local"], only=["https://www.dogus.com.tr/"])
    (row,) = track.meta["pages"]
    assert row["via"] == "direct" and row["fallback"] and row["status"] == 200
    assert f.stats["jina"]["failed"] == 1 and f.at == 1


def test_a_thin_page_goes_to_jina_only_when_jina_comes_later(web, fake_jina, monkeypatch):  # noqa: F811
    web["site"] = site(web["seen"], {"/": ("text/html", "<html><body><div id=app></div><script>x()</script></body></html>")})
    _, track, _f = _crawl(["local"], only=["https://www.dogus.com.tr/"])
    assert track.meta["pages"][0]["via"] == "direct" and not jina_calls(fake_jina)


def test_the_api_takes_orders_of_routes(db, web, fake_jina, monkeypatch):  # noqa: F811
    started = []

    async def work(dbx, jid, mid, choice, reuse=None):
        started.append(choice)
    monkeypatch.setattr(mf, "_work", work)
    a = person(db, "a")
    r = a.post("/api/manufacturers", json={"url": "https://www.dogus.com.tr/", "route": ["jina"], "explore": True})
    assert r.status_code == 200 and r.json()["manufacturer"]["route"] == ["jina"] and started == [["jina"]]
    assert r.json()["job"]["route"] == ["jina"] and r.json()["job"]["route_default"] is False
    mid = r.json()["manufacturer"]["id"]
    # back to the default order: kept as no order of its own
    assert a.patch(f"/api/manufacturers/{mid}", json={"route": "default"}).json()["route"] is None
    jina._conf.clear()
    r = a.post("/api/manufacturers", json={"url": "https://other.example/", "route": ["jina"]})
    assert r.status_code == 400 and "Jina has no API key" in r.json()["detail"]
    for bad in ("always", "jina_fallback", ["always"], []):
        assert a.post("/api/manufacturers", json={"url": "https://other.example/", "route": bad}).status_code == 400, bad


def test_makers_and_runs_from_before_the_orders_still_load():
    assert mf.maker_route({"proxy": "jina_fallback"}) == ["local", "jina", "proxy"]
    assert mf.maker_route({"proxy": "always"}) == ["proxy", "local"]
    assert mf.maker_route({"proxy": "off"}) == ["local"]
    assert mf.maker_route({"route": None, "proxy": "always"}) is None          # the new field wins
    assert mf.maker_route({}) is None
    old = {"_id": "j1", "proxy": "always", "started_at": "2026-10-01T00:00:00+00:00", "finished_at": None}
    got = mf.job_out(old, full=False)
    assert got["route"] == ["proxy", "local"] and "proxy" not in got
    assert mf.job_out({**old, "proxy": "jina"}, full=False)["route"] == ["jina"]
    assert mf.out({"_id": "m1", "proxy": "fallback"})["route"] == ["local", "proxy"]


# ---------------------------------------------------------------- Search and the Chat's tools

def test_web_search_and_web_read_tools(web, fake_jina):  # noqa: F811
    ws, wr = chat_tools.tools()["web_search"], chat_tools.tools()["web_read"]
    assert (ws.package, ws.level, ws.default) == ("general", "read", True)
    assert (wr.package, wr.level, wr.default) == ("general", "read", True)
    got = run(ws.run(Ctx(db=None), {"query": "M20 menteşe", "site": "https://dogus.com.tr/x", "count": 3}))
    (req,) = jina_calls(fake_jina, "s.jina.ai")
    assert req.url.path == "/search" and req.url.params["q"] == "M20 menteşe" and req.url.params["num"] == "3"
    assert req.url.params["site"] == "dogus.com.tr" and req.headers["x-respond-with"] == "no-content"
    assert req.headers["authorization"] == f"Bearer {KEY}"
    assert "Jina Search" in got.text and "https://www.dogus.com.tr/Urun/mentese/1" in got.text and got.vars["n"] == 2
    got = run(wr.run(Ctx(db=None), {"url": "www.dogus.com.tr/Urun/mentese/1"}))
    (req,) = jina_calls(fake_jina)
    assert req.headers["x-remove-selector"] == "header, nav, footer"
    assert "| Boy | 20 mm |" in got.text and got.vars["title"] == "Menteşe M20"
    with pytest.raises(ToolError, match="private or local"):
        run(wr.run(Ctx(db=None), {"url": "http://inside.example/"}))
    assert len(jina_calls(fake_jina)) == 1
    jina._conf.clear()
    for t, args in ((ws, {"query": "x"}), (wr, {"url": "https://www.dogus.com.tr/"})):
        with pytest.raises(ToolError, match="not set up"):
            run(t.run(Ctx(db=None), args))


def test_the_tools_strings_are_translated():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    for n in ("web_search", "web_read"):
        t = chat_tools.tools()[n]
        for s in (t.label, t.about, t.running, t.failed):
            assert "'" + s.replace("'", "\\'") + "':" in tr, s
    for s in ("Searched the web for “{query}” · {n} results", "Searched the web for “{query}” · nothing found",
              "Read the web page {title}"):
        assert f"'{s}':" in tr, s


# ---------------------------------------------------------------- the analytics

def test_every_call_is_counted_reader_and_search_apart(fake_jina):
    fake = FakeDb()
    jina.bind(lambda: fake)

    async def go():
        await jina.read("https://www.dogus.com.tr/a", who="chat")
        fake_jina["reader"] = lambda req: httpx.Response(429, json={"message": "slow"})
        await jina.read("https://www.dogus.com.tr/b", who="manufacturers")
        await jina.search("menteşe", who="chat")
        await asyncio.sleep(0.05)
    run(go())
    rows = list(fake[jina.LOG].docs.values())
    assert sorted((r["api"], r["ok"]) for r in rows) == [("reader", False), ("reader", True), ("search", True)]
    assert KEY not in json.dumps(rows, default=str)
    out = jina.summarise(rows, 14)
    assert out["reader"]["requests"] == 2 and out["reader"]["ok"] == 1 and out["reader"]["failed"] == 1
    assert out["reader"]["tokens"] == 321 and out["search"]["tokens"] == 10000 and out["search"]["requests"] == 1
    assert out["reader"]["calls"]["series"][0]["values"][-1] == 1 and out["reader"]["calls"]["series"][1]["values"][-1] == 1
    assert {x["name"] for x in out["reader"]["by_who"]} == {"chat", "manufacturers"}


def test_the_usage_route_counts_by_day(db, fake_jina):  # noqa: F811
    now = datetime.now(timezone.utc)
    rows = [{"api": "reader", "ok": True, "at": now - timedelta(days=d), "ms": 900, "chars": 5000, "tokens": 1200,
             "target": "https://a.example/", "who": "manufacturers"} for d in (0, 0, 3, 20)]
    rows.append({"api": "search", "ok": False, "at": now, "ms": 100, "chars": 0, "tokens": 0, "error": "Jina 429",
                 "target": "x", "who": "chat"})
    for i, r in enumerate(rows):
        run(db[jina.LOG].insert_one({"_id": f"r{i}", **r}))
    got = person(db, "o").get("/api/jina/usage?days=14").json()
    assert got["reader"]["requests"] == 3 and got["reader"]["tokens"] == 3600 and got["search"]["failed"] == 1
    oks = got["reader"]["calls"]["series"][0]["values"]
    assert len(oks) == 14 and oks[-1] == 2 and oks[-4] == 1
    assert got["log"][0]["api"] in ("reader", "search") and len(got["log"]) == 4
