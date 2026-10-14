"""Files to the generated-files rule, in every workspace (backend/files_migrate.py):
the agents' files from before today in the person's folders get a copy of
the person's own beside them, and the empty "Documents" folders go.

    .venv/bin/python tools/migrate_files.py            # what it would do
    .venv/bin/python tools/migrate_files.py --apply    # do it (safe to run again)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from backend import files_migrate, scope  # noqa: E402


async def owner_of(raw, ws: str) -> dict:
    """The workspace's person: "u<id>" is that account's own; "default" the owner's."""
    q = {"_id": ws[1:]} if ws.startswith("u") and ws != scope.DEFAULT else {"role": "owner"}
    u = await raw.users.find_one(q, {"name": 1, "email": 1}) or {}
    return {"type": "user", "id": u.get("_id") or "", "name": u.get("name") or u.get("email") or "the owner"}


async def main(apply: bool, before: str) -> None:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    raw = AsyncIOMotorClient(os.environ["MONGODB_URI"]).get_default_database()
    spaces = {d.get("workspace_id") or scope.DEFAULT async for d in raw.files.find({}, {"workspace_id": 1})}
    spaces |= {d.get("workspace_id") or scope.DEFAULT async for d in raw.file_folders.find({}, {"workspace_id": 1})}
    total = {"files": 0, "bytes": 0, "folders": 0}
    for ws in sorted(spaces):
        db = scope.ScopedDb(raw, ws)
        tok = scope.WORKSPACE.set(ws)
        try:
            who = await owner_of(raw, ws)
            got = await files_migrate.agent_copies(db, who, before, apply)
            docs = await files_migrate.empty_documents(db, apply)
        finally:
            scope.WORKSPACE.reset(tok)
        total["files"] += got["files"]
        total["bytes"] += got["bytes"]
        total["folders"] += len(docs)
        print(f"{ws}: {got['files']} agent file(s), {got['bytes'] / 1e6:.1f} MB "
              f"{'copied' if apply else 'to copy'} for {who['name']}; "
              f"{len(docs)} empty Documents folder(s) {'removed' if apply else 'to remove'}")
    print(f"{'done' if apply else 'dry run'}: {total['files']} file(s), {total['bytes'] / 1e6:.1f} MB, "
          f"{total['folders']} folder(s)")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true", help="do it (without: say what it would do)")
    p.add_argument("--before", default=datetime.now(timezone.utc).date().isoformat(),
                   help="only agents' files made before this date (default: today)")
    a = p.parse_args()
    asyncio.run(main(a.apply, a.before))
