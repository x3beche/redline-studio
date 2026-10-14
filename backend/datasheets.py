"""The datasheet library: every datasheet read once is kept, and searchable.

"What is the maximum current of this IC?" is answered from the part's
datasheet, at the page that says it - not from a model's memory, and not by
handing the model a whole PDF. So a datasheet, the first time anybody (the
Chat's tools, the Parts page) asks for it, is read once here: its text page
by page, its tables as rows (pdftext.layout: cells " | "), cut into passages
under the headings they sit under, and kept. After that a question is a
search over those passages (ranked in this process, BM25 - no embedding
service, no index server), answered with the part, the page number, the
section and a short snippet; the model reads a whole page or one section
only when the snippet is not enough, and cites the page it took a value from.

What is kept, per workspace (backend/scope.py - each space its own library,
as its drawer and its products are its own):

  datasheets       one document a part: `key` (lcsc:C9864, prod:<maker>:<product>,
                   url:<hash>), what it is (`part`: LCSC number, MPN, maker,
                   the Parts product), where the PDF came from (`source`: LCSC's
                   copy kept with the drawer, a Files file - a product's
                   attached PDF, or a link fetched into Files > Parts/Datasheets),
                   `sha`, `bytes`, `pages`, `fetched_at`, `checked_at`, its
                   headings (`toc`), the pages that are pictures of text
                   (`scanned`) and the language of its text (`lang`).
  datasheet_pages  each page's text, by the PDF's sha: two parts sharing one
                   PDF (a resistor series) share its pages.

The bytes are not copied: LCSC's PDF stays in the LCSC cache it was always
kept in (lcsc.py), a product's PDF in Files. A source that changed - LCSC's
copy fetched again, another PDF attached to the product - is seen by its sha
the next time the part is asked for, and read again. `refresh` asks the
source itself again (LCSC, the link).

Passages are made from the kept pages on demand and kept in memory (CACHE
datasheets), so nothing has to be migrated when the way they are cut
changes; `INDEX_V` re-reads the pages themselves when extraction changes.

Ranking: BM25 over a passage's words and, twice, its heading's. A question
about limits ("maximum", "absolute", "rating", "max current") ranks the
Absolute Maximum Ratings first, then Recommended Operating Conditions and
the Electrical Characteristics; one about pins the pin tables; a table of
contents, a revision history and the legal notice are pushed down. Turkish
words of a question (akım, gerilim, maksimum, bacak...) are searched as
their English, and LCSC's Chinese datasheets are searched with Chinese
words for the same things (电流, 最大, 绝对最大额定值...).

A page with next to no text but a picture on it is a scan: it is said so
(no OCR here) - the model looks at it as a picture instead.

Limits: at most MAX_INDEX_PAGES pages of one PDF are read (the rest are
said to be unread), MAX_PAGE_TEXT characters a page, MAX_LIBRARY datasheets
a workspace, PDFs as large as their source allows (LCSC 30 MB, a link
product_files.FETCH_MAX).
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import re
import secrets
import unicodedata
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import lcsc, pdftext

COLL = "datasheets"
PAGES = "datasheet_pages"
INDEX_V = 1                          # how pages are read (pdftext.layout); a new one reads them again
MAX_INDEX_PAGES = 400
MAX_PAGE_TEXT = 20_000
MAX_LIBRARY = 2000
CHUNK = 1800                         # characters of one passage at most (an Absolute Maximum Ratings table whole)
SNIPPET = 420                        # characters of a passage shown in a search
TABLE_SNIPPET = 1100                 # ... and of a ratings table, when the question is about limits
TOC_MAX = 60
CACHE = 300                          # datasheets whose passages are kept in memory
FOLDER = "Parts/Datasheets"          # where a datasheet fetched from a link is kept in Files


class NoDatasheet(LookupError):
    """Nothing says where this part's datasheet is."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- what a datasheet is of

@dataclass
class Ref:
    """A part as the library knows it: its key, and what it is."""
    key: str
    lcsc: str = ""
    mpn: str = ""
    maker: str = ""
    name: str = ""
    mid: str = ""                    # a Parts product: its maker and product ids
    pid: str = ""
    file: str = ""                   # a Files id holding its datasheet (a product's attached PDF)

    @property
    def label(self) -> str:
        return self.mpn or self.name or self.lcsc or self.key

    def part(self) -> dict:
        return {k: v for k, v in (("lcsc", self.lcsc), ("mpn", self.mpn), ("maker", self.maker),
                                  ("name", self.name), ("mid", self.mid), ("pid", self.pid)) if v}


def lcsc_ref(c: str) -> Ref:
    facts = lcsc._drawer_facts(c)
    return Ref(key=f"lcsc:{c}", lcsc=c, mpn=str(facts.get("mpn") or ""), maker=str(facts.get("maker") or ""),
               name=str(facts.get("description") or "")[:120])


def url_key(url: str) -> str:
    return "url:" + hashlib.sha1(url.strip().encode()).hexdigest()[:16]


def fold(s) -> str:
    return re.sub(r"[^a-z0-9]+", "", unicodedata.normalize("NFKC", str(s or "")).lower())


async def ref_for_product(db, mid: str, pid: str) -> Ref:
    """A Parts product's datasheet: an LCSC part's is LCSC's; any other
    product's is the first PDF attached to it as its datasheet."""
    from . import product_files as pf
    if mid == "lcsc" and lcsc.looks_like_a_part(pid):
        return lcsc_ref(pid)
    maker, product = await pf.target(db, mid, pid)
    _, doc = await pf.holder(db, mid, pid, product)
    sheet = next((f for f in pf.entries(doc) if f.get("role") == "datasheet" and f.get("file")), None)
    return Ref(key=f"prod:{mid}:{pid}", mpn=str(product.get("sku") or ""), name=str(product.get("name") or "")[:120],
               maker=str(maker.get("name") or ""), mid=mid, pid=pid, file=(sheet or {}).get("file") or "")


async def find_ref(db, words: str) -> Ref | None:
    """A part named by its LCSC number, a library id or key, or its MPN - in
    the library or the drawer. None when nothing fits (a product's words are
    the caller's to try)."""
    w = str(words or "").strip()
    if not w:
        return None
    if lcsc.looks_like_a_part(w.upper()):
        return lcsc_ref(w.upper())
    e = await db[COLL].find_one({"$or": [{"_id": w}, {"key": w}]})
    if e:
        return _ref_of(e)
    f = fold(w)
    if f:
        rows = [e async for e in db[COLL].find({}, {"key": 1, "part": 1, "source": 1})]
        same = [e for e in rows if f in (fold((e.get("part") or {}).get("mpn")), fold((e.get("part") or {}).get("name")))]
        if len(same) == 1:
            return _ref_of(same[0])
        hits = [r for r in await lcsc.known(db) if fold(r.get("mpn")) == f]
        if not hits:
            hits = [r for r in await lcsc.known(db) if f and fold(r.get("mpn")).startswith(f)]
        if len(hits) == 1:
            return lcsc_ref(hits[0]["lcsc"])
        if len(hits) > 1:
            raise LookupError(f"{len(hits)} drawer parts match {w!r}: "
                              + ", ".join(f"{h['lcsc']} {h.get('mpn') or ''}" for h in hits[:8])
                              + " - name one by its LCSC number")
    return None


def _ref_of(e: dict) -> Ref:
    p = e.get("part") or {}
    src = e.get("source") or {}
    return Ref(key=e["key"], lcsc=p.get("lcsc") or "", mpn=p.get("mpn") or "", maker=p.get("maker") or "",
               name=p.get("name") or "", mid=p.get("mid") or "", pid=p.get("pid") or "",
               file=src.get("file") if src.get("kind") == "file" else "")


# ---------------------------------------------------------------- reading a PDF once

def _extract(blob: bytes) -> dict:
    """Pages' text (tables as rows) and which are scans. Runs in a thread."""
    got = pdftext.layout(blob, None, MAX_INDEX_PAGES)
    pages = []
    for p in got["pages"]:
        text = p.get("text") or ""
        if len(text) > MAX_PAGE_TEXT:
            text = text[:MAX_PAGE_TEXT] + "\n[... the rest of this page's text is cut]"
        bare = len(re.sub(r"\s+", "", text))
        pages.append({"n": p["n"], "text": text, "scanned": bare < 80 and p.get("images", 0) > 0,
                      "images": p.get("images", 0)})
    return {"count": got["count"], "pages": pages}


_CJK = re.compile(r"[㐀-鿿]")


def lang_of(pages: list[dict]) -> str:
    """"zh" when most of the text is Chinese (LCSC often has only the Chinese one), else "en"."""
    text = "".join(p.get("text") or "" for p in pages[:12])
    letters = len(re.findall(r"[A-Za-z]", text))
    cjk = len(_CJK.findall(text))
    return "zh" if cjk > 200 and cjk * 2 > letters * 0.5 else "en"


# ---------------------------------------------------------------- headings and passages

# What a section is about, from its heading (English, and the Chinese LCSC's datasheets use).
KINDS: tuple[tuple[str, re.Pattern], ...] = tuple((k, re.compile(p, re.I)) for k, p in (
    ("absmax", r"absolute\s+maximum|maximum\s+ratings|limiting\s+values|absolute\s+ratings|绝对最大|极限参数|最大额定"),
    ("recommended", r"recommended\s+operating|operating\s+conditions|operating\s+ratings|推荐工作|推荐操作|工作条件"),
    ("electrical", r"electrical\s+(characteristics|specifications|parameters|data)|\b(dc|ac)\s+(electrical\s+)?characteristics"
                   r"|^\d*[.\d]*\s*specifications$|电气特性|电特性|电气参数|电气规格"),
    ("pinout", r"\bpin\s*(configuration|description|function|assignment|definition|layout|out|list)s?\b|\bpinout\b"
               r"|terminal\s+(functions|configuration)|ball\s+(map|assignment)|管脚|引脚"),
    ("thermal", r"thermal\s+(information|characteristics|resistance|data|considerations)|热特性|热阻"),
    ("package", r"package\s+(information|outline|dimensions?|drawing|data)|mechanical\s+(data|dimensions|drawing|information)"
                r"|outline\s+dimensions|physical\s+dimensions|封装"),
    ("ordering", r"ordering\s+information|order(ing)?\s+codes?|订购信息|订货信息"),
    ("features", r"^(\d+[.\d]*\s*)?(key\s+)?features$|^产品特性$|^特性$|^特点$"),
    ("legal", r"revision\s+history|important\s+notice|disclaimer|document\s+history|^changes\s+from\s+(revision|original)"
              r"|修订历史|免责声明|版本历史"),
))
_NUMBERED = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z㐀-鿿][^|]{1,80})$")
_TOC_LINE = re.compile(r"(\.\s*){4,}|…{2,}|\.{3,}\s*\d{1,3}$")
_NOT_HEADING = re.compile(r"^(table|figure|fig\.|note|notes|图|表)\b|^[•●▪*–-]|[.。:：,，;；、=]\s*$|[，。、；：（=]", re.I)
_UNIT = re.compile(r"^(v|a|ma|mv|ua|µa|μa|na|w|mw|hz|khz|mhz|ghz|°|%|ns|µs|us|ms|s|mm|pf|nf|uf|µf|k?ω|ohm|db|dmips|"
                   r"[kmg]?bits?|[kmg]?b|bytes?|x|k|pins?|channels?|cycles?)\b", re.I)


def kind_of(heading: str) -> str:
    for k, rx in KINDS:
        if rx.search(heading.strip()):
            return k
    return "other"


def heading(line: str) -> str | None:
    """The line's kind of section when it is a heading, else None."""
    s = re.sub(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\s*\|\s*", r"\1 ", line.strip())    # "6.4 | Thermal Information"
    if not (3 <= len(s) <= 90) or " | " in s or _NOT_HEADING.search(s) or _TOC_LINE.search(s) \
            or s.count("(") != s.count(")") or s[0].islower():
        return None
    k = kind_of(s)
    cjk = len(_CJK.findall(s))
    if k != "other" and len(s) <= 64 and len(s.split()) <= 8 and cjk <= 16:
        return k
    m = _NUMBERED.match(s)
    if m and int(m.group(1).split(".")[0]) <= 30 and len(m.group(2).split()) <= 8 and not _UNIT.match(m.group(2)) \
            and not re.search(r"\d\s*(v|a|ma|mv|°c|hz|khz|mhz|w|mw|ω|ohm)\b", m.group(2), re.I):
        return k
    return None


def _boiler(pages: list[dict]) -> set[str]:
    """Lines on most pages, or at the top or foot of three pages or more (the
    running head and foot, "STM32F103x8 Electrical characteristics"): not
    part of any passage, and never a heading."""
    if len(pages) < 4:
        return set()
    seen: Counter = Counter()
    edge: Counter = Counter()
    for p in pages:
        lines = [re.sub(r"\d+", "#", ln.strip()) for ln in (p.get("text") or "").split("\n") if ln.strip()]
        seen.update(set(lines))
        edge.update(set(lines[:3] + lines[-3:]))
    return {ln for ln, n in seen.items() if n >= max(3, 0.4 * len(pages))} | {ln for ln, n in edge.items() if n >= 3}


def structure(pages: list[dict]) -> tuple[list[dict], list[dict]]:
    """(passages, headings) of a datasheet's pages. A passage: its page, the
    heading it sits under (carried over from the pages before), that
    heading's kind, its text. A page that is a table of contents is one
    passage of kind "toc"."""
    chunks: list[dict] = []
    toc: list[dict] = []
    boiler = _boiler(pages)
    section, kind = "", "other"
    for p in pages:
        lines = [ln for ln in (p.get("text") or "").split("\n")
                 if ln.strip() and re.sub(r"\d+", "#", ln.strip()) not in boiler]
        if sum(bool(_TOC_LINE.search(ln)) for ln in lines) >= 5:
            chunks.append({"page": p["n"], "section": "Contents", "kind": "toc", "text": "\n".join(lines)[:CHUNK]})
            continue
        buf: list[str] = []

        def flush():
            if not buf:
                return
            part: list[str] = []
            size = 0
            for ln in buf:
                if part and size + len(ln) > CHUNK:
                    chunks.append({"page": p["n"], "section": section, "kind": kind, "text": "\n".join(part)})
                    part, size = [], 0
                part.append(ln)
                size += len(ln) + 1
            if part:
                chunks.append({"page": p["n"], "section": section, "kind": kind, "text": "\n".join(part)})
            buf.clear()

        for ln in lines:
            k = heading(ln)
            if k is not None:
                flush()
                section, kind = re.sub(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\s*\|\s*", r"\1 ", ln.strip())[:90], k
                if len(toc) < TOC_MAX or k != "other":
                    toc.append({"t": section, "p": p["n"], "k": k})
                continue
            buf.append(ln)
        flush()
    return chunks, toc


# ---------------------------------------------------------------- words, and how a question is read

_TOK = re.compile(r"[a-z0-9µμ]+|[㐀-鿿]+")
STOP = frozenset("a an the of for to in on at is are be do does what which how much many this that its it and or "
                 "with by from can ic chip part device about give tell me my value values "
                 "bu ne nedir kaç mı mi mu mü ve ile için olan nasıl hangi entegre entegrenin parça değeri".split())
# A Turkish word (its start) -> the English a datasheet says it with.
TR = (("akım", "current"), ("akim", "current"), ("gerilim", "voltage"), ("voltaj", "voltage"), ("maksimum", "maximum"),
      ("azami", "maximum"), ("en yüksek", "maximum"), ("asgari", "minimum"), ("mutlak", "absolute"),
      ("sıcaklı", "temperature"), ("sicakli", "temperature"), ("güç", "power"), ("bacak", "pin"), ("pin", "pin"),
      ("frekans", "frequency"), ("çıkış", "output"), ("cikis", "output"), ("giriş", "input"), ("giris", "input"),
      ("besleme", "supply"), ("direnç", "resistance"), ("tüketim", "consumption"), ("uyku", "sleep"),
      ("kılıf", "package"), ("paket", "package"), ("boyut", "dimension"), ("ısıl", "thermal"), ("sınır", "limit"),
      ("çalışma", "operating"), ("kapasit", "capacitance"), ("anahtarlama", "switching"), ("verim", "efficiency"))
# English -> what LCSC's Chinese datasheets say (only ever matches their text).
ZH = {"maximum": "最大", "minimum": "最小", "current": "电流", "voltage": "电压", "absolute": "绝对", "rating": "额定",
      "pin": "引脚 管脚", "temperature": "温度", "power": "功耗 功率", "supply": "供电 电源", "operating": "工作",
      "input": "输入", "output": "输出", "frequency": "频率", "consumption": "功耗", "sleep": "睡眠",
      "thermal": "热", "package": "封装", "resistance": "电阻", "limit": "极限"}
SAME = {"max": "maximum", "min": "minimum", "temp": "temperature", "abs": "absolute", "vcc": "vcc", "vdd": "vdd",
        "pinout": "pin", "pins": "pin", "amps": "current", "amperage": "current", "volts": "voltage"}

# What a question is about -> how much more each kind of section counts.
INTENTS = (
    ({"maximum", "absolute", "limit", "rating", "withstand", "highest", "peak", "exceed", "stress", "breakdown"},
     {"absmax": 1.6, "recommended": 0.8, "electrical": 0.5, "features": 0.3}),
    ({"operating", "recommended", "typical", "nominal", "range"}, {"recommended": 1.0, "electrical": 0.6}),
    ({"current", "voltage", "power", "consumption", "frequency", "resistance", "leakage", "quiescent"},
     {"electrical": 0.4, "absmax": 0.3, "recommended": 0.3, "features": 0.2}),
    ({"pin", "terminal", "pad", "ball", "pinout"}, {"pinout": 1.6}),
    ({"thermal", "junction", "θja", "rθja", "heat", "dissipation"}, {"thermal": 1.2, "absmax": 0.3}),
    ({"package", "dimension", "outline", "mechanical", "footprint", "size"}, {"package": 1.2}),
)
PUSH_DOWN = {"toc": 0.15, "legal": 0.4, "ordering": 0.7}
LIMIT_WORDS = ("limit", "rating", "peak", "continuous")


def _stem(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return w


def tokens(text: str) -> list[str]:
    """A text's words, lower case and stemmed; a run of Chinese as its characters and their pairs."""
    out: list[str] = []
    for w in _TOK.findall(unicodedata.normalize("NFKC", text or "").lower()):
        if _CJK.match(w):
            out.extend(w)
            out.extend(w[i:i + 2] for i in range(len(w) - 1))
        else:
            out.append(_stem(w))
    return out


def query_terms(q: str) -> list[str]:
    """The words a question is searched with: its own (less the filler), the
    English of its Turkish ones, and the Chinese of those."""
    low = cc_lower(q)
    words: list[str] = []
    for tr, en in TR:
        if re.search(r"(?<![\w])" + re.escape(tr), low):
            words.append(en)
    for w in tokens(low):
        if w in STOP or (len(w) < 2 and not _CJK.match(w)):
            continue
        w = SAME.get(w, w)
        if any(w.startswith(_stem(tr.split()[0])) for tr, _ in TR):
            continue                                    # a Turkish word: its English is in already
        words.append(w)
    for w in list(words):
        for zh in ZH.get(w, "").split():
            words.extend(tokens(zh))
    seen: list[str] = []
    for w in words:
        if w not in seen:
            seen.append(w)
    return seen


def cc_lower(text: str) -> str:
    return (text or "").replace("İ", "i").lower()


def boosts(terms: list[str]) -> dict[str, float]:
    got: dict[str, float] = {}
    ts = set(terms)
    for words, add in INTENTS:
        if ts & words:
            for k, v in add.items():
                got[k] = max(got.get(k, 0.0), v)
    return got


# ---------------------------------------------------------------- the passages in memory

_CACHE: OrderedDict[str, list[dict]] = OrderedDict()


async def _passages(db, sha: str) -> list[dict]:
    """A datasheet's passages with their words counted (kept in memory by sha and workspace)."""
    from . import scope
    ck = f"{scope.current()}:{sha}"
    if ck in _CACHE:
        _CACHE.move_to_end(ck)
        return _CACHE[ck]
    pages = sorted([p async for p in db[PAGES].find({"sha": sha}, {"n": 1, "text": 1})], key=lambda p: p["n"])
    chunks, _ = structure(pages)
    for c in chunks:
        words = tokens(c["text"]) + tokens(c["section"]) * 2
        c["tf"] = Counter(words)
        c["len"] = len(words)
    _CACHE[ck] = chunks
    while len(_CACHE) > CACHE:
        _CACHE.popitem(last=False)
    return chunks


def _snippet(text: str, idf: dict[str, float], most: int = SNIPPET, top: bool = False) -> str:
    """The few lines of a passage with most of the question's (rarer) words -
    or, `top`, its first lines (a ratings table is the answer, from its head)."""
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        return ""
    # A table's row with a figure in it counts more than a sentence about it.
    scores = [sum(idf.get(t, 0.0) for t in set(tokens(ln))) + (0.5 if " | " in ln and re.search(r"\d", ln) else 0)
              for ln in lines]
    best = max(range(len(lines)), key=lambda i: (scores[i], -i))
    lo = 0 if top else max(0, best - 2)
    out, size = [], 0
    for ln in lines[lo:lo + max(6, most // 70)]:
        if size + len(ln) > most and out:
            break
        out.append(ln[:most])
        size += len(ln) + 1
    return "\n".join(out)


async def search(db, query: str, keys: list[str] | None = None, limit: int = 6, per_sheet: int = 3) -> dict:
    """The passages that answer `query` best, across the library or the
    datasheets of `keys`: {"terms", "sheets", "hits": [{id, key, label,
    lcsc, page, section, kind, snippet, score}]}."""
    terms = query_terms(query)
    if not terms:
        raise ValueError("say what to look for - a few words, like 'maximum output current' or 'pinout'")
    q = {"key": {"$in": list(keys)}} if keys else {}
    sheets = [e async for e in db[COLL].find(q, {"key": 1, "part": 1, "sha": 1, "pages": 1, "lang": 1})]
    corpus: list[tuple[dict, dict]] = []
    for e in sheets:
        for c in await _passages(db, e["sha"]):
            corpus.append((e, c))
    if not corpus:
        return {"terms": terms, "sheets": len(sheets), "hits": []}
    n = len(corpus)
    avg = sum(c["len"] for _, c in corpus) / n or 1.0
    add = boosts(terms)
    # A question about limits also looks for the words limits are written with (at half weight):
    # "Current limit | 4 | 5 | 6 | A", "Up to 3-A Continuous (4-A Peak) Output Current".
    extra = [w for w in LIMIT_WORDS if w not in terms] if add.get("absmax", 0) >= 1 else []
    df = {t: sum(1 for _, c in corpus if t in c["tf"]) for t in [*terms, *extra]}
    idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) * (0.5 if t in extra else 1.0) for t, d in df.items() if d}
    main = [t for t in idf if t not in extra]
    scored = []
    for e, c in corpus:
        s = 0.0
        for t, w in idf.items():
            f = c["tf"].get(t, 0)
            if f:
                s += w * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * c["len"] / avg))
        if not s:
            continue
        cover = sum(1 for t in main if c["tf"].get(t)) / max(1, len(main))
        s *= (0.5 + cover) * (1 + add.get(c["kind"], 0.0)) * PUSH_DOWN.get(c["kind"], 1.0)
        scored.append((s, e, c))
    scored.sort(key=lambda x: -x[0])
    if scored and (keys or len(sheets) == 1):
        # The limits helper: in one part's datasheet, the best passage of each kind of section the question
        # points to (Absolute Maximum Ratings, then Recommended Operating Conditions, the Electrical
        # Characteristics, the Features) comes first, in that order - then the rest by score.
        first = []
        for k, _ in sorted(add.items(), key=lambda kv: -kv[1]):
            top = next((x for x in scored if x[2]["kind"] == k), None)
            if top and top[0] >= 0.15 * scored[0][0]:
                first.append(top)
        scored = first + [x for x in scored if not any(x is f for f in first)]
    hits, per = [], Counter()
    for s, e, c in scored:
        if per[e["key"]] >= per_sheet and not keys:
            continue
        if any(h["key"] == e["key"] and h["page"] == c["page"] and h["section"] == c["section"] for h in hits):
            continue
        per[e["key"]] += 1
        p = e.get("part") or {}
        hits.append({"id": e["_id"], "key": e["key"], "label": p.get("mpn") or p.get("name") or p.get("lcsc") or e["key"],
                     "lcsc": p.get("lcsc") or "", "page": c["page"], "section": c["section"], "kind": c["kind"],
                     "snippet": _snippet(c["text"], idf, *((TABLE_SNIPPET, True) if add.get(c["kind"], 0) >= 0.8
                                                           else (SNIPPET, False))),
                     "score": round(s, 3)})
        if len(hits) >= limit:
            break
    return {"terms": terms, "sheets": len(sheets), "hits": hits}


# ---------------------------------------------------------------- keeping a datasheet

async def entry(db, key: str) -> dict | None:
    return await db[COLL].find_one({"key": key})


async def _keep_file(db, ref: Ref, name: str, blob: bytes, url: str, by: dict) -> str:
    """A PDF from a link, in Files > Parts/Datasheets (the Parts page's, read-only there); the same bytes once."""
    from . import files
    sha = hashlib.sha256(blob).hexdigest()
    same = await db[files.COLL].find_one({"sha256": sha}, {"_id": 1})
    if same:
        return same["_id"]
    folder = await files.make_path(db, FOLDER, by)
    name = name if name.lower().endswith(".pdf") else (name or ref.label or "datasheet") + ".pdf"
    doc = await files.put(db, name, blob, "application/pdf", {"room": "catalog", "datasheet": ref.key}, by,
                          note=f"Datasheet of {ref.label}, from {url}"[:300], folder=folder["_id"])
    return doc["_id"]


async def _file_bytes(db, fid: str) -> bytes:
    from . import files
    try:
        _, data = await files.get(db, fid)
    except (LookupError, KeyError) as exc:
        raise NoDatasheet(f"its datasheet file {fid} is no longer in Files") from exc
    return data


async def ensure(db, ref: Ref, *, url: str = "", refresh: bool = False, by: dict | None = None) -> tuple[dict, str]:
    """The part's datasheet in the library: (its document, how) - how is
    "library" (kept and unchanged), "indexed" (its PDF was kept elsewhere
    and is read now), "fetched" (fetched now) or "refreshed" (its source
    changed, read again). `url`: the PDF at this link is its datasheet from
    now on. Raises NoDatasheet / lcsc's errors / product_files.Refused /
    pdftext.PdfError."""
    from . import product_files as pf
    by = by or {}
    e = await entry(db, ref.key)
    src = (e or {}).get("source") or {}
    how = "library"
    got_url = url.strip()
    if not got_url and refresh and src.get("kind") == "url":
        got_url = src.get("url") or ""
    if got_url:
        name, blob = await pf.fetch(got_url)
        if not pdftext.is_pdf(blob):
            raise pf.Refused(f"{got_url} is not a PDF - give the datasheet's own PDF link")
        source = {"kind": "url", "url": got_url, "file": await _keep_file(db, ref, name, blob, got_url, by)}
        how = "fetched"
    elif ref.file and src.get("kind") != "url" and src.get("file") != ref.file:
        blob, source = await _file_bytes(db, ref.file), {"kind": "file", "file": ref.file}
    elif src.get("kind") in ("url", "file") and src.get("file"):
        blob, source = await _file_bytes(db, src["file"]), src
    elif ref.lcsc:
        got = await lcsc.datasheet(ref.lcsc, fresh=refresh)
        blob = got["pdf"]
        source = {"kind": "lcsc", "lcsc": ref.lcsc, "url": got.get("url") or ""}
        ref.mpn = ref.mpn or str(got.get("mpn") or "")
        if not got.get("cached"):
            how = "fetched"
    else:
        raise NoDatasheet(f"no datasheet is known for {ref.label}: give its PDF link (url), or attach the PDF to "
                          "the product")
    sha = hashlib.sha256(blob).hexdigest()
    now = _now()
    if e and e.get("sha") == sha and e.get("v") == INDEX_V:
        await db[COLL].update_one({"_id": e["_id"]}, {"$set": {"checked_at": now, "source": source}})
        return {**e, "checked_at": now, "source": source}, how
    if not e and await db[COLL].count_documents({}) >= MAX_LIBRARY:
        raise ValueError(f"the datasheet library holds {MAX_LIBRARY} datasheets already - nothing more is kept")
    have = await db[PAGES].count_documents({"sha": sha})
    shared = await db[COLL].find_one({"sha": sha, "v": INDEX_V}, {"pages": 1, "indexed": 1, "scanned": 1, "lang": 1,
                                                                  "toc": 1})
    if shared and have and have == shared.get("indexed"):
        info = {k: shared.get(k) for k in ("pages", "indexed", "scanned", "lang", "toc")}
    else:
        read = await asyncio.to_thread(_extract, blob)
        await db[PAGES].delete_many({"sha": sha})
        if read["pages"]:
            await db[PAGES].insert_many([{"_id": f"{sha[:24]}:{p['n']}", "sha": sha, "n": p["n"], "text": p["text"],
                                          "scanned": p["scanned"]} for p in read["pages"]])
        _, toc = structure(read["pages"])
        info = {"pages": read["count"], "indexed": len(read["pages"]), "lang": lang_of(read["pages"]),
                "scanned": [p["n"] for p in read["pages"] if p["scanned"]], "toc": toc}
    if how == "library":
        how = "refreshed" if e else "indexed"
    doc = {"key": ref.key, "part": ref.part(), "source": source, "sha": sha, "bytes": len(blob), "v": INDEX_V,
           **info, "fetched_at": now if (how in ("fetched", "refreshed") or not e) else e.get("fetched_at", now),
           "checked_at": now, "by": {"id": by.get("id"), "name": by.get("name")}}
    old = (e or {}).get("sha")
    if e:
        await db[COLL].update_one({"_id": e["_id"]}, {"$set": doc})
        doc["_id"] = e["_id"]
    else:
        doc["_id"] = secrets.token_hex(6)
        await db[COLL].insert_one(dict(doc))
    if old and old != sha and not await db[COLL].find_one({"sha": old}, {"_id": 1}):
        await db[PAGES].delete_many({"sha": old})
    return doc, how


async def pages_of(db, e: dict, ns: list[int]) -> list[dict]:
    rows = [p async for p in db[PAGES].find({"sha": e["sha"], "n": {"$in": ns}}, {"n": 1, "text": 1, "scanned": 1})]
    return sorted(rows, key=lambda p: p["n"])


async def section_of(db, e: dict, words: str, most: int = 6000) -> tuple[str, list[dict]]:
    """The passages under the heading `words` names (its kind's name works too:
    "absolute maximum ratings", "pinout"): (the heading, [{page, text}])."""
    want = fold(words)
    toc = e.get("toc") or []
    k = kind_of(words)
    pick = next((h for h in toc if want and want in fold(h["t"])), None) \
        or next((h for h in toc if k != "other" and h["k"] == k), None)
    if not pick:
        return "", []
    out, size = [], 0
    for c in await _passages(db, e["sha"]):
        if c["section"] == pick["t"] and c["page"] >= pick["p"]:
            if size + len(c["text"]) > most and out:
                break
            out.append({"page": c["page"], "text": c["text"]})
            size += len(c["text"])
    return pick["t"], out


def light(e: dict | None) -> dict | None:
    """What the page shows of a library document."""
    if not e:
        return None
    p, s = e.get("part") or {}, e.get("source") or {}
    return {"id": e["_id"], "key": e["key"], "label": p.get("mpn") or p.get("name") or p.get("lcsc") or e["key"],
            "part": p, "source": {"kind": s.get("kind"), "url": s.get("url") or ""}, "pages": e.get("pages"),
            "indexed": e.get("indexed"), "bytes": e.get("bytes"), "lang": e.get("lang"),
            "scanned": len(e.get("scanned") or []), "fetched_at": e.get("fetched_at"), "checked_at": e.get("checked_at"),
            "toc": len(e.get("toc") or [])}


async def pdf_of(db, e: dict) -> bytes:
    """The PDF itself, from where it is kept."""
    s = e.get("source") or {}
    if s.get("kind") == "lcsc":
        kept = lcsc._datasheet_kept(s.get("lcsc") or (e.get("part") or {}).get("lcsc") or "")
        if not kept:
            raise NoDatasheet("LCSC's copy is no longer kept - fetch it again")
        return kept["pdf"]
    return await _file_bytes(db, s.get("file") or "")


# ---------------------------------------------------------------- routes

router = APIRouter(prefix="/api/datasheets")


def _db():
    from .main import db
    return db()


def _http(exc: Exception):
    if isinstance(exc, LookupError):
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    if isinstance(exc, lcsc.Refused):
        raise HTTPException(429, str(exc)) from exc
    raise HTTPException(400, str(exc)) from exc


@router.get("")
async def api_list() -> dict:
    """The library: what is kept, newest first."""
    rows = [light(e) async for e in _db()[COLL].find({}, {"toc": 0}).sort("fetched_at", -1).limit(MAX_LIBRARY)]
    return {"items": rows}


@router.get("/search")
async def api_search(q: str, part: str = "", limit: int = 8) -> dict:
    """Passages for a question, with their page numbers - across the library or one part."""
    db = _db()
    keys = None
    if part:
        try:
            ref = await find_ref(db, part)
        except LookupError as exc:
            _http(exc)
        if not ref:
            raise HTTPException(404, f"no part {part!r} in the library or the drawer")
        keys = [ref.key]
    try:
        return await search(db, q, keys, max(1, min(20, limit)))
    except ValueError as exc:
        _http(exc)


@router.get("/product/{mid}/{pid}")
async def api_product(mid: str, pid: str) -> dict:
    """A Parts product's datasheet in the library, and whether one can be fetched for it."""
    db = _db()
    try:
        ref = await ref_for_product(db, mid, pid)
    except LookupError as exc:
        _http(exc)
    e = await entry(db, ref.key)
    can = "lcsc" if ref.lcsc else "file" if ref.file else (e or {}).get("source", {}).get("kind")
    return {"entry": light(e), "source": can or None}


@router.post("/product/{mid}/{pid}")
async def api_fetch(mid: str, pid: str, refresh: bool = False) -> dict:
    """Puts a product's datasheet in the library (LCSC's, or the PDF attached to it)."""
    from . import actors, product_files as pf
    db = _db()
    try:
        ref = await ref_for_product(db, mid, pid)
        e, how = await ensure(db, ref, refresh=refresh, by=actors.current() or {})
    except (LookupError, ValueError, OSError, TimeoutError, lcsc.Refused, pf.Refused) as exc:
        _http(exc)
    return {"entry": light(e), "how": how}


@router.get("/{did}/pdf")
async def api_pdf(did: str) -> Response:
    """The datasheet's PDF, to read in the page (a #page=N opens it there)."""
    db = _db()
    e = await db[COLL].find_one({"_id": did})
    if not e:
        raise HTTPException(404, "no such datasheet in the library")
    try:
        blob = await pdf_of(db, e)
    except LookupError as exc:
        _http(exc)
    name = re.sub(r"[^\w.\-]+", "_", light(e)["label"])[:80] or "datasheet"
    return Response(blob, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{name}.pdf"', "Cache-Control": "private, max-age=300"})
