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
FOLDER_PROPOSALS = (8, 40)      # a folder: every project in it, read at once
FOLDER_CHARS = 120_000          # what extraction reads of a folder, split among its projects
FOLDER_TOKENS = 7_000
FOLDER_TIMEOUT = 240.0
STOCK_FOLDERS = ("purchased",)  # bought parts drawn to size: not the designer's taste

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
    if isinstance(src, dict) and src.get("kind") in (*PROJECT_KINDS, "folder") and src.get("id"):
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
    "You read a finished hardware project from Workbench (a 3D CAD model in build123d, a circuit "
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


def parse_proposals(raw: str, source: dict, most: int = PROPOSALS[1], stats: dict | None = None) -> list[dict]:
    """The model's answer as items: the JSON array (fenced or bare, or under
    an "items" key), each made whole, duplicates dropped, at most `most`.
    `stats`, when given, is told what was dropped: {rows, invalid,
    duplicates, over}."""
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
    f"another. Write between {FOLDER_PROPOSALS[0]} and {FOLDER_PROPOSALS[1]} statements in all, as the "
    "folder's design rules: 3D design rules (domain \"mechanical\"), PCB rules (\"pcb\"), firmware rules "
    "(\"firmware\") and rules that hold across them (\"general\"). Cover every domain the folder has "
    "material for. Prefer what recurs across its projects over what one part does once."
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
        parts.append(f"===== {kind} \"{got['label']}\" ({ref}) =====\n{got['text']}")
        await track.step(sid, state="done", project={"kind": kind, "id": ref, "label": got["label"]},
                         chars=len(got["text"]), clipped=got["clipped"], revisions=got["revisions"],
                         notes=got["notes"], **({"files": got["files"]} if "files" in got else {}))
    return "\n\n".join(parts), folder


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
    track.add(chars=len(material), read=sum(1 for s in track.steps if s.get("kind") == "read" and s["state"] == "done"))
    prov, model = llm.route(JOB)
    system = EXTRACT_PROMPT + (FOLDER_PROMPT if whole else "")
    user = f"Project: {kind} \"{label}\"\n\n{material}"
    prompt_chars = len(system) + len(user)
    timeout = FOLDER_TIMEOUT if whole else EXTRACT_TIMEOUT
    track.add(prompt_chars=prompt_chars, tokens_in_est=prompt_chars // CHARS_PER_TOKEN)
    await track.phase("asking", provider=prov, model=model,
                      provider_name=llm.PROVIDERS.get(prov, {}).get("name", prov))
    await track.step("ask", kind="ask", provider=prov, model=model,
                     provider_name=llm.PROVIDERS.get(prov, {}).get("name", prov), prompt_chars=prompt_chars,
                     tokens_est=prompt_chars // CHARS_PER_TOKEN, max_tokens=FOLDER_TOKENS if whole else EXTRACT_TOKENS,
                     timeout=timeout, sent_at=_now())
    if not llm.key(prov):
        why = llm.no_key(prov, JOB)
        await track.step("ask", state="failed", reason=why)
        raise ExtractError(why)
    try:
        d = await llm.complete([{"role": "system", "content": system}, {"role": "user", "content": user}],
                               job=JOB, max_tokens=FOLDER_TOKENS if whole else EXTRACT_TOKENS, temperature=0.2,
                               timeout=timeout)
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
        got = parse_proposals(content, source, FOLDER_PROPOSALS[1] if whole else PROPOSALS[1], stats)
    except ValueError as exc:
        why = f"{exc} - try again, or pick another model for Taste extraction in Settings > LLM settings"
        await track.step("parse", state="failed", reason=why)
        raise ExtractError(why) from exc
    await track.step("parse", state="done" if got else "failed", parsed=len(got), **stats,
                     **({} if got else {"reason": "the model proposed nothing"}))
    if not got:
        raise ExtractError("the model proposed nothing for this project")
    track.add(proposals=len(got))
    return {"project": source, "proposals": got, "provider": prov, "model": model, "usage": used}


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
ACTIVE = ("queued", "reading", "asking", "parsing")
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
                                     "provider": got["provider"], "model": got["model"]})
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
        await db[JOBS].delete_one({"_id": d["_id"]})


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


def job_out(d: dict, full: bool = True) -> dict:
    """A run as the page reads it: `now` is the server's clock, for the page
    to time a running step against; the proposals only when `full`."""
    keep = {k: v for k, v in d.items() if k not in ("_id", "workspace_id", "proposals", "worker", "beat")}
    out = {**keep, "id": d["_id"], "count": len(d.get("proposals") or []), "now": _now(),
           "seconds": d.get("seconds") if d.get("finished_at") else _seconds(d.get("started_at"))}
    if full:
        out["proposals"] = d.get("proposals") or []
    return out


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
    return {"palettes": [out(d) for d in rows], "text": agent_text(rows)}


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
    return {"deleted": jid}


# ---- sharing: a palette as a file ----------------------------------------------

FORMAT = "redline-taste"


def export_doc(doc: dict) -> dict:
    """A palette as a file another person can import: its statements and
    where they came from; not its attachments (those are this workspace's
    projects) nor anything about the account but the author's name."""
    return {"format": FORMAT, "version": 1, "name": doc.get("name") or "", "description": doc.get("description") or "",
            "by": ((doc.get("by") or {}).get("name") or ""), "exported_at": _now(),
            "items": [{k: i[k] for k in ("text", "domain", "strength", "why", "source") if i.get(k) not in (None, "")}
                      for i in doc.get("items") or []]}


async def import_doc(db, data: dict, by: dict) -> dict:
    """A palette file made into a new palette here. Its items are checked one
    by one like any other; a name already taken gets "(imported)"."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("this is not a Workbench taste palette file")
    if int(data.get("version") or 0) > 1:
        raise ValueError("this palette file is from a newer Workbench")
    items = data.get("items")
    if not isinstance(items, list):
        raise ValueError("the file has no items")
    name = str(data.get("name") or "Imported palette").strip()[:100] or "Imported palette"
    taken = {(d.get("name") or "").lower() for d in await listing(db)}
    if name.lower() in taken:
        name = f"{name} (imported)"
    doc = await create(db, name, str(data.get("description") or ""), [x for x in items if isinstance(x, dict)], by)
    if not doc["items"]:
        await db[COLL].delete_one({"_id": doc["_id"]})
        raise ValueError("none of the file's items could be read")
    src = {"by": str(data.get("by") or "")[:120], "at": _now(), "count": len(doc["items"])}
    await db[COLL].update_one({"_id": doc["_id"]}, {"$set": {"imported": src}})
    doc["imported"] = src
    return doc


@router.get("/{pid}/export")
async def api_export(pid: str):
    doc = await get(_db(), pid)
    if not doc:
        _404(pid)
    return export_doc(doc)


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
