"""What happened, told to the people who asked to hear about it.

The things worth a message are written by many hands - the API, the
agents' command line (tools/revisions.py writes to the database
directly), the budget loop - so rather than hook every one of them, this
watches the database: every few seconds it looks for what is new since it
last looked, in

    questions        an agent asked                      -> "question"
    revisions        a note was applied                  -> "note"
    runs / audit     a note's run failed, or was rejected -> "note"
    runs             a run started                       -> "run"
    budget_alerts    a budget crossed its line           -> "budget"
    compute_jobs     a build, layout or convert failed    -> "build"
    cc_usage_alerts  Command Code's weekly window at 90%  -> "ccusage"
                     or used up (owner and admins only)

Each event is announced once: its key goes into `telegram_events` (a
unique _id) before anything is sent, so two processes, a reload, or the
small overlap kept between looks never send it twice. The first look after
a bot is set up starts from now - nothing from before is announced.

It also closes question cards: once a question is answered anywhere (the
app, Telegram, the command line) or withdrawn, every card it was sent as is
edited to show the answer, and its buttons go.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from .. import questions, scope
from . import core, fmt, languages, links, outbox

log = logging.getLogger("redline.telegram")

EVERY_S = 4
OVERLAP = timedelta(seconds=90)
DIGEST_HOUR_UTC = 6                 # 09:00 in Istanbul
WATCHED = ("question", "applied", "failed", "rejected", "run", "budget", "build", "ccusage")
BUILD_KINDS = ["build", "layout", "convert", "run"]


async def announce(db, key: str) -> bool:
    """True the first time a key is seen; False ever after (for two weeks)."""
    from pymongo.errors import DuplicateKeyError
    try:
        await core.raw_of(db)[core.EVENTS].insert_one({"_id": key, "at": core.now()})
        return True
    except DuplicateKeyError:
        return False


def _ws(doc: dict) -> str:
    return doc.get("workspace_id") or scope.DEFAULT


def _id(doc: dict, field: str = "_id"):
    """A name as the code knows it: without its workspace's suffix."""
    return scope.Ids(_ws(doc)).out(doc.get(field))


async def _base(raw) -> str | None:
    return (await core.settings(raw)).get("public_url")


async def _title(sdb, model: str | None, kind: str | None) -> str | None:
    if not model:
        return None
    coll = sdb.boards if kind == "pcb" else sdb.models
    doc = await coll.find_one({"_id": model}, {"title": 1, "name": 1}) or {}
    return doc.get("title") or doc.get("name") or model


# ---------------- questions ----------------

_tr_cache: dict = {}


async def translated(raw, ws: str, q: dict, lang: str | None) -> dict | None:
    """The question in the reader's language (backend/reading.py, kept on the
    question), or None for the original - also when it cannot be had."""
    if not lang:
        return None
    key = (ws, q["_id"], lang)
    if key in _tr_cache:
        return _tr_cache[key]
    from .. import reading
    try:
        # By its English name: the job is asked for a language, not a code,
        # and the app's own reading translation keeps it under the same name.
        got = await reading.translate_doc(scope.ScopedDb(raw, ws), "questions", q["_id"], languages.english(lang),
                                          ("text", "context", "options"), "reading:question")
        out = None if got.get("original") else {"text": got.get("text"), "context": got.get("context"),
                                                 "options": got.get("options") or []}
    except Exception as exc:                            # noqa: BLE001 - the original will do
        log.info("telegram: question %s not translated to %s: %s", q["_id"], lang, core.redact(exc))
        out = None
    if len(_tr_cache) > 500:
        _tr_cache.clear()
    _tr_cache[key] = out
    return out


async def send_question(raw, ws: str, q: dict) -> int:
    """The question to everyone in its workspace who wants questions. Those
    who may answer get the options as buttons and "reply in your own
    words"; a viewer gets the card without them."""
    base = await _base(raw)
    try:                                                # which room's thread it waits in
        q = (await questions.with_rooms(scope.ScopedDb(raw, ws), [dict(q)]))[0]
    except Exception:                                   # noqa: BLE001 - the link goes to the 3D room's
        pass
    n = 0
    for link, role in await links.recipients(raw, ws, "question"):
        shown = await translated(raw, ws, q, link.get("lang"))
        can = links.can(role, "draw")
        text = fmt.question_text(link, q, shown, base, can, role)
        markup = fmt.question_markup(link, q, shown) if can else None
        await outbox.enqueue(raw, link["chat"], text=text, kind="question", user=link["_id"], ws=ws,
                             markup=markup,
                             track={"kind": "question", "question": q["_id"], "multi": bool(q.get("multi")),
                                    "options": (shown or q).get("options") or [], "picked": []})
        n += 1
    return n


async def sync_questions(raw) -> int:
    """Close the cards of questions that are no longer open. Returns how
    many cards were edited."""
    raw = core.raw_of(raw)
    groups: dict = {}
    async for m in raw[core.MSGS].find({"kind": {"$in": ["question", "prompt"]}, "state": "open"}):
        groups.setdefault((m.get("ws") or scope.DEFAULT, m["question"]), []).append(m)
    edited = 0
    for (ws, qid), msgs in groups.items():
        q = await scope.ScopedDb(raw, ws).questions.find_one({"_id": qid})
        if q and q.get("status") == "open":
            continue
        q = q or {"status": "dropped"}
        for m in msgs:
            await raw[core.MSGS].update_one({"_id": m["_id"]}, {"$set": {"state": "closed", "closed_at": core.now()}})
            if m["kind"] != "question":
                continue
            link = await links.by_chat(raw, m["chat"])
            await outbox.enqueue(raw, m["chat"], op="edit", message_id=m["message_id"], is_photo=bool(m.get("photo")),
                                 text=fmt.question_closed(link, m.get("text") or "", q), kind="question-closed",
                                 user=m.get("user"), ws=ws, markup=None)
            edited += 1
    return edited


# ---------------- notes, runs, budgets, builds ----------------

async def note_out(raw, ws: str, rev: dict, ok: bool) -> int:
    sdb = scope.ScopedDb(raw, ws)
    base = await _base(raw)
    title = await _title(sdb, rev.get("model"), rev.get("kind"))
    which = "after" if ok and rev.get("image_after") else ("before" if rev.get("image") else None)
    n = 0
    for link, _role in await links.recipients(raw, ws, "note"):
        await outbox.enqueue(raw, link["chat"], text=fmt.note_event(link, rev, ok, base, title),
                             kind="note-applied" if ok else "note-failed", user=link["_id"], ws=ws,
                             photo={"revision": rev["_id"], "which": which} if which else None)
        n += 1
    return n


async def _each(raw, ws: str, pref: str, kind: str, make) -> int:
    base = await _base(raw)
    n = 0
    for link, _role in await links.recipients(raw, ws, pref):
        await outbox.enqueue(raw, link["chat"], text=make(link, base), kind=kind, user=link["_id"], ws=ws)
        n += 1
    return n


async def tick(raw=None, now=None) -> int:
    """One look. Returns how many events were announced."""
    raw = core.raw_of(raw) if raw is not None else core.raw()
    st = await core.settings(raw)
    if not core.token_of(st):
        return 0
    t = now or core.now()
    wm = st.get("watch") or {}
    if not wm:
        await core.patch_settings(raw, {"watch": {k: t for k in WATCHED}})
        return 0

    def since(k):
        v = core.aware(wm.get(k)) or t
        return v - OVERLAP

    n = 0
    # an agent asked
    async for q in raw.questions.find({"status": "open", "at": {"$gt": core.iso(since("question"))}}):
        ws, qid = _ws(q), _id(q)
        if await announce(raw, f"q:{ws}:{qid}"):
            await send_question(raw, ws, {**q, "_id": qid})
            n += 1
    # a note was applied
    async for r in raw.revisions.find({"status": "applied", "applied_at": {"$gt": core.iso(since("applied"))}}):
        ws, rid = _ws(r), _id(r)
        if await announce(raw, f"a:{ws}:{rid}"):
            await note_out(raw, ws, {**r, "_id": rid}, ok=True)
            n += 1
    # a note's run failed
    async for run in raw.runs.find({"status": "failed", "finished_at": {"$gt": core.iso(since("failed"))}}):
        rid = run.get("revision")
        if not rid:
            continue
        ws = _ws(run)
        if await announce(raw, f"f:{ws}:{rid}:{run.get('finished_at')}"):
            rev = await scope.ScopedDb(raw, ws).revisions.find_one({"_id": rid})
            if rev:
                await note_out(raw, ws, rev, ok=False)
                n += 1
    # a note was rejected (the status change is in the audit trail)
    async for a in raw.audit.find({"at": {"$gt": since("rejected")}, "action": "change",
                                   "target": {"$regex": r"^/api/revisions/[^/]+$"}}):
        if "status=rejected" not in str(((a.get("detail") or {}).get("query")) or ""):
            continue
        ws, rid = _ws(a), a["target"].rsplit("/", 1)[1]
        if await announce(raw, f"f:{ws}:{rid}:rejected"):
            rev = await scope.ScopedDb(raw, ws).revisions.find_one({"_id": rid})
            if rev:
                await note_out(raw, ws, rev, ok=False)
                n += 1
    # a run started
    async for run in raw.runs.find({"status": "running", "started_at": {"$gt": core.iso(since("run"))}}):
        ws = _ws(run)
        if await announce(raw, f"r:{ws}:{run.get('revision') or _id(run)}:{run.get('started_at')}"):
            n += 1
            await _each(raw, ws, "run", "run-started", lambda link, base, run=run: fmt.run_event(link, run, base))
    # a budget crossed its line
    from .. import budgets
    async for al in raw[budgets.ALERTS].find({"at": {"$gt": since("budget")}}):
        ws = _ws(al)
        if await announce(raw, f"b:{al['_id']}"):
            name = budgets.NAMES.get(al.get("kind"), al.get("kind"))
            pct = round((al.get("ratio") or 0) * 100)
            text = (f"{name} is {'over' if al.get('level') == 'over' else 'at'} {pct}% of its budget "
                    f"for {al.get('month')}")
            n += 1
            await _each(raw, ws, "budget", "budget",
                        lambda link, base, al=al, text=text: fmt.budget_event(link, al, text, base))
    # a build failed
    from .. import compute
    async for j in raw[compute.JOBS].find({"at": {"$gt": core.iso(since("build"))}, "kind": {"$in": BUILD_KINDS},
                                           "rc": {"$nin": [0, None]}}):
        ws = _ws(j)
        if await announce(raw, f"x:{j['_id']}"):
            n += 1
            await _each(raw, ws, "build", "build-failed", lambda link, base, j=j: fmt.build_event(link, j, base))

    # Command Code's weekly window (backend/llm.py cc_check_alert): the
    # server's account, so its owner and admins, whichever space they are in
    from .. import llm
    async for al in raw[llm.CC_ALERTS].find({"at": {"$gt": since("ccusage")}}):
        if await announce(raw, f"cc:{al['_id']}"):
            n += 1
            base = await _base(raw)
            for link, _role in await links.server_recipients(raw, "ccusage"):
                await outbox.enqueue(raw, link["chat"], text=fmt.cc_usage_event(link, al, base),
                                     kind="cc-usage", user=link["_id"], ws=links.ws_of(link))

    await core.patch_settings(raw, {"watch": {k: t for k in WATCHED}})
    await sync_questions(raw)
    await digests(raw, t)
    return n


# ---------------- the daily digest ----------------

async def digest_figures(raw, ws: str, t) -> dict:
    sdb = scope.ScopedDb(raw, ws)
    day = core.iso(t - timedelta(days=1))
    from .. import compute
    return {
        "applied": await sdb.revisions.count_documents({"status": "applied", "applied_at": {"$gt": day}}),
        "failed": await sdb.runs.count_documents({"status": "failed", "finished_at": {"$gt": day},
                                                  "revision": {"$ne": None}}),
        "queued": await sdb.revisions.count_documents({"status": "queued", "archived": {"$ne": True}}),
        "drafts": await sdb.revisions.count_documents({"status": "draft", "archived": {"$ne": True}}),
        "questions": await sdb.questions.count_documents({"status": "open"}),
        "builds_failed": await sdb[compute.JOBS].count_documents(
            {"at": {"$gt": day}, "kind": {"$in": BUILD_KINDS}, "rc": {"$nin": [0, None]}}),
    }


async def digests(raw, t) -> int:
    if t.hour < DIGEST_HOUR_UTC:
        return 0
    base = await _base(raw)
    n = 0
    async for link in raw[core.LINKS].find({"prefs.digest": True}):
        if link.get("blocked") or not await announce(raw, f"d:{link['_id']}:{t.date().isoformat()}"):
            continue
        role = await links.role_of(raw, link)
        if not role:
            continue
        ws = links.ws_of(link)
        figures = await digest_figures(raw, ws, t)
        await outbox.enqueue(raw, link["chat"], text=fmt.digest_text(link, figures, base), kind="digest",
                             user=link["_id"], ws=ws)
        n += 1
    return n


async def loop() -> None:
    while True:
        try:
            await tick()
        except Exception as exc:                        # noqa: BLE001 - look again shortly
            log.warning("telegram watcher: %s", core.redact(exc))
        await asyncio.sleep(EVERY_S)
