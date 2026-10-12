"""Manufacturers ("Üreticiler"): makers whose catalogs the workspace keeps,
explored from their own website.

A manufacturer is a name, its site, a summary of what it makes, its
categories and a product catalog - each product with its name, category,
a short description, the specs, dimensions and materials the site gives,
its page, its picture and its code, when there are any - and the person's
own notes ("use them for injection molds"). Added by URL; renamed, noted,
explored again or deleted here.

Exploring (`explore`) is a background job (`manufacturer_jobs`, as a
taste extraction is, see backend/taste.py): it crawls the site politely -
the same registrable domain only, robots.txt obeyed, a clear User-Agent,
at most MAX_PAGES pages MAX_DEPTH links deep, a pause between requests,
timeouts and size caps, HTML only, the sitemap read for product pages -
then hands the pages' text, a chunk at a time, to the "manufacturer" job's
model (Settings > LLM settings) and keeps the company summary and the
products it finds, duplicates merged. Every step is written on the job as
it goes, so the page shows the run live and finds it again after a reload;
a cancel stops it, a restart of the server ends it as interrupted.

Fetching is plain HTTP (httpx): no page's script is ever run. Each request
is refused unless it is http(s) to a public address - checked again on
every redirect - so a site cannot point the crawler into this machine's
network. How it goes out is an order of routes (backend/netroutes.py): the
Product Catalog's default order of Settings > Proxy & Data, or a maker's
own. `local` is directly from here, `proxy` the proxy of that page
(backend/netproxy.py's, metered and logged there like the part lookups),
`jina` Jina Reader (backend/jina.py), which reads a page in a real browser
on Jina's side and answers with its Markdown. A request tries the first
route, and the next when the site turns it away, cannot be reached or -
for a later Jina - answers with a page empty without its script; once a
later route has answered a refused request, the rest of the run starts
there. Jina reads web pages only: robots.txt and the sitemaps go by the
other routes (directly when there are none), and a target is checked
(public, http(s)) before Jina is asked for it.

How the agents get it: the Chat's `manufacturer_search` tool
(backend/chat_tools/manufacturer_search.py) lists them, reads a catalog
and searches the products; a manufacturer is also an @-mention
(backend/cc_context.py, kind "manufacturer").

Manufacturers and their runs belong to the workspace (backend/scope.py).
"""

from __future__ import annotations

import asyncio
import hashlib
import heapq
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import time
import unicodedata
import urllib.parse
import urllib.robotparser
from datetime import datetime, timezone
from html.parser import HTMLParser

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors, llm
from . import catalog_facts as cf
from .taste import CHARS_PER_TOKEN, Stopped, Tracker, _closed, _pid_alive, _seconds

router = APIRouter(prefix="/api/manufacturers")

COLL = "manufacturers"
JOBS = "manufacturer_jobs"
PAGES = "manufacturer_pages"         # a run's pages as read (their text), so the model step can be run again without fetching the site
JOB = "manufacturer"                # the LLM job (llm.JOBS)
USER_AGENT = "Workbench-CatalogReader/1.0 (+https://redline.medipol.dev; reads product pages, obeys robots.txt)"

# The crawl.
MAX_PAGES = 100                     # pages read in one run
MAX_DEPTH = 4                       # links away from the first page
DELAY = 0.75                        # seconds between two requests, at least
MAX_DELAY = 10.0                    # a robots.txt Crawl-delay is obeyed up to this
TIMEOUT = 20.0                      # one request
MAX_BYTES = 3 * 1024 * 1024         # of one page; the rest is not read
MAX_REDIRECTS = 5
CRAWL_SECONDS = 15 * 60             # the whole crawl, at most
SITEMAP_URLS = 5_000                # read from the sitemaps, at most
SITEMAPS = 6                        # sitemap files read, at most
QUERY_VARIANTS = 6                  # the same path with different queries (?page=2...)
ONLY_MAX = 10                       # pages given at once, to be read on their own ("Add from a page")
FOLLOW_MAX = 30                     # product pages followed from them, at most (depth 1)

# What the model reads.
PAGE_CHARS = 6_000                  # of one page
PART_CHARS = 24_000                 # of a page given by hand, in one question (a longer one goes in parts)
CHUNK_CHARS = 32_000                # pages handed to the model in one question
MAX_CHUNKS = 8
EXTRACT_TOKENS = 8_000
EXTRACT_TIMEOUT = 240.0

MAX_PRODUCTS = 2_000                # in one catalog
MAX_SPECS = 24                      # on one product
MAX_DOCS = 40                       # catalog PDFs and the like, as links
THIN_TEXT = 200                     # a page read with less text than this is tried again through a later Jina
REFUSED = (403, 429, 503)           # a site turning a request away: the next route's moment
CONSUMER = "catalog"                # this crawler's routes and default order (backend/netroutes.py)
DEFAULT = "default"                 # a maker that follows the default order

log = logging.getLogger("redline.manufacturers")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db():
    from .main import db
    return db()


# ---- words -------------------------------------------------------------------

_FOLD = str.maketrans({"ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ç": "c", "Ç": "c",
                       "ö": "o", "Ö": "o", "ü": "u", "Ü": "u", "â": "a", "î": "i", "û": "u"})


def fold(text: str) -> str:
    """Lower case without accents, Turkish letters as their plain ones:
    "Menteşe" and "mentese" are the same word to a search."""
    t = str(text or "").translate(_FOLD).lower()
    return "".join(c for c in unicodedata.normalize("NFKD", t) if not unicodedata.combining(c))


def _clean(s, n: int) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


# ---- addresses: what may be fetched ------------------------------------------

class Refused(Exception):
    """An address the crawler will not fetch, with why."""


_SLD = {"com", "co", "org", "net", "gov", "edu", "ac", "gen", "biz", "info", "av", "bel", "web", "k12", "tv",
        "mil", "pol", "tsk", "bbs", "name", "tel", "dr", "ne", "or", "go", "gob", "nic", "ltd", "plc"}


def registrable(host: str) -> str:
    """The domain a site owns: doguskalip.com.tr for www.doguskalip.com.tr,
    example.com for shop.example.com. Without the public suffix list: a
    two-letter country under one of the usual second levels (com.tr,
    co.uk) keeps three labels."""
    host = (host or "").lower().rstrip(".")
    try:
        ipaddress.ip_address(host.strip("[]"))
        return host
    except ValueError:
        pass
    parts = host.split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in _SLD:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def normalise(url: str, base: str | None = None) -> str | None:
    """An absolute http(s) URL without its fragment, tracking parameters
    or default port, its host in lower case; None for anything else
    (mailto:, javascript:, tel:...)."""
    try:
        u = urllib.parse.urljoin(base, url.strip()) if base else url.strip()
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    host = p.hostname.lower()
    try:
        port = p.port
    except ValueError:
        return None
    netloc = host if port in (None, 80 if p.scheme == "http" else 443) else f"{host}:{port}"
    if "@" in p.netloc:
        return None
    path = urllib.parse.quote(urllib.parse.unquote(p.path or "/"), safe="/%:@!$&'()*+,;=-._~")
    query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
                                    if not re.match(r"(utm_|fbclid|gclid|yclid|mc_|_ga|sessionid|sid$|phpsessid)", k, re.I)])
    return urllib.parse.urlunsplit((p.scheme, netloc, path, query, ""))


async def _resolve(host: str) -> list[str]:
    """The addresses a name has (the tests put their own here)."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})


def _public(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_global and not a.is_multicast


async def check(url: str) -> str:
    """The URL, if it may be fetched: http or https, no user in it, and
    every address its host has public - not this machine, not its network,
    not link-local. Refused otherwise."""
    u = normalise(url)
    if not u:
        raise Refused("only http and https addresses can be explored")
    host = urllib.parse.urlsplit(u).hostname or ""
    try:
        ips = [str(ipaddress.ip_address(host.strip("[]")))]
    except ValueError:
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan")):
            raise Refused(f"{host} is not a public address")
        try:
            ips = await _resolve(host)
        except (OSError, UnicodeError) as exc:
            raise Refused(f"{host} could not be found ({exc.__class__.__name__})") from exc
    if not ips:
        raise Refused(f"{host} has no address")
    bad = [ip for ip in ips if not _public(ip)]
    if bad:
        raise Refused(f"{host} is a private or local address ({bad[0]}) - only public sites are explored")
    return u


# ---- reading a page ----------------------------------------------------------

_SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe", "object", "canvas", "select", "button"}
_BLOCK = {"p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "ul", "ol", "li", "dl", "dt",
          "dd", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "br", "hr", "form", "fieldset", "figure",
          "figcaption", "blockquote", "pre", "address", "tbody", "thead", "caption"}


class _Page(HTMLParser):
    """What a page says, read without running anything on it: its title,
    description, text (a table's cells kept apart by |), links with their
    words, and pictures with theirs - the lazy-loaded ones too (data-src,
    srcset...) - and, for catalog_facts, its structured data: the JSON-LD
    blocks, the meta tags, microdata, the H1 and the canonical address."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta: dict[str, str] = {}
        self.links: list[tuple[str, str]] = []
        self.images: list[tuple[str, str]] = []
        self.base: str | None = None
        self.ld: list[str] = []
        self.micro: dict[str, str] = {}
        self.micro_products = 0
        self.og_images: list[str] = []
        self.canonical = ""
        self.h1 = ""
        self._text: list[str] = []
        self._skip = 0
        self._in_title = False
        self._a: list | None = None
        self._ld: list[str] | None = None
        self._h1: list[str] | None = None
        self._iprop: str | None = None

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "script" and "ld+json" in a.get("type", "").lower():
            self._ld = []
        if a.get("itemtype") and re.search(r"schema\.org/(Product|IndividualProduct|ProductModel)\b", a["itemtype"]):
            self.micro_products += 1
        prop = a.get("itemprop", "").strip()
        if prop and prop.lower() in _MICRO:
            val = a.get("content") or (a.get("href") if tag in ("link", "a") else "") or (
                _best_src(a) if tag == "img" else "")
            if val:
                self.micro.setdefault(prop.lower(), val)
            elif tag not in ("meta", "link", "img"):
                self._iprop = prop.lower()
        if tag in _SKIP_TAGS:
            self._skip += 1
            return
        if tag == "title":
            self._in_title = True
        elif tag == "base" and a.get("href") and not self.base:
            self.base = a["href"]
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key in ("og:image", "og:image:secure_url", "og:image:url") and a.get("content"):
                self.og_images.append(a["content"])
            if key and (key in ("description", "keywords") or key.startswith(("og:", "product:", "article:", "twitter:"))):
                self.meta.setdefault(key, a.get("content") or "")
        elif tag == "link":
            rel = a.get("rel", "").lower().split()
            if "canonical" in rel and a.get("href") and not self.canonical:
                self.canonical = a["href"]
            elif "image_src" in rel and a.get("href"):
                self.og_images.append(a["href"])
        elif tag == "a" and a.get("href"):
            self._a = [a["href"], []]
            self._text.append(" ")
            if cf.IMG_EXT.search(a["href"].split("#")[0]):             # a picture's zoom: <a href="...-B.jpg">
                self.images.append((a["href"], a.get("title") or a.get("data-title") or ""))
        elif tag == "img":
            src = _best_src(a)
            if src:
                self.images.append((src, a.get("alt") or a.get("title") or ""))
        elif tag == "source":
            src = _largest(a.get("srcset") or a.get("data-srcset") or "")
            if src:
                self.images.append((src, a.get("title") or ""))
        elif tag == "h1" and not self.h1:
            self._h1 = []
        elif tag in ("td", "th"):
            self._text.append(" | ")
        if tag in _BLOCK:
            self._text.append("\n")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)

    def handle_endtag(self, tag):
        if tag == "script" and self._ld is not None:
            self.ld.append("".join(self._ld))
            self._ld = None
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
            return
        if tag == "title":
            self._in_title = False
        elif tag == "h1" and self._h1 is not None:
            self.h1 = re.sub(r"\s+", " ", "".join(self._h1)).strip()
            self._h1 = None
        elif tag == "a" and self._a is not None:
            self.links.append((self._a[0], _clean(" ".join(self._a[1]), 120)))
            self._a = None
            self._text.append(" ")
        if tag in _BLOCK:
            self._text.append("\n")

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
            return
        if self._skip:
            return
        if self._in_title:
            self.title += data
            return
        if self._iprop and data.strip():
            self.micro.setdefault(self._iprop, data.strip()[:200])
            self._iprop = None
        if self._h1 is not None:
            self._h1.append(data)
        self._text.append(data)
        if self._a is not None:
            self._a[1].append(data)

    def text(self) -> str:
        raw = "".join(self._text)
        lines = []
        for ln in raw.split("\n"):
            ln = re.sub(r"[ \t\r\f\v\xa0]+", " ", ln).strip(" |")
            ln = re.sub(r"(\s*\|\s*)+", " | ", ln)
            if ln and (not lines or lines[-1] != ln):
                lines.append(ln)
        return "\n".join(lines)


_MICRO = {"price", "pricecurrency", "lowprice", "sku", "mpn", "availability", "image", "name", "brand"}
_PLACEHOLDER = re.compile(r"(^data:|blank\.|spacer|placeholder|loading|lazy[-_]?load|transparent|1x1|pixel\.)", re.I)


def _largest(srcset: str) -> str:
    """The largest picture a srcset names ("a.jpg 320w, b.jpg 1024w" -> b.jpg)."""
    best, size = "", -1.0
    for part in str(srcset or "").split(","):
        bits = part.strip().split()
        if not bits or bits[0].startswith("data:"):
            continue
        m = re.match(r"([\d.]+)([wx])$", bits[1]) if len(bits) > 1 else None
        n = float(m.group(1)) * (1 if m.group(2) == "w" else 1000) if m else 0.0
        if n > size:
            best, size = bits[0], n
    return best


def _best_src(a: dict) -> str:
    """An <img>'s real picture: the zoom or full one when named, the largest
    of a srcset, the lazy one (data-src...) before a placeholder src."""
    for k in ("data-zoom-image", "data-zoom", "data-large_image", "data-large", "data-full", "data-original"):
        if a.get(k) and not _PLACEHOLDER.search(a[k]):
            return a[k]
    for k in ("srcset", "data-srcset", "data-lazy-srcset"):
        got = _largest(a.get(k) or "")
        if got and not _PLACEHOLDER.search(got):
            return got
    for k in ("data-src", "data-lazy", "data-lazy-src", "data-echo", "data-img", "data-image", "src"):
        if a.get(k) and not _PLACEHOLDER.search(a[k]):
            return a[k]
    return ""


def _charset_of(content_type: str | None, head: bytes) -> str | None:
    m = re.search(r"charset=['\"]?([\w\-:.]+)", content_type or "", re.I)
    if m:
        return m.group(1)
    m = re.search(rb"<meta[^>]+charset=['\"]?\s*([\w\-:.]+)", head[:4096], re.I)
    return m.group(1).decode("ascii", "ignore") if m else None


def decode(body: bytes, content_type: str | None = None) -> str:
    """A page's bytes as text: the charset the server or the page says
    (Turkish sites often say windows-1254 or iso-8859-9), else UTF-8,
    else Turkish Windows, else Latin-1."""
    if body.startswith(b"\xef\xbb\xbf"):
        return body[3:].decode("utf-8", "replace")
    said = _charset_of(content_type, body)
    if said:
        try:
            return body.decode(said, "replace")
        except LookupError:
            pass
    for enc in ("utf-8", "cp1254"):
        try:
            return body.decode(enc)
        except UnicodeDecodeError:
            continue
    return body.decode("latin-1", "replace")


def parse_page(html: str, url: str) -> dict:
    """A page as the crawl keeps it: title, description, text, links (same
    as written, made absolute) and pictures."""
    p = _Page()
    try:
        p.feed(html)
        p.close()
    except Exception:                                   # noqa: BLE001 - a broken page is read as far as it goes
        pass
    base = normalise(p.base, url) if p.base else url
    base = base or url
    links = []
    for href, words in p.links:
        u = normalise(href, base)
        if u:
            links.append((u, words))
    images: list[tuple[str, str]] = []
    have: set[str] = set()
    og = normalise(p.meta.get("og:image") or "", base) if p.meta.get("og:image") else None
    for src, alt in ([(og, "og:image")] if og else []) + p.images:
        u = normalise(src, base)
        if u and u not in have and not re.search(r"(logo|icon|sprite|flag|banner|spacer|pixel|blank)", u, re.I):
            have.add(u)
            images.append((u, _clean(alt, 120)))
    page = {"title": _clean(p.title or p.meta.get("og:title"), 200),
            "description": _clean(p.meta.get("description") or p.meta.get("og:description"), 400),
            "site_name": _clean(p.meta.get("og:site_name"), 120),
            "text": p.text(), "links": links, "images": images[:60], "url": url}
    raw = {"ld": p.ld, "meta": p.meta, "micro": p.micro, "micro_products": p.micro_products, "h1": p.h1,
           "canonical": normalise(p.canonical, base) if p.canonical else "",
           "og_images": [u for u in (normalise(x, base) for x in p.og_images) if u]}
    try:
        page["facts"] = cf.facts(page, raw)
    except Exception:                                   # noqa: BLE001 - a page whose data cannot be read is still read
        log.exception("reading the structured data of %s", url)
    del page["url"]
    return page


def facts_of(p: dict) -> dict:
    """What a page says about its products (catalog_facts): read with its
    HTML when it was parsed here, from its text and pictures otherwise (a
    page Jina read, or one an earlier run kept)."""
    if not isinstance(p.get("facts"), dict):
        try:
            p["facts"] = cf.facts(p)
        except Exception:                               # noqa: BLE001
            log.exception("reading the products of %s", p.get("url"))
            p["facts"] = {"kind": "other", "main": None, "related_at": None, "items": 0, "canonical": ""}
    return p["facts"]


# ---- which links first -------------------------------------------------------

PRODUCT_WORDS = ("urun", "product", "produkt", "produit", "prodott", "producto", "katalog", "catalog", "kategori",
                 "categor", "seri", "series", "model", "shop", "magaza", "store", "item", "collection", "koleksiyon",
                 "parca", "part", "artikel", "article", "sku", "detay", "detail")
SKIP_WORDS = ("haber", "news", "blog", "duyuru", "announce", "iletisim", "contact", "kariyer", "career", "insan-kaynak",
              "human-resource", "gizlilik", "privacy", "cookie", "cerez", "sozlesme", "kvkk", "gdpr", "terms",
              "bayi", "dealer", "etkinlik", "event", "fuar", "fair", "basin", "press", "video", "galeri", "gallery",
              "kampanya", "campaign", "sss", "faq", "anket", "survey", "referans", "reference", "sertifika")
NEVER_WORDS = ("giris", "login", "logout", "signin", "sign-in", "uye-ol", "register", "sepet", "cart", "basket",
               "checkout", "odeme", "hesabim", "account", "sifre", "password", "wishlist", "favori", "compare",
               "karsilastir", "/feed", "wp-admin", "wp-json", "/cdn-cgi/", "share", "print")
ABOUT_WORDS = ("hakkimizda", "about", "kurumsal", "corporate", "company", "firma", "biz-kimiz", "who-we-are")
FILE_EXT = re.compile(r"\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|zip|rar|7z|gz|tar|docx?|xlsx?|pptx?|csv|"
                      r"mp4|mp3|avi|mov|wmv|webm|dwg|dxf|step|stp|igs|iges|stl|exe|dmg|apk|css|js|json|woff2?|ttf|eot)$", re.I)
DOC_EXT = re.compile(r"\.(pdf|xlsx?|docx?|zip|dwg|dxf|step|stp)$", re.I)


def score(url: str, words: str = "") -> int:
    """How much a link looks like the way to products: higher first; below
    zero, not worth a page."""
    p = urllib.parse.urlsplit(url)
    path = fold(urllib.parse.unquote(p.path + ("?" + p.query if p.query else "")))
    hay = path + " " + fold(words)
    if any(w in path for w in NEVER_WORDS):
        return -100
    s = 0
    if any(w in hay for w in PRODUCT_WORDS):
        s += 10
    if any(w in path for w in ABOUT_WORDS):
        s += 6
    if any(w in path for w in SKIP_WORDS):
        s -= 12
    if p.query:
        s -= 2
    return s - path.count("/")


def looks_like_product(url: str, title: str = "") -> bool:
    return any(w in fold(urllib.parse.unquote(urllib.parse.urlsplit(url).path) + " " + title)
               for w in PRODUCT_WORDS)


# ---- the crawl ---------------------------------------------------------------

def _client(proxy: str | None = None):
    """The HTTP client of one run (the tests hand their own transport in
    here). Redirects are followed by hand, so each is checked."""
    import httpx
    return httpx.AsyncClient(proxy=proxy, timeout=httpx.Timeout(TIMEOUT, connect=10.0), follow_redirects=False,
                             headers={"User-Agent": USER_AGENT, "Accept-Language": "tr,en;q=0.8,*;q=0.5",
                                      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5"})


def proxy_state() -> dict:
    """How a run may go out: the routes this crawler can take, which are set
    up (the proxy of Settings > Proxy & Data, Jina's key), and the default
    order a maker follows unless it has its own."""
    from . import jina, netproxy, netroutes
    conf = netproxy._conf
    return {"configured": bool(netproxy.url()), "price_per_gb": conf.get("price_per_gb", 3.99),
            "country": conf.get("country") or "", "metered": bool(_meter_port()), "jina": jina.configured(),
            "routes": list(netroutes.CONSUMERS[CONSUMER]), "order": netroutes.order(CONSUMER),
            "ready": {r: netroutes.why_not(r) for r in netroutes.CONSUMERS[CONSUMER]}}


def own_route(value) -> list[str] | None:
    """A maker's own order as given - a list of routes, or one of the old
    mode names - or None for the default order."""
    from . import netroutes
    if value is None or value == DEFAULT:
        return None
    return netroutes.clean(CONSUMER, value)


def maker_route(doc: dict) -> list[str] | None:
    """A maker's own order, or None when it follows the default. A maker
    from before the orders kept a mode ("proxy"): that mode, as an order."""
    if "route" in doc:
        return own_route(doc.get("route"))
    return own_route(doc.get("proxy"))


def run_plan(route: list[str] | None) -> list[str]:
    """The routes a run will try: the order (None: the default), without the
    routes that are not set up. ValueError when none is left."""
    from . import netroutes
    try:
        return netroutes.plan(CONSUMER, route)
    except netroutes.NoRoute as exc:
        raise ValueError(str(exc)) from exc


def choice_problem(route: list[str] | None) -> str | None:
    """Why a run cannot go out the way `route` says, or None."""
    try:
        run_plan(route)
    except ValueError as exc:
        return str(exc)
    return None


def _meter_port():
    from . import netmeter
    return netmeter.port()


class Fetcher:
    """One run's way out: an order of routes (backend/netroutes.py) - `local`
    (directly), `proxy`, `jina` (Jina Reader, web pages only) - of which the
    ones set up are tried in turn. A request goes to the first; when the site
    turns it away (REFUSED) or cannot be reached, or Jina cannot read it, to
    the next. A web page that comes back next to empty (its text written by
    its script) is read through a later Jina, if the order has one. Once a
    later route has answered a refused request, the rest of the run starts
    from it. Counts what went each way."""

    def __init__(self, route: list[str] | str | None = None, session: str | None = None):
        from . import netproxy
        try:
            self.order = run_plan(own_route(route))
        except ValueError as exc:
            raise Refused(str(exc)) from exc
        proxied = "proxy" in self.order
        self.session = session if proxied else None
        self.proxy_url = netproxy.client_url(self.session) if proxied else None
        self.at = 0                                     # where a request starts in the order
        self.switched_at: str | None = None
        self.jina_since: str | None = None
        self.rescued_jina = 0                           # refused or unreachable, then read by Jina
        self.stats = {"direct": {"requests": 0, "bytes": 0, "refused": 0},
                      "proxy": {"requests": 0, "bytes": 0, "refused": 0},
                      "jina": {"requests": 0, "bytes": 0, "refused": 0, "failed": 0, "tokens": 0}}
        self._clients: dict[bool, object] = {}

    def client(self, via: bool):
        if via not in self._clients:
            self._clients[via] = _client(self.proxy_url if via else None)
        return self._clients[via]

    async def close(self):
        for c in self._clients.values():
            try:
                await c.aclose()
            except Exception:                           # noqa: BLE001
                pass

    @property
    def via_proxy(self) -> bool:
        """Whether the run's requests start at the proxy now."""
        return self.order[self.at] == "proxy"

    def _routes(self, page: bool) -> list[str]:
        """The routes one request tries, in order: from where the run stands.
        Jina only for a web page; the rest (robots.txt, the sitemaps) by the
        order's other routes, and directly when it has none."""
        tail = self.order[self.at:]
        if page:
            return tail
        return ([r for r in tail if r != "jina"] or [r for r in self.order if r != "jina"] or ["local"])

    async def get(self, url: str, accept, allowed) -> dict:
        """One page: {url (where it ended up), status, type, body, via, ms,
        bytes, error}. `accept(content_type)` says which types are read;
        `allowed(url)` which hosts a redirect may go to. Every hop is
        checked (check()) before it is asked - and before Jina is asked
        for it. Only web pages (accept is _is_html) go through Jina."""
        page = accept is _is_html
        routes = self._routes(page)
        got: dict = {}
        for i, route in enumerate(routes):
            attempt = "first" if i == 0 else "fallback"
            if route == "jina":
                got = await self._jina(url, allowed, attempt=attempt)
                if got.get("error_kind") == "refused":  # not a page to ask anybody for
                    return got
                trouble = bool(got["error"])
            else:
                got = await self._get(url, accept, allowed, route == "proxy", attempt=attempt)
                trouble = got.get("status") in REFUSED or got.get("error_kind") == "network"
            if i:
                got["fallback"] = True
            if trouble:
                continue
            if i:
                # Turned away before and answered here: the rest of the run starts here.
                self.at = max(self.at, self.order.index(route))
                if route == "proxy":
                    self.switched_at = self.switched_at or _now()
                elif route == "jina":
                    self.jina_since = self.jina_since or _now()
                    self.rescued_jina += 1
            if page and route != "jina" and "jina" in routes[i + 1:] and self._thin(got):
                # Written by its script: a later Jina reads it, this once.
                j = await self._jina(url, allowed, attempt="fallback")
                if not j["error"]:
                    j["fallback"] = True
                    return j
            return got
        return got

    def _thin(self, got: dict) -> bool:
        """A web page that came back with next to no text: written by its
        script, most likely. The page read is kept on `got` either way."""
        if got.get("status") != 200 or not got.get("body") or not _is_html(got.get("type", "")):
            return False
        got["page"] = parse_page(decode(got["body"], got["type"]), got["url"])
        return len(got["page"]["text"].strip()) < THIN_TEXT

    async def _jina(self, url: str, allowed, attempt: str = "first") -> dict:
        """One web page through Jina Reader, as _get answers: its Markdown
        is the page's text, its links and pictures the page's (`page`)."""
        from . import jina
        t0 = time.monotonic()
        out: dict = {"url": url, "status": None, "type": "", "body": b"", "via": "jina", "bytes": 0,
                     "error": None, "attempt": attempt}
        try:
            cur = await check(url)                      # never ask Jina for this machine's network
            if not allowed(cur):
                raise Refused(f"it leads off the site, to {urllib.parse.urlsplit(cur).hostname}")
        except Refused as exc:
            out.update(error=str(exc), error_kind="refused", ms=round((time.monotonic() - t0) * 1000))
            return out
        st = self.stats["jina"]
        st["requests"] += 1
        got = await jina.read(cur, who="manufacturers")
        final = (normalise(got["url"]) if got.get("url") else None) or cur
        if got["ok"] and not allowed(final):
            got = {**got, "ok": False, "error": f"it leads off the site, to {urllib.parse.urlsplit(final).hostname}"}
        if got["ok"]:
            links = [(u, w) for u, w in ((normalise(h, final), w) for h, w in got["links"]) if u]
            images = [(u, _clean(a, 120)) for u, a in ((normalise(h, final), a) for h, a in got["images"])
                      if u and not re.search(r"(logo|icon|sprite|flag|banner|spacer|pixel|blank)", u, re.I)]
            body = got["text"].encode("utf-8")
            out.update(url=final, status=200, type="text/html; charset=utf-8", body=body,
                       page={"title": _clean(got["title"], 200), "description": _clean(got["description"], 400),
                             "site_name": "", "text": got["text"], "links": links, "images": images[:40]})
        else:
            out.update(status=got.get("status") if got.get("status") not in (None, 200) else None,
                       error=got["error"], error_kind="jina")
            st["failed"] += 1
            if out["status"] in REFUSED:
                st["refused"] += 1
        out["bytes"] = len(out["body"])
        out["tokens"] = got.get("tokens") or 0
        out["ms"] = got.get("ms") or round((time.monotonic() - t0) * 1000)
        st["bytes"] += out["bytes"]
        st["tokens"] += out["tokens"]
        return out

    async def _get(self, url: str, accept, allowed, via: bool, attempt: str = "first") -> dict:
        import httpx
        side = "proxy" if via else "direct"
        t0 = time.monotonic()
        out: dict = {"url": url, "status": None, "type": "", "body": b"", "via": side, "bytes": 0, "error": None}
        try:
            cur = url
            for _ in range(MAX_REDIRECTS + 1):
                cur = await check(cur)
                if not allowed(cur):
                    raise Refused(f"it leads off the site, to {urllib.parse.urlsplit(cur).hostname}")
                self.stats[side]["requests"] += 1
                async with self.client(via).stream("GET", cur) as r:
                    out.update(url=cur, status=r.status_code, type=r.headers.get("content-type", ""))
                    if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                        nxt = normalise(r.headers["location"], cur)
                        if not nxt:
                            raise Refused("a redirect to an address that is not http(s)")
                        cur = nxt
                        continue
                    if r.status_code != 200 or not accept(out["type"]):
                        break
                    buf = bytearray()
                    async for part in r.aiter_bytes():
                        buf += part
                        if len(buf) >= MAX_BYTES:
                            out["clipped"] = True
                            break
                    out["body"] = bytes(buf[:MAX_BYTES])
                    break
            else:
                raise Refused(f"more than {MAX_REDIRECTS} redirects")
        except Refused as exc:
            out["error"], out["error_kind"] = str(exc), "refused"
        except (httpx.TimeoutException, asyncio.TimeoutError):
            out["error"], out["error_kind"] = f"no answer within {TIMEOUT:.0f} s", "network"
        except httpx.HTTPError as exc:
            out["error"], out["error_kind"] = f"{type(exc).__name__}: {str(exc)[:160]}", "network"
        out["bytes"] = len(out["body"])
        out["ms"] = round((time.monotonic() - t0) * 1000)
        self.stats[side]["bytes"] += out["bytes"]
        if out["status"] in REFUSED:
            self.stats[side]["refused"] += 1
        if via:
            from . import netproxy
            netproxy.log({"kind": "manufacturer", "target": out["url"][:300], "via": "proxy", "status": out["status"],
                          "ms": out["ms"], "bytes": out["bytes"], "error": out["error"], "attempt": attempt,
                          "who": "manufacturers", "session": None, "exit": None})
        return out


def _is_html(ct: str) -> bool:
    ct = (ct or "").split(";")[0].strip().lower()
    return ct in ("text/html", "application/xhtml+xml", "")


def _is_xml(ct: str) -> bool:
    ct = (ct or "").split(";")[0].strip().lower()
    return ct in ("application/xml", "text/xml", "text/plain", "application/rss+xml", "") or ct.endswith("+xml")


async def _read_robots(root: str, track: Tracker, fetcher: Fetcher, allowed, sid: str = "robots"):
    """robots.txt, from a site's own root: (its rules, its sitemaps, its
    Crawl-delay), each written on the step `sid`."""
    robots = urllib.robotparser.RobotFileParser()
    sitemaps: list[str] = []
    delay = DELAY
    await track.step(sid, kind="robots", url=root + "robots.txt", state="running")
    got = await fetcher.get(root + "robots.txt", lambda ct: True, allowed)
    if got["status"] == 200 and got["body"]:
        lines = decode(got["body"], got["type"]).splitlines()
        robots.parse(lines)
        found = [normalise(ln.split(":", 1)[1].strip()) for ln in lines if ln.lower().startswith("sitemap:")]
        sitemaps = [s for s in found if s and allowed(s)]
        cd = robots.crawl_delay(USER_AGENT)
        if cd:
            delay = min(MAX_DELAY, max(DELAY, float(cd)))
        await track.step(sid, state="done", found=True, rules=len(lines), sitemaps=len(sitemaps),
                         delay=delay, via=got["via"])
    elif got["status"] in (401, 403):
        robots.disallow_all = True
        await track.step(sid, state="done", found=True, delay=delay, via=got["via"],
                         note="robots.txt is refused to us: the site is read as closed")
    else:
        robots.allow_all = True
        await track.step(sid, state="done", found=False, delay=delay, via=got["via"],
                         note="no robots.txt: every page may be read" if not got["error"] else got["error"])
    track.add(delay=delay)
    return robots, sitemaps, delay


def _page_of(got: dict, url: str) -> dict:
    """The page a request read: Jina's (or one already parsed), else its HTML parsed."""
    return got.get("page") or parse_page(decode(got["body"], got["type"]), url)


def _root_of(u: str) -> str:
    return urllib.parse.urlunsplit(urllib.parse.urlsplit(u)[:2] + ("/", "", ""))


def _domain_of(u: str) -> str:
    return registrable(urllib.parse.urlsplit(u).hostname or "")


def _page_row(got: dict, url: str, depth: int) -> dict:
    """A request as a row of the run's page list."""
    row = {"url": got["url"] if got["status"] == 200 else url, "depth": depth, "status": got["status"],
           "via": got["via"], "ms": got.get("ms"), "bytes": got["bytes"], "at": _now()}
    if got.get("fallback"):
        row["fallback"] = True
    if got["error"]:
        row["error"] = got["error"]
    elif got["status"] == 200 and not _is_html(got["type"]):
        row["error"] = f"not a web page ({got['type'].split(';')[0]})"
    elif got["status"] != 200:
        row["error"] = f"HTTP {got['status']}"
    return row


async def crawl(start: str, track: Tracker, fetcher: Fetcher, max_pages: int = MAX_PAGES,
                sleep=asyncio.sleep, only: list[str] | None = None, follow: bool = False) -> dict:
    """Read the site from `start`: robots.txt, the sitemaps, then pages,
    the likeliest product pages first. Returns {pages, domain, docs, home}
    - a page {url, title, description, text, images, depth, product}.
    Each request is a row of the run's page list, written as it goes.

    With `only`, just those pages are read (crawl_only): no sitemap, no
    links followed - but the product pages they link to when `follow`."""
    if only:
        return await crawl_only(only, track, fetcher, follow, sleep)
    t_start = time.monotonic()
    pages_meta: list[dict] = track.meta.setdefault("pages", [])
    first = await check(start)
    domain = registrable(urllib.parse.urlsplit(first).hostname or "")

    def allowed(u: str) -> bool:
        return registrable(urllib.parse.urlsplit(u).hostname or "") == domain

    robots = urllib.robotparser.RobotFileParser()
    sitemaps: list[str] = []
    delay = DELAY

    async def read_robots(root: str) -> None:
        """robots.txt, from the site's own root: its rules, its sitemaps,
        its Crawl-delay."""
        nonlocal robots, sitemaps, delay
        robots, sitemaps, delay = await _read_robots(root, track, fetcher, allowed)
        await sleep(delay)

    root_of = _root_of

    await read_robots(root_of(first))
    root = root_of(first)

    def may(u: str) -> bool:
        return robots.can_fetch(USER_AGENT, u)

    # the queue: (-score, depth, n, url, words)
    queue: list = []
    seen: set[str] = set()
    variants: dict[str, int] = {}
    docs: dict[str, str] = {}
    n = 0

    def push(u: str, depth: int, words: str = "", bonus: int = 0) -> None:
        nonlocal n
        if u in seen or not allowed(u) or depth > MAX_DEPTH:
            return
        if FILE_EXT.search(urllib.parse.urlsplit(u).path):
            if DOC_EXT.search(urllib.parse.urlsplit(u).path) and len(docs) < MAX_DOCS:
                docs.setdefault(u, words or urllib.parse.unquote(u.rsplit("/", 1)[-1]))
            return
        s = score(u, words) + bonus
        if s <= -50:
            return
        p = urllib.parse.urlsplit(u)
        if p.query:
            key = p.netloc + p.path
            if variants.get(key, 0) >= QUERY_VARIANTS:
                return
            variants[key] = variants.get(key, 0) + 1
        seen.add(u)
        n += 1
        heapq.heappush(queue, (-s, depth, n, u, words))

    push(first, 0, bonus=1000)

    # the sitemaps: the product pages they name go in first
    if not sitemaps:
        sitemaps = [root + "sitemap.xml"]
    await track.step("sitemap", kind="sitemap", files=0, urls=0)
    read_maps, from_maps = 0, 0
    todo = list(dict.fromkeys(sitemaps))
    while todo and read_maps < SITEMAPS and from_maps < SITEMAP_URLS:
        sm = todo.pop(0)
        if not may(sm):
            continue
        got = await fetcher.get(sm, _is_xml, allowed)
        read_maps += 1
        await sleep(delay)
        if got["status"] != 200 or not got["body"]:
            continue
        xml = decode(got["body"], got["type"])
        locs = [urllib.parse.unquote(x.strip()) if "%" not in x else x.strip()
                for x in re.findall(r"<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</loc>", xml, re.S | re.I)]
        if "<sitemapindex" in xml.lower():
            subs = [normalise(x) for x in locs]
            subs = sorted((s for s in subs if s and allowed(s)), key=lambda s: -score(s))
            todo.extend(subs[:SITEMAPS])
            continue
        for loc in locs[:SITEMAP_URLS - from_maps]:
            u = normalise(loc)
            if u and allowed(u):
                from_maps += 1
                push(u, 1, bonus=4 if looks_like_product(u) else 0)
        await track.step("sitemap", files=read_maps, urls=from_maps)
    await track.step("sitemap", state="done" if from_maps else "skipped", files=read_maps, urls=from_maps,
                     **({} if from_maps else {"reason": "no sitemap with pages in it"}))

    # the pages
    await track.phase("crawling")
    await track.step("crawl", kind="crawl", pages=0, cap=max_pages, queued=len(queue))
    pages: list[dict] = []
    fetched = 0
    refused_robots = 0
    home: dict | None = None
    while queue and fetched < max_pages:
        if time.monotonic() - t_start > CRAWL_SECONDS:
            await track.step("crawl", note=f"stopped after {CRAWL_SECONDS // 60} minutes")
            break
        neg, depth, _, url, words = heapq.heappop(queue)
        if not may(url):
            refused_robots += 1
            continue
        fetched += 1
        # the first page may redirect to another site (checked like any address)
        got = await fetcher.get(url, _is_html, (lambda u: True) if url == first and home is None else allowed)
        row = _page_row(got, url, depth)
        if got["status"] == 200 and got["body"] and _is_html(got["type"]):
            final = normalise(got["url"]) or url
            seen.add(final)
            page = _page_of(got, final)
            row.update(title=page["title"][:160], chars=len(page["text"]), links=len(page["links"]),
                       product=looks_like_product(final, page["title"]))
            page.update(url=final, depth=depth, product=row["product"])
            pages.append(page)
            if home is None:
                home = page
                # the first page may have moved the site (example.com -> www.example.com.tr):
                # from here on that site is the one read, under its own robots.txt
                moved = registrable(urllib.parse.urlsplit(final).hostname or "")
                if moved != domain:
                    domain = moved
                    await track.step("robots", note=f"the site moved to {domain}")
                    await read_robots(root_of(final))
                    if not may(final):
                        await track.step("crawl", state="failed", reason=f"robots.txt of {domain} does not allow reading it")
                        raise ExploreError(f"robots.txt of {domain} does not allow reading the site")
            for link, lw in page["links"]:
                push(link, depth + 1, lw)
        pages_meta.append(row)
        await track.step("crawl", pages=fetched, read=len(pages), cap=max_pages, queued=len(queue),
                         skipped_robots=refused_robots, current=url)
        if queue and fetched < max_pages:
            await sleep(delay)
    if not pages:
        why = next((p.get("error") for p in pages_meta if p.get("error")), None) or "nothing could be read"
        await track.step("crawl", state="failed", reason=f"no page of the site could be read: {why}")
        raise ExploreError(f"no page of {domain} could be read: {why}")
    await track.step("crawl", state="done", pages=fetched, read=len(pages), queued=len(queue),
                     skipped_robots=refused_robots, current=None)
    track.add(pages=fetched, read=len(pages), docs=len(docs))
    return {"pages": pages, "domain": domain, "docs": [{"url": u, "label": _clean(w, 120)} for u, w in docs.items()],
            "home": home}


ONLY_NOTE = "only the given pages"
FOLLOW_NOTE = "only the given pages and the product pages they link to"


async def crawl_only(urls: list[str], track: Tracker, fetcher: Fetcher, follow: bool = False,
                     sleep=asyncio.sleep) -> dict:
    """Read just the pages given (1 to ONLY_MAX) - a product, or a list or
    category of them, on the maker's site or a distributor's: each under
    its own site's robots.txt (a page it forbids is not read, and the row
    says why), the sitemap skipped, no link followed - except, with
    `follow`, the product pages they link to on the same site, one link
    deep, FOLLOW_MAX at most. Returns what crawl() returns."""
    pages_meta: list[dict] = track.meta.setdefault("pages", [])
    given: list[str] = []
    for u in urls[:ONLY_MAX]:
        u = await check(u)
        if u not in given:
            given.append(u)
    if not given:
        raise ExploreError("no page to read")
    rules: dict[str, urllib.robotparser.RobotFileParser] = {}
    delay = DELAY

    async def robots_for(u: str):
        nonlocal delay
        root = _root_of(u)
        if root not in rules:
            sid = "robots" if not rules else f"robots:{len(rules) + 1}"
            dom = _domain_of(root)
            rp, _, d = await _read_robots(root, track, fetcher, lambda x: _domain_of(x) == dom, sid)
            rules[root] = rp
            delay = max(delay, d)
            await sleep(delay)
        return rules[root]

    await track.step("sitemap", kind="sitemap", state="skipped", files=0, urls=0, note=ONLY_NOTE)
    await track.phase("crawling")
    cap = len(given) + (FOLLOW_MAX if follow else 0)
    note = FOLLOW_NOTE if follow else ONLY_NOTE
    await track.step("crawl", kind="crawl", pages=0, read=0, cap=cap, queued=len(given), note=note, only=True)
    pages: list[dict] = []
    docs: dict[str, str] = {}
    seen: set[str] = set(given)
    counts = {"fetched": 0, "robots": 0}
    queue: list[tuple[str, int]] = [(u, 0) for u in given]

    async def read(url: str, depth: int) -> None:
        rp = await robots_for(url)
        if not rp.can_fetch(USER_AGENT, url):
            counts["robots"] += 1
            host = urllib.parse.urlsplit(url).hostname
            pages_meta.append({"url": url, "depth": depth, "status": None, "via": "proxy" if fetcher.via_proxy else "direct",
                               "bytes": 0, "at": _now(), "robots": True,
                               "error": f"robots.txt of {host} does not allow reading this page"})
            return
        counts["fetched"] += 1
        dom = _domain_of(url)
        got = await fetcher.get(url, _is_html, lambda x: _domain_of(x) == dom)
        row = _page_row(got, url, depth)
        if got["status"] == 200 and got["body"] and _is_html(got["type"]):
            final = normalise(got["url"]) or url
            seen.add(final)
            page = _page_of(got, final)
            row.update(title=page["title"][:160], chars=len(page["text"]), links=len(page["links"]),
                       product=depth > 0 or looks_like_product(final, page["title"]))
            page.update(url=final, depth=depth, product=row["product"])
            pages.append(page)
            for link, words in page["links"]:
                path = urllib.parse.urlsplit(link).path
                if _domain_of(link) != _domain_of(final):
                    continue
                if FILE_EXT.search(path):
                    if DOC_EXT.search(path) and len(docs) < MAX_DOCS:
                        docs.setdefault(link, words or urllib.parse.unquote(link.rsplit("/", 1)[-1]))
                    continue
                if (follow and depth == 0 and link not in seen and score(link, words) > -50
                        and looks_like_product(link, words)
                        and sum(1 for _, d in queue if d) < FOLLOW_MAX):
                    seen.add(link)
                    queue.append((link, 1))
        pages_meta.append(row)

    i = 0
    while i < len(queue):
        url, depth = queue[i]
        i += 1
        if i > 1:
            await sleep(delay)
        await read(url, depth)
        await track.step("crawl", pages=counts["fetched"], read=len(pages), cap=cap, queued=len(queue) - i,
                         skipped_robots=counts["robots"], current=url)
    if not pages:
        why = next((p.get("error") for p in pages_meta if p.get("error")), None) or "nothing could be read"
        await track.step("crawl", state="failed", reason=f"the page could not be read: {why}")
        raise ExploreError(f"the page could not be read: {why}")
    await track.step("crawl", state="done", pages=counts["fetched"], read=len(pages), queued=0,
                     skipped_robots=counts["robots"], current=None)
    track.add(pages=counts["fetched"], read=len(pages), docs=len(docs))
    return {"pages": pages, "domain": _domain_of(given[0]), "only": True, "home": pages[0],
            "docs": [{"url": u, "label": _clean(w, 120)} for u, w in docs.items()]}


# ---- what the model reads, and what it says ----------------------------------

def _boiler(pages: list[dict]) -> set[str]:
    """Lines on most pages (the menu, the footer): left out after the first page."""
    if len(pages) < 4:
        return set()
    counts: dict[str, int] = {}
    for p in pages:
        for ln in set(p["text"].split("\n")):
            counts[ln] = counts.get(ln, 0) + 1
    cut = max(3, int(len(pages) * 0.4))
    return {ln for ln, c in counts.items() if c >= cut}


def page_block(p: dict, boiler: set[str], first: bool = False, most: int = PAGE_CHARS) -> str:
    """A page as the model reads it: its address, title, kind (catalog_facts:
    one product's page, or a list), its text - a product page's without the
    related-product blocks after its own part - and its pictures, the
    product's own first."""
    f = facts_of(p)
    whole = p["text"]
    cut = f.get("related_at") if f.get("kind") == "product" else None
    if cut:
        whole = whole[:cut]
    lines = [ln for ln in whole.split("\n") if first or ln not in boiler]
    text = "\n".join(lines)
    if len(text) > most:
        text = text[:most] + "\n[... rest of the page left out]"
    elif cut:
        text += "\n[... the blocks of other products after it (related, recommended) left out]"
    head = [f"=== PAGE {p['url']}", f"Title: {p['title']}"]
    if p.get("description"):
        head.append(f"Description: {p['description']}")
    if cf.hint(f):
        head.append(cf.hint(f))
    own = (f.get("main") or {}).get("images") or []
    rest = [(u, a) for u, a in p.get("images", []) if u not in own]
    many = 20 if f.get("kind") == "list" else 8
    imgs = [f"- {u}  (this product's)" for u in own[:6]] + [
        f"- {u}" + (f"  ({a})" if a else "") for u, a in rest[:max(2, many - len(own[:6]))]
        if not (f.get("kind") == "product" and own)]
    out = "\n".join(head) + "\n" + text
    if imgs:
        out += "\nImages on the page:\n" + "\n".join(imgs)
    return out


def _own(p: dict) -> dict:
    """A product's page without the blocks of other products after its own part."""
    f = facts_of(p)
    cut = f.get("related_at") if f.get("kind") == "product" else None
    if not cut:
        return p
    return {**p, "text": p["text"][:cut] + "\n[... the blocks of other products after it (related, recommended) left out]",
            "facts": {**f, "related_at": None}}


def _parts(p: dict, size: int = PART_CHARS) -> list[dict]:
    """A long page given by hand (a list of a few hundred products) in
    parts of at most `size` characters, cut between lines, so the whole
    list reaches the model rather than its first screen."""
    text = p["text"]
    if len(text) <= size:
        return [p]
    bits: list[str] = []
    cur: list[str] = []
    n = 0
    for ln in text.split("\n"):
        ln = ln[:size]
        if cur and n + len(ln) > size:
            bits.append("\n".join(cur))
            cur, n = [], 0
        cur.append(ln)
        n += len(ln) + 1
    if cur:
        bits.append("\n".join(cur))
    return [{**p, "text": b, "title": f"{p['title']} (part {i} of {len(bits)})",
             "images": p.get("images") if i == 1 else []} for i, b in enumerate(bits, 1)]


def chunks(pages: list[dict], whole: bool = False) -> list[str]:
    """The pages in questions of at most CHUNK_CHARS: the first page (with
    the company in it) and the about pages first, then product pages,
    then the rest; pages with next to no text left out. `whole`: pages
    given by hand - each read to its end, a long one in parts."""
    if whole:
        out: list[str] = []
        cur = ""
        for p in [x for page in pages for x in _parts(_own(page))]:
            b = page_block(p, set(), first=True, most=PART_CHARS)
            if cur and len(cur) + len(b) > CHUNK_CHARS:
                out.append(cur)
                cur = ""
                if len(out) >= MAX_CHUNKS:
                    return out
            cur += ("\n\n" if cur else "") + b
        if cur and len(out) < MAX_CHUNKS:
            out.append(cur)
        return out
    boiler = _boiler(pages)
    first = pages[:1]
    rest = pages[1:]
    about = [p for p in rest if any(w in fold(p["url"]) for w in ABOUT_WORDS)]
    prod = [p for p in rest if p not in about and p.get("product")]
    other = [p for p in rest if p not in about and p not in prod]
    out: list[str] = []
    cur = ""
    for n, p in enumerate(first + about + prod + other):
        if n and len(p["text"]) < 40 and not p.get("images"):
            continue
        b = page_block(p, boiler, first=n == 0)
        if cur and len(cur) + len(b) > CHUNK_CHARS:
            out.append(cur)
            cur = ""
            if len(out) >= MAX_CHUNKS:
                break
        cur += ("\n\n" if cur else "") + b
    if cur and len(out) < MAX_CHUNKS:
        out.append(cur)
    return out


EXTRACT_PROMPT = (
    "You read pages of a manufacturer's or supplier's website, gathered by a crawler, and write down what the company "
    "makes, as a catalog an engineer can search. Reply with JSON only - no prose, no Markdown fence - one object:\n"
    "{\"company\": {\"name\": the company's name, \"description\": two to four sentences on what it makes and for "
    "whom, \"categories\": [its product categories, as the site names them]},\n"
    " \"products\": [{\"name\": the product's name as the site writes it, \"category\": its category, "
    "\"description\": one or two sentences, \"specs\": {name: value} - dimensions, sizes, materials, loads, "
    "standards, finishes, as the page gives them, \"sku\": its code or part number if the page shows one, "
    "\"url\": the page that shows it, \"image\": its picture, \"images\": [more pictures of it], "
    "\"price\": {\"amount\": a number, \"currency\": \"TRY\", \"USD\", \"EUR\"..., \"vat\": \"incl\", \"excl\" or null, "
    "\"text\": the price as the page writes it}, \"list_price\": the struck-through price before a discount (the same "
    "shape), \"stock\": \"in\", \"out\" or null, \"stock_qty\": how many are left when the page says}]}\n\n"
    "Rules:\n"
    "- Only products these pages show; a product family or series listed as one product on the site counts as one. "
    "Do not invent products, specs, codes, prices or links.\n"
    "- A page marked \"Kind: the page of ONE product\" yields that one product only - never the related, "
    "recommended, similar or recently viewed products shown on it. A page marked \"Kind: a list of products\" "
    "yields every product it lists.\n"
    "- Prices: the price the page shows for the product, as a number (Turkish pages write 1.234,56 TL: that is "
    "1234.56 TRY); \"+ KDV\" or \"KDV hariç\" means VAT is excluded (\"excl\"), \"KDV dahil\" included (\"incl\"). "
    "Leave price out when the page shows none.\n"
    "- \"url\", \"image\" and \"images\" must be addresses that appear in the pages above (a PAGE line or an image "
    "line); leave them out when there is none.\n"
    "- Keep the site's own language for names, categories and specs (Turkish stays Turkish); the company "
    "description may be in the same language.\n"
    "- Leave a field out rather than guessing. Navigation, news, contact and campaign pages are not products.\n"
    "- At most 120 products in one answer: the most specific ones first."
)
ONLY_PROMPT = (
    "These pages were picked by hand, not crawled: read them to the end. A page may be a list, a table or a category "
    "of products - write down every product it lists, each as its own entry, even when the list gives only a name, "
    "a code or a size; keep each entry short when there are many. A page of one product gives that product alone, "
    "with its price, stock and pictures. The site may be a distributor's or a shop's: the company is the one whose "
    "products these are when the page says so."
)


def _json_obj(raw: str):
    text = (raw or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    for cand in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text else "",
                 text[text.find("["): text.rfind("]") + 1] if "[" in text else ""):
        if not cand:
            continue
        try:
            return json.loads(cand)
        except ValueError:
            continue
    raise ValueError("the model did not answer with JSON")


def _url_in(u, site_urls: set[str] | None) -> str:
    u = normalise(str(u or "")) if u else None
    if not u:
        return ""
    if site_urls is not None and u not in site_urls:
        return ""
    return u[:500]


HISTORY = 10                    # price and stock readings kept on a product


def _seller(url: str, name: str = "") -> dict | None:
    """The site a product is sold on: its domain, its host, the shop's name when the page gave one."""
    h = _host(url) if url else ""
    if not h:
        return None
    out = {"domain": registrable(h), "host": h}
    if name:
        out["name"] = _clean(name, 120)
    return out


def _history(rows) -> list[dict]:
    out = []
    for h in rows if isinstance(rows, list) else []:
        if not isinstance(h, dict) or not isinstance(h.get("at"), str):
            continue
        e = {"at": h["at"][:40]}
        a = cf.amount(h.get("amount"))
        if a is not None:
            e.update(amount=a, currency=cf.currency_of(h.get("currency")), vat=cf.vat_of(h.get("vat")))
        if h.get("stock") in ("in", "out"):
            e["stock"] = h["stock"]
        if isinstance(h.get("qty"), int) and not isinstance(h.get("qty"), bool):
            e["qty"] = h["qty"]
        if isinstance(h.get("seen"), str):
            e["seen"] = h["seen"][:40]
        if len(e) > 1:
            out.append(e)
    return out[-HISTORY:]


def clean_product(raw: dict, known: set[str] | None = None) -> dict | None:
    """One product made whole, or None when it has no name. `known`, when
    given, holds the addresses the pages had: a url or image not among
    them is dropped (the model made it up). Its price ({amount, currency,
    vat, text, at}, catalog_facts.parse_price - from a number, a text like
    "362,60 TL + KDV" or such a dict), list price and stock ("in", "out",
    how many) when there are any; the dates and the readings it had are
    carried through (an edit, an import)."""
    if not isinstance(raw, dict):
        return None
    name = _clean(raw.get("name") or raw.get("title"), 200)
    if not name:
        return None
    specs_in = raw.get("specs") or raw.get("specifications") or {}
    specs: dict[str, str] = {}
    if isinstance(specs_in, dict):
        for k, v in list(specs_in.items())[:MAX_SPECS]:
            k, v = _clean(k, 60), _clean(", ".join(map(str, v)) if isinstance(v, list) else v, 200)
            if k and v:
                specs[k] = v
    elif isinstance(specs_in, list):
        for s in specs_in[:MAX_SPECS]:
            k, _, v = str(s).partition(":")
            if k.strip() and v.strip():
                specs[_clean(k, 60)] = _clean(v, 200)
    out = {"id": "", "name": name, "category": _clean(raw.get("category"), 120),
           "description": _clean(raw.get("description"), 600), "specs": specs,
           "sku": _clean(raw.get("sku") or raw.get("code"), 80),
           "url": _url_in(raw.get("url"), known), "image": _url_in(raw.get("image"), known)}
    out["id"] = hashlib.sha1(fold(f"{out['sku']}|{out['name']}|{out['url']}").encode()).hexdigest()[:10]
    ims: list[str] = []
    for u in raw.get("images") if isinstance(raw.get("images"), list) else []:
        v = _url_in(u.get("url") if isinstance(u, dict) else u if isinstance(u, str) else "", known)
        if v and v not in ims:
            ims.append(v)
    if not out["image"] and ims:
        out["image"] = ims[0]
    if out["image"] and out["image"] not in ims:
        ims.insert(0, out["image"])
    if len(ims) > 1:
        out["images"] = ims[:12]
    price = cf.parse_price(raw.get("price"), raw.get("currency") or "", raw.get("vat"))
    if price:
        out["price"] = price
    lp = cf.parse_price(raw.get("list_price"), (price or {}).get("currency") or raw.get("currency") or "")
    if lp and (not price or lp["amount"] > price["amount"]):
        out["list_price"] = {k: lp[k] for k in ("amount", "currency", "text")}
    stock, qty, words = cf.parse_stock(raw.get("stock"))
    try:
        if raw.get("stock_qty") not in (None, "") and not isinstance(raw.get("stock_qty"), bool):
            qty = max(0, int(float(str(raw["stock_qty"]).replace(",", "."))))
            stock = stock or ("in" if qty else "out")
    except ValueError:
        pass
    if stock:
        out["stock"] = stock
        if qty is not None:
            out["stock_qty"] = qty
        words = _clean(raw.get("stock_text"), 60) or words
        if words:
            out["stock_text"] = words
    for k in ("added_at", "read_at", "updated"):
        if isinstance(raw.get(k), str) and raw[k].strip():
            out[k] = _clean(raw[k], 40)
    sel = raw.get("seller")
    if isinstance(sel, dict) and sel.get("domain"):
        out["seller"] = {k: _clean(sel[k], 120) for k in ("domain", "host", "name") if sel.get(k)}
    hist = _history(raw.get("history"))
    if hist:
        out["history"] = hist
    return out


def product_key(p: dict) -> str:
    return "sku:" + fold(p["sku"]) if p.get("sku") else "name:" + fold(p["name"])


def merge_products(lists: list[list[dict]], most: int = MAX_PRODUCTS) -> tuple[list[dict], int]:
    """Every chunk's products as one catalog: the same product (by its code,
    else its name) once, its fields filled from each sighting. Returns
    (products, duplicates merged)."""
    by: dict[str, dict] = {}
    dups = 0
    for lst in lists:
        for p in lst:
            k = product_key(p)
            if k in by:
                dups += 1
                have = by[k]
                for f in ("category", "description", "sku", "url", "image", "images", "price", "list_price", "stock",
                          "stock_qty", "stock_text", "updated", "seller", "read_at", "added_at", "history"):
                    if have.get(f) in (None, "", [], {}) and p.get(f) not in (None, "", [], {}):
                        have[f] = p[f]
                for sk, sv in p.get("specs", {}).items():
                    if len(have["specs"]) < MAX_SPECS:
                        have["specs"].setdefault(sk, sv)
            elif len(by) < most:
                by[k] = {**p, "specs": dict(p.get("specs") or {})}
    return list(by.values()), dups


def _reading(p: dict, at: str) -> dict | None:
    """A product's price and stock as read at `at`: a row of its history."""
    pr = p.get("price") or {}
    if pr.get("amount") is None and not p.get("stock"):
        return None
    e: dict = {"at": at}
    if pr.get("amount") is not None:
        e.update(amount=pr["amount"], currency=pr.get("currency") or "", vat=pr.get("vat"))
    if p.get("stock"):
        e["stock"] = p["stock"]
    if p.get("stock_qty") is not None:
        e["qty"] = p["stock_qty"]
    return e


def remember(hist, entry: dict | None) -> list[dict]:
    """The readings with `entry` after them: a new row when the price or
    the stock changed, else the last row seen again (`seen`); the last
    HISTORY rows."""
    h = [dict(x) for x in hist or [] if isinstance(x, dict)]
    if entry:
        last = h[-1] if h else None
        if last and all(last.get(k) == entry.get(k) for k in ("amount", "currency", "vat", "stock", "qty")):
            last["seen"] = entry["at"]
        else:
            h.append(entry)
    return h[-HISTORY:]


_SAID = ("price", "list_price", "stock", "stock_qty", "stock_text", "updated")


def _refresh(old: dict, new: dict, at: str, keep_old: bool) -> dict:
    """A product read again: what it is - name, specs... - the old one's when
    `keep_old` (a page read adds; a product changed by hand stays as it
    was made), else the new one's; what the page says now - price, stock,
    the seller's date - always the new one's when it says it; its id, its
    first date and its readings carried on."""
    base, other = (old, new) if keep_old else (new, old)
    p = {**base, "specs": dict(base.get("specs") or {})}
    for f in ("name", "category", "description", "sku", "url", "image"):
        if not p.get(f) and other.get(f):
            p[f] = other[f]
    for sk, sv in (other.get("specs") or {}).items():
        if len(p["specs"]) < MAX_SPECS:
            p["specs"].setdefault(sk, sv)
    if new.get("images"):
        p["images"] = new["images"]
    if not keep_old and new.get("image"):
        p["image"] = new["image"]
    if new.get("price") or new.get("stock"):
        for f in _SAID:
            if new.get(f) not in (None, ""):
                p[f] = new[f]
            elif f in ("stock_qty", "stock_text") and new.get("stock"):
                p.pop(f, None)
            elif f in old:
                p[f] = old[f]
    if new.get("seller") or old.get("seller"):
        p["seller"] = new.get("seller") or old.get("seller")
    for f in ("id", "source", "added_by", "edited", "edited_by", "edited_at"):
        if f in old:
            p[f] = old[f]
        else:
            p.pop(f, None)
    p["added_at"] = old.get("added_at") or at
    p["read_at"] = at
    hist = remember(old.get("history"), _reading(new, at))
    if hist:
        p["history"] = hist
    return p


def fold_in(have: list[dict], found: list[dict], at: str, replace: bool = False) -> tuple[list[dict], int]:
    """A run's products into the catalog `have`: (catalog, how many are
    new). The same product (by its code, else its name) is read again -
    its id, its first date and its readings kept, its price and stock
    brought up to date (_refresh); a new one starts its readings. A page
    read adds (`replace` off: nothing is dropped); a full exploration
    replaces the catalog with what it found, keeping what was added or
    changed by hand."""
    index: dict[str, dict] = {}
    for p in have:
        index.setdefault(product_key(p), p)
    fresh: dict[str, dict] = {}
    added = 0
    for p in found:
        k = product_key(p)
        if k in fresh:
            continue
        old = index.get(k)
        if old is None:
            q = {**p, "added_at": p.get("added_at") or at, "read_at": p.get("read_at") or at}
            hist = remember(q.get("history"), _reading(q, at))
            if hist:
                q["history"] = hist
            added += 1
        else:
            q = _refresh(old, p, at, keep_old=(not replace) or by_hand(old))
        fresh[k] = q
    if replace:
        out = [p for p in have if by_hand(p) and product_key(p) not in fresh]
        out += list(fresh.values())
    else:
        out = [fresh.pop(product_key(p), p) for p in have]
        out += list(fresh.values())
    return out[:MAX_PRODUCTS], added


def _words_of(s: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", fold(s)) if len(w) > 1}


def _is_main(prod: dict, page: dict, f: dict) -> bool:
    """Whether the model's `prod` is the product whose page `page` is."""
    m = f["main"]
    if prod.get("sku") and m.get("sku") and fold(prod["sku"]).strip() == fold(m["sku"]).strip():
        return True
    if cf._same_name(prod.get("name") or "", m.get("name") or ""):
        return True
    here = {u for u in (page.get("url"), f.get("canonical"), m.get("url")) if u}
    if prod.get("url") in here and not (prod.get("sku") and m.get("sku")):
        a, b = _words_of(prod.get("name") or ""), _words_of(m.get("name") or "")
        return bool(a and b) and len(a & b) / len(a | b) >= 0.6
    return False


def _with_facts(prod: dict, page: dict, f: dict) -> dict:
    """The model's reading of a product's page, with what the page itself
    says of it (its structured data): its price, stock, code, pictures,
    the page and its date win."""
    m = f["main"]
    p = {**prod}
    if m.get("price"):
        p["price"] = dict(m["price"])
    if m.get("list_price"):
        p["list_price"] = {k: m["list_price"].get(k) for k in ("amount", "currency", "text")}
    if m.get("stock"):
        p["stock"] = m["stock"]
        p.pop("stock_qty", None)
        p.pop("stock_text", None)
        if m.get("qty") is not None:
            p["stock_qty"] = m["qty"]
        if m.get("stock_text"):
            p["stock_text"] = m["stock_text"]
    p["sku"] = p.get("sku") or _clean(m.get("sku"), 80)
    for k in ("description", "category"):
        if not p.get(k) and m.get(k):
            p[k] = _clean(m[k], 600 if k == "description" else 120)
    if m.get("images"):
        extra = [u for u in (prod.get("images") or []) if u not in m["images"]]
        p["images"] = (m["images"] + extra)[:12]
        p["image"] = m["images"][0]
    if m.get("url"):
        p["url"] = m["url"][:500]
    if m.get("updated"):
        p["updated"] = _clean(m["updated"], 40)
    if m.get("brand") and len(p.get("specs") or {}) < MAX_SPECS and not any(
            fold(k) in ("marka", "brand") for k in (p.get("specs") or {})):
        label = "Marka" if re.search(r"[ığüşöçİĞÜŞÖÇ]", (page.get("text") or "")[:5000]) else "Brand"
        p["specs"] = {**(p.get("specs") or {}), label: _clean(m["brand"], 200)}
    p["seller"] = _seller(page.get("url") or "", page.get("site_name") or "") or p.get("seller")
    return p


def _from_facts(page: dict, f: dict) -> dict | None:
    """A product's page the model said nothing of: its product as the page's structured data gives it."""
    m = f["main"]
    p = clean_product({"name": m.get("name"), "sku": m.get("sku"), "description": m.get("description"),
                       "category": m.get("category"), "url": m.get("url"), "image": m.get("image"),
                       "images": m.get("images"), "price": m.get("price"), "list_price": m.get("list_price"),
                       "stock": m.get("stock"), "stock_qty": m.get("qty"), "stock_text": m.get("stock_text"),
                       "updated": m.get("updated")})
    if p:
        p["seller"] = _seller(page.get("url") or "", page.get("site_name") or "")
    return p


def by_page(site: dict, products: list[dict]) -> list[dict]:
    """The model's products checked against what the pages say of
    themselves (catalog_facts). A product's page gives its main product
    - with the page's own price, stock, code and pictures - and, when
    every page read was a product's page (a page given by hand, without
    `follow`), nothing else: the related products shown on it are left
    out. A product's page the model missed gives its product all the
    same. Other pages' products stay as the model read them."""
    pages = site.get("pages") or []
    mains = [(pg, f) for pg, f in ((pg, facts_of(pg)) for pg in pages)
             if f.get("kind") == "product" and (f.get("main") or {}).get("name")]
    alone = bool(site.get("only")) and bool(pages) and len(mains) == len(pages)
    used: dict[int, int] = {}
    out: list[dict] = []
    for prod in products:
        i = next((n for n, (pg, f) in enumerate(mains) if _is_main(prod, pg, f)), None)
        if i is None:
            if not alone:
                out.append(prod)
            continue
        if i in used:
            have = out[used[i]]
            for k, v in prod.items():
                if have.get(k) in (None, "", [], {}) and v not in (None, "", [], {}):
                    have[k] = v
            continue
        used[i] = len(out)
        out.append(_with_facts(prod, *mains[i]))
    for n, (pg, f) in enumerate(mains):
        if n not in used:
            p = _from_facts(pg, f)
            if p:
                out.append(p)
    return out


def stamp(products: list[dict], at: str, page_url: str = "") -> list[dict]:
    """A run's products: when they were read, and on which site (the
    product's page's, else the run's first page's)."""
    for p in products:
        p["read_at"] = at
        if p.get("price"):
            p["price"] = {**p["price"], "at": at}
        if not p.get("seller"):
            sel = _seller(p.get("url") or page_url)
            if sel:
                p["seller"] = sel
    return products


def parse_answer(raw: str, known: set[str] | None = None) -> dict:
    """The model's answer as {company, products, rows, invalid}."""
    data = _json_obj(raw)
    if isinstance(data, list):
        data = {"products": data}
    if not isinstance(data, dict):
        raise ValueError("the model did not answer with a JSON object")
    comp = data.get("company") if isinstance(data.get("company"), dict) else {}
    cats = comp.get("categories") if isinstance(comp.get("categories"), list) else []
    rows = data.get("products") if isinstance(data.get("products"), list) else []
    prods, bad = [], 0
    for r in rows:
        p = clean_product(r, known)
        if p:
            prods.append(p)
        else:
            bad += 1
    return {"company": {"name": _clean(comp.get("name"), 120), "description": _clean(comp.get("description"), 1500),
                        "categories": [c for c in (_clean(x, 120) for x in cats) if c][:60]},
            "products": prods, "rows": len(rows), "invalid": bad}


class ExploreError(Exception):
    """What the person is told when exploring cannot run or fails."""


def _failed(prov: str, model: str, exc: BaseException, timeout: float) -> str:
    import httpx
    name = llm.PROVIDERS.get(prov, {}).get("name", prov)
    if isinstance(exc, (asyncio.TimeoutError, httpx.TimeoutException)):
        return (f"the {name} model {model} did not answer within {timeout:.0f} s - try again, or pick a faster "
                "model for Manufacturer exploration in Settings > LLM settings")
    return f"the {name} model {model} failed: {str(exc)[:300] or type(exc).__name__}"


async def extract(db, site: dict, track: Tracker) -> dict:
    """The company and its products, read from the crawled pages a chunk
    at a time: {company, products, provider, model}."""
    whole = bool(site.get("only"))
    parts = chunks(site["pages"], whole)
    if not parts:
        raise ExploreError("the pages read had no text to give the model")
    known: set[str] = set()
    for p in site["pages"]:
        known.add(p["url"])
        known.update(u for u, _ in p.get("images", []))
        known.update(u for u, _ in p.get("links", []))
        main = facts_of(p).get("main") or {}
        known.update(main.get("images") or [])
        if main.get("url"):
            known.add(main["url"])
    prov, model = llm.route(JOB)
    pname = llm.PROVIDERS.get(prov, {}).get("name", prov)
    track.add(chunks=len(parts), chars=sum(len(c) for c in parts))
    await track.phase("asking", provider=prov, model=model, provider_name=pname)
    if not llm.key(prov):
        why = llm.no_key(prov, JOB)
        await track.step("ask:1", kind="ask", n=1, of=len(parts), state="failed", reason=why)
        raise ExploreError(why)
    company: dict = {"name": "", "description": "", "categories": []}
    lists: list[list[dict]] = []
    tin = tout = 0
    cost = 0.0
    priced = False
    failures = []
    for n, chunk in enumerate(parts, 1):
        sid = f"ask:{n}"
        user = f"Website: {site['domain']}\n\n" + (f"{ONLY_PROMPT}\n\n" if whole else "") + chunk
        chars = len(EXTRACT_PROMPT) + len(user)
        await track.step(sid, kind="ask", n=n, of=len(parts), provider=prov, model=model, provider_name=pname,
                         prompt_chars=chars, tokens_est=chars // CHARS_PER_TOKEN, max_tokens=EXTRACT_TOKENS,
                         timeout=EXTRACT_TIMEOUT, pages=chunk.count("=== PAGE "), sent_at=_now())
        d = None
        for attempt in (1, 2):
            # The job's model as set now: a change in LLM settings reaches the chunks still to go.
            prov, model = llm.route(JOB)
            await track.step(sid, provider=prov, model=model, provider_name=llm.PROVIDERS.get(prov, {}).get("name", prov),
                             attempt=attempt)
            try:
                d = await llm.complete([{"role": "system", "content": EXTRACT_PROMPT}, {"role": "user", "content": user}],
                                       job=JOB, max_tokens=EXTRACT_TOKENS, temperature=0.1, timeout=EXTRACT_TIMEOUT)
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:                    # noqa: BLE001 - one chunk lost is one chunk lost
                why = _failed(prov, model, exc, EXTRACT_TIMEOUT)
                # A provider's passing trouble (a gateway timeout, a 5xx): once more, after a breath.
                if attempt == 1 and re.search(r"HTTP 5\d\d|timed out|temporarily", why):
                    await track.step(sid, note=f"{why} - trying once more")
                    await asyncio.sleep(RETRY_PAUSE)
                    continue
                failures.append(why)
                await track.step(sid, state="failed", reason=why)
        if d is None:
            continue
        prov2, model2 = d.get("provider") or prov, d.get("model") or model
        used = d.get("usage") or {}
        await llm.record(db, provider=prov2, model=model2, surface="manufacturers", kind="manufacturer", used=used)
        c = used.get("cost")
        if c is None and prov2 == "claude":
            c = llm.claude_cost(model2, used)
        if c is not None:
            cost += c
            priced = True
        tin += used.get("prompt_tokens") or 0
        tout += used.get("completion_tokens") or 0
        track.add(tokens_in=tin, tokens_out=tout, cost=round(cost, 6) if priced else None)
        content = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        try:
            got = parse_answer(content, known)
        except ValueError as exc:
            failures.append(str(exc))
            await track.step(sid, state="failed", reason=f"{exc} ({len(content):,} characters back)",
                             tokens_in=used.get("prompt_tokens"), tokens_out=used.get("completion_tokens"), cost=c)
            continue
        lists.append(got["products"])
        comp = got["company"]
        company["name"] = company["name"] or comp["name"]
        company["description"] = company["description"] or comp["description"]
        company["categories"] = list(dict.fromkeys(company["categories"] + comp["categories"]))[:60]
        await track.step(sid, state="done", tokens_in=used.get("prompt_tokens"), tokens_out=used.get("completion_tokens"),
                         cost=c, products=len(got["products"]), rows=got["rows"], invalid=got["invalid"],
                         raw_chars=len(content))
    if not lists:
        raise ExploreError(failures[0] if failures else "the model read nothing")
    await track.phase("merging")
    await track.step("merge", kind="merge", found=sum(len(x) for x in lists))
    products, dups = merge_products(lists)
    # what the pages say of themselves: a product's page gives its product (and its price, stock, pictures) only
    products = stamp(by_page(site, products), _now(), (site["pages"][0]["url"] if site.get("pages") else ""))
    products, more = merge_products([products])
    dups += more
    # the categories the products name, after the ones the company says
    cats = list(dict.fromkeys(company["categories"] + [p["category"] for p in products if p["category"]]))[:80]
    company["categories"] = cats
    await track.step("merge", state="done", found=sum(len(x) for x in lists), duplicates=dups, products=len(products),
                     categories=len(cats))
    track.add(products=len(products), duplicates=dups)
    return {"company": company, "products": products, "provider": prov, "model": model}


# ---- manufacturers -----------------------------------------------------------

def _host(url: str) -> str:
    h = urllib.parse.urlsplit(url).hostname or ""
    return h[4:] if h.startswith("www.") else h


async def create(db, url: str, name: str = "", notes: str = "", route=None, by: dict | None = None) -> dict:
    """A new maker. `route`: its own order of routes, or None (or "default")
    to follow the Product Catalog's default order."""
    u = normalise(url if "://" in url else "https://" + url.strip())
    if not u:
        raise ValueError("give the site's address, like https://www.example.com")
    now = _now()
    doc = {"_id": secrets.token_hex(6), "name": _clean(name, 120) or _host(u), "name_auto": not _clean(name, 120),
           "url": u, "domain": registrable(urllib.parse.urlsplit(u).hostname or ""), "notes": _clean_notes(notes),
           "summary": "", "categories": [], "products": [], "docs": [], "route": own_route(route),
           "by": by or actors.current(), "created_at": now, "updated_at": now, "explored_at": None, "last_job": None}
    await db[COLL].insert_one(doc)
    return doc


def _clean_notes(s) -> str:
    return str(s or "").strip()[:4000]


async def get(db, mid: str) -> dict | None:
    return await db[COLL].find_one({"_id": mid})


async def listing(db, q: str = "") -> list[dict]:
    rows = [d async for d in db[COLL].find({})]
    words = [fold(w) for w in q.split() if w]
    if words:
        def hay(d):
            return fold(" ".join([d.get("name") or "", d.get("domain") or "", d.get("summary") or "",
                                  d.get("notes") or "", " ".join(d.get("categories") or [])]))
        rows = [d for d in rows if all(w in hay(d) for w in words)]
    rows.sort(key=lambda d: fold(d.get("name") or ""))
    return rows


async def patch(db, mid: str, sets: dict) -> dict | None:
    from pymongo import ReturnDocument
    clean: dict = {}
    if sets.get("name") is not None:
        clean["name"], clean["name_auto"] = _clean(sets["name"], 120), False
    if sets.get("notes") is not None:
        clean["notes"] = _clean_notes(sets["notes"])
    if sets.get("summary") is not None:
        clean["summary"] = str(sets["summary"]).strip()[:3000]
    if sets.get("route") is not None:
        clean["route"] = own_route(sets["route"])
    if sets.get("url"):
        u = normalise(sets["url"] if "://" in sets["url"] else "https://" + sets["url"].strip())
        if not u:
            raise ValueError("give the site's address, like https://www.example.com")
        clean["url"], clean["domain"] = u, registrable(urllib.parse.urlsplit(u).hostname or "")
    if not clean:
        return await get(db, mid)
    return await db[COLL].find_one_and_update({"_id": mid}, {"$set": {**clean, "updated_at": _now()}},
                                              return_document=ReturnDocument.AFTER)


async def remove(db, mid: str) -> bool:
    """The manufacturer, and its runs and their kept pages with it (a
    running one cancelled first), so no run is left without its maker."""
    for j in [d async for d in db[JOBS].find({"manufacturer.id": mid})]:
        if j.get("status") in ACTIVE:
            await cancel_job(db, j["_id"])
    gone = bool((await db[COLL].delete_one({"_id": mid})).deleted_count)
    await db[JOBS].delete_many({"manufacturer.id": mid})
    await db[PAGES].delete_many({"manufacturer": mid})
    return gone


# ---- products added by hand --------------------------------------------------

class Clash(Exception):
    """A product with the same code (or, without one, the same name) is already in the catalog."""


def manual_product(fields: dict) -> dict:
    """A product as the person typed it, in the extractor's shape
    (clean_product): specs as {name: value} or "name: value" lines, the
    page and the picture as http(s) addresses."""
    raw = dict(fields)
    specs = raw.get("specs")
    if isinstance(specs, str):
        raw["specs"] = [ln for ln in specs.splitlines() if ln.strip()]
    for k, what in (("url", "page"), ("image", "image")):
        v = str(raw.get(k) or "").strip()
        if v:
            u = normalise(v if "://" in v else "https://" + v)
            if not u:
                raise ValueError(f"the {what} address must be an http(s) address")
            raw[k] = u
    if raw.get("price") not in (None, "") and not isinstance(raw.get("price"), dict) \
            and not cf.parse_price(raw["price"], raw.get("currency") or "", raw.get("vat")):
        raise ValueError(f"the price {str(raw['price'])[:40]!r} is not a price - give a number, like 362,60")
    if raw.get("list_price") not in (None, "") and not cf.parse_price(raw["list_price"], raw.get("currency") or ""):
        raise ValueError(f"the list price {str(raw['list_price'])[:40]!r} is not a price")
    p = clean_product(raw)
    if not p:
        raise ValueError("give the product a name")
    if p.get("price") and not p["price"].get("at"):
        p["price"]["at"] = _now()
    if not p.get("seller") and p.get("url"):
        p["seller"] = _seller(p["url"])
    return p


def _clashes(products: list[dict], p: dict, but: str | None = None) -> dict | None:
    k = product_key(p)
    return next((x for x in products if x.get("id") != but and product_key(x) == k), None)


async def add_product(db, mid: str, fields: dict, by: dict | None = None) -> dict:
    doc = await get(db, mid)
    if not doc:
        raise LookupError(f"no manufacturer {mid}")
    p = manual_product(fields)
    have = doc.get("products") or []
    if _clashes(have, p):
        raise Clash(f"\"{p['name']}\" is already in the catalog" + (f" (code {p['sku']})" if p["sku"] else ""))
    if len(have) >= MAX_PRODUCTS:
        raise ValueError(f"the catalog is full ({MAX_PRODUCTS} products)")
    who = by or actors.current()
    p.update(id="m" + secrets.token_hex(5), source="manual", added_by={"id": who.get("id"), "name": who.get("name")},
             added_at=_now())
    hist = remember([], _reading(p, p["added_at"]))
    if hist:
        p["history"] = hist
    await db[COLL].update_one({"_id": mid}, {"$set": {"products": have + [p], "updated_at": _now()}})
    return p


async def edit_product(db, mid: str, pid: str, fields: dict, by: dict | None = None) -> dict:
    """A product changed by hand - one the run found, or one added by hand.
    Either way it is kept through the next full exploration."""
    doc = await get(db, mid)
    if not doc:
        raise LookupError(f"no manufacturer {mid}")
    have = doc.get("products") or []
    old = next((x for x in have if x.get("id") == pid), None)
    if not old:
        raise LookupError(f"no product {pid}")
    f = {k: v for k, v in fields.items() if v is not None}
    was = old.get("price") or {}
    if any(k in f for k in ("price", "currency", "vat")):
        # A price changed by hand: the number given (or the one kept), in the currency and VAT given (or kept).
        val = f.get("price", was.get("amount") if was else None)
        if isinstance(val, dict):
            val = val.get("amount", val.get("text"))
        if val in (None, ""):
            f["price"] = ""
        else:
            pr = cf.parse_price(val, f.get("currency") or was.get("currency") or "", f.get("vat") or None)
            if not pr:
                raise ValueError(f"the price {str(val)[:40]!r} is not a price - give a number, like 362,60")
            if pr["vat"] is None and "vat" not in f:
                pr["vat"] = was.get("vat")
            same = was and pr["amount"] == was.get("amount") and pr["currency"] == (was.get("currency") or "") \
                and pr["vat"] == was.get("vat")
            f["price"] = {**pr, "text": was.get("text", "") if same else "", "at": was.get("at") if same else _now()}
            if same and was.get("gross"):
                f["price"]["gross"] = was["gross"]
    if "stock" in f and (cf.parse_stock(f["stock"])[0] != old.get("stock") or not f["stock"]):
        f.setdefault("stock_qty", "")                   # a stock changed by hand: the site's words and count go with it
        f["stock_text"] = ""
    p = manual_product({**old, **f})
    if _clashes(have, p, pid):
        raise Clash(f"\"{p['name']}\" is already in the catalog" + (f" (code {p['sku']})" if p["sku"] else ""))
    who = by or actors.current()
    keep = {k: old[k] for k in ("source", "added_by", "added_at") if k in old}
    p.update(id=pid, **keep, edited=True, edited_by={"id": who.get("id"), "name": who.get("name")}, edited_at=_now())
    now = _reading(p, p["edited_at"])
    then = _reading(old, "")
    if now and (not then or any(now.get(k) != then.get(k) for k in ("amount", "currency", "vat", "stock", "qty"))):
        p["history"] = remember(old.get("history"), now)
    await db[COLL].update_one({"_id": mid}, {"$set": {"products": [p if x.get("id") == pid else x for x in have],
                                                      "updated_at": _now()}})
    return p


async def delete_products(db, mid: str, ids: list[str]) -> int:
    doc = await get(db, mid)
    if not doc:
        raise LookupError(f"no manufacturer {mid}")
    have = doc.get("products") or []
    drop = set(ids)
    left = [x for x in have if x.get("id") not in drop]
    if len(left) != len(have):
        await db[COLL].update_one({"_id": mid}, {"$set": {"products": left, "updated_at": _now()}})
    return len(have) - len(left)


def by_hand(p: dict) -> bool:
    """Added or changed by hand: kept when a full exploration replaces the catalog."""
    return p.get("source") == "manual" or bool(p.get("edited"))


# ---- searching the catalogs --------------------------------------------------

def _phay(p: dict) -> str:
    return fold(" ".join([p.get("name") or "", p.get("category") or "", p.get("description") or "", p.get("sku") or "",
                          " ".join(f"{k} {v}" for k, v in (p.get("specs") or {}).items())]))


def search(docs: list[dict], q: str = "", category: str = "", limit: int = 50) -> list[tuple[dict, dict, int]]:
    """Products across `docs` matching the words of `q` (any of them; those
    with every word first, then the most) and the category: [(maker,
    product, hits)]. Accents and Turkish letters fold away."""
    words = [fold(w) for w in re.split(r"[\s,;/]+", q or "") if len(w) > 0]
    cat = fold(category).strip()
    out = []
    for d in docs:
        for p in d.get("products") or []:
            if cat and cat not in fold(p.get("category") or "") and cat not in fold(p.get("name") or ""):
                continue
            if words:
                hay = _phay(p)
                name = fold(p.get("name") or "")
                hits = sum(1 for w in words if w in hay)
                if not hits:
                    continue
                rank = hits * 10 + sum(3 for w in words if w in name) + (100 if hits == len(words) else 0)
            else:
                rank = 1
            out.append((d, p, rank))
    out.sort(key=lambda x: (-x[2], fold(x[1].get("name") or "")))
    return out[:limit]


def spec_line(p: dict, n: int = 6) -> str:
    return "; ".join(f"{k}: {v}" for k, v in list((p.get("specs") or {}).items())[:n])


def product_line(p: dict, specs: int = 8, stock: dict | None = None) -> str:
    """A product in a line. With `stock` (backend/inventory.py `stock_of`,
    this manufacturer's: {product id: on hand}) - as the Chat's tools read
    it - the line starts with the product's id and says what is on hand."""
    bits = [p["name"]]
    if p.get("sku"):
        bits.append(f"code {p['sku']}")
    if p.get("category"):
        bits.append(f"[{p['category']}]")
    if p.get("price"):
        bits.append("price " + cf.price_label(p["price"]) + (f" (read {p['price']['at'][:10]})" if p["price"].get("at") else ""))
    if p.get("stock"):
        bits.append(("in stock" if p["stock"] == "in" else "out of stock") + (
            f": {p['stock_qty']} left" if p.get("stock_qty") is not None and p["stock"] == "in" else "") + " on the site")
    if (p.get("seller") or {}).get("domain"):
        bits.append(f"sold on {p['seller']['domain']}")
    line = " · ".join(bits)
    if p.get("description"):
        line += f" - {p['description']}"
    if p.get("specs"):
        line += f" ({spec_line(p, specs)})"
    if p.get("url"):
        line += f" <{p['url']}>"
    if stock is not None:
        have = stock.get(p.get("id"))
        line = f"[{p.get('id')}] {line}" + (
            f" [in stock: {have['quantity']:g} {have['unit']}{' - LOW' if have.get('low') else ''}]" if have else "")
    return line


def block(d: dict, limit: int = 30_000, stock: dict | None = None) -> str:
    """A manufacturer as an agent reads it: who they are, the person's
    notes, the categories and the catalog; clipped to `limit`."""
    lines = [f"Manufacturer \"{d.get('name')}\" ({d.get('url')})"]
    if d.get("notes"):
        lines.append(f"The person's notes on them: {d['notes']}")
    if d.get("summary"):
        lines.append(f"What they make: {d['summary']}")
    if d.get("categories"):
        lines.append("Categories: " + ", ".join(d["categories"]))
    prods = d.get("products") or []
    lines.append(f"Catalog ({len(prods)} products, as read from their site{', explored ' + d['explored_at'][:10] if d.get('explored_at') else ''}):")
    if not prods:
        lines.append("(no products yet - the site has not been explored, or nothing was found)")
    for p in prods:
        lines.append("- " + product_line(p, stock=stock))
    if d.get("docs"):
        lines.append("Documents linked on the site: " + ", ".join(f"{x['label']} <{x['url']}>" for x in d["docs"][:15]))
    text = "\n".join(lines)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit("\n", 1)[0]
    return cut + f"\n[... {len(prods) - cut.count(chr(10) + '- ')} more products left out - search for them by words]"


# ---- exploring as a job ------------------------------------------------------
#
# The same shape as a taste extraction (backend/taste.py, "extraction as a
# job"): POST writes the job down and answers at once; an asyncio task of
# this process does the work and writes each step; a job whose task is
# gone (uvicorn --reload, a restart) is settled as failed with GONE the
# next time it is read.

ACTIVE = ("queued", "crawling", "asking", "merging")
JOB_BEAT = 5.0
JOB_LOST = 45.0
KEEP_JOBS = 60
RETRY_PAUSE = 8.0                # seconds before a chunk is asked once more after a provider's passing failure
GONE = "the exploration was interrupted (the server restarted) - run it again"
WORKER = {"host": socket.gethostname(), "pid": os.getpid(), "boot": secrets.token_hex(6)}
_TASKS: dict[str, asyncio.Task] = {}
_CANCEL: set[str] = set()


class JobTracker(Tracker):
    def __init__(self, db, jid: str):
        super().__init__()
        self.status = "crawling"
        self.db, self.jid = db, jid

    def fields(self) -> dict:
        return {"status": self.status, "steps": self.steps, "totals": self.totals, **self.meta}

    async def flush(self) -> None:
        res = await self.db[JOBS].update_one({"_id": self.jid, "status": {"$in": list(ACTIVE)}},
                                             {"$set": {**self.fields(), "beat": _now()}})
        if not getattr(res, "matched_count", 1):
            raise Stopped(self.jid)


def orphaned(job: dict, at: str | None = None) -> bool:
    t = _TASKS.get(job["_id"])
    if job.get("status") not in ACTIVE or (t and not t.done()):
        return False
    w = job.get("worker") or {}
    if w.get("boot") == WORKER["boot"]:
        return True
    if w.get("host") == WORKER["host"] and w.get("pid") and not _pid_alive(w["pid"]):
        return True
    quiet = _seconds(job.get("beat") or job.get("started_at"), at)
    return quiet is None or quiet > JOB_LOST


async def _end(db, jid: str, status: str, sets: dict) -> bool:
    now = _now()
    doc = await db[JOBS].find_one({"_id": jid})
    if not doc or doc.get("status") not in ACTIVE:
        return False
    sets = {"status": status, "finished_at": now, "seconds": _seconds(doc.get("started_at"), now), **sets}
    res = await db[JOBS].update_one({"_id": jid, "status": {"$in": list(ACTIVE)}}, {"$set": sets})
    return bool(getattr(res, "matched_count", 1))


async def settle(db, job: dict | None) -> dict | None:
    if job and orphaned(job):
        await _end(db, job["_id"], "failed", {"error": GONE, "steps": _closed(job.get("steps"), "failed", GONE)})
        job = await db[JOBS].find_one({"_id": job["_id"]})
    return job


async def _proxy_price(db) -> float:
    from . import netproxy
    price = float(netproxy._conf.get("price_per_gb", 3.99) or 0)
    try:
        from . import costs
        got = costs.derived(await costs.get(db))["proxy_per_gb"]
        price = got if got is not None else price
    except Exception:                                   # noqa: BLE001
        pass
    return price


async def _traffic(db, fetcher: Fetcher, track: Tracker) -> None:
    """What went each way, and - through the proxy's meter - what the
    proxy carried on the wire and what that costs."""
    from . import netmeter
    s = fetcher.stats
    t = {"requests_direct": s["direct"]["requests"], "bytes_direct": s["direct"]["bytes"],
         "requests_proxy": s["proxy"]["requests"], "bytes_proxy": s["proxy"]["bytes"],
         "refused": s["direct"]["refused"] + s["proxy"]["refused"], "refused_direct": s["direct"]["refused"]}
    if fetcher.rescued_jina:
        t["rescued_jina"] = fetcher.rescued_jina
    if fetcher.switched_at:
        t["proxy_since"] = fetcher.switched_at
    j = s.get("jina") or {}
    if j.get("requests"):
        t.update(requests_jina=j["requests"], bytes_jina=j["bytes"], tokens_jina=j["tokens"], failed_jina=j["failed"])
        t["refused"] += j["refused"]
    if fetcher.jina_since:
        t["jina_since"] = fetcher.jina_since
    if fetcher.session and s["proxy"]["requests"]:
        await asyncio.sleep(1.0)                        # the meter closes its books a moment after the tunnel
        wire = netmeter.session_bytes(fetcher.session) or {}
        up = sum(v.get("up", 0) for v in wire.values())
        down = sum(v.get("down", 0) for v in wire.values())
        if up or down:
            t.update(wire_up=up, wire_down=down, proxy_cost=round((up + down) / 1e9 * await _proxy_price(db), 6))
    track.add(**t)


async def keep_pages(db, jid: str, mid: str, site: dict) -> int:
    """A run's pages as read, one row each, so its model step can be run again."""
    rows = [{"_id": f"{jid}:{i}", "job": jid, "manufacturer": mid, "n": i, "domain": site.get("domain"),
             "page": {**{k: p.get(k) for k in ("url", "title", "text", "links", "images", "depth", "site_name")},
                      "facts": facts_of(p)}}
            for i, p in enumerate(site.get("pages") or [])]
    if rows:
        await db[PAGES].insert_many(rows)
    await db[JOBS].update_one({"_id": jid}, {"$set": {"kept_pages": len(rows)}})
    return len(rows)


async def load_pages(db, jid: str) -> dict | None:
    rows = [d async for d in db[PAGES].find({"job": jid})]
    if not rows:
        return None
    rows.sort(key=lambda d: d.get("n", 0))
    job = await db[JOBS].find_one({"_id": jid}) or {}
    return {"pages": [d["page"] for d in rows], "domain": rows[0].get("domain"),
            "docs": [], "from_job": jid, "from_at": job.get("started_at")}


async def _work(db, jid: str, mid: str, choice: str, reuse: str | None = None) -> None:
    from . import netproxy
    track = JobTracker(db, jid)

    async def beat():
        while True:
            await asyncio.sleep(JOB_BEAT)
            try:
                await db[JOBS].update_one({"_id": jid, "status": {"$in": list(ACTIVE)}}, {"$set": {"beat": _now()}})
            except Exception:                           # noqa: BLE001
                pass

    beating = asyncio.create_task(beat())
    fetcher = None
    try:
        jd = await db[JOBS].find_one({"_id": jid}) or {}
        page_run = jd.get("kind") == "page"
        doc = await get(db, mid)
        if not doc:
            raise ExploreError("the manufacturer was deleted")
        if reuse:
            # The model step again, on the pages an earlier run read: the site is not fetched.
            site = await load_pages(db, reuse)
            if not site:
                raise ExploreError("that run's pages are no longer kept - explore the site again")
            site["only"] = page_run
            n = len(site["pages"])
            site["docs"] = doc.get("docs") or []
            await track.step("crawl", kind="crawl", state="done", pages=n, read=n, cap=n,
                             note=f"the pages of the run of {str(site.get('from_at') or '')[:16].replace('T', ' ')}, read again - the site was not fetched")
        else:
            await track.phase("crawling")
            try:
                fetcher = Fetcher(choice, netproxy.new_session())
            except Refused as exc:
                raise ExploreError(str(exc)) from exc
            try:
                site = await crawl(doc["url"], track, fetcher, only=jd.get("only") if page_run else None,
                                   follow=bool(jd.get("follow")))
            except Refused as exc:
                await track.step("robots", kind="robots", state="failed", reason=str(exc))
                raise ExploreError(str(exc)) from exc
            finally:
                await _traffic(db, fetcher, track)
            try:
                await keep_pages(db, jid, mid, site)
            except Exception:                           # noqa: BLE001 - not keeping them only costs a re-fetch later
                log.exception("keeping the pages of run %s", jid)
        got = await extract(db, site, track)
        if page_run and not got["products"]:
            raise ExploreError("the model found no products on the page")
        if not got["products"] and not got["company"]["description"]:
            raise ExploreError("the model found no products and no description on the pages read")
        doc = await get(db, mid)
        if not doc:
            raise ExploreError("the manufacturer was deleted while it was explored")
        have = doc.get("products") or []
        if page_run:
            # A page read by hand adds to the catalog: nothing in it is dropped; a product read again is brought up to date.
            merged, added = fold_in(have, got["products"], _now())
            sets = {"products": merged, "summary": doc.get("summary") or got["company"]["description"] or "",
                    "categories": list(dict.fromkeys((doc.get("categories") or []) + got["company"]["categories"]))[:80],
                    "docs": list({d["url"]: d for d in (doc.get("docs") or []) + (site.get("docs") or [])}.values())[:MAX_DOCS],
                    "explored_at": _now(), "updated_at": _now()}
        else:
            sets = {"summary": got["company"]["description"] or doc.get("summary") or "",
                    "categories": got["company"]["categories"] or doc.get("categories") or [],
                    "docs": site["docs"] or doc.get("docs") or [], "domain": site["domain"] or doc.get("domain"),
                    "explored_at": _now(), "updated_at": _now()}
            if got["products"] or not have:
                # The site's catalog replaces the old one; what was added or changed by hand stays,
                # and a product found again keeps its id, its first date and its price readings.
                sets["products"], _ = fold_in(have, got["products"], _now(), replace=True)
            if doc.get("name_auto") and got["company"]["name"]:
                sets["name"] = got["company"]["name"][:120]
            added = None
        await db[COLL].update_one({"_id": mid}, {"$set": sets})
        await track.step("done", kind="done", state="done", products=len(got["products"]),
                         categories=len(got["company"]["categories"]),
                         **({"added": added, "catalog": len(sets["products"])} if page_run else {}))
        await _end(db, jid, "done", {**track.fields(), "status": "done", "provider": got["provider"],
                                     "model": got["model"], "products_found": len(got["products"])})
    except Stopped:
        pass
    except asyncio.CancelledError:
        cancelled = jid in _CANCEL
        why = None if cancelled else GONE
        track.close_running("cancelled" if cancelled else "failed", why)
        try:
            await asyncio.shield(_end(db, jid, "cancelled" if cancelled else "failed",
                                      {"steps": track.steps, "totals": track.totals, "pages": track.meta.get("pages", []),
                                       "error": why}))
        except BaseException:                           # noqa: BLE001
            pass
        raise
    except ExploreError as exc:
        why = str(exc).strip("'\"")
        track.close_running("failed", why)
        await _end(db, jid, "failed", {**track.fields(), "status": "failed", "error": why})
    except Exception as exc:                            # noqa: BLE001
        log.exception("manufacturer exploration %s failed", jid)
        why = f"the exploration stopped: {str(exc)[:300] or type(exc).__name__}"
        track.close_running("failed", why)
        await _end(db, jid, "failed", {**track.fields(), "status": "failed", "error": why})
    finally:
        beating.cancel()
        if fetcher:
            await fetcher.close()
        _TASKS.pop(jid, None)
        _CANCEL.discard(jid)


async def _maker_ids(db) -> set[str]:
    return {d["_id"] async for d in db[COLL].find({}, {"_id": 1})}


async def jobs(db, limit: int = 20, mid: str | None = None) -> list[dict]:
    """The latest runs (of one manufacturer); a run whose manufacturer is
    gone is left out."""
    rows = [d async for d in db[JOBS].find({"manufacturer.id": mid} if mid else {})]
    if not mid:
        makers = await _maker_ids(db)
        rows = [d for d in rows if (d.get("manufacturer") or {}).get("id") in makers]
    rows.sort(key=lambda d: d.get("started_at") or "", reverse=True)
    return [await settle(db, d) for d in rows[:limit]]


async def job(db, jid: str) -> dict | None:
    return await settle(db, await db[JOBS].find_one({"_id": jid}))


async def delete_run(db, jid: str) -> None:
    """A finished run, and the pages it kept."""
    await db[JOBS].delete_one({"_id": jid})
    await db[PAGES].delete_many({"job": jid})


async def _prune(db) -> None:
    """The oldest finished runs past KEEP_JOBS, and every finished run whose
    manufacturer is gone, with their kept pages."""
    rows = [d async for d in db[JOBS].find({}, {"status": 1, "started_at": 1, "manufacturer.id": 1})]
    makers = await _maker_ids(db)
    done = sorted((d for d in rows if d.get("status") not in ACTIVE),
                  key=lambda d: d.get("started_at") or "", reverse=True)
    orphans = [d for d in done if (d.get("manufacturer") or {}).get("id") not in makers]
    kept = [d for d in done if d not in orphans]
    for d in orphans + kept[KEEP_JOBS:]:
        await delete_run(db, d["_id"])


async def start_job(db, mid: str, route=None, by: dict | None = None,
                    reuse: str | None = None, only: list[str] | None = None, follow: bool = False) -> tuple[dict, bool]:
    """Explore a manufacturer's site (in the background): (job, started).
    One already running for it is that run. With `only`, just those pages
    are read ("page" run) and what they hold is added to the catalog; read
    again (`reuse`), a run is of the kind the run it reads was. `route`:
    None keeps the maker's own order (or the default it follows), "default"
    or a list of routes is kept as its choice from now on."""
    doc = await get(db, mid)
    if not doc:
        raise LookupError(f"no manufacturer {mid}")
    for d in await jobs(db, KEEP_JOBS + 10, mid):
        if d and d.get("status") in ACTIVE:
            return d, False
    own = maker_route(doc) if route is None else own_route(route)
    if reuse:
        try:
            choice = run_plan(own)
        except ValueError:
            choice = ["local"]                          # read again: the site is not fetched
    else:
        choice = run_plan(own)
    if route is not None or "proxy" in doc:
        await db[COLL].update_one({"_id": mid}, {"$set": {"route": own}, "$unset": {"proxy": ""}})
    kind = "page" if only else "site"
    if reuse:
        was = await db[JOBS].find_one({"_id": reuse}) or {}
        kind, only, follow = was.get("kind") or "site", was.get("only"), bool(was.get("follow"))
    limits = {"pages": MAX_PAGES, "depth": MAX_DEPTH, "delay": DELAY}
    if kind == "page":
        limits = {"pages": len(only or []) + (FOLLOW_MAX if follow else 0), "depth": 1 if follow else 0, "delay": DELAY}
    prov, model = llm.route(JOB)
    now = _now()
    jd = {"_id": secrets.token_hex(6), "status": "queued", "kind": kind,
          **({"only": list(only or []), "follow": bool(follow)} if kind == "page" else {}),
          "manufacturer": {"id": mid, "name": doc.get("name") or "", "url": doc.get("url"), "domain": doc.get("domain")},
          "by": by or actors.current(), "started_at": now, "finished_at": None, "beat": now, "worker": WORKER,
          "provider": prov, "model": model, "provider_name": llm.PROVIDERS.get(prov, {}).get("name", prov),
          "route": choice, "route_default": own is None, "limits": limits,
          "steps": [], "totals": {}, "pages": [], "error": None, "products_found": None, "reused": reuse}
    await db[JOBS].insert_one(jd)
    await db[COLL].update_one({"_id": mid}, {"$set": {"last_job": jd["_id"]}})
    _TASKS[jd["_id"]] = asyncio.create_task(_work(db, jd["_id"], mid, choice, reuse))
    try:
        await _prune(db)
    except Exception:                                   # noqa: BLE001
        pass
    return jd, True


async def cancel_job(db, jid: str, who: dict | None = None) -> dict | None:
    d = await job(db, jid)
    if not d or d.get("status") not in ACTIVE:
        return d
    _CANCEL.add(jid)
    await _end(db, jid, "cancelled", {"error": None, "cancelled_by": who or actors.current(),
                                     "steps": _closed(d.get("steps"), "cancelled", None)})
    t = _TASKS.get(jid)
    if t:
        t.cancel()
    return await db[JOBS].find_one({"_id": jid})


def job_route(d: dict) -> list[str]:
    """The routes a run went by; a run from before the orders kept a mode."""
    from . import netroutes
    return netroutes.clean(CONSUMER, d.get("route") if "route" in d else d.get("proxy")) or ["local"]


def job_out(d: dict, full: bool = True) -> dict:
    keep = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "worker", "beat", "pages", "proxy")}
    out = {**keep, "id": d["_id"], "now": _now(), "page_count": len(d.get("pages") or []),
           "route": job_route(d), "route_default": bool(d.get("route_default")),
           "seconds": d.get("seconds") if d.get("finished_at") else _seconds(d.get("started_at"))}
    if full:
        out["pages"] = d.get("pages") or []
    return out


# ---- the API -----------------------------------------------------------------

def out(d: dict, last: dict | None = None, full: bool = True) -> dict:
    keep = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "products", "proxy")}
    o = {**keep, "id": d["_id"], "product_count": len(d.get("products") or []), "route": maker_route(d),
         "categories": d.get("categories") or [], "docs": d.get("docs") or [],
         "last_run": ({"id": last["_id"], "status": last.get("status"), "started_at": last.get("started_at"),
                       "finished_at": last.get("finished_at"), "error": last.get("error"),
                       "pages": len(last.get("pages") or []), "products": last.get("products_found"),
                       "kept_pages": last.get("kept_pages") or 0, "kind": last.get("kind") or "site"} if last else None)}
    if full:
        o["products"] = d.get("products") or []
    return o


async def _lasts(db) -> dict[str, dict]:
    got: dict[str, dict] = {}
    for j in await jobs(db, KEEP_JOBS):
        if j and (j.get("manufacturer") or {}).get("id") not in got:
            got[j["manufacturer"]["id"]] = j
    return got


def _404(mid: str):
    raise HTTPException(404, f"no manufacturer {mid}")


class MakerIn(BaseModel):
    url: str = Field(min_length=3, max_length=500)
    name: str = Field(default="", max_length=120)
    notes: str = Field(default="", max_length=4000)
    # The maker's own order of routes (local, proxy, jina), or "default" for the Product Catalog's.
    route: list[str] | str | None = None
    explore: bool = True
    only: bool = False              # the address is one page to read, not a site to explore
    follow: bool = False            # ...and the product pages it links to


class MakerPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    notes: str | None = Field(default=None, max_length=4000)
    summary: str | None = Field(default=None, max_length=3000)
    url: str | None = Field(default=None, min_length=3, max_length=500)
    # The maker's own order of routes (local, proxy, jina), or "default" for the Product Catalog's.
    route: list[str] | str | None = None


class ExploreIn(BaseModel):
    # The maker's own order of routes (local, proxy, jina), or "default" for the Product Catalog's.
    route: list[str] | str | None = None


class ReadPageIn(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=ONLY_MAX)
    follow: bool = False
    # The maker's own order of routes (local, proxy, jina), or "default" for the Product Catalog's.
    route: list[str] | str | None = None


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(default="", max_length=120)
    sku: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=600)
    specs: dict[str, str] | list[str] | str | None = None
    url: str = Field(default="", max_length=500)
    image: str = Field(default="", max_length=500)
    # its price: a number or a text ("362,60", "362,60 TL + KDV"), the currency (TRY, USD...), VAT incl/excl
    price: float | str | dict | None = None
    currency: str = Field(default="", max_length=8)
    vat: str | None = Field(default=None, max_length=12)
    list_price: float | str | None = None
    stock: str | bool | int | None = None           # "in", "out", "" - or the site's words ("Son 3 adet")
    stock_qty: int | str | None = None


class ProductPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category: str | None = Field(default=None, max_length=120)
    sku: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=600)
    specs: dict[str, str] | list[str] | str | None = None
    url: str | None = Field(default=None, max_length=500)
    image: str | None = Field(default=None, max_length=500)
    price: float | str | dict | None = None          # "" takes the price away
    currency: str | None = Field(default=None, max_length=8)
    vat: str | None = Field(default=None, max_length=12)
    list_price: float | str | None = None
    stock: str | bool | int | None = None            # "" takes the stock away
    stock_qty: int | str | None = None


class ProductIds(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=MAX_PRODUCTS)


async def _pages_given(urls: list[str]) -> list[str]:
    """The pages to read, each checked as any fetch is; 400 for one that may not be."""
    out: list[str] = []
    for u in urls:
        u = u.strip()
        if not u:
            continue
        try:
            u = await check(u if "://" in u else "https://" + u)
        except Refused as exc:
            raise HTTPException(400, f"{u}: {exc}") from exc
        if u not in out:
            out.append(u)
    if not out:
        raise HTTPException(400, "give the page's address, like https://www.example.com/products/hinges")
    return out[:ONLY_MAX]


@router.get("")
async def api_list(q: str = ""):
    db = _db()
    lasts = await _lasts(db)
    return [out(d, lasts.get(d["_id"]), full=False) for d in await listing(db, q[:200])]


def _route_in(value):
    """A route choice from a page: "default", or a list of this crawler's routes; 400 otherwise."""
    from . import netroutes
    if value is None or value == DEFAULT:
        return value
    if isinstance(value, str) or len(value) > len(netroutes.ROUTES) or any(r not in netroutes.CONSUMERS[CONSUMER] for r in value) or not own_route(value):
        raise HTTPException(400, f"a route order is \"default\" or a list of {', '.join(netroutes.CONSUMERS[CONSUMER])}")
    return value


@router.get("/proxy")
async def api_proxy():
    """How a run may go out: the proxy of Settings > Proxy & Data, and Jina, set up or not."""
    return proxy_state()


@router.get("/search")
async def api_search(q: str = "", category: str = "", m: str = "", limit: int = 50):
    db = _db()
    docs = [d for d in await listing(db) if not m or d["_id"] == m]
    rows = search(docs, q[:200], category[:120], max(1, min(limit, 200)))
    return [{"manufacturer": {"id": d["_id"], "name": d.get("name")}, "product": p} for d, p, _ in rows]


SORTS = ("new", "price_asc", "price_desc", "name", "match")


def _seller_of(d: dict, p: dict) -> dict:
    return p.get("seller") or _seller(p.get("url") or "") or {"domain": d.get("domain") or "", "host": _host(d.get("url") or "")}


def all_products(docs: list[dict], q: str = "", cat: str = "", maker: str = "", seller: str = "",
                 lo: float | None = None, hi: float | None = None, stock: str = "", sort: str = "new") -> list[tuple[dict, dict]]:
    """Every product of `docs` (the makers) for the catalog's grid: those
    matching the words of `q` (every word, in its name, code, category,
    specs, maker or seller), the category, the maker (its id), the seller
    (its domain), the price range and the stock ("in": in stock on the
    site; "out"); sorted newest first ("new": added, or read, last),
    by price either way (no price last), by name, or by `q`'s match."""
    words = [fold(w) for w in re.split(r"[\s,;/]+", q or "") if w]
    c = fold(cat).strip()
    rows = []
    for d in docs:
        if maker and d["_id"] != maker:
            continue
        for p in d.get("products") or []:
            if c and fold(p.get("category") or "") != c:
                continue
            sel = _seller_of(d, p)
            if seller and seller not in (sel.get("domain"), sel.get("host")):
                continue
            if stock in ("in", "out") and p.get("stock") != stock:
                continue
            amt = (p.get("price") or {}).get("amount")
            if (lo is not None or hi is not None) and amt is None:
                continue
            if (lo is not None and amt < lo) or (hi is not None and amt > hi):
                continue
            rank = 0
            if words:
                hay = _phay(p) + " " + fold(f"{d.get('name')} {sel.get('domain')} {sel.get('name', '')}")
                if not all(w in hay for w in words):
                    continue
                rank = sum(3 for w in words if w in fold(p.get("name") or ""))
            rows.append((d, p, rank))
    if sort == "price_asc":
        rows.sort(key=lambda x: ((x[1].get("price") or {}).get("amount") is None, (x[1].get("price") or {}).get("amount") or 0))
    elif sort == "price_desc":
        rows.sort(key=lambda x: ((x[1].get("price") or {}).get("amount") is None, -((x[1].get("price") or {}).get("amount") or 0)))
    elif sort == "name":
        rows.sort(key=lambda x: fold(x[1].get("name") or ""))
    elif sort == "match" and words:
        rows.sort(key=lambda x: (-x[2], fold(x[1].get("name") or "")))
    else:
        rows.sort(key=lambda x: (x[1].get("added_at") or x[1].get("read_at") or x[0].get("explored_at") or x[0].get("created_at") or ""),
                  reverse=True)
    return [(d, p) for d, p, _ in rows]


def grid_item(d: dict, p: dict) -> dict:
    return {**p, "maker": {"id": d["_id"], "name": d.get("name") or "", "domain": d.get("domain") or ""},
            "seller": _seller_of(d, p)}


@router.get("/products")
async def api_products(q: str = "", cat: str = "", maker: str = "", seller: str = "", min: float | None = None,
                       max: float | None = None, stock: str = "", sort: str = "new", page: int = 1, size: int = 60):
    """The products of every maker, for the catalog's grid: filtered,
    sorted, a page of them - and what the filters can choose from."""
    docs = await listing(_db())
    rows = all_products(docs, q[:200], cat[:120], maker[:40], seller[:200], min, max, stock,
                        sort if sort in SORTS else "new")
    size = max_(1, min_(size, 200))
    page = max_(1, page)
    every = [(d, p) for d in docs for p in d.get("products") or []]
    cats: dict[str, int] = {}
    sellers: dict[str, int] = {}
    for d, p in every:
        if p.get("category"):
            cats[p["category"]] = cats.get(p["category"], 0) + 1
        dom = _seller_of(d, p).get("domain") or ""
        if dom:
            sellers[dom] = sellers.get(dom, 0) + 1
    amounts = [p["price"]["amount"] for _, p in every if (p.get("price") or {}).get("amount") is not None]
    return {"items": [grid_item(d, p) for d, p in rows[(page - 1) * size: page * size]], "total": len(rows),
            "page": page, "size": size, "all": len(every),
            "categories": sorted(([k, v] for k, v in cats.items()), key=lambda x: fold(x[0])),
            "makers": [{"id": d["_id"], "name": d.get("name") or "", "domain": d.get("domain") or "",
                        "count": len(d.get("products") or [])} for d in docs],
            "sellers": sorted(([k, v] for k, v in sellers.items()), key=lambda x: -x[1]),
            "price": {"min": min_(amounts) if amounts else None, "max": max_(amounts) if amounts else None,
                      "currencies": sorted({(p.get("price") or {}).get("currency") or "" for _, p in every
                                            if p.get("price")} - {""})}}


min_, max_ = min, max


async def _start(mid: str, route, reuse: str | None = None, only: list[str] | None = None,
                 follow: bool = False):
    try:
        jd, started = await start_job(_db(), mid, _route_in(route), actors.current(), reuse, only, follow)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {**job_out(jd), "job_id": jd["_id"], "started": started}


@router.post("")
async def api_create(body: MakerIn):
    """A manufacturer, by its site; explored at once unless `explore` is off.
    With `only`, the address is a page: the manufacturer is made for its
    site, and just that page is read into the catalog."""
    db = _db()
    try:
        page = await check(body.url if "://" in body.url else "https://" + body.url.strip())
    except Refused as exc:
        raise HTTPException(400, str(exc)) from exc
    route = _route_in(body.route)
    if choice_problem(own_route(route)):
        raise HTTPException(400, choice_problem(own_route(route)))
    try:
        doc = await create(db, _root_of(page) if body.only else body.url, body.name, body.notes, route, actors.current())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if body.only:
        run = await _start(doc["_id"], None, only=[page], follow=body.follow)
    else:
        run = await _start(doc["_id"], None) if body.explore else None
    doc = await get(db, doc["_id"])
    return {"manufacturer": out(doc), "job": run}


@router.get("/jobs")
async def api_jobs(limit: int = 20, m: str = ""):
    try:
        await _prune(_db())                             # runs left by a manufacturer deleted before they went with it
    except Exception:                                   # noqa: BLE001
        pass
    return [job_out(d, full=False) for d in await jobs(_db(), max(1, min(limit, KEEP_JOBS)), m or None)]


def _no_job(jid: str):
    raise HTTPException(404, f"no exploration {jid}")


@router.get("/jobs/{jid}")
async def api_job(jid: str):
    d = await job(_db(), jid)
    if not d:
        _no_job(jid)
    return job_out(d)


@router.post("/jobs/{jid}/cancel")
async def api_cancel(jid: str):
    d = await cancel_job(_db(), jid, actors.current())
    if not d:
        _no_job(jid)
    return job_out(d)


@router.delete("/jobs/{jid}")
async def api_job_delete(jid: str):
    d = await job(_db(), jid)
    if not d:
        _no_job(jid)
    if d.get("status") in ACTIVE:
        raise HTTPException(409, "the exploration is still running - cancel it first")
    if (d.get("by") or {}).get("id") != actors.current().get("id") and not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await delete_run(_db(), jid)
    return {"deleted": jid}


# ---- sharing: a manufacturer as a file ---------------------------------------

FORMAT = "redline-manufacturer"


def export_doc(doc: dict) -> dict:
    return {"format": FORMAT, "version": 1, "exported_at": _now(), "by": (doc.get("by") or {}).get("name") or "",
            **{k: doc.get(k) for k in ("name", "url", "notes", "summary", "categories", "docs", "explored_at")},
            "products": doc.get("products") or []}


async def import_doc(db, data: dict, by: dict) -> dict:
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("this is not a Workbench manufacturer file")
    if int(data.get("version") or 0) > 1:
        raise ValueError("this manufacturer file is from a newer Workbench")
    u = normalise(str(data.get("url") or ""))
    if not u:
        raise ValueError("the file has no site address")
    doc = await create(db, u, str(data.get("name") or ""), str(data.get("notes") or ""), None, by)
    prods = [p for p in (clean_product(x) for x in (data.get("products") or [])[:MAX_PRODUCTS]
                         if isinstance(x, dict)) if p]
    prods, _ = merge_products([prods])
    docs = [{"url": x["url"], "label": _clean(x.get("label"), 120)} for x in (data.get("docs") or [])[:MAX_DOCS]
            if isinstance(x, dict) and normalise(str(x.get("url") or ""))]
    sets = {"products": prods, "summary": str(data.get("summary") or "")[:3000],
            "categories": [_clean(c, 120) for c in (data.get("categories") or [])[:80] if _clean(c, 120)],
            "docs": docs, "explored_at": data.get("explored_at") if isinstance(data.get("explored_at"), str) else None,
            "imported": {"by": _clean(data.get("by"), 120), "at": _now(), "count": len(prods)}}
    await db[COLL].update_one({"_id": doc["_id"]}, {"$set": sets})
    return await get(db, doc["_id"])


@router.post("/import")
async def api_import(body: dict):
    try:
        doc = await import_doc(_db(), body, actors.current())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return out(doc)


@router.get("/{mid}")
async def api_get(mid: str):
    db = _db()
    doc = await get(db, mid)
    if not doc:
        _404(mid)
    runs = await jobs(db, 1, mid)
    return out(doc, runs[0] if runs else None)


@router.get("/{mid}/export")
async def api_export(mid: str):
    doc = await get(_db(), mid)
    if not doc:
        _404(mid)
    return export_doc(doc)


@router.patch("/{mid}")
async def api_patch(mid: str, body: MakerPatch):
    db = _db()
    if body.url:
        try:
            await check(body.url if "://" in body.url else "https://" + body.url.strip())
        except Refused as exc:
            raise HTTPException(400, str(exc)) from exc
    _route_in(body.route)
    try:
        doc = await patch(db, mid, body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        _404(mid)
    runs = await jobs(db, 1, mid)
    return out(doc, runs[0] if runs else None)


@router.delete("/{mid}")
async def api_delete(mid: str):
    db = _db()
    doc = await get(db, mid)
    if not doc:
        _404(mid)
    if (doc.get("by") or {}).get("id") != actors.current().get("id") and not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await remove(db, mid)
    return {"deleted": mid}


class ReadAgainIn(BaseModel):
    run: str = Field(pattern="^[0-9a-f]{6,32}$")


@router.post("/{mid}/read-again")
async def api_read_again(mid: str, body: ReadAgainIn):
    """The model step again, on the pages a run kept - the site is not fetched."""
    db = _db()
    job = await db[JOBS].find_one({"_id": body.run, "manufacturer.id": mid})
    if not job or not job.get("kept_pages"):
        raise HTTPException(404, "that run kept no pages - explore the site again")
    return await _start(mid, None, body.run)


@router.post("/{mid}/read-page")
async def api_read_page(mid: str, body: ReadPageIn):
    """Just these pages (and, with `follow`, the product pages they link to)
    read into the catalog - added to it, nothing dropped."""
    urls = await _pages_given(body.urls)
    return await _start(mid, body.route, only=urls, follow=body.follow)


async def _maker_out(db, mid: str) -> dict:
    doc = await get(db, mid)
    if not doc:
        _404(mid)
    runs = await jobs(db, 1, mid)
    return out(doc, runs[0] if runs else None)


def _product_call(exc: Exception):
    if isinstance(exc, LookupError):
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    if isinstance(exc, Clash):
        raise HTTPException(409, str(exc)) from exc
    raise HTTPException(400, str(exc)) from exc


@router.post("/{mid}/products")
async def api_product_add(mid: str, body: ProductIn):
    """A product added by hand; kept through a full exploration."""
    db = _db()
    try:
        p = await add_product(db, mid, body.model_dump(), actors.current())
    except (LookupError, Clash, ValueError) as exc:
        _product_call(exc)
    return {"product": p, "manufacturer": await _maker_out(db, mid)}


@router.post("/{mid}/products/delete")
async def api_products_delete(mid: str, body: ProductIds):
    db = _db()
    try:
        n = await delete_products(db, mid, body.ids)
    except LookupError as exc:
        _product_call(exc)
    return {"deleted": n, "manufacturer": await _maker_out(db, mid)}


@router.patch("/{mid}/products/{pid}")
async def api_product_edit(mid: str, pid: str, body: ProductPatch):
    db = _db()
    try:
        p = await edit_product(db, mid, pid, body.model_dump(), actors.current())
    except (LookupError, Clash, ValueError) as exc:
        _product_call(exc)
    return {"product": p, "manufacturer": await _maker_out(db, mid)}


@router.delete("/{mid}/products/{pid}")
async def api_product_delete(mid: str, pid: str):
    db = _db()
    try:
        n = await delete_products(db, mid, [pid])
    except LookupError as exc:
        _product_call(exc)
    if not n:
        raise HTTPException(404, f"no product {pid}")
    return {"deleted": pid, "manufacturer": await _maker_out(db, mid)}


@router.post("/{mid}/explore")
async def api_explore(mid: str, body: ExploreIn | None = None):
    """Explore the site again; its catalog is replaced by what is found."""
    return await _start(mid, body.route if body else None)
