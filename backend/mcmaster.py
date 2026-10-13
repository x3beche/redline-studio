"""McMaster-Carr as a search-and-link source (backend/linked.py).

McMaster-Carr does not allow its pages to be scraped, and its official API
(https://www.mcmaster.com/help/api/) is given out on approval. Until it is,
Workbench never fetches mcmaster.com: a part is found through a web search
of what the search engine has indexed of mcmaster.com, and its part number
- 91290A115, 5972K91: digits, a letter or two, digits - is read out of the
results' addresses, titles and snippets, with the few specs a snippet says
(thread, length, material, pack, the price it showed). Each part links to
its own page, https://www.mcmaster.com/<part>/, where the CAD box is: the
person downloads the STEP there (CAD → 3-D STEP → Save) and drops it on the
saved part, kept in Files as mcmaster_<part>.step.

The API, later: its credentials (a user name, a password and the client
certificate McMaster issues, with its password) are kept in
`server_settings` like the proxy's password and Jina's key - write-only,
never sent back to a page, never in a log line or the audit trail - and
`Api` is the adapter its calls will go through: the CAD download behind
"Download STEP" (GET /api/mcmaster/parts/{part}/cad), and a saved part's
STEP fetched by itself when `auto_step` is on. Nothing in it calls McMaster
yet; each call says so (`NotWired`), and so does "Test connection".
"""

from __future__ import annotations

import base64
import re
from datetime import datetime, timezone

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import actors, linked

MID = "mcmaster"
SITE = "https://www.mcmaster.com"
DOMAIN = "mcmaster.com"
HOW = "CAD → 3-D STEP → Download"   # what to click on the part's page (the file is then dropped on the Catalog page)

# A part number: 3 to 5 digits, one or two capital letters, 1 to 4 digits
# (91290A115, 5972K91, 6655K13, 57155K372). Case matters in text: "608zz",
# "m3x10" and "10mm" are not part numbers.
PART = re.compile(r"(?<![A-Za-z0-9/-])(\d{3,5}[A-Z]{1,2}\d{1,4})(?![A-Za-z0-9])")
_IN_URL = re.compile(r"mcmaster\.com/(?:[^?#\s]*/)?(\d{3,5}[A-Za-z]{1,2}\d{1,4})(?:[/?#]|$)", re.I)


def url_of(part: str) -> str:
    """The part's own page: the CAD box is on it."""
    return f"{SITE}/{part}/"


def part_of(text: str) -> str | None:
    """A part number out of what someone pasted: the number (any case) or a
    McMaster address with it."""
    s = (text or "").strip()
    if not s:
        return None
    if m := _IN_URL.search(s):
        return m.group(1).upper()
    s = s.upper()
    return s if PART.fullmatch(s) else None


_MATERIALS = ("18-8 Stainless Steel", "316 Stainless Steel", "304 Stainless Steel", "410 Stainless Steel",
              "Stainless Steel", "Black-Oxide Alloy Steel", "Zinc-Plated Alloy Steel", "Alloy Steel",
              "Zinc-Plated Steel", "Galvanized Steel", "Carbon Steel", "Steel", "Brass", "Bronze", "Aluminum",
              "Titanium", "Nylon", "PTFE", "Acetal", "Delrin", "Polycarbonate", "ABS", "Rubber", "Copper")
_SPECS: tuple[tuple[str, re.Pattern], ...] = (
    ("Thread", re.compile(r"\bM\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*mm\b|\b\d+/\d+\"?\s*-\s*\d+\b|#\d+-\d+\b")),
    ("Length", re.compile(r"\b(\d+(?:\.\d+)?\s*mm|\d+(?:[- ]\d+/\d+)?\"|\d+/\d+\")\s+(?:Long|Length)\b", re.I)),
    ("Shaft", re.compile(r"\b(?:for\s+)?(\d+(?:\.\d+)?\s*mm|\d+(?:/\d+)?\")\s+Shaft(?:\s+Diameter)?\b", re.I)),
    ("OD", re.compile(r"\b(\d+(?:\.\d+)?\s*mm|\d+(?:/\d+)?\")\s+(?:OD|Outside Diameter)\b", re.I)),
    ("Trade no.", re.compile(r"\bTrade (?:No\.|Number|Size)\s*([0-9A-Z-]+)", re.I)),
    ("Pack", re.compile(r"\bPacks? of\s+(\d+)\b", re.I)),
    ("Price", re.compile(r"\$\s?\d{1,5}(?:,\d{3})*(?:\.\d{2})?(?:\s*(?:per|/)\s*(?:pack(?:\s+of\s+\d+)?|each))?", re.I)),
)


def specs_of(text: str) -> dict[str, str]:
    """The few facts a title or snippet tends to say."""
    out: dict[str, str] = {}
    for name, rx in _SPECS:
        if m := rx.search(text or ""):
            v = (m.group(1) if m.groups() and m.group(1) else m.group(0)).strip()
            out[name] = re.sub(r"\s+", " ", v)
    low = (text or "").lower()
    for mat in _MATERIALS:
        if mat.lower() in low:
            out["Material"] = mat
            break
    return out


def parse(rows: list[dict]) -> list[dict]:
    """Search results ({title, url, description}) as McMaster parts, each
    once, in the order found: {key, title, url, specs, snippet, source}. A
    number in a result's own address is the result's part; numbers in its
    title or snippet are parts it names (a category page lists many)."""
    seen: dict[str, dict] = {}
    for r in rows:
        url = str(r.get("url") or "")
        title = linked.clean_title(str(r.get("title") or ""), "McMaster-Carr")
        desc = str(r.get("description") or "")
        if DOMAIN not in url.lower():
            continue
        own = _IN_URL.search(url)
        named = [own.group(1).upper()] if own else []
        named += [p for p in PART.findall(f"{title} {desc}") if p not in named]
        text = f"{title}. {desc}"
        for i, p in enumerate(named[:12]):
            mine = bool(own and i == 0)
            got = seen.get(p)
            if got and (got["own"] or not mine):
                for a, v in specs_of(text).items():
                    got["specs"].setdefault(a, v)
                continue
            # A result about another page (a category's) says more of the part in the snippet's sentence with it.
            line = title
            if not mine or not line:
                m = re.search(r"[^.;|]*" + re.escape(p) + r"[^.;|]*", desc)
                line = (m.group(0).strip(" -:,") if m else "") or title
            seen[p] = {"key": p, "title": line[:200] or p, "url": url_of(p), "specs": specs_of(text),
                       "snippet": desc[:300], "source": url, "own": mine}
    parts = [{a: v for a, v in h.items() if a != "own"} for h in seen.values()]
    return parts + categories(rows)[:max(0, MAX_CATEGORIES - len(parts) // 2)]


MAX_CATEGORIES = 6
_CATEGORY = re.compile(r"mcmaster\.com/products/([^?#\s]+?)/?(?:[?#]|$)", re.I)


def categories(rows: list[dict]) -> list[dict]:
    """The category pages a search found (it finds those far more often than
    one part's page): {key "cat:<path>", kind "category", title, url, specs
    - the filters already in its address, "thread-size~m3" as Thread size:
    M3}. Opened, they list the parts with their numbers to pick from."""
    out: dict[str, dict] = {}
    for r in rows:
        url = str(r.get("url") or "")
        m = _CATEGORY.search(url)
        if not m or _IN_URL.search(url):
            continue
        path = m.group(1).strip("/").lower()
        if path in out:
            continue
        specs: dict[str, str] = {}
        for seg in path.split("/")[1:]:
            name, _, val = seg.partition("~")
            if val:
                v = val.replace("-", " ")
                specs[name.replace("-", " ").capitalize()] = v.upper() if len(v) <= 12 else v
        title = linked.clean_title(str(r.get("title") or ""), "McMaster-Carr") or path.split("/")[0].replace("-", " ").title()
        out[path] = {"key": f"cat:{path}", "kind": "category", "title": title[:200],
                     "url": f"https://www.mcmaster.com/products/{path}/", "specs": specs,
                     "snippet": str(r.get("description") or "")[:300], "source": url}
    return list(out.values())


# What the words searched say that McMaster's addresses filter on, as they
# write it: /products/<category>/system-of-measurement~metric/length~10-mm/thread-size~m3/
_THREAD = re.compile(r"\bm\s?(\d{1,2}(?:[.,]\d)?)\b", re.I)
_LENGTH = re.compile(r"(?:\bx\s*|\b)(\d{1,3}(?:[.,]\d)?)\s*mm\b", re.I)
_STOP = {"mm", "x", "and", "for", "with", "the", "a", "of", "screw", "screws", "ve", "icin", "için"}


def filters_of(q: str) -> list[tuple[str, str, str]]:
    """(address part, label, value) for each filter the words name: a metric
    thread (M3 -> thread-size~m3, metric), a length (10 mm -> length~10-mm)."""
    out: list[tuple[str, str, str]] = []
    m = _THREAD.search(q)
    if m:
        size = m.group(1).replace(",", ".")
        out.append(("system-of-measurement~metric", "System", "Metric"))
        rest = q[:m.start()] + q[m.end():]
        n = _LENGTH.search(rest)
        if n:
            ln = n.group(1).replace(",", ".")
            out.append((f"length~{ln.replace('.', '-')}-mm", "Length", f"{ln} mm"))
        out.append((f"thread-size~m{size.replace('.', '-')}", "Thread size", f"M{size}"))
    # Without a thread, "15 mm" is a rail's width, a bearing's bore or a screw's
    # diameter as often as a length: no filter is guessed for it.
    return out


def _words(q: str) -> set[str]:
    return {w for w in re.findall(r"[a-zçğıöşü]{3,}", q.lower()) if w not in _STOP} | \
           ({"phillips"} if re.search(r"phil+ip", q, re.I) else set())


def refine(items: list[dict], q: str) -> list[dict]:
    """Category pages made to land on the size asked for - its filters added
    to the address - and put in order of how many of the words they carry;
    parts stay first."""
    q = english(q)
    fl = filters_of(q)
    words = _words(q)
    want = next((f[0] for f in fl if f[0].startswith("thread-size~")), None)
    parts = [i for i in items if i.get("kind") != "category"]
    cats = []
    for c in items:
        if c.get("kind") != "category":
            continue
        path = c["key"][4:]
        # A category of another thread size than the one asked for (M10 Standoffs for M3) is left out.
        other = next((seg for seg in path.split("/") if seg.startswith("thread-size~")), None)
        # ("m8-2" is M8 with its 2 mm pitch, the same size; "m3-5" is M3.5, another one.)
        if want and other and other != want and not (other.startswith(want + "-") and other != want + "-5"):
            continue
        have = {seg.partition("~")[0] for seg in path.split("/")}
        add = [f for f in fl if f[0].partition("~")[0] not in have]
        if add:
            path = path.rstrip("/") + "/" + "/".join(f[0] for f in add)
            c = {**c, "url": f"https://www.mcmaster.com/products/{path}/",
                 "specs": {**c.get("specs", {}), **{f[1]: f[2] for f in add}}, "filtered": True}
        text = f"{c['title']} {path}".lower().replace("-", " ")
        cats.append((sum(1 for w in words if w in text), c))
    cats.sort(key=lambda t: -t[0])
    return parts + [c for _, c in cats]


# McMaster's catalog is in English: the Turkish a person types for common
# hardware, as McMaster names it (longest first, so "lineer ray" is not "ray").
_TR = [("bilyalı rulman", "ball bearing"), ("bilyali rulman", "ball bearing"), ("lineer rulman", "linear bearing"),
       ("lineer ray", "linear rail"), ("lineer kızak", "linear guide carriage"), ("lineer kizak", "linear guide carriage"),
       ("lineer mil", "linear shaft"), ("bilyalı mil", "ball screw"), ("bilyali mil", "ball screw"),
       ("trapez mil", "lead screw"), ("vidalı mil", "lead screw"), ("vidali mil", "lead screw"),
       ("alüminyum profil", "aluminum extrusion"), ("aluminyum profil", "aluminum extrusion"),
       ("sigma profil", "aluminum extrusion"), ("mil bileziği", "shaft collar"), ("mil bilezigi", "shaft collar"),
       ("ısıl somun", "heat-set insert"), ("isil somun", "heat-set insert"), ("ısıyla gömülen somun", "heat-set insert"),
       ("triger kayış", "timing belt"), ("triger kayis", "timing belt"), ("triger kasnak", "timing belt pulley"),
       ("basma yayı", "compression spring"), ("çekme yayı", "extension spring"), ("burulma yayı", "torsion spring"),
       ("mesafe burcu", "standoff"), ("altıgen ara parça", "standoff"), ("havşa başlı", "flat head"),
       ("yıldız başlı", "phillips"), ("yildiz", "phillips"), ("imbus", "socket head"), ("allen", "socket head"),
       ("paslanmaz", "stainless steel"), ("pirinç", "brass"), ("alüminyum", "aluminum"), ("aluminyum", "aluminum"),
       ("kızak", "linear guide carriage"), ("kizak", "linear guide carriage"), ("araba", "carriage"),
       ("rulman", "ball bearing"), ("yatak", "bearing"), ("kaplin", "shaft coupling"), ("kasnak", "pulley"),
       ("kayış", "belt"), ("kayis", "belt"), ("dişli", "gear"), ("disli", "gear"), ("menteşe", "hinge"),
       ("mentese", "hinge"), ("tekerlek", "caster wheel"), ("yay", "spring"), ("somun", "nut"), ("pul", "washer"),
       ("cıvata", "bolt"), ("civata", "bolt"), ("vida", "screw"), ("mıknatıs", "magnet"), ("miknatis", "magnet"),
       ("conta", "gasket"), ("oring", "o-ring"), ("mil", "shaft"), ("burç", "bushing"), ("burc", "bushing"),
       ("tutucu", "holder"), ("braket", "bracket"), ("ayak", "leveling foot")]


def english(q: str) -> str:
    """The words in McMaster's English: Turkish hardware names put in its words,
    the rest kept ("lineer ray 15mm" -> "linear rail 15mm")."""
    low = q.lower()
    for tr, en in _TR:
        low = re.sub(rf"(?<![\wçğıöşü]){re.escape(tr)}(?:ları|leri|lar|ler|ı|i|u|ü)?(?![\wçğıöşü])", en, low)
    # Nothing Turkish in it: the words as they were typed.
    return re.sub(r"\s+", " ", low).strip() if low != q.lower() else q.strip()


def searches(q: str) -> list[str]:
    e = english(q)
    return [e, f"{e} McMaster-Carr part number"]


# ---------------------------------------------------------------- the API, later

SETTINGS = "server_settings"
SETTINGS_ID = "mcmaster"


class NotWired(Exception):
    """The McMaster-Carr API is not called yet: access is pending."""


class Api:
    """The adapter the official API's calls will go through, once McMaster
    approves access (https://www.mcmaster.com/help/api/): a login with the
    user name and password over the client certificate, then a part's CAD
    links and the STEP itself. Every method says it is not wired yet; the
    page and the routes already go through here."""

    def __init__(self, conf: dict):
        self.conf = conf

    async def login(self) -> None:
        raise NotWired("the McMaster-Carr API is not wired in yet (access is pending)")

    async def cad_links(self, part: str) -> list[dict]:
        """[{format: "3-D STEP", url}] of a part."""
        raise NotWired("the McMaster-Carr API is not wired in yet (access is pending)")

    async def download_step(self, part: str) -> tuple[str, bytes]:
        """(file name, bytes) of the part's 3-D STEP."""
        raise NotWired("the McMaster-Carr API is not wired in yet (access is pending)")


async def conf(db) -> dict:
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    return dict(await raw[SETTINGS].find_one({"_id": SETTINGS_ID}) or {})


def filled(c: dict) -> bool:
    """Everything the API needs is there (not that it works: nothing asks it yet)."""
    return bool(c.get("username") and c.get("password") and c.get("cert"))


def public(c: dict) -> dict:
    """What a page may see: never a password or the certificate itself."""
    cert = c.get("cert") or None
    return {"username": c.get("username") or "", "password_set": bool(c.get("password")),
            "cert": {"name": cert.get("name"), "bytes": cert.get("bytes"), "at": cert.get("at")} if cert else None,
            "cert_password_set": bool(c.get("cert_password")), "auto_step": bool(c.get("auto_step")),
            "filled": filled(c), "connected": False, "wired": False, "set_at": c.get("set_at")}


async def api(db) -> Api | None:
    """The adapter, when its credentials are all filled in."""
    c = await conf(db)
    return Api(c) if filled(c) else None


async def auto_step(db, doc: dict) -> None:
    """A part just saved, with the API set to fetch STEPs by itself: asked of
    the adapter - which says it is not wired yet; that is kept on the part."""
    c = await conf(db)
    if not (c.get("auto_step") and filled(c)):
        return
    try:
        name, data = await Api(c).download_step(doc["key"])
        await linked.put_files(db, KIND, doc["_id"], name, data, prefix=f"{MID}_")
    except (NotWired, ValueError) as exc:
        await db[linked.COLL].update_one({"_id": doc["_id"]}, {"$set": {"fetch": {"error": str(exc), "at": _now()}}})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


KIND = linked.register(linked.Kind(
    id=MID, name="McMaster-Carr", domain=DOMAIN, site=SITE, noun="part", key_label="Part number", how=HOW,
    summary="Parts saved from McMaster-Carr: found through a web search, never read from its site; each links to "
            "its own page, and its STEP, downloaded there, is kept here for the CAD models.",
    key_of=part_of, url_of=url_of, searches=searches, parse=parse, search_site=DOMAIN,
    accept=(".step", ".stp", ".zip"), after_save=auto_step,
    refine=refine))


# ---------------------------------------------------------------- routes

router = APIRouter(prefix="/api/mcmaster")


def _db():
    from .main import db
    return db()


@router.get("/parts/{key}/cad")
async def api_cad(key: str) -> dict:
    """"Download STEP" through the API: once it is wired, the part's CAD
    links from McMaster. Until then it says what to do instead."""
    part = part_of(key)
    if not part:
        raise HTTPException(404, f"{key} is not a McMaster-Carr part number")
    adapter = await api(_db())
    if adapter is None:
        raise HTTPException(409, f"the McMaster-Carr API is not connected - open {url_of(part)} and {HOW}")
    try:
        return {"part": part, "links": await adapter.cad_links(part)}
    except NotWired as exc:
        raise HTTPException(501, f"{exc} - open {url_of(part)} and {HOW}") from exc


@router.get("/settings")
async def get_settings() -> dict:
    return public(await conf(_db()))


class SettingsIn(BaseModel):
    # Left out: unchanged. "" clears it.
    username: str | None = Field(default=None, max_length=200)
    password: str | None = Field(default=None, max_length=300)
    cert_password: str | None = Field(default=None, max_length=300)
    auto_step: bool | None = None


async def _set(sets: dict, unset: list[str], changed: list[str]) -> dict:
    db = _db()
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    upd: dict = {}
    if sets:
        upd["$set"] = {**sets, "set_at": _now()}
    if unset:
        upd["$unset"] = {k: "" for k in unset}
    if upd:
        await raw[SETTINGS].update_one({"_id": SETTINGS_ID}, upd, upsert=True)
        # Which fields changed - never their values.
        await actors.audit(db, "settings", "mcmaster", {"changed": changed})
    return public(await conf(db))


@router.put("/settings")
async def put_settings(body: SettingsIn) -> dict:
    sets, unset, changed = {}, [], []
    for k in ("username", "password", "cert_password"):
        v = getattr(body, k)
        if v is None:
            continue
        v = v.strip()
        if v:
            sets[k] = v
        else:
            unset.append(k)
        changed.append(f"{k} {'set' if v else 'cleared'}")
    if body.auto_step is not None:
        sets["auto_step"] = body.auto_step
        changed.append("auto_step")
    return await _set(sets, unset, changed)


@router.post("/settings/cert")
async def put_cert(upload: UploadFile = File(...)) -> dict:
    """The client certificate McMaster issues with API access (a .pfx / .p12)."""
    data = await upload.read(64 * 1024 + 1)
    if not data or len(data) > 64 * 1024:
        raise HTTPException(400, "a client certificate file of at most 64 KB")
    name = re.sub(r"[^\w .()-]+", "_", upload.filename or "certificate")[:120]
    cert = {"name": name, "bytes": len(data), "data": base64.b64encode(data).decode(), "at": _now()}
    return await _set({"cert": cert}, [], ["certificate set"])


@router.delete("/settings/cert")
async def drop_cert() -> dict:
    return await _set({}, ["cert"], ["certificate cleared"])


@router.post("/test")
async def test() -> dict:
    """A stub, and says so: nothing asks McMaster until access is approved."""
    c = await conf(_db())
    if not filled(c):
        raise HTTPException(400, "fill in the user name, the password and the certificate first")
    try:
        await Api(c).login()
    except NotWired as exc:
        return {"ok": False, "implemented": False, "message": f"not implemented yet: {exc}"}
    return {"ok": True, "implemented": True}
