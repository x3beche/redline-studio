"""One-off moves of Files to the rule that what the app or an agent makes
is kept in In the app, and reaches My files only as a copy
(backend/files_virtual.py area_of).

`agent_copies`: a file an agent put before the rule, in one of the
person's own folders, stays the agent's (In the app > Agents) and the
person gets a copy of their own at the same place - its own bytes, theirs to
rename, move or delete. Each original is marked (`mine_copy`), so it is
copied once, ever: run it again and nothing more is made, even after the
copy was deleted.

`empty_documents`: the "Documents" folders the Chat's PDFs used to go to,
removed where nothing is left in them.

Both say what they would do unless `apply`; `tools/migrate_files.py` runs
them over every workspace."""

from __future__ import annotations

from . import files, files_virtual

MARK = "mine_copy"
MIGRATION = "agent-files-2026-10-14"


async def agent_copies(db, owner: dict, before: str, apply: bool = False) -> dict:
    """Copies, for `owner`, of the agents' files made before `before` (ISO)
    that sit in the person's folders (anywhere but the Chat's and the Parts
    page's). {files, bytes, done: [(original, copy)]}."""
    tops = await files_virtual.folder_tops(db)
    out = {"files": 0, "bytes": 0, "done": []}
    rows = [d async for d in db[files.COLL].find({}, {"gridfs_id": 0, "thumb": 0})]
    for d in sorted(rows, key=lambda x: x.get("created_at") or ""):
        if d.get(MARK) or files_virtual.area_of(d, tops) != "agents" or (d.get("created_at") or "") >= before:
            continue
        if tops.get(d.get("folder") or "", "") in (*files_virtual.CHAT_FOLDERS, *files_virtual.PART_FOLDERS):
            continue
        out["files"] += 1
        out["bytes"] += int(d.get("bytes") or 0)
        if not apply:
            continue
        copy = await files.copy_to_mine(db, d["_id"], owner, d.get("folder") or "", d.get("name"))
        await db[files.COLL].update_one({"_id": copy["_id"]}, {"$set": {
            "context.migrated": MIGRATION, "created_at": d.get("created_at") or copy["created_at"],
            "note": d.get("note") or copy.get("note") or ""}})
        await db[files.COLL].update_one({"_id": d["_id"]}, {"$set": {MARK: copy["_id"]}})
        out["done"].append((d["_id"], copy["_id"]))
    return out


async def empty_documents(db, apply: bool = False) -> list[str]:
    """The top "Documents" folders with nothing in them (no file, no folder) - removed when `apply`."""
    gone = []
    async for f in db[files.FOLDERS].find({"parent": {"$in": ["", None]}}, {"name": 1}):
        if (f.get("name") or "").lower() != "documents":
            continue
        if await db[files.COLL].count_documents({"folder": f["_id"]}, limit=1) \
                or await db[files.FOLDERS].count_documents({"parent": f["_id"]}, limit=1):
            continue
        gone.append(f["_id"])
        if apply:
            await db[files.FOLDERS].delete_one({"_id": f["_id"]})
    return gone
