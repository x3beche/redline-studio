"""The Command Code room: people talking with a model, in the open.

A conversation belongs to the workspace, not to whoever started it: anyone
there can read it and add to it, and each line says who wrote it. The
answer is streamed as it is written (server-sent events) and kept when it
is done - or as far as it got, if someone pressed stop. A conversation
remembers its model; it starts with the one chosen for the "chat" job in
Preferences > LLM settings (backend/llm.py), and can be switched at any
line.

A conversation can be pinned (it stays on top of the list) and archived
(it leaves the list for the "Archived" filter). A line can be deleted, the
last line of one's own edited and sent again (everything after it goes),
and the last answer written again, with the same model or another. Who may
drop what: one's own lines, and the answers to them, always; anyone else's
only with the "delete" right - as deleting a conversation.

The first answer names the conversation: the "summary" job's model is
asked for a short title, and the first line, cut short, is the fallback.
Only while the title is still the default one.

A deleted conversation goes to the trash, not away: it is marked
(`deleted_at`, `deleted_by`) and left out of everything else - the list,
the search, reading it, talking in it - and can be brought back for
TRASH_DAYS days. After that the database drops it by itself (a TTL index
that holds only the trashed ones, see `ensure_indexes`). "Delete forever"
and "Empty trash" drop it at once. Who may: as deleting - one's own
always, anyone else's only with the "delete" right.

A line can carry @-mentions (backend/cc_context.py): models, boards, files,
notes, drawn notes and parts, read through the workspace and handed to the
model as a bounded context block that stays on the line (`context`, never
sent to the page - the chips are, as `mentions`).

Everyone with a conversation open sees an answer as it is written, not
only the one who asked: GET /chats/{id}/live is a server-sent stream fed
from the answer being written (`HUB`). The answer is not written by the
request that asked for it but by a runner of its own (backend/ccgen.py),
which keeps it - its thinking too, whole - as far as it got in the
database: closing the page, refreshing it or a reload of the API stops
nothing, and whoever opens the conversation gets the answer so far and the
rest as it comes. One answer at a time in a conversation; POST
/chats/{id}/stop stops it (whoever asked, or anyone with the "delete"
right).

A line sent while an answer is being written waits in the conversation's
queue (`queue`, on the conversation, in order) instead of being refused:
when the answer ends normally the runner sends the first one waiting
itself (`send_next`), the page that queued it open or not - one at a
time, each with its own model and mentions. An answer stopped, failed or
interrupted pauses the queue (`queue_paused`); "Send now" goes on, "Clear"
drops it. Whoever queued a line, or anyone who may delete, edits or
removes it. Every change goes out on the live stream as {type: queue}.

Search (GET /search) reads every line, not only the titles, through a text
index (`ensure_search_index`), and answers with the line it found, a
snippet and where the words are in it.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import access, actors, cc_context, ccgen, llm, scope

router = APIRouter(prefix="/api/cc")

COLL = "cc_chats"
MAX_MESSAGES = 400               # in one conversation
CONTEXT_CHARS = 400_000          # history sent with a new line, newest kept
MAX_ANSWER = 16_000              # tokens
DEFAULT_TITLE = "New conversation"
TITLE_WORDS = 6
TITLE_CHARS = 60
TITLE_TIMEOUT = 20.0             # seconds the summary model gets to name it
MAX_BULK = 200
TRASH_DAYS = 30                  # a deleted conversation can be restored for this long
TRASH_TTL = "cc_trash_ttl"       # the index that drops it afterwards
# Mongo's {field: None} matches a missing field, too: every conversation
# kept before there was a trash is a live one.
LIVE = {"deleted_at": None}
TRASHED = {"deleted_at": {"$ne": None}}
CHAT_CONTEXT = 4_000_000         # characters of mentioned context one conversation may hold
MAX_QUEUE = 10                   # lines waiting for the answer being written, per conversation

SYSTEM = (
    "You are a helpful assistant in Redline Studio, a workshop app for 3D CAD models, "
    "circuit boards. Several people may share this conversation; a line "
    "written by someone is prefixed with their name in brackets when there is more than "
    "one of them. Answer in the language you are asked in. Use Markdown where it helps. "
    "When you are asked to write a task or a note for the queue, put each task in a fenced "
    "block of its own with the info string task (```task), optionally starting with a line "
    "'title: ...' and a line 'target: <model, board or firmware id>', then the note itself "
    "as plain text. One task per block; the person sends it to the queue with one click."
)

TITLE_PROMPT = (
    "Write a title for a conversation that begins with the message below. At most "
    f"{TITLE_WORDS} words, in the language of the message. Reply with the title only: "
    "no quotes, no Markdown, no full stop at the end."
)


def _db():
    from .main import db
    return db()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc(v) -> datetime | None:
    """A stored time as an aware UTC datetime (Mongo hands back naive UTC)."""
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return None
    if not isinstance(v, datetime):
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def purge_at(doc: dict) -> datetime | None:
    """When a trashed conversation is dropped for good."""
    at = _utc(doc.get("deleted_at"))
    return at + timedelta(days=TRASH_DAYS) if at else None


def _mid() -> str:
    return secrets.token_hex(5)


def _out(doc: dict, full: bool = True) -> dict:
    o = {k: v for k, v in doc.items() if k not in ("_id", "workspace_id", "messages")}
    o["id"] = doc["_id"]
    o["pinned"] = bool(doc.get("pinned"))
    o["archived"] = bool(doc.get("archived"))
    gone = purge_at(doc)
    if gone:
        o["deleted_at"] = _utc(doc["deleted_at"]).isoformat()
        o["purge_at"] = gone.isoformat()
        # Whole days left, counted up: "deletes for good in 30 days" on the day.
        left = (gone - datetime.now(timezone.utc)).total_seconds() / 86400
        o["days_left"] = max(0, int(-(-left // 1)))
    else:
        o.pop("deleted_at", None)
        o.pop("deleted_by", None)
    msgs = doc.get("messages") or []
    o["count"] = len(msgs)
    o.pop("queue_rev", None)
    o["queue"] = queue_public(doc.get("queue"))
    o["queue_paused"] = bool(doc.get("queue_paused")) and bool(o["queue"])
    # Which task blocks of which answer went to the queue (backend/tasks.py),
    # on the line they are in.
    tasks = o.pop("tasks", None) or {}
    if full:
        o["messages"] = [{**public(m), "tasks": tasks[m["id"]]} if m.get("id") in tasks else public(m)
                         for m in msgs]
    elif msgs:
        last = msgs[-1]
        o["last"] = {"role": last["role"], "text": (last.get("content") or "")[:140],
                     "by": (last.get("by") or {}).get("name")}
    return o


def queue_public(q: list[dict] | None) -> list[dict]:
    """The lines waiting, as the page gets them: what they say and mention,
    who queued them and for which model - not the context read for them."""
    return [{k: it.get(k) for k in ("id", "content", "mentions", "by", "at", "provider", "model") if k in it}
            for it in q or []]


def public(m: dict) -> dict:
    """A line as the page gets it: the context block its mentions were
    expanded into stays here; its size goes instead."""
    if "context" not in m and "attach" not in m:
        return m
    o = {k: v for k, v in m.items() if k not in ("context", "attach")}
    o["context_chars"] = len(m.get("context") or "")
    return o


RECALL_RECENT = 1_500            # characters of a step's result replayed for the newest answers
RECALL_OLD = 300                 # and for older ones
RECENT_ANSWERS = 2
STEPS_NOTE = (
    "Earlier answers in this conversation show the tools they ran and what came back - as tool "
    "calls and results, or as a list the server wrote at the start of the answer ('[Tools run "
    "for this answer ...]'). Those are real: the tools did run and the results are what they "
    "returned. Trust them; do not take back or 'correct' facts an earlier answer got from a "
    "tool. Results replayed here are shortened to save space - the answer they belong to was "
    "written with the whole result, so a shortened result is no reason to doubt it. An earlier "
    "answer without such a list or tool calls used no tools. Never write such a list yourself."
)


def _step_result(s: dict, n: int) -> str:
    """What a step of an earlier answer gave, at most `n` characters."""
    st = s.get("status")
    if st == "error":
        return f"Error: {s.get('error') or 'failed'}"
    if st == "denied":
        return "Not run: the person did not allow it."
    if st in ("stopped", "interrupted", "running", "ask"):
        return f"Not finished: the answer was {st if st in ('stopped', 'interrupted') else 'stopped'}."
    got = s.get("result") or s.get("summary") or "(done)"
    full = max(int(s.get("result_chars") or 0), len(got)) if s.get("result") else 0
    cut = got[:n]
    if full > len(cut):
        cut += (f"\n[{full - len(cut)} more characters of this result are left out of this replay only, "
                "to save space; the answer was written with all of it]")
    elif not s.get("result"):
        cut += "\n[only a short summary of this result is kept; the answer was written with all of it]"
    return cut


def _args(s: dict) -> str:
    return ", ".join(f"{k}={v!r}" for k, v in (s.get("args") or {}).items())


def _segments(text: str, steps: list[dict]) -> list[tuple[str, list[dict]]]:
    """An answer cut at its steps: (text before, the steps there) in order,
    the last with no steps."""
    out: list[tuple[str, list[dict]]] = []
    at = 0
    for s in sorted(steps, key=lambda s: s.get("pos") or 0):
        pos = min(max(int(s.get("pos") or 0), at), len(text))
        if out and pos == at and out[-1][1]:
            out[-1][1].append(s)
        else:
            out.append((text[at:pos], [s]))
        at = pos
    out.append((text[at:], []))
    return out


def _replay(m: dict, text: str, n: int, calls: bool, key: str) -> tuple[list[dict], int]:
    """An earlier answer as the model is shown it, with the tools it ran:
    faithfully (an assistant turn asking for them, then their results) when
    `calls`, else as a written list at its start. Returns the lines and
    their size in characters."""
    steps = m.get("steps") or []
    if not calls:
        rows = [f"- {s.get('tool')}({_args(s)}) -> {_step_result(s, n)}" for s in steps]
        head = "[Tools run for this answer, by the server, before or while it was written:\n" + "\n".join(rows) + "]"
        body = head + "\n\n" + text
        return [{"role": "assistant", "content": body}], len(body)
    out: list[dict] = []
    size = 0
    for k, (said, group) in enumerate(_segments(text, steps)):
        said = said.strip()
        if not group:
            said = said or "(the answer ended here)"
            out.append({"role": "assistant", "content": said})
            size += len(said)
            continue
        ids = [f"h{key}_{k}_{j}" for j in range(len(group))]
        out.append({"role": "assistant", "content": said, "tool_calls": [
            {"id": i, "type": "function", "function": {"name": s.get("tool"), "arguments": json.dumps(s.get("args") or {})}}
            for i, s in zip(ids, group)]})
        size += len(said)
        for i, s in zip(ids, group):
            res = _step_result(s, n)
            out.append({"role": "tool", "tool_call_id": i, "content": res,
                        **({"is_error": True} if s.get("status") != "done" else {})})
            size += len(res) + len(_args(s))
    return out, size


def history(msgs: list[dict], images: list[dict] | None = None, tools: set[str] | None = None) -> list[dict]:
    """What the model is sent: the system line, then the conversation -
    newest first until the budget, then put back in order. Names on the
    people's lines once there is more than one person; a line's mentions,
    as their context block, before it. `images` (OpenAI image parts) go
    with the last line.

    An earlier answer's steps (the tools it ran, backend/ccgen.py) go with
    it, so the model can tell which of its facts came from a tool: as tool
    calls and their results when the model has `tools` now (all of that
    answer's among them - a provider wants every tool it is shown called
    to be one it was given), else as a list written at the answer's start.
    The newest answers keep more of each result than older ones."""
    people = {(m.get("by") or {}).get("id") for m in msgs if m["role"] == "user"}
    named = len(people) > 1
    units: list[list[dict]] = []
    used = 0
    answers = 0
    stepped = False
    for idx in range(len(msgs) - 1, -1, -1):
        m = msgs[idx]
        text = m.get("content") or ""
        steps = (m.get("steps") or []) if m["role"] == "assistant" else []
        if not text.strip() and not steps:
            continue                                   # failed, or stopped before a word
        if named and m["role"] == "user":
            text = f"[{(m.get('by') or {}).get('name') or 'someone'}] {text}"
        if m["role"] == "user" and m.get("context"):
            text = m["context"] + "\n\n" + text
        if steps:
            n = RECALL_RECENT if answers < RECENT_ANSWERS else RECALL_OLD
            calls = bool(tools) and all(s.get("tool") in tools for s in steps)
            unit, size = _replay(m, text, n, calls, str(idx))
            stepped = True
        else:
            unit, size = [{"role": m["role"], "content": text}], len(text)
        answers += m["role"] == "assistant"
        used += size
        if used > CONTEXT_CHARS and units:
            break
        units.append(unit)
    # The API wants the turns to alternate and to start with the person;
    # two plain lines in a row from people (two people, or an answer that
    # failed) are joined into one.
    merged: list[dict] = []
    for unit in reversed(units):
        for m in unit:
            prev = merged[-1] if merged else None
            if prev and prev["role"] == m["role"] and m["role"] in ("user", "assistant") \
                    and not prev.get("tool_calls") and not m.get("tool_calls"):
                prev["content"] += "\n\n" + m["content"]
            else:
                merged.append(dict(m))
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    if images and merged and merged[-1]["role"] == "user":
        merged[-1]["content"] = [{"type": "text", "text": merged[-1]["content"]}, *images]
    system = SYSTEM + ("\n\n" + STEPS_NOTE if stepped else "")
    return [{"role": "system", "content": system}] + merged


# ---- lines: finding them, and whose they are -------------------------------

def find(msgs: list[dict], ref: str) -> int:
    """A line by its id; a line kept before lines had ids, by its place.
    -1 when there is no such line."""
    for i, m in enumerate(msgs):
        if m.get("id") == ref:
            return i
    if ref.isdigit() and int(ref) < len(msgs) and not msgs[int(ref)].get("id"):
        return int(ref)
    return -1


def owners(msgs: list[dict]) -> list[str | None]:
    """Whose each line is: a person's line is theirs, an answer belongs to
    whoever asked the question it answers."""
    out: list[str | None] = []
    asker: str | None = None
    for m in msgs:
        if m["role"] == "user":
            asker = (m.get("by") or {}).get("id")
            out.append(asker)
        else:
            out.append(asker)
    return out


def may_drop(msgs: list[dict], idx: list[int], me: str | None, can_delete: bool) -> bool:
    """Lines at `idx` may go: all of them are mine, or I may delete."""
    if can_delete:
        return True
    own = owners(msgs)
    return all(own[i] == me for i in idx)


def with_ids(msgs: list[dict]) -> tuple[list[dict], bool]:
    """Every line with an id - the ones kept before there were ids get one.
    Says whether any was given."""
    changed = False
    out = []
    for m in msgs:
        if not m.get("id"):
            m = {**m, "id": _mid()}
            changed = True
        out.append(m)
    return out, changed


def regen_cut(msgs: list[dict]) -> int:
    """Where the conversation is cut to answer its last question again:
    after the last person's line (the answers after it go)."""
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i]["role"] == "user":
            return i + 1
    return -1


def clean_title(raw: str) -> str:
    """The summary model's answer as a title: one line, no quotes or
    Markdown, at most TITLE_WORDS words."""
    line = next((ln for ln in (raw or "").splitlines() if ln.strip()), "")
    line = re.sub(r"^\s*(title|başlık)\s*:\s*", "", line, flags=re.I)
    line = line.strip().strip("#*_`\"'“”‘’«» ").rstrip(".。!").strip()
    words = line.split()
    return " ".join(words[:TITLE_WORDS])[:TITLE_CHARS].strip()


def fallback_title(text: str) -> str:
    return " ".join((text or "").split())[:TITLE_CHARS] or DEFAULT_TITLE


async def make_title(first: str, answer: str = "") -> tuple[str, dict]:
    """A short title from the summary model, or the first line cut short.
    Returns the title and what the call used (empty when there was none)."""
    prov, model = llm.route("summary")
    if first.strip() and llm.key(prov):
        try:
            prompt = first[:2000] + (f"\n\n(The answer began: {answer[:600]})" if answer else "")
            d = await asyncio.wait_for(llm.complete(
                [{"role": "system", "content": TITLE_PROMPT}, {"role": "user", "content": prompt}],
                job="summary", max_tokens=40, temperature=0.2), TITLE_TIMEOUT)
            got = clean_title(((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
            if got:
                return got, {**(d.get("usage") or {}), "provider": d.get("provider") or prov,
                             "model": d.get("model") or model}
        except Exception:                              # noqa: BLE001 - the fallback is fine
            pass
    return fallback_title(first), {}


# ---- the trash: kept TRASH_DAYS days, then dropped by the database -----------

async def ensure_indexes(raw) -> None:
    """The index that empties the trash: a TTL on `deleted_at` that holds
    only the trashed conversations (a partial index - the live ones have no
    `deleted_at` and are never in it). One for the collection, so for every
    workspace alike: the time is all it asks. Safe to call at every start;
    one left with other options (another TTL) is replaced."""
    coll = raw[COLL]
    spec = {"name": TRASH_TTL, "expireAfterSeconds": TRASH_DAYS * 86400,
            "partialFilterExpression": {"deleted_at": {"$type": "date"}}}
    try:
        await coll.create_index([("deleted_at", 1)], **spec)
    except Exception as exc:                           # noqa: BLE001
        if getattr(exc, "code", None) not in (85, 86):  # IndexOptionsConflict, IndexKeySpecsConflict
            raise
        for old in (TRASH_TTL, [("deleted_at", 1)]):
            try:
                await coll.drop_index(old)
            except Exception:                          # noqa: BLE001 - not there by that name
                pass
        await coll.create_index([("deleted_at", 1)], **spec)


SEARCH_INDEX = "cc_text"         # the titles and every line, for GET /search


async def ensure_search_index(raw) -> None:
    """The text index search reads: the titles (weighted up) and every
    line's text - never the mentioned context, which is the workspace's
    things, not the conversation. No stemming ("none"): the room speaks
    Turkish and English in one breath. One for the collection, like the
    trash's: the workspace is in every query (backend/scope.py), as are
    the trash and the archive. A collection has one text index at most, so
    one made with other fields or options is replaced. Safe at every start."""
    coll = raw[COLL]
    keys = [("title", "text"), ("messages.content", "text")]
    spec = {"name": SEARCH_INDEX, "weights": {"title": 5, "messages.content": 1}, "default_language": "none"}
    try:
        await coll.create_index(keys, **spec)
    except Exception as exc:                           # noqa: BLE001
        if getattr(exc, "code", None) not in (85, 86):  # IndexOptionsConflict, IndexKeySpecsConflict
            raise
        info = await coll.index_information()
        for name, ix in info.items():
            if name == SEARCH_INDEX or any(k == "_fts" for k, _ in ix.get("key") or []):
                await coll.drop_index(name)
        await coll.create_index(keys, **spec)


def _gone_by() -> dict:
    who = actors.current() or {}
    return {"id": who.get("id"), "name": who.get("name"), "type": who.get("type")}


async def _trash(db, cid: str) -> bool:
    """Into the trash; False when it was not (any more) a live one."""
    res = await db[COLL].update_one({"_id": cid, **LIVE},
                                    {"$set": {"deleted_at": datetime.now(timezone.utc), "deleted_by": _gone_by()}})
    return bool(getattr(res, "matched_count", 1))


# ---- conversations ----------------------------------------------------------

@router.get("/chats")
async def list_chats(q: str = "", archived: str = "0", trash: str = "0") -> list[dict]:
    """`archived`: 0 (default) leaves the archived ones out, 1 is only
    them, all is both. `trash=1` is the trash instead - archived or not,
    newest deleted first - and nothing else ever shows a trashed one."""
    in_trash = trash in ("1", "true")
    query: dict = dict(TRASHED if in_trash else LIVE)
    if q:
        query["$or"] = [{"title": {"$regex": re.escape(q), "$options": "i"}},
                        {"messages.content": {"$regex": re.escape(q), "$options": "i"}}]
    if not in_trash and archived in ("1", "true"):
        query["archived"] = True
    elif not in_trash and archived != "all":
        query["archived"] = {"$ne": True}
    order = [("deleted_at", -1)] if in_trash else [("pinned", -1), ("updated_at", -1)]
    cur = _db()[COLL].find(query, {"messages": {"$slice": -1}}).sort(order).limit(300)
    rows = [d async for d in cur]
    if in_trash:
        # The TTL monitor runs once a minute or so: past its day, it is gone.
        now = datetime.now(timezone.utc)
        rows = [d for d in rows if (purge_at(d) or now) > now]
    # $slice keeps the last one; the count needs the length.
    counts = {d["_id"]: d["n"] async for d in _db()[COLL].aggregate(
        [{"$project": {"n": {"$size": {"$ifNull": ["$messages", []]}}}}])}
    out = []
    for d in rows:
        o = _out(d, full=False)
        o["count"] = counts.get(d["_id"], o["count"])
        out.append(o)
    return out


SNIPPET = 200                    # characters of a line around what was found
PER_CHAT = 3                     # lines shown from one conversation


def terms(q: str) -> list[str]:
    """The words a search looks for, as the text index splits them: quoted
    phrases kept whole, "-word" (left out by the index) not highlighted."""
    out: list[str] = []
    for phrase, word in re.findall(r'"([^"]+)"|(\S+)', q):
        t = (phrase or word).strip().lower()
        if t and not t.startswith("-"):
            t = t.strip(".,;:!?()[]{}'\"")
            if t and t not in out:
                out.append(t)
    return out


def snippet(text: str, words: list[str], width: int = SNIPPET) -> tuple[str, list[list[int]]] | None:
    """The part of a line around the first word found, and where every word
    found is in it ([start, end] in the snippet). None when none is in it."""
    flat = " ".join((text or "").split())
    low = flat.lower()
    found = [(m.start(), m.end()) for w in words for m in re.finditer(re.escape(w), low)]
    if not found:
        return None
    found.sort()
    first = found[0][0]
    start = max(0, min(first - width // 3, len(flat) - width))
    end = min(len(flat), start + width)
    pre = "…" if start > 0 else ""
    post = "…" if end < len(flat) else ""
    hits = [[s - start + len(pre), e - start + len(pre)] for s, e in found if s >= start and e <= end]
    return pre + flat[start:end] + post, hits


@router.get("/search")
async def search(q: str = "", archived: str = "0", trash: str = "0", limit: int = 30) -> dict:
    """Every conversation's title and lines, through the text index: the
    lines found (up to PER_CHAT a conversation), each with its time, a
    snippet and where the words are in it. `archived` and `trash` as for
    the list: 0 leaves the archived out, all takes them too; trash=1 looks
    only in the trash. Without the index (not made yet) it reads them all."""
    q = q.strip()[:200]
    words = terms(q)
    if not words:
        return {"q": q, "how": "none", "results": []}
    in_trash = trash in ("1", "true")
    query: dict = dict(TRASHED if in_trash else LIVE)
    if not in_trash and archived in ("1", "true"):
        query["archived"] = True
    elif not in_trash and archived != "all":
        query["archived"] = {"$ne": True}
    limit = max(1, min(limit, 100))
    fields = {"title": 1, "messages.id": 1, "messages.role": 1, "messages.content": 1, "messages.at": 1,
              "messages.by": 1, "archived": 1, "pinned": 1, "updated_at": 1, "deleted_at": 1}
    coll = _db()[COLL]
    how = "index"
    try:
        cur = coll.find({**query, "$text": {"$search": q}}, {**fields, "score": {"$meta": "textScore"}}) \
            .sort([("score", {"$meta": "textScore"})]).limit(limit)
        rows = [d async for d in cur]
    except Exception as exc:                           # noqa: BLE001
        if getattr(exc, "code", None) != 27:            # IndexNotFound: read them all instead
            raise
        how = "scan"
        rx = "|".join(re.escape(w) for w in words)
        query["$or"] = [{"title": {"$regex": rx, "$options": "i"}},
                        {"messages.content": {"$regex": rx, "$options": "i"}}]
        cur = coll.find(query, fields).sort([("updated_at", -1)]).limit(limit)
        rows = [d async for d in cur]
    results: list[dict] = []
    for d in rows:
        chat = {"chat_id": d["_id"], "title": d.get("title") or DEFAULT_TITLE, "archived": bool(d.get("archived")),
                "pinned": bool(d.get("pinned")), "score": round(d.get("score") or 0, 3),
                "trashed": bool(d.get("deleted_at"))}
        shown = 0
        for m in reversed(d.get("messages") or []):    # newest first
            got = snippet(m.get("content") or "", words)
            if not got:
                continue
            results.append({**chat, "message_id": m.get("id"), "role": m.get("role"), "at": m.get("at"),
                            "by": (m.get("by") or {}).get("name"), "snippet": got[0], "hits": got[1]})
            shown += 1
            if shown >= PER_CHAT:
                break
        if not shown:
            got = snippet(chat["title"], words) or (chat["title"], [])
            results.append({**chat, "message_id": None, "role": None, "at": d.get("updated_at"), "by": None,
                            "snippet": got[0], "hits": got[1]})
    return {"q": q, "how": how, "results": results}


@router.get("/mentions")
async def mentions(q: str = "", kind: str = "", limit: int = 40) -> list[dict]:
    """What `@` offers in the composer: models, boards, files, notes, drawn
    notes and parts matching `q` - this workspace's, for whoever may look."""
    return await cc_context.candidates(_db(), q[:200], kind, max(1, min(limit, 100)))


class ChatIn(BaseModel):
    title: str = Field(default="", max_length=120)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)


@router.post("/chats")
async def create_chat(body: ChatIn) -> dict:
    prov, model = llm.route("chat")
    if body.provider:
        if body.provider not in llm.PROVIDERS:
            raise HTTPException(400, f"unknown provider {body.provider!r}")
        if body.provider != prov and not body.model:
            # another provider and no model named: its cheap one, or a choice
            if body.provider != llm.CHEAP[0]:
                raise HTTPException(400, f"choose a {llm.PROVIDERS[body.provider]['name']} model")
            model = llm.CHEAP[1]
        prov = body.provider
    model = body.model or model
    now = _now()
    doc = {"_id": secrets.token_hex(6), "title": body.title.strip() or DEFAULT_TITLE,
           "provider": prov, "model": model, "by": actors.current(),
           "created_at": now, "updated_at": now, "messages": []}
    await _db()[COLL].insert_one(doc)
    return _out(doc)


class BulkIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=MAX_BULK)
    # Dropped at once instead of going to the trash (from the trash).
    forever: bool = False


def _mine(doc: dict) -> bool:
    return (doc.get("by") or {}).get("id") == actors.current().get("id")


def _can_delete() -> bool:
    return access.allowed(access.current(), "delete")


@router.post("/chats/bulk-delete")
async def bulk_delete(body: BulkIn) -> dict:
    """Several conversations at once: each one as DELETE /chats/{id} would -
    one's own always, anyone else's only with the "delete" right. The ones
    refused are named, the rest go - to the trash, or with `forever` (from
    the trash) for good."""
    db = _db()
    deleted: list[str] = []
    refused: list[str] = []
    missing: list[str] = []
    can = _can_delete()
    for cid in dict.fromkeys(body.ids):
        doc = await db[COLL].find_one({"_id": cid} if body.forever else {"_id": cid, **LIVE}, {"by": 1, "title": 1})
        if not doc:
            missing.append(cid)
        elif not _mine(doc) and not can:
            refused.append(cid)
        else:
            if body.forever:
                await db[COLL].delete_one({"_id": cid})
            elif not await _trash(db, cid):
                missing.append(cid)
                continue
            deleted.append(cid)
            # A POST is not in the trail by itself; a delete must be.
            await actors.audit(db, "delete", f"/api/cc/chats/{cid}",
                               {"how": "bulk", "title": doc.get("title"),
                                **({"forever": True} if body.forever else {"trash": True})})
    return {"deleted": deleted, "refused": refused, "missing": missing}


async def _restore(db, cid: str) -> str:
    """"restored", "refused" or "missing"."""
    doc = await db[COLL].find_one({"_id": cid, **TRASHED}, {"by": 1, "title": 1})
    if not doc:
        return "missing"
    if not _mine(doc) and not _can_delete():
        return "refused"
    res = await db[COLL].update_one({"_id": cid, **TRASHED}, {"$unset": {"deleted_at": "", "deleted_by": ""}})
    if not getattr(res, "matched_count", 1):
        return "missing"
    await actors.audit(db, "restore", f"/api/cc/chats/{cid}", {"title": doc.get("title")})
    return "restored"


@router.post("/chats/bulk-restore")
async def bulk_restore(body: BulkIn) -> dict:
    """Several out of the trash at once, as POST /chats/{id}/restore would."""
    db = _db()
    out: dict[str, list[str]] = {"restored": [], "refused": [], "missing": []}
    for cid in dict.fromkeys(body.ids):
        out[await _restore(db, cid)].append(cid)
    return out


@router.post("/chats/empty-trash")
async def empty_trash() -> dict:
    """Everything in the trash dropped for good - with the "delete" right;
    without it, one's own only (the rest stay, counted in `kept`)."""
    db = _db()
    can = _can_delete()
    mine, kept = [], 0
    async for d in db[COLL].find(TRASHED, {"by": 1}):
        if can or _mine(d):
            mine.append(d["_id"])
        else:
            kept += 1
    n = 0
    if mine:
        res = await db[COLL].delete_many({"_id": {"$in": mine}, **TRASHED})
        n = getattr(res, "deleted_count", len(mine))
        await actors.audit(db, "delete", "/api/cc/chats/empty-trash", {"how": "empty-trash", "count": n})
    return {"deleted": n, "kept": kept}


@router.get("/chats/{cid}")
async def get_chat(cid: str) -> dict:
    db = _db()
    doc = await db[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, cid)
    msgs = doc.get("messages") or []
    # Lines kept before lines had ids get one, once, so they can be named.
    fixed, changed = with_ids(msgs)
    if changed:
        res = await db[COLL].update_one({"_id": cid, "messages": {"$size": len(msgs)}},
                                        {"$set": {"messages": fixed}})
        if getattr(res, "matched_count", 1):
            doc["messages"] = fixed
    return _out(doc)


class ChatPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None
    archived: bool | None = None


@router.patch("/chats/{cid}")
async def patch_chat(cid: str, body: ChatPatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if "provider" in patch and patch["provider"] not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {patch['provider']!r}")
    if "title" in patch:
        patch["title"] = patch["title"].strip() or DEFAULT_TITLE
    if patch:
        res = await _db()[COLL].update_one({"_id": cid, **LIVE}, {"$set": patch})
        if not getattr(res, "matched_count", 1):
            raise HTTPException(404, cid)
    return await get_chat(cid)


@router.delete("/chats/{cid}")
async def delete_chat(cid: str, forever: str = "0") -> dict:
    """Into the trash; `forever=1` drops it for good (from the trash, or
    straight away). The trail has it as every DELETE (main.py)."""
    db = _db()
    for_good = forever in ("1", "true")
    doc = await db[COLL].find_one({"_id": cid} if for_good else {"_id": cid, **LIVE}, {"by": 1})
    if not doc:
        raise HTTPException(404, cid)
    # Your own, always; someone else's, only if you may delete (as notes).
    if not _mine(doc) and not _can_delete():
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    if for_good:
        await db[COLL].delete_one({"_id": cid})
        return {"deleted": cid, "forever": True}
    if not await _trash(db, cid):
        raise HTTPException(404, cid)
    return {"deleted": cid, "trash": True, "days": TRASH_DAYS}


@router.post("/chats/{cid}/restore")
async def restore_chat(cid: str) -> dict:
    """Out of the trash, as it was (pinned, archived, every line)."""
    got = await _restore(_db(), cid)
    if got == "missing":
        raise HTTPException(404, f"{cid} is not in the trash")
    if got == "refused":
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    return await get_chat(cid)


@router.delete("/chats/{cid}/messages/{ref}")
async def delete_message(cid: str, ref: str) -> dict:
    """One line out of a conversation: one's own (or an answer to it)
    always, anyone else's only with the "delete" right."""
    db = _db()
    doc = await db[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, cid)
    msgs = doc.get("messages") or []
    i = find(msgs, ref)
    if i < 0:
        raise HTTPException(404, f"no line {ref!r} in this conversation")
    if not may_drop(msgs, [i], actors.current().get("id"), _can_delete()):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    if msgs[i].get("id"):
        await db[COLL].update_one({"_id": cid}, {"$pull": {"messages": {"id": msgs[i]["id"]}}})
    else:
        rest = msgs[:i] + msgs[i + 1:]
        res = await db[COLL].update_one({"_id": cid, "messages": {"$size": len(msgs)}},
                                        {"$set": {"messages": rest}})
        if not getattr(res, "matched_count", 1):
            raise HTTPException(409, "the conversation changed meanwhile - try again")
    return await get_chat(cid)


# ---- talking ----------------------------------------------------------------

class MentionIn(BaseModel):
    kind: str = Field(max_length=20)
    id: str = Field(min_length=1, max_length=300)


class SayIn(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)
    # Edit: this line (one's own) is replaced by `text`, and everything
    # after it goes before the answer is written again.
    edit: str | None = Field(default=None, max_length=40)
    # @-mentions: read here, through the workspace (backend/cc_context.py).
    mentions: list[MentionIn] = Field(default_factory=list, max_length=cc_context.MAX_MENTIONS)
    # The page that asked, so it can tell its own answer from someone
    # else's on the live stream.
    client: str | None = Field(default=None, max_length=40)


class RegenIn(BaseModel):
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=200)
    client: str | None = Field(default=None, max_length=40)


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


async def _load(cid: str) -> dict:
    doc = await _db()[COLL].find_one({"_id": cid, **LIVE})
    if not doc:
        raise HTTPException(404, cid)
    return doc


def _pick(doc: dict, provider: str | None, model: str | None) -> tuple[str, str]:
    provider = provider or doc.get("provider") or llm.route("chat")[0]
    if provider not in llm.PROVIDERS:
        raise HTTPException(400, f"unknown provider {provider!r}")
    if not model:
        # The conversation's own model, or the chat job's, only on their own
        # provider; else the cheap one. Never a dearer model nobody chose.
        jp, jm = llm.route("chat")
        if provider == (doc.get("provider") or jp) and doc.get("model"):
            model = doc["model"]
        elif provider == jp:
            model = jm
        elif provider == llm.CHEAP[0]:
            model = llm.CHEAP[1]
        else:
            raise HTTPException(400, f"choose a {llm.PROVIDERS[provider]['name']} model")
    if not llm.key(provider):
        raise HTTPException(503, llm.no_key(provider, "chat"))
    return provider, model


async def _cut(db, cid: str, msgs: list[dict], keep: int, tail: list[dict], sets: dict) -> None:
    """The conversation becomes msgs[:keep] + tail - only if nobody added a
    line meanwhile (otherwise 409, and nothing changed)."""
    query = {"_id": cid, "messages": {"$size": len(msgs)}}
    if sets.get("gen"):
        query["gen"] = None                            # and only while no answer is being written
    res = await db[COLL].update_one(query, {"$set": {"messages": msgs[:keep] + tail, **sets}})
    if not getattr(res, "matched_count", 1):
        raise HTTPException(409, "the conversation changed meanwhile - read it again and retry")


# ---- watching an answer being written --------------------------------------

class Hub:
    """Who is watching which conversation, and the answers being written in
    it. One per API process (the room runs in one): the request writing an
    answer publishes each piece here, and every page with the conversation
    open has a queue on GET /chats/{id}/live that the pieces are copied to.
    A page that cannot keep up (its queue full) is let go - it reconnects
    and starts again from the state, which holds the answer so far."""

    QUEUE = 2000

    def __init__(self):
        self.subs: dict[str, set[asyncio.Queue]] = {}
        self.live: dict[str, dict[str, dict]] = {}     # key -> gen -> state
        self.tails: dict[str, asyncio.Task] = {}       # key -> the task following its generation (`_tail`)
        self.poked: set[str] = set()                   # keys whose task should look once more

    def subscribe(self, key: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(self.QUEUE)
        self.subs.setdefault(key, set()).add(q)
        return q

    def unsubscribe(self, key: str, q: asyncio.Queue) -> None:
        got = self.subs.get(key)
        if got is not None:
            got.discard(q)
            if not got:
                self.subs.pop(key, None)

    def watchers(self, key: str) -> int:
        return len(self.subs.get(key) or ())

    def publish(self, key: str, ev: dict) -> None:
        for q in list(self.subs.get(key) or ()):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                self.unsubscribe(key, q)
                try:
                    q.get_nowait()                     # room for the goodbye
                    q.put_nowait(None)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def snapshot(self, key: str) -> list[dict]:
        at = ccgen._iso()                              # the server's clock now, for the page's speed
        return [{**v, "now": at} for v in (self.live.get(key) or {}).values()]

    def busy(self, key: str) -> bool:
        return bool(self.live.get(key))

    def begin(self, key: str, state: dict) -> None:
        self.live.setdefault(key, {})[state["gen"]] = state
        self.publish(key, {"type": "start", **state})

    def piece(self, key: str, gen: str, kind: str, text: str) -> None:
        st = (self.live.get(key) or {}).get(gen)
        if st is not None:
            # Whole: the thinking is shown in full, never its tail.
            st["text" if kind == "text" else "thinking"] += text
        self.publish(key, {"type": kind, "gen": gen, "text": text})

    def end(self, key: str, gen: str, ev: dict) -> None:
        got = self.live.get(key) or {}
        got.pop(gen, None)
        if not got:
            self.live.pop(key, None)
        self.publish(key, {**ev, "gen": gen})
        self.publish(key, {"type": "end", "gen": gen})


HUB = Hub()
LIVE_PING = 10.0                 # seconds between keep-alive comments (the page gives up after 25 s of nothing)
LIVE_MAX = 300.0                 # an idle stream is closed (and reopened by the page) after this


def live_key(cid: str) -> str:
    return f"{scope.current()}:{cid}"


@router.get("/chats/{cid}/live")
async def live(cid: str, request: Request):
    """The answers being written in this conversation, as they are written,
    for everyone who has it open. Events: {type: hello, live: [...]} first
    (the answers already under way, as far as they got), then start, text,
    thinking, done, error, end and title, each with the `gen` it belongs
    to. Closed after LIVE_MAX seconds with nothing under way ({type: bye});
    the page opens it again."""
    doc = await _load(cid)                             # this workspace's, and not in the trash
    key = live_key(cid)
    q = HUB.subscribe(key)
    # An answer being written by a runner this process has not followed yet
    # (written before a reload, say): followed now, its start - with the
    # answer so far - comes as the first event after the hello.
    follow(cid)

    async def events():
        try:
            yield _sse({"type": "hello", "live": HUB.snapshot(key), "watchers": HUB.watchers(key),
                        "queue": queue_event(doc)})
            opened = time.monotonic()
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), LIVE_PING)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        return
                    if time.monotonic() - opened > LIVE_MAX and not HUB.busy(key):
                        yield _sse({"type": "bye"})
                        return
                    yield b": ping\n\n"
                    continue
                if ev is None:                         # let go: too slow
                    yield _sse({"type": "bye", "why": "behind"})
                    return
                yield _sse(ev)
        finally:
            HUB.unsubscribe(key, q)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- following an answer a runner is writing (backend/ccgen.py) --------------

TAIL = 0.2                       # seconds between looks at the answer being written
BUSY = "an answer is being written in this conversation - wait for it, or stop it"
_TASKS: set[asyncio.Task] = set()  # the title waits, held so they are not collected


def follow(cid: str) -> None:
    """Follow the answer being written in this conversation, if there is
    one, for everyone watching it: one task per conversation in this
    process, which reads the generation every TAIL seconds and hands the
    new pieces to the hub. Called when a page starts watching and when an
    answer is started; a task already following is poked instead, so one
    about to stop looks once more."""
    key = live_key(cid)
    t = HUB.tails.get(key)
    if t is not None and not t.done():
        HUB.poked.add(key)
        return
    HUB.tails[key] = asyncio.ensure_future(_tail(key, cid, _db()))


async def _tail(key: str, cid: str, db) -> None:
    me = asyncio.current_task()
    gid: str | None = None
    grace = 0.0                  # after an answer: a moment to see the queued line's answer start
    try:
        while True:
            if gid is None:
                HUB.poked.discard(key)
                chat = await db[COLL].find_one({"_id": cid})
                gen = await ccgen.get(db, chat["gen"]) if chat and chat.get("gen") else None
                if gen is None or gen.get("status") != "running":
                    if key in HUB.poked:
                        continue
                    if time.monotonic() < grace and (chat or {}).get("queue") and not chat.get("queue_paused"):
                        await asyncio.sleep(TAIL)
                        continue
                    return
                gid = gen["_id"]
                if gid not in (HUB.live.get(key) or {}):
                    # From where it got: a page that came late, or after a
                    # reload, gets the answer so far in the start.
                    HUB.begin(key, ccgen.state(gen))
                    if chat.get("queue") is not None or chat.get("queue_rev"):
                        HUB.publish(key, queue_event(chat))     # a waiting line may have just gone
            else:
                await asyncio.sleep(TAIL)
                gen = await ccgen.get(db, gid)
            if gen is None:
                HUB.end(key, gid, {"type": "error", "error": "the answer went missing"})
                gid = None
                continue
            if ccgen.dead(gen):
                gen = await ccgen.lose(db, gen, ccgen.GONE)
            st = (HUB.live.get(key) or {}).get(gid) or {}
            if st and not st.get("first_at") and gen.get("first_at"):
                # When the first token came, on the server's clock: the
                # pages watching work out the time to it without their own.
                now = ccgen.state(gen)
                st["first_at"] = now["first_at"]
                HUB.publish(key, {"type": "timing", "gen": gid, "started_at": now["started_at"], "first_at": now["first_at"]})
            for kind in ("thinking", "text"):
                have, got = len(st.get(kind) or ""), gen.get(kind) or ""
                if len(got) > have:
                    HUB.piece(key, gid, kind, got[have:])
            if st is not None and (gen.get("steps") or []) != (st.get("steps") or []):
                # The tools the model used, as they run (backend/chat_tools):
                # the whole list each time - a few short rows.
                st["steps"] = gen.get("steps") or []
                HUB.publish(key, {"type": "steps", "gen": gid, "steps": st["steps"]})
            if gen.get("status") == "running":
                continue
            answer = gen.get("answer") or ccgen.partial(gen)
            if gen.get("status") == "failed":
                HUB.publish(key, {"type": "error", "gen": gid, "error": answer.get("error")})
            # Kept by now (ccgen.finish), so a page that reads the
            # conversation then finds the answer in it.
            HUB.end(key, gid, {"type": "done", "message": public(answer)})
            after = await db[COLL].find_one({"_id": cid})
            if (after or {}).get("queue_rev"):                # a queue was ever used here: how it stands now
                grace = time.monotonic() + 8.0
                HUB.publish(key, queue_event(after))
            if gen.get("naming"):
                task = asyncio.ensure_future(_titled(key, gid, db))
                _TASKS.add(task)
                task.add_done_callback(_TASKS.discard)
            else:
                if gen.get("title"):                   # named before this looked
                    HUB.publish(key, {"type": "title", "gen": gid, "title": gen["title"]})
                HUB.publish(key, {"type": "named", "gen": gid})
            gid = None
    finally:
        if HUB.tails.get(key) is me:
            HUB.tails.pop(key, None)


async def _titled(key: str, gid: str, db) -> None:
    """The title the runner names the conversation with, once it has."""
    until = time.monotonic() + TITLE_TIMEOUT + 10
    title = None
    while time.monotonic() < until:
        await asyncio.sleep(TAIL)
        gen = await ccgen.get(db, gid)
        if not gen or not gen.get("naming"):
            title = (gen or {}).get("title")
            break
    if title:
        HUB.publish(key, {"type": "title", "gen": gid, "title": title})
    HUB.publish(key, {"type": "named", "gen": gid})


async def _claim(db, doc: dict) -> dict:
    """The conversation, free to answer in: 409 while an answer is being
    written in it. A lock left by a runner that died is let go first, its
    answer so far kept - so the conversation is read again then."""
    if not doc.get("gen"):
        return doc
    if not await ccgen.free(db, doc):
        raise HTTPException(409, BUSY)
    return await _load(doc["_id"])


async def _begin(db, cid: str, gen: dict, first: dict) -> StreamingResponse:
    """Start the runner of `gen` (which holds the lock) and follow it.
    The answer streams back as everyone watching gets it (`HUB`): the first
    event ({type: user, message, keep, gen}: the conversation is its first
    `keep` lines, then `message` if any), then thinking|text|error, done,
    and a title when the conversation was named by this answer. Closing
    this stream stops nothing: the answer is written all the same, and the
    page that comes back follows it on GET /chats/{id}/live."""
    key = live_key(cid)
    gid = gen["_id"]
    q = HUB.subscribe(key)                             # before it starts: nothing is missed
    try:
        await ccgen.launch(db, gen)
    except OSError as exc:
        HUB.unsubscribe(key, q)
        raise HTTPException(500, f"the answer could not be started: {exc}")
    follow(cid)
    first = dict(first)
    if first.get("message"):
        first["message"] = public(first["message"])
    first["gen"] = gid
    titled = bool(gen.get("want_title"))

    async def events():
        try:
            yield _sse(first)
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), LIVE_PING)
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
                    continue
                if ev is None:                         # let go: the page follows on /live
                    return
                if ev.get("gen") != gid:
                    continue
                kind = ev.get("type")
                if kind == "start":
                    for k in ("thinking", "text"):     # what was written before this one looked
                        if ev.get(k):
                            yield _sse({"type": k, "text": ev[k]})
                    if ev.get("steps"):
                        yield _sse({"type": "steps", "steps": ev["steps"]})
                elif kind == "steps":
                    yield _sse({"type": "steps", "steps": ev.get("steps") or []})
                elif kind in ("thinking", "text"):
                    yield _sse({"type": kind, "text": ev.get("text") or ""})
                elif kind == "error":
                    yield _sse({"type": "error", "error": ev.get("error")})
                elif kind == "done":
                    yield _sse({"type": "done", "message": ev.get("message")})
                elif kind == "title":
                    yield _sse({"type": "title", "title": ev.get("title")})
                elif kind == "named" or (kind == "end" and not titled):
                    return
        finally:
            HUB.unsubscribe(key, q)

    # X-Accel-Buffering: nginx (NPM) would otherwise hold the stream back
    # and hand it over in one piece at the end.
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/chats/{cid}/stop")
async def stop(cid: str) -> dict:
    """Stop the answer being written: whoever asked for it, or anyone with
    the "delete" right. It is kept as far as it got, marked stopped."""
    db = _db()
    doc = await _load(cid)
    gid = doc.get("gen")
    gen = await ccgen.get(db, gid) if gid else None
    if not gen or gen.get("status") != "running":
        await ccgen.free(db, doc)
        return {"stopped": False, "running": False}
    who = actors.current() or {}
    if (gen.get("by") or {}).get("id") != who.get("id") and not _can_delete():
        raise HTTPException(403, "only whoever asked can stop this answer - "
                            + access.refusal(access.current() or "nobody", "delete"))
    await ccgen.request_stop(db, gen, {"id": who.get("id"), "name": who.get("name")})
    follow(cid)
    return {"stopped": True, "gen": gid}


# ---- the tools the models may use (backend/chat_tools) ------------------------

@router.get("/tools")
async def list_tools() -> dict:
    """Every chat tool, and whether it is on for whoever asks (their own
    choice, else the tool's default)."""
    from . import chat_tools
    me = (actors.current() or {}).get("id")
    uses = {d["_id"]: d["n"] async for d in _db()[COLL].aggregate([
        {"$match": {**LIVE, "messages.steps.0": {"$exists": True}}},
        {"$unwind": "$messages"}, {"$unwind": "$messages.steps"},
        {"$group": {"_id": "$messages.steps.tool", "n": {"$sum": 1}}}])}
    return {"tools": [{**t, "uses": uses.get(t["name"], 0)}
                      for t in chat_tools.chosen(await chat_tools.prefs(_db(), me))]}


class ToolsIn(BaseModel):
    tools: dict[str, bool]


@router.put("/tools")
async def set_tools(body: ToolsIn) -> dict:
    """Turn chat tools on or off for oneself: they go to the model with
    one's own lines, on every device."""
    from . import chat_tools
    me = (actors.current() or {}).get("id")
    if not me:
        raise HTTPException(400, "tools are chosen per account - sign in")
    try:
        mine = await chat_tools.save(_db(), me, body.tools)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"tools": chat_tools.chosen(mine)}


STATS_DAYS = 14                  # the day bars on a tool's page
STATS_RECENT = 8                 # its latest uses listed there


@router.get("/tools-usage")
async def tools_usage() -> dict:
    """Every tool's uses in this workspace's conversations, for the top of
    the Tools view: totals, how many worked, and the last STATS_DAYS days
    by tool."""
    from . import chat_tools
    me = (actors.current() or {}).get("id")
    now = datetime.now(timezone.utc)
    day0 = (now - timedelta(days=STATS_DAYS - 1)).date()
    names = list(chat_tools.tools())
    days = {(day0 + timedelta(days=i)).isoformat(): {} for i in range(STATS_DAYS)}
    per = {n: {"uses": 0, "done": 0, "week": 0} for n in names}
    mine = 0
    async for doc in _db()[COLL].find(dict(LIVE), {"messages.role": 1, "messages.by": 1, "messages.steps": 1}):
        asker: dict = {}
        for m in doc.get("messages") or []:
            if m.get("role") == "user":
                asker = m.get("by") or {}
                continue
            for st in m.get("steps") or []:
                n = st.get("tool")
                if n not in per:
                    continue
                per[n]["uses"] += 1
                per[n]["done"] += (st.get("status") or "done") == "done"
                if me and asker.get("id") == me:
                    mine += 1
                at = str(st.get("at") or "")
                if at[:10] in days:
                    days[at[:10]][n] = days[at[:10]].get(n, 0) + 1
                try:
                    per[n]["week"] += now - datetime.fromisoformat(at.replace("Z", "+00:00")) <= timedelta(days=7)
                except ValueError:
                    pass
    return {"tools": per, "mine": mine, "days": [{"day": d, "by": by} for d, by in days.items()]}


@router.get("/tools/{name}")
async def tool_page(name: str) -> dict:
    """One tool, for its page in the Tools view: what the model is told
    about it and what it takes, and how it has been used in this
    workspace's conversations - counts, outcomes, time taken, by day, by
    whom, and its latest uses with where they were."""
    from . import chat_tools
    tool = chat_tools.tools().get(name)
    if tool is None:
        raise HTTPException(404, f"no tool {name!r}")
    me = (actors.current() or {}).get("id")
    mine = await chat_tools.prefs(_db(), me)
    props = (tool.schema or {}).get("properties") or {}
    need = set((tool.schema or {}).get("required") or [])
    out = {**tool.public(), "on": mine.get(name, tool.default), "model_text": tool.description,
           "running": tool.running, "failed": tool.failed,
           "params": [{"name": k, "type": v.get("type") or "", "about": v.get("description") or "", "required": k in need}
                      for k, v in props.items()]}

    now = datetime.now(timezone.utc)
    day0 = (now - timedelta(days=STATS_DAYS - 1)).date()
    days = {(day0 + timedelta(days=i)).isoformat(): [0, 0] for i in range(STATS_DAYS)}
    uses, outcomes, people, chats, times, recent = 0, {}, {}, set(), [], []
    week = mine_n = 0
    cur = _db()[COLL].find(dict(LIVE), {"title": 1, "messages.role": 1, "messages.by": 1, "messages.steps": 1})
    async for doc in cur:
        asker: dict = {}
        for m in doc.get("messages") or []:
            if m.get("role") == "user":
                asker = m.get("by") or {}
                continue
            for st in m.get("steps") or []:
                if st.get("tool") != name:
                    continue
                uses += 1
                chats.add(doc["_id"])
                status = st.get("status") or "done"
                outcomes[status] = outcomes.get(status, 0) + 1
                who = asker.get("name") or "someone"
                people[who] = people.get(who, 0) + 1
                if me and asker.get("id") == me:
                    mine_n += 1
                if isinstance(st.get("ms"), (int, float)) and status == "done":
                    times.append(st["ms"])
                at = str(st.get("at") or "")
                if at[:10] in days:
                    days[at[:10]][0 if status == "done" else 1] += 1
                try:
                    if now - datetime.fromisoformat(at.replace("Z", "+00:00")) <= timedelta(days=7):
                        week += 1
                except ValueError:
                    pass
                recent.append({"at": at, "chat": doc["_id"], "title": doc.get("title") or "", "say": st.get("say") or "",
                               "vars": st.get("vars") or {}, "status": status, "ms": st.get("ms"), "by": who})
    times.sort()
    recent.sort(key=lambda r: r["at"], reverse=True)
    out["stats"] = {
        "uses": uses, "week": week, "mine": mine_n, "chats": len(chats),
        "outcomes": outcomes,
        "ms": {"median": times[len(times) // 2] if times else None,
               "p90": times[min(len(times) - 1, int(len(times) * .9))] if times else None},
        "last": recent[0]["at"] if recent else None,
        "days": [{"day": d, "n": ok + bad, "bad": bad} for d, (ok, bad) in days.items()],
        "people": sorted(({"name": k, "n": v} for k, v in people.items()), key=lambda x: -x["n"])[:6],
        "recent": recent[:STATS_RECENT],
    }
    return out


class StepIn(BaseModel):
    allow: bool


@router.post("/chats/{cid}/steps/{sid}")
async def answer_step(cid: str, sid: str, body: StepIn) -> dict:
    """Allow or refuse a tool that asks first (a delete-level one): whoever
    asked for the answer, or anyone who may delete."""
    db = _db()
    doc = await _load(cid)
    gen = await ccgen.get(db, doc["gen"]) if doc.get("gen") else None
    if not gen or gen.get("status") != "running":
        raise HTTPException(409, "no answer is being written here")
    who = actors.current() or {}
    if (gen.get("by") or {}).get("id") != who.get("id") and not _can_delete():
        raise HTTPException(403, "only whoever asked can answer this - "
                            + access.refusal(access.current() or "nobody", "delete"))
    if not await ccgen.answer_step(db, gen, sid, body.allow, {"id": who.get("id"), "name": who.get("name")}):
        raise HTTPException(409, "that step is not waiting for an answer")
    return {"ok": True, "allow": body.allow}


async def _name(db, cid: str, msgs: list[dict], answer: dict) -> str | None:
    """Name the conversation after its first line, if nobody has yet."""
    first = next((m.get("content") or "" for m in msgs if m["role"] == "user"), "")
    if not first:
        return None
    title, used = await make_title(first, "" if answer.get("error") else answer.get("content") or "")
    # Only over the default: someone may have renamed it meanwhile.
    res = await db[COLL].update_one({"_id": cid, "title": {"$in": ["", DEFAULT_TITLE]}},
                                    {"$set": {"title": title}})
    if used:
        await llm.record(db, provider=used.pop("provider"), model=used.pop("model"),
                         surface="chat", kind="cc-title", used=used)
    return title if getattr(res, "matched_count", 1) else None


async def _line(db, msgs: list[dict], text: str, mentions: list, provider: str, model: str) -> tuple[dict, list[dict]]:
    """A line as it will be kept: who wrote it, and the context its
    mentions were read into (through this workspace, as this person)."""
    who = actors.current()
    mine = {"id": _mid(), "role": "user", "content": text, "at": _now(),
            "by": {"id": who.get("id"), "name": who.get("name"), "type": who.get("type")}}
    pics: list[dict] = []
    if mentions:
        # Read now, through this workspace: what cannot be seen is refused.
        context, chips, pics = await cc_context.expand(db, [m.model_dump() for m in mentions],
                                                       await _vision(provider, model))
        if context:
            held = sum(len(m.get("context") or "") for m in msgs)
            if held + len(context) > CHAT_CONTEXT:
                raise HTTPException(400, "this conversation holds too much mentioned context already - "
                                         "start a new one")
            mine.update({"context": context, "mentions": chips})
            if pics:
                mine["attach"] = pics
    return mine, pics


@router.post("/chats/{cid}/messages")
async def say(cid: str, body: SayIn):
    """Add a line (or, with `edit`, replace one's own line and drop what
    followed it) and have it answered: the answer is written by a runner of
    its own (backend/ccgen.py), and streamed here as it is written - events
    {type: user|thinking|text|done|error|title}. One answer at a time in a
    conversation: a new line while one is being written is queued instead
    (202, {queued, queue, paused}) and sent when it ends; an edit then is
    refused (409)."""
    db = _db()
    doc = await _load(cid)
    provider, model = _pick(doc, body.provider, body.model)
    if body.edit is None and doc.get("gen") and not await ccgen.free(db, doc):
        return await _enqueue(db, cid, body, provider, model)
    doc = await _claim(db, doc)
    msgs = doc.get("messages") or []
    provider, model = _pick(doc, body.provider, body.model)
    who = actors.current()
    mine, pics = await _line(db, msgs, body.text, body.mentions, provider, model)
    sets: dict = {"updated_at": mine["at"], "provider": provider, "model": model}

    if body.edit is not None:
        i = find(msgs, body.edit)
        if i < 0:
            raise HTTPException(404, f"no line {body.edit!r} in this conversation")
        if msgs[i]["role"] != "user" or (msgs[i].get("by") or {}).get("id") != who.get("id"):
            raise HTTPException(403, "only your own line can be edited")
        if not may_drop(msgs, list(range(i + 1, len(msgs))), who.get("id"), _can_delete()):
            raise HTTPException(403, "someone else wrote after this line - "
                                + access.refusal(access.current() or "nobody", "delete"))
        mine["edited_at"] = mine["at"]
        mine["at"] = msgs[i].get("at") or mine["at"]
        keep = i
    else:
        if len(msgs) >= MAX_MESSAGES:
            raise HTTPException(400, f"this conversation has {MAX_MESSAGES} lines; start a new one")
        keep = len(msgs)
    gen = await ccgen.new(db, cid, keep=keep, upto=keep + 1, question=mine["id"], message=public(mine),
                          provider=provider, model=model, client=body.client, images=bool(pics),
                          want_title=doc.get("title") in ("", DEFAULT_TITLE, None))
    try:
        if body.edit is not None:
            await _cut(db, cid, msgs, keep, [mine], {**sets, "gen": gen["_id"]})
        else:
            # The line and the lock in one write: a second line while an
            # answer is being written is queued, not a second answer.
            res = await db[COLL].update_one({"_id": cid, "gen": None},
                                            {"$push": {"messages": mine}, "$set": {**sets, "gen": gen["_id"]}})
            if not getattr(res, "matched_count", 1):
                await ccgen.drop(db, gen)
                return await _enqueue(db, cid, body, provider, model)
    except HTTPException:
        await ccgen.drop(db, gen)
        raise
    return await _begin(db, cid, gen, {"type": "user", "message": mine, "keep": keep})


# ---- the queue: lines sent while an answer is being written -----------------

def queue_event(doc: dict | None) -> dict:
    q = queue_public((doc or {}).get("queue"))
    return {"type": "queue", "queue": q, "paused": bool((doc or {}).get("queue_paused")) and bool(q),
            "why": (doc or {}).get("queue_why")}


async def _publish_queue(db, cid: str) -> dict:
    ev = queue_event(await db[COLL].find_one({"_id": cid}))
    HUB.publish(live_key(cid), ev)
    return ev


async def _requeue(db, cid: str, change) -> dict:
    """Change the queue in one write, against the version read: `change`
    gets the queue and the conversation and gives the new queue (and may
    raise). Tried again when someone else changed it meanwhile."""
    for _ in range(8):
        doc = await _load(cid)
        q = list(doc.get("queue") or [])
        new, extra = change(q, doc)
        sets = {"queue": new, "queue_rev": (doc.get("queue_rev") or 0) + 1, **extra}
        if not new:
            sets.update({"queue_paused": False, "queue_why": None})
        res = await db[COLL].update_one({"_id": cid, "queue_rev": doc.get("queue_rev")}, {"$set": sets})
        if getattr(res, "matched_count", 1):
            return doc
    raise HTTPException(409, "the queue changed meanwhile - try again")


async def _enqueue(db, cid: str, body: SayIn, provider: str, model: str) -> JSONResponse:
    """The line waits for the answer being written - read now, as the one
    who queued it, and sent as they would have sent it."""
    doc = await _load(cid)
    if len(doc.get("queue") or []) >= MAX_QUEUE:
        raise HTTPException(409, f"{MAX_QUEUE} lines are waiting already - wait for the answer, or remove one")
    if len(doc.get("messages") or []) + len(doc.get("queue") or []) >= MAX_MESSAGES:
        raise HTTPException(400, f"this conversation has {MAX_MESSAGES} lines; start a new one")
    mine, pics = await _line(db, doc.get("messages") or [], body.text, body.mentions, provider, model)
    item = {**mine, "provider": provider, "model": model, "client": body.client, "images": bool(pics),
            "actor": actors.current(), "asker_role": access.current()}

    def add(q, _doc):
        if len(q) >= MAX_QUEUE:
            raise HTTPException(409, f"{MAX_QUEUE} lines are waiting already - wait for the answer, or remove one")
        return q + [item], {}
    await _requeue(db, cid, add)
    # The answer may have ended while this was written down: then it goes now.
    await kick(db, cid)
    ev = await _publish_queue(db, cid)
    return JSONResponse({"queued": queue_public([item])[0], "queue": ev["queue"], "paused": ev["paused"]},
                        status_code=202)


async def send_next(db, cid: str) -> dict | None:
    """The first line waiting, sent - as a line of the conversation with
    its answer started (a runner of its own), as whoever queued it would
    have sent it. Only while nothing is being written and the queue is not
    paused. Called by the runner when an answer ends (backend/ccgen.py),
    and here when the queue is let go again. The generation, or None."""
    doc = await db[COLL].find_one({"_id": cid, **LIVE})
    if not doc or doc.get("gen") or doc.get("queue_paused") or not doc.get("queue"):
        return None
    q = list(doc["queue"])
    item = q[0]
    msgs = doc.get("messages") or []
    if len(msgs) >= MAX_MESSAGES:
        await pause(db, cid, "full")
        return None
    mine = {k: item[k] for k in ("id", "role", "content", "by", "context", "mentions", "attach") if k in item}
    mine["at"] = _now()
    gen = await ccgen.new(db, cid, keep=len(msgs), upto=len(msgs) + 1, question=mine["id"], message=public(mine),
                          provider=item.get("provider") or doc.get("provider"), model=item.get("model") or doc.get("model"),
                          client=item.get("client"), images=bool(item.get("images")),
                          want_title=doc.get("title") in ("", DEFAULT_TITLE, None) and not msgs,
                          actor=item.get("actor"), role=item.get("asker_role"))
    res = await db[COLL].update_one(
        {"_id": cid, "gen": None, "queue_rev": doc.get("queue_rev")},
        {"$push": {"messages": mine},
         "$set": {"updated_at": mine["at"], "provider": gen["provider"], "model": gen["model"], "gen": gen["_id"],
                  "queue": q[1:], "queue_rev": (doc.get("queue_rev") or 0) + 1}})
    if not getattr(res, "matched_count", 1):
        await ccgen.drop(db, gen)
        return None
    try:
        await ccgen.launch(db, gen)
    except OSError:
        return None
    return gen


async def kick(db, cid: str) -> dict | None:
    """In the API: the next line waiting, if the conversation is free; and
    followed for everyone watching."""
    doc = await db[COLL].find_one({"_id": cid})
    if doc and doc.get("gen") and not await ccgen.free(db, doc):
        return None
    gen = await send_next(db, cid)
    if gen:
        follow(cid)
    return gen


async def pause(db, cid: str, why: str) -> None:
    """The answer did not end well (stopped, failed, interrupted): what is
    waiting waits for someone to say go on."""
    doc = await db[COLL].find_one({"_id": cid})
    if doc and doc.get("queue"):
        await db[COLL].update_one({"_id": cid}, {"$set": {"queue_paused": True, "queue_why": why}})


def _may_touch(item: dict) -> bool:
    who = actors.current() or {}
    return (item.get("by") or {}).get("id") == who.get("id") or _can_delete()


def _refuse_touch():
    raise HTTPException(403, "only whoever queued it can change this line - "
                        + access.refusal(access.current() or "nobody", "delete"))


class QueueEdit(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)


@router.patch("/chats/{cid}/queue/{qid}")
async def queue_edit(cid: str, qid: str, body: QueueEdit) -> dict:
    """A line waiting, written again before it is sent."""
    db = _db()

    def change(q, _doc):
        it = next((x for x in q if x.get("id") == qid), None)
        if it is None:
            raise HTTPException(404, "that line is not waiting any more")
        if not _may_touch(it):
            _refuse_touch()
        return [{**x, "content": body.text, "edited_at": _now()} if x.get("id") == qid else x for x in q], {}
    await _requeue(db, cid, change)
    return await _publish_queue(db, cid)


@router.delete("/chats/{cid}/queue/{qid}")
async def queue_remove(cid: str, qid: str) -> dict:
    """A line waiting, not sent after all."""
    db = _db()

    def change(q, _doc):
        it = next((x for x in q if x.get("id") == qid), None)
        if it is None:
            raise HTTPException(404, "that line is not waiting any more")
        if not _may_touch(it):
            _refuse_touch()
        return [x for x in q if x.get("id") != qid], {}
    await _requeue(db, cid, change)
    return await _publish_queue(db, cid)


@router.post("/chats/{cid}/queue/clear")
async def queue_clear(cid: str) -> dict:
    """Every waiting line this person may remove, removed."""
    db = _db()
    await _requeue(db, cid, lambda q, _doc: ([x for x in q if not _may_touch(x)], {}))
    return await _publish_queue(db, cid)


@router.post("/chats/{cid}/queue/resume")
async def queue_resume(cid: str) -> dict:
    """A paused queue goes on: the first line is sent now, if nothing is
    being written."""
    db = _db()
    await _load(cid)
    await db[COLL].update_one({"_id": cid}, {"$set": {"queue_paused": False, "queue_why": None}})
    gen = await kick(db, cid)
    ev = await _publish_queue(db, cid)
    return {**ev, "sent": bool(gen), "gen": gen["_id"] if gen else None}


@router.post("/chats/{cid}/regenerate")
async def regenerate(cid: str, body: RegenIn | None = None):
    """Answer the last question again - with the conversation's model, or
    another one, which the conversation then keeps. The answers after the
    last question go; someone else's only with the "delete" right."""
    body = body or RegenIn()
    db = _db()
    doc = await _claim(db, await _load(cid))
    msgs = doc.get("messages") or []
    keep = regen_cut(msgs)
    if keep < 0:
        raise HTTPException(400, "nothing to answer yet")
    provider, model = _pick(doc, body.provider, body.model)
    if not may_drop(msgs, list(range(keep, len(msgs))), actors.current().get("id"), _can_delete()):
        raise HTTPException(403, access.refusal(access.current() or "nobody", "delete"))
    # The question's pictures go again, if this model reads them.
    pics = msgs[keep - 1].get("attach") or []
    gen = await ccgen.new(db, cid, keep=keep, upto=keep, question=msgs[keep - 1].get("id"), message=None,
                          provider=provider, model=model, client=body.client,
                          images=bool(pics) and await _vision(provider, model),
                          want_title=doc.get("title") in ("", DEFAULT_TITLE, None))
    try:
        if keep < len(msgs) or body.provider or body.model:
            await _cut(db, cid, msgs, keep, [], {"updated_at": _now(), "provider": provider, "model": model,
                                                 "gen": gen["_id"]})
        else:
            res = await db[COLL].update_one({"_id": cid, "gen": None}, {"$set": {"gen": gen["_id"]}})
            if not getattr(res, "matched_count", 1):
                raise HTTPException(409, BUSY)
    except HTTPException:
        await ccgen.drop(db, gen)
        raise
    return await _begin(db, cid, gen, {"type": "user", "message": None, "keep": keep})


async def _vision(provider: str, model: str) -> bool:
    """Whether the model reads images: its row in the provider's list, else
    its name (backend/llm.py `vision`)."""
    try:
        for m in await llm.models(provider):
            if m["id"] == model:
                return bool(m["vision"]) if "vision" in m else llm.vision(m)
    except Exception:                                  # noqa: BLE001 - the list is a nicety
        pass
    return llm.vision({"id": model})
