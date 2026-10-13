"""Search-and-link sources: sites whose parts and models Workbench finds
through a web search and links to, never reading the site itself, and the
ones a workspace saved from them with the CAD files the person downloaded.

McMaster-Carr (backend/mcmaster.py) and GrabCAD (backend/grabcad.py) are
two: McMaster does not allow its pages to be scraped and GrabCAD's files
need its own login, so neither is fetched. A source here is a `Kind` - its
site, how an item's key is read out of an address or a pasted number, the
web searches that find its items (Jina Search, backend/jina.py: the same
calls, log and cost as the Chat's web_search) and how their results are read,
what the person does on the item's page to download it - registered once.
Registering one also lists it as a built-in source of the Product Catalog
(backend/catalog_builtin.py), and the Chat gets its `<id>_find` and
`<id>_save` tools (backend/chat_tools/linked_find.py, linked_save.py).

A saved item (collection `linked_parts`, the workspace's - backend/
scope.py) is a source and a key - a McMaster part number, a GrabCAD model's
slug - with its title, link, notes, tags, a quantity, a licence and the
specs the search showed; and, once the person drops them on it, its CAD
files: kept in Files (folder "<source>", named `<prefix><key>...`) like any
other, a ZIP unpacked and only its STEP and mesh files kept. The first STEP
(else the first mesh) is the item's `cad`: the Files tab draws its picture,
and `revisions.py linked to-model <source>:<key> --folder F` makes it a
model a CAD design imports (POST .../to-model, as Files' "Add to project").
"""

from __future__ import annotations

import io
import re
import secrets
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Awaitable, Callable

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import access, actors, jina

COLL = "linked_parts"
MAX_TAGS = 12
MAX_FILES = 40                                   # CAD files kept out of one ZIP
CAD_SUFFIXES = (".step", ".stp", ".stl", ".3mf", ".obj", ".glb")


@dataclass(frozen=True)
class Kind:
    id: str
    name: str
    domain: str
    site: str
    noun: str                                    # "part", "model"
    key_label: str                               # "Part number", "Model"
    how: str                                     # what to click on the item's page for its files
    summary: str
    key_of: Callable[[str], str | None]          # a key out of a pasted number or address
    url_of: Callable[[str], str]                 # the item's own page
    searches: Callable[[str], list[str]]         # the words of each search, tried in turn
    parse: Callable[[list[dict]], list[dict]]    # search results as items: {key, title, url, specs, ...}
    search_site: str = ""                        # Jina Search's `site`
    accept: tuple[str, ...] = (".step", ".stp")  # what may be dropped on an item
    caution: str = ""                            # one line said beside every result
    enough: int = 3                              # a search that finds this many needs no second one
    after_save: Callable[[object, dict], Awaitable[None]] | None = None
    refine: Callable[[list[dict], str], list[dict]] | None = None   # the items read again with the words searched
    extra: tuple[str, ...] = field(default_factory=tuple)   # fields an item has besides the common ones


KINDS: dict[str, Kind] = {}


def register(k: Kind) -> Kind:
    """A source, and its place among the catalog's built-in sources."""
    from .catalog_builtin import Source, register as register_source
    KINDS[k.id] = k
    register_source(Source(id=k.id, name=k.name, domain=k.domain, url=k.site, view="linked",
                           summary=k.summary, products=lambda db, k=k: products(db, k)))
    return k


def kind(src: str) -> Kind:
    from . import catalog_builtin  # noqa: F401 - its modules register the sources
    k = KINDS.get(src)
    if not k:
        raise HTTPException(404, f"no source {src}")
    return k


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_title(t: str, *tails: str) -> str:
    """A search result's title without the site's name around it."""
    t = (t or "").strip()
    for tail in tails:
        t = re.sub(r"\s*[|·–—-]\s*" + tail + r"\s*$", "", t, flags=re.I)
        t = re.sub(r"^" + tail + r"\s*[|·–—-]\s*", "", t, flags=re.I)
    return t.strip()


# ---------------------------------------------------------------- finding

async def find_steps(k: Kind, q: str, *, count: int = 8, who: str = ""):
    """find() as it goes, for a page to follow: {"type": "search", n, of,
    words} before each web search, {"type": "got", n, rows, items, ms} after
    it, then {"type": "done", **find()'s answer}."""
    import time
    q = re.sub(r"\s+", " ", (q or "")).strip()[:200]
    out: dict = {"ok": False, "results": [], "queries": [], "error": None}
    if not q:
        out["error"] = "say what to look for"
        yield {"type": "done", **out}
        return
    if not jina.configured():
        out["error"] = "web search is not set up (Settings > Proxy & Data: Jina's API key)"
        yield {"type": "done", **out}
        return
    rows: list[dict] = []
    wordings = list(k.searches(q))
    for i, words in enumerate(wordings, 1):
        shown = words + (f" site:{k.search_site}" if k.search_site else "")
        yield {"type": "search", "n": i, "of": len(wordings), "words": shown}
        t0 = time.monotonic()
        got = await jina.search(words, site=k.search_site, num=jina.SEARCH_MAX, who=who)
        if not got["ok"] and re.search(r"\b(5\d\d|timed? ?out)\b", str(got.get("error") or ""), re.I):
            got = await jina.search(words, site=k.search_site, num=jina.SEARCH_MAX, who=who)   # a passing upstream error: once more
        out["queries"].append(shown)
        if not got["ok"]:
            yield {"type": "got", "n": i, "rows": 0, "items": len(k.parse(rows)), "ms": int((time.monotonic() - t0) * 1000),
                   "error": got["error"]}
            if not rows:
                out["error"] = got["error"]
            break
        rows += got["results"]
        items = len(k.parse(rows))
        yield {"type": "got", "n": i, "rows": len(got["results"]), "items": items,
               "ms": int((time.monotonic() - t0) * 1000), "enough": items >= k.enough}
        if items >= k.enough:
            break
    found = k.parse(rows)
    if k.refine:
        found = k.refine(found, q)
    out["results"] = found[:max(1, min(count, 20))]
    out["ok"] = out["error"] is None
    yield {"type": "done", **out}


async def find(k: Kind, q: str, *, count: int = 8, who: str = "") -> dict:
    """Items for words, from a web search of the source's site - never the
    site itself. The first search; the next, worded otherwise, only while
    fewer than `enough` items came up. {ok, results, queries, error}."""
    last: dict = {}
    async for ev in find_steps(k, q, count=count, who=who):
        last = ev
    return {key: v for key, v in last.items() if key != "type"}


# ---------------------------------------------------------------- the saved items

def _who(by: dict | None = None) -> dict:
    by = by or actors.current() or {}
    return {"id": by.get("id"), "name": by.get("name")}


def _tags(v) -> list[str]:
    items = v if isinstance(v, list) else re.split(r"[,\n]", str(v or ""))
    out: list[str] = []
    for t in items:
        t = re.sub(r"\s+", " ", str(t)).strip().lstrip("#")[:40]
        if t and t.lower() not in (x.lower() for x in out):
            out.append(t)
    return out[:MAX_TAGS]


def _qty(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        n = int(float(str(v).replace(",", ".")))
    except (TypeError, ValueError) as exc:
        raise ValueError("the quantity is a whole number") from exc
    if not 0 <= n <= 10_000_000:
        raise ValueError("the quantity is out of range")
    return n


TEXTS = {"title": 200, "notes": 2000, "licence": 200, "author": 120}


def clean(k: Kind, raw: dict, partial: bool = False) -> dict:
    """An item's fields as kept. Raises ValueError for what cannot be."""
    out: dict = {}
    if not partial or "key" in raw:
        key = k.key_of(str(raw.get("key") or raw.get("url") or ""))
        if not key:
            raise ValueError(f"that is not a {k.name} {k.key_label.lower()} or a link to one")
        out["key"] = key
    for f, n in TEXTS.items():
        if f in raw and (f in ("title", "notes") or f in k.extra):
            out[f] = re.sub(r"[ \t]+", " ", str(raw.get(f) or "")).strip()[:n]
    if "tags" in raw:
        out["tags"] = _tags(raw.get("tags"))
    if "quantity" in raw:
        out["quantity"] = _qty(raw.get("quantity"))
    if isinstance(raw.get("specs"), dict):
        out["specs"] = {str(a)[:40]: str(b)[:120] for a, b in list(raw["specs"].items())[:12] if str(b).strip()}
    return out


async def get(db, k: Kind, key: str) -> dict | None:
    """A saved item by its id or its key."""
    return (await db[COLL].find_one({"_id": key, "source": k.id})
            or await db[COLL].find_one({"source": k.id, "key": k.key_of(key) or key}))


async def listing(db, k: Kind) -> list[dict]:
    return [d async for d in db[COLL].find({"source": k.id}).sort("created_at", -1)]


async def save(db, k: Kind, raw: dict, by: dict | None = None) -> tuple[dict, bool]:
    """An item saved; one saved already is given back, its empty fields
    filled and its tags added to. (doc, new)."""
    f = clean(k, raw)
    who, now = _who(by), _now()
    have = await db[COLL].find_one({"source": k.id, "key": f["key"]})
    if have:
        sets = {a: v for a, v in f.items() if a not in ("key", "tags", "quantity") and v and not have.get(a)}
        if f.get("quantity") is not None and have.get("quantity") is None:
            sets["quantity"] = f["quantity"]
        tags = _tags([*(have.get("tags") or []), *(f.get("tags") or [])])
        if tags != (have.get("tags") or []):
            sets["tags"] = tags
        if sets:
            sets.update(updated_at=now, updated_by=who)
            await db[COLL].update_one({"_id": have["_id"]}, {"$set": sets})
        return {**have, **sets}, False
    doc = {"_id": secrets.token_hex(6), "source": k.id, "key": f["key"], "title": f.get("title") or "",
           "url": k.url_of(f["key"]), "notes": f.get("notes") or "", "tags": f.get("tags") or [],
           "quantity": f.get("quantity"), "specs": f.get("specs") or {},
           **{x: f.get(x) or "" for x in k.extra}, "cad": None, "files": [], "by": who,
           "created_at": now, "updated_at": now}
    await db[COLL].insert_one(doc)
    if k.after_save:
        await k.after_save(db, doc)
    return doc, True


async def edit(db, k: Kind, key: str, raw: dict) -> dict | None:
    have = await get(db, k, key)
    if not have:
        return None
    f = clean(k, {a: v for a, v in raw.items() if a != "key"}, partial=True)
    if not f:
        return have
    f.update(updated_at=_now(), updated_by=_who())
    await db[COLL].update_one({"_id": have["_id"]}, {"$set": f})
    return {**have, **f}


def may_delete(doc: dict) -> bool:
    """One's own item, or anyone's with the right to delete."""
    return (doc.get("by") or {}).get("id") == actors.current().get("id") or access.allowed(access.current(), "delete")


async def remove(db, k: Kind, key: str) -> dict | None:
    """The saved item goes; its files stay in Files (a model may be made of them)."""
    have = await get(db, k, key)
    if not have:
        return None
    await db[COLL].delete_one({"_id": have["_id"]})
    return have


# ---------------------------------------------------------------- its CAD files

def _suffix(name: str) -> str:
    return PurePosixPath(name or "").suffix.lower()


def cad_files(name: str, data: bytes, accept: tuple[str, ...]) -> list[tuple[str, bytes]]:
    """What was dropped, as the CAD files in it: itself, or a ZIP's STEP and
    mesh files (a folder's path left out; at most MAX_FILES, and never more
    unpacked than Files keeps). Raises ValueError when there are none."""
    from . import files
    sfx = _suffix(name)
    if sfx not in accept:
        raise ValueError("a " + ", ".join(s.lstrip(".").upper() for s in accept) + " file")
    if sfx != ".zip":
        return [(PurePosixPath(name).name, data)]
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("that ZIP could not be opened") from exc
    want = [i for i in z.infolist() if not i.is_dir() and _suffix(i.filename) in CAD_SUFFIXES
            and not PurePosixPath(i.filename).name.startswith(("._", "."))]
    if not want:
        raise ValueError("there is no STEP, STL, 3MF or OBJ file in that ZIP")
    want = want[:MAX_FILES]
    if sum(i.file_size for i in want) > files.MAX_BYTES:
        raise ValueError(f"its CAD files are larger than {files.MAX_BYTES // (1024 * 1024)} MB unpacked")
    return [(PurePosixPath(i.filename).name, z.read(i)) for i in want]


def _check(name: str, data: bytes) -> None:
    if _suffix(name) in (".step", ".stp") and not data[:4096].lstrip().startswith(b"ISO-10303-21"):
        raise ValueError(f"{name} is not a STEP (it does not start with ISO-10303-21)")


async def put_files(db, k: Kind, key: str, name: str, data: bytes, by: dict | None = None,
                    prefix: str = "") -> dict | None:
    """Files dropped on a saved item, kept in Files (folder named after the
    source) as <prefix><key>.<ext> - one file - or <prefix><key>_<name> -
    several -, names a model made of them can be imported by. The first
    STEP, else the first mesh, is its `cad`. Files kept before stay."""
    from . import files
    have = await get(db, k, key)
    if not have:
        return None
    got = cad_files(name, data, k.accept)
    for n, d in got:
        _check(n, d)
    who = _who(by)
    folder = await files.make_path(db, k.name, who)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", f"{prefix}{have['key']}")
    kept = []
    for n, d in got:
        nm = f"{stem}{_suffix(n)}" if len(got) == 1 else f"{stem}_{n}"
        doc = await files.put(db, nm, d, None, {"room": "cad", "linked": f"{k.id}:{have['key']}"}, who,
                              note=f"{k.name} {have['key']}" + (f" - {have['title']}" if have.get("title") else "")
                                   + f" ({have.get('url') or k.url_of(have['key'])})", folder=folder["_id"])
        kept.append({"file": doc["_id"], "name": doc["name"], "kind": doc["kind"], "bytes": doc["bytes"],
                     "sha256": doc["sha256"], "original": n[:200], "by": who, "at": _now()})
    all_files = [*kept, *(have.get("files") or [])][:100]
    cad = next((f for f in kept if f["kind"] == "step"), None) or next((f for f in kept if f["kind"] == "mesh"), None)
    sets = {"files": all_files, "updated_at": _now(), **({"cad": cad} if cad else {})}
    await db[COLL].update_one({"_id": have["_id"]}, {"$set": sets, "$unset": {"fetch": ""}})
    return {**have, **sets}


async def out(db, docs: list[dict]) -> list[dict]:
    """Saved items for a page: whether the CAD file's picture is drawn yet
    (files.py: the first page that shows it draws it)."""
    from . import files
    keys = {files.solid_key(d["cad"]["sha256"]) for d in docs if (d.get("cad") or {}).get("sha256")}
    have = set()
    if keys:
        have = {x["_id"] async for x in db[files.SOLID_THUMBS].find({"_id": {"$in": list(keys)}}, {"_id": 1})}
    res = []
    for d in docs:
        o = {a: v for a, v in d.items() if a not in ("_id", "workspace_id")}
        o["id"] = d["_id"]
        if c := d.get("cad"):
            o["cad"] = {**c, "has_thumb": f"{c['sha256'][:12]}.{files.SOLID_VERSION}"
                        if files.solid_key(c.get("sha256") or "") in have else None}
        res.append(o)
    return res


# ---------------------------------------------------------------- as a catalog source

def product(k: Kind, p: dict) -> dict:
    """A saved item as a catalog product (backend/catalog_builtin.py)."""
    c = p.get("cad") or None
    specs = {k.key_label: p["key"], **({"Author": p["author"]} if p.get("author") else {}), **(p.get("specs") or {}),
             **({"Licence": p["licence"]} if p.get("licence") else {}),
             **({"Quantity": str(p["quantity"])} if p.get("quantity") is not None else {}),
             "CAD": c["name"] if c else "not yet"}
    thumb = f"/api/files/{c['file']}/thumb?v={c['has_thumb']}" if c and c.get("has_thumb") else ""
    return {"id": p["key"], "name": p.get("title") or p["key"], "category": (p.get("tags") or ["Saved"])[0],
            "description": p.get("notes") or "", "specs": specs, "sku": p["key"], "url": p.get("url") or k.url_of(p["key"]),
            "image": thumb, "images": [], "seller": {"domain": k.domain, "host": k.site.split("//")[-1], "name": k.name},
            "added_at": p.get("created_at"), "linked": p}


async def products(db, k: Kind) -> list[dict]:
    return [product(k, p) for p in await out(db, await listing(db, k))]


# ---------------------------------------------------------------- routes

router = APIRouter(prefix="/api/linked")


def _db():
    from .main import db
    return db()


def _404(k: Kind, key: str):
    raise HTTPException(404, f"no saved {k.name} {k.noun} {key}")


@router.get("/{src}/search")
async def api_search(src: str, q: str = "", n: int = 10) -> dict:
    """The Catalog's "Find on ...": the same search as the Chat's <src>_find."""
    k = kind(src)
    got = await find(k, q[:200], count=n, who="catalog")
    if got["error"] and not got["results"]:
        raise HTTPException(400 if not q.strip() else 502, got["error"])
    saved = {d["key"] async for d in _db()[COLL].find({"source": k.id}, {"key": 1})}
    return {**got, "how": k.how, "caution": k.caution,
            "results": [{**r, "saved": r["key"] in saved} for r in got["results"]]}


@router.get("/{src}/search/stream")
async def api_search_stream(src: str, q: str = "", n: int = 10):
    """The same search, told as it goes (text/event-stream): each web search
    as it starts and what it brought, then the answer with what is saved."""
    import json
    from fastapi.responses import StreamingResponse
    k = kind(src)
    db = _db()

    async def events():
        async for ev in find_steps(k, q[:200], count=n, who="catalog"):
            if ev["type"] == "done":
                saved = {d["key"] async for d in db[COLL].find({"source": k.id}, {"key": 1})}
                ev = {**ev, "how": k.how, "caution": k.caution,
                      "results": [{**r, "saved": r["key"] in saved} for r in ev["results"]]}
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode()

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/{src}/parts")
async def api_list(src: str) -> list[dict]:
    return await out(_db(), await listing(_db(), kind(src)))


class ItemIn(BaseModel):
    key: str = Field(min_length=1, max_length=400)        # the key, or the item's address
    title: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=4000)
    tags: list[str] | str | None = None
    quantity: int | str | None = None
    specs: dict[str, str] | None = None
    licence: str | None = Field(default=None, max_length=300)
    author: str | None = Field(default=None, max_length=200)


@router.post("/{src}/parts")
async def api_add(src: str, body: ItemIn) -> dict:
    k = kind(src)
    try:
        doc, new = await save(_db(), k, body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if new:
        await actors.audit(_db(), "linked-save", f"{k.id}:{doc['key']}")
    return {"part": (await out(_db(), [await get(_db(), k, doc["_id"]) or doc]))[0], "new": new}


class ItemPatch(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=4000)
    tags: list[str] | str | None = None
    quantity: int | str | None = None
    licence: str | None = Field(default=None, max_length=300)
    author: str | None = Field(default=None, max_length=200)


@router.patch("/{src}/parts/{key}")
async def api_edit(src: str, key: str, body: ItemPatch) -> dict:
    k = kind(src)
    try:
        doc = await edit(_db(), k, key, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        _404(k, key)
    return (await out(_db(), [doc]))[0]


@router.delete("/{src}/parts/{key}")
async def api_delete(src: str, key: str) -> dict:
    k = kind(src)
    have = await get(_db(), k, key)
    if not have:
        _404(k, key)
    if not may_delete(have):
        raise HTTPException(403, "only whoever saved it, or someone who may delete, can remove it")
    await remove(_db(), k, have["_id"])
    await actors.audit(_db(), "linked-remove", f"{k.id}:{have['key']}")
    return {"deleted": have["key"]}


@router.post("/{src}/parts/{key}/files")
async def api_files(src: str, key: str, upload: UploadFile = File(...)) -> dict:
    """The files downloaded from the item's page, dropped on it."""
    from . import files
    k = kind(src)
    data = await upload.read(files.MAX_BYTES + 1)
    if len(data) > files.MAX_BYTES:
        raise HTTPException(413, f"larger than {files.MAX_BYTES // (1024 * 1024)} MB")
    try:
        doc = await put_files(_db(), k, key, upload.filename or "", data, prefix=f"{k.id}_")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        _404(k, key)
    await actors.audit(_db(), "linked-files", f"{k.id}:{doc['key']}", {"files": [f["file"] for f in doc["files"][:5]]})
    return (await out(_db(), [doc]))[0]


class ToModel(BaseModel):
    folder: str = Field(min_length=1, max_length=300)
    title: str | None = Field(default=None, max_length=120)
    file: str | None = Field(default=None, max_length=40)   # one of its files; its `cad` when left out


@router.post("/{src}/parts/{key}/to-model")
async def api_to_model(src: str, key: str, body: ToModel) -> dict:
    """Its CAD file into a project as a model of its own - a purchased or
    downloaded part - as Files' "Add to project" makes one (main.py
    files_to_model), named by its source and key."""
    from .main import FileToModel, files_to_model
    k = kind(src)
    have = await get(_db(), k, key)
    if not have:
        _404(k, key)
    fid = body.file or (have.get("cad") or {}).get("file")
    if not fid or not any(f["file"] == fid for f in have.get("files") or []):
        raise HTTPException(409, f"{have['key']} has no CAD file yet - on {have.get('url') or k.url_of(have['key'])}: "
                                 f"{k.how}, then drop it on the {k.noun}")
    title = body.title or f"{k.name} {have['key']}" + (f" {have['title']}" if have.get("title") else "")
    return await files_to_model(fid, FileToModel(folder=body.folder, title=title[:120]))
