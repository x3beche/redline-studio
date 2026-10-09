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
                     or took over a minute and is done    -> "longbuild"
    chat             a room's agent wrote in its thread   -> "reply"
    cc_gens          a Command Code answer ended          -> "reply"
    boards           a board was routed (or laid out      -> "route"
                     long, unrouted)                      -> "longbuild"
    firmware_jobs    a firmware build ended               -> "firmware"
    releases         a release is ready, or failed        -> "release"
    audit            a part's body asked for, or bound    -> "bodies"
    parts            a part came into the drawer          -> "library"
    cc_usage_alerts  Command Code's weekly window at 90%  -> "ccusage"
                     or used up (owner and admins only)
    the server       disk, a model provider failing, the  -> "health"
                     pages' errors, builds crashing (owner and admins only)

Each event is announced once: its key goes into `telegram_events` (a
unique _id) before anything is sent, so two processes, a reload, or the
small overlap kept between looks never send it twice. The first look after
a bot is set up starts from now - nothing from before is announced; nor is
anything from before a kind of event was first watched (a new kind starts
its clock at its first look, with no overlap). The server's health is told
once per trouble per HEALTH_HOURS, and only when something new went wrong.

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
WATCHED = ("question", "applied", "failed", "rejected", "run", "budget", "build", "ccusage",
           "reply", "ccreply", "route", "longbuild", "firmware", "release", "bodies", "library", "health")
BUILD_KINDS = ["build", "layout", "convert", "run"]
LONG_S = 60                         # a build this long is worth a "done"
LONG_KINDS = ["build", "convert", "board"]   # a layout: from its board, with the routing
HEALTH_HOURS = 4                    # one message per trouble in this long
DISK_PCT, DISK_FREE_GB = 90, 5      # the disk is nearly full past either
DISK_EVERY_S = 300                  # and is looked at this often
LLM_FAILS, LLM_MINUTES = 3, 30      # a provider failing this often in this long
PAGE_ERRORS, PAGE_MINUTES = 20, 15  # the pages' errors piling up


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
    # A kind added since the bot was set up: when it was first watched, which
    # the overlap never reaches back past - what happened before is not news.
    first = {**(st.get("watch_from") or {}), **{k: t for k in WATCHED if k not in wm}}

    def since(k):
        # A kind first watched now starts now: nothing from before it is news.
        v, f = core.aware(wm.get(k)), core.aware(first.get(k))
        if not v:
            return t
        return max(v - OVERLAP, f) if f else v - OVERLAP

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

    n += await made(raw, t, since)
    n += await health(raw, t, since)

    await core.patch_settings(raw, {"watch": {k: t for k in WATCHED}, "watch_from": first})
    await sync_questions(raw)
    await digests(raw, t)
    return n


# ---------------- what was made: replies, routes, builds, releases, parts ----------------

async def made(raw, t, since) -> int:
    """The work that ended since the last look: a room's agent or a Command
    Code conversation answering, a board routed, a long build done, a
    firmware build, a release, a part's body, a part in the drawer."""
    from .. import ato, ccgen, chat, compute, fwbuild, lcsc, release
    n = 0
    # A room's agent wrote in its thread: one message a room, its last line
    # (an agent often says two or three things in a row).
    said: dict = {}
    async for c in raw[chat.CHAT].find({"role": chat.AGENT, "at": {"$gt": core.iso(since("reply"))}}):
        if await announce(raw, f"rp:{_ws(c)}:{_id(c)}"):
            said.setdefault((_ws(c), chat.room_of(c)), []).append(c)
    for (ws, room), rows in said.items():
        rows.sort(key=lambda c: c.get("at") or "")
        n += 1
        await _each(raw, ws, "reply", "agent-reply",
                    lambda link, base, room=room, last=rows[-1], more=len(rows) - 1:
                    fmt.reply_event(link, room, last.get("text"), base, more=more))
    # A Command Code answer ended: written, failed or cut off (stopped by
    # someone is not news to them).
    async for g in raw[ccgen.GENS].find({"status": {"$in": ["done", "failed", "interrupted"]},
                                         "finished_at": {"$gt": since("ccreply")}}):
        if not await announce(raw, f"cr:{g['_id']}"):
            continue
        ws = g.get("workspace") or scope.DEFAULT
        from .. import cc_chat
        conv = await scope.ScopedDb(raw, ws)[cc_chat.COLL].find_one({"_id": g.get("chat")}, {"title": 1}) or {}
        answer = g.get("answer") or {}
        error = answer.get("error") if g["status"] != "done" else None
        n += 1
        await _each(raw, ws, "reply", "cc-reply",
                    lambda link, base, g=g, conv=conv, error=error:
                    fmt.reply_event(link, "cc", g.get("text"), base, title=conv.get("title"),
                                    chat=g.get("chat"), error=error or None))
    # A board laid out: routed (with its checks), or - unrouted - a long one done.
    async for b in raw[ato.BOARDS].find({"layout.at": {"$gt": core.iso(since("route"))}}):
        ws, bid = _ws(b), _id(b)
        if not await announce(raw, f"rt:{ws}:{bid}:{(b.get('layout') or {}).get('at')}"):
            continue
        title = b.get("title") or b.get("name")
        if b.get("route"):
            erc = (b.get("schematic") or {}).get("erc")
            n += 1
            await _each(raw, ws, "route", "route",
                        lambda link, base, b=b, bid=bid, title=title, erc=erc:
                        fmt.route_event(link, bid, title, b["route"], b.get("drc"), erc, base))
            continue
        job = await scope.ScopedDb(raw, ws)[compute.JOBS].find_one(
            {"kind": "layout", "model": bid, "rc": 0, "wall_s": {"$gte": LONG_S},
             "at": {"$gt": core.iso(since("route") - timedelta(hours=1))}}, sort=[("at", -1)])
        if job:
            n += 1
            await _each(raw, ws, "longbuild", "long-build",
                        lambda link, base, job=job, title=title: fmt.longbuild_event(link, job, base, title))
    # A build or convert that took long enough to walk away from is done.
    async for j in raw[compute.JOBS].find({"at": {"$gt": core.iso(since("longbuild"))}, "kind": {"$in": LONG_KINDS},
                                           "rc": 0, "wall_s": {"$gte": LONG_S}}):
        ws = _ws(j)
        if await announce(raw, f"lb:{j['_id']}"):
            n += 1
            await _each(raw, ws, "longbuild", "long-build", lambda link, base, j=j: fmt.longbuild_event(link, j, base))
    # A firmware build ended.
    async for j in raw[fwbuild.JOBS].find({"status": {"$in": ["done", "failed"]},
                                           "finished_at": {"$gt": since("firmware")}}):
        ws = j.get("workspace") or scope.DEFAULT
        if await announce(raw, f"fw:{j['_id']}"):
            n += 1
            await _each(raw, ws, "firmware", "firmware", lambda link, base, j=j: fmt.firmware_event(link, j, base))
    # A release is ready, or failed.
    async for rel in raw[release.COLL].find({"status": {"$in": ["ready", "failed"]},
                                             "done_at": {"$gt": core.iso(since("release"))}}):
        ws, rid = _ws(rel), _id(rel)
        if await announce(raw, f"rl:{ws}:{rid}"):
            n += 1
            await _each(raw, ws, "release", f"release-{rel['status']}",
                        lambda link, base, rel=rel, rid=rid: fmt.release_event(link, rel, base, rid))
    # A part's drawn body: the PCB room asked the 3D room for one, or one was bound.
    async for a in raw.audit.find({"at": {"$gt": since("bodies")}, "action": {"$in": ["body-request", "body-bind"]}}):
        ws, d = _ws(a), a.get("detail") or {}
        if not await announce(raw, f"bd:{a['_id']}"):
            continue
        n += 1
        if a["action"] == "body-request":
            await _each(raw, ws, "bodies", "body-asked",
                        lambda link, base, d=d: fmt.body_event(link, "asked", d.get("part") or "?", base,
                                                               name=d.get("name"), model=d.get("model"),
                                                               board=d.get("board"), ref=d.get("ref")))
        else:
            part = str(a.get("target") or "").removeprefix("part ")
            await _each(raw, ws, "bodies", "body-bound",
                        lambda link, base, d=d, part=part: fmt.body_event(link, "bound", part, base,
                                                                          name=d.get("body"), model=d.get("model")))
    # A part came into the drawer (the drawer is the server's, not a space's).
    async for p in raw[lcsc.PARTS].find({"at": {"$gt": core.iso(since("library"))}}, {"footprint": 0}):
        if await announce(raw, f"lib:{p['_id']}"):
            n += 1
            base = await _base(raw)
            for link, _role in await links.server_recipients(raw, "library", act="view"):
                await outbox.enqueue(raw, link["chat"], text=fmt.library_event(link, p, base), kind="library",
                                     user=link["_id"], ws=links.ws_of(link))
    return n


# ---------------- the server's health (owner and admins) ----------------

_disk_at = 0.0


def _bucket(t) -> int:
    return int(t.timestamp() // (HEALTH_HOURS * 3600))


async def _tell_admins(raw, key: str, what: str, d: dict) -> int:
    if not await announce(raw, key):
        return 0
    base = await _base(raw)
    for link, _role in await links.server_recipients(raw, "health"):
        await outbox.enqueue(raw, link["chat"], text=fmt.health_event(link, what, d, base), kind=f"health-{what}",
                             user=link["_id"], ws=links.ws_of(link))
    return 1


def disk_now() -> dict:
    """How full the disk the checkout (and its .cache) is on is."""
    import shutil
    from .. import jobs
    u = shutil.disk_usage(jobs.ROOT)
    return {"pct": round(100 * u.used / u.total) if u.total else 0, "free_gb": u.free / 1e9, "path": str(jobs.ROOT)}


def _signal(rc: int) -> str:
    import signal
    try:
        return signal.Signals(-rc).name
    except ValueError:
        return f"signal {-rc}"


async def health(raw, t, since) -> int:
    """Trouble on the server, each kind told at most once per HEALTH_HOURS:
    the disk nearly full; a model provider failing again and again (a bad
    key, no credit left); the pages' errors piling up; builds crashing. A
    failure only counts towards a message when a new one came since the
    last look - what was wrong before nothing is said about stays unsaid."""
    global _disk_at
    import time

    from .. import build, ccgen, client_errors, compute, suggest
    n = 0
    b = _bucket(t)
    # the disk
    if time.monotonic() - _disk_at >= DISK_EVERY_S:
        _disk_at = time.monotonic()
        try:
            d = disk_now()
        except OSError:
            d = None
        if d and (d["pct"] >= DISK_PCT or d["free_gb"] < DISK_FREE_GB):
            n += await _tell_admins(raw, f"hd:disk:{b}", "disk", d)
    # a model provider failing: suggestions and Command Code answers that failed
    window = t - timedelta(minutes=LLM_MINUTES)
    fails: dict = {}
    async for x in raw[suggest.COLL].find({"state": "failed", "at": {"$gt": window}}):
        fails.setdefault(x.get("provider") or "?", []).append((core.aware(x.get("at")), x.get("error")))
    async for g in raw[ccgen.GENS].find({"status": "failed", "finished_at": {"$gt": window}}):
        fails.setdefault(g.get("provider") or "?", []).append((core.aware(g.get("finished_at")),
                                                                (g.get("answer") or {}).get("error")))
    fresh = since("health")
    for prov, rows in fails.items():
        rows.sort(key=lambda r: r[0] or t)
        if len(rows) >= LLM_FAILS and (rows[-1][0] or t) > fresh:
            n += await _tell_admins(raw, f"hd:llm:{prov}:{b}", "llm",
                                    {"provider": prov, "n": len(rows), "minutes": LLM_MINUTES, "detail": rows[-1][1]})
    # the pages' errors piling up
    recent = [e async for e in raw[client_errors.COLLECTION].find(
        {"at": {"$gt": t - timedelta(minutes=PAGE_MINUTES)}}, {"message": 1, "at": 1})]
    if len(recent) >= PAGE_ERRORS and any((core.aware(e.get("at")) or t) > fresh for e in recent):
        recent.sort(key=lambda e: core.aware(e.get("at")) or t)
        first = (recent[-1].get("message") or "").splitlines()
        n += await _tell_admins(raw, f"hd:pages:{b}", "pages",
                                {"n": len(recent), "minutes": PAGE_MINUTES, "detail": first[0] if first else None})
    # a build that crashed natively (run again, or crashed every time)
    async for j in raw[compute.JOBS].find({"at": {"$gt": core.iso(fresh)}, "kind": "build"}):
        rc = j.get("rc")
        if not j.get("crashes") and not build.crashed(rc):
            continue
        n += await _tell_admins(raw, f"hd:crash:{b}", "crash",
                                {"what": _id(j, "model") or "?", "signal": _signal(rc) if build.crashed(rc) else None,
                                 "retried": j.get("crashes") or 0})
    return n


# ---------------- the digest: daily, or weekly ----------------

async def digest_figures(raw, ws: str, t, days: int = 1) -> dict:
    """The space's figures over the last `days`."""
    from .. import ato, ccgen, chat, compute, fwbuild, release
    sdb = scope.ScopedDb(raw, ws)
    day = core.iso(t - timedelta(days=days))
    jobs = {"at": {"$gt": day}, "kind": {"$in": BUILD_KINDS + ["board"]}}
    # the machine's collections, each job holding its space
    machine = {"workspace": ws, "finished_at": {"$gt": t - timedelta(days=days)}}
    return {
        "applied": await sdb.revisions.count_documents({"status": "applied", "applied_at": {"$gt": day}}),
        "failed": await sdb.runs.count_documents({"status": "failed", "finished_at": {"$gt": day},
                                                  "revision": {"$ne": None}}),
        "queued": await sdb.revisions.count_documents({"status": "queued", "archived": {"$ne": True}}),
        "drafts": await sdb.revisions.count_documents({"status": "draft", "archived": {"$ne": True}}),
        "questions": await sdb.questions.count_documents({"status": "open"}),
        "builds_ok": await sdb[compute.JOBS].count_documents({**jobs, "rc": 0}),
        "builds_failed": await sdb[compute.JOBS].count_documents({**jobs, "rc": {"$nin": [0, None]}}),
        "fw_ok": await raw[fwbuild.JOBS].count_documents({**machine, "status": "done", "result.ok": True}),
        "fw_failed": await raw[fwbuild.JOBS].count_documents({**machine, "$or": [{"status": "failed"},
                                                                            {"result.ok": False}]}),
        "routes": await sdb[ato.BOARDS].count_documents({"route.at": {"$gt": day}}),
        "releases": await sdb[release.COLL].count_documents({"status": "ready", "done_at": {"$gt": day}}),
        "replies": await sdb[chat.CHAT].count_documents({"role": chat.AGENT, "at": {"$gt": day}})
        + await raw[ccgen.GENS].count_documents({**machine, "status": "done"}),
    }


async def digests(raw, t) -> int:
    """At DIGEST_HOUR_UTC: every day for those who want it daily, Mondays
    for those who want it weekly (the week before, then)."""
    if t.hour < DIGEST_HOUR_UTC:
        return 0
    base = await _base(raw)
    n = 0
    async for link in raw[core.LINKS].find({"prefs.digest": True}):
        every = links.every_of(link)
        if every == "week" and t.weekday() != 0:
            continue
        when = t.date().isoformat() if every == "day" else "w{}-{:02d}".format(*t.isocalendar()[:2])
        if link.get("blocked") or not await announce(raw, f"d:{link['_id']}:{when}"):
            continue
        role = await links.role_of(raw, link)
        if not role:
            continue
        ws = links.ws_of(link)
        figures = await digest_figures(raw, ws, t, 7 if every == "week" else 1)
        await outbox.enqueue(raw, link["chat"], text=fmt.digest_text(link, figures, base, every), kind="digest",
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
