"""files_search: the Files tab's search box - a file's name or note holding
the words (any case), in one's own files (My files), what the app keeps
(In the app: the Projects' builds, the Chat's, Parts', the agents',
Taste's), the Deleted files, or all of them - each with where it is and
the link that opens it in the app.

What it reads is what the tab reads: GET /api/files (backend/files.py
`listing`, each upload's area by files_virtual.area_of), the read-only
folders' own files (GET /api/files/virtual, files_virtual.tree) and the
trash (GET /api/files/trash), with the rights those routes need."""

from __future__ import annotations

from .. import app_links, files, files_virtual
from . import Ctx, Result, Tool, ToolError, clip, size
from ._rights import need

AREAS = ("mine", "app", "deleted", "all")
SHOW = 40                            # files the answer names
SAID = {"mine": "My files", "app": "In the app", "deleted": "Deleted files", "all": "all of Files"}
WHERE = {"projects": "Projects", "chat": "Chat", "parts": "Parts", "agents": "Agents", "taste": "Taste"}


def _hit(d: dict, q: str, kind: str) -> bool:
    k = d.get("kind") if d.get("kind") != "other" else files.kind_of(d.get("name") or "")
    if kind and k != kind:
        return False
    return not q or q in str(d.get("name") or "").lower() or q in str(d.get("note") or "").lower()


def _place(fid: str, folder: str, area: str) -> str:
    """Files open at the file: its folder (My files, an In the app folder, the trash), the file in the viewer."""
    if area == "deleted":
        return "/files/deleted"
    if folder.startswith(files_virtual.ROOT):
        base = "/files/app/" + app_links.segs(folder[len(files_virtual.ROOT):])
    elif area != "own":
        base = "/files/app/" + area
    else:
        base = "/files/mine/" + app_links.seg(folder) if folder else "/files"
    return f"{base}?file={app_links.seg(fid)}"


async def search(db, q: str, area: str, kind: str = "") -> list[dict]:
    """The files that match, newest first: {id, name, kind, bytes, at, area, where, folder, link, open}."""
    q = q.strip().lower()
    out: list[dict] = []
    if area in ("mine", "app", "all"):
        tops = await files_virtual.folder_tops(db)
        paths = {f["_id"]: f.get("path") or f.get("name") or "" async for f in db[files.FOLDERS].find({}, {"path": 1, "name": 1})}
        for d in await files.listing(db, q="", kind="", limit=5000):
            if not _hit(d, q, kind):
                continue
            a = files_virtual.area_of(d, tops)
            if (area == "mine" and a != "own") or (area == "app" and a == "own"):
                continue
            folder = d.get("folder") or ""
            out.append({"id": d["_id"], "name": d.get("name"), "kind": d.get("kind"), "bytes": d.get("bytes") or 0,
                        "at": d.get("created_at") or "", "area": a,
                        "where": ("My files" if a == "own" else f"In the app > {WHERE.get(a, a)}")
                        + (f" > {paths[folder]}" if paths.get(folder) else ""),
                        "link": _place(d["_id"], folder, a), "open": f"/api/files/{d['_id']}"})
    if area in ("app", "all"):
        tree = await files_virtual.tree(db)
        names = {f["id"]: f.get("name") or "" for f in tree.get("folders") or []}
        for f in tree.get("files") or []:
            if not _hit(f, q, kind):
                continue
            out.append({"id": f["id"], "name": f.get("name"), "kind": f.get("kind"), "bytes": f.get("bytes") or 0,
                        "at": f.get("created_at") or "", "area": f.get("where") or "projects",
                        "where": "In the app > " + WHERE.get(str(f.get("where") or ""), "Projects")
                        + (f" > {names[f['folder']]}" if names.get(f.get("folder")) else ""),
                        "link": _place(f["id"], f.get("folder") or "", "projects"), "open": ""})
    if area in ("deleted", "all"):
        for d in await files.trash(db):
            if not _hit(d, q, kind):
                continue
            out.append({"id": d["_id"], "name": d.get("name"), "kind": d.get("kind"), "bytes": d.get("bytes") or 0,
                        "at": d.get("deleted_at") or "", "area": "deleted",
                        "where": "Deleted files" + (f" (was in {d['folder_path']})" if d.get("folder_path") else "")
                        + (f", deleted for good after {str(d['purge_at'])[:10]}" if d.get("purge_at") else ""),
                        "link": "/files/deleted", "open": ""})
    out.sort(key=lambda r: str(r["at"]), reverse=True)
    return out


async def run(ctx: Ctx, args: dict) -> Result:
    area = str(args.get("area") or "all").strip().lower()
    area = {"my": "mine", "own": "mine", "my files": "mine", "in the app": "app", "trash": "deleted"}.get(area, area)
    if area not in AREAS:
        raise ToolError(f"area is one of {', '.join(AREAS)}")
    kind = str(args.get("kind") or "").strip().lower()
    if kind and kind not in files.KINDS:
        raise ToolError(f"kind is one of {', '.join(files.KINDS)}")
    q = str(args.get("query") or "").strip()
    if not q and not kind:
        raise ToolError("say what to look for: words of a file's name or note (or a kind)")
    need("GET", "/api/files")
    if area in ("deleted", "all"):
        need("GET", "/api/files/trash")
    got = await search(ctx.db, q, area, kind)
    what = (f"\"{q}\"" if q else "") + (f" ({kind})" if kind else "")
    if not got:
        return Result(text=f"No file in {SAID[area]} matches {what}.", say="No files match {query}",
                      vars={"query": q or kind, "n": 0, "area": area}, summary="none")
    lines = [f"{r['id']}  {r['name']}  ({r['kind'] or 'file'}, {size(r['bytes'])}, "
             f"{'deleted' if r['area'] == 'deleted' else 'added'} {str(r['at'])[:10]})  {r['where']}  "
             f"place: {r['link']}" + (f"  open: {r['open']}" if r["open"] else "")
             for r in got[:SHOW]]
    more = f"\n... and {len(got) - SHOW} more: narrow the words or the area." if len(got) > SHOW else ""
    text = (f"{len(got)} file(s) in {SAID[area]} match {what}, newest first (id, name, kind, size, date, where). "
            "Give the person a file's place link (Files open at it) or its open link (the viewer over the Chat); "
            "read one with file_read; a deleted one comes back with files_restore.\n" + "\n".join(lines) + more)
    v = {"query": q or kind, "n": len(got), "area": area}
    for i, r in enumerate(got[:3]):
        v[f"f{i}"] = f"{r['name']}"[:60]
        v[f"l{i}"] = r["link"][:80]
    return Result(text=clip(text, 12_000), say="Found {n} files for {query}", vars=v,
                  summary="\n".join(f"{r['name']} · {r['where']}" for r in got[:12]))


TOOL = Tool(
    name="files_search", package="files", level="read", order=69,
    label="Search Files",
    about="Searches Files as its search box does: My files, In the app, Deleted files, or all.",
    description="Search the Files tab like its search box: files whose name or note holds `query` (any case), in "
                "`area` mine (My files: the person's own), app (In the app: what the app keeps - the Projects' "
                "builds, the Chat's files, Parts', the agents', Taste's - read-only there), deleted (Deleted files, "
                "kept 30 days) or all (default); `kind` narrows to one kind (pdf, step, image, table, bom...). "
                "Each file comes with where it is and links: its place in Files and, for a stored file, the link "
                "that opens it in the viewer over the Chat. Use file_read to read one, files_restore to bring a "
                "deleted one back.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Words of the file's name or note"},
        "area": {"type": "string", "enum": list(AREAS), "description": "Where to look (default all)"},
        "kind": {"type": "string", "enum": list(files.KINDS), "description": "Only this kind of file"}}},
    running="Searching Files for {query}", failed="Could not search Files",
    run=run)
