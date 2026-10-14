"""files_restore: a file of Files' Deleted files put back, as the trash's
"Restore" does (POST /api/files/trash/restore, backend/files.py
`restore`): into its folder (made again from its path if it went), and the
Chat lines and products that said it was gone no longer do.

Only within the trash's days (files.TRASH_DAYS: past them it is deleted for
good and cannot come back), and with the route's rights: one's own file,
or anyone's with the right to delete. It asks the person first. Everything
it writes goes through the workspace, so the Chat's undo puts the file back
among the Deleted files, as it was."""

from __future__ import annotations

from datetime import datetime, timezone

from .. import actors, files
from . import Ctx, Result, Tool, ToolError
from ._rights import need

SHOW = 12


async def _trashed(db, ref: str) -> dict:
    """The deleted file `ref` names: its id, or words of its name (only one may match)."""
    ref = str(ref or "").strip()
    if not ref:
        raise ToolError("say which deleted file: its id or its name (files_search with area deleted lists them)")
    # What is past its days is gone for good (the hourly sweep deletes it; not swept here, so the step's change
    # holds only the restore).
    now = datetime.now(timezone.utc).isoformat()
    every = [d async for d in db[files.TRASH].find({}, {"gridfs_id": 0}) if str(d.get("purge_at") or "9") >= now]
    got = next((d for d in every if d["_id"] == ref), None)
    if got:
        return got
    words = ref.lower().split()
    hits = [d for d in every if all(w in str(d.get("name") or "").lower() for w in words)]
    exact = [d for d in hits if str(d.get("name") or "").lower() == ref.lower()]
    hits = exact if len(exact) == 1 else hits
    if len(hits) == 1:
        return hits[0]
    if not hits:
        if await db[files.COLL].find_one({"_id": ref}, {"_id": 1}):
            raise ToolError(f"{ref} is not deleted: it is in Files")
        raise ToolError(f"no deleted file {ref!r}: the Deleted files keep a file {files.TRASH_DAYS} days, then it is "
                        "deleted for good" + (f". Deleted now: " + ", ".join(f"{d['_id']} ({d.get('name')})" for d in every[:SHOW])
                                              if every else " - and they are empty now"))
    raise ToolError(f"{len(hits)} deleted files match {ref!r}: "
                    + ", ".join(f"{d['_id']} ({d.get('name')}, deleted {str(d.get('deleted_at'))[:10]})" for d in hits[:SHOW])
                    + ". Ask which one, then call again with its id.")


async def run(ctx: Ctx, args: dict) -> Result:
    need("POST", "/api/files/trash/restore")
    t = await _trashed(ctx.db, args.get("file") or "")
    from ..files_api import _may_remove                 # the route's own rule: one's own, or anyone's with "delete"
    if not _may_remove(t):
        from .. import access
        raise ToolError(access.refusal(access.current() or "nobody", "delete") + f" - {t.get('name')} is someone else's")
    try:
        doc = await files.restore(ctx.db, t["_id"])
    except KeyError:
        raise ToolError(f"{t.get('name')} is not among the Deleted files any more") from None
    except files.Clash as exc:
        raise ToolError(f"{t.get('name')}: {exc}") from exc
    await actors.audit(ctx.db, "restore", f"1 file(s): {doc.get('name')}", {"ids": [doc["_id"]], "by": "chat"})
    where = t.get("folder_path") or "My files"
    link = f"/api/files/{doc['_id']}"
    return Result(text=f"Restored {doc.get('name')} ({doc['_id']}) from the Deleted files into {where}. Open it: {link}",
                  say="Restored {name}", vars={"name": doc.get("name") or doc["_id"], "file": doc["_id"], "where": where},
                  summary=f"back in {where}")


TOOL = Tool(
    name="files_restore", package="files", level="change", order=72,
    label="Restore a deleted file",
    about="Puts a file back from Files' Deleted files, as its Restore does; asks first.",
    description="Put a file back from the Files tab's Deleted files - as its Restore does: into the folder it was "
                "in (made again if it went), and the conversations and products that said it was gone no longer "
                "do. `file` is its id (files_search with area deleted gives it) or its name. Only within the 30 "
                "days a deleted file is kept, and only the person's own file unless they may delete others'. It "
                "asks the person before it runs; use it only when they ask to restore a file.",
    schema={"type": "object", "properties": {
        "file": {"type": "string", "description": "The deleted file's id, or its name"}}, "required": ["file"]},
    running="Restoring {file} from the Deleted files", failed="Could not restore the file",
    default=True, asks=lambda args: True,
    run=run)
