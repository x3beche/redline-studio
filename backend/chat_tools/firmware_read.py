"""firmware_read: a firmware's source and its last build's log, as the
Firmware room shows them - its file tree (GET /api/firmware/{id}/files:
firmware.tree), a file's text (firmware.read, paged by lines) and the
compiler's lines of its last build (GET /api/firmware/{id}/log: the build
job's `lines`), the errors first and then the end of it.

It only reads: firmware_build says how the builds went, the Firmware room
changes the code."""

from __future__ import annotations

import re

from .. import firmware, fwbuild
from . import Ctx, Result, Tool, ToolError, clip, size
from ._rights import need
from ._things import find

WHAT = ("source", "log", "files")
MAX_FILES = 200                     # files a list names
MAX_LINES = 400                     # lines of a file one call gives
MAX_CHARS = 16_000                  # characters of source one call gives
FIRST = 3                           # files read when none is named: the entry points
TAIL = 120                          # the log's last lines
MAX_ERRORS = 40                     # its error lines, given first
ERROR = re.compile(r"\b(error|fatal|undefined reference|failed)\b", re.I)


def _main_files(tree: list[dict]) -> list[str]:
    """What to read when no file is named: the code someone wrote, the entry points first."""
    code = [f["path"] for f in tree if not f.get("generated")
            and f["path"].rsplit(".", 1)[-1].lower() in ("c", "cpp", "cc", "ino", "h", "hpp", "py")]
    rank = lambda p: (0 if re.search(r"(^|/)main\.\w+$", p) else 1 if p.startswith("src/") else 2, p)  # noqa: E731
    return sorted(code, key=rank)[:FIRST]


def _listing(tree: list[dict]) -> list[str]:
    out = [f"  {f['path']}  {size(f.get('bytes') or 0)}  v{f.get('version')}" + ("  (generated)" if f.get("generated") else "")
           for f in tree[:MAX_FILES]]
    if len(tree) > MAX_FILES:
        out.append(f"  ... and {len(tree) - MAX_FILES} more")
    return out


def _numbered(text: str, start: int) -> tuple[str, int, int]:
    """Lines from `start` (1-based), at most MAX_LINES and MAX_CHARS: the text, the last line given, all lines."""
    lines = text.splitlines()
    out, used, last = [], 0, start - 1
    for i in range(start - 1, min(len(lines), start - 1 + MAX_LINES)):
        row = f"{i + 1:>5}  {lines[i]}"
        if used + len(row) > MAX_CHARS and out:
            break
        out.append(row)
        used += len(row) + 1
        last = i + 1
    return "\n".join(out), last, len(lines)


async def _source(ctx: Ctx, fw: dict, path: str, start: int) -> Result:
    fid = fw["_id"]
    need("GET", f"/api/firmware/{fid}/files")
    tree = await firmware.tree(ctx.db, fid)
    if not tree:
        return Result(text=f"Firmware {fid} has no files yet.", say="{title} has no files yet",
                      vars={"title": fw.get("title") or fid, "firmware": fid}, summary="no files")
    wanted = [path] if path else _main_files(tree)
    out = [f"Firmware {fid} \"{fw.get('title')}\" at version {fw.get('version')}: {len(tree)} files"]
    out += _listing(tree)
    read = []
    for p in wanted:
        try:
            got = await firmware.read(ctx.db, fid, p)
        except KeyError:
            raise ToolError(f"no file {p!r} in firmware {fid} - the files are listed with what=files") from None
        except firmware.Refused as exc:
            raise ToolError(str(exc)) from None
        text, last, total = _numbered(got.get("content") or "", start if path else 1)
        more = (f" - lines {start if path else 1}-{last} of {total}; ask again with from_line {last + 1} for the rest"
                if last < total else "")
        out.append(f"\n--- {got['path']} (v{got.get('version')}"
                   + (", generated from the schematic - change the board, not this file" if got.get("generated") else "")
                   + f"){more} ---\n{text}")
        read.append(got["path"])
    v = {"title": fw.get("title") or fid, "firmware": fid, "n": len(read), "files": len(tree),
         "path": read[0] if len(read) == 1 else ""}
    return Result(text=clip("\n".join(out)), say="Read {n} files of {title}" if len(read) != 1 else "Read {path} of {title}",
                  vars=v, summary=f"{len(tree)} files · read " + ", ".join(read))


async def _files(ctx: Ctx, fw: dict) -> Result:
    fid = fw["_id"]
    need("GET", f"/api/firmware/{fid}/files")
    tree = await firmware.tree(ctx.db, fid)
    text = (f"Firmware {fid} \"{fw.get('title')}\" at version {fw.get('version')}: {len(tree)} files "
            "(read one with what=source and its path):\n" + "\n".join(_listing(tree)))
    return Result(text=clip(text), say="Listed the {files} files of {title}",
                  vars={"title": fw.get("title") or fid, "firmware": fid, "files": len(tree)},
                  summary="\n".join(f["path"] for f in tree[:20]))


async def _log(ctx: Ctx, fw: dict) -> Result:
    fid = fw["_id"]
    need("GET", f"/api/firmware/{fid}/log")
    b = fw.get("build") or {}
    v = {"title": fw.get("title") or fid, "firmware": fid, "state": b.get("state") or "never built"}
    raw, ws = getattr(ctx.db, "raw", ctx.db), getattr(ctx.db, "workspace", "default")
    job = await fwbuild.get(raw, b["job"]) if b.get("job") else None
    if not job or job.get("workspace") != ws:
        return Result(text=f"Firmware {fid} has no build log" + (" - it was never built." if not b else " kept."),
                      say="{title} has no build log", vars=v, summary="no log")
    lines = job.get("lines") or []
    errors = [ln for ln in lines if ln.get("level") == "error" or ERROR.search(str(ln.get("text") or ""))]
    out = [f"The last build of firmware {fid} \"{fw.get('title')}\": {b.get('state')}, version {b.get('version')}, "
           f"at {b.get('at')}, {b.get('seconds')} s (job {b.get('job')}); {len(lines)} log lines, "
           f"{len(errors)} of them errors."]
    if errors:
        out.append(f"Errors ({min(len(errors), MAX_ERRORS)} of {len(errors)}):")
        out += [f"  {str(e.get('text') or '')[:400]}" for e in errors[:MAX_ERRORS]]
    tail = lines[-TAIL:]
    out.append(f"The end of the log ({len(tail)} of {len(lines)} lines):")
    out += [f"  {str(ln.get('text') or '')[:400]}" for ln in tail]
    v.update(lines=len(lines), errors=len(errors))
    return Result(text=clip("\n".join(out)), say="Read the build log of {title}: {errors} errors", vars=v,
                  summary=f"{b.get('state')} · {len(lines)} lines · {len(errors)} errors"
                          + (f"\n{str(errors[0].get('text') or '')[:200]}" if errors else ""))


async def run(ctx: Ctx, args: dict) -> Result:
    ref = str(args.get("firmware") or "").strip()
    if not ref:
        raise ToolError("say which firmware (its id, title or board - firmware_build lists them)")
    what = str(args.get("what") or "source").strip().lower()
    if what not in WHAT:
        raise ToolError("what is source, log or files")
    try:
        start = max(1, int(args.get("from_line") or 1))
    except (TypeError, ValueError):
        raise ToolError("from_line is a line number") from None
    fw = await find(ctx.db, firmware.COLL, ref, ("title", "name", "board", "mcu_title"), "firmware")
    if what == "log":
        return await _log(ctx, fw)
    if what == "files":
        return await _files(ctx, fw)
    return await _source(ctx, fw, str(args.get("path") or "").strip(), start)


TOOL = Tool(
    name="firmware_read", package="firmware", level="read", order=67,
    label="Read a firmware",
    about="Reads a firmware's source files and its last build log, as the Firmware room shows them.",
    description="Read a firmware project (the Firmware room) as the room shows it: `what` source (default) gives its "
                "file list and a file's text with line numbers - `path` names it, else its entry points (main first) "
                "are read; a long file is paged with `from_line`; files lists them only (generated ones such as "
                "pins.h say so); log gives the last build's compiler output, its error lines first and then its end. "
                "It only reads - firmware_build says how the builds went.",
    schema={"type": "object", "properties": {
        "firmware": {"type": "string", "description": "The firmware's id, title or board"},
        "what": {"type": "string", "enum": list(WHAT), "description": "source (default), log or files"},
        "path": {"type": "string", "description": "A file's path, e.g. src/main.cpp"},
        "from_line": {"type": "integer", "minimum": 1, "description": "Where to go on reading a long file"}},
        "required": ["firmware"]},
    running="Reading a firmware", failed="Could not read the firmware",
    run=run)
