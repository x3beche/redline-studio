#!/usr/bin/env python
"""Revizyon ve model komut satiri araci.

Sunucu calismiyorken de dogrudan MongoDB'ye baglanir; .env'deki MONGODB_URI
ve MONGODB_DB kullanilir.

    python tools/revisions.py queue                 siradaki revizyonlar
    python tools/revisions.py show <id> [-o DIZIN]  isaretli goruntuyu diske yaz
    python tools/revisions.py done <id>             uygulandi isaretle
    python tools/revisions.py models                model listesi
    python tools/revisions.py source <model>        kaynak kodu yazdir
    python tools/revisions.py save <model> <dosya>  kaynak kodu guncelle
    python tools/revisions.py build <model>         yeniden uret (viewer/STEP/STL)
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


def connect():
    from dotenv import load_dotenv
    from motor.motor_asyncio import AsyncIOMotorClient

    load_dotenv(ROOT / ".env")
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        sys.exit("MONGODB_URI tanimli degil (.env)")
    return AsyncIOMotorClient(uri)[os.getenv("MONGODB_DB", "assets_3d")]


async def cmd_queue(_):
    db = connect()
    rows = [d async for d in db.revisions.find({"status": "queued"})]
    rows.sort(key=lambda d: d.get("queued_at") or d["created_at"])
    if not rows:
        print("sirada revizyon yok")
        return
    for i, d in enumerate(rows, 1):
        cam = d.get("camera") or {}
        print(f"\n#{i}  {d['_id']}")
        print(f"   yorum : {d['comment']}")
        print(f"   model : {d.get('model') or '-'}    parca: {d.get('part') or '-'}")
        print(f"   zaman : {d['created_at'][:19].replace('T', ' ')}")
        if cam.get("position"):
            print(f"   kamera: konum {cam['position']} hedef {cam.get('target')}")
        print(f"   goruntu icin: python tools/revisions.py show {d['_id']}")


async def cmd_show(args):
    from backend import store

    db = connect()
    doc = await db.revisions.find_one({"_id": args.id})
    if not doc:
        sys.exit(f"{args.id} bulunamadi")
    png = await store.get_shot(db, doc["image"]["gridfs_id"])
    out = Path(args.out or tempfile.gettempdir()) / f"{args.id}.png"
    out.write_bytes(png)
    print(f"yorum   : {doc['comment']}")
    print(f"model   : {doc.get('model') or '-'}   parca: {doc.get('part') or '-'}")
    print(f"durum   : {doc.get('status')}")
    print(f"goruntu : {out}   ({len(png)} bayt)")
    print("\nBu dosyayi Read araciyla acip kirmizi isaretlere bak.")


async def cmd_done(args):
    db = connect()
    res = await db.revisions.update_one({"_id": args.id},
                                        {"$set": {"status": "applied"}})
    if res.matched_count == 0:
        sys.exit(f"{args.id} bulunamadi")
    print(f"{args.id} -> uygulandi")


async def cmd_models(_):
    db = connect()
    async for m in db.models.find({}, {"source": 0}):
        art = ", ".join(m.get("artifacts", {})) or "uretilmemis"
        flag = " (BAYAT)" if m.get("stale") else ""
        print(f"{m['_id']:24s} {m.get('title',''):22s} {art}{flag}")


async def cmd_source(args):
    db = connect()
    doc = await db.models.find_one({"_id": args.model})
    if not doc:
        sys.exit(f"{args.model} bulunamadi")
    sys.stdout.write(doc["source"])


async def cmd_save(args):
    from backend import store

    db = connect()
    doc = await store.save_model(db, args.model, Path(args.file).read_text())
    print(f"{doc['_id']} kaydedildi  hash={doc['sha256'][:12]}  ready={doc['ready']}")
    print("simdi: python tools/revisions.py build " + args.model)


async def cmd_build(args):
    from backend import build

    db = connect()
    res = await build.build(db, args.model, ROOT / "export_model.py")
    sizes = ", ".join(f"{k} {v/1e6:.1f}MB" for k, v in res["artifacts"].items())
    print(f"{res['model']} uretildi: {sizes}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("queue").set_defaults(fn=cmd_queue)
    s = sub.add_parser("show"); s.add_argument("id"); s.add_argument("-o", "--out")
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("done"); s.add_argument("id"); s.set_defaults(fn=cmd_done)
    sub.add_parser("models").set_defaults(fn=cmd_models)
    s = sub.add_parser("source"); s.add_argument("model"); s.set_defaults(fn=cmd_source)
    s = sub.add_parser("save"); s.add_argument("model"); s.add_argument("file")
    s.set_defaults(fn=cmd_save)
    s = sub.add_parser("build"); s.add_argument("model"); s.set_defaults(fn=cmd_build)
    args = ap.parse_args()
    asyncio.run(args.fn(args))


if __name__ == "__main__":
    main()
