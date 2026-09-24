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

A note from one of the coding rooms (web, embedded, mobile) is a frozen page
and the elements under the marks:

    python tools/revisions.py code show <id>     the note, the page, the elements
    python tools/revisions.py code diff <id>     what changed since it was drawn
    python tools/revisions.py code test <id>     the project's test command
    python tools/revisions.py code done <id>     tests, after shot, then applied
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


def _line(text: str, level: str = "info", room: str = "cad") -> dict:
    import uuid
    return {"_id": uuid.uuid4().hex[:12], "at": _now(),
            "text": text.strip(), "level": level, "room": room}


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
        if d.get("kind") in CODE_KINDS:
            _queue_code(i, d)
            continue
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

    if args.what == "keep":
        # Ahead of a layout, and patient: each download is three asks of a
        # budget of 25 per five minutes, so twenty parts is a wait - better
        # spent here than in a layout that places half the board.
        from backend import store  # noqa: F401  (connect() needs the env)
        lcsc.PATIENT.set(True)
        # Line by line, even into a file: this takes minutes, and progress
        # that sits in a buffer until the end is no progress at all.
        sys.stdout.reconfigure(line_buffering=True)
        db = connect()
        codes = list(dict.fromkeys(args.args))
        for i, code in enumerate(codes, 1):
            have = await db[lcsc.PARTS].find_one({"_id": code}, {"_id": 1})
            if have:
                print(f"[{i}/{len(codes)}] {code}: already in the drawer")
                continue
            try:
                doc = await lcsc.fetch(db, code)
                has3d = bool((doc.get("artifacts") or {}).get("model"))
                print(f"[{i}/{len(codes)}] {code}: {doc.get('name')}"
                      + (" + 3D" if has3d else ", footprint only"))
            except lcsc.Refused as exc:
                sys.exit(f"[{i}/{len(codes)}] {code}: {exc} - run it again later; "
                         "what was kept stays kept")
            except (RuntimeError, ValueError, OSError) as exc:
                print(f"[{i}/{len(codes)}] {code}: could not be fetched - {exc}")
        return
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
    # Each part on its own: one that cannot be had right now - EasyEDA
    # cooling off, a part it does not know - is named, and the rest still
    # come out. A traceback for the fourth of nine parts helped nobody.
    left_out = []
    for code in args.args:
        try:
            if args.what == "pins":
                rows = await lcsc.pins(code)
                print(f"# {code}")
                for pin in rows:
                    print(f"  {pin['number']:>6}  {pin['name']}")
            else:
                print(await lcsc.ato_component(code))
        except lcsc.Refused as exc:
            left_out.append(f"{code}: {exc}")
        except LookupError as exc:
            left_out.append(f"{code}: {exc}")
    if left_out:
        print("\n# not written:\n" + "\n".join(f"#   {x}" for x in left_out),
              file=sys.stderr)
        sys.exit(2)


async def cmd_board(args):
    """A board, the whole way through, by the server that owns the work.

    `run` is what a change to a board goes through every time: build the
    source, draw the schematic, place, route, pour, check. The steps are
    the server's - it has the KiCad container and the router - so this asks
    it, and prints what came out: the numbers to read before saying a
    board is done.
    """
    import json as _json
    import urllib.error
    import urllib.request

    base = os.environ.get("X3_API", "http://localhost:8000")

    def call(path: str, method: str = "GET", body: dict | None = None,
             timeout: int = 60):
        req = urllib.request.Request(
            base + path, method=method,
            data=_json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return _json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode()
        except urllib.error.HTTPError as exc:
            sys.exit(f"{method} {path}: {exc.code} {exc.read().decode(errors='replace')[:800]}")
        except urllib.error.URLError as exc:
            sys.exit(f"the server is not answering at {base} ({exc.reason}) - start.sh")

    bid = args.board
    if args.what == "source":
        print(call(f"/api/boards/{bid}")["source"])
    elif args.what == "save":
        text = Path(args.file).read_text()
        print(call(f"/api/boards/{bid}", "PUT", {"source": text}))
    elif args.what == "run":
        print(f"{bid}: build, schematic, place, route, pour, DRC - a minute or so")
        out = call(f"/api/boards/{bid}/run", "POST", {}, timeout=1800)
        _print_board(out)
    else:                                        # show
        doc = next((b for b in call("/api/boards") if b["_id"] == bid), None)
        if not doc:
            sys.exit(f"no board {bid}")
        _print_board({"schematic": doc.get("schematic") or {},
                      "layout": {**(doc.get("layout") or {}),
                                 "route": doc.get("route"), "drc": doc.get("drc")}})


def _print_board(out: dict) -> None:
    s = out.get("schematic") or {}
    lay = out.get("layout") or {}
    r = lay.get("route") or {}
    d = lay.get("drc") or {}
    erc = s.get("erc") or {}
    if out.get("seconds"):
        print(f"  took       {out['seconds']} s")
    print(f"  schematic  {s.get('parts', '?')} parts, {s.get('labels', '?')} pins joined, "
          f"ERC {erc.get('error_count', '?')} errors / {erc.get('warning_count', '?')} warnings")
    print(f"  board      {lay.get('placed', '?')} placed, {lay.get('size_mm', '?')} mm, "
          f"missing {lay.get('missing') or 'none'}")
    print(f"  routing    {r.get('unrouted', '?')} unrouted, {r.get('tracks', '?')} segments, "
          f"{r.get('vias', '?')} vias, {r.get('length_mm', '?')} mm")
    for note in r.get("notes") or []:
        print(f"             router: {note}")
    print(f"  DRC        {d.get('error_count', '?')} errors, {d.get('unconnected', '?')} unconnected, "
          f"{d.get('warning_count', '?')} warnings")
    for x in (d.get("examples") or []) + (erc.get("examples") or []):
        print(f"             {x[:150]}")
    for u in d.get("unconnected_examples") or []:
        print(f"             unconnected: {u}")


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
    doc = await db.revisions.find_one({"_id": args.id})
    if doc and doc.get("kind") in CODE_KINDS:
        # Not done until the tests pass and the after shot is taken.
        await _code_done(db, doc)
        return
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
    # In the log of the room the revision belongs to: a code note's run is
    # read in its coding room, not in the 3D room's.
    rdoc = await db.revisions.find_one({"_id": args.id}) or {}
    room = rdoc.get("kind") if rdoc.get("kind") in CODE_KINDS else "cad"
    await db.activity.insert_one(_line(f"started: {args.title}", "work", room))
    print(f"run started: {args.title}")


async def cmd_log(args):
    db = connect()
    await db.activity.insert_one(_line(args.text, args.level, args.room))
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
    rdoc = await db.revisions.find_one({"_id": cur.get("revision")}) or {}
    room = rdoc.get("kind") if rdoc.get("kind") in CODE_KINDS else "cad"
    await db.activity.insert_one(_line(f"finished: {status}", status, room))
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

    doc = await db.revisions.find_one({"_id": rid}) or {}
    if doc.get("kind") in CODE_KINDS:
        return await _code_after(db, doc)
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


# ---------------- code notes ----------------
# A note on a running interface, written in the Web, Embedded or Mobile
# room. `model` is the project's id, the drawing is a real screenshot of a
# route at a size, and `code` says what was under the marks - selector,
# box, and the file that renders it. The change is an edit in the
# project's checkout, the diff is read from git, the check is its test
# command, and the "after" is the same route at the same size again.
CODE_KINDS = ("web", "embedded", "mobile")


def _queue_code(i: int, d: dict) -> None:
    code = d.get("code") or {}
    vp = code.get("viewport") or ["?", "?"]
    print(f"\n#{i}  {d['_id']}   [{d['kind'].upper()}]")
    print(f"   note  : {d['comment']}")
    print(f"   app   : {d.get('model') or '-'}    part: {d.get('part') or '-'}")
    print(f"   page  : {code.get('route') or '/'} at {vp[0]}x{vp[1]}")
    for e in (code.get("dom") or [])[:3]:
        print(f"   under : {e.get('tag')} \"{(e.get('text') or '')[:30]}\"  "
              f"{e.get('file') or '?'}")
    print(f"   read  : python tools/revisions.py code show {d['_id']}")


async def _code_note(db, rid: str) -> tuple[dict, dict]:
    from backend import apps

    doc = await db.revisions.find_one({"_id": rid})
    if not doc:
        sys.exit(f"{rid} not found")
    if doc.get("kind") not in CODE_KINDS:
        sys.exit(f"{rid} is a {doc.get('kind') or 'cad'} note, not a code note")
    app = await db[apps.APPS].find_one({"_id": doc.get("model")})
    if not app:
        sys.exit(f"{rid}: its project {doc.get('model')} is gone")
    return doc, app


async def _code_show(db, args):
    from backend import store

    doc, app = await _code_note(db, args.id)
    code = doc.get("code") or {}
    vp = code.get("viewport") or ["?", "?"]
    print(f"note    : {doc['comment']}")
    print(f"status  : {doc.get('status')}    part: {doc.get('part') or '-'}")
    print(f"project : {app['_id']}  ({app.get('platform')})  {app['repo']}"
          + (f"  cwd {app['cwd']}" if app.get("cwd") else ""))
    print(f"page    : {(app.get('url') or '').rstrip('/')}{code.get('route') or '/'}"
          f"  at {vp[0]}x{vp[1]}")
    print(f"base    : {(code.get('base') or '-')[:12]}"
          f"   ({len(code.get('dirty') or {})} files were already uncommitted"
          " - they are not this note's)")
    print(f"check   : {app.get('test') or 'no test command'}")
    dom = code.get("dom") or []
    print(f"\nunder the marks ({len(dom)}):" if dom else "\nunder the marks: nothing mapped")
    for e in dom:
        x, y, w, h = e.get("box") or [0, 0, 0, 0]
        where = e.get("file") or "?"
        if e.get("line"):
            where += f":{e['line']}"
        print(f"  {e.get('tag'):8} \"{(e.get('text') or '')[:40]}\"  "
              f"at {x},{y} {w}x{h}")
        print(f"           {where}   ({e.get('component') or '-'})")
        print(f"           {e.get('selector')}")
    if (doc.get("image") or {}).get("gridfs_id"):
        png = await store.get_shot(db, doc["image"]["gridfs_id"])
        out = Path(args.out or tempfile.gettempdir()) / f"{args.id}.png"
        out.write_bytes(png)
        print(f"\nimage   : {out}   ({len(png)} bytes)")
        print("Open it with the Read tool: the marks say which part of the "
              "page, the list above says which element.")
    else:
        print("\nimage   : none - a written note about the project")


async def _code_diff(db, args):
    from backend import code_api

    doc, _ = await _code_note(db, args.id)
    try:
        text, frozen = await code_api.note_patch(db, doc)
    except (KeyError, ValueError) as exc:
        sys.exit(str(exc))
    if not text:
        print("nothing has changed since this note was drawn")
        return
    sys.stdout.write(text)
    if frozen:
        print("\n(frozen when the note was done)")


async def _code_test(db, app: dict) -> dict:
    from backend import apps

    print(f"$ {app['test']}   (in {apps.workdir(app)})")
    sys.stdout.flush()
    out = await apps.run_test(db, app)
    tail = out["tail"].rstrip().splitlines()[-25:]
    print("\n".join(tail))
    c = ", ".join(f"{v} {k}" for k, v in out["counts"].items()) or f"exit {out['rc']}"
    print(f"\ntests {'PASS' if out['ok'] else 'FAIL'}: {c} in {out['wall_s']:.1f} s")
    await db.activity.insert_one(_line(
        f"{app['_id']}: tests {'passed' if out['ok'] else 'FAILED'} - {c}",
        "done" if out["ok"] else "error", app.get("platform") or "web"))
    return out


async def _code_after(db, doc: dict) -> dict:
    """The same route at the same size, photographed again."""
    from backend import apps, code_api

    app = await db[apps.APPS].find_one({"_id": doc.get("model")})
    if not app:
        raise SystemExit(f"its project {doc.get('model')} is gone")
    code = doc.get("code") or {}
    w, h = (code.get("viewport") or [1280, 800])[:2]
    got = await code_api.take_shot(db, app, code.get("route") or "/", w, h)
    out = Path(tempfile.gettempdir()) / f"after-{doc['_id']}.png"
    out.write_bytes(got["png"])
    from backend import store
    shot = await store.put_shot(db, got["png"])
    await db.revisions.update_one({"_id": doc["_id"]},
                                  {"$set": {"image_after": shot}})
    print(f"after shot: {out}   ({shot['bytes']} bytes, "
          f"{code.get('route') or '/'} at {w}x{h})")
    print("Open it with the Read tool and compare it against the drawing.")
    return shot


async def _code_done(db, doc: dict) -> None:
    """Tests, then the after shot, then applied - and never the last
    without the first two. The patch is frozen onto the note on the way,
    so its card shows its own change after the checkout has moved on."""
    from backend import apps, code_api, store

    app = await db[apps.APPS].find_one({"_id": doc.get("model")})
    if not app:
        sys.exit(f"its project {doc.get('model')} is gone")
    if app.get("test"):
        out = await _code_test(db, app)
        if not out["ok"]:
            sys.exit(f"\n{doc['_id']} is not done: the tests fail. Fix them, "
                     "or say why on their screen (revisions.py ask).")
    else:
        print("no test command for this project - nothing to check against")
        out = None
    await _code_after(db, doc)
    text, frozen = await code_api.note_patch(db, doc)
    if not frozen:
        await code_api.freeze_patch(db, doc["_id"], text)
    parsed = apps.parse(text)
    await db.revisions.update_one({"_id": doc["_id"]}, {"$set": {
        "code.check": None if out is None else {
            "ok": out["ok"], "counts": out["counts"], "wall_s": out["wall_s"],
            "at": out["at"], "command": out["command"]},
        "code.changed": [f["path"] for f in parsed["files"]]}})
    patch = await store.set_status(db, doc["_id"], "applied")
    print(f"\n{doc['_id']} -> applied: {len(parsed['files'])} files, "
          f"+{parsed['added']} -{parsed['removed']}"
          + ("  (archived)" if patch and patch.get("archived") else ""))


async def cmd_code(args):
    """Code notes: read one, see its change, run its check, finish it."""
    db = connect()
    await _shout_interrupts(db)
    if args.what == "show":
        await _code_show(db, args)
    elif args.what == "diff":
        await _code_diff(db, args)
    elif args.what == "test":
        doc, app = await _code_note(db, args.id)
        out = await _code_test(db, app)
        if not out["ok"]:
            sys.exit(1)
    elif args.what == "after":
        doc, _ = await _code_note(db, args.id)
        await _code_after(db, doc)
    elif args.what == "done":
        doc, _ = await _code_note(db, args.id)
        await _code_done(db, doc)


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
    s.add_argument("what", choices=["find", "pins", "ato", "passive", "keep"],
                   help="find: ranked search; pins: a part's pinout; "
                        "ato: component blocks to paste into a board; "
                        "passive: R/C by value and size, e.g. R 10k 0402; "
                        "keep: fetch footprints and models ahead of a layout, "
                        "waiting out LCSC's budget")
    s.add_argument("args", nargs="+",
                   help="a search for find, LCSC numbers (C...) for pins/ato, "
                        "KIND VALUE SIZE for passive")
    s.set_defaults(fn=cmd_part)
    s = sub.add_parser("board", help="a board: its source, and the whole pipeline")
    s.add_argument("what", choices=["run", "show", "source", "save"],
                   help="run: build, schematic, place, route, DRC; show: where it "
                        "stands; source/save: read or write its atopile")
    s.add_argument("board")
    s.add_argument("file", nargs="?", help="for save: the .ato file to write")
    s.set_defaults(fn=cmd_board)
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
    s.add_argument("--room", default="cad",
                   choices=["cad", "pcb", "web", "embedded", "mobile"],
                   help="whose log: cad for models (default), pcb for boards, "
                        "web, embedded or mobile for a coding room")
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
    s = sub.add_parser("code", help="notes on a running interface: web, "
                                    "embedded and mobile")
    s.add_argument("what", choices=["show", "diff", "test", "after", "done"],
                   help="show: the note, the page and the elements under the "
                        "marks, drawing written to disk; diff: what changed "
                        "since it was drawn; test: the project's check; "
                        "after: the same page again; done: test, after, then "
                        "applied - refused while the tests fail")
    s.add_argument("id")
    s.add_argument("-o", "--out", help="where show writes the drawing")
    s.set_defaults(fn=cmd_code)
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
