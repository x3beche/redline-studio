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
notes - and asks the "taste" job's model (Settings > LLM settings) for
proposals. Nothing is kept from it until the person has looked at each one
and saved the ones they want (a separate call).

Palettes belong to the workspace (backend/scope.py) and say who made them.
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors, llm

router = APIRouter(prefix="/api/taste")

COLL = "taste_palettes"
JOB = "taste"
DOMAINS = ("mechanical", "pcb", "firmware", "general")
STRENGTHS = ("must", "prefer", "avoid")
PROJECT_KINDS = ("model", "board", "firmware")
MAX_ITEMS = 300                 # in one palette
MAX_TEXT = 400                  # one statement
MAX_WHY = 400
BLOCK_CHARS = 8_000             # one palette, as an agent reads it
PROPOSALS = (5, 20)             # what extraction asks for
SOURCE_CHARS = 40_000           # what extraction reads of a project
EXTRACT_TOKENS = 3_000
EXTRACT_TIMEOUT = 120.0

DOMAIN_NAMES = {"mechanical": "Mechanical", "pcb": "PCB", "firmware": "Firmware", "general": "General"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db():
    from .main import db
    return db()


# ---- items -------------------------------------------------------------------

def clean_item(raw: dict, source: dict | None = None) -> dict | None:
    """One statement made whole, or None when there is no statement in it."""
    text = re.sub(r"\s+", " ", str(raw.get("text") or "")).strip()[:MAX_TEXT]
    if not text:
        return None
    domain = str(raw.get("domain") or "").strip().lower()
    strength = str(raw.get("strength") or "").strip().lower()
    why = re.sub(r"\s+", " ", str(raw.get("why") or "")).strip()[:MAX_WHY]
    src = raw.get("source") if source is None else source
    if isinstance(src, dict) and src.get("kind") in PROJECT_KINDS and src.get("id"):
        src = {"kind": src["kind"], "id": str(src["id"])[:200], "label": str(src.get("label") or src["id"])[:200]}
    else:
        src = "manual"
    return {"id": str(raw.get("id") or "") or secrets.token_hex(4), "text": text,
            "domain": domain if domain in DOMAINS else "general",
            "strength": strength if strength in STRENGTHS else "prefer",
            **({"why": why} if why else {}), "source": src}


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
                pinned: bool | None = None) -> dict | None:
    sets: dict = {}
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
    them gets it. Checked against the workspace - only what is there."""
    out, seen = [], set()
    for t in targets:
        kind, ref = t.get("kind"), str(t.get("id") or "")
        if kind not in PROJECT_KINDS or not ref or (kind, ref) in seen:
            continue
        label = await project_label(db, kind, ref)
        if label is None:
            raise KeyError(f"{kind} {ref}")
        seen.add((kind, ref))
        out.append({"kind": kind, "id": ref, "label": label})
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


async def projects(db, q: str = "", limit: int = 60) -> list[dict]:
    """Models, boards and firmware of the workspace, for the pickers."""
    words = [w for w in q.lower().split() if w]
    out: list[dict] = []
    subs = {"model": lambda d: d["_id"] + ".3d",
            "board": lambda d: d["_id"] + ".pcb" + (f" · {d['folder']}" if d.get("folder") else ""),
            "firmware": lambda d: "firmware · " + str(d.get("board") or "")}
    for kind, coll in _PROJECT_COLL.items():
        async for d in db[coll].find({}, {"title": 1, "name": 1, "folder": 1, "board": 1}):
            label = d.get("title") or d.get("name") or d["_id"]
            row = {"kind": kind, "id": d["_id"], "label": label, "sub": subs[kind](d)}
            if all(w in f"{label} {d['_id']} {row['sub']}".lower() for w in words):
                out.append(row)
    out.sort(key=lambda r: (PROJECT_KINDS.index(r["kind"]), str(r["label"]).lower()))
    return out[:limit]


async def attached_to(db, kind: str, ref: str) -> list[dict]:
    """The palettes attached to one project."""
    return [d for d in await listing(db)
            if any(a.get("kind") == kind and a.get("id") == ref for a in d.get("attached") or [])]


# ---- what an agent reads -----------------------------------------------------

def block(doc: dict, limit: int = BLOCK_CHARS) -> str:
    """A palette as an agent reads it: grouped by domain, MUST first, then
    PREFER, then AVOID, each with its why; clipped to `limit`."""
    items = doc.get("items") or []
    head = f"Design taste to follow (palette \"{doc.get('name') or doc['_id']}\")"
    if doc.get("description"):
        head += f" - {doc['description']}"
    lines = [head + ":"]
    if not items:
        lines.append("(no items yet)")
    shown = 0
    for dom in DOMAINS:
        mine = [i for i in items if (i.get("domain") or "general") == dom]
        if not mine:
            continue
        lines.append(f"{DOMAIN_NAMES[dom]}:")
        for st in STRENGTHS:
            for i in (x for x in mine if (x.get("strength") or "prefer") == st):
                lines.append(f"- {st.upper()}: {i['text']}" + (f" (why: {i['why']})" if i.get("why") else ""))
                shown += 1
    text = "\n".join(lines)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit("\n", 1)[0]
    left = len(items) - cut.count("\n- ")
    return cut + f"\n[... {left} more items of this palette left out]"


def agent_text(palettes: list[dict], limit: int = BLOCK_CHARS * 3) -> str:
    """Several palettes, for a room's agent: each block, then a line on
    how to use them."""
    if not palettes:
        return ""
    each = max(1500, limit // len(palettes))
    body = "\n\n".join(block(p, each) for p in palettes)
    return (body + "\n\nFollow MUST items; follow PREFER items unless the note says otherwise; "
            "never do AVOID items. If the note asks for something a palette forbids, ask before doing it.")


# ---- extraction --------------------------------------------------------------

EXTRACT_PROMPT = (
    "You read a finished hardware project from Redline Studio (a 3D CAD model in build123d, a circuit "
    "board in atopile/KiCad, or ESP32 firmware) and distil its design taste: the decisions that make it "
    "good and that a designer would want repeated in the next project.\n\n"
    f"Write between {PROPOSALS[0]} and {PROPOSALS[1]} statements. Each one must be:\n"
    "- concrete and checkable: numbers, parts, placements, rules (\"Walls 2 mm, outside edges filleted "
    "1 mm\", \"Decoupling caps within 2 mm of the pin\", \"Every task feeds the watchdog\");\n"
    "- general enough to reuse in another project - no project names, no ids, no reference designators;\n"
    "- seen in the material: do not invent what the project does not show.\n"
    "Where the person corrected the design (drawn notes, notes), the correction is strong taste.\n\n"
    "Reply with JSON only - no prose, no Markdown fence: an array of objects "
    "{\"text\": the statement, \"domain\": \"mechanical\"|\"pcb\"|\"firmware\"|\"general\", "
    "\"strength\": \"must\"|\"prefer\"|\"avoid\", \"why\": one short reason}. "
    "Write \"avoid\" items as what not to do (\"Vias in pads\"), not with \"never\" in front. "
    "Write in the language the person's notes are written in; English if there are none."
)


def parse_proposals(raw: str, source: dict) -> list[dict]:
    """The model's answer as items: the JSON array (fenced or bare, or under
    an "items" key), each made whole, duplicates dropped, at most 20."""
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
    for row in data:
        if isinstance(row, str):
            row = {"text": row}
        if not isinstance(row, dict):
            continue
        it = clean_item({**row, "id": None}, source)
        key = (it or {}).get("text", "").lower()
        if it and key not in seen:
            seen.add(key)
            out.append(it)
        if len(out) >= PROPOSALS[1]:
            break
    return out


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + f"\n[... {len(s) - n:,} more characters left out]"


async def gather(db, kind: str, ref: str) -> tuple[str, str]:
    """What is known about a project, as text for the model, and its name."""
    from . import cc_context
    parts: list[str] = []
    label = await project_label(db, kind, ref)
    if label is None:
        raise KeyError(f"{kind} {ref}")
    if kind == "model":
        got = await cc_context._model(db, ref)
        parts.append(_clip(got["text"] if got else "", SOURCE_CHARS))
    elif kind == "board":
        got = await cc_context._board(db, ref)
        if got:
            parts.append(_clip(got["text"], SOURCE_CHARS // 2))
        src = (await db["boards"].find_one({"_id": ref}, {"source": 1}) or {}).get("source")
        if src:
            parts.append("Board source:\n```\n" + _clip(src, SOURCE_CHARS // 2) + "\n```")
    else:
        from . import firmware
        fw = await firmware.get(db, ref)
        parts.append(f"Firmware `{ref}` - \"{label}\" for board {fw.get('board')} ({fw.get('mcu_title') or fw.get('mcu') or '?'}), "
                     f"version {fw.get('version')}")
        b = fw.get("build") or {}
        if b.get("state"):
            parts.append(f"Last build: {b.get('state')}, {b.get('error_count', 0)} errors, {b.get('warning_count', 0)} warnings")
        files = await firmware.contents(db, ref)
        left = SOURCE_CHARS
        for path in sorted(files, key=lambda p: (not p.startswith("src/"), p)):
            if left <= 0:
                parts.append(f"[... {len(files)} files in all; the rest left out]")
                break
            body = _clip(files[path], min(left, 12_000))
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
    return "\n\n".join(p for p in parts if p), label


class ExtractError(Exception):
    """What the person is told when extraction cannot run or fails."""


async def extract(db, kind: str, ref: str) -> dict:
    """Proposals for one project: {project, proposals, provider, model}.
    Nothing is saved."""
    try:
        material, label = await gather(db, kind, ref)
    except KeyError as exc:
        raise LookupError(f"{kind} {ref} is not in this workspace") from exc
    prov, model = llm.route(JOB)
    if not llm.key(prov):
        raise ExtractError(llm.no_key(prov, JOB))
    source = {"kind": kind, "id": ref, "label": label}
    try:
        d = await llm.complete([{"role": "system", "content": EXTRACT_PROMPT},
                                {"role": "user", "content": f"Project: {kind} \"{label}\"\n\n{material}"}],
                               job=JOB, max_tokens=EXTRACT_TOKENS, temperature=0.2, timeout=EXTRACT_TIMEOUT)
    except Exception as exc:                           # noqa: BLE001 - said to the person, plainly
        raise ExtractError(f"the {llm.PROVIDERS.get(prov, {}).get('name', prov)} model {model} failed: "
                           f"{str(exc)[:300] or type(exc).__name__}") from exc
    await llm.record(db, provider=d.get("provider") or prov, model=d.get("model") or model,
                     surface="taste", kind="taste", used=d.get("usage") or {})
    content = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    try:
        got = parse_proposals(content, source)
    except ValueError as exc:
        raise ExtractError(f"{exc} - try again, or pick another model for Taste extraction "
                           "in Settings > LLM settings") from exc
    if not got:
        raise ExtractError("the model proposed nothing for this project")
    return {"project": source, "proposals": got, "provider": d.get("provider") or prov, "model": d.get("model") or model}


# ---- the API -----------------------------------------------------------------

def out(d: dict) -> dict:
    items = d.get("items") or []
    return {**{k: v for k, v in d.items() if k not in ("_id", "workspace_id")}, "id": d["_id"],
            "items": items, "attached": d.get("attached") or [], "counts": counts(items)}


class ItemIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    domain: str = "general"
    strength: str = "prefer"
    why: str = Field(default="", max_length=MAX_WHY)
    source: dict | str | None = None


class ItemPatch(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=MAX_TEXT)
    domain: str | None = None
    strength: str | None = None
    why: str | None = Field(default=None, max_length=MAX_WHY)


class PaletteIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    items: list[ItemIn] = Field(default_factory=list, max_length=MAX_ITEMS)


class PalettePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    pinned: bool | None = None


class ItemsIn(BaseModel):
    items: list[ItemIn] = Field(min_length=1, max_length=MAX_ITEMS)
    at: int | None = None


class OrderIn(BaseModel):
    ids: list[str] = Field(max_length=MAX_ITEMS)


class Target(BaseModel):
    kind: str = Field(pattern="^(model|board|firmware)$")
    id: str = Field(min_length=1, max_length=200)


class AttachIn(BaseModel):
    attached: list[Target] = Field(default_factory=list, max_length=50)


class ExtractIn(BaseModel):
    kind: str = Field(pattern="^(model|board|firmware)$")
    id: str = Field(min_length=1, max_length=200)


def _404(pid: str):
    raise HTTPException(404, f"no palette {pid}")


@router.get("")
async def api_list(q: str = ""):
    return [out(d) for d in await listing(_db(), q[:200])]


@router.get("/projects")
async def api_projects(q: str = ""):
    return await projects(_db(), q[:200])


@router.get("/attached")
async def api_attached(kind: str, id: str):
    """The palettes attached to one project, and the text its agent reads."""
    if kind not in PROJECT_KINDS:
        raise HTTPException(400, "kind is model, board or firmware")
    rows = await attached_to(_db(), kind, id)
    return {"palettes": [out(d) for d in rows], "text": agent_text(rows)}


@router.post("/extract")
async def api_extract(body: ExtractIn):
    try:
        return await extract(_db(), body.kind, body.id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ExtractError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("")
async def api_create(body: PaletteIn):
    doc = await create(_db(), body.name, body.description, [i.model_dump() for i in body.items], actors.current())
    return out(doc)


@router.get("/{pid}")
async def api_get(pid: str):
    doc = await get(_db(), pid)
    if not doc:
        _404(pid)
    return out(doc)


@router.patch("/{pid}")
async def api_patch(pid: str, body: PalettePatch):
    doc = await patch(_db(), pid, body.name, body.description, body.pinned)
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
        doc = await attach(_db(), pid, [t.model_dump() for t in body.attached])
    except KeyError as exc:
        raise HTTPException(404, f"{exc.args[0]} is not in this workspace") from exc
    return out(doc)
