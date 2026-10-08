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
    python tools/revisions.py files put <path> [--board B] [--note TEXT] [--folder F]  keep one there
    python tools/revisions.py files [--folder F]                   what is in a Files folder
    python tools/revisions.py files mkdir <a/b>                    a folder (and its parents)
    python tools/revisions.py files mv <id|folder> <folder|/>      move a file or a folder

Firmware - the Firmware room's projects (backend/firmware.py) and the notes
filed on them (backend/fwnotes.py); through the server, like `board`:

    python tools/revisions.py next --room firmware                 the next queued note, in full
    python tools/revisions.py fw files <fw> [prefix]               the files, at the latest version
    python tools/revisions.py fw get <fw> <path> [-o FILE] [--version N]
    python tools/revisions.py fw put <fw> <path> <file> [<path> <file> ...] [--base N] [--note TEXT]
    python tools/revisions.py fw pins <fw>                          the MCU's pins, nets, parts, used where
    python tools/revisions.py fw build <fw> [--wait]                errors, warnings, flash and RAM
    python tools/revisions.py fw diff <fw> [vA vB]                  what changed between two versions

`fw put` is refused when the firmware moved on since the version it was
written against (`--base`, default: the version `fw get` / `fw files` last
read). `finish <id>` on a firmware note is refused until the version with
the change has built cleanly; it keeps the diff, the build and a picture of
the main changed hunk on the card.
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
    # Direct, but still one account's space - the owner's ("default") unless
    # REDLINE_WORKSPACE says otherwise - so this agent never sees, queues or
    # works on another account's notes (backend/scope.py).
    from backend import scope
    ws = os.getenv("REDLINE_WORKSPACE", "").strip() or scope.DEFAULT
    scope.WORKSPACE.set(ws)
    return scope.ScopedDb(AsyncIOMotorClient(uri)[os.getenv("MONGODB_DB", "redline")], ws)


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
        if d.get("kind") == "firmware":
            from backend import fwnotes
            print(f"\n#{i}  {d['_id']}   [FIRMWARE]")
            print(f"   note  : {d['comment']}")
            print(f"   fw    : {d.get('model') or '-'}    at: {fwnotes.anchor_text(d.get('anchor'))}")
            print(f"   time  : {d['created_at'][:19].replace('T', ' ')}")
            print(f"   in full: python tools/revisions.py show {d['_id']}")
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
    elif args.what == "changes":
        # A converted board changed on purpose: these nets and parts differ
        # from the import because a note asked for it. Marked, not hidden.
        out = call(f"/api/boards/{bid}/changes", "PUT",
                   {"nets": args.net or [], "parts": args.ref or [],
                    "why": args.why or "", "clear": bool(args.clear)})
        for ch in out.get("changes") or []:
            print(f"  changed    {', '.join(ch['nets'] + ch['parts'])}: {ch['why']}")
        if out.get("equivalence"):
            _print_equivalence(out["equivalence"])
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
    if eq.get("explained"):
        print(f"             every difference was made on purpose ({eq.get('intended')})")
    for d in eq.get("differences") or []:
        print(f"             {'changed' if d.get('intended') else 'differs'}: {d}")
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
        for ref, spot in (lay.get("placed_new") or {}).items():
            print(f"  new part   {ref} " + (f"placed in free room at {spot[0]}, {spot[1]} mm, {spot[2]} deg"
                                            if spot else "NOT placed: no free room on the board"))
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
                              args.context, args.multi, getattr(args, "room", None))
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
    if doc.get("kind") == "firmware":
        await _show_firmware_note(db, doc)
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


async def _show_firmware_note(db, doc: dict) -> None:
    """What a firmware note is about: the firmware, the pin or the code it
    is anchored to as it is now, and where its build stands."""
    from backend import firmware, fwnotes

    fid = doc.get("model") or ""
    print("[FIRMWARE NOTE] - read AGENTS.md, \"Firmware notes\", before touching it")
    try:
        fw = await firmware.get(db, fid)
    except KeyError:
        print(f"firmware: {fid} - GONE")
        return
    a = doc.get("anchor") or {}
    print(f"firmware: {fw.get('title')} ({fid}) - board {fw.get('board')} {fw.get('mcu')}, "
          f"{fw.get('pio_board')}/{fw.get('framework')}, files v{fw.get('version')}")
    print(f"about   : {fwnotes.anchor_text(a or None)}")
    if a.get("kind") == "code":
        lo, hi = a.get("lines") or [1, 1]
        try:
            got = await firmware.read(db, fid, a["file"])
            lines = got["content"].splitlines()
            print(f"code    : {a['file']} lines {lo}-{hi} as they are now"
                  + (f" (the note was written against v{a.get('version')})" if a.get("version") != fw.get("version") else ""))
            for n in range(max(1, lo - 3), min(len(lines), hi + 3) + 1):
                mark = ">" if lo <= n <= hi else " "
                print(f"  {mark}{n:5d}  {lines[n - 1]}")
            if a.get("excerpt") is not None and "\n".join(lines[lo - 1:hi]) != a["excerpt"]:
                print("  (these lines changed since the note was written; it was about:)")
                for n, t in enumerate(a["excerpt"].splitlines(), lo):
                    print(f"  |{n:5d}  {t}")
        except (KeyError, firmware.Refused):
            print(f"code    : {a.get('file')} is no longer in the project")
    elif a.get("kind") in ("pin", "net") and a.get("macro"):
        uses = firmware.used_in(await firmware.contents(db, fid), [a["macro"]]).get(a["macro"]) or []
        print(f"in code : {a['macro']} " + (f"used in {', '.join(uses)}" if uses else "not used in the code yet")
              + (" - INPUT ONLY pin" if a.get("gpio") in firmware.ESP32_INPUT_ONLY else "")
              + (" - strapping pin" if a.get("gpio") in firmware.ESP32_STRAPPING else ""))
    b = fw.get("build") or {}
    if b.get("state"):
        sz = (f", flash {b['flash']['pct']}% RAM {b['ram']['pct']}%" if b.get("flash") and b.get("ram") else "")
        print(f"build   : {b['state']} - v{b.get('version')}, {b.get('error_count', 0)} errors, "
              f"{b.get('warning_count', 0)} warnings{sz}")
    else:
        print("build   : never built")
    if doc.get("fw_result"):
        print(f"result  : {fwnotes.result_line(doc['fw_result'])}")
    print(f"files   : python tools/revisions.py fw files {fid}   (then fw get / fw put / fw build --wait)")


async def cmd_next(args):
    """The oldest queued note nobody has started, in full - one room's."""
    from backend import compute

    db = connect()
    rows = [d async for d in db.revisions.find({"status": "queued"})]
    rows = [d for d in rows if not d.get("archived")]
    if args.room:
        rows = [d for d in rows if compute.room_of(d.get("kind")) == args.room]
    if rows:
        busy = {r["_id"] async for r in db.runs.find(
            {"_id": {"$in": [d["_id"] for d in rows]}, "status": {"$in": ["running", "done", "failed"]}})}
        rows = [d for d in rows if d["_id"] not in busy]
    rows.sort(key=lambda d: d.get("queued_at") or d["created_at"])
    if not rows:
        print("nothing queued" + (f" in {args.room}" if args.room else ""))
        sys.exit(2)
    d = rows[0]
    print(f"next    : {d['_id']}   [{compute.room_of(d.get('kind'))}]")
    await cmd_show(argparse.Namespace(id=d["_id"], out=args.out))


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
    # A firmware note is finished when the version holding the change has
    # built cleanly: checked before the run is closed, so a refusal leaves
    # it open. Its "after" is the diff, the build and a picture of the main
    # changed hunk (backend/fwnotes.py), not a render.
    target = args.id or cur.get("revision")
    fw_note = False
    if target:
        tdoc = await db.revisions.find_one({"_id": target}) or {}
        fw_note = tdoc.get("kind") == "firmware"
    if fw_note and not args.failed:
        from backend import fwnotes
        try:
            got = await fwnotes.result(db, target)
        except fwnotes.Refused as exc:
            sys.exit(f"not finished - {exc}")
        print(f"firmware: {len(got['files'])} file(s), +{got['added']} -{got['removed']}"
              + (f", main change {got['main']['file']}:{got['main']['line']}" if got.get("main") else ""))
        print(f"build   : {fwnotes.result_line(got)}")
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
    # Finishing closes the run; the note stays queued until the person has
    # looked at it and marked it applied (or `done <id>` when they said so).
    if status == "done" and cur.get("revision"):
        print("finished - waiting for the person to review and mark it applied"
              + (" (built, ready to flash - flashing is theirs, from the browser)" if fw_note else ""))

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
    if rev and not args.no_shot and not fw_note:
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
                     else f"${t['cost_usd']:.4f} (list price)")
            print(f"analytics: {t['calls']} calls, "
                  f"{t['billed_tokens']:,} tokens, {money}, "
                  f"{doc['seconds']:.0f} s")
            c = doc.get("compute") or {}
            ct = c.get("totals") or {}
            if ct.get("jobs"):
                print(f"compute  : {ct['jobs']} jobs, {ct['core_min']:.1f} "
                      f"core-min, peak {ct.get('peak_rss_mb') or 0:.0f} MB, "
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
    # An after shot never waits for a build: said, not left to render.py to
    # infer from REDLINE_REVISION.
    argv = [sys.executable, str(ROOT / "tools" / "render.py"), rid, "-o", str(out), "--no-wait"]
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
    doc = await db.revisions.find_one({"_id": args.id})
    if not doc:
        sys.exit(f"{args.id} not found")
    if doc.get("kind") == "firmware":
        sys.exit("a firmware note has no camera: `finish <id>` keeps its after picture "
                 "(the main changed hunk), its diff and its build on the card")
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

    def folders() -> list[dict]:
        return _json.loads(call("/api/files/folders"))

    def folder_id(path: str | None, make: bool = False) -> str:
        """A Files folder by its path ("/" or "" is the top)."""
        want = (path or "").strip().strip("/")
        if not want:
            return ""
        got = next((f for f in folders() if f["path"].lower() == want.lower()), None)
        if got is None and make:
            got = _json.loads(call("/api/files/folders", "POST", _json.dumps({"path": want}).encode(),
                                   "application/json"))
        if got is None:
            sys.exit(f"no folder {want!r} in Files (files mkdir {want})")
        return got["id"]

    if args.what == "list":
        where = {k: v for k, v in (("board", args.board), ("kind", args.kind), ("q", args.q)) if v}
        if args.folder is not None:
            where["folder"] = folder_id(args.folder)
        q = urllib.parse.urlencode(where)
        rows = _json.loads(call("/api/files" + (f"?{q}" if q else "")))
        paths = {f["id"]: f["path"] for f in folders()}
        if not rows:
            print("no files")
        for d in rows:
            ctx = d.get("context") or {}
            at = ctx.get("board") or ctx.get("model") or ctx.get("room") or "-"
            who = (d.get("by") or {}).get("name") or "?"
            place = paths.get(d.get("folder") or "", "")
            print(f"{d['id']}  {d['kind']:<10} {d['bytes'] // 1024:>7} kB  {d['created_at'][:16]}  "
                  f"{at:<24} {place + '/' if place else ''}{d['name']}  ({who})"
                  + (f"\n{'':14}{d['note']}" if d.get("note") else ""))
    elif args.what == "mkdir":
        if not args.target:
            sys.exit("files mkdir needs a path, e.g. datasheets/power")
        got = _json.loads(call("/api/files/folders", "POST", _json.dumps({"path": args.target}).encode(),
                               "application/json"))
        print(f"folder {got['path']} ({got['id']})")
    elif args.what == "mv":
        if not args.target or args.dest is None:
            sys.exit("files mv needs a file id or a folder path, and the folder it goes into ('/' is the top)")
        to = folder_id(args.dest)
        ids = {d["id"] for d in _json.loads(call("/api/files"))}
        body = {"files": [args.target], "folders": [], "to": to} if args.target in ids else \
            {"files": [], "folders": [folder_id(args.target)], "to": to}
        got = _json.loads(call("/api/files/move", "POST", _json.dumps(body).encode(), "application/json"))
        print(f"moved {got['files']} file(s), {got['folders']} folder(s) to {args.dest.strip('/') or '/'}")
    elif args.what == "get":
        if not args.target:
            sys.exit("files get needs a file id (files list)")
        meta = {d["id"]: d for d in _json.loads(call("/api/files"))}.get(args.target)
        data = call(f"/api/files/{args.target}")
        out = Path(args.out or (meta or {}).get("name") or args.target)
        out.write_bytes(data)
        print(f"wrote {out} ({len(data)} bytes)" + (f" - a {meta['kind']}" if meta else ""))
    elif args.what == "to-model":
        # A STEP/mesh from the Files tab copied into a project folder as a
        # model of its own - it stays whole if the file is deleted from Files.
        if not args.target or not args.folder:
            sys.exit("files to-model needs a file id and --folder (e.g. iot-fan/purchased)")
        body = {"folder": args.folder, **({"title": args.title} if args.title else {})}
        got = _json.loads(call(f"/api/files/{args.target}/to-model", "POST",
                               _json.dumps(body).encode(), "application/json"))
        print(f"model {got['model']} ({got['title']}) from {got['upload']} - building (job {got.get('build_job')})")
    elif args.what == "put":
        src = Path(args.target or "")
        if not src.is_file():
            sys.exit(f"files put needs a file: {src}")
        ctx = {"room": os.environ.get("REDLINE_ROOM", "pcb" if args.board else "cad"),
               **({"board": args.board} if args.board else {})}
        b = uuid.uuid4().hex
        parts = [("context", _json.dumps(ctx).encode(), None), ("note", (args.note or "").encode(), None),
                 ("folder", folder_id(args.folder, make=True).encode(), None)]
        body = b"".join(
            f"--{b}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n".encode() + v + b"\r\n"
            for n, v, _ in parts)
        body += (f"--{b}\r\nContent-Disposition: form-data; name=\"upload\"; filename=\"{src.name}\"\r\n"
                 f"Content-Type: application/octet-stream\r\n\r\n").encode() + src.read_bytes() + f"\r\n--{b}--\r\n".encode()
        got = _json.loads(call("/api/files", "POST", body, f"multipart/form-data; boundary={b}"))
        for d in got:
            print(f"kept {d['name']} as {d['id']} ({d['kind']}, {d['bytes']} bytes)")


# ---------------------------------------------------------------- firmware

def _fw_state(fid: str) -> Path:
    """Where the version this agent last read of a firmware is kept, so
    `fw put` can say which version its change was written against."""
    return Path(tempfile.gettempdir()) / f"redline-fw-{fid}.json"


def _fw_seen(fid: str, version: int) -> None:
    try:
        _fw_state(fid).write_text(json.dumps({"version": int(version)}))
    except OSError:
        pass


def _fw_id(name: str) -> str:
    """A firmware by its id, or by its title or name ("U2 ESP32", u2-esp32)."""
    rows = api_call("/api/firmware")
    for f in rows:
        if name in (f["id"], f.get("title"), f.get("name")):
            return f["id"]
    low = name.lower()
    hits = [f for f in rows if low in (f.get("title") or "").lower() or low in (f.get("board") or "").lower()]
    if len(hits) == 1:
        return hits[0]["id"]
    sys.exit(f"no firmware {name!r}: " + ", ".join(f"{f['id']} ({f.get('title')} on {f.get('board')})" for f in rows))


def _size_text(s: dict | None) -> str:
    return f"{s['pct']}% ({s['used'] // 1024} of {s['total'] // 1024} KB)" if s else "-"


def _print_build(job: dict) -> bool:
    r = job.get("result") or {}
    status = job.get("status")
    if status != "done" or not r:
        print(f"build {job.get('job')}: {status} - {job.get('detail') or 'see the room log'}")
        return False
    ok = bool(r.get("ok"))
    print(f"build {job.get('job')} of v{r.get('version', job.get('version'))}: "
          f"{'OK' if ok else 'FAILED'} - {r.get('error_count', 0)} errors, {r.get('warning_count', 0)} warnings"
          f" · {job.get('seconds')} s")
    for e in r.get("errors") or []:
        print(f"  error   {str(e.get('file', '')).replace('/project/', '')}:{e.get('line') or '-'}: {e.get('text')}")
    for w in r.get("warnings") or []:
        print(f"  warning {str(w.get('file', '')).replace('/project/', '')}:{w.get('line') or '-'}: {w.get('text')}")
    if ok:
        print(f"  flash {_size_text(r.get('flash'))} · RAM {_size_text(r.get('ram'))}")
    return ok


def cmd_fw(args):
    """A firmware's files, builds and versions, through the server."""
    import time as _time
    import urllib.parse

    fid = _fw_id(args.fw)
    rest = args.rest or []
    if args.what == "files":
        fw = api_call(f"/api/firmware/{fid}")
        _fw_seen(fid, fw["version"])
        b = fw.get("build") or {}
        print(f"{fw['title']} ({fid}) v{fw['version']} - board {fw['board']} {fw['mcu']}; "
              f"last build: {b.get('state') or 'none'}" + (f" of v{b.get('version')}" if b.get("state") else ""))
        for f in api_call(f"/api/firmware/{fid}/files"):
            if rest and not f["path"].startswith(rest[0]):
                continue
            print(f"  {f['path']:<28} {f['bytes']:>7} B  v{f['version']}"
                  + ("   GENERATED from the schematic - never edit" if f.get("generated") else ""))
    elif args.what == "get":
        if not rest:
            sys.exit("fw get <fw> <path> [-o FILE]")
        q = f"?version={args.version}" if args.version else ""
        got = api_call(f"/api/firmware/{fid}/files/{_q(rest[0])}{q}")
        if not args.version:
            _fw_seen(fid, api_call(f"/api/firmware/{fid}")["version"])
        if args.out:
            Path(args.out).write_text(got["content"])
            print(f"wrote {args.out} - {got['path']} as of v{got['version']}"
                  + (" (GENERATED - read it, never edit it)" if got.get("generated") else ""))
        else:
            sys.stdout.write(got["content"])
    elif args.what == "put":
        if len(rest) < 2 or len(rest) % 2:
            sys.exit("fw put <fw> <path> <local file> [<path> <local file> ...]")
        files = {}
        for path, local in zip(rest[::2], rest[1::2]):
            src = Path(local)
            if not src.is_file():
                sys.exit(f"no file {local}")
            files[path] = src.read_text()
        base = args.base
        if base is None:
            try:
                base = json.loads(_fw_state(fid).read_text())["version"]
            except (OSError, ValueError, KeyError):
                sys.exit("which version is this change written against? `fw files` or `fw get` first, "
                         "or --base N")
        got = api_call(f"/api/firmware/{fid}/files", "POST",
                       {"files": files, "note": args.note or "", "base": base})
        if got.get("changed"):
            _fw_seen(fid, got["version"])
            print(f"saved v{got['version']} (on v{base}): {', '.join(got['changed'])}")
            print(f"build it: python tools/revisions.py fw build {fid} --wait")
        else:
            print(f"nothing changed - still v{got['version']}")
    elif args.what == "pins":
        fw = api_call(f"/api/firmware/{fid}")
        print(f"{fw['mcu']} {fw.get('mcu_title') or ''} - pins.h "
              + ("matches the board" if fw.get("matches") else "DOES NOT match the board (regenerated on the next draw)"))
        for p in fw.get("pins") or []:
            if p["kind"] != "gpio":
                continue
            flags = (" input-only" if p.get("input_only") else "") + (" strapping" if p.get("strapping") else "")
            print(f"  {p['name']:<10} GPIO{p['gpio']:<3} {p.get('macro') or p.get('net') or '-':<14} "
                  f"{', '.join(p.get('parts') or []) or '-':<34} "
                  f"{'used in ' + ', '.join(p['used_in']) if p.get('used_in') else 'unused'}{flags}")
    elif args.what == "build":
        try:
            job = api_call(f"/api/firmware/{fid}/build", "POST", {})
            print(f"building v{job.get('version')} - job {job['job']}")
        except ApiError as exc:
            if " 409 " not in str(exc):
                raise
            jid = (api_call(f"/api/firmware/{fid}").get("build") or {}).get("job")
            print(f"a build is already running (job {jid})")
            job = {"job": jid}
        if not args.wait:
            print(f"follow it: python tools/revisions.py fw build {fid} --wait  (or the room's log)")
            return
        while True:
            cur = api_call(f"/api/firmware/{fid}/builds/{job['job']}")
            if cur.get("status") != "running":
                break
            _time.sleep(2)
        if not _print_build(cur):
            sys.exit(1)
    elif args.what == "diff":
        q = urllib.parse.urlencode({k: v for k, v in (("a", rest[0] if rest else None),
                                                       ("b", rest[1] if len(rest) > 1 else None)) if v})
        got = api_call(f"/api/firmware/{fid}/diff" + (f"?{q}" if q else ""))
        print(f"v{got['a']} -> v{got['b']}: {len(got['files'])} file(s), +{got['added']} -{got['removed']}")
        for f in got["files"]:
            print(f"\n=== {f['path']} ({f['status']}, +{f['added']} -{f['removed']})")
            print(f["diff"])


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
    s.add_argument("--room", choices=["cad", "pcb", "firmware"],
                   help="only this room's notes")
    s.set_defaults(fn=cmd_queue)
    s = sub.add_parser("kind", help="which room a revision belongs to")
    s.add_argument("id")
    s.set_defaults(fn=cmd_kind)
    s = sub.add_parser("chat", help="read what the person said")
    s.add_argument("--limit", type=int, default=40)
    s.add_argument("--keep-unread", action="store_true",
                   help="look without picking it up")
    s.add_argument("--room", choices=["cad", "pcb", "firmware"],
                   help="only this room's thread (each tab has its own)")
    s.set_defaults(fn=cmd_chat)
    s = sub.add_parser("say", help="answer in the thread")
    s.add_argument("text")
    s.add_argument("--room", choices=["cad", "pcb", "firmware"],
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
    s.add_argument("--room", choices=["cad", "pcb", "firmware"],
                   help="whose thread it shows in (default: the revision's room)")
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
                                    "rules-save", "rules-schema", "convert", "hold",
                                    "changes"],
                   help="run: build, schematic, place, route, DRC; show: where it "
                        "stands; source/save: read or write its atopile; rules: "
                        "the routing rules as JSON (to a file if given); "
                        "rules-save: write them back, checked; rules-schema: "
                        "what every rule field is; convert: an imported board "
                        "to atopile, built and checked; hold <id> on|off: keep a "
                        "converted board's layout, or let the placer redo it; "
                        "changes <id> --net N --ref R --why ...: a converted board "
                        "differs from its import on purpose (--clear forgets them)")
    s.add_argument("board", nargs="?")
    s.add_argument("file", nargs="?", help="for save: the .ato file; for rules / "
                                           "rules-save: the JSON file; for hold: on|off")
    s.add_argument("--bom", help="convert: a BOM CSV (Designator, Footprint, Value, "
                                 "LCSC Part) - replaces guessed parts")
    s.add_argument("--part", action="append", metavar="REF=C12345",
                   help="convert: choose a part for a designator (R1,R2=C... for "
                        "several); kept on the board, marked GUESSED")
    s.add_argument("--picks", help="convert: a JSON file of ref -> {lcsc, why}")
    s.add_argument("--why", help="convert: the reason written beside --part picks; "
                                 "changes: why the board differs from its import")
    s.add_argument("--net", action="append", help="changes: a net changed on purpose (repeat)")
    s.add_argument("--ref", action="append", help="changes: a part added or changed on purpose (repeat)")
    s.add_argument("--clear", action="store_true", help="changes: forget the changes said so far")
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
    s.add_argument("--room", choices=["cad", "pcb", "firmware"],
                   help="only this room's notes and thread; default: every room")
    s.set_defaults(fn=cmd_wait)
    s = sub.add_parser("files", help="the Files tab: what people uploaded (a BOM, a datasheet...)")
    s.add_argument("what", nargs="?", default="list", choices=["list", "get", "put", "to-model", "mkdir", "mv"],
                   help="list (the default), get <id> [-o PATH], put <path>, mkdir <path>, "
                        "mv <id|folder path> <folder path>, "
                        "to-model <id> --folder F [--title T] (a STEP/mesh copied into a project as a model)")
    s.add_argument("target", nargs="?", help="get: the file's id; put: the file to upload; mkdir: a folder path; "
                                             "mv: a file id or a folder path")
    s.add_argument("dest", nargs="?", help="mv: the folder it goes into ('/' is the top)")
    s.add_argument("-o", "--out", help="get: where to write it (default: its own name)")
    s.add_argument("--board", help="list: only this board's; put: link it to this board")
    s.add_argument("--kind", help="list: only this kind (bom, pick-place, pdf, image...)")
    s.add_argument("-q", help="list: search the names and notes")
    s.add_argument("--note", help="put: a line about the file")
    s.add_argument("--folder", help="list/put: a Files folder by path ('/' the top; put makes it if missing); "
                                    "to-model: the catalog folder it goes in")
    s.add_argument("--title", help="to-model: the model's name (default: the file's)")
    s.set_defaults(fn=cmd_files)
    s = sub.add_parser("show"); s.add_argument("id"); s.add_argument("-o", "--out")
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("next", help="the oldest queued note nobody has started, in full")
    s.add_argument("--room", choices=["cad", "pcb", "firmware"], help="only this room's")
    s.add_argument("-o", "--out", help="where its drawing is written")
    s.set_defaults(fn=cmd_next)
    s = sub.add_parser("fw", help="a firmware's files, builds and versions (the Firmware room)")
    s.add_argument("what", choices=["files", "get", "put", "pins", "build", "diff"])
    s.add_argument("fw", help="firmware id, or its title (U2 ESP32)")
    s.add_argument("rest", nargs="*", help="files: a path prefix; get: a path; put: path file pairs; "
                                          "diff: two versions")
    s.add_argument("-o", "--out", help="get: write to this file instead of printing")
    s.add_argument("--version", type=int, help="get: as of this version")
    s.add_argument("--base", type=int, help="put: the version the change was written against; "
                                            "default: the version the last `fw files` / `fw get` "
                                            "of this firmware read (refused if neither ran)")
    s.add_argument("--note", help="put: what the change is (the version's note)")
    s.add_argument("--wait", action="store_true", help="build: wait for it and print the errors, warnings, "
                                                      "flash and RAM (default: off - start it and return)")
    s.set_defaults(fn=cmd_fw, sync=True)
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
                   choices=["cad", "pcb", "firmware"],
                   help="whose log: cad for models (default), pcb for boards, firmware")
    s.set_defaults(fn=cmd_log)
    s = sub.add_parser("finish")
    s.add_argument("id", nargs="?",
                   help="the revision whose run to close; without it, whatever "
                        "the shared run points at")
    s.add_argument("--failed", action="store_true")
    s.add_argument("--room", default="cad",
                   choices=["cad", "pcb", "firmware"],
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
