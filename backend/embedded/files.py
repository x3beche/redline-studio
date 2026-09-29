"""The code editor on a firmware: the project's files on disk - list, read, write - with git status.

Routes under /api/embedded/<app>/... (rooms/fw-*.ts, rooms/code-view.ts).

A firmware is not one file in the database, as a model or a board is: it is
a directory in a git checkout. Which directory is read off the app - its
repo, its cwd, and the `-C <dir>` its build command names (`idf.py -C
demoboard ...`). Its sources may reach out of it by relative path - a
`../../common/fan.c` in a CMakeLists - and those directories are part of
the project too. The editor sees, and may write, those directories and
nothing else.

Paths on the wire are relative to the nearest directory holding all of
them (the "anchor": for iot-fan that is firmware/, so `demoboard/main/main.c`
and `common/fan.h`).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import shlex
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/embedded")

MAX_BYTES = 512 * 1024
MAX_FILES = 3000
# Directories that are made, not written: never listed, never written.
SKIP_DIRS = {".git", "build", "managed_components", "node_modules", "__pycache__", ".cache",
             ".venv", "venv", ".pio", ".vscode", ".idea", "dist", "out", "Debug", "Release"}
# Build systems whose files name the sources, and so the directories, a firmware uses.
BUILD_FILES = ("CMakeLists.txt", "Makefile", "makefile", "GNUmakefile", "component.mk")


# ---------------- which directories are the project ----------------
def _skipped(parts: tuple[str, ...] | list[str]) -> bool:
    return any(p in SKIP_DIRS or p.startswith("build-") or p.startswith("build_")
               or (p.startswith("cmake-build")) for p in parts)


def project_dir(app: dict) -> Path:
    """repo / cwd / the build command's -C <dir> (when it names one inside)."""
    base = Path(app["repo"]) / (app.get("cwd") or "")
    try:
        argv = shlex.split(app.get("build") or "")
    except ValueError:
        argv = (app.get("build") or "").split()
    for i, a in enumerate(argv):
        sub = None
        if a == "-C" and i + 1 < len(argv):
            sub = argv[i + 1]
        elif a.startswith("-C") and len(a) > 2 and not a.startswith("-C-"):
            sub = a[2:]
        if sub and "$" not in sub:
            cand = (base / sub).resolve()
            if cand.is_dir() and _inside(cand, Path(app["repo"]).resolve()):
                return cand
    return base.resolve()


def _inside(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


_REL = re.compile(r"""(?:^|[\s"'(=;:])((?:\.\./)+[^\s"'();$]*)""")
_INC_BLOCK = re.compile(r"(?:INCLUDE_DIRS|PRIV_INCLUDE_DIRS|include_directories|target_include_directories)"
                        r"([^)]*)", re.S)
_WORDS = re.compile(r"\"([^\"]*)\"|([^\s\"()]+)")
_KEYWORD = re.compile(r"^[A-Z][A-Z_]+$")


def _build_files(proj: Path) -> list[Path]:
    out = []
    for dirpath, dirnames, filenames in os.walk(proj):
        dirnames[:] = [d for d in dirnames if not _skipped([d]) and not d.startswith(".")]
        for f in filenames:
            if f in BUILD_FILES:
                out.append(Path(dirpath) / f)
        if len(out) > 200:
            break
    return out


def layout(app: dict) -> dict:
    """The project's directories: the firmware's own, the ones its build
    files reach by relative path, the include directories they name, and
    the anchor all paths are written against."""
    repo = Path(app["repo"]).resolve()
    proj = project_dir(app)
    roots: list[Path] = [proj]
    includes: list[Path] = []

    def add_root(d: Path) -> None:
        if not d.is_dir() or not _inside(d, repo) or _inside(proj, d) and d != proj:
            return                              # outside the checkout, or a parent of the project
        if _skipped(d.relative_to(repo).parts):
            return
        if any(_inside(d, r) for r in roots):
            return
        roots[:] = [r for r in roots if not _inside(r, d)] + [d]

    for bf in _build_files(proj):
        try:
            text = bf.read_text(errors="replace")
        except OSError:
            continue
        text = re.sub(r"#.*", "", text)
        for m in _REL.finditer(text):
            target = (bf.parent / m.group(1)).resolve()
            add_root(target if target.is_dir() else target.parent)
        for block in _INC_BLOCK.finditer(text):
            for w in _WORDS.finditer(block.group(1)):
                word = w.group(1) if w.group(1) is not None else w.group(2)
                if not word or _KEYWORD.match(word) or "$" in word or word.startswith("-"):
                    continue
                d = (bf.parent / word).resolve()
                if d.is_dir() and _inside(d, repo):
                    includes.append(d)
    # Nothing found: a sibling `common` is the usual shared code.
    if len(roots) == 1 and (proj.parent / "common").is_dir() and proj != repo:
        add_root((proj.parent / "common").resolve())
    anchor = Path(os.path.commonpath([str(r) for r in roots]))
    if not _inside(anchor, repo):
        anchor = repo
    includes = [d for d in dict.fromkeys(includes) if any(_inside(d, r) for r in roots)]
    return {"repo": repo, "project": proj, "roots": roots, "anchor": anchor, "includes": includes}


# ---------------- git ----------------
def _git(repo: Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, timeout=20)
    if out.returncode:
        raise RuntimeError(out.stderr.decode(errors="replace").strip() or f"git {args[0]} failed")
    return out.stdout.decode(errors="replace")


def status_of(xy: str) -> str | None:
    """A porcelain XY code as the editor's one mark: untracked, modified
    (changed in the working tree, staged or not), staged (only staged)."""
    if xy == "??":
        return "untracked"
    if xy == "!!":
        return None
    x, y = xy[0], xy[1]
    if y in "MDT" or "U" in xy:
        return "modified"
    if x in "MADRCT":
        return "staged"
    return None


def git_status(repo: Path, pathspecs: list[str]) -> dict[str, str]:
    """repo-relative path -> mark, from `git status --porcelain -z`."""
    raw = _git(repo, "status", "--porcelain", "-z", "--untracked-files=all", "--", *pathspecs)
    out: dict[str, str] = {}
    items = raw.split("\0")
    i = 0
    while i < len(items):
        it = items[i]
        i += 1
        if len(it) < 4:
            continue
        xy, path = it[:2], it[3:]
        if xy[0] in "RC":
            i += 1                              # the old name follows a rename
        mark = status_of(xy)
        if mark:
            out[path] = mark
    return out


def _is_text(p: Path) -> bool:
    try:
        with p.open("rb") as f:
            head = f.read(8192)
    except OSError:
        return False
    if b"\0" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as exc:
        # A multi-byte character cut at the 8 KB edge is still text.
        return exc.start >= len(head) - 4
    return True


def listing(app: dict) -> dict:
    lay = layout(app)
    repo, anchor = lay["repo"], lay["anchor"]
    specs = [str(r.relative_to(repo)) or "." for r in lay["roots"]]
    raw = _git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *specs)
    status = git_status(repo, specs)
    files = []
    for rel in sorted(set(raw.split("\0")) - {""}):
        parts = rel.split("/")
        if _skipped(parts[:-1]):
            continue
        p = repo / rel
        if p.is_symlink() or not p.is_file():
            continue                            # deleted in the tree, or a link
        size = p.stat().st_size
        if size > MAX_BYTES or not _is_text(p):
            continue
        a = p.resolve()
        if not any(_inside(a, r) for r in lay["roots"]):
            continue
        files.append({"path": a.relative_to(anchor).as_posix(), "size": size,
                      "git": status.get(rel), "language": language_of(rel)})
        if len(files) >= MAX_FILES:
            break
    return {"root": anchor.name, "anchor": anchor.relative_to(repo).as_posix() if anchor != repo else "",
            "project": lay["project"].relative_to(anchor).as_posix() if lay["project"] != anchor else "",
            "includes": [d.relative_to(anchor).as_posix() for d in lay["includes"] if _inside(d, anchor)],
            "open": _first(files, lay["project"].relative_to(anchor).as_posix()
                           if lay["project"] != anchor else ""),
            "files": files}


def _first(files: list[dict], proj: str) -> str | None:
    """The file to open first: the project's main source."""
    pre = proj + "/" if proj else ""
    names = [f["path"] for f in files]
    for cand in ("main/main.c", "main/main.cpp", "src/main.c", "src/main.cpp", "main.c", "main.cpp",
                 "Core/Src/main.c", "src/main.rs"):
        if pre + cand in names:
            return pre + cand
    for n in names:
        if n.startswith(pre) and re.search(r"(^|/)main\.(c|cpp|cc)$", n):
            return n
    src = [n for n in names if n.startswith(pre) and n.endswith((".c", ".cpp", ".cc"))]
    return (src or [n for n in names if n.startswith(pre)] or names or [None])[0]


# ---------------- one file ----------------
LANGUAGES = {".c": "cpp", ".h": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
             ".hh": "cpp", ".ino": "cpp", ".py": "python", ".json": "json", ".yaml": "yaml",
             ".yml": "yaml", ".md": "markdown", ".rs": "rust", ".sh": "shell", ".js": "javascript",
             ".ts": "typescript", ".html": "html", ".css": "css", ".xml": "xml"}


def language_of(path: str) -> str:
    """Monaco's language for a file: C and C++ as cpp; CMake, Kconfig,
    ini, linker scripts and the rest as plain text."""
    return LANGUAGES.get(Path(path).suffix.lower(), "plaintext")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def resolve(app: dict, rel: str, lay: dict | None = None) -> Path:
    """The file a wire path names, or 400/403: never outside the project's
    directories, never through a link, never in a build directory."""
    lay = lay or layout(app)
    if not rel or "\0" in rel or rel.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", rel):
        raise HTTPException(400, "a path inside the project, please")
    parts = Path(rel).parts
    if any(p in ("..", ".") for p in parts) or "\\" in rel:
        raise HTTPException(400, "no .. in a path")
    if _skipped(list(parts[:-1])):
        raise HTTPException(403, "that is a build directory - it is made, not written")
    raw = lay["anchor"] / rel
    # No link anywhere on the way down from the anchor.
    walk = lay["anchor"]
    for part in parts:
        walk = walk / part
        if walk.is_symlink():
            raise HTTPException(403, "that path goes through a link")
    real = raw.resolve()
    if not any(_inside(real, r) for r in lay["roots"]):
        raise HTTPException(403, "outside the firmware's directories")
    return real


def read_file(app: dict, rel: str) -> dict:
    p = resolve(app, rel)
    if not p.is_file():
        raise HTTPException(404, rel)
    data = p.read_bytes()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "too large to edit here")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(415, "not a text file")
    if "\0" in text:
        raise HTTPException(415, "not a text file")
    return {"path": rel, "text": text, "hash": digest(data), "language": language_of(rel),
            "stale": bool(app.get("stale"))}


def write_file(app: dict, rel: str, text: str, base_hash: str | None) -> dict:
    """Write the text, unless the file changed since `base_hash` was read:
    then 409, with what is there now. A new file only when no hash is given."""
    p = resolve(app, rel)
    data = text.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "too large to edit here")
    if "\0" in text:
        raise HTTPException(415, "only text")
    if p.exists():
        if not p.is_file():
            raise HTTPException(400, "not a file")
        cur = p.read_bytes()
        if b"\0" in cur[:8192]:
            raise HTTPException(415, "not a text file")
        if base_hash is not None and digest(cur) != base_hash:
            raise HTTPException(409, {"detail": "the file changed while you were editing it - "
                                                "an agent or someone else saved first",
                                      "hash": digest(cur), "rev": digest(cur),
                                      "text": cur.decode("utf-8", errors="replace")})
    elif base_hash:
        raise HTTPException(409, {"detail": "the file was deleted while you were editing it",
                                  "hash": None, "rev": None, "text": ""})
    elif not p.parent.is_dir():
        raise HTTPException(404, "no such directory")
    tmp = p.with_name(f".{p.name}.redline-tmp")
    tmp.write_bytes(data)
    if p.exists():
        os.chmod(tmp, p.stat().st_mode & 0o7777)
    os.replace(tmp, p)
    return {"path": rel, "hash": digest(data), "saved": True}


# ---------------- the routes ----------------
async def _load_app(aid: str) -> dict:
    from ..code_api import _app
    a = await _app(aid)
    if (a.get("platform") or "web") != "embedded" or not a.get("repo"):
        raise HTTPException(400, f"{aid} is not a firmware")
    return a


async def _record(app: dict, rel: str) -> None:
    """A save, in the audit trail as a model's is, and in the Embedded
    room's log; the build is out of date from here."""
    from .. import actors
    from ..main import db, say
    d = db()
    await d.apps.update_one({"_id": app["_id"]}, {"$set": {"stale": True}})
    await actors.audit(d, "edit", f"app {app['_id']}", {"how": "code view", "file": rel})
    try:
        await say(f"{app['_id']}: {actors.current()['name']} saved {rel}", "info", "embedded")
    except Exception:                               # noqa: BLE001
        pass


class FileIn(BaseModel):
    text: str = Field(max_length=MAX_BYTES)
    base_hash: str | None = Field(default=None, max_length=64)


@router.get("/{aid}/files")
async def list_files(aid: str):
    a = await _load_app(aid)
    try:
        return await asyncio.to_thread(listing, a)
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
        raise HTTPException(502, str(exc))


@router.get("/{aid}/files/{path:path}")
async def get_file(aid: str, path: str):
    a = await _load_app(aid)
    return await asyncio.to_thread(read_file, a, path)


@router.put("/{aid}/files/{path:path}")
async def put_file(aid: str, path: str, body: FileIn):
    a = await _load_app(aid)
    out = await asyncio.to_thread(write_file, a, path, body.text, body.base_hash)
    await _record(a, path)
    return out
