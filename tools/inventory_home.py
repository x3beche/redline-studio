"""Stock lines that count no Parts product, given one - once, for every
workspace (backend/inventory.py `home_unlinked`).

    .venv/bin/python tools/inventory_home.py           # what would be done
    .venv/bin/python tools/inventory_home.py --apply   # do it

Since stock became a part of the Parts page every stock line counts one
product. A line kept before that with no product (or with only a maker)
gets one: the LCSC drawer's part its LCSC number names, else a product of
My Items made from its own words (or the My Items product of the same code or
name). Its quantity, place, minimum and log stay; a line in its log says
what was done. Nothing is deleted, and a second run finds nothing to do.

It needs the database (MONGODB_URI in .env).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _raw():
    from dotenv import load_dotenv
    from motor.motor_asyncio import AsyncIOMotorClient
    load_dotenv(ROOT / ".env")
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        sys.exit("MONGODB_URI is not set (.env)")
    return AsyncIOMotorClient(uri)[os.getenv("MONGODB_DB", "redline")]


async def main(apply: bool) -> None:
    from backend import inventory as inv
    from backend import scope
    raw = _raw()
    spaces = sorted({d.get("workspace_id") or scope.DEFAULT
                     async for d in raw[inv.COLL].find({}, {"workspace_id": 1})} | {scope.DEFAULT})
    for ws in spaces:
        scope.WORKSPACE.set(ws)
        db = scope.ScopedDb(raw, ws)
        rows = await inv.everything(db)
        loose = [d for d in rows if not inv.linked_to(d)]
        print(f"{ws}: {len(rows)} stock line(s), {len(loose)} counting no product")
        for d in rows:
            if inv.linked_to(d):
                c = d["catalog"]
                got = await inv.catalog_builtin.find_product(db, c["manufacturer"], c["product"])
                print(f"  ok   {d['_id']}  {d.get('name')!r} -> {c['manufacturer']}:{c['product']}"
                      + ("" if got else "  (that product is not in Parts any more)"))
        if not loose:
            continue
        if not apply:
            for d in loose:
                print(f"  todo {d['_id']}  {d.get('name')!r}")
            continue
        for x in await inv.home_unlinked(db, {"id": "system", "name": "Workbench"}):
            c = x["catalog"]
            print(f"  done {x['id']}  {x['name']!r} -> {c['manufacturer']}:{c['product']} ({c.get('product_name')})")
    if not apply:
        print("(nothing written - --apply does it)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="write the changes (else only say them)")
    asyncio.run(main(ap.parse_args().apply))
