#!/usr/bin/env python
"""Command line tool for revisions and models.

Talks to MongoDB directly, so it works with the server stopped; MONGODB_URI
and MONGODB_DB are read from .env.

    python tools/revisions.py queue                 queued revisions
    python tools/revisions.py show <id> [-o DIR]    write the marked image to disk
    python tools/revisions.py done <id>             mark as applied
    python tools/revisions.py models                list models
    python tools/revisions.py source <model>        print source code
    python tools/revisions.py save <model> <file>   update source code
    python tools/revisions.py build <model>         rebuild (viewer/STEP/STL)

Progress shown on screen while you work:

    python tools/revisions.py start <id> "title"    begin the top progress bar
    python tools/revisions.py log "text" [-p 40]    append a line to the log
    python tools/revisions.py finish [--failed]     complete the bar

What the work cost - tokens, money at list price, wall clock - is read from
the agent's own transcripts and frozen onto the revision when the run
finishes:

    python tools/revisions.py usage [--full] [-r ID]

The card shows the drawing as the "before"; the same view once the work is
done goes next to it:

    python tools/revisions.py after <id> [--only PART]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _line(text: str, level: str = "info") -> dict:
    import uuid
    return {"_id": uuid.uuid4().hex[:12], "at": _now(),
            "text": text.strip(), "level": level}


def connect():
    from dotenv import load_dotenv
    from motor.motor_asyncio import AsyncIOMotorClient

    load_dotenv(ROOT / ".env")
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        sys.exit("MONGODB_URI is not set (.env)")
    return AsyncIOMotorClient(uri)[os.getenv("MONGODB_DB", "assets_3d")]


async def cmd_queue(_):
    db = connect()
    rows = [d async for d in db.revisions.find({"status": "queued"})]
    rows.sort(key=lambda d: d.get("queued_at") or d["created_at"])
    if not rows:
        print("nothing queued")
        return
    for i, d in enumerate(rows, 1):
        cam = d.get("camera") or {}
        # A board note is not a model revision: there is no drawing to show
        # and `build` does not take a board. Say so on the first line, so
        # nobody runs the model loop on it.
        board = d.get("kind") == "pcb"
        print(f"\n#{i}  {d['_id']}" + ("   [BOARD]" if board else ""))
        print(f"   note  : {d['comment']}")
        print(f"   {'board' if board else 'model'} : {d.get('model') or '-'}"
              f"    part: {d.get('part') or '-'}")
        print(f"   time  : {d['created_at'][:19].replace('T', ' ')}")
        if board:
            print(f"   source: GET/PUT /api/boards/{d.get('model')}  "
                  f"(then POST .../build and .../layout)")
            continue
        if cam.get("position"):
            print(f"   camera: pos {cam['position']} target {cam.get('target')}")
        print(f"   image : python tools/revisions.py show {d['_id']}")


async def cmd_wait(args):
    """Block until something is queued, then print it and exit.

    The point is not to poll from inside a turn - it is to end the turn.
    Started in the background, this command sits quietly on the database
    and returns the moment a revision is queued, and its exit is what wakes
    the agent up. Without it somebody has to type "carry on" every time a
    piece of work lands.
    """
    import time as _time

    from backend import chat

    db = connect()
    deadline = _time.monotonic() + args.timeout if args.timeout else None
    seen = set(args.ignore or [])
    waited = 0
    while True:
        # Either kind of work wakes it: a queued revision, or something the
        # person typed into the thread. Both are them asking for something.
        said = await chat.unread(db)
        if said:
            urgent = [d for d in said if d.get("urgent")]
            if urgent:
                await _shout_interrupts(db)
            print(f"{len(said)} message(s) after waiting {waited}s")
            for d in said:
                print(f"  {d['at'][11:19]}  {d['text'][:88]}")
            print("\nRead the thread: revisions.py chat")
            return
        rows = [d async for d in db.revisions.find({"status": "queued"})]
        rows = [d for d in rows if d["_id"] not in seen]
        rows.sort(key=lambda d: d.get("queued_at") or d["created_at"])
        if rows:
            print(f"{len(rows)} queued after waiting {waited}s")
            for d in rows:
                print(f"  {d['_id']}  {d.get('model') or '-'}  "
                      f"{(d.get('comment') or '')[:72]}")
            print("\nPick the first one up: start, show, read the drawing.")
            return
        if deadline and _time.monotonic() > deadline:
            print(f"nothing queued after {waited}s")
            sys.exit(2)
        await asyncio.sleep(args.every)
        waited += args.every


async def _shout_interrupts(db) -> list[dict]:
    """Print anything urgent the person has said and not had picked up.

    Called from the commands the agent runs anyway - the progress log, a
    build - so an urgent line surfaces in its own output without it having
    to remember to look. Nothing is stopped and nothing is killed: the
    build carries on and the person gets an answer without waiting for it.
    It does not mark them read either - reading is what `chat` is for, and
    an urgent line nobody has read stays loud.
    """
    from backend import chat

    rows = await chat.interrupts(db)
    for d in rows:
        print(f"\n!! URGENT  {d['at'][11:19]}  {d['text']}")
    if rows:
        print("!! Answer it before the next step: revisions.py chat, then say\n")
    return rows


async def cmd_chat(args):
    """Read the thread, and mark what the person said as picked up.

    Not everything a person wants is a mark on a model - move these into a
    folder, rename that, why is this build slow. Those arrive here.
    """
    from backend import chat

    db = connect()
    rows = await chat.history(db, args.limit)
    if not rows:
        print("nothing said yet")
        return
    for d in rows:
        who = "you " if d["role"] == chat.AGENT else "them"
        mark = " " if d.get("seen_at") else "*"
        bang = "!! " if d.get("urgent") and not d.get("seen_at") else ""
        print(f"{mark}{d['at'][11:19]}  {who}  {bang}{d['text']}")
    fresh = [d["_id"] for d in rows
             if d["role"] == chat.USER and not d.get("seen_at")]
    if fresh and not args.keep_unread:
        await chat.mark_seen(db, fresh)
        print(f"\n{len(fresh)} new, now marked as read. Answer with: "
              f"revisions.py say \"...\"")


async def cmd_say(args):
    """Answer in the thread. This is what the person sees on screen."""
    from backend import chat

    db = connect()
    await chat.post(db, args.text, role=chat.AGENT)
    print("said")


async def cmd_part(args):
    """Parts for a board, from LCSC.

    The pinout comes out of the part's own EasyEDA symbol, so a component
    block is never written from memory - that is where a board goes wrong
    in a way nobody sees until it is on the bench.
    """
    from backend import lcsc

    if args.what == "passive":
        if len(args.args) != 3:
            sys.exit("passive KIND VALUE SIZE, e.g. passive R 10k 0402")
        got = lcsc.passive(*args.args)
        if not got:
            print(f"not in the table. It has: "
                  + ", ".join(lcsc.passive_values()))
            sys.exit(2)
        print(f"{got['key']:14} {got['lcsc']:9} {got['mpn']}   "
              f"(stock {got.get('stock')} when checked)")
        return
    if args.what == "find":
        rows = await lcsc.pick(" ".join(args.args), 8)
        if not rows:
            print("nothing came back")
        for r in rows:
            cls = (r.get("jlc_class") or "?").replace(" Part", "")
            price = f"${r['price']:.4f}" if r.get("price") is not None else "-"
            print(f"{r['lcsc']:10} {str(r.get('mpn'))[:26]:26} "
                  f"{str(r.get('package'))[:20]:20} {cls:8} "
                  f"stock {r.get('stock') or 0:<9} {price}")
        return
    for code in args.args:
        if args.what == "pins":
            print(f"# {code}")
            for pin in await lcsc.pins(code):
                print(f"  {pin['number']:>6}  {pin['name']}")
        else:
            print(await lcsc.ato_component(code))


async def cmd_ask(args):
    """Put a question on the person's screen and wait for the answer.

    The terminal is the wrong place to ask: the person who drew the revision
    is looking at the model in a browser, not at your log. This writes the
    question to the database, where the page picks it up, notifies, and
    writes the answer back.

    Blocks, like `wait` does, so the answer is simply the command's output.
    """
    import time as _time

    from backend import questions

    db = connect()
    doc = await questions.ask(db, args.text, args.option, args.revision,
                              args.context, args.multi)
    print(f"asked: {doc['_id']}")
    if doc["options"]:
        print("options: " + " | ".join(doc["options"]))
    print("waiting for an answer on screen...")

    deadline = _time.monotonic() + args.timeout if args.timeout else None
    while True:
        cur = await questions.get(db, doc["_id"])
        if cur and cur.get("status") == questions.ANSWERED:
            print(f"\nanswer: {cur['answer']}")
            return
        if deadline and _time.monotonic() > deadline:
            await questions.drop(db, doc["_id"])
            print(f"\nno answer after {args.timeout}s - question withdrawn")
            sys.exit(2)
        await asyncio.sleep(args.every)


async def cmd_show(args):
    from backend import store

    db = connect()
    doc = await db.revisions.find_one({"_id": args.id})
    if not doc:
        sys.exit(f"{args.id} not found")
    print(f"note    : {doc['comment']}")
    print(f"model   : {doc.get('model') or '-'}   part: {doc.get('part') or '-'}")
    print(f"status  : {doc.get('status')}")
    # A note about a part is a valid revision on its own - freeze and draw is
    # optional - so say so instead of dying on the missing image.
    if not (doc.get("image") or {}).get("gridfs_id"):
        print("image   : none - this revision is a written note, no drawing")
        return
    png = await store.get_shot(db, doc["image"]["gridfs_id"])
    out = Path(args.out or tempfile.gettempdir()) / f"{args.id}.png"
    out.write_bytes(png)
    print(f"image   : {out}   ({len(png)} bytes)")
    print("\nOpen this file with the Read tool and look at the red marks.")


async def cmd_done(args):
    # Through store.set_status, not a raw update: that is where auto-archive
    # lives, and a raw write left every task closed here sitting in the list.
    from backend import store

    db = connect()
    patch = await store.set_status(db, args.id, "applied")
    if patch is None:
        sys.exit(f"{args.id} not found")
    print(f"{args.id} -> applied" + ("  (archived)" if patch.get("archived") else ""))


async def cmd_start(args):
    from backend import compute

    db = connect()
    doc = {"_id": "current", "title": args.title, "revision": args.id,
           "model": None, "percent": 0.0, "status": "running",
           "started_at": _now(), "finished_at": None,
           # The machine's busy counter at both ends of the run: the
           # difference is what the whole box burned while this was worked
           # on. Our own builds are a part of that, not a separate bill.
           "cpu_start": compute.machine_cpu()}
    await db.runs.replace_one({"_id": "current"}, doc, upsert=True)
    # A second copy keyed by the revision. "current" is overwritten by the
    # next run, and without this the window a revision was worked in - which
    # is what the cost is measured over - would be gone the moment the next
    # one starts.
    await db.runs.replace_one({"_id": args.id}, {**doc, "_id": args.id},
                              upsert=True)
    await db.activity.insert_one(_line(f"started: {args.title}", "work"))
    print(f"run started: {args.title}")


async def cmd_log(args):
    db = connect()
    await db.activity.insert_one(_line(args.text, args.level))
    # The agent logs at every step, so this is where an interrupt catches it
    # between one thing and the next.
    await _shout_interrupts(db)
    if args.percent is not None:
        cur = await db.runs.find_one({"_id": "current"}) or {}
        ids = ["current"] + ([cur["revision"]] if cur.get("revision") else [])
        await db.runs.update_many({"_id": {"$in": ids}},
                                  {"$set": {"percent": args.percent}})
    pct = "" if args.percent is None else f"  [{args.percent:.0f}%]"
    print(f"{args.text}{pct}")


async def cmd_finish(args):
    from backend import compute, usage

    db = connect()
    status = "failed" if args.failed else "done"
    patch = {"status": status, "percent": 100.0, "finished_at": _now(),
             "cpu_end": compute.machine_cpu()}
    cur = await db.runs.find_one({"_id": "current"}) or {}
    ids = ["current"] + ([cur["revision"]] if cur.get("revision") else [])
    await db.runs.update_many({"_id": {"$in": ids}}, {"$set": patch},
                              upsert=False)
    await db.runs.update_one({"_id": "current"}, {"$set": patch}, upsert=True)
    await db.activity.insert_one(_line(f"finished: {status}", status))
    print(f"run {status}")

    # The card's "after": the same view once the work is done. Best effort -
    # it needs the dev server and a headless browser, and a finished run must
    # not depend on either.
    rev = cur.get("revision")
    if rev and not args.no_shot:
        try:
            await _after_shot(db, rev)
        except SystemExit as exc:
            print(f"after shot skipped: {exc}")
        except Exception as exc:                     # noqa: BLE001
            print(f"after shot skipped: {type(exc).__name__}: {exc}")

    # What the work cost, frozen onto the revision while the window is known.
    if rev:
        try:
            run = await db.runs.find_one({"_id": rev}) or {**cur, **patch}
            doc = await usage.store(db, rev, run)
            t = doc["totals"]
            money = ("-" if not t["complete"]
                     else f"${t['cost_usd']:.4f} (liste fiyati)")
            print(f"analytics: {t['calls']} cagri, "
                  f"{t['billed_tokens']:,} token, {money}, "
                  f"{doc['seconds']:.0f} sn")
            c = doc.get("compute") or {}
            ct = c.get("totals") or {}
            if ct.get("jobs"):
                print(f"compute  : {ct['jobs']} is, {ct['core_min']:.1f} "
                      f"cekirdek-dk, tepe {ct.get('peak_rss_mb') or 0:.0f} MB, "
                      f"~{(c.get('energy') or {}).get('wh', 0):.2f} Wh")
        except Exception as exc:                 # never block finishing
            print(f"analytics skipped: {type(exc).__name__}: {exc}")


async def cmd_stop(args):
    """Stop a build that is running. Your call, not the app's.

    An urgent message tells you somebody wants something; it does not
    decide that the four minutes of booleans under way are a waste. If
    they are, this is how you say so.
    """
    from backend import build

    db = connect()
    if await build.request_stop(db, args.model):
        print(f"{args.model}: asked to stop, it will die within a couple of "
              f"seconds")
    else:
        print(f"{args.model}: nothing building")


async def cmd_models(_):
    db = connect()
    async for m in db.models.find({}, {"source": 0}):
        art = ", ".join(m.get("artifacts", {})) or "not built"
        flag = " (STALE)" if m.get("stale") else ""
        print(f"{m['_id']:24s} {m.get('title',''):22s} {art}{flag}")


async def cmd_source(args):
    db = connect()
    doc = await db.models.find_one({"_id": args.model})
    if not doc:
        sys.exit(f"{args.model} not found")
    sys.stdout.write(doc["source"])


async def cmd_save(args):
    from backend import store

    db = connect()
    doc = await store.save_model(db, args.model, Path(args.file).read_text())
    print(f"{doc['_id']} saved  hash={doc['sha256'][:12]}  ready={doc['ready']}")
    print("next: python tools/revisions.py build " + args.model)


async def cmd_build(args):
    from backend import build

    db = connect()
    # Reported, not obeyed: the work carries on and the person gets their
    # answer. Nothing here decides for them that four minutes of booleans
    # were a waste.
    await _shout_interrupts(db)
    res = await build.build(db, args.model, ROOT / "export_model.py")
    sizes = ", ".join(f"{k} {v/1e6:.1f}MB" for k, v in res["artifacts"].items())
    print(f"{res['model']} built: {sizes}")


async def _after_shot(db, rid: str, width: int = 1200, height: int = 800,
                      only: str | None = None) -> dict:
    from backend import store

    out = Path(tempfile.gettempdir()) / f"after-{rid}.png"
    argv = [sys.executable, str(ROOT / "tools" / "render.py"), rid,
            "-o", str(out), "--width", str(width), "--height", str(height)]
    if only:
        argv += ["--only", only]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        # The run is already closed by the time the after shot is taken, so
        # the render cannot look up which revision it is for.
        env={**os.environ, "X3_REVISION": rid})
    log, _ = await proc.communicate()
    if proc.returncode != 0 or not out.exists():
        raise SystemExit("render failed: " + log.decode(errors="replace")[-400:])
    shot = await store.put_shot(db, out.read_bytes())
    await db.revisions.update_one({"_id": rid}, {"$set": {"image_after": shot}})
    print(f"after shot stored: {shot['bytes']} bytes")
    return shot


async def cmd_after(args):
    """Take the "after" shot from the revision's own camera and store it.

    The drawing on a card is the before. Putting the same view next to it
    once the work is done is the only way to see, from the card alone,
    whether what was asked for actually happened.
    """
    db = connect()
    if not await db.revisions.find_one({"_id": args.id}):
        sys.exit(f"{args.id} not found")
    await _after_shot(db, args.id, args.width, args.height, args.only)


async def cmd_usage(args):
    """Pull transcript usage into the database, and optionally re-roll a run."""
    from backend import usage

    db = connect()
    print(await usage.ingest(db, full=args.full))
    if args.revision:
        run = await db.runs.find_one({"_id": args.revision})
        if not run:
            sys.exit(f"{args.revision}: no run recorded")
        doc = await usage.store(db, args.revision, run)
        print(json.dumps({k: doc[k] for k in ("seconds", "totals", "rate")},
                         indent=2, ensure_ascii=False))


async def cmd_summaries(args):
    """One-off backfill: write the short sentence onto cards that lack one.

    Hand-written summaries are left alone unless --force says otherwise.
    """
    from backend import store, summarise

    db = connect()
    query = {} if args.all else {"$or": [{"summary": None},
                                         {"summary": {"$exists": False}}]}
    rows = [d async for d in db.revisions.find(query)]
    if args.limit:
        rows = rows[:args.limit]
    if not rows:
        print("nothing to summarise")
        return

    done = skipped = failed = 0
    spend = 0.0
    for doc in rows:
        rid = doc["_id"]
        if doc.get("summary_manual") and not args.force:
            skipped += 1
            continue
        png = None
        gid = (doc.get("image") or {}).get("gridfs_id")
        if gid:
            try:
                png = await store.get_shot(db, gid)
            except Exception:
                png = None
        try:
            text, usage = await summarise.summarise(doc["comment"], png)
        except Exception as exc:
            print(f"  {rid}  FAILED: {exc}")
            failed += 1
            continue
        if not text:
            failed += 1
            continue
        cost = usage.get("cost") or 0.0
        spend += cost if isinstance(cost, (int, float)) else 0.0
        await db.revisions.update_one({"_id": rid}, {"$set": {
            "summary": text, "summary_at": store.now(), "summary_manual": False}})
        done += 1
        print(f"  {rid}  {text}")
    print(f"\n{done} written, {skipped} hand-written left alone, {failed} failed"
          f"   total {spend:.5f} USD")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("queue").set_defaults(fn=cmd_queue)
    s = sub.add_parser("chat", help="read what the person said")
    s.add_argument("--limit", type=int, default=40)
    s.add_argument("--keep-unread", action="store_true",
                   help="look without picking it up")
    s.set_defaults(fn=cmd_chat)
    s = sub.add_parser("say", help="answer in the thread")
    s.add_argument("text")
    s.set_defaults(fn=cmd_say)
    s = sub.add_parser("ask", help="ask the person a question on their screen")
    s.add_argument("text", help="the question, in Markdown - it is rendered "
                                "on their screen, so a list or a table is "
                                "worth using when the answer is a choice")
    s.add_argument("-o", "--option", action="append",
                   help="an answer to offer; repeat for more. The form still "
                        "takes free text either way")
    s.add_argument("-c", "--context",
                   help="what you already know, so they need not reconstruct it")
    s.add_argument("--multi", action="store_true",
                   help="several options may be picked")
    s.add_argument("--revision", help="the revision this is about")
    s.add_argument("--every", type=int, default=3,
                   help="seconds between checks (default 3)")
    s.add_argument("--timeout", type=int, default=0,
                   help="withdraw the question after N seconds; 0 waits")
    s.set_defaults(fn=cmd_ask)
    s = sub.add_parser("part", help="parts from LCSC, for writing a board")
    s.add_argument("what", choices=["find", "pins", "ato", "passive"],
                   help="find: ranked search; pins: a part's pinout; "
                        "ato: component blocks to paste into a board; "
                        "passive: R/C by value and size, e.g. R 10k 0402")
    s.add_argument("args", nargs="+",
                   help="a search for find, LCSC numbers (C...) for pins/ato, "
                        "KIND VALUE SIZE for passive")
    s.set_defaults(fn=cmd_part)
    s = sub.add_parser("wait", help="block until a revision is queued")
    s.add_argument("--every", type=int, default=30,
                   help="seconds between checks (default 30)")
    s.add_argument("--timeout", type=int, default=0,
                   help="give up after N seconds; 0 waits for as long as the "
                        "session lasts")
    s.add_argument("--ignore", nargs="*",
                   help="revision ids to not count as new work")
    s.set_defaults(fn=cmd_wait)
    s = sub.add_parser("show"); s.add_argument("id"); s.add_argument("-o", "--out")
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("done"); s.add_argument("id"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("start"); s.add_argument("id"); s.add_argument("title")
    s.set_defaults(fn=cmd_start)
    s = sub.add_parser("log"); s.add_argument("text")
    s.add_argument("-p", "--percent", type=float)
    s.add_argument("-l", "--level", default="info",
                   choices=["info", "work", "done", "warn", "error"])
    s.set_defaults(fn=cmd_log)
    s = sub.add_parser("finish"); s.add_argument("--failed", action="store_true")
    s.add_argument("--no-shot", action="store_true",
                   help="skip the after picture")
    s.set_defaults(fn=cmd_finish)
    sub.add_parser("models").set_defaults(fn=cmd_models)
    s = sub.add_parser("source"); s.add_argument("model"); s.set_defaults(fn=cmd_source)
    s = sub.add_parser("save"); s.add_argument("model"); s.add_argument("file")
    s.set_defaults(fn=cmd_save)
    s = sub.add_parser("build"); s.add_argument("model"); s.set_defaults(fn=cmd_build)
    s = sub.add_parser("stop", help="stop a build that is running")
    s.add_argument("model")
    s.set_defaults(fn=cmd_stop)
    s = sub.add_parser("after", help="store the after shot for a revision")
    s.add_argument("id")
    s.add_argument("--width", type=int, default=1200)
    s.add_argument("--height", type=int, default=800)
    s.add_argument("--only", help="show only this part, as in render.py")
    s.set_defaults(fn=cmd_after)
    s = sub.add_parser("usage", help="pull LLM usage from the agent transcripts")
    s.add_argument("--full", action="store_true",
                   help="re-read every transcript from the start")
    s.add_argument("-r", "--revision", help="also re-roll this revision's numbers")
    s.set_defaults(fn=cmd_usage)
    s = sub.add_parser("summaries", help="backfill the one-line card summaries")
    s.add_argument("--all", action="store_true", help="redo cards that have one")
    s.add_argument("--force", action="store_true", help="replace hand-written ones")
    s.add_argument("--limit", type=int, default=0)
    s.set_defaults(fn=cmd_summaries)
    args = ap.parse_args()
    asyncio.run(args.fn(args))


if __name__ == "__main__":
    main()
