"""What the build made: what fills flash (by group, archive, file), size history, commits and diffs.

Routes under /api/embedded/<app>/... (rooms/fw-*.ts, rooms/code-view.ts).

The sizes are written by backend/firmware.py when a build succeeds (the
"fw-sizes" artifact, and a line per build on the app's firmware_history);
this only reads them. The commits are the firmware project's own git
history, read with git on the host - the project's directory, nothing
outside it.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .. import apps, store

router = APIRouter(prefix="/api/embedded")

HASH = re.compile(r"[0-9a-f]{7,40}")
MAX_TEXT = 256 * 1024          # one side of a diff; a bigger file is not shown
COMMITS = 20


def _db():
    # Late: main imports this module and owns the one connection.
    from backend.main import db
    return db()


async def _app(aid: str) -> dict:
    doc = await _db()[apps.APPS].find_one({"_id": aid})
    if not doc:
        raise HTTPException(404, aid)
    if (doc.get("platform") or "web") != "embedded":
        raise HTTPException(400, f"{aid} is not firmware")
    return doc


# ---------------- the size change ----------------
def change(history: list[dict]) -> dict:
    """The last build against the one before it: per owner, per memory
    region and in all. `state` says which: first build, no change, or
    changed."""
    good = [h for h in history or [] if h.get("regions") or h.get("groups")]
    if len(good) < 2:
        return {"state": "first" if good else "none", "total": None,
                "groups": {}, "regions": [], "at": None, "was_at": None}
    was, now = good[-2], good[-1]
    groups = {g: (now.get("groups") or {}).get(g, 0) - (was.get("groups") or {}).get(g, 0)
              for g in ("yours", "framework", "runtime")
              if now.get("groups") is not None and was.get("groups") is not None}
    before = {r["name"]: r for r in was.get("regions") or []}
    regions = [{"name": r["name"], "used": r["used"], "size": r.get("size"),
                "delta": r["used"] - before[r["name"]]["used"]}
               for r in now.get("regions") or [] if r["name"] in before]
    total = (now["total"] - was["total"]) if now.get("total") is not None \
        and was.get("total") is not None else None
    moved = any(groups.values()) or any(r["delta"] for r in regions) or bool(total)
    return {"state": "changed" if moved else "same", "total": total, "groups": groups,
            "regions": regions, "at": now.get("at"), "was_at": was.get("at"),
            "commit": now.get("commit"), "was_commit": was.get("commit")}


@router.get("/{aid}/build")
async def build_view(aid: str):
    """What the last build made: flash by owner, archive, file and
    function; the project's own files; its largest functions; and the
    size change against the build before."""
    a = await _app(aid)
    fw = a.get("firmware") or {}
    try:
        sizes = json.loads(await store.get_artifact(_db(), aid, "fw-sizes", apps.APPS))
    except KeyError:
        sizes = None
    history = a.get("firmware_history") or []
    return {"built": {"at": fw.get("at"), "ok": fw.get("ok"), "arch": fw.get("arch"),
                      "elf": fw.get("elf"), "wall_s": fw.get("wall_s")} if fw else None,
            "sizes": sizes, "history": history, "change": change(history)}


# ---------------- git ----------------
async def git(repo: str, *args: str, timeout: float = 20) -> tuple[int, str]:
    try:
        p = await asyncio.create_subprocess_exec(
            "git", "-C", repo, *args, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
    except OSError:
        return 127, ""
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        return -9, ""
    return p.returncode or 0, out.decode(errors="replace")


def where(app: dict) -> tuple[str, str]:
    """The repository and the firmware project's directory in it."""
    return str(Path(app["repo"]).resolve()), (app.get("cwd") or "").strip("/") or "."


def inside(repo: str, rel: str) -> Path | None:
    """A path git named, only if it is in the repository."""
    root = Path(repo).resolve()
    p = (root / rel).resolve()
    return p if p.is_relative_to(root) and p != root else None


def parse_log(text: str) -> list[dict]:
    """git log --format=<RS>h<US>...  --numstat: one commit per record,
    its lines added and removed summed."""
    out = []
    for rec in text.split("\x1e"):
        if not rec.strip():
            continue
        head, _, rest = rec.partition("\n")
        parts = head.split("\x1f")
        if len(parts) < 6:
            continue
        added = removed = files = 0
        for line in rest.splitlines():
            m = re.match(r"^(\d+|-)\t(\d+|-)\t", line)
            if m:
                files += 1
                added += int(m.group(1)) if m.group(1) != "-" else 0
                removed += int(m.group(2)) if m.group(2) != "-" else 0
        out.append({"hash": parts[0], "short": parts[1], "subject": parts[2],
                    "author": parts[3], "when": parts[4], "at": parts[5],
                    "files": files, "added": added, "removed": removed})
    return out


def parse_status(text: str) -> list[dict]:
    """git status --porcelain=v1 -z: each changed path and how."""
    out = []
    items = text.split("\0")
    i = 0
    while i < len(items):
        it = items[i]
        i += 1
        if len(it) < 4:
            continue
        xy, path = it[:2], it[3:]
        if xy[0] in "RC":
            i += 1                      # the old name follows a rename
        state = ("untracked" if xy == "??" else "added" if "A" in xy
                 else "deleted" if "D" in xy else "renamed" if "R" in xy else "modified")
        out.append({"path": path, "state": state})
    return out


def parse_numstat(text: str) -> dict[str, tuple[int, int, bool]]:
    out = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            binary = parts[0] == "-"
            out[parts[2]] = (0 if binary else int(parts[0]), 0 if binary else int(parts[1]), binary)
    return out


def _lines(p: Path) -> int:
    try:
        if p.stat().st_size > MAX_TEXT:
            return 0
        return p.read_text(errors="replace").count("\n")
    except OSError:
        return 0


async def worktree_files(repo: str, sub: str) -> list[dict]:
    rc, st = await git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", sub)
    if rc:
        return []
    _, ns = await git(repo, "diff", "HEAD", "--numstat", "--no-renames", "--", sub)
    counts = parse_numstat(ns)
    out = []
    for f in parse_status(st):
        p = inside(repo, f["path"])
        if not p:
            continue
        a, r, binary = counts.get(f["path"], (0, 0, False))
        if f["state"] == "untracked":
            a = _lines(p)
        out.append({**f, "added": a, "removed": r, "binary": binary})
    return out


@router.get("/{aid}/commits")
async def commits(aid: str):
    """The firmware project's recent commits, and what is changed in its
    working tree and not committed."""
    a = await _app(aid)
    repo, sub = where(a)
    rc, _ = await git(repo, "rev-parse", "--git-dir")
    if rc:
        return {"git": False, "dir": sub, "commits": [], "worktree": []}
    _, log = await git(repo, "log", f"-n{COMMITS}", "--no-renames",
                       "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%aI", "--numstat", "--", sub)
    return {"git": True, "dir": sub, "commits": parse_log(log),
            "worktree": await worktree_files(repo, sub)}


async def _show(repo: str, rev: str, path: str) -> tuple[str, bool]:
    """A file's text at a revision; ("", False) when it is not there, and
    too big or binary says so."""
    rc, out = await git(repo, "cat-file", "-s", f"{rev}:{path}")
    if rc:
        return "", False
    if int(out.strip() or 0) > MAX_TEXT:
        return "", True
    rc, out = await git(repo, "show", f"{rev}:{path}")
    return ("", False) if rc else (out, "\0" in out)


def _disk(p: Path) -> tuple[str, bool]:
    try:
        if p.stat().st_size > MAX_TEXT:
            return "", True
        raw = p.read_bytes()
    except OSError:
        return "", False
    return ("", True) if b"\0" in raw else (raw.decode(errors="replace"), False)


@router.get("/{aid}/commits/{rev}")
async def commit_diff(aid: str, rev: str):
    """One commit's changed files in the firmware project, each before and
    after, for a diff."""
    if not HASH.fullmatch(rev):
        raise HTTPException(400, "a commit is 7 to 40 hex digits")
    a = await _app(aid)
    repo, sub = where(a)
    rc, full = await git(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    if rc:
        raise HTTPException(404, f"no commit {rev}")
    full = full.strip()
    _, head = await git(repo, "log", "-1", "--format=%h%x1f%s%x1f%an%x1f%ar%x1f%P", full)
    short, subject, author, when, parents = (head.rstrip("\n").split("\x1f") + [""] * 5)[:5]
    parent = parents.split()[0] if parents.strip() else None
    _, ns = await git(repo, "show", "--numstat", "--format=", "--no-renames", full, "--", sub)
    files = []
    for path, (added, removed, binary) in parse_numstat(ns).items():
        if not inside(repo, path):
            continue
        before, big1 = await _show(repo, parent, path) if parent else ("", False)
        after, big2 = await _show(repo, full, path)
        skip = binary or big1 or big2
        files.append({"path": path, "added": added, "removed": removed, "binary": skip,
                      "before": "" if skip else before, "after": "" if skip else after})
    return {"hash": full, "short": short, "subject": subject, "author": author,
            "when": when, "parent": parent, "files": files}


@router.get("/{aid}/worktree")
async def worktree_diff(aid: str):
    """The working tree's changed files in the firmware project, each as
    committed (HEAD) and as on disk."""
    a = await _app(aid)
    repo, sub = where(a)
    out = []
    for f in await worktree_files(repo, sub):
        p = inside(repo, f["path"])
        before, big1 = ("", False) if f["state"] in ("untracked", "added") \
            else await _show(repo, "HEAD", f["path"])
        after, big2 = ("", False) if f["state"] == "deleted" else _disk(p)
        skip = f["binary"] or big1 or big2
        out.append({**f, "binary": skip, "before": "" if skip else before,
                    "after": "" if skip else after})
    return {"dir": sub, "files": out}
