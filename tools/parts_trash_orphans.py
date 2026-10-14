"""Stock lines and product files left behind by deletes from before
Parts' Deleted (backend/parts_trash.py), moved into it: each orphan a unit
"deleted with <maker> on <date>", restorable for its days from now. Nothing
is deleted for good. Every workspace, a dry run unless --apply.

    .venv/bin/python tools/parts_trash_orphans.py            # what would move
    .venv/bin/python tools/parts_trash_orphans.py --apply    # move it
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


async def main(apply: bool) -> None:
    from dotenv import dotenv_values
    from motor.motor_asyncio import AsyncIOMotorClient

    from backend import actors, parts_trash, scope
    cfg = {**dotenv_values(ROOT / ".env"), **os.environ}
    raw = AsyncIOMotorClient(cfg["MONGODB_URI"]).get_default_database(cfg.get("MONGODB_DB") or "redline")
    spaces = {scope.DEFAULT}
    for coll in ("inventory", "product_files"):
        spaces |= {w for w in await raw[coll].distinct("workspace_id") if w}
    actors.CURRENT.set({"id": "system", "name": "Workbench", "type": "system"})
    for ws in sorted(spaces):
        tok = scope.WORKSPACE.set(ws)
        try:
            got = await parts_trash.adopt_orphans(scope.ScopedDb(raw, ws), apply=apply)
        finally:
            scope.WORKSPACE.reset(tok)
        print(f"{ws}: {len(got)} product(s) " + ("moved" if apply else "to move"))
        for g in got:
            print(f"  {g['name']} [{g['maker']}] - {g['note']}; {len(g['stock'])} stock line(s), {g['files']} file(s)"
                  + (f" -> unit {g['unit']}" if g["unit"] else ""))
            for s in g["stock"]:
                print(f"    {s}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="move them (else a dry run)")
    asyncio.run(main(ap.parse_args().apply))
