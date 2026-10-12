"""What a page says about its products, read without a model: the Product
Catalog's (backend/manufacturers.py) structured reading of a page.

A page read by the crawler is one of three kinds:

- "product": the page of one product. Its main product - the one whose
  page it is - is found from the structured data first (JSON-LD
  `Product`, the og: tags, microdata), then from its text: the name (H1,
  og:title, the title), its code ("Ürün Kodu: R006532"), its price
  ("362,60 TL + KDV"), its stock ("Stokta Var", "Son 3 adet"), its
  pictures and the date the seller last changed it. The blocks of other
  products on it ("Benzer Ürünler", related, recommended, recently
  viewed) are not this page's products: where they begin is kept
  (`related_at`), so the model is not shown them.
- "list": a category, a search, a table of products - every product on
  it counts (JSON-LD `ItemList`, many prices and no single product).
- "other": anything else (a home page, an about page) - the model decides.

The same reading works on a page fetched as HTML (`raw`: what
manufacturers._Page collected - the JSON-LD, the meta tags, microdata, the
H1, the canonical address) and on one whose text came as Markdown from Jina
Reader, or a page kept by an earlier run without any of that: then the text
and the pictures are all there is, and they are enough for the usual shop
page.

Prices are read in Turkish and English ways of writing them: "1.234,56 TL",
"₺1.234,56", "$1,234.56", "362,60 TL + KDV" (VAT excluded), "KDV Dahil"
(included) - `parse_price`, `find_prices`.
"""

from __future__ import annotations

import json
import math
import re
import urllib.parse

# ---- words ---------------------------------------------------------------------

_FOLD = str.maketrans({"ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ç": "c", "Ç": "c",
                       "ö": "o", "Ö": "o", "ü": "u", "Ü": "u", "â": "a", "î": "i", "û": "u", "Â": "a"})


def low(s: str) -> str:
    """Lower case, Turkish letters as their plain ones - the same length as
    `s` (one letter for one), so a match in it is a match in `s` too."""
    t = str(s or "").translate(_FOLD)
    out = t.lower()
    return out if len(out) == len(t) else "".join(c.lower() if len(c.lower()) == 1 else c for c in t)


def _clean(s, n: int) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


def _same_name(a: str, b: str) -> bool:
    """Two names of one product: the same words, or one holding the other
    nearly whole."""
    a, b = re.sub(r"[^a-z0-9]+", " ", low(a)).strip(), re.sub(r"[^a-z0-9]+", " ", low(b)).strip()
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 8 and short in long_ and len(short) / len(long_) >= 0.75


# ---- prices ----------------------------------------------------------------------

CURRENCY = {"tl": "TRY", "try": "TRY", "ytl": "TRY", "₺": "TRY", "usd": "USD", "us$": "USD", "$": "USD",
            "eur": "EUR", "euro": "EUR", "€": "EUR", "gbp": "GBP", "£": "GBP", "chf": "CHF", "jpy": "JPY",
            "cny": "CNY", "rmb": "CNY", "¥": "CNY"}
SYMBOL = {"TRY": "₺", "USD": "$", "EUR": "€", "GBP": "£"}
_NUM = r"\d{1,3}(?:[.,'  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?"
_PRICE = re.compile(
    rf"(?<![\w.,])(?:(?P<c1>US\$|₺|\$|€|£|(?<![A-Za-z])(?:USD|EUR|TRY|GBP)(?=[ \t\u00a0]))[ \t\u00a0]?(?P<n1>{_NUM})"
    rf"|(?P<n2>{_NUM})[ \t ]*\n?[ \t ]*(?P<c2>TL|TRY|YTL|USD|EUR|EURO|GBP|₺|€|\$|£)(?![A-Za-zğüşıöçĞÜŞİÖÇ]))",
    re.I)
_EXCL_AFTER = re.compile(r"^[\s*]*(\+\s*(kdv|vat|tax)|\(?\s*(kdv\s*hari[cç]|kdv'?siz|excl\.?\s*vat|ex\.?\s*vat|"
                         r"excluding\s+vat|plus\s+vat|vat\s+excl|before\s+tax|net)\b)")
_INCL_AFTER = re.compile(r"^[\s*]*\(?\s*(kdv\s*dahil|kdv'?\s*li\b|incl\.?\s*vat|inc\.?\s*vat|including\s+vat|"
                         r"vat\s+incl|tax\s+incl)")
_EXCL_BEFORE = re.compile(r"(kdv\s*hari[cç]|kdv'?siz|excl\.?\s*vat|ex\.?\s*vat|\+\s*kdv)\s*(fiyat[ıi]?)?\s*[:\-]?\s*$")
_INCL_BEFORE = re.compile(r"(kdv\s*dahil|kdv'?\s*li|incl\.?\s*vat|inc\.?\s*vat)\s*(fiyat[ıi]?)?\s*[:\-]?\s*$")
VAT_RATES = (1.2, 1.1, 1.18, 1.08, 1.01, 1.19, 1.21, 1.25)


def currency_of(s) -> str:
    """"TL", "₺", "try" -> "TRY"; a three-letter code as it is; "" otherwise."""
    s = str(s or "").strip()
    if not s:
        return ""
    got = CURRENCY.get(s.lower())
    if got:
        return got
    return s.upper() if re.fullmatch(r"[A-Za-z]{3}", s) else ""


def amount(s, currency: str = "") -> float | None:
    """A number as a price writes it: "1.234,56" and "1,234.56" are 1234.56,
    "362,60" is 362.6, "12.500" (Turkish) 12500; None when it is not one."""
    if isinstance(s, bool):
        return None
    if isinstance(s, (int, float)):
        v = float(s)
    else:
        t = re.sub(r"[\s  ']", "", str(s or ""))
        t = re.sub(r"[^\d.,\-]", "", t)
        if not re.search(r"\d", t):
            return None
        if "," in t and "." in t:
            dec = "," if t.rfind(",") > t.rfind(".") else "."
            t = t.replace("." if dec == "," else ",", "").replace(dec, ".")
        elif "," in t:
            head, _, tail = t.rpartition(",")
            t = t.replace(",", "") if (t.count(",") > 1 or len(tail) == 3) else head.replace(",", "") + "." + tail
        elif t.count(".") > 1:
            t = t.replace(".", "")
        elif "." in t:
            head, _, tail = t.partition(".")
            if len(tail) == 3 and currency not in ("USD", "GBP"):
                t = head + tail
        try:
            v = float(t)
        except ValueError:
            return None
    if not math.isfinite(v) or v <= 0 or v >= 1e10:
        return None
    return round(v, 4)


def vat_of(v) -> str | None:
    """"incl", "excl" or None, from what a person, a model or a page says."""
    if v is True:
        return "incl"
    if v is False:
        return "excl"
    s = low(str(v or "")).strip()
    if not s:
        return None
    if re.search(r"^(incl|inc|included|including|dahil|kdv dahil|kdvli|gross|with)", s) or s in ("true", "yes", "1"):
        return "incl"
    if re.search(r"^(excl|ex|excluded|excluding|haric|kdv haric|\+ ?kdv|\+ ?vat|net|plus|without|kdvsiz)", s) \
            or s in ("false", "no", "0"):
        return "excl"
    return None


def find_prices(text: str) -> list[dict]:
    """Every price written in `text`, in order: {amount, currency, vat,
    text, pos, end}. VAT is read from the words beside it ("+ KDV",
    "KDV Dahil", "excl. VAT")."""
    text = str(text or "")
    out = []
    for m in _PRICE.finditer(text):
        cur = currency_of(m.group("c1") or m.group("c2"))
        num = m.group("n1") or m.group("n2")
        a = amount(num, cur)
        if a is None:
            continue
        after = low(text[m.end():m.end() + 40])
        stop = re.search(r"\d", after)
        after = after[:stop.start()] if stop else after
        before = low(text[max(0, m.start() - 40):m.start()])
        vat, end = None, m.end()
        ex = _EXCL_AFTER.search(after)
        inc = _INCL_AFTER.search(after)
        if ex:
            vat, end = "excl", m.end() + ex.end()
        elif inc:
            vat, end = "incl", m.end() + inc.end()
        elif _EXCL_BEFORE.search(before):
            vat = "excl"
        elif _INCL_BEFORE.search(before):
            vat = "incl"
        out.append({"amount": a, "currency": cur, "vat": vat, "text": _clean(text[m.start():end], 60),
                    "pos": m.start(), "end": end})
    return out


def parse_price(v, currency: str = "", vat=None, at: str | None = None) -> dict | None:
    """A price as the catalog keeps it - {amount, currency, vat, text, at}
    (and `gross`, the price with VAT, when the page gave both) - from a
    number, a text ("362,60 TL + KDV", "$12.50") or such a dict; None
    when there is no price in it."""
    if v is None or v == "" or v is False:
        return None
    text = ""
    gross = None
    if isinstance(v, dict):
        raw = v.get("amount", v.get("value", v.get("price")))
        currency = currency_of(v.get("currency") or v.get("priceCurrency")) or currency_of(currency)
        vat = v.get("vat", vat)
        text = _clean(v.get("text"), 60)
        gross = amount(v.get("gross"), currency) if v.get("gross") is not None else None
        at = v.get("at") or at
        if isinstance(raw, str) and find_prices(raw):
            p = find_prices(raw)[0]
            a = p["amount"]
            currency = currency or p["currency"]
            vat = vat if vat is not None else p["vat"]
            text = text or p["text"]
        else:
            a = amount(raw, currency)
        if a is None and text:
            got = find_prices(text)
            if got:
                a, currency = got[0]["amount"], currency or got[0]["currency"]
                vat = vat if vat is not None else got[0]["vat"]
    elif isinstance(v, (int, float)) and not isinstance(v, bool):
        a = amount(v)
        currency = currency_of(currency)
    else:
        s = str(v).strip()
        got = find_prices(s)
        currency = currency_of(currency)
        if got:
            a = got[0]["amount"]
            currency = got[0]["currency"] or currency
            vat = vat if vat is not None else got[0]["vat"]
            text = got[0]["text"]
            if vat is None:
                vat = vat_of(s[got[0]["end"]:]) or ("excl" if re.search(r"\+\s*(kdv|vat)", low(s)) else None)
        else:
            a = amount(s, currency)
            text = _clean(s, 60) if a is not None and re.search(r"[^\d.,\s]", s) else ""
    if a is None:
        return None
    out = {"amount": a, "currency": currency, "vat": vat_of(vat), "text": text or "", "at": at}
    if gross and gross != a:
        out["gross"] = gross
    return out


def price_label(p: dict | None) -> str:
    """A price in a line: "362.60 TRY + VAT", "$12.50 incl. VAT"."""
    if not isinstance(p, dict) or p.get("amount") is None:
        return ""
    s = f"{p['amount']:,.2f} {p.get('currency') or ''}".strip()
    if p.get("vat") == "excl":
        s += " + VAT"
        if p.get("gross"):
            s += f" ({p['gross']:,.2f} with VAT)"
    elif p.get("vat") == "incl":
        s += " incl. VAT"
    return s


# ---- stock -------------------------------------------------------------------------

_OUT = re.compile(r"stokta\s+yok|stok\s+yok|t[uü]kendi|t[uü]kenmi[sş]tir|stokta\s+bulunmamaktad[ıi]r|temin\s+edilemiyor|"
                  r"gelince\s+haber\s+ver|out\s+of\s+stock|sold\s+out|currently\s+unavailable|not\s+available")
_QTY = (re.compile(r"son\s+(\d{1,6})\s+(?:adet|urun|tane|pcs)"),
        re.compile(r"stok(?:\s+adedi|\s+miktari|ta)?\s*:?\s*(\d{1,6})\s*(?:adet|pcs|pieces)?\b(?!\s*[.,/]\d)"),
        re.compile(r"(\d{1,6})\s+adet\s+stok"),
        re.compile(r"only\s+(\d{1,6})\s+left"),
        re.compile(r"(\d{1,6})\s+(?:in\s+stock|available)"))
_IN = re.compile(r"stokta\s+var|stokta(?!\s+yok)\b|in\s+stock|available\s+now|hemen\s+teslim|stoktan\s+teslim")
SCHEMA_STOCK = {"instock": "in", "instoreonly": "in", "limitedavailability": "in", "onlineonly": "in",
                "outofstock": "out", "soldout": "out", "discontinued": "out", "backorder": None, "preorder": None,
                "presale": None}


def parse_stock(v) -> tuple[str | None, int | None, str]:
    """("in" | "out" | None, how many when said, the words) from what a
    page, a model or a person says: "Stokta Var", "Son 3 adet",
    "https://schema.org/InStock", "out", 12, True."""
    if v is None or v == "":
        return None, None, ""
    if isinstance(v, bool):
        return ("in" if v else "out"), None, ""
    if isinstance(v, (int, float)):
        n = int(v)
        return ("in" if n > 0 else "out"), max(n, 0), ""
    s = str(v).strip()
    lw = low(s)
    key = re.sub(r"[^a-z]", "", lw.rsplit("/", 1)[-1])
    if key in SCHEMA_STOCK:
        return SCHEMA_STOCK[key], None, ""
    if lw in ("in", "yes", "var", "available"):
        return "in", None, ""
    if lw in ("out", "no", "yok", "none"):
        return "out", None, ""
    if _OUT.search(lw):
        return "out", None, _clean(s, 60)
    for rx in _QTY:
        m = rx.search(lw)
        if m:
            n = int(m.group(1))
            return ("in" if n > 0 else "out"), n, _clean(s, 60)
    if _IN.search(lw):
        return "in", None, _clean(s, 60)
    return None, None, _clean(s, 60)


def stock_in(text: str) -> dict:
    """The stock a stretch of a page says: {stock, qty, text}; nothing when it
    says both (a template with "Stokta Var" and "Stokta Yok" both written,
    one of them hidden by its script) or neither."""
    lw = low(text)
    for rx in _QTY:
        m = rx.search(lw)
        if m:
            n = int(m.group(1))
            return {"stock": "in" if n > 0 else "out", "qty": n, "text": _clean(text[m.start():m.end()], 60)}
    outs = list(_OUT.finditer(lw))
    rest = _OUT.sub(lambda m: " " * len(m.group(0)), lw)
    ins = list(_IN.finditer(rest))
    if outs and not ins:
        return {"stock": "out", "qty": None, "text": _clean(text[outs[0].start():outs[0].end()], 60)}
    if ins and not outs:
        return {"stock": "in", "qty": None, "text": _clean(text[ins[0].start():ins[0].end()], 60)}
    return {}


# ---- the page --------------------------------------------------------------------

RELATED = re.compile(
    r"^[#>*\s]*(benzer\s+urunler|ilgili\s+urunler|onerilen\s+urunler|sizin\s+icin\s+sectiklerimiz|"
    r"son\s+(?:gezilen|incelenen|goruntulenen|baktiginiz)\s+urunler|bunlar[ıi]?\s+da\s+\w+|"
    r"birlikte\s+al[ıi]nan\s+urunler|bu\s+urunu\s+(?:alanlar|inceleyenler)[^\n]*|benzer\s+urun\w*|"
    r"tamamlayici\s+urunler|related\s+products?|you\s+may\s+also\s+like|recently\s+viewed[^\n]*|"
    r"customers\s+(?:also|who)\s+[^\n]*|similar\s+products?|recommended(?:\s+(?:for\s+you|products?))?|"
    r"frequently\s+bought\s+together|ahnliche\s+produkte|zubehor)\s*[*:]*\s*$", re.M)
_CODE = re.compile(r"(?<![a-z])(?:(?:urun|stok|model)\s*(?:kodu|no|numarasi)|sku|product\s+code|part\s+(?:no|number)|"
                   r"item\s+(?:no|number|code)|art(?:ikel)?[.\s-]*nr|mpn)\s*[:#.]?[ \t]*\n?[ \t*]*"
                   r"([a-z0-9][a-z0-9\-_./]{1,40})")
_CART = re.compile(r"sepete\s+ekle|add\s+to\s+(?:cart|basket|bag)|in\s+den\s+warenkorb|hemen\s+al|buy\s+now")
_UPDATED = re.compile(r"(?:guncelleme\s+tarihi|son\s+guncelleme|guncellenme\s+tarihi|fiyat\s+guncelleme(?:\s+tarihi)?|"
                      r"last\s+updated|updated\s+on|updated)\s*:?\s*"
                      r"(\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{2})?)")
_TITLE_TAIL = re.compile(r"\s*[-|–:]?\s*(satin\s+al|fiyati|fiyatlari|en\s+uygun\s+fiyat\w*.*|online\s+satis\w*|"
                         r"buy\s+online|kaufen|uygun\s+fiyat\w*.*)\s*$")
THUMB = re.compile(r"thumb|kucuk|small|mini|/k/|_xs\.|-xs\.|50x50|100x100|icon", re.I)
IMG_EXT = re.compile(r"\.(jpe?g|png|webp|gif|avif)(\?|$)", re.I)


def _types(node: dict) -> set[str]:
    t = node.get("@type")
    t = t if isinstance(t, list) else [t]
    return {str(x).rsplit("/", 1)[-1] for x in t if x}


def _ld_nodes(blocks) -> list[dict]:
    """The JSON-LD blocks' top nodes: each block's, its @graph's and a
    WebPage's mainEntity."""
    out: list[dict] = []

    def walk(x, depth=0):
        if depth > 4:
            return
        if isinstance(x, list):
            for y in x:
                walk(y, depth + 1)
        elif isinstance(x, dict):
            if "@graph" in x:
                walk(x["@graph"], depth + 1)
            if x.get("@type"):
                out.append(x)
            if isinstance(x.get("mainEntity"), (dict, list)):
                walk(x["mainEntity"], depth + 1)
    for b in blocks or []:
        if isinstance(b, str):
            s = re.sub(r"^\s*(<!--|<!\[CDATA\[)|(-->|\]\]>)\s*$", "", b.strip())
            try:
                b = json.loads(s)
            except ValueError:
                try:
                    b = json.loads(re.sub(r",\s*([}\]])", r"\1", s.replace("\n", " ")))
                except ValueError:
                    continue
        walk(b)
    return out


def _first(v):
    return v[0] if isinstance(v, list) and v else v


def _img_urls(v) -> list[str]:
    out = []
    for x in v if isinstance(v, list) else [v]:
        if isinstance(x, dict):
            x = x.get("contentUrl") or x.get("url")
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
    return out


def _ld_product(node: dict) -> dict:
    offers = node.get("offers")
    offer = {}
    if isinstance(offers, list):
        offer = next((o for o in offers if isinstance(o, dict)), {})
    elif isinstance(offers, dict):
        offer = offers
        if "AggregateOffer" in _types(offers) and isinstance(offers.get("offers"), list) and offers["offers"]:
            inner = next((o for o in offers["offers"] if isinstance(o, dict)), {})
            offer = {**offers, **inner}
    spec = offer.get("priceSpecification")
    specs = spec if isinstance(spec, list) else [spec] if isinstance(spec, dict) else []
    price_raw = offer.get("price", offer.get("lowPrice"))
    cur = offer.get("priceCurrency")
    vat = None
    list_price = None
    for s in specs:
        kind = low(str(s.get("priceType") or ""))
        if "list" in kind or "strikethrough" in kind or "msrp" in kind:
            list_price = parse_price(s.get("price"), s.get("priceCurrency") or cur)
            continue
        if price_raw is None:
            price_raw = s.get("price")
        cur = cur or s.get("priceCurrency")
        if s.get("valueAddedTaxIncluded") is not None:
            vat = vat_of(s.get("valueAddedTaxIncluded"))
    brand = node.get("brand")
    brand = _first(brand)
    brand = brand.get("name") if isinstance(brand, dict) else brand
    inv = offer.get("inventoryLevel")
    qty = inv.get("value") if isinstance(inv, dict) else None
    stock, _, _ = parse_stock(offer.get("availability"))
    return {"name": _clean(node.get("name"), 200), "sku": _clean(node.get("sku") or node.get("mpn") or node.get("productID"), 80),
            "brand": _clean(brand, 120), "description": _clean(node.get("description"), 600),
            "images": _img_urls(node.get("image")), "url": str(node.get("url") or offer.get("url") or "").strip(),
            "category": _clean(node.get("category") if isinstance(node.get("category"), str) else "", 120),
            "price": parse_price(price_raw, currency_of(cur), vat) if price_raw is not None else None,
            "list_price": list_price, "stock": stock,
            "qty": int(qty) if isinstance(qty, (int, float)) and not isinstance(qty, bool) else None,
            "updated": _clean(node.get("dateModified") or offer.get("priceValidFrom"), 40)}


def _title_name(title: str, site: str = "") -> str:
    """A product's name from a page title: "X Satın Al | Shop" -> "X"."""
    t = str(title or "")
    for sep in (" | ", " – ", " — "):
        if sep in t:
            t = t.split(sep)[0]
    if site and " - " in t and low(t.rsplit(" - ", 1)[1]).strip() in low(site):
        t = t.rsplit(" - ", 1)[0]
    m = _TITLE_TAIL.search(low(t))
    if m and m.start() > 3:
        t = t[:m.start()]
    return _clean(t, 200)


def _anchor(text: str, name: str) -> int:
    """Where the product's own part of the page begins: its name written
    as a line (the H1), the first such place a price or a code follows."""
    if not name:
        return 0
    words = [re.escape(w) for w in low(name).split() if w]
    if not words:
        return 0
    rx = re.compile(r"\s+".join(words))
    lw = low(text)
    hits = [m.start() for m in rx.finditer(lw)]
    if not hits:
        return 0
    for h in hits:
        near = text[h:h + 1500]
        if find_prices(near) or _CODE.search(low(near)):
            return h
    return hits[0]


def _host(u: str) -> str:
    h = urllib.parse.urlsplit(u or "").hostname or ""
    return h[4:] if h.startswith("www.") else h


def _norm(u: str, base: str) -> str:
    from .manufacturers import normalise
    return normalise(u, base) or "" if u else ""


def facts(page: dict, raw: dict | None = None) -> dict:
    """What `page` ({url, title, text, images, links} - parse_page's, or
    one Jina read, or one an earlier run kept) says about its products:
    {kind, why, main, related_at, items, canonical}. `raw`: the structured
    data of its HTML (JSON-LD blocks, meta, microdata, H1, canonical)."""
    raw = raw or {}
    url = page.get("url") or ""
    text = page.get("text") or ""
    lw = low(text)
    meta = {k.lower(): v for k, v in (raw.get("meta") or {}).items()}
    micro = raw.get("micro") or {}
    canonical = _norm(raw.get("canonical") or meta.get("og:url") or "", url)
    nodes = _ld_nodes(raw.get("ld"))
    prods = [n for n in nodes if _types(n) & {"Product", "ProductGroup", "IndividualProduct", "ProductModel"}]
    lists = [n for n in nodes if _types(n) & {"ItemList", "OfferCatalog"} and isinstance(n.get("itemListElement"), list)]
    og_type = low(str(meta.get("og:type") or "")).strip()
    h1 = _clean(raw.get("h1"), 200)
    if not h1:
        m = re.search(r"^#\s+(.+)$", text, re.M)               # Jina's Markdown: the page's H1
        h1 = _clean(m.group(1), 200) if m else ""
    site = meta.get("og:site_name") or page.get("site_name") or ""
    kind, why, main = "other", "", None

    ld = None
    if prods:
        here = {u for u in (url, canonical) if u}
        ld_main = [p for p in prods if _norm(str(p.get("url") or ""), url) in here]
        if not ld_main and len(prods) > 1:
            ld_main = [p for p in prods if _same_name(str(p.get("name") or ""), h1 or meta.get("og:title") or "")]
        if ld_main or len(prods) == 1:
            ld = _ld_product((ld_main or prods)[0])
            kind, why = "product", "JSON-LD Product"
        elif og_type.startswith("product"):
            ld = _ld_product(prods[0])
            kind, why = "product", "og:type product"
    items = 0
    if lists and kind != "product":
        items = max(len(n["itemListElement"]) for n in lists)
        if items >= 2:
            kind, why = "list", "JSON-LD ItemList"
    if kind == "other" and len(prods) > 2:
        kind, why, items = "list", "JSON-LD Products", len(prods)
    if kind == "other" and og_type.startswith("product"):
        kind, why = "product", "og:type product"
    n_micro = int(raw.get("micro_products") or 0)
    if kind == "other" and n_micro == 1 and (micro.get("price") or micro.get("sku")):
        kind, why = "product", "microdata Product"

    name = (ld or {}).get("name") or h1 or _clean(meta.get("og:title"), 200) or _title_name(page.get("title") or "", site)
    at = _anchor(text, h1 or name) if text else 0
    if not at and name != h1:
        at = _anchor(text, name)
    rel = [m.start() for m in RELATED.finditer(lw)]
    related_at = next((r for r in rel if r > at), None)
    window = text[at:min(related_at if related_at is not None else len(text), at + 4000)]
    lwin = low(window)

    codes = [m for m in _CODE.finditer(lw) if re.search(r"\d", m.group(1)) or len(m.group(1)) >= 4]
    carts = len(_CART.findall(lw))
    prices_all = find_prices(text)
    if kind == "other":
        if len({low(text[m.start(1):m.end(1)]) for m in codes}) == 1 and (prices_all or carts):
            kind, why = "product", "one product code on the page"
        elif related_at is not None and find_prices(window):
            kind, why = "product", "one product, then related products"
        elif carts == 1 and find_prices(window):
            kind, why = "product", "one add-to-cart"
        elif len(prices_all) >= 4 and related_at is None and carts != 1:
            kind, why, items = "list", "many prices", len(prices_all)
    if kind != "product":
        return {"kind": kind, "why": why, "main": None, "related_at": None, "items": items, "canonical": canonical}

    # ---- the main product: the structured data first, the text for what it leaves out
    ld = ld or {}
    wcode = next((m for m in _CODE.finditer(lwin) if re.search(r"\d", m.group(1)) or len(m.group(1)) >= 4), None)
    sku = ld.get("sku") or _clean(micro.get("sku"), 80) or _clean(meta.get("product:retailer_item_id"), 80) \
        or (window[wcode.start(1):wcode.end(1)] if wcode else "")
    wprices = find_prices(window)
    price = ld.get("price")
    if not price and (micro.get("price") or meta.get("product:price:amount") or meta.get("og:price:amount")):
        price = parse_price(micro.get("price") or meta.get("product:price:amount") or meta.get("og:price:amount"),
                            currency_of(micro.get("pricecurrency") or meta.get("product:price:currency")
                                        or meta.get("og:price:currency")))
    first = wprices[0] if wprices else None
    if price and first is None:
        first = next((p for p in prices_all if abs(p["amount"] - price["amount"]) < 0.005), None)
    if not price and first:
        price = {k: first[k] for k in ("amount", "currency", "vat", "text")}
    if price:
        same = next((p for p in (wprices or prices_all) if abs(p["amount"] - price["amount"]) < 0.005), None)
        if same:
            price["vat"] = price.get("vat") or same["vat"]
            price["text"] = price.get("text") or same["text"]
            price["currency"] = price.get("currency") or same["currency"]
        # the same price with VAT, written next to it ("362,60 TL + KDV ... 435,12 TL")
        for p in wprices[:6]:
            if price.get("vat") == "incl" or abs(p["amount"] - price["amount"]) < 0.005:
                continue
            r = p["amount"] / price["amount"]
            if p["vat"] == "incl" or any(abs(r - v) < 0.004 for v in VAT_RATES):
                if any(abs(r - v) < 0.004 for v in VAT_RATES):
                    price["gross"] = p["amount"]
                    price["vat"] = price.get("vat") or "excl"
                break
        price.setdefault("currency", "")
        price = {**price, "currency": price.get("currency") or ("TRY" if re.search(r"\b(tl|kdv)\b", lw) else "")}
    st = {"stock": ld.get("stock"), "qty": ld.get("qty"), "text": ""}
    if not st["stock"] and micro.get("availability"):
        st["stock"] = parse_stock(micro.get("availability"))[0]
    if not st["stock"] and meta.get("product:availability"):
        st["stock"] = parse_stock(meta.get("product:availability"))[0]
    seen = stock_in(window) or ({} if st["stock"] else stock_in(text))
    if seen:
        st = {"stock": st["stock"] or seen["stock"], "qty": st["qty"] if st["qty"] is not None else seen.get("qty"),
              "text": seen.get("text") or ""}
    upd = ld.get("updated") or _clean(meta.get("article:modified_time") or meta.get("og:updated_time")
                                      or meta.get("product:updated_time"), 40)
    if not upd:
        m = _UPDATED.search(lw)
        upd = m.group(1) if m else ""

    # its pictures: the structured ones, then the page's whose words are its name
    imgs: list[str] = []
    for u in ld.get("images") or []:
        imgs.append(_norm(u, url))
    for u in raw.get("og_images") or ([meta["og:image"]] if meta.get("og:image") else []) \
            or [u for u, a in page.get("images") or [] if a == "og:image"]:
        imgs.append(_norm(u, url))
    if micro.get("image"):
        imgs.append(_norm(micro["image"], url))
    named = [(u, a) for u, a in page.get("images") or [] if a and a != "og:image" and _same_name(a, name)]
    big = [u for u, a in named if not THUMB.search(a) and not THUMB.search(u)]
    imgs += big or [u for u, _ in named]
    zoom = [u for u, _ in page.get("links") or [] if IMG_EXT.search(urllib.parse.urlsplit(u).path)]
    imgs += [u for u in zoom if any(_stem(u) == _stem(x) for x in imgs)]
    imgs = list(dict.fromkeys(u for u in imgs if u))[:12]
    main = {"name": name, "sku": sku, "brand": ld.get("brand") or _clean(meta.get("product:brand"), 120),
            "description": ld.get("description") or "", "category": ld.get("category") or "",
            "price": price, "list_price": ld.get("list_price"), "stock": st["stock"], "qty": st["qty"],
            "stock_text": st["text"], "updated": upd, "images": imgs, "image": imgs[0] if imgs else "",
            "url": canonical if canonical and _host(canonical) == _host(url) else url}
    return {"kind": "product", "why": why, "main": main, "related_at": related_at, "items": 1, "canonical": canonical}


def _stem(u: str) -> str:
    """An image's name without its size letter: -O.jpg, -B.jpg and -K.jpg of
    one picture are one."""
    p = urllib.parse.urlsplit(u).path.rsplit("/", 1)[-1]
    p = re.sub(r"\.\w+$", "", p)
    return re.sub(r"([-_](?:[a-z]|xs|sm|md|lg|xl|thumb|large|small|big|zoom|\d{2,4}x\d{2,4}))$", "", p, flags=re.I)


def hint(f: dict) -> str:
    """What the model is told of a page's kind, above its text."""
    if f.get("kind") == "product" and f.get("main"):
        m = f["main"]
        bits = [f"\"{m['name']}\""]
        if m.get("sku"):
            bits.append(f"code {m['sku']}")
        if m.get("price"):
            bits.append(f"price {price_label(m['price'])}" + (f" (written \"{m['price']['text']}\")" if m["price"].get("text") else ""))
        if m.get("stock"):
            bits.append(f"stock {m['stock']}" + (f" ({m['stock_text']})" if m.get("stock_text") else ""))
        return ("Kind: the page of ONE product (" + f.get("why", "") + ") - " + ", ".join(bits)
                + ". Write down only this product; any other products on the page (related, recommended, similar, "
                "recently viewed) are not this page's and are left out.")
    if f.get("kind") == "list":
        n = f.get("items") or 0
        return (f"Kind: a list of products{f' (about {n})' if n else ''} - write down every product it lists, each "
                "with its own page link, price and picture when the list shows them.")
    return ""
