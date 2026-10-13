"""Taste palettes ("Tadım"): what makes a design good, as statements an
agent can follow.

A palette is a named list of short, checkable statements - "Walls 2 mm,
outside edges filleted 1 mm", "No vias in pads", "Every task feeds the
watchdog" - each with a domain (mechanical, pcb, firmware, general), a
strength (must, prefer, avoid), an optional why, and where it came from
(written by hand, or extracted from a project).

How the agents get it:

- in Chat, a palette is an @-mention like a note (backend/cc_context.py,
  kind "taste"); and a palette attached to a model or a board goes along
  by itself whenever that model or board is mentioned;
- a room's agent reads the palettes attached to the model, board or
  firmware a queued note is about when it shows the note
  (tools/revisions.py show / next), and `revisions.py taste` prints them.

Extraction (`extract`) reads what is known about a finished project - its
source, a board's rules and checks, a firmware's code, its notes and drawn
notes - or every project under a folder at once (`gather_folder`, bought
parts left out), and asks the "taste" job's model (Settings > LLM settings) for
proposals. It runs as a background job (`taste_jobs`, see "extraction as a
job" below) that writes each step - every project read, the question, the
answer read - as it goes, so the page can show the run line by line and
find it again after a reload. The proposals wait on the job; nothing goes
into a palette until the person has looked at each one and saved the ones
they want (a separate call).

Palettes belong to the workspace (backend/scope.py) and say who made them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import socket
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors, llm

router = APIRouter(prefix="/api/taste")

COLL = "taste_palettes"
JOB = "taste"
# The form language first: how a design looks is what text alone missed.
DOMAINS = ("form", "mechanical", "pcb", "firmware", "general")
STRENGTHS = ("must", "prefer", "avoid")
PROJECT_KINDS = ("model", "board", "firmware")
# Where an item holds: on what is seen, on what is not (a hidden face, the
# inside of a case), inside the product; or a few words of its own
# ("openings in visible walls"). Missing is "all", as every item was before.
SCOPES = ("all", "visible", "hidden", "internal")
# What an item is: the person's design language, carried to whatever they
# design next, or a fact of the product it was read from (its fan
# connector, its cell) - kept whole, so that product can be made again as
# it is, and applied only to it or a new version of it.
LAYERS = ("language", "specific")
MAX_ITEMS = 300                 # in one palette
MAX_TEXT = 400                  # one statement
MAX_WHY = 400
MAX_SCOPE = 120
MAX_EXCEPTION = 300
MAX_EXAMPLE = 300
BLOCK_CHARS = 8_000             # one palette, as an agent reads it
PROPOSALS = (8, 30)             # what extraction asks for
SOURCE_CHARS = 40_000           # what extraction reads of a project
EXTRACT_TOKENS = 6_000
EXTRACT_TIMEOUT = 180.0
FOLDER_PROPOSALS = (12, 50)     # a folder: every project in it, read at once
FOLDER_CHARS = 120_000          # what extraction reads of a folder, split among its projects
FOLDER_TOKENS = 10_000
FOLDER_TIMEOUT = 300.0
STOCK_FOLDERS = ("purchased",)  # bought parts drawn to size: not the designer's taste

DOMAIN_NAMES = {"form": "Form language", "mechanical": "Mechanical", "pcb": "PCB", "firmware": "Firmware",
                "general": "General"}
SCOPE_NAMES = {"visible": "visible surfaces", "hidden": "hidden surfaces", "internal": "internal features"}

# Said first in every palette an agent reads, unless the palette says its own.
PRIORITY = ("On visible surfaces appearance wins over printability rules; if a MUST conflicts with "
            "the form language, ask on screen instead of choosing.")
MAX_PRIORITY = 600


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db():
    from .main import db
    return db()


# ---- items -------------------------------------------------------------------

def _line(v, n: int) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def clean_scope(v) -> str:
    """One of SCOPES, or a few words of its own; "all" when nothing is said."""
    text = _line(v, MAX_SCOPE)
    low = text.lower()
    aliases = {"": "all", "any": "all", "everywhere": "all", "seen": "visible", "outside": "visible",
               "exterior": "visible", "external": "visible", "not visible": "hidden", "inside": "internal",
               "interior": "internal"}
    low = aliases.get(low, low)
    return low if low in SCOPES else text


def clean_seen(v) -> dict | None:
    """In how many of the projects read an item was seen: {n, m}."""
    if not isinstance(v, dict):
        return None
    try:
        n, m = int(v.get("n")), int(v.get("m"))
    except (TypeError, ValueError):
        return None
    if m < 1 or n < 1:
        return None
    return {"n": min(n, m), "m": m}


def clean_item(raw: dict, source: dict | None = None) -> dict | None:
    """One statement made whole, or None when there is no statement in it.
    An item from before scopes and layers reads as applying everywhere
    and as design language - which is how it was used."""
    text = _line(raw.get("text"), MAX_TEXT)
    if not text:
        return None
    domain = str(raw.get("domain") or "").strip().lower()
    strength = str(raw.get("strength") or "").strip().lower()
    layer = str(raw.get("layer") or "").strip().lower()
    why = _line(raw.get("why"), MAX_WHY)
    exception = _line(raw.get("exception"), MAX_EXCEPTION)
    example = _line(raw.get("example"), MAX_EXAMPLE)
    seen = clean_seen(raw.get("seen"))
    src = raw.get("source") if source is None else source
    if isinstance(src, dict) and src.get("kind") in (*PROJECT_KINDS, "folder") and src.get("id"):
        src = {"kind": src["kind"], "id": str(src["id"])[:200], "label": str(src.get("label") or src["id"])[:200]}
    else:
        src = "manual"
    return {"id": str(raw.get("id") or "") or secrets.token_hex(4), "text": text,
            "domain": domain if domain in DOMAINS else "general",
            "strength": strength if strength in STRENGTHS else "prefer",
            "applies_to": clean_scope(raw.get("applies_to")),
            "layer": layer if layer in LAYERS else "language",
            **({"why": why} if why else {}), **({"exception": exception} if exception else {}),
            **({"example": example} if example else {}), **({"seen": seen} if seen else {}),
            "source": src}


def item_out(it: dict) -> dict:
    """An item as it is read: one kept before scopes and layers gets them."""
    return {**it, "applies_to": it.get("applies_to") or "all",
            "layer": it.get("layer") if it.get("layer") in LAYERS else "language"}


def counts(items: list[dict]) -> dict:
    out = {d: 0 for d in DOMAINS}
    for it in items:
        out[it.get("domain") if it.get("domain") in DOMAINS else "general"] += 1
    return out


# ---- palettes ----------------------------------------------------------------

async def create(db, name: str, description: str = "", items: list[dict] | None = None,
                 by: dict | None = None) -> dict:
    now = _now()
    kept = [i for i in (clean_item(x) for x in (items or [])[:MAX_ITEMS]) if i]
    doc = {"_id": secrets.token_hex(6), "name": name.strip()[:120], "description": description.strip()[:1000],
           "items": kept, "attached": [], "pinned": False, "by": by or actors.current(),
           "created_at": now, "updated_at": now}
    await db[COLL].insert_one(doc)
    return doc


async def get(db, pid: str) -> dict | None:
    return await db[COLL].find_one({"_id": pid})


async def listing(db, q: str = "") -> list[dict]:
    rows = [d async for d in db[COLL].find({})]
    words = [w for w in q.lower().split() if w]
    if words:
        def hay(d):
            return " ".join([d.get("name") or "", d.get("description") or "",
                             *(i.get("text") or "" for i in d.get("items") or [])]).lower()
        rows = [d for d in rows if all(w in hay(d) for w in words)]
    rows.sort(key=lambda d: d.get("updated_at") or "", reverse=True)
    rows.sort(key=lambda d: not d.get("pinned"))
    return rows


async def _save(db, pid: str, sets: dict) -> dict | None:
    from pymongo import ReturnDocument
    return await db[COLL].find_one_and_update({"_id": pid}, {"$set": {**sets, "updated_at": _now()}},
                                              return_document=ReturnDocument.AFTER)


async def patch(db, pid: str, name: str | None = None, description: str | None = None,
                pinned: bool | None = None, priority: str | None = None) -> dict | None:
    sets: dict = {}
    if priority is not None:
        # Empty is the standard rule again.
        sets["priority"] = priority.strip()[:MAX_PRIORITY] or None
    if name is not None:
        sets["name"] = name.strip()[:120]
    if description is not None:
        sets["description"] = description.strip()[:1000]
    if pinned is not None:
        sets["pinned"] = bool(pinned)
    if not sets:
        return await get(db, pid)
    return await _save(db, pid, sets)


async def add_items(db, pid: str, items: list[dict], at: int | None = None) -> dict | None:
    doc = await get(db, pid)
    if not doc:
        return None
    have = list(doc.get("items") or [])
    seen = {i["id"] for i in have}
    new = []
    for raw in items:
        it = clean_item({**raw, "id": None})
        if it and it["id"] not in seen:
            seen.add(it["id"])
            new.append(it)
    if len(have) + len(new) > MAX_ITEMS:
        raise ValueError(f"a palette holds at most {MAX_ITEMS} items")
    if at is None or not 0 <= at <= len(have):
        have.extend(new)
    else:
        have[at:at] = new
    return await _save(db, pid, {"items": have})


async def edit_item(db, pid: str, iid: str, change: dict) -> dict | None:
    doc = await get(db, pid)
    if not doc:
        return None
    items = list(doc.get("items") or [])
    for n, it in enumerate(items):
        if it["id"] == iid:
            merged = {**it, **{k: v for k, v in change.items() if v is not None}}
            got = clean_item(merged, it.get("source") or "manual")
            if not got:
                raise ValueError("an item needs its text")
            items[n] = got
            return await _save(db, pid, {"items": items})
    return None


async def remove_item(db, pid: str, iid: str) -> dict | None:
    doc = await get(db, pid)
    if not doc or not any(i["id"] == iid for i in doc.get("items") or []):
        return None
    return await _save(db, pid, {"items": [i for i in doc["items"] if i["id"] != iid]})


async def reorder(db, pid: str, ids: list[str]) -> dict | None:
    """The items in the order given; any left out keep their place after."""
    doc = await get(db, pid)
    if not doc:
        return None
    by = {i["id"]: i for i in doc.get("items") or []}
    order = [by.pop(i) for i in dict.fromkeys(ids) if i in by]
    return await _save(db, pid, {"items": order + [i for i in doc.get("items") or [] if i["id"] in by]})


async def attach(db, pid: str, targets: list[dict]) -> dict | None:
    """Which projects this palette goes with: every agent working on one of
    them gets it. Checked against the workspace - only what is there. Each
    keeps its product line (for whether the project-specific items go
    along) and, when the person set it, `specifics`: on or off for that
    project whatever its line; left out, it follows the line."""
    out, seen = [], set()
    for t in targets:
        kind, ref = t.get("kind"), str(t.get("id") or "")
        if kind not in PROJECT_KINDS or not ref or (kind, ref) in seen:
            continue
        label = await project_label(db, kind, ref)
        if label is None:
            raise KeyError(f"{kind} {ref}")
        seen.add((kind, ref))
        row = {"kind": kind, "id": ref, "label": label, "product": await product_of(db, kind, ref)}
        if isinstance(t.get("specifics"), bool):
            row["specifics"] = t["specifics"]
        out.append(row)
    return await _save(db, pid, {"attached": out})


async def remove(db, pid: str) -> bool:
    return bool((await db[COLL].delete_one({"_id": pid})).deleted_count)


# ---- projects ----------------------------------------------------------------

_PROJECT_COLL = {"model": "models", "board": "boards", "firmware": "firmware"}


async def project_label(db, kind: str, ref: str) -> str | None:
    d = await db[_PROJECT_COLL[kind]].find_one({"_id": ref}, {"title": 1, "name": 1})
    if not d:
        return None
    return d.get("title") or d.get("name") or ref


# ---- product lines -------------------------------------------------------------
#
# A palette's project-specific items are for the product they were read
# from: that project, or a new version of it. A project's product line is
# its top folder ("iot-fan" for iot-fan/parts/lid, iot-fan/electronics's
# board, that board's firmware); a new version is a folder named after it
# ("iot-fan-80mm", "iot-fan_v2", "iot-fan2").

async def product_of(db, kind: str, ref: str) -> str:
    if kind in ("model", "folder"):
        return ref.split("/", 1)[0]
    if kind == "firmware":
        fw = await db["firmware"].find_one({"_id": ref}, {"board": 1}) or {}
        if fw.get("board"):
            kind, ref = "board", str(fw["board"])
        else:
            return ref
    b = await db["boards"].find_one({"_id": ref}, {"folder": 1}) or {}
    return (b.get("folder") or ref).split("/", 1)[0]


def _norm(name: str) -> str:
    return re.sub(r"\s+", "-", str(name or "").strip().lower())


def same_line(a: str | None, b: str | None) -> bool:
    """Whether two products are one line: the same, or one the other's new
    version (its name, then a separator, a digit or a v)."""
    a, b = _norm(a or ""), _norm(b or "")
    if not a or not b:
        return False
    if a == b:
        return True
    short, long = sorted((a, b), key=len)
    return long.startswith(short) and bool(re.match(r"[-_. ]|v?\d", long[len(short):]))


def sources(doc: dict) -> list[dict]:
    """The projects a palette was read from - the runs saved into it and its
    items' own sources - each with its product line: [{kind, id, label, product}]."""
    out: dict[tuple, dict] = {}
    for o in doc.get("origins") or []:
        if isinstance(o, dict) and o.get("id"):
            out[(o.get("kind"), o["id"])] = {"kind": o.get("kind"), "id": o["id"], "label": o.get("label") or o["id"],
                                             "product": o.get("product") or str(o["id"]).split("/", 1)[0]}
    for it in doc.get("items") or []:
        src = it.get("source")
        if isinstance(src, dict) and src.get("id") and (src.get("kind"), src["id"]) not in out:
            out[(src.get("kind"), src["id"])] = {**src, "product": str(src["id"]).split("/", 1)[0]
                                                 if src.get("kind") in ("model", "folder") else src["id"]}
    return list(out.values())


def specifics_for(doc: dict, product: str | None = None, note: str = "", override: bool | None = None) -> bool | None:
    """Whether the project-specific items apply: as the person set it for
    this application (`override`); else yes when the work is on the
    palette's own product line, or the note names that product; else no.
    None when nothing says what the work is on."""
    if isinstance(override, bool):
        return override
    srcs = sources(doc)
    if product and any(same_line(product, s["product"]) for s in srcs):
        return True
    words = str(note or "").lower()
    if words and any(len(n) >= 3 and re.search(r"(?<!\w)" + re.escape(n).replace("\\-", "[-_ ]") + r"(?!\w)", words)
                     for s in srcs for n in {_norm(s["product"]), _norm(s.get("label") or "")} if n):
        return True
    return False if product or note else None


async def projects(db, q: str = "", limit: int = 60, folders: bool = False) -> list[dict]:
    """Models, boards and firmware of the workspace, for the pickers; with
    `folders`, the folders that hold any of them first (extraction reads a
    folder whole)."""
    words = [w for w in q.lower().split() if w]
    out: list[dict] = []
    if folders:
        for f in await folder_list(db):
            row = {"kind": "folder", "id": f["id"], "label": f["id"], "sub": f["sub"]}
            if all(w in f"{f['id']} {f['sub']}".lower() for w in words):
                out.append(row)
    subs = {"model": lambda d: d["_id"] + ".3d",
            "board": lambda d: d["_id"] + ".pcb" + (f" · {d['folder']}" if d.get("folder") else ""),
            "firmware": lambda d: "firmware · " + str(d.get("board") or "")}
    for kind, coll in _PROJECT_COLL.items():
        async for d in db[coll].find({}, {"title": 1, "name": 1, "folder": 1, "board": 1}):
            label = d.get("title") or d.get("name") or d["_id"]
            row = {"kind": kind, "id": d["_id"], "label": label, "sub": subs[kind](d)}
            if all(w in f"{label} {d['_id']} {row['sub']}".lower() for w in words):
                out.append(row)
    order = ("folder", *PROJECT_KINDS)
    out.sort(key=lambda r: (order.index(r["kind"]), str(r["label"]).lower()))
    return out[:limit]


def _in(folder: str, path: str | None) -> bool:
    return bool(path) and (path == folder or path.startswith(folder + "/"))


def _stock(path: str | None) -> bool:
    return any(seg in STOCK_FOLDERS for seg in (path or "").split("/"))


async def folder_projects(db, folder: str) -> list[tuple[str, str]]:
    """Every model, board and firmware under a folder (its subfolders too),
    bought parts left out: (kind, id)."""
    got: list[tuple[str, str]] = []
    async for d in db["models"].find({}, {"folder": 1}).sort("_id", 1):
        if _in(folder, d.get("folder")) and not _stock(d.get("folder")):
            got.append(("model", d["_id"]))
    boards = []
    async for d in db["boards"].find({}, {"folder": 1}).sort("_id", 1):
        if _in(folder, d.get("folder")):
            boards.append(d["_id"])
            got.append(("board", d["_id"]))
    if boards:
        async for d in db["firmware"].find({"board": {"$in": boards}}, {"_id": 1}).sort("_id", 1):
            got.append(("firmware", d["_id"]))
    return got


async def folder_list(db) -> list[dict]:
    """The folders that hold a model or a board, top ones included, each with
    what it holds: [{id, sub}]."""
    paths: dict[str, list[int]] = {}
    for coll, at in (("models", 0), ("boards", 1)):
        async for d in db[coll].find({}, {"folder": 1}):
            f = d.get("folder") or ""
            if not f or (coll == "models" and _stock(f)):
                continue
            parts = f.split("/")
            for i in range(1, len(parts) + 1):
                paths.setdefault("/".join(parts[:i]), [0, 0])[at] += 1
    out = []
    for f, (m, b) in sorted(paths.items()):
        bits = [f"{m} {'model' if m == 1 else 'models'}"] if m else []
        if b:
            bits.append(f"{b} {'board' if b == 1 else 'boards'}")
        out.append({"id": f, "sub": " · ".join(bits)})
    return out


async def attached_to(db, kind: str, ref: str) -> list[dict]:
    """The palettes attached to one project."""
    return [d for d in await listing(db)
            if any(a.get("kind") == kind and a.get("id") == ref for a in d.get("attached") or [])]


def overrides_for(palettes: list[dict], kind: str, ref: str) -> dict:
    """{palette id: on/off} where the person set the project-specific items
    for this project's attachment; the rest follow the product line."""
    got = {}
    for p in palettes:
        for a in p.get("attached") or []:
            if a.get("kind") == kind and a.get("id") == ref and isinstance(a.get("specifics"), bool):
                got[p["_id"]] = a["specifics"]
    return got


# ---- what an agent reads -----------------------------------------------------

def _item_line(i: dict) -> str:
    i = item_out(i)
    scope = i["applies_to"]
    tag = "" if scope == "all" else f" [{SCOPE_NAMES.get(scope, scope)}]"
    line = f"- {i['strength'].upper()}{tag}: {i['text']}"
    if i.get("exception"):
        line += f" (except: {i['exception']})"
    if i.get("example"):
        line += f" (e.g. {i['example']})"
    if i.get("seen"):
        line += f" (seen in {i['seen']['n']} of {i['seen']['m']} projects)"
    if i.get("why"):
        line += f" (why: {i['why']})"
    return line


def ref_path(pid: str, r: dict) -> str:
    return f"/api/taste/{pid}/refs/{r['id']}"


def block(doc: dict, limit: int = BLOCK_CHARS, product: str | None = None, note: str = "",
          override: bool | None = None) -> str:
    """A palette as an agent reads it: the priority rule first, then where
    it came from and whether its project-specific items apply to this work
    (`product`, `note`, `override` - see specifics_for), its reference
    renders, then the design language by domain, MUST first, then PREFER,
    then AVOID, each with its scope, exception, example and why; the
    project-specific items last. Clipped to `limit`."""
    items = [item_out(i) for i in doc.get("items") or []]
    head = f"Design taste to follow (palette \"{doc.get('name') or doc['_id']}\")"
    if doc.get("description"):
        head += f" - {doc['description']}"
    lines = [head + ":", "Priority: " + (doc.get("priority") or PRIORITY)]
    srcs = sources(doc)
    specific = [i for i in items if i["layer"] == "specific"]
    lang = [i for i in items if i["layer"] != "specific"]
    line_names = ", ".join(dict.fromkeys(s["product"] for s in srcs))
    if srcs:
        lines.append("Read from: " + ", ".join(f"{s['kind']} {s['label']}" for s in srcs)
                     + f" (product line: {line_names}).")
    on = specifics_for(doc, product, note, override)
    if specific:
        if on is True:
            lines.append(f"Applying to {product or line_names}: the palette's own product line (or a new version of it) - "
                         "follow the design language AND the project-specific items, which describe this product as it is.")
        elif on is False:
            lines.append(f"Applying to {product or 'another product'}: not {line_names} - follow the design language only; "
                         "the project-specific items are background about another product: do not apply them.")
        else:
            lines.append(f"The design language applies to any product; the project-specific items apply only to "
                         f"{line_names or 'the product it was read from'} or a new version of it.")
    refs = doc.get("references") or []
    if refs:
        lines.append(f"Reference renders of the source ({len(refs)}; look at them before designing - "
                     f"`revisions.py taste {doc['_id']}` writes them to disk): "
                     + ", ".join(f"{r.get('view')} of {r.get('model') or '?'} {ref_path(doc['_id'], r)}" for r in refs))
    if doc.get("measures"):
        lines.append("Measured on the source: " + _clip(doc["measures"], 1500).replace("\n", "; "))
    if doc.get("notice"):
        lines.append("Note: " + doc["notice"])
    if not items:
        lines.append("(no items yet)")

    def group(rows: list[dict]) -> None:
        for dom in DOMAINS:
            mine = [i for i in rows if i["domain"] == dom]
            if not mine:
                continue
            lines.append(f"{DOMAIN_NAMES[dom]}:")
            for st in STRENGTHS:
                lines.extend(_item_line(i) for i in mine if i["strength"] == st)

    if lang:
        if specific:
            lines.append("DESIGN LANGUAGE (for any product):")
        group(lang)
    if specific:
        lines.append(f"PROJECT-SPECIFIC ({line_names or 'source'}) - "
                     + ("APPLY: this work is on that product." if on is True else
                        "background only, not carried over to another product." if on is False else
                        "only for that product or a new version of it."))
        group(specific)
    text = "\n".join(lines)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit("\n", 1)[0]
    left = len(items) - cut.count("\n- ")
    return cut + f"\n[... {left} more items of this palette left out]"


CHECK = ("Before you finish: the Taste check. Render the result from the same views as the reference renders "
         "(`revisions.py taste-check <palette> <model>` takes them and puts each reference beside it), compare them "
         "item by item - the form language first - fix what does not match, and end your report with a section "
         "\"Taste check\": every item that applies, pass or fail, and the before/after renders.")


def agent_text(palettes: list[dict], limit: int = BLOCK_CHARS * 3, product: str | None = None, note: str = "",
               overrides: dict | None = None) -> str:
    """Several palettes, for a room's agent working on `product` (the note's
    project's product line) about `note`: each block, then how to use them.
    `overrides`: {palette id: True/False} - the person's choice of
    project-specific items for this application (an attachment's)."""
    if not palettes:
        return ""
    each = max(1500, limit // len(palettes))
    overrides = overrides or {}
    body = "\n\n".join(block(p, each, product, note, overrides.get(p["_id"])) for p in palettes)
    looks = any(p.get("references") or any(item_out(i)["domain"] == "form" for i in p.get("items") or [])
                for p in palettes)
    return (body + "\n\nFollow MUST items; follow PREFER items unless the note says otherwise; never do AVOID "
            "items. An item holds where its scope says (visible surfaces, hidden ones, internal features) and "
            "not where its exception says. Apply the design language to whatever product you are designing - "
            "a new product gets the same form, edges, colours and details, scaled by the ratios given; "
            "project-specific items apply only where the palette says so above. On visible surfaces appearance "
            "wins over printability rules; if a MUST conflicts with the form language or the note, ask on screen "
            "(`revisions.py ask`) instead of choosing."
            + ("\n\nOpen the reference renders before you design. " + CHECK if looks else ""))


# ---- extraction --------------------------------------------------------------

EXTRACT_PROMPT = (
    "You read a finished hardware project from Workbench (a 3D CAD model in build123d, a circuit "
    "board in atopile/KiCad, or ESP32 firmware) and distil its designer's taste: the decisions that make it "
    "good and that the designer wants repeated.\n\n"
    "The designer makes a product line - next time it may be a charger, a shaver or a car, not this product. "
    "So sort every statement into one of two layers:\n"
    "- \"language\": the designer's DESIGN LANGUAGE, true of any product they make: form and proportions, "
    "edge treatment (radii, chamfers), surface finish and colour scheme, how openings, buttons, icons, seams, "
    "panels, vents and fasteners are styled, printability and tolerance habits, how they work. Write it as a "
    "transferable principle, with a relative measure where one exists (\"Outer corner radius about N% of the "
    "part's smallest outer dimension, the same on every corner\", \"Every visible edge of an opening chamfered "
    "A-B mm\", \"Body in one colour, functional accents in a second\") - the numbers from the measurements "
    "and the source, never from these examples - and put the absolute values measured on this project in "
    "\"example\" (\"<part>: R<r> on a <d> mm deep body (<r/d>%)\").\n"
    "- \"specific\": facts of THIS product - its components and their choices (a 4-pin fan connector, an 18650 "
    "cell, magnets holding a module), its mechanisms, its layout decisions, its board's own rules, its measured "
    "sizes. Keep these complete and exact: with them the same product can be made again as it is.\n"
    "The test for each statement: would it hold for a charger, a shaver or a lamp by the same designer? Yes: "
    "language. Only for this product: specific. A finished product nearly always has both - write the "
    "specifics it has (its main components and how they are held, its connectors, its mechanisms and their "
    "ranges, its key dimensions and layout) as well as the language.\n\n"
    "Each statement must be:\n"
    "- concrete and checkable: numbers, parts, placements, rules;\n"
    "- seen in the material - the source, the measurements, the pictures, the notes: do not invent;\n"
    "- scoped: \"applies_to\" is \"visible\" (seen surfaces), \"hidden\" (surfaces nobody sees), \"internal\" "
    "(inside the product), \"all\", or a few words (\"openings in visible walls\"); \"exception\" says where it "
    "does not hold. Printability rules (overhangs of at least 45 degrees, teardrop holes, no supports) are for "
    "hidden and internal features: a visible opening keeps its designed shape (a bridge, a chamfer, or asking) - "
    "say so in the exception. Appearance rules are for visible surfaces.\n"
    "Where the person corrected the design (drawn notes, notes), the correction is strong taste.\n\n"
    "Domains: \"form\" (the form language: what the product looks like - silhouette, proportions, corner and edge "
    "radii, chamfers, recesses and wells, embossed or debossed icons and labels, two-tone colour split, flush or "
    "inset panels, seams and parting lines, how a button or a screen sits in its face), \"mechanical\" (how parts "
    "are made and fit: walls, tolerances, fasteners, printing), \"pcb\", \"firmware\", \"general\".\n\n"
    f"Write between {PROPOSALS[0]} and {PROPOSALS[1]} statements. "
    "Reply with JSON only - no prose, no Markdown fence: an array of objects "
    "{\"text\": the statement, \"domain\": \"form\"|\"mechanical\"|\"pcb\"|\"firmware\"|\"general\", "
    "\"layer\": \"language\"|\"specific\", \"strength\": \"must\"|\"prefer\"|\"avoid\", "
    "\"applies_to\": \"visible\"|\"hidden\"|\"internal\"|\"all\"|words, \"exception\": where it does not hold or \"\", "
    "\"example\": the measured values on this project or \"\", \"why\": one short reason}. "
    "Write \"avoid\" items as what not to do (\"Vias in pads\"), not with \"never\" in front. "
    "Write in the language the person's notes are written in; English if there are none."
)

LOOK_PROMPT = (
    "\n\nYou also get renders of the project's main model from several views and measurements taken from "
    "its own parts' STEP files (bought parts left out). Read the form language from them: look at every "
    "picture, name what is consistent (the same radius on every outer corner, every opening chamfered, "
    "buttons in recessed wells, icons embossed, frame one colour and body another, panels flush), and give "
    "the measured numbers. At least a quarter of the statements should be \"form\" items when there are "
    "pictures. A measurement that comes from a bought part or a hidden feature is not form language."
)

TEXT_ONLY_PROMPT = (
    "\n\nThere are no pictures this time, only the measurements (if any) and the text: write \"form\" items "
    "only from what the measurements and the source show."
)


_LAYER_WORDS = {"project": "specific", "project-specific": "specific", "project_specific": "specific",
                "specifics": "specific", "design language": "language", "design-language": "language",
                "general": "language", "transferable": "language"}


def parse_proposals(raw: str, source: dict, most: int = PROPOSALS[1], stats: dict | None = None,
                    projects: int | None = None) -> list[dict]:
    """The model's answer as items: the JSON array (fenced or bare, or under
    an "items" key), each made whole, duplicates dropped, at most `most`.
    `stats`, when given, is told what was dropped: {rows, invalid,
    duplicates, over}. With `projects` (a folder's, how many were read),
    each row's "seen_in" becomes the item's seen {n, m}; the items seen
    in more of them come first within their domain and strength."""
    text = (raw or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    data = None
    for cand in (text, text[text.find("["): text.rfind("]") + 1] if "[" in text else "",
                 text[text.find("{"): text.rfind("}") + 1] if "{" in text else ""):
        if not cand:
            continue
        try:
            data = json.loads(cand)
            break
        except ValueError:
            continue
    if isinstance(data, dict):
        data = data.get("items") or data.get("taste") or data.get("statements")
    if not isinstance(data, list):
        raise ValueError("the model did not answer with a JSON list")
    out, seen = [], set()
    tally = {"rows": len(data), "invalid": 0, "duplicates": 0, "over": 0}
    for n, row in enumerate(data):
        if len(out) >= most:
            tally["over"] = len(data) - n
            break
        if isinstance(row, str):
            row = {"text": row}
        if isinstance(row, dict):
            row = dict(row)
            lay = str(row.get("layer") or "").strip().lower()
            row["layer"] = _LAYER_WORDS.get(lay, lay)
            if projects and projects > 1 and row.get("seen_in") is not None:
                try:
                    row["seen"] = {"n": int(row["seen_in"]), "m": projects}
                except (TypeError, ValueError):
                    pass
        it = clean_item({**row, "id": None}, source) if isinstance(row, dict) else None
        if not it:
            tally["invalid"] += 1
            continue
        key = it["text"].lower()
        if key in seen:
            tally["duplicates"] += 1
            continue
        seen.add(key)
        out.append(it)
    if stats is not None:
        stats.update(tally)
    if projects and projects > 1:
        out.sort(key=lambda i: -(i.get("seen") or {}).get("n", 0))      # stable: the model's order otherwise
    return out


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + f"\n[... {len(s) - n:,} more characters left out]"


async def read_project(db, kind: str, ref: str, budget: int = SOURCE_CHARS) -> dict:
    """What is known about a project, as text for the model: {text, label,
    clipped (some of its own text was left out), revisions, notes, files}."""
    SOURCE = budget
    from . import cc_context
    parts: list[str] = []
    cut = False

    def clip(s: str, n: int) -> str:
        nonlocal cut
        cut = cut or len(s) > n
        return _clip(s, n)

    label = await project_label(db, kind, ref)
    if label is None:
        raise KeyError(f"{kind} {ref}")
    nfiles = 0
    if kind == "model":
        got = await cc_context._model(db, ref)
        parts.append(clip(got["text"] if got else "", SOURCE))
    elif kind == "board":
        got = await cc_context._board(db, ref)
        if got:
            parts.append(clip(got["text"], SOURCE // 2))
        src = (await db["boards"].find_one({"_id": ref}, {"source": 1}) or {}).get("source")
        if src:
            parts.append("Board source:\n```\n" + clip(src, SOURCE // 2) + "\n```")
    else:
        from . import firmware
        fw = await firmware.get(db, ref)
        parts.append(f"Firmware `{ref}` - \"{label}\" for board {fw.get('board')} ({fw.get('mcu_title') or fw.get('mcu') or '?'}), "
                     f"version {fw.get('version')}")
        b = fw.get("build") or {}
        if b.get("state"):
            parts.append(f"Last build: {b.get('state')}, {b.get('error_count', 0)} errors, {b.get('warning_count', 0)} warnings")
        files = await firmware.contents(db, ref)
        nfiles = len(files)
        left = SOURCE
        for path in sorted(files, key=lambda p: (not p.startswith("src/"), p)):
            if left <= 0:
                cut = True
                parts.append(f"[... {len(files)} files in all; the rest left out]")
                break
            body = clip(files[path], min(left, 12_000))
            left -= len(body)
            parts.append(f"File {path}:\n```\n{body}\n```")
    # What people said about it: its drawn notes and notes.
    revs = []
    async for r in db["revisions"].find({"$or": [{"model": ref}, {"board": ref}]},
                                       {"comment": 1, "summary": 1, "status": 1, "created_at": 1}):
        revs.append(r)
    revs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    if revs:
        parts.append("Drawn notes (changes people asked for), newest first:\n" + "\n".join(
            f"- [{r.get('status')}] {(r.get('comment') or r.get('summary') or '').strip()[:500]}" for r in revs[:40]))
    notes = []
    async for n in db["notes"].find({}, {"text": 1, "context": 1, "mentions": 1, "updated_at": 1}):
        ctx = n.get("context") or {}
        if ref in (ctx.get("model"), ctx.get("board")) or ref in (n.get("mentions") or []) \
                or ref.rsplit("/", 1)[-1] in (n.get("mentions") or []):
            notes.append(n)
    if notes:
        parts.append("Notes about it:\n" + "\n".join("- " + (n.get("text") or "").strip()[:800] for n in notes[:20]))
    return {"text": "\n\n".join(p for p in parts if p), "label": label, "clipped": cut,
            "revisions": min(len(revs), 40), "notes": min(len(notes), 20),
            **({"files": nfiles} if kind == "firmware" else {})}


async def gather(db, kind: str, ref: str, budget: int = SOURCE_CHARS) -> tuple[str, str]:
    """What is known about a project, as text for the model, and its name;
    its own text clipped to `budget` characters."""
    got = await read_project(db, kind, ref, budget)
    return got["text"], got["label"]


class ExtractError(Exception):
    """What the person is told when extraction cannot run or fails."""


class Stopped(Exception):
    """The run was ended from outside (cancelled, or settled as lost)
    while it worked: it stops without writing over that."""


class Tracker:
    """What an extraction says as it goes: its status (reading, asking,
    parsing), one row per step - each project read, the question to the
    model, reading its answer - and the totals. This one keeps it in
    memory (the tests read it); a job's writes it down (JobTracker)."""

    def __init__(self):
        self.status = "reading"
        self.steps: list[dict] = []
        self.totals: dict = {}
        self.meta: dict = {}
        self._t0: dict[str, float] = {}

    def row(self, sid: str) -> dict | None:
        return next((s for s in self.steps if s["id"] == sid), None)

    async def step(self, sid: str, **fields) -> dict:
        """Open or change one step's row; a state of done, skipped or failed
        closes it with its time."""
        import time
        row = self.row(sid)
        if row is None:
            row = {"id": sid, "state": "running", "started_at": _now()}
            self._t0[sid] = time.monotonic()
            self.steps.append(row)
        row.update(fields)
        if row["state"] in ("done", "skipped", "failed", "cancelled") and not row.get("finished_at"):
            row["finished_at"] = _now()
            row["seconds"] = round(time.monotonic() - self._t0.get(sid, time.monotonic()), 2)
        await self.flush()
        return row

    async def phase(self, status: str, **meta) -> None:
        self.status = status
        self.meta.update(meta)
        await self.flush()

    def add(self, **totals) -> None:
        self.totals.update({k: v for k, v in totals.items() if v is not None})

    def close_running(self, state: str, reason: str | None = None) -> None:
        """Every step still running ends as `state` (failed, cancelled),
        with the reason on it."""
        import time
        for row in self.steps:
            if row["state"] == "running":
                row.update({"state": state, "finished_at": _now(),
                            "seconds": round(time.monotonic() - self._t0.get(row["id"], time.monotonic()), 2)})
                if reason:
                    row["reason"] = reason

    async def flush(self) -> None:
        """Written down (a job's); in memory, nothing to do."""


FOLDER_PROMPT = (
    "\n\nThis time you read a whole project folder: every model, board and firmware in it, one after "
    f"another. Write between {FOLDER_PROPOSALS[0]} and {FOLDER_PROPOSALS[1]} statements in all: the form "
    "language (\"form\"), 3D design rules (\"mechanical\"), PCB rules (\"pcb\"), firmware rules "
    "(\"firmware\") and rules that hold across them (\"general\"). Cover every domain the folder has "
    "material for. Prefer what recurs across its parts over what one part does once. Each ===== block names "
    "its product; when the folder holds more than one product, give each statement \"seen_in\": in how many "
    "of the products it can be seen - what holds across products is the surest design language."
)


async def gather_folder(db, folder: str, track: Tracker | None = None) -> tuple[str, str]:
    """Every project under a folder, as text for the model, each given its
    share of the reading; each one a step of `track`."""
    track = track or Tracker()
    refs = await folder_projects(db, folder)
    if not refs:
        raise KeyError(f"folder {folder}")
    each = max(4_000, FOLDER_CHARS // len(refs))
    track.add(projects=len(refs), budget=FOLDER_CHARS)
    parts, left = [], FOLDER_CHARS
    for n, (kind, ref) in enumerate(refs):
        sid = f"read:{kind}:{ref}"
        if left <= 0:
            for k2, r2 in refs[n:]:
                await track.step(f"read:{k2}:{r2}", kind="read", project={"kind": k2, "id": r2, "label": r2},
                                 state="skipped", reason="the reading budget was used up", chars=0)
            parts.append(f"[... {len(refs)} projects in all; the rest left out]")
            break
        budget = min(each, left)
        await track.step(sid, kind="read", project={"kind": kind, "id": ref, "label": ref}, budget=budget)
        try:
            got = await read_project(db, kind, ref, budget)
        except Exception as exc:                        # noqa: BLE001 - one unreadable project skips, not stops
            await track.step(sid, state="skipped", chars=0,
                             reason=f"could not be read: {str(exc)[:160] or type(exc).__name__}")
            continue
        left -= len(got["text"])
        product = product_in(folder, ref) if kind == "model" else folder
        parts.append(f"===== {kind} \"{got['label']}\" ({ref}) - product {product} =====\n{got['text']}")
        await track.step(sid, state="done", project={"kind": kind, "id": ref, "label": got["label"]},
                         chars=len(got["text"]), clipped=got["clipped"], revisions=got["revisions"],
                         notes=got["notes"], **({"files": got["files"]} if "files" in got else {}))
    return "\n\n".join(parts), folder


# ---- looking at it: renders and measurements ------------------------------------
#
# Text alone missed what a design looks like: a palette read from source,
# notes and drawn notes came out as tolerances and screws, with no word on
# the rounded corners or the chamfered openings that make it what it is.
# So a model or a folder is also photographed - its main model, from the
# views tools/render.py --views takes (the same ones `revisions.py
# taste-check` takes a new design from, so the two line up) - and its own
# parts' STEP files are measured in the drawing image (tools/formmeasure.py:
# fillet radii, chamfers, walls, recesses, colours). The pictures go to the
# model when it reads images, and are kept with the run - and with the
# palette its proposals are saved into - as the palette's reference renders.

ROOT = Path(__file__).resolve().parent.parent
LOOK_VIEWS = ("iso", "iso-back", "front", "right", "top", "detail")
MORE_VIEWS = ("iso", "iso-back")      # a folder's second and third main models
RENDER_SIZE = (1200, 800)
RENDER_TIMEOUT = 480.0
MEASURE_TIMEOUT = 300.0
MAX_RENDERED = 3                      # main models of a folder photographed
MAX_MEASURED = 16                     # own parts measured
MAX_REFS = 18                         # reference renders one palette keeps
REF_BYTES = 4 * 1024 * 1024           # one reference render, imported
LLM_IMAGE_PX = 1024                   # the longer side a picture goes to the model at
_RENDERING = asyncio.Semaphore(1)     # one headless browser at a time


def _stock_model(d: dict) -> bool:
    return _stock(d.get("folder")) or _stock(d["_id"])


def _assembly(d: dict) -> bool:
    return "assemblies" in (d.get("folder") or d["_id"]).split("/")


def _own_part(d: dict) -> bool:
    """One of the designer's own parts, built: what is measured (an
    assembly's STEP holds bought parts too)."""
    return not _stock_model(d) and not _assembly(d) and bool((d.get("artifacts") or {}).get("step"))


KIND_FOLDERS = ("parts", "assemblies", "purchased", "electronics")


def product_in(folder: str, path: str) -> str:
    """Which product of a folder a model is: the folder itself when its
    parts sit in parts/, assemblies/...; a subfolder of its own otherwise
    (a folder of several products: lamp/, fan/, each with its parts)."""
    rest = path[len(folder) + 1:].split("/") if path.startswith(folder + "/") else []
    return f"{folder}/{rest[0]}" if len(rest) > 1 and rest[0] not in KIND_FOLDERS else folder


async def look_targets(db, kind: str, ref: str) -> tuple[list[str], list[str]]:
    """What to photograph (the main models, the biggest assembly first) and
    what to measure (the designer's own parts - bought parts left out)."""
    if kind == "model":
        d = await db["models"].find_one({"_id": ref}, {"uses": 1, "folder": 1, "artifacts": 1})
        if not d:
            return [], []
        parts, todo, seen = [], [ref], set()
        while todo and len(seen) < 200:
            mid = todo.pop()
            if mid in seen:
                continue
            seen.add(mid)
            m = await db["models"].find_one({"_id": mid}, {"uses": 1, "folder": 1, "artifacts": 1})
            if not m or _stock_model(m):
                continue
            todo.extend(u["id"] for u in m.get("uses") or [] if u.get("kind") == "model")
            if _own_part(m):
                parts.append(mid)
        shown = [ref] if (d.get("artifacts") or {}).get("viewer") else []
        return shown, sorted(parts)[:MAX_MEASURED]
    rows = [d async for d in db["models"].find({}, {"folder": 1, "uses": 1, "artifacts": 1})
            if _in(ref, d.get("folder")) and not _stock_model(d)]
    used = {u["id"] for d in rows for u in d.get("uses") or [] if u.get("kind") == "model"}
    tops = [d for d in rows if d["_id"] not in used and (d.get("artifacts") or {}).get("viewer")]
    tops.sort(key=lambda d: (not _assembly(d), -len(d.get("uses") or []), d["_id"]))
    # The biggest top model always; more only when they are assemblies too
    # (another product in the folder), not a part nobody imports.
    tops = tops[:1] + [d for d in tops[1:MAX_RENDERED] if _assembly(d)]
    parts = [d["_id"] for d in rows if _own_part(d)]
    return [d["_id"] for d in tops], sorted(parts)[:MAX_MEASURED]


async def _page_session(db) -> dict | None:
    """A page session for the headless browser, for whoever started the run
    and in their workspace (backend/auth.py); None with sign-in off."""
    from . import auth
    if not auth.enabled():
        return None
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    got = await auth.page_session_for_request(raw)
    return {"cookie": got["name"], "value": got["value"]} if got else None


async def render_views(db, model: str, views: tuple[str, ...] = LOOK_VIEWS,
                       size: tuple[int, int] = RENDER_SIZE) -> dict[str, bytes]:
    """The model's last build photographed from each view: {view: PNG},
    by tools/render.py --views in one browser. Raises with what it said."""
    import shutil
    import signal
    import sys
    import tempfile
    try:
        session = await _page_session(db)
    except PermissionError as exc:
        raise RuntimeError(f"no page session for the browser: {exc}") from exc
    work = Path(tempfile.mkdtemp(prefix="redline-taste-"))
    env = {k: v for k, v in os.environ.items() if k not in ("REDLINE_TOKEN", "REDLINE_PAGE_SESSION")}
    env["REDLINE_API"] = f"http://127.0.0.1:{os.environ.get('API_PORT', '8000')}"
    env["REDLINE_TOKEN"] = ""                     # never the agents' token from .env: this person's session or none
    if session:
        env["REDLINE_PAGE_SESSION"] = json.dumps(session)
    argv = [sys.executable, str(ROOT / "tools" / "render.py"), f"model:{model}", "--views", ",".join(views),
            "--width", str(size[0]), "--height", str(size[1]), "--free-aspect", "--no-wait", "--allow-stale",
            "-o", str(work / "views")]
    try:
        async with _RENDERING:
            proc = await asyncio.create_subprocess_exec(*argv, env=env, cwd=str(ROOT), stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.STDOUT)
            try:
                said, _ = await asyncio.wait_for(proc.communicate(), RENDER_TIMEOUT)
            except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
                # An interrupt lets render.py close its browser (its finally); then for sure.
                proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), 20)
                except asyncio.TimeoutError:
                    proc.kill()
                    rm = await asyncio.create_subprocess_exec("docker", "rm", "-f", f"redline-render-{proc.pid}",
                                                              stdout=asyncio.subprocess.DEVNULL,
                                                              stderr=asyncio.subprocess.DEVNULL)
                    await rm.wait()
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise RuntimeError(f"the render took longer than {RENDER_TIMEOUT:.0f} s") from exc
        got = {v: (work / "views" / f"{v}.png").read_bytes() for v in views
               if (work / "views" / f"{v}.png").exists()}
        if not got:
            lines = [ln for ln in said.decode(errors="replace").splitlines()
                     if ln.strip() and "Warning" not in ln and not ln.startswith(" ")]
            raise RuntimeError((lines[-1] if lines else f"render.py exited {proc.returncode}")[:300])
        return got
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def measure_parts(db, models: list[str]) -> dict[str, dict]:
    """Each model's STEP measured in the drawing image: {model: what
    tools/formmeasure.py found}. A model with no STEP is left out."""
    import shutil
    import tempfile
    from . import limits, release, store
    work = Path(tempfile.mkdtemp(prefix="redline-form-"))
    try:
        os.chmod(work, 0o777)
        (work / "in").mkdir()
        names = {}
        for m in models:
            try:
                step = await store.get_artifact(db, m, "step")
            except Exception:                           # noqa: BLE001 - not built: nothing to measure
                continue
            stem = re.sub(r"[^\w.-]", "__", m)
            names[stem] = m
            (work / "in" / f"{stem}.step").write_bytes(step)
        if not names:
            return {}
        argv = ["docker", "run", "--rm", *limits.box(), "--network", "none",
                "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{work}:/work",
                "-v", f"{ROOT / 'tools'}:/tools:ro", "--entrypoint", "python3", release.DRAW_IMAGE,
                "/tools/formmeasure.py", "/work/in", "/work/out.json"]
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
        try:
            said, _ = await asyncio.wait_for(proc.communicate(), MEASURE_TIMEOUT)
        except asyncio.TimeoutError as exc:
            proc.kill()
            raise RuntimeError(f"measuring took longer than {MEASURE_TIMEOUT:.0f} s") from exc
        except asyncio.CancelledError:
            proc.kill()
            raise
        out = work / "out.json"
        if proc.returncode != 0 or not out.exists():
            text = said.decode(errors="replace").strip().splitlines()
            raise RuntimeError((text[-1] if text else f"the measuring stopped with exit {proc.returncode}")[:300])
        got = json.loads(out.read_text())
        return {names.get(k, k): v for k, v in got.items()}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _hist(rows, unit: str = "", prefix: str = "") -> str:
    return ", ".join(f"{prefix}{v:g}{unit} x{n}" for v, n in rows or [])


def summarise(measured: dict[str, dict]) -> str:
    """The measurements as lines for the model and the palette: one per part."""
    lines = []
    for mid, m in measured.items():
        name = mid.rsplit("/", 1)[-1]
        if m.get("error"):
            lines.append(f"{name}: could not be measured ({m['error'][:120]})")
            continue
        size = m.get("size") or [0, 0, 0]
        bits = [f"{name} ({' x '.join(f'{v:g}' for v in size)} mm)"]
        small = min([v for v in size if v > 0] or [0])
        if m.get("vertical_corners"):
            r = m["vertical_corners"][0][0]
            rel = f" (R/smallest side {r / small * 100:.0f}%)" if small else ""
            bits.append("rounded vertical corners " + _hist(m["vertical_corners"], prefix="R") + rel)
        if m.get("fillets_convex"):
            bits.append("outside fillets " + _hist(m["fillets_convex"], prefix="R"))
        if m.get("fillets_concave"):
            bits.append("inside corner radii " + _hist(m["fillets_concave"], prefix="R"))
        if m.get("chamfers"):
            bits.append("chamfers " + _hist(m["chamfers"], " mm"))
        if m.get("walls"):
            bits.append("walls " + _hist(m["walls"], " mm"))
        if m.get("recessed"):
            bits.append("recessed faces (wells, debossing, insets) " + _hist(m["recessed"], " mm deep"))
        if m.get("raised"):
            bits.append("raised faces (embossing, lips) " + _hist(m["raised"], " mm high"))
        if m.get("holes"):
            bits.append("holes " + _hist(m["holes"][:6], prefix="d"))
        cols = m.get("colours") or {}
        total = sum(cols.values()) or 1
        if cols:
            bits.append("colours " + ", ".join(f"{c} {a / total * 100:.0f}%"
                                               for c, a in sorted(cols.items(), key=lambda x: -x[1])[:4]))
        lines.append("; ".join(bits))
    return "\n".join(lines)


async def reads_images(prov: str, model: str) -> bool:
    try:
        for m in await llm.models(prov):
            if m["id"] == model:
                return bool(m.get("vision"))
    except Exception:                                   # noqa: BLE001 - the name says it
        pass
    return llm.vision({"id": model})


async def vision_route() -> tuple[str, str, bool]:
    """(provider, model, reads images) for the question: the Taste job's own
    model; when it does not read images, the first other configured job's
    model that does (said on the palette); else the Taste model, text only."""
    prov, model = llm.route(JOB)
    if await reads_images(prov, model):
        return prov, model, True
    for j in llm.JOBS:
        p2, m2 = llm.route(j)
        if llm.key(p2) and (p2, m2) != (prov, model) and await reads_images(p2, m2):
            return p2, m2, True
    return prov, model, False


def _for_model(png: bytes) -> str:
    """A render as the model gets it: at most LLM_IMAGE_PX, as a JPEG data URL."""
    import base64
    import io
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("RGB")
    im.thumbnail((LLM_IMAGE_PX, LLM_IMAGE_PX))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


async def look(db, kind: str, ref: str, track: Tracker) -> dict:
    """The project photographed and measured, each a step of `track`:
    {images: [(label, png)], references: [kept renders], measures: text,
    notices: [what could not be done]}. Nothing here stops the run."""
    from . import store
    got: dict = {"images": [], "references": [], "measures": "", "notices": []}
    renders, parts = await look_targets(db, kind, ref)
    if not renders:
        got["notices"].append("nothing built to photograph")
    for n, model in enumerate(renders):
        views = LOOK_VIEWS if n == 0 else MORE_VIEWS
        sid = f"render:{model}"
        await track.step(sid, kind="render", model=model, views=list(views))
        try:
            try:
                pngs = await render_views(db, model, views)
            except RuntimeError as first:
                # Once more: a page reloaded under the browser (a new build
                # of the app, a model rebuilt) spoils one take, not two.
                await track.step(sid, retry=str(first)[:200])
                await asyncio.sleep(5)
                pngs = await render_views(db, model, views)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                        # noqa: BLE001 - said, and the run goes on
            why = str(exc)[:300] or type(exc).__name__
            await track.step(sid, state="failed", reason=why)
            got["notices"].append(f"{model} could not be photographed ({why})")
            continue
        label = await project_label(db, "model", model) or model
        for v, png in pngs.items():
            shot = await store.put_shot(db, png)
            got["references"].append({"id": secrets.token_hex(4), "view": v, "model": model, "label": label,
                                      "gridfs_id": shot["gridfs_id"], "bytes": len(png), "size": list(RENDER_SIZE),
                                      "at": _now()})
            got["images"].append((f"{label}, {v} view", png))
        track.meta["references"] = got["references"]
        await track.step(sid, state="done", shots=len(pngs))
    if parts:
        await track.step("measure", kind="measure", parts=len(parts))
        try:
            measured = await measure_parts(db, parts)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                        # noqa: BLE001 - said, and the run goes on
            why = str(exc)[:300] or type(exc).__name__
            await track.step("measure", state="failed", reason=why)
            got["notices"].append(f"the parts could not be measured ({why})")
        else:
            got["measures"] = summarise(measured)
            await track.step("measure", state="done", measured=sum(1 for m in measured.values() if not m.get("error")),
                             chars=len(got["measures"]))
    return got


CHARS_PER_TOKEN = 4             # the estimate before the provider counts


def _failed(prov: str, model: str, exc: BaseException, timeout: float) -> str:
    """A model call that failed, in a sentence for the person."""
    import httpx
    name = llm.PROVIDERS.get(prov, {}).get("name", prov)
    if isinstance(exc, (asyncio.TimeoutError, httpx.TimeoutException)):
        return (f"the {name} model {model} did not answer within {timeout:.0f} s - try again, or pick a faster "
                "model for Taste extraction in Settings > LLM settings")
    return f"the {name} model {model} failed: {str(exc)[:300] or type(exc).__name__}"


async def extract(db, kind: str, ref: str, track: Tracker | None = None) -> dict:
    """Proposals for one project, or a folder of them: {project, proposals,
    provider, model, usage}. Nothing is saved. Each step is told to `track`
    as it happens."""
    track = track or Tracker()
    whole = kind == "folder"
    await track.phase("reading")
    try:
        if whole:
            material, label = await gather_folder(db, ref, track)
        else:
            sid = f"read:{kind}:{ref}"
            await track.step(sid, kind="read", project={"kind": kind, "id": ref, "label": ref}, budget=SOURCE_CHARS)
            try:
                got = await read_project(db, kind, ref)
            except KeyError:
                await track.step(sid, state="failed", reason="not in this workspace")
                raise
            material, label = got["text"], got["label"]
            track.add(projects=1, budget=SOURCE_CHARS)
            await track.step(sid, state="done", project={"kind": kind, "id": ref, "label": label},
                             chars=len(material), clipped=got["clipped"], revisions=got["revisions"],
                             notes=got["notes"], **({"files": got["files"]} if "files" in got else {}))
    except KeyError as exc:
        raise LookupError(f"{kind} {ref} is not in this workspace") from exc
    source = {"kind": kind, "id": ref, "label": label}
    nread = sum(1 for s in track.steps if s.get("kind") == "read" and s["state"] == "done")
    track.add(chars=len(material), read=nread)
    # Several products in a folder: what holds across them is counted.
    nproducts = len({product_in(ref, s["project"]["id"]) if s["project"].get("kind") == "model" else ref
                     for s in track.steps if s.get("kind") == "read" and s["state"] == "done"}) if whole else 1
    # What it looks like: a model or a folder is photographed and measured.
    seen: dict = {"images": [], "references": [], "measures": "", "notices": []}
    if kind in ("model", "folder"):
        await track.phase("looking")
        seen = await look(db, kind, ref, track)
    if seen["images"]:
        prov, model, vision = await vision_route()
    else:
        (prov, model), vision = llm.route(JOB), False
    notices = list(seen["notices"])
    pics = seen["images"] if vision else []
    if seen["images"] and not vision:
        notices.append("no configured model reads images, so the renders were not read - choose one that does "
                       "for Taste extraction in Settings > LLM settings and run it again")
    elif pics and (prov, model) != llm.route(JOB):
        notices.append(f"the renders were read by {model}: the Taste extraction model does not read images")
    if kind in ("model", "folder") and not pics:
        notices.insert(0, "extracted from text" + (" and measurements" if seen["measures"] else "") + " only")
    system = (EXTRACT_PROMPT + (FOLDER_PROMPT if whole else "")
              + (LOOK_PROMPT if pics else TEXT_ONLY_PROMPT if kind in ("model", "folder") else ""))
    head = f"Project: {kind} \"{label}\""
    if seen["measures"]:
        head += ("\n\nMeasured from the STEP of each of its own parts (mm; \"x5\" is how many times):\n"
                 + seen["measures"])
    text = f"{head}\n\n{material}"
    user: str | list = text
    if pics:
        user = [{"type": "text", "text": text}]
        for what, png in pics:
            user += [{"type": "text", "text": f"Render: {what}"},
                     {"type": "image_url", "image_url": {"url": await asyncio.to_thread(_for_model, png)}}]
    prompt_chars = len(system) + len(text)
    timeout = FOLDER_TIMEOUT if whole else EXTRACT_TIMEOUT
    track.add(prompt_chars=prompt_chars, tokens_in_est=prompt_chars // CHARS_PER_TOKEN, images=len(pics))
    await track.phase("asking", provider=prov, model=model,
                      provider_name=llm.PROVIDERS.get(prov, {}).get("name", prov))
    await track.step("ask", kind="ask", provider=prov, model=model,
                     provider_name=llm.PROVIDERS.get(prov, {}).get("name", prov), prompt_chars=prompt_chars,
                     tokens_est=prompt_chars // CHARS_PER_TOKEN, max_tokens=FOLDER_TOKENS if whole else EXTRACT_TOKENS,
                     timeout=timeout, sent_at=_now(), images=len(pics))
    if not llm.key(prov):
        why = llm.no_key(prov, JOB)
        await track.step("ask", state="failed", reason=why)
        raise ExtractError(why)
    try:
        d = await llm.complete([{"role": "system", "content": system}, {"role": "user", "content": user}],
                               job=JOB, provider=prov, model=model, max_tokens=FOLDER_TOKENS if whole else EXTRACT_TOKENS,
                               temperature=0.2, timeout=timeout)
    except asyncio.CancelledError:
        raise
    except Exception as exc:                           # noqa: BLE001 - said to the person, plainly
        why = _failed(prov, model, exc, timeout)
        await track.step("ask", state="failed", reason=why)
        raise ExtractError(why) from exc
    prov, model = d.get("provider") or prov, d.get("model") or model
    used = d.get("usage") or {}
    await llm.record(db, provider=prov, model=model, surface="taste", kind="taste", used=used)
    cost = used.get("cost")
    if cost is None and prov == "claude":
        cost = llm.claude_cost(model, used)
    track.add(tokens_in=used.get("prompt_tokens"), tokens_out=used.get("completion_tokens"), cost=cost)
    content = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    await track.step("ask", state="done", provider=prov, model=model, tokens_in=used.get("prompt_tokens"),
                     tokens_out=used.get("completion_tokens"), cost=cost)
    await track.phase("parsing", provider=prov, model=model)
    await track.step("parse", kind="parse", raw_chars=len(content))
    stats: dict = {}
    try:
        got = parse_proposals(content, source, FOLDER_PROPOSALS[1] if whole else PROPOSALS[1], stats,
                              projects=nproducts if whole else None)
    except ValueError as exc:
        why = f"{exc} - try again, or pick another model for Taste extraction in Settings > LLM settings"
        await track.step("parse", state="failed", reason=why)
        raise ExtractError(why) from exc
    await track.step("parse", state="done" if got else "failed", parsed=len(got), **stats,
                     **({} if got else {"reason": "the model proposed nothing"}))
    if not got:
        raise ExtractError("the model proposed nothing for this project")
    track.add(proposals=len(got))
    notice = "; ".join(notices)
    return {"project": source, "proposals": got, "provider": prov, "model": model, "usage": used,
            "references": seen["references"], "measures": seen["measures"], "vision": bool(pics),
            "notice": (notice[:1].upper() + notice[1:] + ".") if notice else "",
            "product": await product_of(db, kind, ref)}


# ---- extraction as a job -----------------------------------------------------
#
# A folder run reads every project in it and waits minutes for the model:
# too long for one request. So POST /extract writes a job down
# (`taste_jobs`, per workspace) and answers at once; the work runs as an
# asyncio task of this API process and writes each step as it goes, so a
# page that is reloaded (or opened later) finds the run where it is, and
# its proposals once it is done - kept until they are saved or the run is
# deleted.
#
# uvicorn --reload restarts this process on every save of a backend file,
# and the task dies with it. A run still marked reading/asking whose task is
# not in this process - its process gone, or not heard from for JOB_LOST
# seconds - is settled as failed with GONE the next time it is read.

JOBS = "taste_jobs"
ACTIVE = ("queued", "reading", "looking", "asking", "parsing")
STATUSES = (*ACTIVE, "done", "failed", "cancelled")
JOB_BEAT = 5.0                  # a running job says it is alive this often, s
JOB_LOST = 45.0                 # one not heard from for this long has died
KEEP_JOBS = 40                  # finished runs kept per workspace, newest first
GONE = "the extraction was interrupted (the server restarted) - run it again"
CANCELLED = "cancelled"
WORKER = {"host": socket.gethostname(), "pid": os.getpid(), "boot": secrets.token_hex(6)}
_TASKS: dict[str, asyncio.Task] = {}
_CANCEL: set[str] = set()
log = logging.getLogger("redline.taste")


class JobTracker(Tracker):
    """A job's tracker: every change written on the job, as long as the job
    is still running - a cancel or a settle from outside stops the work."""

    def __init__(self, db, jid: str):
        super().__init__()
        self.db, self.jid = db, jid

    def fields(self) -> dict:
        return {"status": self.status, "steps": self.steps, "totals": self.totals, **self.meta}

    async def flush(self) -> None:
        res = await self.db[JOBS].update_one({"_id": self.jid, "status": {"$in": list(ACTIVE)}},
                                             {"$set": {**self.fields(), "beat": _now()}})
        if not getattr(res, "matched_count", 1):
            raise Stopped(self.jid)


def _seconds(a: str | None, b: str | None = None) -> float | None:
    try:
        t0 = datetime.fromisoformat(a) if a else None
        t1 = datetime.fromisoformat(b) if b else datetime.now(timezone.utc)
    except ValueError:
        return None
    return round((t1 - t0).total_seconds(), 1) if t0 else None


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except (PermissionError, TypeError, ValueError, OSError):
        return True
    return True


def orphaned(job: dict, at: str | None = None) -> bool:
    """A running job whose task is not running anywhere any more."""
    t = _TASKS.get(job["_id"])
    if job.get("status") not in ACTIVE or (t and not t.done()):
        return False
    w = job.get("worker") or {}
    if w.get("boot") == WORKER["boot"]:
        return True                                     # this process, and no task: it ended unwritten
    if w.get("host") == WORKER["host"] and w.get("pid") and not _pid_alive(w["pid"]):
        return True                                     # its process is gone (a reload, a restart)
    quiet = _seconds(job.get("beat") or job.get("started_at"), at)
    return quiet is None or quiet > JOB_LOST


async def _end(db, jid: str, status: str, sets: dict) -> bool:
    """A running job finished as `status`; False when it had already
    ended (cancelled or settled meanwhile) - then nothing is written."""
    now = _now()
    doc = await db[JOBS].find_one({"_id": jid})
    if not doc or doc.get("status") not in ACTIVE:
        return False
    sets = {"status": status, "finished_at": now, "seconds": _seconds(doc.get("started_at"), now), **sets}
    res = await db[JOBS].update_one({"_id": jid, "status": {"$in": list(ACTIVE)}}, {"$set": sets})
    return bool(getattr(res, "matched_count", 1))


def _closed(steps: list[dict], state: str, reason: str | None) -> list[dict]:
    now = _now()
    out = []
    for s in steps or []:
        if s.get("state") == "running":
            s = {**s, "state": state, "finished_at": now, "seconds": _seconds(s.get("started_at"), now)}
            if reason:
                s["reason"] = reason
        out.append(s)
    return out


async def settle(db, job: dict | None) -> dict | None:
    """The job as it is: one left running by a process that is gone is
    failed now, with GONE."""
    if job and orphaned(job):
        await _end(db, job["_id"], "failed", {"error": GONE, "steps": _closed(job.get("steps"), "failed", GONE)})
        job = await db[JOBS].find_one({"_id": job["_id"]})
    return job


async def _work(db, jid: str, kind: str, ref: str) -> None:
    track = JobTracker(db, jid)

    async def beat():
        while True:
            await asyncio.sleep(JOB_BEAT)
            try:
                await db[JOBS].update_one({"_id": jid, "status": {"$in": list(ACTIVE)}}, {"$set": {"beat": _now()}})
            except Exception:                           # noqa: BLE001 - the next one will do
                pass

    beating = asyncio.create_task(beat())
    try:
        got = await extract(db, kind, ref, track)
        await track.step("done", kind="done", state="done", proposals=len(got["proposals"]))
        await _end(db, jid, "done", {**track.fields(), "status": "done", "proposals": got["proposals"],
                                     "provider": got["provider"], "model": got["model"],
                                     "references": got["references"], "measures": got["measures"],
                                     "notice": got["notice"], "vision": got["vision"], "product": got["product"]})
    except Stopped:
        pass                                            # ended from outside; that is what it says
    except asyncio.CancelledError:
        cancelled = jid in _CANCEL
        why = None if cancelled else GONE
        track.close_running("cancelled" if cancelled else "failed", why)
        try:
            await asyncio.shield(_end(db, jid, "cancelled" if cancelled else "failed",
                                      {"steps": track.steps, "totals": track.totals, "error": why}))
        except BaseException:                           # noqa: BLE001 - the process is going; read settles it
            pass
        raise
    except (LookupError, ExtractError) as exc:
        why = str(exc).strip("'\"")
        track.close_running("failed", why)
        await _end(db, jid, "failed", {**track.fields(), "status": "failed", "error": why})
    except Exception as exc:                            # noqa: BLE001 - said to the person, plainly
        log.exception("taste extraction %s failed", jid)
        why = f"the extraction stopped: {str(exc)[:300] or type(exc).__name__}"
        track.close_running("failed", why)
        await _end(db, jid, "failed", {**track.fields(), "status": "failed", "error": why})
    finally:
        beating.cancel()
        _TASKS.pop(jid, None)
        _CANCEL.discard(jid)


async def _label(db, kind: str, ref: str) -> str:
    """The project's name, or LookupError when it is not in the workspace."""
    if kind == "folder":
        if not await folder_projects(db, ref):
            raise LookupError(f"folder {ref} is not in this workspace")
        return ref
    label = await project_label(db, kind, ref)
    if label is None:
        raise LookupError(f"{kind} {ref} is not in this workspace")
    return label


async def jobs(db, limit: int = 20) -> list[dict]:
    """The workspace's runs, newest first, each settled."""
    rows = [d async for d in db[JOBS].find({})]
    rows.sort(key=lambda d: d.get("started_at") or "", reverse=True)
    return [await settle(db, d) for d in rows[:limit]]


async def job(db, jid: str) -> dict | None:
    return await settle(db, await db[JOBS].find_one({"_id": jid}))


async def _prune(db) -> None:
    rows = [d async for d in db[JOBS].find({}, {"status": 1, "started_at": 1})]
    done = sorted((d for d in rows if d.get("status") not in ACTIVE),
                  key=lambda d: d.get("started_at") or "", reverse=True)
    for d in done[KEEP_JOBS:]:
        full = await db[JOBS].find_one({"_id": d["_id"]}, {"references": 1}) or {}
        await db[JOBS].delete_one({"_id": d["_id"]})
        await _drop_shots(db, [r.get("gridfs_id") for r in full.get("references") or []])


async def start_job(db, kind: str, ref: str, by: dict | None = None) -> tuple[dict, bool]:
    """Start a run (the work goes on in the background): (job, started).
    The same project already running is that run, not a second one."""
    label = await _label(db, kind, ref)
    for d in await jobs(db, KEEP_JOBS + 10):
        if d and d.get("status") in ACTIVE and (d.get("project") or {}).get("id") == ref \
                and (d.get("project") or {}).get("kind") == kind:
            return d, False
    prov, model = llm.route(JOB)
    now = _now()
    doc = {"_id": secrets.token_hex(6), "status": "queued", "project": {"kind": kind, "id": ref, "label": label},
           "by": by or actors.current(), "started_at": now, "finished_at": None, "beat": now, "worker": WORKER,
           "provider": prov, "model": model, "provider_name": llm.PROVIDERS.get(prov, {}).get("name", prov),
           "steps": [], "totals": {}, "proposals": [], "error": None, "saved_to": None}
    await db[JOBS].insert_one(doc)
    _TASKS[doc["_id"]] = asyncio.create_task(_work(db, doc["_id"], kind, ref))
    try:
        await _prune(db)
    except Exception:                                   # noqa: BLE001 - old runs stay a little longer
        pass
    return doc, True


async def cancel_job(db, jid: str, who: dict | None = None) -> dict | None:
    """Stop a running job: it ends as cancelled, whatever its task does after."""
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


def refs_out(refs: list[dict] | None, base: str) -> list[dict]:
    """Reference renders as the page reads them: where to fetch each, not
    where it is stored."""
    return [{k: v for k, v in r.items() if k != "gridfs_id"} | {"url": f"{base}/refs/{r['id']}"}
            for r in refs or [] if isinstance(r, dict) and r.get("id")]


def job_out(d: dict, full: bool = True) -> dict:
    """A run as the page reads it: `now` is the server's clock, for the page
    to time a running step against; the proposals only when `full`."""
    keep = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "proposals", "worker", "beat")}
    keep["references"] = refs_out(d.get("references"), f"/api/taste/jobs/{d['_id']}")
    out = {**keep, "id": d["_id"], "count": len(d.get("proposals") or []), "now": _now(),
           "seconds": d.get("seconds") if d.get("finished_at") else _seconds(d.get("started_at"))}
    if full:
        out["proposals"] = d.get("proposals") or []
    return out


# ---- the API -----------------------------------------------------------------

def out(d: dict) -> dict:
    items = [item_out(i) for i in d.get("items") or []]
    srcs = sources(d)
    attached = [{**a, "specifics_default": any(same_line(a.get("product") or str(a.get("id") or "").split("/", 1)[0],
                                                         s["product"]) for s in srcs)}
                for a in d.get("attached") or []]
    return {**{k: v for k, v in d.items() if k not in ("_id", "workspace_id")}, "id": d["_id"],
            "items": items, "attached": attached, "counts": counts(items),
            "priority": d.get("priority") or PRIORITY, "priority_default": not d.get("priority"),
            "sources": srcs, "references": refs_out(d.get("references"), f"/api/taste/{d['_id']}")}


async def adopt(db, pid: str, job: dict) -> dict | None:
    """What a run saw goes with the palette its proposals were saved into:
    its renders (the palette's reference renders, newest kept), the
    measurements, what could not be done, and the project it read."""
    doc = await get(db, pid)
    if not doc:
        return None
    have = list(doc.get("references") or [])
    ids = {r.get("gridfs_id") for r in have}
    new = [r for r in job.get("references") or [] if r.get("gridfs_id") not in ids]
    refs = (have + new)[-MAX_REFS:]
    origin = {**(job.get("project") or {}), "product": job.get("product") or str((job.get("project") or {}).get("id")
                                                                                 or "").split("/", 1)[0]}
    origins = [o for o in doc.get("origins") or [] if (o.get("kind"), o.get("id")) != (origin.get("kind"), origin.get("id"))]
    sets = {"references": refs, "origins": [*origins, origin] if origin.get("id") else origins}
    if job.get("measures"):
        sets["measures"] = job["measures"]
    if job.get("status") == "done":
        sets["notice"] = job.get("notice") or None
    saved = await _save(db, pid, sets)
    await _drop_shots(db, [r["gridfs_id"] for r in have if r not in refs])
    return saved


async def _drop_shots(db, gids: list) -> None:
    """Stored renders nobody points at any more - no palette, no run - deleted."""
    from . import store
    gids = [g for g in gids if g is not None]
    if not gids:
        return
    kept = set()
    for coll in (COLL, JOBS):
        async for d in db[coll].find({}, {"references": 1}):
            kept.update(r.get("gridfs_id") for r in d.get("references") or [] if isinstance(r, dict))
    for gid in gids:
        if gid in kept:
            continue
        try:
            await store.bucket(db, "shots").delete(gid)
        except Exception:                               # noqa: BLE001 - gone already
            pass


async def ref_png(db, doc: dict | None, rid: str) -> bytes | None:
    from . import store
    r = next((r for r in (doc or {}).get("references") or [] if r.get("id") == rid), None)
    if not r:
        return None
    try:
        return await store.get_shot(db, r["gridfs_id"])
    except Exception:                                   # noqa: BLE001 - the file is gone
        return None


class ItemIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    domain: str = "general"
    strength: str = "prefer"
    why: str = Field(default="", max_length=MAX_WHY)
    applies_to: str = Field(default="all", max_length=MAX_SCOPE)
    exception: str = Field(default="", max_length=MAX_EXCEPTION)
    example: str = Field(default="", max_length=MAX_EXAMPLE)
    layer: str = "language"
    seen: dict | None = None
    source: dict | str | None = None


class ItemPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=MAX_TEXT)
    domain: str | None = None
    strength: str | None = None
    why: str | None = Field(default=None, max_length=MAX_WHY)
    applies_to: str | None = Field(default=None, max_length=MAX_SCOPE)
    exception: str | None = Field(default=None, max_length=MAX_EXCEPTION)
    example: str | None = Field(default=None, max_length=MAX_EXAMPLE)
    layer: str | None = None


class PaletteIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    items: list[ItemIn] = Field(default_factory=list, max_length=MAX_ITEMS)


class PalettePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    pinned: bool | None = None
    priority: str | None = Field(default=None, max_length=MAX_PRIORITY)


class ItemsIn(BaseModel):
    items: list[ItemIn] = Field(min_length=1, max_length=MAX_ITEMS)
    at: int | None = None


class OrderIn(BaseModel):
    ids: list[str] = Field(max_length=MAX_ITEMS)


class Target(BaseModel):
    kind: str = Field(pattern="^(model|board|firmware)$")
    id: str = Field(min_length=1, max_length=200)
    specifics: bool | None = None               # project-specific items for it: on, off, or by its product line


class AttachIn(BaseModel):
    attached: list[Target] = Field(default_factory=list, max_length=50)


class ExtractIn(BaseModel):
    kind: str = Field(pattern="^(model|board|firmware|folder)$")
    id: str = Field(min_length=1, max_length=200)


class SavedTo(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=120)
    count: int = Field(default=0, ge=0, le=MAX_ITEMS)


class JobPatch(BaseModel):
    saved_to: SavedTo


def _404(pid: str):
    raise HTTPException(404, f"no palette {pid}")


@router.get("")
async def api_list(q: str = ""):
    return [out(d) for d in await listing(_db(), q[:200])]


@router.get("/projects")
async def api_projects(q: str = "", folders: bool = False):
    return await projects(_db(), q[:200], folders=folders)


@router.get("/attached")
async def api_attached(kind: str, id: str):
    """The palettes attached to one project, and the text its agent reads."""
    if kind not in PROJECT_KINDS:
        raise HTTPException(400, "kind is model, board or firmware")
    rows = await attached_to(_db(), kind, id)
    return {"palettes": [out(d) for d in rows],
            "text": agent_text(rows, product=await product_of(_db(), kind, id), overrides=overrides_for(rows, kind, id))}


@router.post("/extract")
async def api_extract(body: ExtractIn):
    """Start an extraction; it runs on in the background (GET /jobs/{id})."""
    try:
        doc, started = await start_job(_db(), body.kind, body.id, actors.current())
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {**job_out(doc), "job_id": doc["_id"], "started": started}


@router.get("/jobs")
async def api_jobs(limit: int = 20):
    return [job_out(d, full=False) for d in await jobs(_db(), max(1, min(limit, KEEP_JOBS)))]


def _no_job(jid: str):
    raise HTTPException(404, f"no extraction {jid}")


@router.get("/jobs/{jid}")
async def api_job(jid: str):
    d = await job(_db(), jid)
    if not d:
        _no_job(jid)
    return job_out(d)


def _png(data: bytes):
    from fastapi.responses import Response
    return Response(data, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@router.get("/jobs/{jid}/refs/{rid}")
async def api_job_ref(jid: str, rid: str):
    data = await ref_png(_db(), await _db()[JOBS].find_one({"_id": jid}, {"references": 1}), rid)
    if data is None:
        raise HTTPException(404, f"no render {rid} on extraction {jid}")
    return _png(data)


@router.post("/jobs/{jid}/cancel")
async def api_cancel(jid: str):
    d = await cancel_job(_db(), jid, actors.current())
    if not d:
        _no_job(jid)
    return job_out(d)


@router.patch("/jobs/{jid}")
async def api_job_patch(jid: str, body: JobPatch):
    """Which palette its proposals were saved to."""
    d = await job(_db(), jid)
    if not d:
        _no_job(jid)
    saved = {"id": body.saved_to.id, "name": body.saved_to.name, "count": body.saved_to.count, "at": _now()}
    await _db()[JOBS].update_one({"_id": jid}, {"$set": {"saved_to": saved}})
    await adopt(_db(), body.saved_to.id, d)
    return job_out(await _db()[JOBS].find_one({"_id": jid}))


@router.delete("/jobs/{jid}")
async def api_job_delete(jid: str):
    d = await job(_db(), jid)
    if not d:
        _no_job(jid)
    if d.get("status") in ACTIVE:
        raise HTTPException(409, "the extraction is still running - cancel it first")
    if (d.get("by") or {}).get("id") != actors.current().get("id") and not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await _db()[JOBS].delete_one({"_id": jid})
    await _drop_shots(_db(), [r.get("gridfs_id") for r in d.get("references") or []])
    return {"deleted": jid}


# ---- sharing: a palette as a file ----------------------------------------------

FORMAT = "redline-taste"


ITEM_KEYS = ("text", "domain", "strength", "why", "applies_to", "exception", "example", "layer", "seen", "source")


async def export_doc(db, doc: dict) -> dict:
    """A palette as a file another person can import: its statements and
    where they came from, its priority rule, and its reference renders
    (the pictures themselves, base64 PNG) with the measurements; not its
    attachments (those are this workspace's projects) nor anything about
    the account but the author's name."""
    import base64
    from . import store
    refs = []
    for r in doc.get("references") or []:
        try:
            png = await store.get_shot(db, r["gridfs_id"])
        except Exception:                               # noqa: BLE001 - a lost picture is left out
            continue
        refs.append({k: r[k] for k in ("view", "model", "label", "size") if r.get(k) is not None}
                    | {"png": base64.b64encode(png).decode()})
    return {"format": FORMAT, "version": 2, "name": doc.get("name") or "", "description": doc.get("description") or "",
            "by": ((doc.get("by") or {}).get("name") or ""), "exported_at": _now(),
            **({"priority": doc["priority"]} if doc.get("priority") else {}),
            **({"measures": doc["measures"]} if doc.get("measures") else {}),
            **({"notice": doc["notice"]} if doc.get("notice") else {}),
            "origins": [{k: o.get(k) for k in ("kind", "id", "label", "product")} for o in doc.get("origins") or []],
            "references": refs,
            "items": [{k: i[k] for k in ITEM_KEYS if i.get(k) not in (None, "")}
                      for i in (item_out(x) for x in doc.get("items") or [])]}


def _clean_png(data: str) -> bytes:
    """A picture from a file: base64 PNG, read and written again by Pillow so
    nothing but a picture is kept."""
    import base64
    import binascii
    import io
    from PIL import Image
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise ValueError("a reference render is not base64") from exc
    if len(raw) > REF_BYTES:
        raise ValueError("a reference render is too large")
    try:
        im = Image.open(io.BytesIO(raw))
        if im.width * im.height > 4096 * 4096:
            raise ValueError("a reference render is too large")
        im = im.convert("RGB")
    except ValueError:
        raise
    except Exception as exc:                            # noqa: BLE001 - not a picture
        raise ValueError("a reference render is not a picture") from exc
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


async def import_doc(db, data: dict, by: dict) -> dict:
    """A palette file made into a new palette here. Its items are checked one
    by one like any other, its renders as pictures; a name already taken
    gets "(imported)". A file from before scopes, layers and renders (version
    1) reads as it always did."""
    from . import store
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("this is not a Workbench taste palette file")
    if int(data.get("version") or 0) > 2:
        raise ValueError("this palette file is from a newer Workbench")
    items = data.get("items")
    if not isinstance(items, list):
        raise ValueError("the file has no items")
    pics = []
    for r in (data.get("references") or [])[:MAX_REFS]:
        if isinstance(r, dict) and r.get("png"):
            pics.append((r, _clean_png(str(r["png"]))))
    name = str(data.get("name") or "Imported palette").strip()[:100] or "Imported palette"
    taken = {(d.get("name") or "").lower() for d in await listing(db)}
    if name.lower() in taken:
        name = f"{name} (imported)"
    doc = await create(db, name, str(data.get("description") or ""), [x for x in items if isinstance(x, dict)], by)
    if not doc["items"]:
        await db[COLL].delete_one({"_id": doc["_id"]})
        raise ValueError("none of the file's items could be read")
    refs = []
    for r, png in pics:
        shot = await store.put_shot(db, png)
        refs.append({"id": secrets.token_hex(4), "view": _line(r.get("view"), 40) or "view",
                     "model": _line(r.get("model"), 200), "label": _line(r.get("label"), 200),
                     "gridfs_id": shot["gridfs_id"], "bytes": len(png),
                     "size": r.get("size") if isinstance(r.get("size"), list) else None, "at": _now()})
    origins = [{k: _line(o.get(k), 200) for k in ("kind", "id", "label", "product")}
               for o in data.get("origins") or [] if isinstance(o, dict) and o.get("id")][:20]
    src = {"by": str(data.get("by") or "")[:120], "at": _now(), "count": len(doc["items"])}
    sets = {"imported": src, "references": refs, "origins": origins,
            **({"priority": _line(data["priority"], MAX_PRIORITY)} if data.get("priority") else {}),
            **({"measures": str(data["measures"])[:8000]} if data.get("measures") else {}),
            **({"notice": _line(data["notice"], 600)} if data.get("notice") else {})}
    await db[COLL].update_one({"_id": doc["_id"]}, {"$set": sets})
    doc.update(sets)
    return doc


@router.get("/{pid}/export")
async def api_export(pid: str):
    doc = await get(_db(), pid)
    if not doc:
        _404(pid)
    return await export_doc(_db(), doc)


@router.post("/import")
async def api_import(body: dict):
    try:
        doc = await import_doc(_db(), body, actors.current())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return out(doc)


@router.post("")
async def api_create(body: PaletteIn):
    doc = await create(_db(), body.name, body.description, [i.model_dump() for i in body.items], actors.current())
    return out(doc)


@router.get("/{pid}/refs/{rid}")
async def api_ref(pid: str, rid: str):
    data = await ref_png(_db(), await get(_db(), pid), rid)
    if data is None:
        raise HTTPException(404, f"no render {rid} in palette {pid}")
    return _png(data)


@router.get("/{pid}")
async def api_get(pid: str):
    doc = await get(_db(), pid)
    if not doc:
        _404(pid)
    return out(doc)


@router.patch("/{pid}")
async def api_patch(pid: str, body: PalettePatch):
    doc = await patch(_db(), pid, body.name, body.description, body.pinned, body.priority)
    if not doc:
        _404(pid)
    return out(doc)


@router.delete("/{pid}")
async def api_delete(pid: str):
    doc = await get(_db(), pid)
    if not doc:
        _404(pid)
    # Your own, always; someone else's, only if you may delete - as notes.
    if (doc.get("by") or {}).get("id") != actors.current().get("id") and not access.allowed(access.current(), "delete"):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    await remove(_db(), pid)
    await _drop_shots(_db(), [r.get("gridfs_id") for r in doc.get("references") or []])
    return {"deleted": pid}


@router.post("/{pid}/items")
async def api_add(pid: str, body: ItemsIn):
    try:
        doc = await add_items(_db(), pid, [i.model_dump() for i in body.items], body.at)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        _404(pid)
    return out(doc)


@router.patch("/{pid}/items/{iid}")
async def api_edit(pid: str, iid: str, body: ItemPatch):
    try:
        doc = await edit_item(_db(), pid, iid, body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not doc:
        raise HTTPException(404, f"no item {iid} in palette {pid}")
    return out(doc)


@router.delete("/{pid}/items/{iid}")
async def api_remove_item(pid: str, iid: str):
    doc = await remove_item(_db(), pid, iid)
    if not doc:
        raise HTTPException(404, f"no item {iid} in palette {pid}")
    return out(doc)


@router.put("/{pid}/order")
async def api_order(pid: str, body: OrderIn):
    doc = await reorder(_db(), pid, body.ids)
    if not doc:
        _404(pid)
    return out(doc)


@router.put("/{pid}/attached")
async def api_attach(pid: str, body: AttachIn):
    if not await get(_db(), pid):
        _404(pid)
    try:
        doc = await attach(_db(), pid, [t.model_dump(exclude_none=True) for t in body.attached])
    except KeyError as exc:
        raise HTTPException(404, f"{exc.args[0]} is not in this workspace") from exc
    return out(doc)
