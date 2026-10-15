"""The example questions on an empty Chat, written from the person's own work.

An empty Chat shows a handful of example questions to start from. Written
by hand they are the same for everyone; here a model writes them from what
the person is working on: the models, boards and firmware touched last,
the open drawn notes, the notes, the taste palettes, the manufacturers and
(when the setting says so) the titles of their recent conversations - a
short summary of names and states, never a file's content, a key or a
password.

It is a job in Settings > LLM settings ("chat_suggestions" in
backend/llm.py JOBS): a provider and a model like the others, plus its own
settings (llm.job_ideas): on/off, how often the questions are written
again, how many, and whether the conversations' titles are read.

The questions are kept per workspace, person and language (`COLL`, one
document each). The page is never kept waiting for them: it is handed the
last set at once - or nothing, and shows the hand-written ones - and when
that set is older than the interval (or written under other settings) a
new one is asked for in the background, for the next look. The refresh
button asks at once and waits. One call at a time per key; an automatic
one that failed is not tried again for RETRY_S. Every call goes in the
usage log like the other jobs' (kind "chat-suggestions").
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException

from . import access, actors, cc_chat, llm, prompts, scope

router = APIRouter(prefix="/api/cc/ideas")

JOB = "chat_suggestions"
COLL = "chat_ideas"            # the machine's: the key carries workspace, person and language
KINDS = ("pcb", "firmware", "cad", "notes", "taste", "manufacturers", "general")
LANGS = {"en": "English", "tr": "Turkish"}
MAX_CHARS = 180                # one question
SUMMARY_CHARS = 5000           # the workspace as the model reads it
ITEM_CHARS = 90                # one name or title in it
TIMEOUT = 45.0
RETRY_S = 600                  # an automatic call that failed waits this long

# What a model may call a kind, and the kind it is.
_ALIASES = {
    "pcb": "pcb", "board": "pcb", "boards": "pcb", "electronics": "pcb", "schematic": "pcb",
    "firmware": "firmware", "fw": "firmware", "code": "firmware", "embedded": "firmware",
    "cad": "cad", "3d": "cad", "3d/cad": "cad", "model": "cad", "models": "cad", "mechanical": "cad",
    "notes": "notes", "note": "notes", "queue": "notes", "revision": "notes", "revisions": "notes",
    "taste": "taste", "palette": "taste", "palettes": "taste", "style": "taste",
    "manufacturers": "manufacturers", "manufacturer": "manufacturers", "maker": "manufacturers",
    "makers": "manufacturers", "supplier": "manufacturers", "suppliers": "manufacturers",
    "general": "general",
}

PROMPT = (
    "You write the example questions shown on the empty screen of an engineering assistant's chat. "
    "The person designs hardware in a studio app: 3D models (build123d CAD), PCBs, firmware, notes "
    "and a review queue, taste palettes (design rules) and a manufacturer catalog. Below is a short "
    "summary of their workspace. Write {n} questions this person would really ask next about their "
    "own work: short (at most {chars} characters), concrete, naming their own models, boards, "
    "firmware or notes where it fits, varied across the kinds their workspace has, written as the "
    "person would type them, in {lang}. Tag each with one kind: "
    + ", ".join(KINDS) + ". Reply with JSON only, no Markdown: "
    '{{"questions": [{{"kind": "pcb", "text": "..."}}]}}'
)


def _db():
    from .main import db
    return db()


def _raw(db):
    return db.raw if getattr(type(db), "SCOPED", False) else db


def settings() -> dict:
    return llm.job_ideas(JOB)


def _sig(conf: dict) -> str:
    """What the kept set was written under: another count, or the titles
    in or out, or another wording of the prompt (Settings > LLM settings >
    Prompts), is a reason to write it again."""
    mark = prompts.stamp(("chat_ideas",))
    return f"{conf['count']}:{int(conf['chats'])}" + (f":{mark}" if mark else "")


def _key(lang: str) -> str:
    who = (actors.current() or {}).get("id") or "?"
    return f"{scope.current()}:{who}:{lang}"


def _clip(s, n: int = ITEM_CHARS) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[:n - 1].rstrip() + "…"


# ---- what the model reads ---------------------------------------------------

async def _rows(db, coll: str, q: dict, fields: dict, n: int, order: str = "updated_at") -> list[dict]:
    try:
        return [d async for d in db[coll].find(q, fields).sort(order, -1).limit(n)]
    except Exception:                                  # noqa: BLE001 - a part missing is fine
        llm.log.warning("chat ideas: %s not read", coll)
        return []


async def workspace_summary(db, chats: bool = True) -> str:
    """The person's current work in a few short lines: names and states
    only. Empty when there is nothing in the workspace."""
    parts: list[str] = []

    def section(title: str, lines: list[str]) -> None:
        lines = [ln for ln in lines if ln]
        if lines:
            parts.append(title + ":\n" + "\n".join("- " + ln for ln in lines))

    models = await _rows(db, "models", {}, {"title": 1, "name": 1, "updated_at": 1}, 8)
    section("3D models (latest first)", [_clip(d.get("title") or d.get("name") or d["_id"]) for d in models])
    boards = await _rows(db, "boards", {}, {"title": 1, "folder": 1, "updated_at": 1}, 8)
    section("PCBs (latest first)", [_clip(d.get("title") or d["_id"]) + (f" (in {_clip(d['folder'], 40)})" if d.get("folder") else "")
                                    for d in boards])
    fws = await _rows(db, "firmware", {}, {"title": 1, "board_title": 1, "mcu_part": 1, "updated_at": 1}, 6)
    section("Firmware", [_clip(d.get("title") or d["_id"]) + " - " + ", ".join(
        x for x in (_clip(d.get("mcu_part"), 40), f"board {_clip(d.get('board_title'), 40)}" if d.get("board_title") else "") if x)
        for d in fws])
    revs = await _rows(db, "revisions", {"status": {"$in": ["draft", "queued", "working", "failed"]}},
                       {"summary": 1, "comment": 1, "model": 1, "board": 1, "status": 1, "created_at": 1}, 8, "created_at")
    section("Open drawn notes / queue", [f"[{d.get('status')}] " + _clip(d.get("summary") or d.get("comment"), 120)
                                         + (f" (on {_clip(d.get('model') or d.get('board'), 40)})" if d.get("model") or d.get("board") else "")
                                         for d in revs if d.get("summary") or d.get("comment")])
    notes = await _rows(db, "notes", {}, {"title": 1, "text": 1, "updated_at": 1}, 6)
    section("Notes", [_clip(d.get("title") or d.get("text"), 120) for d in notes])
    pals = await _rows(db, "taste_palettes", {}, {"name": 1, "items": 1, "updated_at": 1}, 5)
    section("Taste palettes", [_clip(d.get("name") or d["_id"]) + f" ({len(d.get('items') or [])} items)" for d in pals])
    makers = await _rows(db, "manufacturers", {}, {"name": 1, "categories": 1, "updated_at": 1}, 5)
    section("Manufacturers", [_clip(d.get("name") or d["_id"]) + (" - " + _clip(", ".join(d.get("categories") or []), 60)
                                                                  if d.get("categories") else "") for d in makers])
    if chats:
        me = (actors.current() or {}).get("id")
        rows = await _rows(db, cc_chat.COLL, {"by.id": me, **cc_chat.LIVE}, {"title": 1, "updated_at": 1}, 12)
        section("Their recent conversation titles", [_clip(d.get("title"), 80) for d in rows
                                                     if d.get("title") and d.get("title") != cc_chat.DEFAULT_TITLE][:8])
    text = "\n\n".join(parts)
    return text if len(text) <= SUMMARY_CHARS else text[:SUMMARY_CHARS] + "\n…"


# ---- the model's answer -----------------------------------------------------

def _kind(raw) -> str:
    k = str(raw or "").strip().lower()
    return _ALIASES.get(k) or _ALIASES.get(k.rstrip("s")) or "general"


def parse(raw: str, count: int) -> list[dict]:
    """The model's answer as [{kind, text}]: JSON (an object with
    "questions", or a bare list, fenced or not), or failing that one
    question a line. At most `count`, no repeats, each cut to MAX_CHARS."""
    raw = (raw or "").strip()
    raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw)
    data = None
    for pat in (r"\{.*\}", r"\[.*\]"):
        m = re.search(pat, raw, re.S)
        if not m:
            continue
        try:
            data = json.loads(m.group(0))
            break
        except ValueError:
            continue
    if isinstance(data, dict):
        data = data.get("questions") or data.get("items") or data.get("examples")
    # No JSON: the lines that are list items or questions, not the prose around them.
    items: list = data if isinstance(data, list) else [
        ln for ln in raw.splitlines()
        if re.match(r"^\s*([-*]|\d+[.)])\s+\S", ln) or ln.strip().endswith("?")]
    out: list[dict] = []
    seen: set[str] = set()
    for it in items:
        if isinstance(it, dict):
            text, kind = it.get("text") or it.get("question") or "", _kind(it.get("kind") or it.get("area"))
        else:
            text, kind = str(it), "general"
            m = re.match(r"^\s*(?:[-*]|\d+[.)])?\s*\[?([A-Za-z/0-9]+)\]?\s*[:|-]\s+(.*)$", text)
            if m and _kind(m.group(1)) != "general":
                kind, text = _kind(m.group(1)), m.group(2)
        text = re.sub(r"^\s*([-*>]|\d+[.)])\s+", "", str(text)).strip().strip("\"'“”`").strip()
        if not text:
            continue
        if len(text) > MAX_CHARS:
            cut = text[:MAX_CHARS]
            text = (cut.rsplit(" ", 1)[0] if " " in cut else cut).rstrip(" ,;:") + "…"
        if text.lower() in seen:
            continue
        seen.add(text.lower())
        out.append({"kind": kind, "text": text})
        if len(out) >= count:
            break
    return out


# ---- kept and written again -------------------------------------------------

_tasks: dict[str, asyncio.Task] = {}
_indexed = False


async def _ensure_index(raw) -> None:
    global _indexed
    if _indexed:
        return
    _indexed = True
    try:
        await raw[COLL].create_index("ws", name="chat_ideas_ws")
    except Exception:                                  # noqa: BLE001 - only a lookup aid
        pass


def _age(doc: dict, now: float) -> float:
    at = doc.get("at")
    if isinstance(at, datetime):
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        return now - at.timestamp()
    return float("inf")


def stale(doc: dict | None, conf: dict, now: float | None = None) -> bool:
    """Whether the kept set should be written again: none yet, older than
    the interval, or written under other settings."""
    now = time.time() if now is None else now
    if not doc or not doc.get("items"):
        return True
    return doc.get("sig") != _sig(conf) or _age(doc, now) >= conf["every"]


def _may_ask() -> bool:
    """A call costs money: for whoever may write in the Chat."""
    return access.allowed(access.current(), "draw")


async def generate(db, lang: str, key: str) -> list[dict] | None:
    """Ask the model once and keep what it wrote; None when nothing came
    (off, no key, an empty workspace, a failure - the kept set stays)."""
    conf = settings()
    raw = _raw(db)
    prov, model = llm.route(JOB)
    now = datetime.now(timezone.utc)
    if not conf["on"] or not llm.key(prov):
        return None
    summary = await workspace_summary(db, conf["chats"])
    if not summary:
        # Nothing to write from: the hand-written ones, and a look again later.
        await raw[COLL].update_one({"_id": key}, {"$set": {"failed_at": now, "error": "the workspace is empty",
                                                           "ws": scope.current()}}, upsert=True)
        return None
    system = prompts.text("chat_ideas", n=conf["count"], chars=MAX_CHARS, lang=LANGS.get(lang, "English"))
    error = None
    items: list[dict] = []
    try:
        d = await asyncio.wait_for(llm.complete(
            [{"role": "system", "content": system}, {"role": "user", "content": "The workspace:\n\n" + summary}],
            job=JOB, max_tokens=120 + conf["count"] * 90, temperature=0.7, timeout=TIMEOUT), TIMEOUT + 5)
        await llm.record(db, provider=d.get("provider") or prov, model=d.get("model") or model,
                         surface="chat", kind="chat-suggestions", used=d.get("usage") or {})
        items = parse(((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "", conf["count"])
        if not items:
            error = "the answer held no questions"
    except Exception as exc:                           # noqa: BLE001 - the kept set, or the hand-written ones
        error = f"{type(exc).__name__}: {exc}"[:300]
    if error:
        llm.log.warning("chat ideas failed (%s %s): %s", prov, model, error)
        await raw[COLL].update_one({"_id": key}, {"$set": {"failed_at": now, "error": error, "ws": scope.current()}},
                                   upsert=True)
        return None
    await raw[COLL].update_one({"_id": key}, {"$set": {
        "items": items, "at": now, "sig": _sig(conf), "lang": lang, "ws": scope.current(),
        "provider": prov, "model": model, "error": None, "failed_at": None}}, upsert=True)
    return items


def _start(db, lang: str, key: str) -> asyncio.Task:
    """The one call for this key, started now or already running."""
    task = _tasks.get(key)
    if task and not task.done():
        return task
    task = asyncio.ensure_future(generate(db, lang, key))
    _tasks[key] = task
    task.add_done_callback(lambda t, k=key: _tasks.pop(k, None) if _tasks.get(k) is t else None)
    return task


def _out(doc: dict | None, conf: dict, refreshing: bool) -> dict:
    prov, model = llm.route("chat")
    doc = doc or {}
    items = doc.get("items") if conf["on"] else None
    at = doc.get("at")
    return {"items": items or [], "source": "llm" if items else "default", "on": conf["on"],
            "at": at.isoformat() if isinstance(at, datetime) else None, "refreshing": refreshing,
            "every": conf["every"], "count": conf["count"],
            "error": doc.get("error") if _may_ask() else None,
            # the model a conversation started from the empty Chat begins with
            "start": {"provider": prov, "model": model}}


async def ideas(db, lang: str) -> dict:
    """The kept set, at once; a new one asked for in the background when it
    is due (and the person may cause a call)."""
    conf = settings()
    key = _key(lang)
    raw = _raw(db)
    await _ensure_index(raw)
    doc = await raw[COLL].find_one({"_id": key})
    refreshing = key in _tasks and not _tasks[key].done()
    if conf["on"] and stale(doc, conf) and _may_ask() and not refreshing:
        failed = (doc or {}).get("failed_at")
        if failed and failed.tzinfo is None:
            failed = failed.replace(tzinfo=timezone.utc)
        recent_fail = failed and (time.time() - failed.timestamp()) < RETRY_S
        if not recent_fail and llm.key(llm.route(JOB)[0]):
            _start(db, lang, key)
            refreshing = True
    return _out(doc, conf, refreshing)


async def refresh(db, lang: str) -> dict:
    """Written again now, waited for."""
    conf = settings()
    key = _key(lang)
    if conf["on"]:
        await _start(db, lang, key)
    doc = await _raw(db)[COLL].find_one({"_id": key})
    return _out(doc, conf, False)


Lang = Literal["en", "tr"]


@router.get("")
async def get_ideas(lang: Lang = "en") -> dict:
    """{items: [{kind, text}], source: "llm" | "default", on, at, refreshing,
    every, count, start}. `default`: no written set - the page shows its
    hand-written examples."""
    return await ideas(_db(), lang)


@router.post("/refresh")
async def post_refresh(lang: Lang = "en") -> dict:
    """The refresh button: a new set written now (the same answer as GET)."""
    if not settings()["on"]:
        raise HTTPException(409, "the example questions are turned off in Settings > LLM settings")
    prov = llm.route(JOB)[0]
    if not llm.key(prov):
        raise HTTPException(409, llm.no_key(prov, JOB))
    return await refresh(_db(), lang)
