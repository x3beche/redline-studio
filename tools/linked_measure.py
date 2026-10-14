"""Measure the STEP of every saved McMaster-Carr part and GrabCAD model
that has one and is not measured yet - for every workspace
(backend/linked_measure.py).

    .venv/bin/python tools/linked_measure.py            # what would be measured
    .venv/bin/python tools/linked_measure.py --apply    # measure them
    .venv/bin/python tools/linked_measure.py --apply --again   # measured ones too

A STEP dropped on an item is measured when it is dropped; this is for the
items whose STEP came before that. Only an item whose `cad` is a STEP is
looked at; its specs are not changed - the measurement is kept beside
them. A second run finds nothing to do. It needs the database (MONGODB_URI
in .env) and OpenCascade (OCP), as the API's own Python has.
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


async def main(apply: bool, again: bool) -> None:
    from backend import catalog_builtin, linked, linked_measure, scope  # noqa: F401 - registers the sources
    raw = _raw()
    counts = {"items": 0, "step": 0, "todo": 0, "measured": 0, "failed": 0, "mismatch": 0}
    spaces = sorted({d.get("workspace_id") or scope.DEFAULT
                     async for d in raw[linked.COLL].find({}, {"workspace_id": 1})})
    for ws in spaces:
        scope.WORKSPACE.set(ws)
        db = scope.ScopedDb(raw, ws)
        rows = [d async for d in db[linked.COLL].find({})]
        steps = [d for d in rows if (d.get("cad") or {}).get("kind") == "step"]
        todo = [d for d in steps if again or linked_measure.stale(d)]
        counts["items"] += len(rows)
        counts["step"] += len(steps)
        counts["todo"] += len(todo)
        print(f"{ws}: {len(rows)} saved item(s), {len(steps)} with a STEP, {len(todo)} to measure")
        for d in todo:
            name = f"{d['source']}:{d['key']}"
            if not apply:
                print(f"  todo {name}  {d['cad']['name']}")
                continue
            m = await linked_measure.measure(db, d["_id"])
            if not m or m.get("error"):
                counts["failed"] += 1
                print(f"  fail {name}  {(m or {}).get('error')}")
                continue
            counts["measured"] += 1
            k = linked.KINDS.get(d["source"])
            v = linked_measure.view({**d, "measured": m}, k.specs_of if k else None) or {}
            counts["mismatch"] += bool(v.get("mismatch"))
            print(f"  done {name}  " + "; ".join(f"{a} {b}" for a, b in v.get("rows") or [])
                  + "".join(f"  MISMATCH {b['what']}: said {b['said']}, measured {b['measured']}" for b in v.get("mismatch") or []))
    print(" ".join(f"{a}={b}" for a, b in counts.items()))
    if not apply:
        print("(nothing measured - --apply does it)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="measure them (else only say which)")
    ap.add_argument("--again", action="store_true", help="measured ones too")
    a = ap.parse_args()
    asyncio.run(main(a.apply, a.again))
