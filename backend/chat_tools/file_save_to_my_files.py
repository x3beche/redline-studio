"""file_save_to_my_files: a copy of a file in the person's own folders.

What the app or an agent generates - a PDF, a render, a shopping list, an
agent's export, a room's STEP or drawing - is kept in its own read-only
area of Files (In the app: Chat, Agents, Projects...) and never in My files.
When the person asks to save one to their files ("save it to my files",
"dosyalarıma kaydet"), this copies it there (backend/files.py copy_to_mine):
a new file of their own they can rename, move and delete; the original stays
where it was."""

from __future__ import annotations

from .. import actors, files, files_virtual
from . import Ctx, Result, Tool, ToolError, size
from ._rights import need


async def _last(ctx: Ctx) -> str:
    """The newest file this conversation made, else the newest one its lines carry."""
    if ctx.chat:
        made = [d async for d in ctx.db[files.COLL].find({"context.chat": ctx.chat}, {"created_at": 1})]
        if made:
            return max(made, key=lambda d: d.get("created_at") or "")["_id"]
        c = await ctx.db["cc_chats"].find_one({"_id": ctx.chat}, {"messages.mentions": 1})
        for m in reversed((c or {}).get("messages") or []):
            ids = [x.get("id") for x in m.get("mentions") or [] if x.get("kind") == "file" and x.get("id")]
            if ids:
                return ids[-1]
    raise ToolError("say which file: its Files id (the tool that made it gave it), or make it first")


async def run(ctx: Ctx, args: dict) -> Result:
    fid = str(args.get("file") or "").strip()
    if not fid or fid.lower() in ("last", "the last file", "latest"):
        fid = await _last(ctx)
    need("POST", f"/api/files/{fid}/copy")
    folder = ""
    path = str(args.get("folder") or "").strip().strip("/")
    by = ctx.actor or actors.current() or {}
    try:
        if path:
            folder = (await files.make_path(ctx.db, path, by))["_id"]
            if (await files_virtual.folder_tops(ctx.db)).get(folder, "") in (*files_virtual.CHAT_FOLDERS,
                                                                           *files_virtual.PART_FOLDERS):
                raise ToolError(f"{path} is the app's own folder - choose one of the person's (or none, the top)")
        name = files.check_name(str(args["name"])) if args.get("name") else None
        doc = await files.copy_to_mine(ctx.db, fid, by, folder, name)
    except KeyError as exc:
        raise ToolError(f"no file {fid} in Files") from exc
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    where = path or "My files"
    link = f"/api/files/{doc['_id']}?inline=1"
    text = (f"Saved a copy of it to {where} as {doc['name']} ({size(doc['bytes'])}), file id {doc['_id']} - "
            f"the person's own now: they can rename, move or delete it; the original stays where it was. "
            f"Link: [{doc['name']}]({link})")
    return Result(text=text, say="Saved {name} to {where}", vars={"name": doc["name"], "where": where, "file": doc["_id"]},
                  summary=text[:600])


TOOL = Tool(
    name="file_save_to_my_files", package="files", level="change", order=20, default=True,
    label="Save a file to My files",
    about="Copies a file the Chat, an agent or a room made into the person's own files.",
    description="Copy a file into the person's own folders (My files in the Files room). What you or the app "
                "generate - a PDF from pdf_make, a render, a shopping list, a room's STEP or drawing - is kept "
                "in the app's own read-only area (Files > In the app) and is NOT in My files: when the person "
                "asks to save it to their files (\"save it to my files\", \"dosyalarıma kaydet\"), call this - "
                "do not say it is already saved. `file`: its Files id (the tool that made it returned it), or "
                "\"last\" for the newest this conversation made; `folder` a folder path of theirs (made if "
                "missing; none: the top); `name` a new name if they gave one. The copy is theirs to rename, "
                "move or delete; the original stays.",
    schema={"type": "object", "properties": {
        "file": {"type": "string", "description": "The Files id, or \"last\""},
        "folder": {"type": "string", "description": "A folder path of the person's, e.g. Reports/2026"},
        "name": {"type": "string", "description": "A new name for the copy"}}, "required": ["file"]},
    running="Saving a copy to My files", failed="Could not save it to My files",
    run=run,
)
