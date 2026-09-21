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
"""

from __future__ import annotations

import argparse
import asyncio
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
        print(f"\n#{i}  {d['_id']}")
        print(f"   note  : {d['comment']}")
        print(f"   model : {d.get('model') or '-'}    part: {d.get('part') or '-'}")
        print(f"   time  : {d['created_at'][:19].replace('T', ' ')}")
        if cam.get("position"):
            print(f"   camera: pos {cam['position']} target {cam.get('target')}")
        print(f"   image : python tools/revisions.py show {d['_id']}")


async def cmd_show(args):
    from backend import store

    db = connect()
    doc = await db.revisions.find_one({"_id": args.id})
    if not doc:
        sys.exit(f"{args.id} not found")
    png = await store.get_shot(db, doc["image"]["gridfs_id"])
    out = Path(args.out or tempfile.gettempdir()) / f"{args.id}.png"
    out.write_bytes(png)
    print(f"note    : {doc['comment']}")
    print(f"model   : {doc.get('model') or '-'}   part: {doc.get('part') or '-'}")
    print(f"status  : {doc.get('status')}")
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
    db = connect()
    doc = {"_id": "current", "title": args.title, "revision": args.id,
           "model": None, "percent": 0.0, "status": "running",
           "started_at": _now(), "finished_at": None}
    await db.runs.replace_one({"_id": "current"}, doc, upsert=True)
    await db.activity.insert_one(_line(f"started: {args.title}", "work"))
    print(f"run started: {args.title}")


async def cmd_log(args):
    db = connect()
    await db.activity.insert_one(_line(args.text, args.level))
    if args.percent is not None:
        await db.runs.update_one({"_id": "current"},
                                 {"$set": {"percent": args.percent}})
    pct = "" if args.percent is None else f"  [{args.percent:.0f}%]"
    print(f"{args.text}{pct}")


async def cmd_finish(args):
    db = connect()
    status = "failed" if args.failed else "done"
    await db.runs.update_one(
        {"_id": "current"},
        {"$set": {"status": status, "percent": 100.0, "finished_at": _now()}},
        upsert=True)
    await db.activity.insert_one(_line(f"finished: {status}", status))
    print(f"run {status}")


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
    res = await build.build(db, args.model, ROOT / "export_model.py")
    sizes = ", ".join(f"{k} {v/1e6:.1f}MB" for k, v in res["artifacts"].items())
    print(f"{res['model']} built: {sizes}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("queue").set_defaults(fn=cmd_queue)
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
    s.set_defaults(fn=cmd_finish)
    sub.add_parser("models").set_defaults(fn=cmd_models)
    s = sub.add_parser("source"); s.add_argument("model"); s.set_defaults(fn=cmd_source)
    s = sub.add_parser("save"); s.add_argument("model"); s.add_argument("file")
    s.set_defaults(fn=cmd_save)
    s = sub.add_parser("build"); s.add_argument("model"); s.set_defaults(fn=cmd_build)
    args = ap.parse_args()
    asyncio.run(args.fn(args))


if __name__ == "__main__":
    main()
