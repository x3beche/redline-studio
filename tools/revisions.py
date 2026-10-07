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

Components - every model and board, as the 3D designs that import them see
them (backend/links.py); through the server, like `board`:

    python tools/revisions.py component list                      versions, uses, used by
    python tools/revisions.py component show <id>                 data, versions, pins, state
    python tools/revisions.py component deps <id> [--tree]        what it uses, what uses it
    python tools/revisions.py component pin <model> <comp> <v|latest>
    python tools/revisions.py component refresh <board>           3D component from its layout

Files people uploaded in the Files tab - a BOM, a pick-and-place file, a
datasheet (backend/files.py); through the server, like `board`:

    python tools/revisions.py files [--board B] [--kind bom] [-q TEXT]   list them
    python tools/revisions.py files get <id> [-o PATH]                   write one to disk
    python tools/revisions.py files put <path> [--board B] [--note TEXT] keep one there
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
    from backend import actors
    return {"_id": uuid.uuid4().hex[:12], "at": _now(),
            "text": text.strip(), "level": level, "room": room, "by": actors.agent()}


def connect():
    from dotenv import load_dotenv
    from motor.motor_asyncio import AsyncIOMotorClient

    load_dotenv(ROOT / ".env")
    # REDLINE_TRANSPORT=api: the database through the server, with this agent's
    # token (REDLINE_TOKEN) - no connection string needed (tools/remote_db.py).
    # Anything else: straight to MongoDB, as before.
    if os.getenv("REDLINE_TRANSPORT", "").strip().lower() == "api":
        sys.path.insert(0, str(ROOT / "tools"))
        from remote_db import RemoteDb
        return RemoteDb(os.getenv("REDLINE_API", "http://localhost:8000"), os.getenv("REDLINE_TOKEN") or None)
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        sys.exit("MONGODB_URI is not set (.env)")
    return AsyncIOMotorClient(uri)[os.getenv("MONGODB_DB", "redline")]


async def cmd_queue(args):
    from backend import compute

    db = connect()
    rows = [d async for d in db.revisions.find({"status": "queued"})]
    # One room's queue, for the agent that works that room.
    if getattr(args, "room", None):
        rows = [d for d in rows if compute.room_of(d.get("kind")) == args.room]
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
        said = await chat.unread(db, getattr(args, "room", None))
        if said:
            urgent = [d for d in said if d.get("urgent")]
            if urgent:
                await _shout_interrupts(db)
            print(f"{len(said)} message(s) after waiting {waited}s")
            for d in said:
                print(f"  {d['at'][11:19]}  [{chat.room_of(d)}]  {d['text'][:80]}")
            print("\nRead the thread: revisions.py chat")
            return
        rows = [d async for d in db.revisions.find({"status": "queued"})]
        rows = [d for d in rows if d["_id"] not in seen]
        if getattr(args, "room", None):
            from backend import compute
            rows = [d for d in rows if compute.room_of(d.get("kind")) == args.room]
        # A note somebody has started on is work in hand, not new work: the
        # main agent handed it to a room's agent, and being woken for it
        # again every half minute would be a loop.
        if rows:
            busy = {r["_id"] async for r in db.runs.find(
                {"_id": {"$in": [d["_id"] for d in rows]}, "status": "running"})}
            rows = [d for d in rows if d["_id"] not in busy]
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
        print(f"\n!! URGENT  {d['at'][11:19]}  [{chat.room_of(d)}]  {d['text']}")
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
    rows = await chat.history(db, args.limit, args.room)
    if not rows:
        print("nothing said yet")
        return
    for d in rows:
        who = "you " if d["role"] == chat.AGENT else "them"
        mark = " " if d.get("seen_at") else "*"
        bang = "!! " if d.get("urgent") and not d.get("seen_at") else ""
        print(f"{mark}{d['at'][11:19]}  [{chat.room_of(d)}]  {who}  {bang}{d['text']}")
    fresh = [d["_id"] for d in rows
             if d["role"] == chat.USER and not d.get("seen_at")]
    if fresh and not args.keep_unread:
        await chat.mark_seen(db, fresh)
        print(f"\n{len(fresh)} new, now marked as read. Answer in the room it was "
              f"said in: revisions.py say --room <room> \"...\"")


async def cmd_say(args):
    """Answer in the thread. This is what the person sees on screen."""
    from backend import chat

    db = connect()
    # Into the thread it was asked in: named, or where the person last spoke.
    room = args.room or await chat.last_room(db)
    await chat.post(db, args.text, role=chat.AGENT, room=room)
    print(f"said, in {room}")


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
            if getattr(args, "refresh", False):
                # Fetched again even though it is in the drawer: EasyEDA's
                # record asked afresh, the footprint and the 3D model
                # downloaded, the model seated on its pads.
                try:
                    got = await lcsc.refresh(db, code)
                except lcsc.Refused as exc:
                    sys.exit(f"[{i}/{len(codes)}] {code}: {exc} - run it again later; "
                             "what was refreshed stays refreshed")
                except (RuntimeError, ValueError, OSError, LookupError) as exc:
                    print(f"[{i}/{len(codes)}] {code}: could not be refreshed - {exc}")
                    continue
                print(f"[{i}/{len(codes)}] {code}: {got.get('name')} - {got['said']}")
                continue
            have = await db[lcsc.PARTS].find_one({"_id": code}, {"_id": 1})
            if have:
                print(f"[{i}/{len(codes)}] {code}: already in the drawer "
                      "(--refresh fetches it again, with its 3D model)")
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
    if args.what == "seat":
        # The model offsets of parts already in the drawer: worked out from
        # the stored model and EasyEDA's placement, nothing downloaded
        # again. A part whose EasyEDA record is not on disk is asked for
        # once, through the same budget (and proxy) as everything else.
        lcsc.PATIENT.set(True)
        sys.stdout.reconfigure(line_buffering=True)
        db = connect()
        ids = [] if args.args == ["all"] else list(dict.fromkeys(args.args))

        def show(i, n, row):
            off = row.get("offset")
            was = row.get("was")
            fmt = lambda v: "(" + " ".join(f"{x:.3f}" for x in v) + ")" if v else "-"
            print(f"[{i}/{n}] {row['lcsc']}: {row['status']}"
                  + (f"  {fmt(was)} -> {fmt(off)}" if off is not None else ""))
        try:
            await lcsc.seat_all(db, ids, progress=show)
        except lcsc.Refused as exc:
            sys.exit(f"{exc} - run it again later; what was seated stays seated")
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

    from backend import actors

    base = os.environ.get("REDLINE_API", "http://localhost:8000")

    def call(path: str, method: str = "GET", body: dict | None = None,
             timeout: int = 60):
        req = urllib.request.Request(
            base + path, method=method,
            data=_json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json", **actors.header_for_agent(),
                     **({"Authorization": f"Bearer {os.environ['REDLINE_TOKEN']}"} if os.environ.get("REDLINE_TOKEN") else {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return _json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode()
        except urllib.error.HTTPError as exc:
            sys.exit(f"{method} {path}: {exc.code} {exc.read().decode(errors='replace')[:800]}")
        except urllib.error.URLError as exc:
            sys.exit(f"the server is not answering at {base} ({exc.reason}) - start.sh")

    def job(path: str, body: dict | None, limit: int = 3600):
        """A long step as a job (backend/jobs.py): started, then followed
        until it is done. A reload of the API in between is only a pause -
        the job runs in a process of its own and the asking goes on."""
        import time as _t
        sep = "&" if "?" in path else "?"
        started = call(f"{path}{sep}detach=1", "POST", body, timeout=120)
        if not isinstance(started, dict) or "job" not in started:
            return started                  # an older server: the answer itself
        where = f"/api/boards/{started['board']}/jobs/{started['job']}"
        print(f"  job        {started['job']} - follow it at {where}", flush=True)
        t0, quiet = _t.monotonic(), 0
        while _t.monotonic() - t0 < limit + 120:
            _t.sleep(3)
            req = urllib.request.Request(base + where, headers={
                **actors.header_for_agent(),
                **({"Authorization": f"Bearer {os.environ['REDLINE_TOKEN']}"}
                   if os.environ.get("REDLINE_TOKEN") else {})})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    got = _json.loads(r.read())
            except urllib.error.HTTPError as exc:
                if exc.code in (502, 503, 504):
                    continue
                sys.exit(f"GET {where}: {exc.code} {exc.read().decode(errors='replace')[:800]}")
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                quiet += 1                  # the API restarting: the job is not
                if quiet % 10 == 1:
                    print("  (the server is not answering - reloading? the job goes on)", flush=True)
                continue
            if got.get("status") == "running":
                continue
            if got.get("status") == "done":
                return got.get("result")
            detail = got.get("detail")
            # A refusal written to be read (a convert that would discard
            # hand edits names the lines): as it is, not as escaped JSON.
            sys.exit(f"{path}: {got.get('status')} {got.get('code')} "
                     + (detail[:3000] if isinstance(detail, str) else
                        _json.dumps(detail, ensure_ascii=False)[:800]))
        sys.exit(f"{path}: still running after {limit} s - {where}")

    bid = args.board
    if args.what == "rules-schema":
        print(_json.dumps(call("/api/rules/schema"), indent=1, ensure_ascii=False))
        return
    if not bid:
        sys.exit(f"board {args.what} needs a board id")
    if args.what == "rules":
        # The rules as the board room shows them: what is set, who each
        # class catches once patterns apply, the nets there are, and what
        # is wrong. Edit the "rules" part and give it back with rules-save.
        got = call(f"/api/boards/{bid}/rules")
        text = _json.dumps(got, indent=1, ensure_ascii=False)
        if args.file:
            Path(args.file).write_text(text + "\n")
            print(f"wrote {args.file} - edit its \"rules\", then: board rules-save {bid} {args.file}")
        else:
            print(text)
    elif args.what == "rules-save":
        if not args.file:
            sys.exit("board rules-save <board> <file.json>")
        body = _json.loads(Path(args.file).read_text())
        body = body.get("rules", body)
        print(call(f"/api/boards/{bid}/rules", "PUT", {"rules": body}))
        print("saved - `board run` routes to them")
    elif args.what == "source":
        if args.rev:
            # A backup kept by a convert that wrote over (or merged) hand
            # edits: its text is in source_blobs, by fingerprint.
            async def backup():
                db = connect()
                doc = await db.boards.find_one({"_id": bid}, {"source_backups": 1})
                rows = [r for r in (doc or {}).get("source_backups") or []
                        if r["sha"].startswith(args.rev)]
                if not rows:
                    have = ", ".join(f"{r['rev']} ({r['at'][:19]}, {r['why']})"
                                     for r in (doc or {}).get("source_backups") or [])
                    sys.exit(f"{bid} has no backup {args.rev}" + (f" - it has: {have}" if have else ""))
                blob = await db.source_blobs.find_one({"_id": rows[-1]["sha"]})
                return (blob or {}).get("text")
            text = await backup()
            if text is None:
                sys.exit(f"the text of backup {args.rev} is not kept")
            print(text)
            return
        print(call(f"/api/boards/{bid}")["source"])
    elif args.what == "save":
        text = Path(args.file).read_text()
        print(call(f"/api/boards/{bid}", "PUT", {"source": text}))
    elif args.what == "run":
        print(f"{bid}: build, schematic, place, route, pour, DRC - a minute or so")
        out = job(f"/api/boards/{bid}/run", {}, limit=1800)
        _print_board(out)
    elif args.what == "convert":
        # An imported board written as atopile, built, and checked against
        # the import. Parts nothing else settles are picked with --part
        # (kept on the board); a BOM given now replaces the guesses.
        picks = {}
        if args.picks:
            picks.update(_json.loads(Path(args.picks).read_text()))
        for item in args.part or []:
            refs, _, code = item.partition("=")
            if not code:
                sys.exit(f"--part {item}: REF=C12345 (or R1,R2=C12345)")
            for ref in refs.split(","):
                picks[ref.strip()] = {"lcsc": code.strip(),
                                      "why": args.why or "picked by hand, not from a BOM"}
        # Decoded the way the parser decodes a BOM in an upload: EasyEDA
        # writes UTF-16, which read as UTF-8 reached the server as noise and
        # left every part a guess.
        from backend.imports.parts import _text as table_text
        body = {"picks": picks or None,
                "bom": table_text(Path(args.bom).read_bytes()) if args.bom else None,
                "force": bool(args.force), "keep_edits": bool(args.keep_edits)}
        print(f"{bid}: converting to atopile - parts, source, build, the netlist checked "
              "(LCSC lookups wait their turn: minutes on a first run)")
        out = job(f"/api/boards/{bid}/convert", body, limit=3600)
        _print_convert(out)
        if args.run and out.get("status") == "converted":
            print(f"{bid}: build, schematic, place (held), route, pour, DRC")
            _print_board(job(f"/api/boards/{bid}/run", {}, limit=3600))
    elif args.what == "hold":
        want = (args.file or "on").lower() in ("on", "yes", "true", "1")
        print(call(f"/api/boards/{bid}/hold", "PUT", {"placement": want}))
    else:                                        # show
        doc = next((b for b in call("/api/boards") if b["_id"] == bid), None)
        if not doc:
            sys.exit(f"no board {bid}")
        _print_board({"schematic": doc.get("schematic") or {},
                      "layout": {**(doc.get("layout") or {}),
                                 "route": doc.get("route"), "drc": doc.get("drc")}})


# ---------------------------------------------------------------- components

class ApiError(SystemExit):
    """The server said no: the command stops with its answer."""


def api_call(path: str, method: str = "GET", body: dict | None = None, timeout: int = 60):
    """One request to the app's API, as this agent (REDLINE_API,
    REDLINE_TOKEN, REDLINE_AGENT): the parsed JSON, or a stop with what
    the server said. Tests point this at the app itself."""
    import json as _json
    import urllib.error
    import urllib.request

    from backend import actors

    base = os.environ.get("REDLINE_API", "http://localhost:8000")
    req = urllib.request.Request(
        base + path, method=method,
        data=_json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **actors.header_for_agent(),
                 **({"Authorization": f"Bearer {os.environ['REDLINE_TOKEN']}"}
                    if os.environ.get("REDLINE_TOKEN") else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return _json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode()
    except urllib.error.HTTPError as exc:
        text = exc.read().decode(errors="replace")
        try:
            text = _json.loads(text).get("detail", text)
        except ValueError:
            pass
        raise ApiError(f"{method} {path}: {exc.code} {str(text)[:800]}")
    except urllib.error.URLError as exc:
        raise ApiError(f"the server is not answering at {base} ({exc.reason}) - start.sh")


def _q(cid: str) -> str:
    import urllib.parse
    return urllib.parse.quote(cid, safe="/")


def _find_component(rows: list[dict], name: str) -> dict:
    """A component by id - `board:<id>` or `model:<id>` when both kinds
    have it - or by the module name it is imported by."""
    kind, _, rest = name.partition(":")
    if kind in ("model", "board") and rest:
        hit = [r for r in rows if r["kind"] == kind and r["id"] == rest]
    else:
        hit = [r for r in rows if r["id"] == name] or [r for r in rows if r.get("module") == name]
    if not hit:
        raise ApiError(f"no component {name} - `component list` shows them")
    if len(hit) > 1:
        raise ApiError(f"{name} is a model and a board: say model:{name} or board:{name}")
    return hit[0]


def _state(r: dict) -> str:
    if r["kind"] == "board":
        return "" if r.get("ready") else "no 3D yet"
    st = r.get("state")
    if st in ("queued", "building"):
        return "rebuilding"
    if st in ("failed", "blocked", "cycle"):
        return st
    return "stale" if r.get("stale") else ""


def _vline(v: dict) -> str:
    return f"v{v['version']}  {str(v.get('at') or '')[:16].replace('T', ' ')}  " + "; ".join(v.get("changes") or [])


def cmd_component(args):
    """Components - every .3d model and .pcb board, as the 3D designs that
    import them see them: versions, who uses what, pins (backend/links.py).
    Through the API with the agent's token, like `board`."""
    rows = api_call("/api/components")
    what = args.what
    if what == "list":
        print(f"{'kind':5}  {'id':40}  {'ver':>4}  {'uses':>4}  {'used by':>7}  pins  state")
        for r in rows:
            print(f"{r['kind']:5}  {r['id']:40}  {'v' + str(r.get('version') or 0):>4}  "
                  f"{len(r.get('uses') or []):>4}  {len(r.get('used_by') or []):>7}  "
                  f"{len(r.get('pins') or {}):>4}  {_state(r)}")
        return
    if not args.id:
        raise ApiError(f"component {what} needs a component id")
    r = _find_component(rows, args.id)
    k = f"{r['kind']}:{r['id']}"
    by_key = {f"{x['kind']}:{x['id']}": x for x in rows}
    if what == "show":
        _show_component(r, k)
    elif what == "deps":
        _print_deps(r, k, by_key, args.tree)
    elif what == "pin":
        if r["kind"] != "model":
            raise ApiError("only a model pins what it uses: component pin <model> <component> <version|latest>")
        if not args.component or not args.version:
            raise ApiError("component pin <model> <component> <version|latest>")
        c = _find_component(rows, args.component)
        if args.version == "latest":
            version = None
        else:
            try:
                version = int(args.version.lstrip("v"))
            except ValueError:
                raise ApiError(f"{args.version}: a version number (3 or v3), or latest")
        out = api_call(f"/api/models/{_q(r['id'])}/pins", "POST",
                       {"component": f"{c['kind']}:{c['id']}", "version": version})
        said = f"pinned at v{version}" if version is not None else "follows its latest"
        if not out.get("changed"):
            print(f"{r['id']}: {c['id']} already {said} - nothing to rebuild")
        else:
            print(f"{r['id']}: {c['id']} {said}"
                  + (f" (was v{out['was']})" if out.get("was") is not None else ""))
            if out.get("queued"):
                print(f"  rebuilding {', '.join(out['queued'])}")
            for cyc in out.get("cycles") or []:
                print(f"  import cycle, not built: {' -> '.join(cyc + cyc[:1])}")
    elif what == "refresh":
        if r["kind"] != "board":
            raise ApiError("refresh is for a board: its 3D component from its layout")
        running = [j for j in api_call(f"/api/boards/{_q(r['id'])}/jobs") or []
                   if j.get("status") == "running"]
        if running:
            raise ApiError(f"{r['id']}: a {running[0].get('kind')} job is running "
                           f"({running[0].get('_id') or running[0].get('job')}) - its layout makes "
                           "the component; try again when it is done")
        print(f"{r['id']}: exporting the 3D component from the layout (a minute or so)", flush=True)
        out = api_call(f"/api/boards/{_q(r['id'])}/component", "POST", {}, timeout=900)
        print(f"  version    v{out.get('version')}" + (" (new)" if out.get("changed") else " (unchanged)")
              + ((" - from the import: the STEP it was uploaded with, in the board's frame"
                  if out.get("step_from") == "upload"
                  else " - from the import: the STEP is the bare board, parts as boxes")
                 if out.get("from") == "import" else ""))
        print(f"  step       {out.get('step_bytes', 0) / 1e6:.1f} MB")
        if out.get("queued"):
            print(f"  rebuilding {', '.join(out['queued'])}")
        _show_component(r, k, brief=True)


def _show_component(r: dict, k: str, brief: bool = False) -> None:
    if r["kind"] == "board":
        c = api_call(f"/api/boards/{_q(r['id'])}/component")
        comp = c.get("component") or {}
        print(f"board {r['id']} - {c.get('title')}")
        if not comp:
            print("  no 3D yet - `component refresh` or the next layout makes it")
        else:
            print(f"  version    v{comp.get('version')}  {str(comp.get('at') or '')[:16].replace('T', ' ')}"
                  + ("  (every run is a new version)" if c.get("every_run") else ""))
            print(f"  import     {c.get('line')}")
        if c.get("error"):
            print(f"  last error {str(c['error'].get('at'))[:16]}: {c['error'].get('error', '')[-300:]}")
        d = c.get("data")
        if d:
            print(f"  size       {d['size'][0]} x {d['size'][1]} x {d['thickness']} mm")
            print(f"  holes      {len(d['holes'])} mounting: "
                  + ", ".join(f"({h['x']}, {h['y']}) d{h['d']}" for h in d["holes"]))
            print(f"  drills     {len(d.get('drills') or [])} other holes (parts' pins and pegs)")
            print(f"  connectors {len(d['connectors'])}: "
                  + ", ".join(f"{x['ref']}" + (f" {x['edge']} @{x['along']}" if x.get("edge") else "")
                              + f" h{x['height']}" for x in d["connectors"]))
            ko = d.get("keepout") or {}
            print(f"  keepout    {ko.get('top')} mm above, {ko.get('bottom')} mm below")
            if d.get("approximate"):
                print(f"  boxes for  {len(d['approximate'])} parts in B.part (mesh-only or imported): "
                      + ", ".join(d["approximate"][:12]) + (" ..." if len(d["approximate"]) > 12 else ""))
        if brief:
            return
        print("  used by    " + (", ".join(u["id"] + (f" (pinned v{u['pinned']})" if u.get("pinned") else "")
                                          + (f" [{u['state']}]" if u.get("state") else "")
                                          for u in c.get("used_by") or []) or "nothing"))
        pinned = c.get("pinned_by") or []
    else:
        c = api_call(f"/api/models/{_q(r['id'])}/links")
        link = c.get("link") or {}
        print(f"model {r['id']} - {r.get('title')}")
        print(f"  version    v{c.get('version')}" + ("  (changed since its build)" if c.get("stale") else ""))
        if link:
            b = link.get("because") or {}
            print(f"  rebuild    {link.get('state')} - because {b.get('title') or b.get('id')}"
                  + (f" v{b['version']}" if b.get("version") is not None else "")
                  + (f" ({b['pin']})" if b.get("pin") else ""))
            if link.get("error"):
                print(f"  last error {link['error'].strip().splitlines()[-1][:300]}")
        print(f"  built      {'against the latest' if c['built'].get('current') else 'not against the latest'}"
              f" ({str(c['built'].get('at') or 'never')[:16]})")
        for cyc in c.get("cycles") or []:
            print(f"  cycle      {' -> '.join(cyc + cyc[:1])}")
        print("  uses       " + (", ".join(
            f"{u['id']} v{u.get('version')}" + (f" (pinned v{u['pinned']})" if u.get("pinned") is not None else "")
            + (f" (built against v{u['built_against']})" if u.get("built_against") not in (None, u.get("version"))
               and u.get("pinned") is None else "")
            for u in c.get("uses") or []) or "nothing"))
        print("  used by    " + (", ".join(u["id"] for u in c.get("used_by") or []) or "nothing"))
        for x in c.get("copied") or []:
            print(f"  copied     line {x['line']}: {x['value']} is {' / '.join(x['names'])}")
        pinned = c.get("pinned_by") or []
    if pinned:
        print("  pinned by  " + ", ".join(f"{p['id']} at v{p['version']}" + (" (behind)" if p.get("behind") else "")
                                          for p in pinned))
    vs = api_call(f"/api/components/{r['kind']}/{_q(r['id'])}/versions")
    if vs.get("versions"):
        print("  versions   (kept, newest first)")
        for v in vs["versions"][:8]:
            print("    " + _vline(v))


def _print_deps(r: dict, k: str, by_key: dict, tree: bool) -> None:
    def label(key_: str, pin=None) -> str:
        x = by_key.get(key_) or {}
        return (f"{x.get('kind', '?')}:{x.get('id', key_)} v{x.get('version') or 0}"
                + (f" (pinned v{pin})" if pin is not None else ""))

    used_by = {kk: [f"{x['kind']}:{x['id']}" for x in by_key.values() if kk in (x.get("uses") or [])]
               for kk in by_key}
    print(label(k))
    if not tree:
        pins = r.get("pins") or {}
        print("  uses:    " + (", ".join(label(u, pins.get(u)) for u in r.get("uses") or []) or "nothing"))
        print("  used by: " + (", ".join(label(u, (by_key[u].get("pins") or {}).get(k))
                                         for u in used_by.get(k) or []) or "nothing"))
        return

    def down(key_: str, depth: int, seen: set) -> None:
        pins = (by_key.get(key_) or {}).get("pins") or {}
        for u in (by_key.get(key_) or {}).get("uses") or []:
            print("  " * depth + "- " + label(u, pins.get(u)) + ("  (cycle)" if u in seen else ""))
            if u not in seen:
                down(u, depth + 1, seen | {u})

    def up(key_: str, depth: int, seen: set) -> None:
        for d in used_by.get(key_) or []:
            pin = (by_key[d].get("pins") or {}).get(key_)
            print("  " * depth + "+ " + label(d, pin) + ("  (cycle)" if d in seen else ""))
            if d not in seen:
                up(d, depth + 1, seen | {d})

    print(" uses (what it is built from):")
    down(k, 1, {k})
    print(" used by (what rebuilds when it changes):")
    up(k, 1, {k})


def _print_convert(out: dict) -> None:
    print(f"  status     {out.get('status')}")
    parts = out.get("parts") or []
    guessed = [p for p in parts if p.get("guessed")]
    print(f"  parts      {len(parts)}: {len(parts) - len(guessed)} settled, "
          f"{len(guessed)} GUESSED" + (f" (BOM {out['bom']})" if out.get("bom") else " (no BOM)"))
    by_how: dict = {}
    for p in guessed:
        by_how.setdefault(p["how"], []).append(p["ref"])
    for how, refs in by_how.items():
        print(f"             {how}: {', '.join(refs)}")
    for p in parts:
        if p["how"] not in ("placeholder", "bom-value"):
            land = p.get("land") or {}
            print(f"    {p['ref']:12} {p['lcsc'] or '-':10} {p['how']:7} {p['component']:28} "
                  f"land {land.get('worst_mm', '-')} mm"
                  + (f", pins added {','.join(p['added_pins'])}" if p.get("added_pins") else ""))
    for x in out.get("unresolved") or []:
        print(f"  UNRESOLVED {x}")
    for x in out.get("problems") or []:
        print(f"  problem    {x}")
    for x in out.get("findings") or []:
        print(f"  finding    {x}")
    if out.get("modules"):
        print(f"  modules    " + "; ".join(f"{m} ({len(r)})" for m, r in out["modules"].items()))
    if out.get("open_pins") is not None:
        print(f"  open pins  {len(out['open_pins'])} pads on no net stay unconnected")
    if out.get("outline"):
        o = out["outline"]
        print(f"  outline    {'closed' if o.get('closed') else 'NOT closed'}, "
              f"{o.get('strokes')} strokes, ends joined up to {o.get('joined_mm')} mm")
    if out.get("holes") is not None:
        print(f"  holes      {out['holes']} in the drills that belong to no part (placed as mounting holes)")
    if out.get("min_edge") is not None:
        print(f"  edge       the import's tracks keep {out['min_edge']} mm from the edge - "
              "the rules' copper-to-edge starts there unless one was chosen")
    if out.get("build_error"):
        print("  build      FAILED\n" + out["build_error"])
    eq = out.get("equivalence")
    if eq:
        _print_equivalence(eq)


def _print_equivalence(eq: dict) -> None:
    n, p = eq["nets"], eq["parts"]
    print(f"  netlist    {'EQUIVALENT' if eq['equivalent'] else 'NOT EQUIVALENT'} to the import: "
          f"parts {p['built']}/{p['imported']}, nets {n['same']}/{n['imported']} identical, "
          f"pads joined {eq['pads_joined']['built']}/{eq['pads_joined']['imported']}")
    for d in eq.get("differences") or []:
        print(f"             differs: {d}")
    if p.get("missing") or p.get("extra"):
        print(f"             parts missing {p['missing']}, extra {p['extra']}")
    if eq.get("renamed"):
        print(f"             renamed: {', '.join(eq['renamed'][:10])}")


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
    # How many layouts it took, when it took more than the first one.
    tried = r.get("attempts") or 1
    print(f"  routing    {r.get('unrouted', '?')} unrouted, {r.get('tracks', '?')} segments, "
          f"{r.get('vias', '?')} vias, {r.get('length_mm', '?')} mm"
          + (f", {tried} layouts tried" if tried > 1 else ""))
    lo = r.get("leftovers")
    if lo:
        print(f"  leftovers  {', '.join(lo.get('nets') or [])} routed first, then the rest: "
              f"{lo.get('unrouted_before')} -> {lo.get('unrouted_after', '?')} unrouted"
              + (" (kept)" if lo.get("kept") else " (first pass kept)"))
    print(f"  DRC        {d.get('error_count', '?')} errors, {d.get('unconnected', '?')} unconnected, "
          f"{d.get('warning_count', '?')} warnings")
    for x in (d.get("examples") or []) + (erc.get("examples") or []):
        print(f"             {x[:150]}")
    for u in d.get("unconnected_examples") or []:
        print(f"             unconnected: {u}")
    if d.get("edge_exempt"):
        print(f"  edge       kept at the edge as imported (not flagged): {', '.join(d['edge_exempt'])}")
    if lay.get("held"):
        print(f"  held       every part where the import had it: worst pad "
              f"{lay.get('held_worst_mm')} mm off" + (f"; by centre only: {', '.join(lay['held_by_centre'])}"
                                                    if lay.get("held_by_centre") else ""))
    mounting = [h for h in lay.get("holes") or [] if h.get("ref")]
    if mounting:
        print(f"  holes      {len(mounting)} mounting holes from the drills: "
              + ", ".join(f"{h['ref']} {h['d']} mm" + (" plated" if h.get("plated") else "")
                          for h in mounting))
    for h in lay.get("holes") or []:
        if h.get("part"):
            print(f"  holes      {h['d']} mm in the drills is {h['part']}'s own (its body's hole, "
                  "where the import had it) - put in that part, not a mounting hole")
    if out.get("equivalence"):
        _print_equivalence(out["equivalence"])


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
    # One run per room: the 3D room's is "current", the others their own,
    # so a tab's agent can work while another room's is busy. Within a room
    # it is still one document, and re-pointing it while somebody else's
    # run is open lets their `finish` close yours: that happened, a CAD run
    # and a code run crossing at 07:40 when there was only one. And a note
    # running under one agent is not another's to start: that happened too,
    # a second agent taking a note - and runs/current - from the first.
    # The rules are backend/runs.py's, shared with POST /api/run/start.
    from backend import actors, compute, runs

    db = connect()
    rdoc = await db.revisions.find_one({"_id": args.id}) or {}
    room = compute.room_of(rdoc.get("kind"))
    take_over = bool(getattr(args, "take_over", False))
    try:
        doc, what = await runs.start(
            db, args.id, args.title or "", room, actors.agent(),
            # Which Claude Code session is asking; the sub-agent within it
            # is read from the transcript later (backend/usage.py, resolve).
            session=runs.session_from_env(), take_over=take_over,
            force=bool(getattr(args, "force", False)),
            # The machine's busy counter at both ends of the run: the
            # difference is what the whole box burned while this was worked
            # on. Our own builds are a part of that, not a separate bill.
            extra={"cpu_start": compute.machine_cpu()})
    except runs.Busy as exc:
        sys.exit(str(exc))
    me = actors.agent()["name"]
    if what == "resumed":
        print(f"run already yours, carrying on: {doc.get('title')}")
        return
    if what == "taken-over":
        prev = (doc["taken_over"][-1].get("from") or {}).get("name") or "agent"
        await db.activity.insert_one(_line(
            f"taken over by {me} from {prev}: {doc.get('title')}", "warn", room))
        await actors.audit(db, "take-over", f"runs/{args.id}",
                           {"from": prev, "to": me})
        print(f"run taken over from {prev}: {doc.get('title')}")
        return
    # In the log of the room the revision belongs to.
    await db.activity.insert_one(_line(f"started: {args.title}", "work", room))
    # The sources as they are now, so what this note changes can be shown.
    try:
        from backend import changes
        await changes.started(db, args.id)
    except Exception as exc:                     # noqa: BLE001 - never block a start
        print(f"(sources not recorded: {type(exc).__name__}: {exc})")
    print(f"run started: {args.title}")


async def cmd_log(args):
    db = connect()
    await db.activity.insert_one(_line(args.text, args.level, args.room))
    # The agent logs at every step, so this is where an interrupt catches it
    # between one thing and the next.
    await _shout_interrupts(db)
    if args.percent is not None:
        from backend import compute
        key = compute.run_key(args.room)
        cur = await db.runs.find_one({"_id": key}) or {}
        ids = [key] + ([cur["revision"]] if cur.get("revision") else [])
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
    from backend import compute as _c
    room = args.room
    if args.id:
        rdoc = await db.revisions.find_one({"_id": args.id}) or {}
        room = _c.room_of(rdoc.get("kind"))
    key = _c.run_key(room)
    cur = await db.runs.find_one({"_id": key}) or {}
    if args.id and cur.get("revision") != args.id:
        # Closing one's own run by name, while "current" belongs to another:
        # only the run keyed by that revision is touched.
        mine = await db.runs.find_one({"_id": args.id})
        if not mine:
            sys.exit(f"no run recorded for {args.id}")
        cur = {**mine, "revision": args.id}
        await db.runs.update_one({"_id": args.id}, {"$set": patch})
    else:
        ids = [key] + ([cur["revision"]] if cur.get("revision") else [])
        await db.runs.update_many({"_id": {"$in": ids}}, {"$set": patch},
                                  upsert=False)
        await db.runs.update_one({"_id": key}, {"$set": patch}, upsert=True)
    await db.activity.insert_one(_line(f"finished: {status}", status, room))
    print(f"run {status}")

    # The card's "after": the same view once the work is done. Best effort -
    # it needs the dev server and a headless browser, and a finished run must
    # not depend on either.
    rev = cur.get("revision")
    if rev:
        # What changed since the start, kept on the note for the page to show.
        try:
            from backend import changes
            got = await changes.finished(db, rev)
            if got:
                print("changed : " + ", ".join(f"{c['id'].split('/')[-1]} +{c['added']} -{c['removed']}" for c in got))
        except Exception as exc:                 # noqa: BLE001 - never block a finish
            print(f"(changes not recorded: {type(exc).__name__}: {exc})")
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
    try:
        doc = await store.save_model(db, args.model, Path(args.file).read_text())
    except store.SourceError as exc:
        # Compiled, not run: a syntax error is refused here, not kept as a
        # version that only the build finds out about.
        sys.exit(f"{args.model}: {exc}")
    print(f"{doc['_id']} saved  hash={doc['sha256'][:12]}  ready={doc['ready']}")
    print("next: python tools/revisions.py build " + args.model)


async def cmd_build(args):
    from backend import build

    db = connect()
    # Reported, not obeyed: the work carries on and the person gets their
    # answer. Nothing here decides for them that four minutes of booleans
    # were a waste.
    await _shout_interrupts(db)
    from backend import store
    # The version this build is of; how it went is kept on it, so a saved
    # version that does not build is marked failed (pins and "latest" skip
    # it) and one that does is cleared.
    version = await store.current_version(db, args.model)
    try:
        res = await build.build(db, args.model, ROOT / "export_model.py")
    except (ValueError, RuntimeError, TimeoutError, MemoryError) as exc:
        await store.version_built(db, args.model, version, str(exc) or type(exc).__name__)
        raise
    await store.version_built(db, args.model, version)
    sizes = ", ".join(f"{k} {v/1e6:.1f}MB" for k, v in res["artifacts"].items())
    print(f"{res['model']} built: {sizes}")


async def _after_shot(db, rid: str, width: int | None = None, height: int | None = None,
                      only: str | None = None) -> dict:
    from backend import store

    out = Path(tempfile.gettempdir()) / f"after-{rid}.png"
    # No size by default: render.py then shoots the note's own canvas, whose
    # shape decides the framing. A note from before the canvas was kept is
    # shot in the shape of its drawing (the before image's pixel size), not
    # at a fixed 1200x800: the same camera over another aspect frames
    # another picture (render.py shot_size / drawn_size).
    argv = [sys.executable, str(ROOT / "tools" / "render.py"), rid, "-o", str(out)]
    if width:
        argv += ["--width", str(width)]
    if height:
        argv += ["--height", str(height)]
    if only:
        argv += ["--only", only]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        # The run is already closed by the time the after shot is taken, so
        # the render cannot look up which revision it is for.
        env={**os.environ, "REDLINE_REVISION": rid})
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
    if getattr(args, "reattribute", False):
        got = await usage.reattribute(db, full=True)
        for d in got["recomputed"]:
            b, a = d["before"], d["after"]
            print(f"{d['id']}: {b.get('calls')} calls {b.get('billed_tokens', 0):,} tok "
                  f"${b.get('cost_usd', 0):.2f} -> {a['calls']} calls "
                  f"{a['billed_tokens']:,} tok ${a['cost_usd']:.2f}")
        print(f"recomputed {len(got['recomputed'])}, approximate "
              f"{len(got['approximate'])}: {', '.join(got['approximate'])}")
        return
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


async def cmd_kind(args):
    """Which room a revision belongs to: cad or pcb."""
    from backend import compute

    doc = await connect().revisions.find_one({"_id": args.id}, {"kind": 1})
    if not doc:
        sys.exit(f"{args.id} not found")
    print(compute.room_of(doc.get("kind")))


async def cmd_files(args):
    """The Files tab, from the command line. Through the server (it keeps the
    bytes in GridFS and knows the workspace), with the agents' token."""
    import json as _json
    import urllib.error
    import urllib.parse
    import urllib.request
    import uuid

    from backend import actors

    base = os.environ.get("REDLINE_API", "http://localhost:8000")
    auth = {"Authorization": f"Bearer {os.environ['REDLINE_TOKEN']}"} if os.environ.get("REDLINE_TOKEN") else {}

    def call(path: str, method: str = "GET", data: bytes | None = None, ctype: str | None = None) -> bytes:
        req = urllib.request.Request(base + path, method=method, data=data,
                                     headers={**actors.header_for_agent(), **auth,
                                              **({"content-type": ctype} if ctype else {})})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            sys.exit(f"{method} {path}: {exc.code} {exc.read().decode(errors='replace')[:800]}")
        except urllib.error.URLError as exc:
            sys.exit(f"the server is not answering at {base} ({exc.reason}) - start.sh")

    if args.what == "list":
        q = urllib.parse.urlencode({k: v for k, v in (("board", args.board), ("kind", args.kind), ("q", args.q)) if v})
        rows = _json.loads(call("/api/files" + (f"?{q}" if q else "")))
        if not rows:
            print("no files")
        for d in rows:
            ctx = d.get("context") or {}
            at = ctx.get("board") or ctx.get("model") or ctx.get("room") or "-"
            who = (d.get("by") or {}).get("name") or "?"
            print(f"{d['id']}  {d['kind']:<10} {d['bytes'] // 1024:>7} kB  {d['created_at'][:16]}  "
                  f"{at:<24} {d['name']}  ({who})" + (f"\n{'':14}{d['note']}" if d.get("note") else ""))
    elif args.what == "get":
        if not args.target:
            sys.exit("files get needs a file id (files list)")
        meta = {d["id"]: d for d in _json.loads(call("/api/files"))}.get(args.target)
        data = call(f"/api/files/{args.target}")
        out = Path(args.out or (meta or {}).get("name") or args.target)
        out.write_bytes(data)
        print(f"wrote {out} ({len(data)} bytes)" + (f" - a {meta['kind']}" if meta else ""))
    elif args.what == "put":
        src = Path(args.target or "")
        if not src.is_file():
            sys.exit(f"files put needs a file: {src}")
        ctx = {"room": os.environ.get("REDLINE_ROOM", "pcb" if args.board else "cad"),
               **({"board": args.board} if args.board else {})}
        b = uuid.uuid4().hex
        parts = [("context", _json.dumps(ctx).encode(), None), ("note", (args.note or "").encode(), None)]
        body = b"".join(
            f"--{b}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n".encode() + v + b"\r\n"
            for n, v, _ in parts)
        body += (f"--{b}\r\nContent-Disposition: form-data; name=\"upload\"; filename=\"{src.name}\"\r\n"
                 f"Content-Type: application/octet-stream\r\n\r\n").encode() + src.read_bytes() + f"\r\n--{b}--\r\n".encode()
        got = _json.loads(call("/api/files", "POST", body, f"multipart/form-data; boundary={b}"))
        for d in got:
            print(f"kept {d['name']} as {d['id']} ({d['kind']}, {d['bytes']} bytes)")


def main() -> None:
    # The repo's .env, before anything reads the environment: the token
    # (REDLINE_TOKEN) is needed by the API-backed commands - `board ...` - as
    # well as by the database ones. What the shell already set wins.
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("queue")
    s.add_argument("--room", choices=["cad", "pcb"],
                   help="only this room's notes")
    s.set_defaults(fn=cmd_queue)
    s = sub.add_parser("kind", help="which room a revision belongs to")
    s.add_argument("id")
    s.set_defaults(fn=cmd_kind)
    s = sub.add_parser("chat", help="read what the person said")
    s.add_argument("--limit", type=int, default=40)
    s.add_argument("--keep-unread", action="store_true",
                   help="look without picking it up")
    s.add_argument("--room", choices=["cad", "pcb"],
                   help="only this room's thread (each tab has its own)")
    s.set_defaults(fn=cmd_chat)
    s = sub.add_parser("say", help="answer in the thread")
    s.add_argument("text")
    s.add_argument("--room", choices=["cad", "pcb"],
                   help="which room's thread; default: where the person last spoke")
    s.set_defaults(fn=cmd_say)
    s = sub.add_parser("ask", help="ask the person a question on their screen")
    s.add_argument("text", help="the question, in Markdown - it is rendered "
                                "on their screen. Ask as you would a systems "
                                "engineer who is not a specialist here: the "
                                "decision in one plain sentence, what each "
                                "choice means for the product, no jargon; "
                                "numbers and net names go in -c")
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
    s.add_argument("what", choices=["find", "pins", "ato", "passive", "keep", "seat"],
                   help="find: ranked search; pins: a part's pinout; "
                        "ato: component blocks to paste into a board; "
                        "passive: R/C by value and size, e.g. R 10k 0402; "
                        "keep: fetch footprints and models ahead of a layout, "
                        "waiting out LCSC's budget (--refresh: again, for parts "
                        "already in the drawer); "
                        "seat C... | all: put stored parts' 3D bodies on their "
                        "pads (rewrites the footprint's model offset)")
    s.add_argument("args", nargs="+",
                   help="a search for find, LCSC numbers (C...) for pins/ato, "
                        "KIND VALUE SIZE for passive")
    s.add_argument("--refresh", action="store_true",
                   help="keep: fetch the footprint and 3D model again even for a part "
                        "already in the drawer, and seat the model; says when "
                        "LCSC/EasyEDA has no 3D model for it")
    s.set_defaults(fn=cmd_part)
    s = sub.add_parser("board", help="a board: its source, and the whole pipeline")
    s.add_argument("what", choices=["run", "show", "source", "save", "rules",
                                    "rules-save", "rules-schema", "convert", "hold"],
                   help="run: build, schematic, place, route, DRC; show: where it "
                        "stands; source/save: read or write its atopile; rules: "
                        "the routing rules as JSON (to a file if given); "
                        "rules-save: write them back, checked; rules-schema: "
                        "what every rule field is; convert: an imported board "
                        "to atopile, built and checked; hold <id> on|off: keep a "
                        "converted board's layout, or let the placer redo it")
    s.add_argument("board", nargs="?")
    s.add_argument("file", nargs="?", help="for save: the .ato file; for rules / "
                                           "rules-save: the JSON file; for hold: on|off")
    s.add_argument("--bom", help="convert: a BOM CSV (Designator, Footprint, Value, "
                                 "LCSC Part) - replaces guessed parts")
    s.add_argument("--part", action="append", metavar="REF=C12345",
                   help="convert: choose a part for a designator (R1,R2=C... for "
                        "several); kept on the board, marked GUESSED")
    s.add_argument("--picks", help="convert: a JSON file of ref -> {lcsc, why}")
    s.add_argument("--why", help="convert: the reason written beside --part picks")
    s.add_argument("--run", action="store_true",
                   help="convert: then run the whole pipeline")
    s.add_argument("--force", action="store_true",
                   help="convert: write over hand edits to the source made since the last "
                        "convert (the edited source is kept as a backup revision first)")
    s.add_argument("--keep-edits", action="store_true",
                   help="convert: carry hand edits over onto the new source (a three-way "
                        "merge); refused where they conflict")
    s.add_argument("--rev", help="source: a backup revision of the source (from a forced "
                                 "or merged convert) instead of the current one")
    s.set_defaults(fn=cmd_board)
    s = sub.add_parser("component", help="components: models and boards as 3D designs import "
                                         "them - versions, uses, pins")
    s.add_argument("what", choices=["list", "show", "deps", "pin", "refresh"],
                   help="list: every component with its version, uses and used-by counts; "
                        "show <id>: versions, uses / used by, pins, state, a board's named data; "
                        "deps <id> [--tree]: what it uses and what uses it; "
                        "pin <model> <component> <version|latest>: use a component at a "
                        "version, or follow its latest (rebuilds the model); "
                        "refresh <board>: its 3D component from its layout now")
    s.add_argument("id", nargs="?", help="a model or board id (model:<id> / board:<id> when both)")
    s.add_argument("component", nargs="?", help="pin: the component the model uses")
    s.add_argument("version", nargs="?", help="pin: a kept version (3 or v3), or latest")
    s.add_argument("--tree", action="store_true", help="deps: the whole tree, both ways")
    s.set_defaults(fn=cmd_component, sync=True)
    s = sub.add_parser("wait", help="block until a revision is queued")
    s.add_argument("--every", type=int, default=30,
                   help="seconds between checks (default 30)")
    s.add_argument("--timeout", type=int, default=0,
                   help="give up after N seconds; 0 waits for as long as the "
                        "session lasts")
    s.add_argument("--ignore", nargs="*",
                   help="revision ids to not count as new work")
    s.add_argument("--room", choices=["cad", "pcb"],
                   help="only this room's notes and thread; default: every room")
    s.set_defaults(fn=cmd_wait)
    s = sub.add_parser("files", help="the Files tab: what people uploaded (a BOM, a datasheet...)")
    s.add_argument("what", nargs="?", default="list", choices=["list", "get", "put"],
                   help="list (the default), get <id> [-o PATH], put <path>")
    s.add_argument("target", nargs="?", help="get: the file's id; put: the file to upload")
    s.add_argument("-o", "--out", help="get: where to write it (default: its own name)")
    s.add_argument("--board", help="list: only this board's; put: link it to this board")
    s.add_argument("--kind", help="list: only this kind (bom, pick-place, pdf, image...)")
    s.add_argument("-q", help="list: search the names and notes")
    s.add_argument("--note", help="put: a line about the file")
    s.set_defaults(fn=cmd_files)
    s = sub.add_parser("show"); s.add_argument("id"); s.add_argument("-o", "--out")
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("done"); s.add_argument("id"); s.set_defaults(fn=cmd_done)
    s = sub.add_parser("start"); s.add_argument("id")
    s.add_argument("title", nargs="?", default="",
                   help="what you are doing (optional with --take-over)")
    s.add_argument("--force", action="store_true",
                   help="open it even though another note's run is open in the room")
    s.add_argument("--take-over", action="store_true", dest="take_over",
                   help="take this note over from the agent it is running under "
                        "(recorded: who from whom, when)")
    s.set_defaults(fn=cmd_start)
    s = sub.add_parser("log"); s.add_argument("text")
    s.add_argument("-p", "--percent", type=float)
    s.add_argument("-l", "--level", default="info",
                   choices=["info", "work", "done", "warn", "error"])
    s.add_argument("--room", default="cad",
                   choices=["cad", "pcb"],
                   help="whose log: cad for models (default), pcb for boards")
    s.set_defaults(fn=cmd_log)
    s = sub.add_parser("finish")
    s.add_argument("id", nargs="?",
                   help="the revision whose run to close; without it, whatever "
                        "the shared run points at")
    s.add_argument("--failed", action="store_true")
    s.add_argument("--room", default="cad",
                   choices=["cad", "pcb"],
                   help="without an id: which room's run to close")
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
    s.add_argument("--width", type=int, default=None,
                   help="default: the note's own canvas size, else its drawing's")
    s.add_argument("--height", type=int, default=None)
    s.add_argument("--only", help="show only this part, as in render.py")
    s.set_defaults(fn=cmd_after)
    s = sub.add_parser("usage", help="pull LLM usage from the agent transcripts")
    s.add_argument("--full", action="store_true",
                   help="re-read every transcript from the start")
    s.add_argument("-r", "--revision", help="also re-roll this revision's numbers")
    s.add_argument("--reattribute", action="store_true",
                   help="re-cost every costed note by the agent that worked it "
                        "(notes whose agent cannot be told are marked approximate)")
    s.set_defaults(fn=cmd_usage)
    s = sub.add_parser("summaries", help="backfill the one-line card summaries")
    s.add_argument("--all", action="store_true", help="redo cards that have one")
    s.add_argument("--force", action="store_true", help="replace hand-written ones")
    s.add_argument("--limit", type=int, default=0)
    s.set_defaults(fn=cmd_summaries)
    args = ap.parse_args()
    # Everything this command writes is the agent's, named by REDLINE_AGENT.
    from backend import actors
    actors.CURRENT.set(actors.agent())
    if getattr(args, "sync", False):
        args.fn(args)
        return
    asyncio.run(args.fn(args))


if __name__ == "__main__":
    main()
