"""Manufacturers (backend/manufacturers.py): makers kept per workspace, their
sites explored politely - robots.txt, the same domain, a page cap, public
addresses only, any charset - and their catalogs read by a model, as a
background run that can be followed, cancelled, and survives a reload.

No real site and no real model are reached: the HTTP goes to a fake
transport, the names to a fake resolver, the model is a stub."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from backend import access, cc_context, llm, netproxy
from backend import manufacturers as mf
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401  (the fixture)


def run(c):
    return asyncio.run(c)


# ---------------------------------------------------------------- a fake site

PUBLIC = {"www.dogus.com.tr": ["93.184.216.34"], "dogus.com.tr": ["93.184.216.34"],
          "cdn.dogus.com.tr": ["93.184.216.35"], "other.example": ["93.184.216.36"],
          "inside.example": ["10.0.0.5"], "meta.example": ["169.254.169.254"]}

ROBOTS = "User-agent: *\nDisallow: /gizli\nSitemap: https://www.dogus.com.tr/sitemap.xml\n"
SITEMAP = ("<?xml version='1.0'?><urlset><url><loc>https://www.dogus.com.tr/Urun/mentese/1</loc></url>"
           "<url><loc>https://www.dogus.com.tr/Urun/rulman/2</loc></url>"
           "<url><loc>https://other.example/Urun/x</loc></url></urlset>")
HOME = ("<html><head><title>Doğuş Kalıp</title><meta name='description' content='Kalıp elemanları'></head><body>"
        "<nav><a href='/Urunler/10/baglanti'>Bağlantı</a> <a href='/haberler/1'>Haber</a>"
        " <a href='/giris-yap'>Giriş</a> <a href='/gizli/x'>Gizli</a></nav>"
        "<script>document.write('never run')</script>"
        "<p>Kalıp elemanları üretiriz.</p><a href='https://other.example/'>Dış</a>"
        "<a href='http://inside.example/'>iç</a><a href='/katalog.pdf'>E-katalog</a>"
        "<a href='javascript:__doPostBack(1)'>x</a></body></html>")
CATEGORY = ("<html><head><title>Bağlantı Ekipmanları</title></head><body>"
            "<a href='/Urun/mentese/1'>Menteşe</a><a href='/Urun/kelepce/3'>Kelepçe</a></body></html>")


def product(name: str, extra: str = "") -> str:
    return (f"<html><head><title>{name}</title></head><body><h1>{name}</h1>"
            f"<table><tr><th>Boy</th><td>20 mm</td></tr><tr><th>Malzeme</th><td>AISI 304</td></tr></table>"
            f"<img src='/img/{name}.jpg' alt='{name}'>{extra}</body></html>")


def site(seen: list, extra: dict | None = None):
    pages = {"/robots.txt": ("text/plain", ROBOTS), "/sitemap.xml": ("application/xml", SITEMAP),
             "/": ("text/html; charset=utf-8", HOME), "/Urunler/10/baglanti": ("text/html", CATEGORY),
             "/Urun/mentese/1": ("text/html", product("Menteşe")),
             "/Urun/rulman/2": ("text/html", product("Rulman")),
             "/Urun/kelepce/3": ("text/html", product("Kelepçe")),
             "/haberler/1": ("text/html", "<html><title>Haber</title><body>news</body></html>"),
             **(extra or {})}

    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        assert req.headers["user-agent"] == mf.USER_AGENT
        if req.url.host != "www.dogus.com.tr":
            return httpx.Response(200, text="<html>elsewhere</html>", headers={"content-type": "text/html"})
        got = pages.get(req.url.raw_path.decode().split("?")[0]) or pages.get(req.url.path)
        if got is None:
            return httpx.Response(404, text="nope")
        if isinstance(got, httpx.Response):
            return got
        ct, body = got
        return httpx.Response(200, content=body.encode("utf-8") if isinstance(body, str) else body,
                              headers={"content-type": ct})
    return handle


@pytest.fixture
def web(monkeypatch):
    """The fake internet: names from PUBLIC, pages from `state['site']`,
    no pause between requests."""
    state = {"seen": [], "proxied": []}
    state["site"] = site(state["seen"])

    async def resolve(host):
        if host not in PUBLIC:
            raise OSError("no such host")
        return PUBLIC[host]

    def client(proxy=None):
        def handler(req):
            if proxy:
                state["proxied"].append(str(req.url))
            return state["site"](req) if not proxy or "proxy_site" not in state else state["proxy_site"](req)
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False,
                                 headers={"User-Agent": mf.USER_AGENT})

    monkeypatch.setattr(mf, "_resolve", resolve)
    monkeypatch.setattr(mf, "_client", client)
    monkeypatch.setattr(mf, "DELAY", 0)
    return state


def _crawl(start="https://www.dogus.com.tr/", choice=("local",), cap=mf.MAX_PAGES):
    track = mf.Tracker()

    async def go():
        f = mf.Fetcher(list(choice), "s1")
        try:
            return await mf.crawl(start, track, f, cap), f
        finally:
            await f.close()
    (got, f) = run(go())
    return got, track, f


# ---------------------------------------------------------------- addresses

def test_the_domain_a_site_owns():
    assert mf.registrable("www.doguskalip.com.tr") == "doguskalip.com.tr"
    assert mf.registrable("static.doguskalip.com.tr") == "doguskalip.com.tr"
    assert mf.registrable("shop.example.com") == "example.com"
    assert mf.registrable("www.example.co.uk") == "example.co.uk"
    assert mf.normalise("/Urun/90°-dirsek/7165#top", "https://www.doguskalip.com.tr/x") == \
        "https://www.doguskalip.com.tr/Urun/90%C2%B0-dirsek/7165"
    assert mf.normalise("HTTPS://WWW.Example.com:443/a?utm_source=x&page=2") == "https://www.example.com/a?page=2"
    for bad in ("javascript:alert(1)", "mailto:a@b.c", "ftp://example.com/", "tel:0212", "http://u:p@example.com/"):
        assert mf.normalise(bad) is None, bad


def test_only_public_addresses_are_fetched(web):
    assert run(mf.check("https://www.dogus.com.tr/")) == "https://www.dogus.com.tr/"
    for bad in ("http://127.0.0.1/", "http://localhost:8000/", "http://10.1.2.3/", "http://169.254.169.254/latest",
                "http://[::1]/", "http://192.168.1.1/", "http://inside.example/", "http://meta.example/",
                "ftp://www.dogus.com.tr/", "http://x.internal/", "http://nowhere.invalid/"):
        with pytest.raises(mf.Refused):
            run(mf.check(bad))


def test_a_page_in_any_charset_is_read():
    tr = "Menteşe, kelepçe ve çıkarıcı pim"
    assert mf.decode(tr.encode("cp1254"), "text/html; charset=windows-1254") == tr
    assert mf.decode(f"<meta charset='iso-8859-9'><p>{tr}</p>".encode("iso-8859-9")).endswith(f"<p>{tr}</p>")
    assert mf.decode(tr.encode("cp1254")) == tr                                  # nothing said: Turkish Windows
    assert mf.decode(tr.encode("utf-8")) == tr
    page = mf.parse_page(HOME, "https://www.dogus.com.tr/")
    assert page["title"] == "Doğuş Kalıp" and "never run" not in page["text"] and "Kalıp elemanları üretiriz." in page["text"]
    assert ("https://www.dogus.com.tr/Urunler/10/baglanti", "Bağlantı") in page["links"]
    assert not any(u.startswith("javascript") for u, _ in page["links"])
    table = mf.parse_page(product("Menteşe"), "https://www.dogus.com.tr/Urun/mentese/1")
    assert "Boy | 20 mm" in table["text"] and table["images"][0][0] == "https://www.dogus.com.tr/img/Menteşe.jpg".replace("ş", "%C5%9F")


def test_product_links_go_first():
    assert mf.score("https://x.com/Urunler/10/baglanti") > mf.score("https://x.com/haberler/12/fuar")
    assert mf.score("https://x.com/products/hinges") > mf.score("https://x.com/contact")
    assert mf.score("https://x.com/giris-yap") <= -50 and mf.score("https://x.com/sepetim") <= -50


# ---------------------------------------------------------------- the crawl

def test_the_crawl_keeps_to_the_site_and_its_robots(web):
    got, track, f = _crawl()
    urls = [p["url"] for p in got["pages"]]
    seen = web["seen"]
    assert seen[0] == "https://www.dogus.com.tr/robots.txt" and seen[1] == "https://www.dogus.com.tr/sitemap.xml"
    assert urls[0] == "https://www.dogus.com.tr/"
    # the sitemap's product pages and the linked ones are read; robots, other sites, logins and files are not
    assert "https://www.dogus.com.tr/Urun/mentese/1" in urls and "https://www.dogus.com.tr/Urun/kelepce/3" in urls
    assert not [u for u in seen if "gizli" in u or "other.example" in u or "inside.example" in u
                or "giris" in u or u.endswith(".pdf")]
    assert got["docs"] == [{"url": "https://www.dogus.com.tr/katalog.pdf", "label": "E-katalog"}]
    assert got["domain"] == "dogus.com.tr"
    # product pages before the news
    assert urls.index("https://www.dogus.com.tr/Urun/mentese/1") < urls.index("https://www.dogus.com.tr/haberler/1")
    steps = {s["id"]: s for s in track.steps}
    assert steps["robots"]["state"] == "done" and steps["robots"]["sitemaps"] == 1
    assert steps["sitemap"]["urls"] == 2 and steps["crawl"]["state"] == "done"
    assert len(track.meta["pages"]) == steps["crawl"]["pages"]
    assert f.stats["direct"]["requests"] == len(seen) and f.stats["proxy"]["requests"] == 0


def test_the_page_cap_holds(web):
    got, track, _ = _crawl(cap=2)
    assert len(got["pages"]) == 2 and len(track.meta["pages"]) == 2


def test_a_redirect_into_the_network_is_refused(web):
    extra = {"/Urun/rulman/2": httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"}),
             "/Urun/mentese/1": httpx.Response(301, headers={"location": "https://other.example/stolen"})}
    web["site"] = site(web["seen"], extra)
    _, track, _ = _crawl()
    rows = {r["url"]: r for r in track.meta["pages"]}
    assert "private or local address" in rows["https://www.dogus.com.tr/Urun/rulman/2"]["error"]
    assert "off the site" in rows["https://www.dogus.com.tr/Urun/mentese/1"]["error"]
    assert not [u for u in web["seen"] if "169.254" in u or "other.example" in u]


def test_a_closed_robots_txt_reads_nothing(web):
    web["site"] = site(web["seen"], {"/robots.txt": ("text/plain", "User-agent: *\nDisallow: /\n")})
    with pytest.raises(mf.ExploreError, match="no page"):
        _crawl()
    assert web["seen"] == ["https://www.dogus.com.tr/robots.txt"]


def test_a_large_page_is_cut_and_a_file_is_not_read(web):
    big = "<html><title>Big</title><body>" + "x" * (mf.MAX_BYTES + 5000) + "</body></html>"
    web["site"] = site(web["seen"], {"/Urun/mentese/1": ("text/html", big),
                                     "/Urun/rulman/2": ("application/pdf", "%PDF-1.4")})
    _, track, _ = _crawl()
    rows = {r["url"]: r for r in track.meta["pages"]}
    assert rows["https://www.dogus.com.tr/Urun/mentese/1"]["bytes"] == mf.MAX_BYTES
    assert "not a web page" in rows["https://www.dogus.com.tr/Urun/rulman/2"]["error"]
    assert rows["https://www.dogus.com.tr/Urun/rulman/2"]["bytes"] == 0


# ---------------------------------------------------------------- the proxy

def _proxy_on(monkeypatch):
    monkeypatch.setattr(netproxy, "_conf", {"host": "proxy.test", "port": 8000})
    monkeypatch.setattr(netproxy, "log", lambda row: None)


def test_fallback_goes_through_the_proxy_once_refused(web, monkeypatch):
    _proxy_on(monkeypatch)
    blocked = site(web["seen"], {"/Urunler/10/baglanti": httpx.Response(429, text="slow down")})
    web["site"] = blocked
    web["proxy_site"] = site([])
    got, track, f = _crawl(choice=["local", "proxy"])
    rows = [r for r in track.meta["pages"] if r.get("fallback")]
    assert len(rows) == 1 and rows[0]["via"] == "proxy" and rows[0]["status"] == 200
    assert f.stats["direct"]["refused"] == 1 and f.stats["proxy"]["requests"] >= 1
    # after the refusal the run stays on the proxy
    assert web["proxied"] and all(r["via"] == "proxy" for r in track.meta["pages"][track.meta["pages"].index(rows[0]):])
    assert f.switched_at


def test_proxy_first_and_local_only(web, monkeypatch):
    _proxy_on(monkeypatch)
    _, track, f = _crawl(choice=["proxy", "local"])
    assert f.stats["direct"]["requests"] == 0 and all(r["via"] == "proxy" for r in track.meta["pages"])
    web["proxied"].clear()
    _, track, f = _crawl(choice=["local"])
    assert not web["proxied"] and f.stats["proxy"]["requests"] == 0 and f.proxy_url is None
    monkeypatch.setattr(netproxy, "_conf", {})
    with pytest.raises(mf.Refused, match="not set up"):
        mf.Fetcher(["proxy"], "s")
    assert mf.Fetcher(["proxy", "local"], "s").order == ["local"]      # a route not set up is passed over
    st = mf.proxy_state()
    assert st["configured"] is False and st["order"] == ["local", "proxy"] and st["routes"] == ["local", "proxy", "jina"]
    assert st["ready"]["local"] is None and "not set up" in st["ready"]["proxy"]


def test_the_proxy_answers_and_then_a_refused_proxy_goes_to_local(web, monkeypatch):
    """Proxy first: a refusal through it is asked directly, and the rest of
    the run starts there."""
    _proxy_on(monkeypatch)
    web["proxy_site"] = site([], {"/Urunler/10/baglanti": httpx.Response(403, text="no")})
    _, track, f = _crawl(choice=["proxy", "local"])
    rows = track.meta["pages"]
    i = next(n for n, r in enumerate(rows) if r["url"].endswith("/Urunler/10/baglanti"))
    assert all(r["via"] == "proxy" for r in rows[:i])
    assert rows[i]["via"] == "direct" and rows[i]["fallback"] and rows[i]["status"] == 200
    assert all(r["via"] == "direct" for r in rows[i + 1:]) and f.at == 1


def test_a_network_failure_tries_the_next_route(web, monkeypatch):
    _proxy_on(monkeypatch)

    def down(req):
        raise httpx.ConnectError("unreachable", request=req)
    web["site"] = down
    web["proxy_site"] = site([])
    _, track, f = _crawl(choice=["local", "proxy"])
    assert track.meta["pages"] and all(r["via"] == "proxy" for r in track.meta["pages"])
    assert f.switched_at


# ---------------------------------------------------------------- the model's answer

PAGE_URL = "https://www.dogus.com.tr/Urun/mentese/1"


def test_the_answer_becomes_a_catalog():
    known = {PAGE_URL, "https://www.dogus.com.tr/img/m.jpg"}
    raw = ('```json\n{"company": {"name": "Doğuş Kalıp", "description": "Kalıp elemanları.", "categories": ["Menteşe"]},'
           ' "products": [{"name": "Menteşe", "category": "Menteşe", "specs": {"Boy": "20 mm", "": "x"},'
           ' "sku": "DK-1", "url": "' + PAGE_URL + '", "image": "https://www.dogus.com.tr/img/m.jpg"},'
           ' {"name": "Menteşe X", "url": "https://made.up/page", "image": "https://made.up/i.png"},'
           ' {"name": ""}, "junk"]}\n```')
    got = mf.parse_answer(raw, known)
    assert got["company"]["name"] == "Doğuş Kalıp" and got["rows"] == 4 and got["invalid"] == 2
    a, b = got["products"]
    assert a["specs"] == {"Boy": "20 mm"} and a["url"] == PAGE_URL and a["image"].endswith("m.jpg") and a["id"]
    assert b["url"] == "" and b["image"] == ""                                 # made up: dropped
    with pytest.raises(ValueError):
        mf.parse_answer("I could not read it.")
    merged, dups = mf.merge_products([[a], [{**a, "description": "more", "specs": {"Malzeme": "304"}}], [b]])
    assert dups == 1 and len(merged) == 2
    assert merged[0]["description"] == "more" and merged[0]["specs"] == {"Boy": "20 mm", "Malzeme": "304"}


def _fake_llm(monkeypatch, answer=None, seen=None):
    async def complete(messages, **kw):
        if seen is not None:
            seen.append(messages)
        user = messages[1]["content"]
        prods = [{"name": n, "category": "Bağlantı", "specs": {"Boy": "20 mm"},
                  "url": f"https://www.dogus.com.tr/Urun/{k}"}
                 for n, k in (("Menteşe", "mentese/1"), ("Kelepçe", "kelepce/3"), ("Rulman", "rulman/2"))
                 if f"=== PAGE https://www.dogus.com.tr/Urun/{k}" in user]
        text = answer if answer is not None else (
            '{"company": {"name": "Doğuş Kalıp A.Ş.", "description": "Kalıp elemanları üretir.",'
            ' "categories": ["Bağlantı"]}, "products": ' + str(prods).replace("'", '"') + "}")
        return {"choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 200},
                "provider": "commandcode", "model": "m"}

    async def nothing(db, **kw):
        pass
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", nothing)
    monkeypatch.setattr(llm, "route", lambda job: ("commandcode", "m"))


def test_the_pages_are_read_in_chunks_and_merged(web, monkeypatch):
    seen = []
    _fake_llm(monkeypatch, seen=seen)
    monkeypatch.setattr(mf, "CHUNK_CHARS", 400)
    got, track, _ = _crawl()
    out = run(mf.extract(None, got, track))
    assert len(seen) > 1 and track.totals["chunks"] == len(seen)
    assert seen[0][1]["content"].index("=== PAGE https://www.dogus.com.tr/\n") < 200    # the home page first
    assert {p["name"] for p in out["products"]} == {"Menteşe", "Kelepçe", "Rulman"}
    assert out["company"]["name"] == "Doğuş Kalıp A.Ş." and out["company"]["categories"] == ["Bağlantı"]
    asks = [s for s in track.steps if s["kind"] == "ask"]
    assert all(s["state"] == "done" and s["tokens_in"] == 1000 for s in asks)
    assert track.totals["tokens_in"] == 1000 * len(asks) and track.totals["products"] == 3
    assert llm.JOBS[mf.JOB]["label"] == "Manufacturer exploration" and llm.job_label("manufacturer") == "Manufacturer exploration"


# ---------------------------------------------------------------- the run, as a job

def _until_done(fake, jid):
    async def go():
        t = mf._TASKS.get(jid)
        if t:
            await t
        return await mf.job(fake, jid)
    return go


def test_a_run_explores_and_fills_the_catalog(web, monkeypatch):
    _fake_llm(monkeypatch)
    fake = FakeDb()

    async def go():
        doc = await mf.create(fake, "https://www.dogus.com.tr/", by={"id": "a", "name": "A"})
        jd, started = await mf.start_job(fake, doc["_id"])
        again, started2 = await mf.start_job(fake, doc["_id"])
        assert started and not started2 and again["_id"] == jd["_id"]
        return doc, await _until_done(fake, jd["_id"])()

    doc, d = run(go())
    assert d["status"] == "done" and d["products_found"] == 3 and d["route"] == ["local"] and d["route_default"]
    kinds = [s["kind"] for s in d["steps"]]
    assert kinds[:3] == ["robots", "sitemap", "crawl"] and kinds[-2:] == ["merge", "done"]
    assert d["pages"] and d["totals"]["requests_direct"] > 0 and d["totals"]["requests_proxy"] == 0
    m = run(mf.get(fake, doc["_id"]))
    assert m["name"] == "Doğuş Kalıp A.Ş." and m["summary"] == "Kalıp elemanları üretir." and len(m["products"]) == 3
    assert m["explored_at"] and m["docs"][0]["url"].endswith("katalog.pdf")
    out = mf.job_out(d, full=False)
    assert "pages" not in out and out["page_count"] == len(d["pages"]) and "worker" not in out


def test_a_run_keeps_its_pages_and_the_model_step_runs_again_without_the_site(web, monkeypatch):
    _fake_llm(monkeypatch)
    real = llm.complete
    calls = {"n": 0}

    async def flaky(messages, **kw):                 # the first ask meets a gateway timeout once
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Command Code answered HTTP 524: Upstream model provider is temporarily unavailable")
        return await real(messages, **kw)
    monkeypatch.setattr(llm, "complete", flaky)
    monkeypatch.setattr(mf, "RETRY_PAUSE", 0)
    fake = FakeDb()

    async def go():
        doc = await mf.create(fake, "https://www.dogus.com.tr/", by={"id": "a", "name": "A"})
        jd, _ = await mf.start_job(fake, doc["_id"])
        first = await _until_done(fake, jd["_id"])()
        fetched = len(web["seen"])
        again, started = await mf.start_job(fake, doc["_id"], reuse=jd["_id"])
        second = await _until_done(fake, again["_id"])()
        return first, second, fetched

    first, second, fetched = run(go())
    assert first["status"] == "done" and first["products_found"] == 3 and first["kept_pages"] > 0
    ask1 = next(s for s in first["steps"] if s["id"] == "ask:1")
    assert ask1["state"] == "done" and ask1["attempt"] == 2                       # retried once, then answered
    assert len(web["seen"]) == fetched                                             # the second run fetched nothing
    assert second["status"] == "done" and second["products_found"] == 3 and second["reused"] == first["_id"]
    crawl = next(s for s in second["steps"] if s["kind"] == "crawl")
    assert crawl["read"] == first["kept_pages"] and "not fetched" in crawl["note"]
    assert not any(s["kind"] in ("robots", "sitemap") for s in second["steps"])


def test_a_run_can_be_cancelled_and_a_restart_interrupts_it(web, monkeypatch):
    _fake_llm(monkeypatch)

    async def forever(messages, **kw):
        await asyncio.sleep(60)
    monkeypatch.setattr(llm, "complete", forever)
    fake = FakeDb()

    async def go(cancel: bool):
        doc = await mf.create(fake, "www.dogus.com.tr")
        jd, _ = await mf.start_job(fake, doc["_id"])
        for _ in range(200):
            await asyncio.sleep(0.01)
            if (await mf.job(fake, jd["_id"]))["status"] == "asking":
                break
        if cancel:
            d = await mf.cancel_job(fake, jd["_id"], {"id": "a"})
            assert d["status"] == "cancelled"
            await asyncio.sleep(0.05)
        else:
            t = mf._TASKS[jd["_id"]]
            t.cancel()                                   # what the process going away does
            with pytest.raises(asyncio.CancelledError):
                await t
        return await mf.job(fake, jd["_id"])

    d = run(go(True))
    assert d["status"] == "cancelled" and d["cancelled_by"] == {"id": "a"} and not d["error"]
    assert next(s for s in d["steps"] if s["kind"] == "ask")["state"] == "cancelled"
    assert d["_id"] not in mf._TASKS
    d = run(go(False))
    assert d["status"] == "failed" and d["error"] == mf.GONE and d["pages"]


def test_a_run_left_by_a_restart_is_settled_when_read():
    fake = FakeDb()
    old = {"host": mf.WORKER["host"], "pid": 999_999_999, "boot": "gone"}
    for m in ("m1", "m2"):
        run(fake[mf.COLL].insert_one({"_id": m, "name": m}))
    run(fake[mf.JOBS].insert_one({"_id": "j1", "status": "crawling", "manufacturer": {"id": "m1"},
                                  "started_at": mf._now(), "beat": mf._now(), "worker": old,
                                  "steps": [{"id": "crawl", "kind": "crawl", "state": "running",
                                             "started_at": mf._now()}]}))
    run(fake[mf.JOBS].insert_one({"_id": "j2", "status": "asking", "manufacturer": {"id": "m2"},
                                  "started_at": mf._now(), "beat": mf._now(),
                                  "worker": {"host": "elsewhere", "pid": 1, "boot": "b"}, "steps": []}))
    d = run(mf.job(fake, "j1"))
    assert d["status"] == "failed" and d["error"] == mf.GONE and d["steps"][0]["reason"] == mf.GONE
    assert {r["_id"]: r["status"] for r in run(mf.jobs(fake))} == {"j1": "failed", "j2": "asking"}


def test_a_page_that_reloads_finds_the_run_where_it_is(db, web, monkeypatch):  # noqa: F811
    """F5 mid-run: the run is the server's; the page asks for it again by its
    id (?run=) and gets the same steps and pages, still going."""
    _fake_llm(monkeypatch)
    async def slow(messages, **kw):
        await asyncio.sleep(30)
    monkeypatch.setattr(llm, "complete", slow)
    a = person(db, "a")
    r = a.post("/api/manufacturers", json={"url": "https://www.dogus.com.tr/", "route": ["local"]}).json()
    jid, mid = r["job"]["job_id"], r["manufacturer"]["id"]
    assert r["job"]["status"] == "queued" and r["manufacturer"]["route"] == ["local"]
    # The TestClient's loop ran the task as far as it got; what the server wrote is what a reload reads.
    first = a.get(f"/api/manufacturers/jobs/{jid}").json()
    again = a.get(f"/api/manufacturers/jobs/{jid}").json()
    assert first["id"] == again["id"] == jid and first["manufacturer"]["id"] == mid
    assert [s["id"] for s in again["steps"]][:len(first["steps"])] == [s["id"] for s in first["steps"]]
    listed = [x for x in a.get("/api/manufacturers").json() if not x.get("builtin")]
    assert listed[0]["last_run"]["id"] == jid


# ---------------------------------------------------------------- the API, who sees and who may

def test_a_manufacturer_from_start_to_finish(db, web, monkeypatch):  # noqa: F811
    started = []

    async def work(dbx, jid, mid, choice, reuse=None):
        started.append((mid, choice))
    monkeypatch.setattr(mf, "_work", work)
    a, b = person(db, "a"), person(db, "b")
    assert a.post("/api/manufacturers", json={"url": "http://127.0.0.1:8000/"}).status_code == 400
    assert a.post("/api/manufacturers", json={"url": "https://inside.example/"}).status_code == 400
    r = a.post("/api/manufacturers", json={"url": "www.dogus.com.tr", "notes": "kalıp için", "explore": False}).json()
    m = r["manufacturer"]
    assert r["job"] is None and m["name"] == "dogus.com.tr" and m["url"] == "https://www.dogus.com.tr/"
    assert m["domain"] == "dogus.com.tr" and m["notes"] == "kalıp için" and m["products"] == []
    mid = m["id"]
    m = a.patch(f"/api/manufacturers/{mid}", json={"name": "Doğuş", "notes": "use them for injection molds"}).json()
    assert m["name"] == "Doğuş" and m["name_auto"] is False
    assert a.patch(f"/api/manufacturers/{mid}", json={"url": "http://10.0.0.1/"}).status_code == 400
    # its catalog, as a run would leave it
    from backend import scope
    ws_a = next(iter(db[mf.COLL].docs.values()))["workspace_id"]
    run(scope.ScopedDb(db, ws_a)[mf.COLL].update_one({"_id": mid}, {"$set": {"products": [
        {"id": "p1", "name": "Paslanmaz Menteşe", "category": "Menteşe", "specs": {"Boy": "20 mm"}, "sku": "DK-1"},
        {"id": "p2", "name": "Teflon Rulman", "category": "Rulman", "specs": {}}]}}))
    # The built-in sources come first, for every workspace and empty or not (backend/catalog_builtin.py).
    every = a.get("/api/manufacturers").json()
    assert [x["id"] for x in every if x.get("builtin")] == ["lcsc", "mcmaster", "grabcad", "own"] and every[0]["id"] == "lcsc"
    listed = [x for x in every if not x.get("builtin")]
    assert [x["id"] for x in listed] == [mid] and listed[0]["product_count"] == 2 and "products" not in listed[0]
    assert [x["id"] for x in a.get("/api/manufacturers?q=injection").json()] == [mid]
    # The overview's grid is the workspace's own sites: a built-in source's products only when asked for.
    assert {i["maker"]["id"] for i in a.get("/api/manufacturers/products").json()["items"]} == {mid}
    assert a.get("/api/manufacturers/lcsc").json()["builtin"] is True
    assert [h["product"]["id"] for h in a.get("/api/manufacturers/search?q=mentese").json()] == ["p1"]
    assert [h["product"]["id"] for h in a.get("/api/manufacturers/search?category=rulman").json()] == ["p2"]
    assert len(a.get(f"/api/manufacturers/{mid}").json()["products"]) == 2
    # another space sees none of it - only the built-in sources, empty
    assert [(x["id"], x["product_count"]) for x in b.get("/api/manufacturers").json()] == \
        [("lcsc", 0), ("mcmaster", 0), ("grabcad", 0), ("own", 0)]
    assert b.get(f"/api/manufacturers/{mid}").status_code == 404
    assert b.post(f"/api/manufacturers/{mid}/explore", json={}).status_code == 404
    assert b.get("/api/manufacturers/search?q=mentese").json() == []
    # exploring: the proxy only when it is set up; "always" is no order
    monkeypatch.setattr(netproxy, "_conf", {})
    assert a.post(f"/api/manufacturers/{mid}/explore", json={"route": ["proxy"]}).status_code == 400
    assert a.post(f"/api/manufacturers/{mid}/explore", json={"route": "always"}).status_code == 400
    assert a.post(f"/api/manufacturers/{mid}/explore", json={"route": ["local", "ftp"]}).status_code == 400
    r = a.post(f"/api/manufacturers/{mid}/explore", json={"route": ["proxy", "local"]}).json()
    assert r["started"] and r["route"] == ["local"] and not r["route_default"] and started == [(mid, ["local"])]
    jid = r["job_id"]
    assert a.get("/api/manufacturers/proxy").json()["configured"] is False
    import types
    monkeypatch.setitem(mf._TASKS, jid, types.SimpleNamespace(done=lambda: False, cancel=lambda: None))
    assert [j["id"] for j in a.get("/api/manufacturers/jobs").json()] == [jid]
    assert b.get(f"/api/manufacturers/jobs/{jid}").status_code == 404
    assert a.delete(f"/api/manufacturers/jobs/{jid}").status_code == 409
    assert a.post(f"/api/manufacturers/jobs/{jid}/cancel").json()["status"] == "cancelled"
    assert a.get(f"/api/manufacturers/{mid}").json()["route"] == ["proxy", "local"]      # kept as its own
    # a file to send, made a manufacturer elsewhere
    f = a.get(f"/api/manufacturers/{mid}/export").json()
    assert f["format"] == "redline-manufacturer" and len(f["products"]) == 2
    got = b.post("/api/manufacturers/import", json=f).json()
    assert got["name"] == "Doğuş" and got["product_count"] == 2 and got["route"] is None      # the default order
    assert b.post("/api/manufacturers/import", json={"format": "x"}).status_code == 400
    assert a.delete(f"/api/manufacturers/jobs/{jid}").json() == {"deleted": jid}
    assert a.delete(f"/api/manufacturers/{mid}").json() == {"deleted": mid}
    assert a.get(f"/api/manufacturers/{mid}").status_code == 404


def test_viewers_look_drawers_write():
    for m, p in (("POST", "/api/manufacturers"), ("PATCH", "/api/manufacturers/m1"),
                 ("DELETE", "/api/manufacturers/m1"), ("POST", "/api/manufacturers/m1/explore"),
                 ("POST", "/api/manufacturers/jobs/j1/cancel"), ("DELETE", "/api/manufacturers/jobs/j1"),
                 ("POST", "/api/manufacturers/import")):
        assert not access.page_allowed(m, p), (m, p)
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))
    for p in ("/api/manufacturers", "/api/manufacturers/m1", "/api/manufacturers/jobs", "/api/manufacturers/jobs/j1",
              "/api/manufacturers/search", "/api/manufacturers/proxy", "/api/manufacturers/m1/export"):
        assert access.page_allowed("GET", p) and access.allowed("viewer", access.action("GET", p))


def test_a_manufacturer_is_an_at_mention():
    assert "manufacturer" in cc_context.KINDS
    fake = FakeDb()
    doc = run(mf.create(fake, "https://www.dogus.com.tr/", "Doğuş Kalıp", "for molds"))
    run(fake[mf.COLL].update_one({"_id": doc["_id"]}, {"$set": {"products": [
        {"id": "p", "name": "Menteşe", "category": "Bağlantı", "specs": {"Boy": "20 mm"}, "sku": "", "url": ""}]}}))
    got = run(cc_context.resolve(fake, "manufacturer", doc["_id"]))
    assert got["label"] == "Doğuş Kalıp" and "for molds" in got["text"] and "- Menteşe · [Bağlantı] (Boy: 20 mm)" in got["text"]
    rows = run(cc_context.candidates(fake, "doğuş", "manufacturer"))
    assert rows and rows[0]["kind"] == "manufacturer" and "1 products" in rows[0]["sub"]


# ---------------------------------------------------------------- one page, by hand

LIST = ("<html><head><title>Menteşeler</title></head><body><h1>Menteşeler</h1>"
        "<table><tr><td>DK-1</td><td>Menteşe</td></tr><tr><td>DK-3</td><td>Kelepçe</td></tr></table>"
        "<a href='/Urun/mentese/1'>Menteşe</a> <a href='/Urun/kelepce/3'>Kelepçe</a> <a href='/haberler/1'>Haber</a>"
        "<a href='/iletisim'>İletişim</a> <a href='/gizli/urun-1'>x</a> <a href='/fiyat.pdf'>Fiyat listesi</a>"
        "<a href='https://other.example/Urun/y'>dış</a></body></html>")


def _only(urls, follow=False):
    track = mf.Tracker()

    async def go():
        f = mf.Fetcher("off")
        try:
            return await mf.crawl(urls[0], track, f, only=urls, follow=follow)
        finally:
            await f.close()
    return run(go()), track


def test_only_the_given_page_is_read(web):
    web["site"] = site(web["seen"], {"/liste": ("text/html", LIST)})
    got, track = _only(["https://www.dogus.com.tr/liste"])
    assert web["seen"] == ["https://www.dogus.com.tr/robots.txt", "https://www.dogus.com.tr/liste"]   # no sitemap, no links
    assert [p["url"] for p in got["pages"]] == ["https://www.dogus.com.tr/liste"] and got["only"]
    steps = {s["id"]: s for s in track.steps}
    assert steps["sitemap"]["state"] == "skipped" and steps["sitemap"]["note"] == mf.ONLY_NOTE
    assert steps["crawl"]["state"] == "done" and steps["crawl"]["note"] == mf.ONLY_NOTE and steps["crawl"]["cap"] == 1
    assert got["docs"] == [{"url": "https://www.dogus.com.tr/fiyat.pdf", "label": "Fiyat listesi"}]


def test_a_page_robots_forbids_is_refused_with_why(web):
    with pytest.raises(mf.ExploreError, match="robots.txt of www.dogus.com.tr does not allow"):
        _only(["https://www.dogus.com.tr/gizli/liste"])
    assert web["seen"] == ["https://www.dogus.com.tr/robots.txt"]


def test_following_reads_the_product_links_one_deep_and_capped(web, monkeypatch):
    web["site"] = site(web["seen"], {"/liste": ("text/html", LIST)})
    got, track = _only(["https://www.dogus.com.tr/liste"], follow=True)
    urls = [p["url"] for p in got["pages"]]
    assert urls == ["https://www.dogus.com.tr/liste", "https://www.dogus.com.tr/Urun/mentese/1",
                    "https://www.dogus.com.tr/Urun/kelepce/3"]          # robots, news, contact and other sites left
    assert not [u for u in web["seen"] if "haber" in u or "iletisim" in u or "other.example" in u or "gizli" in u]
    assert {s["id"]: s for s in track.steps}["crawl"]["note"] == mf.FOLLOW_NOTE
    # ...the links of those pages are not followed, and there is a cap
    monkeypatch.setattr(mf, "FOLLOW_MAX", 1)
    web["seen"].clear()
    got, _ = _only(["https://www.dogus.com.tr/liste"], follow=True)
    assert len(got["pages"]) == 2


def test_a_long_page_reaches_the_model_whole():
    page = {"url": "https://x.com/l", "title": "L", "text": "\n".join(f"row {i} " + "x" * 90 for i in range(800)),
            "images": [], "links": []}
    parts = mf.chunks([page], whole=True)
    assert len(parts) > 1 and "row 799" in "".join(parts) and "(part 1 of" in parts[0]
    assert "row 799" not in "".join(mf.chunks([page]))


def _maker_with(fake, products):
    doc = run(mf.create(fake, "https://www.dogus.com.tr/", by={"id": "a", "name": "A"}))
    run(fake[mf.COLL].update_one({"_id": doc["_id"]}, {"$set": {"products": products, "summary": "Kalıp.",
                                                                "categories": ["Eski"]}}))
    return doc["_id"]


def test_a_page_run_adds_to_the_catalog(web, monkeypatch):
    _fake_llm(monkeypatch)
    web["site"] = site(web["seen"], {"/liste": ("text/html", LIST)})
    fake = FakeDb()
    old = [{"id": "o1", "name": "Rulman", "category": "Eski", "description": "", "specs": {}, "sku": "", "url": "", "image": ""},
           {"id": "o2", "name": "Menteşe", "category": "", "description": "eski", "specs": {}, "sku": "", "url": "", "image": ""}]
    mid = _maker_with(fake, old)

    async def go():
        jd, _ = await mf.start_job(fake, mid, only=["https://www.dogus.com.tr/liste"], follow=True)
        return await _until_done(fake, jd["_id"])()
    d = run(go())
    assert d["status"] == "done" and d["kind"] == "page" and d["only"] == ["https://www.dogus.com.tr/liste"]
    assert d["limits"]["pages"] == 1 + mf.FOLLOW_MAX and d["kept_pages"] == 3
    m = run(mf.get(fake, mid))
    names = [p["name"] for p in m["products"]]
    assert names == ["Rulman", "Menteşe", "Kelepçe"]                     # nothing dropped, the new one added
    assert m["products"][1]["description"] == "eski" and m["products"][1]["category"] == "Bağlantı"
    assert m["summary"] == "Kalıp." and m["categories"] == ["Eski", "Bağlantı"] and m["name"] == "dogus.com.tr"
    done = next(s for s in d["steps"] if s["kind"] == "done")
    assert done["added"] == 1 and done["catalog"] == 3
    # read again, it is a page run still
    async def again():
        jd, _ = await mf.start_job(fake, mid, reuse=d["_id"])
        return await _until_done(fake, jd["_id"])()
    d2 = run(again())
    assert d2["kind"] == "page" and len(run(mf.get(fake, mid))["products"]) == 3


def test_products_by_hand_survive_a_full_exploration(web, monkeypatch):
    _fake_llm(monkeypatch)
    fake = FakeDb()
    mid = _maker_with(fake, [{"id": "o1", "name": "Eski Ürün", "category": "", "description": "", "specs": {},
                              "sku": "", "url": "", "image": ""},
                             {"id": "o2", "name": "Rulman", "category": "", "description": "", "specs": {},
                              "sku": "", "url": "", "image": ""}])
    p = run(mf.add_product(fake, mid, {"name": "Özel Pim", "sku": "P-9", "specs": "Çap: 6 mm\nBoy: 40 mm\nbozuk",
                                       "url": "www.dogus.com.tr/pim"}, {"id": "a", "name": "A"}))
    assert p["source"] == "manual" and p["specs"] == {"Çap": "6 mm", "Boy": "40 mm"}
    assert p["url"] == "https://www.dogus.com.tr/pim" and p["id"].startswith("m")
    with pytest.raises(mf.Clash):
        run(mf.add_product(fake, mid, {"name": "Başka", "sku": "p-9"}))
    with pytest.raises(ValueError):
        run(mf.add_product(fake, mid, {"name": "X", "url": "javascript:alert(1)"}))
    e = run(mf.edit_product(fake, mid, "o2", {"description": "elle düzeltildi", "specs": {"Boy": "21 mm"}}))
    assert e["edited"] and e["id"] == "o2" and e["name"] == "Rulman"
    with pytest.raises(mf.Clash):
        run(mf.edit_product(fake, mid, p["id"], {"name": "Rulman", "sku": ""}))
    with pytest.raises(LookupError):
        run(mf.edit_product(fake, mid, "nope", {"name": "x"}))

    async def go():
        jd, _ = await mf.start_job(fake, mid)
        return await _until_done(fake, jd["_id"])()
    assert run(go())["status"] == "done"
    prods = {x["name"]: x for x in run(mf.get(fake, mid))["products"]}
    assert set(prods) == {"Özel Pim", "Rulman", "Menteşe", "Kelepçe"}        # the old found one went; by hand stayed
    assert prods["Rulman"]["description"] == "elle düzeltildi" and prods["Rulman"]["url"]   # the site filled the rest
    assert run(mf.delete_products(fake, mid, [p["id"], "o2", "none"])) == 2
    assert {x["name"] for x in run(mf.get(fake, mid))["products"]} == {"Menteşe", "Kelepçe"}


def test_runs_and_their_pages_go_with_a_delete(web, monkeypatch):
    _fake_llm(monkeypatch)
    fake = FakeDb()

    async def go():
        a = await mf.create(fake, "https://www.dogus.com.tr/")
        b = await mf.create(fake, "https://www.dogus.com.tr/", "B")
        ja, _ = await mf.start_job(fake, a["_id"])
        await _until_done(fake, ja["_id"])()
        jb, _ = await mf.start_job(fake, b["_id"])
        await _until_done(fake, jb["_id"])()
        jb2, _ = await mf.start_job(fake, b["_id"])
        await _until_done(fake, jb2["_id"])()
        return a["_id"], b["_id"], ja["_id"], jb["_id"], jb2["_id"]
    a, b, ja, jb, jb2 = run(go())
    pages = fake[mf.PAGES].docs
    assert {r["job"] for r in pages.values()} == {ja, jb, jb2}
    run(mf.delete_run(fake, jb))
    assert {r["job"] for r in pages.values()} == {ja, jb2}
    run(mf.remove(fake, b))
    assert {r["job"] for r in pages.values()} == {ja} and set(fake[mf.JOBS].docs) == {ja}
    # a run left by a manufacturer deleted the old way: not listed, and pruned
    run(fake[mf.JOBS].insert_one({"_id": "old", "status": "done", "manufacturer": {"id": "gone"}, "started_at": mf._now()}))
    run(fake[mf.PAGES].insert_one({"_id": "old:0", "job": "old", "manufacturer": "gone", "page": {}}))
    assert [j["_id"] for j in run(mf.jobs(fake))] == [ja]
    run(mf._prune(fake))
    assert "old" not in fake[mf.JOBS].docs and "old:0" not in pages and ja in fake[mf.JOBS].docs


def test_the_page_and_product_api(db, web, monkeypatch):  # noqa: F811
    started = []

    async def work(dbx, jid, mid, choice, reuse=None):
        started.append(jid)
    monkeypatch.setattr(mf, "_work", work)
    a, b = person(db, "a"), person(db, "b")
    r = a.post("/api/manufacturers", json={"url": "https://www.dogus.com.tr/Urunler/10/baglanti", "only": True,
                                           "follow": True, "proxy": "off"}).json()
    m, j = r["manufacturer"], r["job"]
    assert m["url"] == "https://www.dogus.com.tr/" and m["name"] == "dogus.com.tr"
    assert j["kind"] == "page" and j["only"] == ["https://www.dogus.com.tr/Urunler/10/baglanti"] and j["follow"]
    mid = m["id"]
    ws = next(iter(db[mf.COLL].docs.values()))["workspace_id"]
    run(db[mf.JOBS].update_one({"_id": j["job_id"]}, {"$set": {"status": "done"}}))
    assert a.post(f"/api/manufacturers/{mid}/read-page", json={"urls": ["http://10.0.0.1/x"]}).status_code == 400
    assert a.post(f"/api/manufacturers/{mid}/read-page", json={"urls": []}).status_code == 422
    r = a.post(f"/api/manufacturers/{mid}/read-page", json={"urls": ["www.dogus.com.tr/a", "https://www.dogus.com.tr/a"]}).json()
    assert r["kind"] == "page" and r["only"] == ["https://www.dogus.com.tr/a"] and not r["follow"]
    assert b.post(f"/api/manufacturers/{mid}/read-page", json={"urls": ["https://www.dogus.com.tr/a"]}).status_code == 404
    # products by hand
    got = a.post(f"/api/manufacturers/{mid}/products", json={"name": "Pim", "sku": "P1", "specs": "Çap: 6 mm"}).json()
    pid = got["product"]["id"]
    assert got["manufacturer"]["product_count"] == 1 and got["product"]["source"] == "manual"
    assert a.post(f"/api/manufacturers/{mid}/products", json={"name": "Pim 2", "sku": "p1"}).status_code == 409
    assert a.post(f"/api/manufacturers/{mid}/products", json={"name": ""}).status_code == 422
    assert b.post(f"/api/manufacturers/{mid}/products", json={"name": "x"}).status_code == 404
    got = a.patch(f"/api/manufacturers/{mid}/products/{pid}", json={"category": "Pimler"}).json()
    assert got["product"]["category"] == "Pimler" and got["product"]["specs"] == {"Çap": "6 mm"}
    assert a.patch(f"/api/manufacturers/{mid}/products/nope", json={"name": "x"}).status_code == 404
    a.post(f"/api/manufacturers/{mid}/products", json={"name": "Somun"})
    a.post(f"/api/manufacturers/{mid}/products", json={"name": "Vida"})
    ids = [p["id"] for p in a.get(f"/api/manufacturers/{mid}").json()["products"]]
    assert a.delete(f"/api/manufacturers/{mid}/products/{ids[0]}").json()["deleted"] == ids[0]
    assert a.delete(f"/api/manufacturers/{mid}/products/{ids[0]}").status_code == 404
    got = a.post(f"/api/manufacturers/{mid}/products/delete", json={"ids": ids[1:]}).json()
    assert got["deleted"] == 2 and got["manufacturer"]["product_count"] == 0
    # deleting the maker takes its runs
    assert a.delete(f"/api/manufacturers/{mid}").json() == {"deleted": mid}
    assert a.get("/api/manufacturers/jobs").json() == []
    assert not [d for d in db[mf.JOBS].docs.values() if d.get("workspace_id") == ws]


def test_new_routes_follow_the_tabs_rules():
    for m, p in (("POST", "/api/manufacturers/m1/read-page"), ("POST", "/api/manufacturers/m1/products"),
                 ("PATCH", "/api/manufacturers/m1/products/p1"), ("DELETE", "/api/manufacturers/m1/products/p1"),
                 ("POST", "/api/manufacturers/m1/products/delete")):
        assert not access.page_allowed(m, p), (m, p)
        assert access.allowed("reviewer", access.action(m, p)) and not access.allowed("viewer", access.action(m, p))


# ---------------------------------------------------------------- one product's page, a list page, prices

ROBO = "https://www.robo90.com/robo90-gri-eco-pla-filament-175mm-1-kg"
ROBO_NAME = "Robo90 Gri ECO PLA Filament - 1.75mm - 1 Kg"
ROBO_IMG = "https://www.robo90.com/robo90-gri-eco-pla-filament-175mm-1-kg-filament-robo90-robo90-56947-65-O.jpg"
ROBO_BIG = ROBO_IMG.replace("-O.jpg", "-B.jpg")
ROBO_LD = ('{"@context": "https://schema.org", "@type": "Product", "name": "' + ROBO_NAME + '", "sku": "R006532",'
           ' "brand": {"@type": "Brand", "name": "Robo90"}, "image": ["' + ROBO_IMG + '"], "url": "' + ROBO + '",'
           ' "offers": {"@type": "Offer", "price": "362.60", "priceCurrency": "TRY",'
           ' "availability": "https://schema.org/InStock"}}')


def robo_page(ld: bool = True) -> str:
    """robo90.com's product page, as it is built: the menu, the product (its
    picture lazy-loaded, its zoom a link), its price without VAT and with,
    then a block of related products with their own prices and pictures."""
    related = "".join(
        f"<div class='p'><a href='/{k}'><img src='/img/blank.gif' data-src='/{k}-O.jpg' alt='{n}'></a>"
        f"<a href='/{k}'>{n}</a><span>{a} TL</span><button>Ekle</button></div>"
        for k, n, a in (("nanelab-hyper-pla-cyan", "Nanelab Hyper PLA Cyan Filament - 1.75mm - 1Kg", "646,80"),
                        ("robo90-mavi-abs", "Robo90 Mavi ABS Filament - 1.75mm - 1 Kg", "558,60"),
                        ("creality-hyper-pla", "Creality Hyper PLA RFID Kırmızı Filament 1.75mm 1 Kg", "882,00")))
    return ("<html><head><title>" + ROBO_NAME + " Satın Al | Robo90</title>"
            + (f"<script type='application/ld+json'>{ROBO_LD}</script>" if ld else "")
            + f"<meta property='og:image' content='{ROBO_BIG}'><meta property='og:site_name' content='Robo90'>"
            "</head><body><div>1500 TL ve Üzeri Alışverişlerde Kargo Ücretsiz</div>"
            "<nav><a href='/filament'>Filament</a></nav>"
            f"<h1>{ROBO_NAME}</h1><div>Marka: Robo90</div><div>Ürün Kodu: <b>R006532</b></div>"
            f"<a href='{ROBO_BIG}' class='zoom'><img src='/img/loading.gif' data-src='{ROBO_IMG}'"
            f" srcset='/small-1.jpg 200w, {ROBO_IMG} 800w' alt='{ROBO_NAME}'></a>"
            "<div><span>362,60</span> TL + KDV</div><div>%5 <span>435,12</span> TL</div><div>Stokta Var</div>"
            "<button>Sepete Ekle</button><div>Filament Çapı: 1.75mm</div>"
            f"<h3>Benzer Ürünler</h3>{related}</body></html>")


ROBO_LIST = ("<html><head><title>PLA Filament</title><script type='application/ld+json'>"
             '{"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "position": 1, "url": "/a"},'
             ' {"@type": "ListItem", "position": 2, "url": "/b"}, {"@type": "ListItem", "position": 3, "url": "/c"}]}'
             "</script></head><body><h1>PLA Filament</h1>"
             + "".join(f"<div><a href='/{k}'><img data-src='/{k}.jpg' alt='{n}'>{n}</a> {a} TL"
                       "<button>Sepete Ekle</button></div>"
                       for k, n, a in (("a", "Gri PLA", "362,60"), ("b", "Mavi PLA", "399,00"), ("c", "Siyah PLA", "1.249,90")))
             + "</body></html>")


def test_prices_are_read_the_way_pages_write_them():
    cases = {"362,60 TL + KDV": (362.6, "TRY", "excl"), "435,12 TL": (435.12, "TRY", None),
             "1.234,56 TL": (1234.56, "TRY", None), "₺1.234,56": (1234.56, "TRY", None), "12.500 TL": (12500, "TRY", None),
             "$1,234.56": (1234.56, "USD", None), "€ 12,50": (12.5, "EUR", None), "USD 12.50": (12.5, "USD", None),
             "KDV Dahil: 99,90 TL": (99.9, "TRY", "incl"), "99,90 TL (KDV dahil)": (99.9, "TRY", "incl"),
             "1.299,00 TL KDV Hariç": (1299, "TRY", "excl"), "£9.99 incl. VAT": (9.99, "GBP", "incl"),
             "$12.50 excl. VAT": (12.5, "USD", "excl")}
    for text, (a, cur, vat) in cases.items():
        p = mf.cf.parse_price(text)
        assert (p["amount"], p["currency"], p["vat"]) == (a, cur, vat), (text, p)
    assert mf.cf.parse_price("362,60", "TL", "excl") == {"amount": 362.6, "currency": "TRY", "vat": "excl", "text": "",
                                                          "at": None}
    assert mf.cf.parse_price(19.9, "usd")["currency"] == "USD"
    assert mf.cf.parse_price({"amount": "1.234,50", "currency": "₺", "vat": "dahil"})["amount"] == 1234.5
    for bad in ("", None, "fiyat sorunuz", "0 TL", "abc"):
        assert mf.cf.parse_price(bad) is None, bad
    assert mf.cf.parse_stock("Stokta Var") == ("in", None, "Stokta Var")
    assert mf.cf.parse_stock("Son 3 adet")[:2] == ("in", 3)
    assert mf.cf.parse_stock("https://schema.org/OutOfStock")[0] == "out"
    assert mf.cf.parse_stock("Tükendi")[0] == "out" and mf.cf.parse_stock(0) == ("out", 0, "")
    assert mf.cf.stock_in("Stokta Yok\nStokta Var") == {}                  # a template with both: not said


def test_a_product_page_is_its_one_product():
    page = mf.parse_page(robo_page(), ROBO)
    f = page["facts"]
    assert f["kind"] == "product" and f["why"] == "JSON-LD Product"
    m = f["main"]
    assert m["name"] == ROBO_NAME and m["sku"] == "R006532" and m["stock"] == "in"
    assert (m["price"]["amount"], m["price"]["currency"], m["price"]["vat"], m["price"]["gross"]) == (362.6, "TRY", "excl", 435.12)
    assert m["image"] == ROBO_IMG and ROBO_BIG in m["images"]
    assert (ROBO_IMG, ROBO_NAME) in page["images"]                          # the lazy picture, not its placeholder
    assert not [u for u, _ in page["images"] if "blank.gif" in u or "loading.gif" in u]
    assert "https://www.robo90.com/nanelab-hyper-pla-cyan-O.jpg" in [u for u, _ in page["images"]]
    # the model is told what the page is, and does not see the related products
    block = mf.page_block({**page, "url": ROBO}, set(), first=True)
    assert "Kind: the page of ONE product" in block and "R006532" in block and "362.60 TRY + VAT" in block
    assert "Nanelab" not in block and "Mavi ABS" not in block and "Benzer Ürünler" not in block
    # without the JSON-LD, the text says the same
    bare = mf.parse_page(robo_page(ld=False), ROBO)["facts"]
    assert bare["kind"] == "product" and bare["main"]["sku"] == "R006532" and bare["main"]["stock"] == "in"
    assert bare["main"]["price"]["amount"] == 362.6 and bare["main"]["price"]["vat"] == "excl"
    assert bare["main"]["image"] == ROBO_BIG                                # og:image first
    # a list page is a list
    lf = mf.parse_page(ROBO_LIST, "https://www.robo90.com/pla")["facts"]
    assert lf["kind"] == "list" and lf["items"] == 3 and lf["main"] is None


def test_a_page_jina_read_is_read_the_same_way():
    md = ("[Anasayfa](https://www.robo90.com/)\n1500 TL ve Üzeri Kargo Ücretsiz\n# " + ROBO_NAME + "\nMarka: Robo90\n"
          "Ürün Kodu: R006532\n362,60 TL + KDV\n435,12 TL\nSon 3 adet\n## Benzer Ürünler\nNanelab Hyper PLA\n646,80 TL\n")
    page = {"url": ROBO, "title": ROBO_NAME, "text": md, "links": [(ROBO_BIG, "")],
            "images": [(ROBO_IMG, ROBO_NAME), ("https://www.robo90.com/nanelab-O.jpg", "Nanelab Hyper PLA")]}
    f = mf.facts_of(page)
    assert f["kind"] == "product"
    m = f["main"]
    assert m["sku"] == "R006532" and m["price"]["amount"] == 362.6 and m["stock"] == "in" and m["qty"] == 3
    assert m["image"] == ROBO_IMG and ROBO_BIG in m["images"] and "https://www.robo90.com/nanelab-O.jpg" not in m["images"]
    assert "Nanelab" not in mf.page_block(page, set(), first=True)


def _robo_web(web, monkeypatch, pages):
    monkeypatch.setitem(PUBLIC, "www.robo90.com", ["93.184.216.40"])

    def handle(req):
        web["seen"].append(str(req.url))
        body = pages.get(req.url.path)
        if body is None:
            return httpx.Response(404, text="nope")
        return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})
    web["site"] = handle


def _robo_llm(monkeypatch, price=None, seen=None):
    """A model that does what went wrong: writes down the related products of a product's page too."""
    async def complete(messages, **kw):
        if seen is not None:
            seen.append(messages[1]["content"])
        rows = [{"name": ROBO_NAME, "sku": "R006532", "category": "Filament", "url": ROBO,
                 "specs": {"Filament Çapı": "1.75mm"}, **({"price": price} if price else {})},
                {"name": "Nanelab Hyper PLA Cyan Filament - 1.75mm - 1Kg", "category": "Filament",
                 "image": "https://www.robo90.com/nanelab-hyper-pla-cyan-O.jpg", "price": "646,80 TL"},
                {"name": "Robo90 Mavi ABS Filament - 1.75mm - 1 Kg", "category": "Filament", "url": ROBO}]
        import json as _j
        text = _j.dumps({"company": {"name": "Robo90", "description": "3D yazıcı malzemeleri.",
                                     "categories": ["Filament"]}, "products": rows})
        return {"choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                "provider": "commandcode", "model": "m"}

    async def nothing(db, **kw):
        pass
    monkeypatch.setattr(llm, "complete", complete)
    monkeypatch.setattr(llm, "key", lambda p: "k")
    monkeypatch.setattr(llm, "record", nothing)
    monkeypatch.setattr(llm, "route", lambda job: ("commandcode", "m"))


def test_reading_one_product_page_adds_that_product_with_its_price_and_picture(web, monkeypatch):
    path = "/robo90-gri-eco-pla-filament-175mm-1-kg"
    _robo_web(web, monkeypatch, {path: robo_page(), "/robots.txt": "User-agent: *\nAllow: /\n"})
    seen = []
    _robo_llm(monkeypatch, seen=seen)
    fake = FakeDb()
    doc = run(mf.create(fake, "https://www.robo90.com/", by={"id": "a", "name": "A"}))

    async def go(**kw):
        jd, _ = await mf.start_job(fake, doc["_id"], **kw)
        return await _until_done(fake, jd["_id"])()
    d = run(go(only=[ROBO]))
    assert d["status"] == "done", d.get("error")
    assert "Nanelab" not in seen[0] and "Kind: the page of ONE product" in seen[0]
    prods = run(mf.get(fake, doc["_id"]))["products"]
    assert len(prods) == 1                                             # the related products are left out
    p = prods[0]
    assert p["name"] == ROBO_NAME and p["sku"] == "R006532" and p["url"] == ROBO
    assert (p["price"]["amount"], p["price"]["currency"], p["price"]["vat"]) == (362.6, "TRY", "excl")
    assert p["price"]["at"] == p["read_at"] and p["added_at"] and p["stock"] == "in"
    assert p["image"] == ROBO_IMG and ROBO_BIG in p["images"]
    assert p["seller"] == {"domain": "robo90.com", "host": "robo90.com", "name": "Robo90"}
    assert p["specs"]["Marka"] == "Robo90" and len(p["history"]) == 1 and p["history"][0]["amount"] == 362.6
    assert "price 362.60 TRY + VAT" in mf.product_line(p) and "in stock" in mf.product_line(p)
    # the price changes on the site: read again, the product is brought up to date and remembers
    _robo_web(web, monkeypatch, {path: robo_page().replace("362.60", "399.00").replace("362,60", "399,00")
                                 .replace("435,12", "478,80").replace("Stokta Var", "Son 2 adet"),
                                 "/robots.txt": "User-agent: *\nAllow: /\n"})
    d2 = run(go(only=[ROBO]))
    p2 = run(mf.get(fake, doc["_id"]))["products"]
    assert d2["status"] == "done" and len(p2) == 1 and p2[0]["id"] == p["id"] and p2[0]["added_at"] == p["added_at"]
    assert p2[0]["price"]["amount"] == 399.0 and p2[0]["stock_qty"] == 2
    assert [h["amount"] for h in p2[0]["history"]] == [362.6, 399.0] and p2[0]["history"][1]["qty"] == 2
    # the same again: no new row, the last one seen again
    run(go(reuse=d2["_id"]))
    p3 = run(mf.get(fake, doc["_id"]))["products"][0]
    assert len(p3["history"]) == 2 and p3["history"][1]["seen"]
    # a run that also read a list page keeps what the model found there
    lst = {**mf.parse_page(ROBO_LIST, "https://www.robo90.com/pla"), "url": "https://www.robo90.com/pla"}
    prod = {**mf.parse_page(robo_page(), ROBO), "url": ROBO}
    got = mf.by_page({"only": True, "pages": [prod, lst]}, [{"name": "Mavi PLA", "sku": "", "url": ""}])
    assert [x["name"] for x in got] == ["Mavi PLA", ROBO_NAME]          # ...and the product page's own, from the page
    assert mf.by_page({"only": True, "pages": [prod]}, [{"name": "Mavi PLA", "sku": "", "url": ""}])[0]["name"] == ROBO_NAME


def test_kept_pages_read_again_with_the_new_reading(web, monkeypatch):
    """A page kept by a run before pages were read for their products (no
    `facts`): read again, it is one product with its price and picture."""
    _robo_llm(monkeypatch)
    fake = FakeDb()
    doc = run(mf.create(fake, "https://www.robo90.com/", by={"id": "a", "name": "A"}))
    old = mf.parse_page(robo_page(ld=False), ROBO)
    page = {"url": ROBO, "title": old["title"], "text": old["text"], "links": old["links"],
            "images": old["images"], "depth": 0}
    run(fake[mf.JOBS].insert_one({"_id": "j0", "status": "done", "kind": "page", "only": [ROBO], "follow": False,
                                  "manufacturer": {"id": doc["_id"]}, "kept_pages": 1, "started_at": mf._now()}))
    run(fake[mf.PAGES].insert_one({"_id": "j0:0", "job": "j0", "manufacturer": doc["_id"], "n": 0,
                                   "domain": "robo90.com", "page": page}))

    async def go():
        jd, _ = await mf.start_job(fake, doc["_id"], reuse="j0")
        return await _until_done(fake, jd["_id"])()
    assert run(go())["status"] == "done"
    prods = run(mf.get(fake, doc["_id"]))["products"]
    assert [p["sku"] for p in prods] == ["R006532"] and prods[0]["price"]["amount"] == 362.6
    assert prods[0]["image"] == ROBO_BIG and prods[0]["stock"] == "in"


def test_a_list_page_gives_every_product(web, monkeypatch):
    _robo_web(web, monkeypatch, {"/pla": ROBO_LIST, "/robots.txt": "User-agent: *\nAllow: /\n"})

    async def complete(messages, **kw):
        rows = [{"name": n, "url": f"https://www.robo90.com/{k}", "image": f"https://www.robo90.com/{k}.jpg",
                 "price": {"amount": a, "currency": "TRY", "text": f"{a} TL"}}
                for k, n, a in (("a", "Gri PLA", 362.6), ("b", "Mavi PLA", 399), ("c", "Siyah PLA", 1249.9))]
        import json as _j
        return {"choices": [{"message": {"content": _j.dumps({"company": {}, "products": rows})}}],
                "usage": {}, "provider": "commandcode", "model": "m"}
    _robo_llm(monkeypatch)
    monkeypatch.setattr(llm, "complete", complete)
    fake = FakeDb()
    doc = run(mf.create(fake, "https://www.robo90.com/", by={"id": "a", "name": "A"}))

    async def go():
        jd, _ = await mf.start_job(fake, doc["_id"], only=["https://www.robo90.com/pla"])
        return await _until_done(fake, jd["_id"])()
    assert run(go())["status"] == "done"
    prods = run(mf.get(fake, doc["_id"]))["products"]
    assert [p["name"] for p in prods] == ["Gri PLA", "Mavi PLA", "Siyah PLA"]
    assert [p["price"]["amount"] for p in prods] == [362.6, 399, 1249.9] and all(p["image"] for p in prods)
    assert {p["seller"]["domain"] for p in prods} == {"robo90.com"}


def test_prices_by_hand_and_the_grid(db, web, monkeypatch):  # noqa: F811
    monkeypatch.setattr(mf, "_work", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setitem(PUBLIC, "www.robo90.com", ["93.184.216.40"])
    a = person(db, "a")
    mid = a.post("/api/manufacturers", json={"url": "https://www.robo90.com/", "explore": False}).json()["manufacturer"]["id"]
    other = a.post("/api/manufacturers", json={"url": "https://www.dogus.com.tr/", "explore": False}).json()["manufacturer"]["id"]
    got = a.post(f"/api/manufacturers/{mid}/products", json={
        "name": "Gri PLA", "category": "Filament", "price": "1.234,50", "currency": "TRY", "vat": "excl",
        "stock": "in", "stock_qty": 4, "url": "https://www.robo90.com/gri"}).json()["product"]
    assert (got["price"]["amount"], got["price"]["currency"], got["price"]["vat"]) == (1234.5, "TRY", "excl")
    assert got["price"]["at"] and got["stock"] == "in" and got["stock_qty"] == 4 and len(got["history"]) == 1
    assert got["seller"]["domain"] == "robo90.com"
    assert a.post(f"/api/manufacturers/{mid}/products", json={"name": "X", "price": "sorunuz"}).status_code == 400
    a.post(f"/api/manufacturers/{mid}/products", json={"name": "Mavi PLA", "category": "Filament", "price": 399,
                                                       "currency": "TRY", "stock": "out"})
    a.post(f"/api/manufacturers/{other}/products", json={"name": "Menteşe", "category": "Bağlantı", "price": "$12.50"})
    a.post(f"/api/manufacturers/{other}/products", json={"name": "Eski PLA"})                     # an old one: no price
    # changed by hand: the price and the stock, remembered
    e = a.patch(f"/api/manufacturers/{mid}/products/{got['id']}", json={"price": "1.199,00", "stock": "out"}).json()["product"]
    assert e["price"]["amount"] == 1199 and e["price"]["currency"] == "TRY" and e["price"]["vat"] == "excl"
    assert e["stock"] == "out" and "stock_qty" not in e and [h["amount"] for h in e["history"]] == [1234.5, 1199]
    e = a.patch(f"/api/manufacturers/{mid}/products/{got['id']}", json={"category": "PLA"}).json()["product"]
    assert len(e["history"]) == 2 and e["price"]["amount"] == 1199                  # nothing said of the price: kept
    men = a.get(f"/api/manufacturers/{other}").json()["products"][0]
    assert men["name"] == "Menteşe" and men["price"]["currency"] == "USD"
    assert "price" not in a.patch(f"/api/manufacturers/{other}/products/{men['id']}", json={"price": ""}).json()["product"]
    a.patch(f"/api/manufacturers/{other}/products/{men['id']}", json={"price": "12.50", "currency": "USD"})
    # the grid: every maker's products, filtered and sorted
    g = a.get("/api/manufacturers/products?q=pla&sort=price_asc").json()
    assert [x["name"] for x in g["items"]] == ["Mavi PLA", "Gri PLA", "Eski PLA"] and g["total"] == 3 and g["all"] == 4
    assert g["items"][0]["maker"]["id"] == mid and g["items"][2]["seller"]["domain"] == "dogus.com.tr"
    assert [x["name"] for x in a.get("/api/manufacturers/products?sort=price_desc").json()["items"]][-1] in ("Eski PLA", "Menteşe")
    assert [x["name"] for x in a.get("/api/manufacturers/products?min=300&max=1000").json()["items"]] == ["Mavi PLA"]
    assert [x["name"] for x in a.get("/api/manufacturers/products?stock=out&q=pla&sort=name").json()["items"]] == ["Gri PLA", "Mavi PLA"]
    assert [x["name"] for x in a.get(f"/api/manufacturers/products?maker={other}&sort=name").json()["items"]] == ["Eski PLA", "Menteşe"]
    assert [x["name"] for x in a.get("/api/manufacturers/products?cat=Bağlantı").json()["items"]] == ["Menteşe"]
    assert a.get("/api/manufacturers/products?seller=robo90.com").json()["total"] == 2
    g = a.get("/api/manufacturers/products?size=2&page=2&sort=name").json()
    assert g["page"] == 2 and len(g["items"]) == 2 and g["total"] == 4
    assert ["Filament", 1] in g["categories"] and g["price"]["min"] == 12.5 and set(g["price"]["currencies"]) == {"TRY", "USD"}
    assert {m["id"] for m in g["makers"]} == {mid, other, "own"}     # and Own items, the overview's too


ILERI = """<html><head><title>SFU 1204 Mil - ileri3d</title></head><body>
<h1>SFU 1204 Tornalanmış Mil ve Vidalı Somun-350mm</h1>
<div><h6 class="fiyat-son">2.539,81 TL<span class="kdv-yaz">KDV Dahil</span></h6></div>
<div><span>287,85</span> TL'den başlayan taksitlerle!</div>
<a class="btn" href="/sepet">Sepete Ekle</a>
<p>SFU1204 vidalı mil ve bilyeli somun seti, 350 mm.</p>
<h3>İlgili Ürünler</h3>
<div><span>Tükendi</span><a>SFU 1204 Tornalanmış Mil ve Vidalı Somun-250mm</a> 2.279,31 TL</div>
<div><span>Tükendi</span><a>SFU 1204 Tornalanmış Mil ve Vidalı Somun-450mm</a> 2.800,30 TL</div>
</body></html>"""


def test_a_price_run_into_kdv_an_instalment_and_related_products_stock():
    # "2.539,81 TLKDV Dahil" (two spans, no space) is the price; the instalment
    # under it is not; the related products' "Tükendi" is theirs, and an
    # add-to-cart in the product's own part says it can be bought.
    main = mf.parse_page(ILERI, "https://www.ileri3d.com/urun/sfu-1204-350mm")["facts"]["main"]
    assert main["price"]["amount"] == 2539.81 and main["price"]["vat"] == "incl"
    assert main["stock"] == "in"
    assert mf.cf.find_prices("287,85\nTL'den başlayan taksitlerle")[0]["instalment"]
    assert not mf.cf.find_prices("2.539,81 TL KDV Dahil")[0]["instalment"]
    assert mf.cf.find_prices("Fiyat 1.200 TLDEN") == []
