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


def _crawl(start="https://www.dogus.com.tr/", choice="off", cap=mf.MAX_PAGES):
    track = mf.Tracker()

    async def go():
        f = mf.Fetcher(choice, "s1" if choice != "off" else None)
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

def _proxy_on(monkeypatch, mode="fallback"):
    monkeypatch.setattr(netproxy, "_conf", {"enabled": True, "mode": mode, "host": "proxy.test", "port": 8000})
    monkeypatch.setattr(netproxy, "log", lambda row: None)


def test_fallback_goes_through_the_proxy_once_refused(web, monkeypatch):
    _proxy_on(monkeypatch)
    blocked = site(web["seen"], {"/Urunler/10/baglanti": httpx.Response(429, text="slow down")})
    web["site"] = blocked
    web["proxy_site"] = site([])
    got, track, f = _crawl(choice="fallback")
    rows = [r for r in track.meta["pages"] if r.get("fallback")]
    assert len(rows) == 1 and rows[0]["via"] == "proxy" and rows[0]["status"] == 200
    assert f.stats["direct"]["refused"] == 1 and f.stats["proxy"]["requests"] >= 1
    # after the refusal the run stays on the proxy
    assert web["proxied"] and all(r["via"] == "proxy" for r in track.meta["pages"][track.meta["pages"].index(rows[0]):])
    assert f.switched_at


def test_always_and_off(web, monkeypatch):
    _proxy_on(monkeypatch, "always")
    _, track, f = _crawl(choice="always")
    assert f.stats["direct"]["requests"] == 0 and all(r["via"] == "proxy" for r in track.meta["pages"])
    web["proxied"].clear()
    _, track, f = _crawl(choice="off")
    assert not web["proxied"] and f.stats["proxy"]["requests"] == 0
    monkeypatch.setattr(netproxy, "_conf", {})
    with pytest.raises(mf.Refused, match="not set up"):
        mf.Fetcher("always", "s")
    st = mf.proxy_state()
    assert st["configured"] is False and st["default"] == "off"


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
    assert d["status"] == "done" and d["products_found"] == 3 and d["proxy"] == "off"
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
    r = a.post("/api/manufacturers", json={"url": "https://www.dogus.com.tr/", "proxy": "off"}).json()
    jid, mid = r["job"]["job_id"], r["manufacturer"]["id"]
    assert r["job"]["status"] == "queued" and r["manufacturer"]["proxy"] == "off"
    # The TestClient's loop ran the task as far as it got; what the server wrote is what a reload reads.
    first = a.get(f"/api/manufacturers/jobs/{jid}").json()
    again = a.get(f"/api/manufacturers/jobs/{jid}").json()
    assert first["id"] == again["id"] == jid and first["manufacturer"]["id"] == mid
    assert [s["id"] for s in again["steps"]][:len(first["steps"])] == [s["id"] for s in first["steps"]]
    listed = a.get("/api/manufacturers").json()
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
    listed = a.get("/api/manufacturers").json()
    assert [x["id"] for x in listed] == [mid] and listed[0]["product_count"] == 2 and "products" not in listed[0]
    assert a.get("/api/manufacturers?q=injection").json()[0]["id"] == mid
    assert [h["product"]["id"] for h in a.get("/api/manufacturers/search?q=mentese").json()] == ["p1"]
    assert [h["product"]["id"] for h in a.get("/api/manufacturers/search?category=rulman").json()] == ["p2"]
    assert len(a.get(f"/api/manufacturers/{mid}").json()["products"]) == 2
    # another space sees none of it
    assert b.get("/api/manufacturers").json() == [] and b.get(f"/api/manufacturers/{mid}").status_code == 404
    assert b.post(f"/api/manufacturers/{mid}/explore", json={}).status_code == 404
    assert b.get("/api/manufacturers/search?q=mentese").json() == []
    # exploring: the proxy only when it is set up
    monkeypatch.setattr(netproxy, "_conf", {})
    assert a.post(f"/api/manufacturers/{mid}/explore", json={"proxy": "always"}).status_code == 400
    r = a.post(f"/api/manufacturers/{mid}/explore", json={"proxy": "off"}).json()
    assert r["started"] and r["proxy"] == "off" and started == [(mid, "off")]
    jid = r["job_id"]
    assert a.get("/api/manufacturers/proxy").json()["configured"] is False
    import types
    monkeypatch.setitem(mf._TASKS, jid, types.SimpleNamespace(done=lambda: False, cancel=lambda: None))
    assert [j["id"] for j in a.get("/api/manufacturers/jobs").json()] == [jid]
    assert b.get(f"/api/manufacturers/jobs/{jid}").status_code == 404
    assert a.delete(f"/api/manufacturers/jobs/{jid}").status_code == 409
    assert a.post(f"/api/manufacturers/jobs/{jid}/cancel").json()["status"] == "cancelled"
    # a file to send, made a manufacturer elsewhere
    f = a.get(f"/api/manufacturers/{mid}/export").json()
    assert f["format"] == "redline-manufacturer" and len(f["products"]) == 2
    got = b.post("/api/manufacturers/import", json=f).json()
    assert got["name"] == "Doğuş" and got["product_count"] == 2 and got["proxy"] == "off"
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
