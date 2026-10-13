"""Wrong reads are never taken quietly (backend/catalog_facts.py, backend/manufacturers.py).

A price or a stock read from a seller's page says where it came from - the
structured data, the microdata, the meta tags or the page's text, with the
words around it - and carries a doubt when something about it looks wrong:
another price in the product's own part about N times it (an instalment),
the structured data and the text disagreeing, a jump of more than half
since the last reading, "Tükendi" beside "Sepete Ekle", out of stock with
some left, a currency missing or odd. A person who says "Wrong" gives the
right value: it is kept through the next reads while the page says what it
said, the page is kept as a test case, and "Re-read all products" reads
every page again, says what changed and keeps the corrections."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from backend import manufacturers as mf
from backend import catalog_facts as cf
from test_manufacturers import PUBLIC, web  # noqa: F401  (the fixture)
from test_telegram import FakeDb
from test_users_admin import db, person  # noqa: F401  (the fixture)


def run(c):
    return asyncio.run(c)


URL = "https://www.ileri3d.com/urun/sfu-1204-350mm"
NAME = "SFU 1204 Tornalanmış Mil ve Vidalı Somun-350mm"


def page(price: str = '<h6 class="fiyat-son">2.539,81 TL<span class="kdv-yaz">KDV Dahil</span></h6>',
         stock: str = "", ld: str = "", extra: str = "") -> str:
    """ileri3d.com's product page: its price, an instalment line, an add-to-cart, then related products."""
    return (f"<html><head><title>SFU 1204 Mil - ileri3d</title>{ld}</head><body><h1>{NAME}</h1>"
            f"<div>{price}</div>{extra}<div><span>287,85</span> TL'den başlayan taksitlerle!</div>{stock}"
            "<a class='btn' href='/sepet'>Sepete Ekle</a><p>SFU1204 vidalı mil ve bilyeli somun seti, 350 mm.</p>"
            "<h3>İlgili Ürünler</h3><div><span>Tükendi</span><a>SFU 1204 Somun-250mm</a> 2.279,31 TL</div></body></html>")


def main_of(html: str, url: str = URL) -> dict:
    return mf.parse_page(html, url)["facts"]["main"]


def kinds(d: dict | None) -> list[str]:
    return [x["k"] for x in (d or {}).get("doubt") or []]


def ld(price: str, cur: str = "TRY", avail: str = "InStock") -> str:
    node = {"@context": "https://schema.org", "@type": "Product", "name": NAME, "url": URL,
            "offers": {"@type": "Offer", "price": price, "priceCurrency": cur, "availability": f"https://schema.org/{avail}"}}
    return f"<script type='application/ld+json'>{json.dumps(node)}</script>"


# ---------------------------------------------------------------- where a value came from

def test_a_value_says_where_it_was_read_and_the_words_around_it():
    m = main_of(page())
    assert m["price"]["amount"] == 2539.81 and m["price"]["source"] == "text"
    assert "2.539,81 TL" in m["price"]["snippet"] and len(m["price"]["snippet"]) < 140 and not kinds(m["price"])
    assert m["stock"] == "in" and m["stock_read"]["source"] == "text" and "Sepete Ekle" in m["stock_read"]["snippet"]
    m = main_of(page(ld=ld("2539.81")))
    assert m["price"]["source"] == "ld" and '"price": "2539.81"' in m["price"]["snippet"] and not kinds(m["price"])
    assert m["stock_read"]["source"] == "ld" and "InStock" in m["stock_read"]["snippet"]
    meta = "<meta property='product:price:amount' content='2539.81'><meta property='product:price:currency' content='TRY'>"
    m = main_of(page(ld=meta))
    assert m["price"]["source"] == "meta" and "2539.81" in m["price"]["snippet"]


# ---------------------------------------------------------------- the checks, one by one

def test_a_price_far_below_another_one_reads_like_an_instalment():
    # the instalment written in a way the reader does not know, before the price
    m = main_of(page(price="<div>9 ay boyunca 287,85 TL</div><div>2.539,81 TL KDV Dahil</div>"))
    assert m["price"]["amount"] == 287.85
    d = m["price"]["doubt"][0]
    assert d["k"] == "instalment" and d["other"] == 2539.81 and d["n"] == 9
    # far lower with no N that makes it: "lower"
    m = main_of(page(price="<div>5,00 TL</div><div>2.539,81 TL</div>"))
    assert kinds(m["price"]) == ["lower"]
    # shipping from, a price with VAT, the list price: not another price of it
    m = main_of(page(price="<div>362,60 TL + KDV</div><div>435,12 TL</div><div>1500 TL ve Üzeri Kargo Ücretsiz</div>"))
    assert m["price"]["amount"] == 362.6 and not kinds(m["price"])


def test_structured_data_far_from_the_text_is_doubted():
    m = main_of(page(ld=ld("287.85")))
    assert m["price"]["amount"] == 287.85 and m["price"]["source"] == "ld"
    assert "mismatch" in kinds(m["price"]) and "instalment" in kinds(m["price"])
    mis = next(d for d in m["price"]["doubt"] if d["k"] == "mismatch")
    assert mis["where"] == "text" and mis["other"] == 2539.81
    # the same price without VAT in the data and with it on the page: not a mismatch
    assert not kinds(main_of(page(ld=ld("2116.51")))["price"])
    # the JSON-LD and the meta tags disagreeing
    meta = "<meta property='product:price:amount' content='1999'><meta property='product:price:currency' content='TRY'>"
    m = main_of(page(price="", ld=ld("2539.81") + meta))
    assert kinds(m["price"]) == ["mismatch"] and m["price"]["doubt"][0]["where"] == "meta"


def test_a_currency_missing_guessed_or_odd_is_doubted():
    assert kinds(main_of(page(ld=ld("2539.81", cur="XYZ")))["price"]) == ["odd_currency"]
    m = main_of(page(price="", ld=ld("2539.81", cur="")).replace("TL", "").replace("KDV", ""))
    assert m["price"]["currency"] == "" and kinds(m["price"]) == ["no_currency"]
    m = main_of(page(price="", ld=ld("2539.81", cur="")))
    assert m["price"]["currency"] == "TRY" and kinds(m["price"]) == ["currency_guessed"]


def test_stock_said_both_ways_or_against_its_count_is_doubted():
    m = main_of(page(stock="<div>Tükendi</div>"))
    assert m["stock"] == "out" and kinds(m["stock_read"]) == ["both_words"]
    assert m["stock_read"]["doubt"][0] == {"k": "both_words", "out": "Tükendi", "in": "Sepete Ekle"}
    m = main_of(page(ld=ld("2539.81", avail="OutOfStock"), stock="<div>Stok: 5 adet</div>"))
    assert m["stock"] == "out" and m["qty"] == 5
    assert set(kinds(m["stock_read"])) == {"qty_conflict", "stock_mismatch"}
    m = main_of(page(ld=ld("2539.81", avail="InStock"), stock="<div>Stokta yok</div>"))
    assert "stock_mismatch" in kinds(m["stock_read"])
    # the related products' "Tükendi" is not this product's: no doubt
    assert not kinds(main_of(page())["stock_read"])


def test_notify_me_when_in_stock_is_out_of_stock_and_purchased_together_is_other_products():
    # robotistan.com: "Out Of Stock / Notify me when its in stock", then "PURCHASED TOGETHER" with other products
    html = (f"<html><head><title>ADS1115</title></head><body><h1>ADS1115 16-Bit ADC</h1><div>Fiyat: 112.67 TL + VAT</div>"
            "<div>Out Of Stock</div><button>Notify me when its in stock</button><h3>PURCHASED TOGETHER</h3>"
            "<div>1/4W 330R Resistor 0.24 TL</div><div>In stock</div></body></html>")
    m = main_of(html, "https://www.robotistan.com/ads1115")
    assert m["stock"] == "out" and not kinds(m["stock_read"]) and m["price"]["amount"] == 112.67
    assert cf.parse_stock("Notify me when it's back in stock")[0] == "out"


def test_a_jump_of_more_than_half_since_the_last_reading_is_doubted():
    old = mf.clean_product({"name": NAME, "url": URL, "price": {"amount": 2539.81, "currency": "TRY", "at": "t0"}})
    old["history"] = mf.remember([], mf._reading(old, "t0"))
    got, _ = mf.fold_in([old], [mf.clean_product({"name": NAME, "url": URL, "price": "287,85 TL"})], "t1")
    assert kinds(got[0]["price"]) == ["jump"] and got[0]["price"]["doubt"][0]["was"] == 2539.81
    assert got[0]["price"]["doubt"][0]["pct"] == -89
    got, _ = mf.fold_in(got, [mf.clean_product({"name": NAME, "url": URL, "price": "2.600 TL"})], "t2")
    assert kinds(got[0]["price"]) == ["jump"]                     # back up: a jump again
    got, _ = mf.fold_in(got, [mf.clean_product({"name": NAME, "url": URL, "price": "2.700 TL"})], "t3")
    assert not kinds(got[0]["price"])                             # a small move is no doubt


def test_the_model_reading_and_a_typed_value_say_so():
    p = mf.stamp([mf.clean_product({"name": "Gri PLA", "price": "362,60 TL", "stock": "Son 3 adet"})], "t")[0]
    assert p["price"]["source"] == "model" and p["price"]["snippet"] == "362,60 TL"
    assert p["stock_read"]["source"] == "model"
    # what is kept goes through the cleaning: the doubt, the source, the words
    kept = mf.clean_product({"name": "x", "price": {"amount": 5, "currency": "TRY", "source": "text", "snippet": "a" * 400,
                                                    "doubt": [{"k": "lower", "other": 99, "junk": {"a": 1}}]},
                             "stock": "in", "stock_read": {"source": "nowhere", "doubt": "no"}})
    assert kept["price"]["source"] == "text" and len(kept["price"]["snippet"]) == 200
    assert kept["price"]["doubt"][0]["k"] == "lower" and isinstance(kept["price"]["doubt"][0]["junk"], str)
    assert "stock_read" not in kept


# ---------------------------------------------------------------- "Wrong", and what holds it

def _fake_maker(products):
    fake = FakeDb()
    doc = run(mf.create(fake, "https://www.ileri3d.com/", by={"id": "a", "name": "A"}))
    run(fake[mf.COLL].update_one({"_id": doc["_id"]}, {"$set": {"products": products}}))
    return fake, doc["_id"]


def _wrong_product():
    """ileri3d's product as it was read before the reader was fixed: the instalment as the price, out of stock."""
    p = mf.clean_product({"name": NAME, "url": URL, "price": {"amount": 287.85, "currency": "TRY", "source": "text",
                                                              "snippet": "287,85 TL'den başlayan taksitlerle"},
                          "stock": "out", "stock_text": "Tükendi", "stock_read": {"source": "text", "snippet": "Tükendi"}})
    return {**p, "id": "p1", "added_at": "t0", "read_at": "t0"}


def test_a_correction_holds_while_the_page_says_what_it_said():
    fake, mid = _fake_maker([_wrong_product()])
    p, case = run(mf.correct_product(fake, mid, "p1", "price", {"amount": "2.539,81", "currency": "TRY", "vat": "incl"},
                                     {"id": "a", "name": "Ayşe"}, keep=False))
    assert case is None
    pr = p["price"]
    assert (pr["amount"], pr["currency"], pr["vat"], pr["manual"], pr["source"]) == (2539.81, "TRY", "incl", True, "hand")
    assert pr["by"] == {"id": "a", "name": "Ayşe"} and pr["page_was"] == {"amount": 287.85, "currency": "TRY", "vat": None}
    p, _ = run(mf.correct_product(fake, mid, "p1", "stock", {"stock": "in", "qty": "4"}, {"id": "a", "name": "Ayşe"}, keep=False))
    assert p["stock"] == "in" and p["stock_qty"] == 4 and "stock_text" not in p
    assert p["stock_read"]["manual"] and p["stock_read"]["page_was"] == {"stock": "out", "qty": None}
    assert mf.by_hand(p) and [(h.get("amount"), h.get("stock")) for h in p["history"]] == [(2539.81, "out"), (2539.81, "in")]
    # a second correction keeps what the page said the first time
    p, _ = run(mf.correct_product(fake, mid, "p1", "price", {"amount": "2539", "currency": "TRY"}, {"id": "a"}, keep=False))
    assert p["price"]["page_was"]["amount"] == 287.85
    p, _ = run(mf.correct_product(fake, mid, "p1", "price", {"amount": "2.539,81", "vat": "incl"}, {"id": "a", "name": "Ayşe"}, keep=False))
    with pytest.raises(ValueError):
        run(mf.correct_product(fake, mid, "p1", "price", {"amount": "sorunuz"}, {"id": "a"}, keep=False))
    with pytest.raises(ValueError):
        run(mf.correct_product(fake, mid, "p1", "stock", {"stock": "out", "qty": 3}, {"id": "a"}, keep=False))
    with pytest.raises(LookupError):
        run(mf.correct_product(fake, mid, "nope", "stock", {"stock": "in"}, {"id": "a"}, keep=False))

    # the page still says the wrong thing (an old reader, a run reading it with the model): the correction holds
    same = mf.clean_product({"name": NAME, "url": URL, "price": "287,85 TL", "stock": "Tükendi"})
    got, _ = mf.fold_in([p], [same], "t1")
    q = got[0]
    assert q["price"] is not None and q["price"]["amount"] == 2539.81 and q["price"]["manual"]
    assert q["stock"] == "in" and q["stock_qty"] == 4 and q["stock_read"]["manual"] and q["read_at"] == "t1"
    # a full exploration that finds nothing keeps a corrected product
    kept, _ = mf.fold_in([q], [], "t2", replace=True)
    assert [x["id"] for x in kept] == ["p1"]
    # the page changes: its new value is taken, and says the correction is behind it
    moved = mf.clean_product({"name": NAME, "url": URL, "price": "2.799,00 TL", "stock": "Son 2 adet"})
    q2 = mf.fold_in([q], [moved], "t3")[0][0]
    assert q2["price"]["amount"] == 2799 and not q2["price"].get("manual")
    assert q2["price"]["doubt"][-1] == {"k": "changed_since_fix", "fixed": 2539.81, "was": 287.85}
    assert q2["stock_qty"] == 2 and not q2["stock_read"].get("manual")
    assert q2["stock_read"]["doubt"][-1]["k"] == "changed_since_fix" and mf.doubtful(q2)


def test_wrong_through_the_api_and_the_grid_filter(db, monkeypatch):  # noqa: F811
    monkeypatch.setattr(mf, "_work", lambda *a, **k: asyncio.sleep(0))
    kept = []

    async def keep_case(*a, **k):
        kept.append(a)
    monkeypatch.setattr(mf, "keep_case", keep_case)
    monkeypatch.setitem(PUBLIC, "www.ileri3d.com", ["93.184.216.41"])

    async def resolve(host):
        return PUBLIC[host]
    monkeypatch.setattr(mf, "_resolve", resolve)
    a, b = person(db, "a"), person(db, "b")
    mid = a.post("/api/manufacturers", json={"url": "https://www.ileri3d.com/", "explore": False}).json()["manufacturer"]["id"]
    doc = next(iter(db[mf.COLL].docs.values()))
    bad = {**_wrong_product(), "price": {"amount": 287.85, "currency": "TRY", "source": "text",
                                         "doubt": [{"k": "instalment", "other": 2539.81, "n": 9}]}}
    run(db[mf.COLL].update_one({"_id": doc["_id"]}, {"$set": {"products": [bad, {**_wrong_product(), "id": "p2", "name": "Öteki"}]}}))
    g = a.get("/api/manufacturers/products").json()
    assert g["doubtful"] == 1 and g["total"] == 2
    g = a.get("/api/manufacturers/products?check=1").json()
    assert [x["id"] for x in g["items"]] == ["p1"] and g["items"][0]["price"]["doubt"][0]["k"] == "instalment"
    r = a.post(f"/api/manufacturers/{mid}/products/p1/correct", json={"what": "price", "amount": "2.539,81", "currency": "TRY",
                                                                       "vat": "incl"})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["product"]["price"]["amount"] == 2539.81 and got["product"]["price"]["manual"]
    assert not got["product"]["price"].get("doubt")
    assert got["case"] == f"tests/fixtures/catalog_pages/ileri3d.com-p1.json" and len(kept) == 1
    assert a.get("/api/manufacturers/products?check=1").json()["total"] == 0
    assert a.post(f"/api/manufacturers/{mid}/products/p1/correct", json={"what": "name"}).status_code == 422
    assert a.post(f"/api/manufacturers/{mid}/products/p1/correct", json={"what": "price", "amount": "x"}).status_code == 400
    assert a.post(f"/api/manufacturers/{mid}/products/p9/correct", json={"what": "stock", "stock": "in"}).status_code == 404
    assert b.post(f"/api/manufacturers/{mid}/products/p1/correct", json={"what": "stock", "stock": "in"}).status_code == 404


# ---------------------------------------------------------------- the page kept as a test case

def _ileri_web(web, pages):  # noqa: F811
    PUBLIC["www.ileri3d.com"] = ["93.184.216.41"]

    def handle(req):
        web["seen"].append(str(req.url))
        body = pages.get(req.url.path)
        if body is None:
            return httpx.Response(404, text="nope")
        return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})
    web["site"] = handle


def test_a_correction_keeps_the_page_as_a_test_case(web, monkeypatch, tmp_path):  # noqa: F811
    monkeypatch.setattr(mf, "CASES", tmp_path)
    monkeypatch.setitem(PUBLIC, "www.ileri3d.com", ["93.184.216.41"])
    _ileri_web(web, {"/urun/sfu-1204-350mm": page(), "/robots.txt": "User-agent: *\nAllow: /\n"})
    fake, mid = _fake_maker([_wrong_product()])
    doc = run(mf.get(fake, mid))

    async def correct():
        got = await mf.correct_product(fake, mid, "p1", "price", {"amount": "2.539,81", "currency": "TRY", "vat": "incl"},
                                       {"id": "a", "name": "Ayşe"})
        await asyncio.gather(*mf._KEEPING)              # the case is kept in the background
        return got
    p, name = run(correct())
    assert name == "ileri3d.com-p1"
    case = json.loads((tmp_path / "ileri3d.com-p1.json").read_text())
    assert case["price"] == {"wrong": {"amount": 287.85, "currency": "TRY", "vat": None},
                             "right": {"amount": 2539.81, "currency": "TRY", "vat": "incl"}}
    assert case["html"] == "ileri3d.com-p1.html" and "2.539,81" in (tmp_path / case["html"]).read_text()
    assert case["product"]["name"] == NAME and case["by"] == "Ayşe" and case["via"] == "direct"
    assert mf.check_case(tmp_path / "ileri3d.com-p1.json") == []          # today's reader reads it right
    # the stock too, into the same case
    run(mf.keep_case(doc, p, "stock", {"stock": "out", "qty": None}, {"stock": "in", "qty": None}, {"name": "Ayşe"}))
    case = json.loads((tmp_path / "ileri3d.com-p1.json").read_text())
    assert case["price"]["right"]["amount"] == 2539.81 and case["stock"]["right"]["stock"] == "in"
    assert mf.check_case(tmp_path / "ileri3d.com-p1.json") == []
    # a reader that went wrong again is caught
    (tmp_path / case["html"]).write_text(page(price="<div>9 ay boyunca 287,85 TL</div><div>2.539,81 TL</div>",
                                              stock="<div>Tükendi</div>"))
    bad = mf.check_case(tmp_path / "ileri3d.com-p1.json")
    assert bad and bad[0].startswith("price: read 287.85") and any(x.startswith("stock:") for x in bad)
    # a page that could not be read again: kept with why, and skipped by the test
    _ileri_web(web, {"/robots.txt": "User-agent: *\nAllow: /\n"})
    run(mf.keep_case(doc, {**p, "id": "p2"}, "price", None, {"amount": 1, "currency": "TRY", "vat": None}, {"name": "A"}))
    c2 = json.loads((tmp_path / "ileri3d.com-p2.json").read_text())
    assert "HTTP 404" in c2["error"] and "html" not in c2 and mf.check_case(tmp_path / "ileri3d.com-p2.json") is None


# ---------------------------------------------------------------- "Re-read all products"

def test_reading_every_page_again_reports_and_keeps_corrections(web, monkeypatch):  # noqa: F811
    monkeypatch.setitem(PUBLIC, "www.ileri3d.com", ["93.184.216.41"])
    pages = {"/urun/sfu-1204-350mm": page(), "/urun/b": page().replace(NAME, "Bilyeli Somun B"),
             "/urun/c": page(stock="<div>Tükendi</div>").replace(NAME, "Somun C"),
             "/robots.txt": "User-agent: *\nDisallow: /gizli\n"}
    _ileri_web(web, pages)
    corrected = {**_wrong_product(), "id": "p2", "name": "Bilyeli Somun B", "url": "https://www.ileri3d.com/urun/b",
                 "stock": "in", "stock_read": {"source": "hand", "manual": True, "page_was": {"stock": "in", "qty": None}},
                 "price": {"amount": 2600, "currency": "TRY", "vat": "incl", "source": "hand", "manual": True,
                           "page_was": {"amount": 2539.81, "currency": "TRY", "vat": "incl"}}}
    prods = [_wrong_product(), corrected,
             {**_wrong_product(), "id": "p3", "name": "Somun C", "url": "https://www.ileri3d.com/urun/c", "stock": "in",
              "price": {"amount": 2539.81, "currency": "TRY", "vat": "incl"}},
             {**_wrong_product(), "id": "p4", "name": "Gizli", "url": "https://www.ileri3d.com/gizli/x"},
             {**_wrong_product(), "id": "p5", "name": "Elle", "url": ""}]
    fake, mid = _fake_maker(prods)
    seen = []

    async def progress(done, total, current, report):
        seen.append((done, total, current))
    rep = run(mf.recheck(fake, dry=True, progress=progress))
    c = rep["counts"]
    assert (c["products"], c["pages"], c["read"], c["failed"], c["price"], c["stock"], c["held"], c["saved"]) == (5, 4, 3, 1, 1, 2, 1, 0)
    assert c["doubt"] == 2 and seen[-1] == (4, 4, None)
    rows = {r["id"]: r for r in rep["rows"]}
    assert rows["p1"]["price"] == [{"amount": 287.85, "currency": "TRY", "vat": None}, {"amount": 2539.81, "currency": "TRY", "vat": "incl"}]
    assert rows["p1"]["stock"] == [{"stock": "out", "qty": None}, {"stock": "in", "qty": None}]
    assert rows["p1"]["doubt"] == [{"k": "jump", "was": 287.85, "pct": 782, "on": "price"}]       # read right at last
    assert rows["p2"]["held"] == ["price", "stock"] and "price" not in rows["p2"]       # the corrections hold
    assert rows["p3"]["stock"][1]["stock"] == "out" and rows["p3"]["doubt"][0] == {"k": "both_words", "out": "Tükendi",
                                                                                    "in": "Sepete Ekle", "on": "stock"}
    assert "robots.txt" in rows["p4"]["error"] and "p5" not in rows
    assert run(mf.get(fake, mid))["products"] == prods                         # a dry run writes nothing
    assert sum(1 for u in web["seen"] if u.endswith("robots.txt")) == 1         # robots.txt once a site
    # for real: the values are kept, the corrections held
    run(mf.recheck(fake))
    got = {p["id"]: p for p in run(mf.get(fake, mid))["products"]}
    assert got["p1"]["price"]["amount"] == 2539.81 and got["p1"]["stock"] == "in" and got["p1"]["price"]["source"] == "text"
    assert got["p2"]["price"]["amount"] == 2600 and got["p2"]["price"]["manual"]
    assert got["p3"]["stock"] == "out" and mf.doubtful(got["p3"]) and got["p4"] == prods[3]


def test_a_reread_runs_alone_in_the_background(web, monkeypatch):  # noqa: F811
    monkeypatch.setitem(PUBLIC, "www.ileri3d.com", ["93.184.216.41"])
    _ileri_web(web, {"/urun/sfu-1204-350mm": page(), "/robots.txt": "User-agent: *\nAllow: /\n"})
    fake, mid = _fake_maker([_wrong_product()])

    async def go(dry):
        c, started = await mf.start_check(fake, dry, {"id": "a", "name": "A"})
        again, second = await mf.start_check(fake, dry)
        assert started and not second and again["_id"] == c["_id"]
        await mf._CHECKS[c["_id"]]
        return await mf.last_check(fake)
    c = run(go(True))
    assert c["status"] == "done" and c["dry"] and c["counts"]["price"] == 1 and c["done"] == c["total"] == 1
    assert run(mf.get(fake, mid))["products"][0]["price"]["amount"] == 287.85
    assert mf.check_out(c)["id"] == c["_id"] and "worker" not in mf.check_out(c)
    c = run(go(False))
    assert c["status"] == "done" and run(mf.get(fake, mid))["products"][0]["price"]["amount"] == 2539.81
    # not while a site is explored
    run(fake[mf.JOBS].insert_one({"_id": "j1", "status": "crawling", "manufacturer": {"id": mid, "name": "ileri3d"},
                                  "started_at": mf._now(), "beat": mf._now(), "worker": {"boot": "elsewhere"}}))
    with pytest.raises(ValueError, match="ileri3d is being explored"):
        run(mf.start_check(fake))
    # one a restart left ends as interrupted
    run(fake[mf.JOBS].delete_one({"_id": "j1"}))
    run(fake[mf.CHECKS].insert_one({"_id": "zz", "status": "running", "started_at": "9999", "beat": mf._now(),
                                    "worker": mf.WORKER}))
    assert run(mf.last_check(fake))["status"] == "failed"


def test_the_kinds_of_source_are_known():
    assert set(cf.SOURCES) == {"ld", "micro", "meta", "text", "model", "hand"}
