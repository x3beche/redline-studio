"""Files' read-only folders: what the rest of the app keeps, shown where a
person looks for their files.

Files (backend/files.py) holds what people bring. Everything else a
workspace keeps - a model's source and its STEP, a board's KiCad files and
Gerbers, a firmware's sources and its build, a project's releases, a
model's technical drawing - lives with the thing it belongs to. Here it is
shown in Files too, as it is and where it is, without a byte copied:

- **Projects** mirrors the project tree of the 3D and PCB rooms: each
  folder, each model (`.3d`), board (`.pcb`) and firmware in it, and their
  files. The rooms' own files are references: opening, previewing and
  downloading one reads it from where it is kept; renaming, moving and
  deleting are refused here (the room they belong to changes them).
- **Chat** lists, per conversation, the Files the conversation used - the
  pictures and files sent with its lines, the PDFs and pictures its tools
  made - by reference: they stay where they are in My files.
- **Parts** lists, per maker and product, the files attached to a Parts
  product or a McMaster-Carr / GrabCAD part, by reference too.

A virtual entry's id starts with `v:`; the routes of backend/files_api.py
read it through `doc()` here, so a preview, a range request, a table, a
PDF's text or a STEP's 3D view work the same as for an upload.

When a file is deleted from Files, `mark_gone()` says so wherever it was
used: on the Chat line that carried it (the chip says who deleted it and
when, and the model's context for later answers says it is gone) and on
the Parts product that held it. Files has no trash: the bytes are gone, so
"gone" cannot be undone - the delete dialog says what used it first
(`uses()`).
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime, timedelta, timezone

from . import files

ROOT = "v:"
PROJECTS, CHAT, PARTS = "v:projects", "v:chat", "v:parts"
AGENTS, TASTE = "v:agents", "v:taste"
ROOTS = {PROJECTS: "Projects", CHAT: "Chat", PARTS: "Parts", AGENTS: "Agents", TASTE: "Taste"}

# What a model's and a board's stored outputs are called as files, by
# label; any other label is the build's own data, in a "Build data" folder.
MODEL_FILES = {"step": "{n}.step", "stl": "{n}.stl", "3mf": "{n}.3mf"}
BOARD_FILES = {"step": "{n}.step", "stl": "{n}.stl", "model3d": "{n}.glb", "routed": "{n}.kicad_pcb",
               "schematic": "{n}.kicad_sch", "layers_pdf": "{n}-layers.pdf", "bom_csv": "{n}-bom.csv",
               "sources": "{n}-gerbers.zip", "schematic_svg": "{n}-schematic.svg"}
BUILD_DATA = "Build data"
# Where each kind of entry is changed, for the lock's tooltip and refusal().
WHERE = {"pf": "cad", "pm": "cad", "ms": "cad", "ma": "cad", "md": "cad", "pb": "pcb", "bs": "pcb", "ba": "pcb",
         "pw": "firmware", "fs": "firmware", "fb": "firmware", "pr": "releases", "rl": "releases",
         "cc": "chat", "qm": "parts", "qp": "parts", "projects": "projects", "chat": "chat", "parts": "parts",
         "rv": "cad", "pn": "cad", "ag": "agents", "agents": "agents", "tp": "taste", "tr": "taste", "taste": "taste"}
ROOM = {"cad": "the 3D Drawing room", "pcb": "the PCB Design room", "firmware": "the Firmware room",
        "releases": "the project's releases", "chat": "the Chat", "parts": "the Parts page",
        "projects": "the project tree", "agents": "the agent that made it", "taste": "the Taste room"}


def is_virtual(fid: str | None) -> bool:
    return bool(fid) and str(fid).startswith(ROOT)


def vid(kind: str, *ref: str) -> str:
    """An entry's id: its kind and what it points at, made safe for a URL
    path (a model's id has slashes in it)."""
    raw = json.dumps(list(ref), separators=(",", ":")).encode()
    return f"{ROOT}{kind}:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def unvid(v: str) -> tuple[str, list[str]]:
    """(kind, ref) of an id made by vid(); KeyError for anything else."""
    try:
        _, kind, b64 = v.split(":", 2)
        ref = json.loads(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)))
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise KeyError(v) from exc
    if not isinstance(ref, list) or not all(isinstance(x, str) for x in ref):
        raise KeyError(v)
    return kind, ref


def _who(by) -> dict:
    by = by if isinstance(by, dict) else {}
    return {k: by[k] for k in ("id", "name") if by.get(k)}


def _folder(fid: str, name: str, parent: str, where: str, **extra) -> dict:
    return {"id": fid, "name": name, "parent": parent, "ro": True, "where": where, "by": {},
            "created_at": extra.pop("at", "") or "", **extra}


def _file(fid: str, name: str, folder: str, size: int, where: str, *, at: str = "", by=None,
          stored: int | None = None, sha: str = "", build: bool = False, open_: dict | None = None) -> dict:
    kind = files.kind_of(name)
    return {"id": fid, "name": name, "folder": folder, "bytes": int(size or 0),
            "stored": int(stored if stored is not None else size or 0),
            "kind": kind, "content_type": files.type_of(name, None),
            # The build's own data is large and not meant to be read: listed, kept, not previewed.
            "preview": "none" if build else files.preview_of(name, kind),
            "created_at": at or "", "by": _who(by), "note": "", "context": {},
            "sha256": sha, "ro": True, "where": where, "open": open_ or {}, **({"build": True} if build else {})}


# ---------------------------------------------------------------- Projects

async def projects(db) -> tuple[list[dict], list[dict]]:
    """The project tree's folders, models, boards and firmware as folders,
    and their files: sources, outputs, drawings, builds, releases."""
    from . import release
    from .firmware import COLL as FW, FILES as FWF
    dirs: list[dict] = []
    out: list[dict] = []
    tree = [f async for f in db.folders.find({}, {"name": 1, "parent": 1})]
    seen_notes: set[str] = set()
    known = {f["_id"] for f in tree}

    def under(path: str) -> str:
        return vid("pf", path) if path and path in known else PROJECTS

    for f in tree:
        dirs.append(_folder(vid("pf", f["_id"]), f.get("name") or f["_id"], under(f.get("parent") or ""), "cad",
                            path=f["_id"], open={"room": "cad"}))

    model_ids: set[str] = set()
    async for m in db.models.find({}, {"name": 1, "title": 1, "folder": 1, "source": 1, "sha256": 1,
                                        "artifacts": 1, "updated_at": 1, "drawing_layout": 1}):
        mid, name = m["_id"], m.get("name") or m["_id"].rpartition("/")[2]
        model_ids.add(mid)
        here, see = vid("pm", mid), {"room": "cad", "model": mid}
        dirs.append(_folder(here, f"{name}.3d", under(m.get("folder") or ""), "cad", open=see,
                            title=m.get("title") or name, at=m.get("updated_at")))
        src = m.get("source") or ""
        if src:
            out.append(_file(vid("ms", mid), f"{name}.py", here, len(src.encode()), "cad",
                             at=m.get("updated_at"), sha=m.get("sha256") or "", open_=see))
        arts = m.get("artifacts") or {}
        extra = False
        for label, meta in sorted(arts.items()):
            build = label not in MODEL_FILES
            extra |= build
            nm = MODEL_FILES.get(label, "{n}." + ("viewer.json" if label == "viewer" else label)).format(n=name)
            out.append(_file(vid("ma", mid, label), nm, vid("pd", "m", mid) if build else here,
                             meta.get("bytes") or 0, "cad", at=meta.get("at"), stored=meta.get("stored_bytes"),
                             sha=meta.get("sha256") or "", build=build, open_=see))
        if extra:
            dirs.append(_folder(vid("pd", "m", mid), BUILD_DATA, here, "cad", open=see, build=True))
        kept = _drawing(m)
        if kept:
            try:
                st = kept.stat()
            except OSError:
                st = None
            if st:
                out.append(_file(vid("md", mid), f"{name}-drawing.pdf", here, st.st_size, "cad",
                                 at=datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(), open_=see))

    # The drawn notes on each model: the drawing it was asked on, and the picture after the work.
    async for r in db.revisions.find({"image": {"$exists": True}}, {"image": 1, "image_after": 1, "model": 1,
                                                                    "created_at": 1, "by": 1}):
        mid = r.get("model") or ""
        if mid not in model_ids:
            continue
        here = vid("pn", mid)
        if here not in seen_notes:
            seen_notes.add(here)
            dirs.append(_folder(here, "Drawn notes", vid("pm", mid), "cad", open={"room": "cad", "model": mid}, tr=True))
        for which, label in (("image", "drawn"), ("image_after", "after")):
            shot = r.get(which)
            if isinstance(shot, dict) and shot.get("gridfs_id") is not None:
                out.append(_file(vid("rv", r["_id"], which), f"{r['_id']} {label}.png", here, shot.get("bytes") or 0, "cad",
                                 at=r.get("created_at"), by=r.get("by"), open_={"room": "cad", "model": mid}))

    boards: dict[str, dict] = {}
    async for b in db.boards.find({}, {"title": 1, "folder": 1, "source": 1, "artifacts": 1, "saved_at": 1}):
        bid = b["_id"]
        boards[bid] = b
        here, see = vid("pb", bid), {"room": "pcb", "board": bid}
        dirs.append(_folder(here, f"{b.get('title') or bid}.pcb", under(b.get("folder") or ""), "pcb",
                            open=see, at=b.get("saved_at")))
        src = b.get("source") or ""
        if src:
            out.append(_file(vid("bs", bid), f"{bid}.ato", here, len(src.encode()), "pcb",
                             at=b.get("saved_at"), open_=see))
        arts = b.get("artifacts") or {}
        extra = False
        for label, meta in sorted(arts.items()):
            nm = BOARD_FILES.get(label)
            if label == "pcb":
                nm = "{n}-placed.kicad_pcb" if "routed" in arts else "{n}.kicad_pcb"
            build = nm is None
            extra |= build
            out.append(_file(vid("ba", bid, label), (nm or "{n}." + label).format(n=bid),
                             vid("pd", "b", bid) if build else here, meta.get("bytes") or 0, "pcb",
                             at=meta.get("at"), stored=meta.get("stored_bytes"), sha=meta.get("sha256") or "",
                             build=build, open_=see))
        if extra:
            dirs.append(_folder(vid("pd", "b", bid), BUILD_DATA, here, "pcb", open=see, build=True))

    fws = [f async for f in db[FW].find({}, {"title": 1, "board": 1, "folder": 1, "build": 1, "by": 1,
                                             "updated_at": 1})]
    latest: dict[tuple[str, str], dict] = {}
    if fws:
        async for d in db[FWF].find({}, {"content": 0}):
            k = (d.get("firmware"), d.get("path"))
            if k not in latest or int(d.get("version") or 0) > int(latest[k].get("version") or 0):
                latest[k] = d
    for fw in fws:
        fid = fw["_id"]
        b = boards.get(fw.get("board") or "")
        here, see = vid("pw", fid), {"room": "firmware", "firmware": fid}
        dirs.append(_folder(here, fw.get("title") or fid, vid("pb", b["_id"]) if b else
                            under(fw.get("folder") or ""), "firmware", open=see, at=fw.get("updated_at")))
        for (owner, path), d in sorted(latest.items(), key=lambda kv: kv[0][1] or ""):
            if owner != fid or not path:
                continue
            out.append(_file(vid("fs", fid, path), path, here, d.get("bytes") or 0, "firmware",
                             at=d.get("at"), by=d.get("by"), sha=d.get("sha256") or "", open_=see))
        build = fw.get("build") or {}
        for nm, meta in sorted((build.get("artifacts") or {}).items()):
            out.append(_file(vid("fb", fid, nm), nm, here, meta.get("bytes") or 0, "firmware",
                             at=build.get("at"), sha=meta.get("sha256") or "", open_=see))

    rels = [d async for d in db[release.COLL].find({"status": "ready"}, {"log": 0, "problems": 0})]
    for project in sorted({d.get("project") or "" for d in rels}):
        dirs.append(_folder(vid("pr", project), "Releases", under(project), "releases",
                            open={"room": "cad"}))
    for d in rels:
        out.append(_file(vid("rl", d["_id"]), f"{d.get('project') or 'release'}-{d.get('tag') or d['_id']}.zip",
                         vid("pr", d.get("project") or ""), d.get("bytes") or 0, "releases",
                         at=d.get("done_at") or d.get("created_at"), by=d.get("by")))
    return dirs, out


def _drawing(m: dict):
    """Where a model's technical drawing is kept (backend/release.py), for
    its STEP and layout as they are now; None when it has no STEP."""
    from . import drawlayout, release
    step = (m.get("artifacts") or {}).get("step")
    if not (step and step.get("sha256")):
        return None
    return release._kept(step, layout=drawlayout.digest((m.get("drawing_layout") or {}).get("spec")))


# ---------------------------------------------------------------- Chat and Parts (references)

async def _live(db) -> dict[str, dict]:
    return {d["_id"]: d async for d in db[files.COLL].find({}, {"gridfs_id": 0, "thumb": 0})}


async def chats(db, live: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """A folder per conversation (not in the Chat's trash) that used a file
    of Files, and which files: those sent with its lines, and those its
    tools made for it (`context.chat`)."""
    made: dict[str, list[str]] = {}
    for d in live.values():
        c = (d.get("context") or {}).get("chat")
        if c:
            made.setdefault(str(c), []).append(d["_id"])
    dirs, links, names = [], [], {}
    cur = db["cc_chats"].find({}, {"title": 1, "messages.mentions": 1, "deleted_at": 1, "updated_at": 1})
    async for c in cur.sort("updated_at", -1):
        if c.get("deleted_at"):
            continue
        ids: list[str] = []
        for m in c.get("messages") or []:
            for x in m.get("mentions") or []:
                if x.get("kind") == "file" and x.get("id") in live and x["id"] not in ids:
                    ids.append(x["id"])
        ids += [i for i in made.get(c["_id"], []) if i not in ids]
        if not ids:
            continue
        title = (c.get("title") or "").strip() or "Untitled"
        n = names[title.lower()] = names.get(title.lower(), 0) + 1
        here = vid("cc", c["_id"])
        dirs.append(_folder(here, title if n == 1 else f"{title} ({n})", CHAT, "chat", chat=c["_id"],
                            at=c.get("updated_at") or ""))
        links += [{"folder": here, "file": i} for i in ids]
    # The Chat's own uploads no conversation holds now (attached and never
    # sent, or sent in a room's agent thread): in a folder of their own.
    tops = await folder_tops(db)
    linked = {x["file"] for x in links}
    rest = [fid for fid, d in live.items() if fid not in linked and chat_owned(d, tops)]
    if rest:
        here = vid("cc", "")
        dirs.append(_folder(here, "Not in a conversation", CHAT, "chat", tr=True))
        links += [{"folder": here, "file": i} for i in rest]
    return dirs, links


async def parts(db, live: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """A folder per maker, and in it one per product, with the files of
    Files attached to it."""
    from . import linked, product_files
    makers = {d["_id"]: d.get("name") or d["_id"] async for d in db["manufacturers"].find({}, {"name": 1})}
    makers.update({"mcmaster": "McMaster-Carr", "grabcad": "GrabCAD"})
    rows: list[tuple[str, str, str, list[str]]] = []
    async for d in db[product_files.COLL].find({}, {"mid": 1, "pid": 1, "name": 1, "files.file": 1}):
        rows.append((str(d.get("mid") or ""), str(d.get("pid") or ""), d.get("name") or str(d.get("pid") or ""),
                     [f.get("file") for f in d.get("files") or []]))
    async for d in db[linked.COLL].find({}, {"source": 1, "key": 1, "title": 1, "files.file": 1}):
        rows.append((str(d.get("source") or ""), str(d.get("key") or ""), d.get("title") or str(d.get("key") or ""),
                     [f.get("file") for f in d.get("files") or []]))
    # Files kept for a product or a saved part that nothing holds any more (it was
    # deleted, or the file let go): under the product they were kept for, by its key.
    held = {i for r in rows for i in r[3]}
    loose: dict[tuple[str, str], list[str]] = {}
    for fid, d in live.items():
        ctx = d.get("context") or {}
        mark = str(ctx.get("product") or ctx.get("linked") or "")
        if fid not in held and ":" in mark:
            loose.setdefault(tuple(mark.split(":", 1)), []).append(fid)
    have = {(r[0], r[1]): r for r in rows}
    for (mid, pid), ids in loose.items():
        if (mid, pid) in have:
            have[(mid, pid)][3].extend(ids)
        else:
            rows.append((mid, pid, pid, ids))
    dirs, links, seen = [], [], set()
    for mid, pid, name, ids in sorted(rows, key=lambda r: (makers.get(r[0], r[0]).lower(), r[2].lower())):
        ids = [i for i in dict.fromkeys(ids) if i in live]
        if not ids:
            continue
        if mid not in seen:
            seen.add(mid)
            dirs.append(_folder(vid("qm", mid), makers.get(mid, mid) or "?", PARTS, "parts", maker=mid))
        here = vid("qp", mid, pid)
        dirs.append(_folder(here, name, vid("qm", mid), "parts", maker=mid, product=pid))
        links += [{"folder": here, "file": i} for i in ids]
    return dirs, links


async def tree(db) -> dict:
    """Everything the read-only folders hold: {folders, files, links} -
    folders and files of the Projects, and (folder, file) pairs for the
    Files the Chat and Parts folders refer to."""
    live = await _live(db)
    pdirs, pfiles = await projects(db)
    cdirs, clinks = await chats(db, live)
    qdirs, qlinks = await parts(db, live)
    adirs, alinks = await agents(db, live)
    tdirs, tfiles = await tastes(db)
    roots = [_folder(k, v, "", WHERE[k[2:]], root=True) for k, v in ROOTS.items()]
    return {"folders": roots + pdirs + cdirs + qdirs + adirs + tdirs, "files": pfiles + tfiles,
            "links": clinks + qlinks + alinks}


async def agents(db, live: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """A folder per agent, with the files the rooms' agents put in Files
    (revisions.py files put, the MCP server): theirs, read-only here."""
    tops = await folder_tops(db)
    dirs, links, seen = [], [], set()
    for fid, d in sorted(live.items(), key=lambda kv: kv[1].get("created_at") or "", reverse=True):
        if area_of(d, tops) != "agents":
            continue
        who = str((d.get("by") or {}).get("name") or "agent")
        here = vid("ag", who)
        if here not in seen:
            seen.add(here)
            dirs.append(_folder(here, who, AGENTS, "agents"))
        links.append({"folder": here, "file": fid})
    return dirs, links


async def tastes(db) -> tuple[list[dict], list[dict]]:
    """A folder per taste palette, with the reference renders it was made from."""
    dirs, out = [], []
    async for p in db["taste_palettes"].find({}, {"name": 1, "references": 1, "updated_at": 1}):
        refs = [r for r in p.get("references") or [] if isinstance(r, dict) and r.get("gridfs_id") is not None]
        if not refs:
            continue
        here = vid("tp", p["_id"])
        dirs.append(_folder(here, p.get("name") or p["_id"], TASTE, "taste", open={"room": "taste"}))
        for r in refs:
            name = " - ".join(x for x in (r.get("label") or r.get("model") or "", r.get("view") or "") if x) or r.get("id")
            out.append(_file(vid("tr", p["_id"], str(r.get("id"))), f"{name}.png".replace("/", "-"), here,
                             r.get("bytes") or 0, "taste", at=r.get("at"), open_={"room": "taste"}))
    return dirs, out


# ---------------------------------------------------------------- one entry, with its bytes

async def doc(db, v: str, data: bool = True) -> dict:
    """A Projects entry as Files' routes read a file: its row, and its
    bytes (`_data`) or where they are kept as they are (`_grid`). KeyError
    when there is no such entry for this workspace."""
    kind, ref = unvid(v)
    if kind not in ("ms", "ma", "md", "bs", "ba", "fs", "fb", "rl", "rv", "tr"):
        raise KeyError(v)
    _, rows = await (tastes(db) if kind == "tr" else projects(db))
    row = next((r for r in rows if r["id"] == v), None)
    if row is None:
        raise KeyError(v)
    out = {**row, "_id": v}
    if not data:
        return out
    from bson import ObjectId
    from . import ato, release, store
    from .firmware import BUCKET as FWB, COLL as FW, FILES as FWF
    if kind == "ms":
        m = await db.models.find_one({"_id": ref[0]}, {"source": 1})
        out["_data"] = ((m or {}).get("source") or "").encode()
    elif kind == "ma":
        out["_data"] = await store.get_artifact(db, ref[0], ref[1])
    elif kind == "md":
        # Only a drawing already made is listed: read, never made here.
        kept = _drawing(await db.models.find_one({"_id": ref[0]}, {"artifacts": 1, "drawing_layout": 1}) or {})
        try:
            out["_data"] = kept.read_bytes() if kept else b""
        except OSError as exc:
            raise KeyError(v) from exc
    elif kind == "bs":
        b = await db.boards.find_one({"_id": ref[0]}, {"source": 1})
        out["_data"] = ((b or {}).get("source") or "").encode()
    elif kind == "ba":
        out["_data"] = await store.get_artifact(db, ref[0], ref[1], ato.BOARDS)
    elif kind == "fs":
        kept = [d async for d in db[FWF].find({"firmware": ref[0], "path": ref[1]})]
        d = max(kept, key=lambda x: int(x.get("version") or 0), default={})
        out["_data"] = (d.get("content") or "").encode()
    elif kind == "fb":
        fw = await db[FW].find_one({"_id": ref[0]}, {"build": 1})
        meta = (((fw or {}).get("build") or {}).get("artifacts") or {}).get(ref[1])
        if not meta:
            raise KeyError(v)
        out["_grid"] = (FWB, ObjectId(str(meta["gridfs_id"])))
    elif kind == "rl":
        d = await db[release.COLL].find_one({"_id": ref[0]}, {"zip_id": 1})
        if not d or not d.get("zip_id"):
            raise KeyError(v)
        out["_grid"] = (release.BUCKET, d["zip_id"])
    elif kind in ("rv", "tr"):
        if kind == "rv":
            r = await db.revisions.find_one({"_id": ref[0]}, {ref[1]: 1})
            shot = (r or {}).get(ref[1]) if ref[1] in ("image", "image_after") else None
        else:
            p = await db["taste_palettes"].find_one({"_id": ref[0]}, {"references": 1})
            shot = next((x for x in (p or {}).get("references") or [] if str(x.get("id")) == ref[1]), None)
        if not isinstance(shot, dict) or shot.get("gridfs_id") is None:
            raise KeyError(v)
        out["_grid"] = ("shots", shot["gridfs_id"])
    if "_data" in out:
        out["bytes"] = len(out["_data"])
    return out


# ---------------------------------------------------------------- the Parts page's own uploads

PARTS_REFUSAL = "read-only: it belongs to the Parts page - change it on the Parts page (or through the Chat's product tools)"


CHAT_REFUSAL = "read-only: it belongs to the Chat - it goes with its line or its conversation, deleted in the Chat"


def chat_owned(doc: dict, tops: dict[str, str]) -> bool:
    """An upload the Chat made or was given (a picture pasted in a line, a PDF
    or a render its tools made, kept in the Chat folder): the Chat's, shown
    under In the app > Chat, read-only in Files, and moved to Files' trash
    when no conversation holds it any more (release_chat_files). A file of
    one's own a conversation only mentions stays one's own."""
    ctx = doc.get("context") or {}
    return bool(ctx.get("chat")) or ctx.get("room") in ("chat", "commandcode") \
        or tops.get(doc.get("folder") or "", "") in CHAT_FOLDERS


def mentioned(msgs: list[dict]) -> set[str]:
    """The Files ids a conversation's lines carry."""
    return {x.get("id") for m in msgs or [] for x in m.get("mentions") or [] if x.get("kind") == "file" and x.get("id")}


async def release_chat_files(db, ids: set[str], chats: list[str] = ()) -> list[str]:
    """After lines or conversations were deleted (cc_chat.py): the Chat's own
    uploads among `ids` - and those its tools made for `chats` - that no
    conversation holds any more go to Files' trash, where they can still be
    restored. The rights were the Chat's delete's own. Never raises: the
    Chat's delete is done either way."""
    try:
        return await _release(db, set(ids), list(chats))
    except Exception as exc:                          # noqa: BLE001 - logged, the delete stands
        import logging
        logging.getLogger(__name__).warning("releasing the Chat's files failed: %s", exc)
        return []


async def _release(db, ids: set[str], chats: list[str]) -> list[str]:
    from . import files as f_
    if chats:
        ids |= {d["_id"] async for d in db[f_.COLL].find({"context.chat": {"$in": list(chats)}}, {"_id": 1})}
    if not ids:
        return []
    held = await _chat_refs(db)
    alive = {c["_id"] async for c in db["cc_chats"].find({}, {"_id": 1})}
    tops = await folder_tops(db)
    out = []
    async for d in db[f_.COLL].find({"_id": {"$in": list(ids)}}, {"context": 1, "folder": 1}):
        if d["_id"] in held or (d.get("context") or {}).get("chat") in alive or not chat_owned(d, tops):
            continue
        if await f_.remove(db, d["_id"]):
            out.append(d["_id"])
    return out


AGENT_REFUSAL = "read-only: an agent made it - copy it to My files to change it there"


def agent_made(doc: dict) -> bool:
    """A file a room's agent put in Files (revisions.py files put, the MCP server)."""
    return (doc.get("by") or {}).get("type") == "agent"


def area_of(doc: dict, tops: dict[str, str]) -> str:
    """Whose an upload is: "parts", "chat", "agents" - made or kept by the app,
    read-only in Files and never in My files - or "own". A copy saved to My
    files (copy_to_mine) is always one's own."""
    if (doc.get("context") or {}).get("copied_from"):
        return "own"
    if parts_owned(doc, tops):
        return "parts"
    if chat_owned(doc, tops):
        return "chat"
    if agent_made(doc):
        return "agents"
    return "own"


def parts_owned(doc: dict, tops: dict[str, str]) -> bool:
    """An upload kept for a Parts product or a saved McMaster-Carr / GrabCAD part
    (its context says so, or it is kept under Parts, McMaster-Carr or GrabCAD):
    the Parts page's, shown under In the app > Parts and read-only in Files.
    A file of one's own a product only refers to stays one's own."""
    ctx = doc.get("context") or {}
    return bool(ctx.get("product") or ctx.get("linked")) or tops.get(doc.get("folder") or "", "") in PART_FOLDERS


async def folder_tops(db) -> dict[str, str]:
    """Each folder's top folder's name, lower-cased, by id."""
    return {f["_id"]: (f.get("path") or f.get("name") or "").split("/")[0].lower()
            async for f in db[files.FOLDERS].find({}, {"path": 1, "name": 1})}


def where_of(v: str) -> str:
    """The area a read-only entry is changed in: cad, pcb, firmware, releases, chat, parts, projects."""
    kind = v.split(":")[1] if ":" in v else ""
    if kind == "pd":
        try:
            return "pcb" if unvid(v)[1][:1] == ["b"] else "cad"
        except KeyError:
            return "projects"
    return WHERE.get(kind, "projects")


def refusal(v: str) -> str:
    """Why a read-only entry is not changed here, and where it is."""
    return f"read-only: it is shown here from {ROOM[where_of(v)]} - change it there"


# ---------------------------------------------------------------- how much there is

def _day(iso: str | None) -> str:
    return (iso or "")[:10]


RANGES = {"7d": 7, "30d": 30, "90d": 90}
# The areas counted, in the order the page draws them.
AREAS = ("projects", "chat", "parts", "agents", "taste", "own")
# Where an upload is kept says what it is for, when nothing else does.
CHAT_FOLDERS = ("chat",)
PART_FOLDERS = ("parts", "mcmaster-carr", "grabcad")


async def _chat_refs(db) -> set[str]:
    """Every upload a Chat line carries - the trash's conversations too:
    their files are still the Chat's."""
    out: set[str] = set()
    async for c in db["cc_chats"].find({"messages.mentions.kind": "file"}, {"messages.mentions": 1}):
        out |= {x.get("id") for m in c.get("messages") or [] for x in m.get("mentions") or [] if x.get("kind") == "file"}
    return out


async def usage(db, range_: str = "auto") -> dict:
    """How many files and how much data, honestly.

    Each file is counted once, in the area it is kept for: the Projects'
    own files; an upload a conversation made or carried, or kept in the
    Chat folder, is the Chat's; one a product holds, or kept under Parts,
    McMaster-Carr or GrabCAD, is Parts'; the rest are My files. A file two
    areas use is counted where it is kept and listed as `shared` in the
    other (the same bytes are not counted twice). The rooms' build outputs
    (the 3D view's mesh, a board's layers) are a kind of their own,
    "build". `bytes` is the files' own size, `stored` what the database
    keeps of them (the rooms' outputs are kept gzipped).

    `range_` is 7d, 30d, 90d, all or auto (the shortest that holds what
    was added lately); `chart` is what each day (each week, for all) added
    per area, as the Analytics charts read it."""
    live = await _live(db)
    _, pfiles = await projects(db)
    _, qlinks = await parts(db, live)
    in_chat = await _chat_refs(db)
    in_parts = {x["file"] for x in qlinks}
    tops = await folder_tops(db)
    owner: dict[str, str] = {}
    shared: dict[str, set[str]] = {}
    for fid, d in live.items():
        owner[fid] = a = area_of(d, tops)
        for other, used in (("chat", in_chat), ("parts", in_parts)):
            if other != a and fid in used:
                shared.setdefault(other, set()).add(fid)
    areas = {a: {"files": 0, "bytes": 0, "stored": 0, "shared": {"files": 0, "bytes": 0}}
             for a in AREAS}
    rows: list[dict] = []
    _, tfiles = await tastes(db)
    for f in [*pfiles, *tfiles]:
        area = "taste" if f["where"] == "taste" else "projects"
        a = areas[area]
        a["files"] += 1
        a["bytes"] += f["bytes"]
        a["stored"] += f["stored"]
        rows.append({"id": f["id"], "name": f["name"], "bytes": f["bytes"], "area": area, "folder": f["folder"],
                     "kind": "build" if f.get("build") else f["kind"], "at": f["created_at"]})
    for fid, d in live.items():
        a = areas[owner[fid]]
        a["files"] += 1
        a["bytes"] += int(d.get("bytes") or 0)
        a["stored"] += int(d.get("bytes") or 0)
        rows.append({"id": fid, "name": d.get("name") or fid, "bytes": int(d.get("bytes") or 0),
                     "area": owner[fid], "folder": d.get("folder") or "", "kind": d.get("kind") or "other",
                     "at": d.get("created_at") or ""})
    for other, ids in shared.items():
        areas[other]["shared"] = {"files": len(ids), "bytes": sum(int(live[i].get("bytes") or 0) for i in ids)}

    today = datetime.now(timezone.utc).date()
    dates = sorted(_day(r["at"]) for r in rows if _day(r["at"]))
    first = dates[0] if dates else today.isoformat()
    if range_ == "auto":
        recent = [d for d in dates if d >= (today - timedelta(days=89)).isoformat()]
        old = (today - datetime.fromisoformat(recent[0] if recent else first).date()).days + 1 if dates else 7
        range_ = next((k for k, n in RANGES.items() if old <= n), "all")
    if range_ in RANGES:
        days, step = RANGES[range_], 1
    else:
        range_ = "all"
        days = min(730, (today - datetime.fromisoformat(first).date()).days + 1)
        step = 7 if days > 120 else 1
    n = max(1, -(-days // step))
    start = today - timedelta(days=n * step - 1)
    names = AREAS
    values = {a: [0] * n for a in names}
    added = {"files": 0, "bytes": 0}
    for r in rows:
        day = _day(r["at"])
        if not day:
            continue
        k = (datetime.fromisoformat(day).date() - start).days // step
        if 0 <= k < n:
            values[r["area"]][k] += r["bytes"]
            added["files"] += 1
            added["bytes"] += r["bytes"]
    t0 = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
    chart = {"t0": t0, "step": step * 86400, "n": n, "series": [{"name": a, "values": values[a]} for a in names]}

    kinds: dict[str, dict] = {}
    for r in rows:
        k = kinds.setdefault(r["kind"], {"files": 0, "bytes": 0})
        k["files"] += 1
        k["bytes"] += r["bytes"]
    rows.sort(key=lambda r: -r["bytes"])
    # The last week, a day at a time: what came in, and what was deleted from
    # Files (the audit trail's lines from files_api.py: "file <name>", "<n> file(s): ...").
    week = {(today - timedelta(days=i)).isoformat(): {"added": 0, "added_bytes": 0, "deleted": 0}
            for i in range(6, -1, -1)}
    for r in rows:
        if _day(r["at"]) in week and not r["id"].startswith(ROOT):
            week[_day(r["at"])]["added"] += 1
            week[_day(r["at"])]["added_bytes"] += r["bytes"]
    since = datetime.combine(today - timedelta(days=6), datetime.min.time(), timezone.utc)
    async for a in db["audit"].find({"action": "delete", "at": {"$gte": since}}, {"at": 1, "target": 1}):
        at, target = a.get("at"), str(a.get("target") or "")
        day = at.date().isoformat() if isinstance(at, datetime) else _day(str(at))
        cnt = 1 if target.startswith("file ") else int(m.group(1)) if (m := re.match(r"(\d+) file\(s\)", target)) else 0
        if day in week and cnt:
            week[day]["deleted"] += cnt
    held = [d async for d in db[files.TRASH].find({}, {"bytes": 1})]
    return {"range": range_, "first": first, "week": [{"day": d, **v} for d, v in week.items()],
            "trash": {"files": len(held), "bytes": sum(int(d.get("bytes") or 0) for d in held), "days": files.TRASH_DAYS},
            "areas": areas,
            "total": {k: sum(a[k] for a in areas.values()) for k in ("files", "bytes", "stored")},
            "files": [{k: r[k] for k in ("id", "name", "bytes", "area", "folder", "kind", "at")} for r in rows[:300]],
            "largest": [{k: r[k] for k in ("id", "name", "bytes", "area", "folder", "kind")} for r in rows[:10]],
            "chart": chart, "added": added,
            "kinds": dict(sorted(kinds.items(), key=lambda kv: -kv[1]["bytes"]))}


# ---------------------------------------------------------------- what uses a file, and when it is gone

async def uses(db, ids: list[str]) -> dict[str, dict]:
    """For each file: the conversations whose lines carry it, the products
    that hold it, and the model made of it - for the delete dialog."""
    from . import linked, product_files
    want = set(ids)
    out = {i: {"chats": [], "products": [], "model": None} for i in ids}
    async for c in db["cc_chats"].find({"messages.mentions.id": {"$in": list(want)}},
                                       {"title": 1, "messages.mentions": 1, "deleted_at": 1}):
        hit = {x.get("id") for m in c.get("messages") or [] for x in m.get("mentions") or []
               if x.get("kind") == "file"} & want
        for i in hit:
            out[i]["chats"].append((c.get("title") or "Untitled") + (" (in the trash)" if c.get("deleted_at") else ""))
    for coll, title in ((product_files.COLL, "name"), (linked.COLL, "title")):
        async for d in db[coll].find({"files.file": {"$in": list(want)}}, {title: 1, "files.file": 1}):
            for i in {f.get("file") for f in d.get("files") or []} & want:
                out[i]["products"].append(d.get(title) or "?")
    async for d in db[files.COLL].find({"_id": {"$in": list(want)}}, {"model": 1}):
        out[d["_id"]]["model"] = d.get("model")
    return out


def gone_line(name: str, fid: str, who: str, at: str) -> str:
    """What the model reads, after a line's context, about a file deleted since."""
    return (f"\n\n[Later: the file `{name}` (id {fid}) mentioned above was deleted from Files by {who} "
            f"on {at[:16].replace('T', ' ')} UTC. It is gone - it can no longer be opened or read. Do not use its "
            f"content as if it were still there; if asked about it, say it was deleted.]")


_GONE_LINE = re.compile(r"\n\n\[Later: the file `[^`]*` \(id (?P<id>[^)]+)\) mentioned above was deleted from Files by .*?\]",
                        re.S)


async def mark_back(db, fid: str) -> dict:
    """A file restored from the trash: the lines and products that said it
    was gone no longer do, and the model is no longer told so."""
    from . import linked, product_files
    n_chat = n_part = 0
    async for c in db["cc_chats"].find({"messages.mentions.id": fid},
                                       {"messages.id": 1, "messages.mentions": 1, "messages.context": 1}):
        for i, m in enumerate(c.get("messages") or []):
            unset = {f"messages.{i}.mentions.{j}.gone": "" for j, x in enumerate(m.get("mentions") or [])
                     if x.get("kind") == "file" and x.get("id") == fid and x.get("gone")}
            if not unset or not m.get("id"):
                continue
            upd: dict = {"$unset": unset}
            if isinstance(m.get("context"), str):
                upd["$set"] = {f"messages.{i}.context": _GONE_LINE.sub(
                    lambda g: "" if g.group("id") == fid else g.group(0), m["context"])}
            await db["cc_chats"].update_one({"_id": c["_id"], f"messages.{i}.id": m["id"]}, upd)
            n_chat += 1
    for coll in (product_files.COLL, linked.COLL):
        async for d in db[coll].find({"files.file": fid}, {"files": 1, "cad": 1, "picture": 1}):
            unset = {f"files.{j}.gone": "" for j, f in enumerate(d.get("files") or []) if f.get("file") == fid and f.get("gone")}
            if (d.get("cad") or {}).get("file") == fid and (d.get("cad") or {}).get("gone"):
                unset["cad.gone"] = ""
            if (d.get("picture") or {}).get("file") == fid and (d.get("picture") or {}).get("gone"):
                unset["picture.gone"] = ""
            if unset:
                await db[coll].update_one({"_id": d["_id"]}, {"$unset": unset})
                n_part += 1
    return {"chats": n_chat, "products": n_part}


async def mark_gone(db, doc: dict, by: dict) -> dict:
    """A file was deleted from Files: the Chat lines that carried it and the
    Parts products that held it say so. Each changed place is written by
    its own position, checked to be the same line or entry still."""
    from . import linked, product_files
    fid, name = doc["_id"], doc.get("name") or doc["_id"]
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    mark = {"by": _who(by), "at": at}
    who = mark["by"].get("name") or "someone"
    n_chat = n_part = 0
    async for c in db["cc_chats"].find({"messages.mentions.id": fid},
                                       {"messages.id": 1, "messages.mentions": 1, "messages.context": 1}):
        for i, m in enumerate(c.get("messages") or []):
            sets = {f"messages.{i}.mentions.{j}.gone": mark for j, x in enumerate(m.get("mentions") or [])
                    if x.get("kind") == "file" and x.get("id") == fid and not x.get("gone")}
            if not sets or not m.get("id"):
                continue
            if isinstance(m.get("context"), str):
                sets[f"messages.{i}.context"] = m["context"] + gone_line(name, fid, who, at)
            res = await db["cc_chats"].update_one({"_id": c["_id"], f"messages.{i}.id": m["id"]}, {"$set": sets})
            n_chat += getattr(res, "modified_count", 1) or 0
    for coll in (product_files.COLL, linked.COLL):
        async for d in db[coll].find({"files.file": fid}, {"files.file": 1, "cad.file": 1, "picture.file": 1}):
            sets = {f"files.{j}.gone": mark for j, f in enumerate(d.get("files") or []) if f.get("file") == fid}
            if (d.get("cad") or {}).get("file") == fid:
                sets["cad.gone"] = mark
            if (d.get("picture") or {}).get("file") == fid:
                sets["picture.gone"] = mark
            if sets:
                await db[coll].update_one({"_id": d["_id"]}, {"$set": sets})
                n_part += 1
    return {"chats": n_chat, "products": n_part}
