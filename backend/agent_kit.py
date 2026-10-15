"""The agent kit: what an agent on someone's own computer needs, served to
whoever holds an agent token.

People run their main agent on their own machine, from the seed
(https://github.com/x3beche/redline-agent-seed): a start script and a few
instructions, no source. On every start the seed asks for this kit
(GET /api/agent/kit, backend/agent_api.py) and unpacks it next to itself,
so what it runs is always what the server runs today.

What is in it:

- the command line the agents use - tools/revisions.py, its MCP server, the
  remote database (tools/remote_db.py) and render.py - and the library
  modules of backend/ those import, found by following their imports
  (lazy ones too) and stopping at the server's own modules (SERVER): the
  app, sign-in, accounts, tokens, the agents' way in, the chat, Telegram.
  Nothing that holds a setting or a secret: those are in the database and
  .env, and neither is in the kit;
- the agents' instructions: AGENTS.md, TOOLS.md, .claude/agents/*.md;
- written here: a CLAUDE.md on working remotely, .mcp.json,
  .claude/settings.json (the commands it may run without asking),
  requirements.txt (light: no build123d - builds and kept parts run on the
  server, tools/revisions.py _on_the_server) and VERSION;
- the same for OpenCode (the seed's `--runner opencode`): opencode.json
  (the MCP server, the same permissions, CLAUDE.md and OPENCODE.md as
  instructions), .opencode/agents/*.md made from .claude/agents/*.md, and
  .opencode/plugins/redline-wait.js (tools/opencode/), which runs
  `revisions.py wait` whenever the main agent goes idle, OpenCode having no
  background shell.

The tarball is the same bytes for the same files (sorted, no times, no
owners), so its hash is its version and the seed fetches it only when it
changed.
"""

from __future__ import annotations

import ast
import gzip
import hashlib
import io
import json
import os
import re
import tarfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where people get the seed; the page shows it with the one line to run.
SEED_URL = os.environ.get("REDLINE_AGENT_SEED", "https://github.com/x3beche/redline-agent-seed").rstrip("/")

ENTRY = ("tools/revisions.py", "tools/remote_db.py", "tools/mcp_server.py", "tools/render.py")
DATA = ("backend/passives.json",)
DOC_GLOBS = ("AGENTS.md", "TOOLS.md", ".claude/agents/*.md")

# The server's own modules: never in the kit, and where following imports
# stops. A kit module that imports one does so only inside a function the
# command line does not call.
SERVER = frozenset({
    "backend.main", "backend.auth", "backend.accounts", "backend.admin", "backend.agent_api",
    "backend.agent_kit", "backend.tgbot", "backend.cc_chat", "backend.cc_context", "backend.ccgen",
    "backend.chat_tools", "backend.llm_api", "backend.tools_api", "backend.tools_llm",
    "backend.tool_router", "backend.files_api", "backend.firmware_api", "backend.bodies_api",
    "backend.imports.api", "backend.rustdesk", "backend.release", "backend.client_errors",
    "backend.sysinfo", "backend.profile", "backend.insights",
    "backend.manufacturers", "backend.themes",
})

# What the kit's modules need from PyPI - and not build123d, OpenCascade,
# KiCad or atopile: that work is the server's.
REQUIREMENTS = """\
httpx>=0.27
pymongo>=4.9
motor>=3.6
python-dotenv>=1.0
fastapi>=0.115
pydantic>=2.0
numpy>=1.26
psutil>=5.9
pillow>=10
websockets>=12
pypdfium2==5.14.0
cryptography>=43
python-multipart>=0.0.9
"""

CLAUDE_MD = """\
# Workbench agent, on this computer

You are a Workbench agent running on the person's own computer. You reach
Workbench only through its API: the commands in AGENTS.md work here exactly
as written (`.venv/bin/python tools/revisions.py ...`), and every one of
them goes to the server with the token in your environment.

Read **AGENTS.md** now, then start the main-agent loop it describes
("First thing to do", "One main agent, one agent per room", "Never stop
between revisions"). The room agents are in `.claude/agents/` (for
OpenCode the same ones are in `.opencode/agents/`; read OPENCODE.md too).
Where AGENTS.md says the Agent tool, use your sub-agent tool (OpenCode:
`task`); where it says the Read tool, your file-reading tool - it shows
a PNG as a picture.

What is different from AGENTS.md here:

- `REDLINE_TRANSPORT=api`, `REDLINE_API`, `REDLINE_TOKEN` and `REDLINE_AGENT`
  are already set. There is no `MONGODB_URI` and no `.env` in this folder:
  never ask for the database password, never look for one.
- **Never print, echo, write or paste `REDLINE_TOKEN`** - not into a file,
  a note, the thread, a log line, a commit or a command's output. If a
  command says it wants an agent token, tell the person in the thread to
  check the seed's `.env`; do not ask them to paste it to you.
- `build` runs on the server (it takes minutes; the command waits and
  prints what the build did). `part keep` fetches and seats parts on the
  server. `export_model.py`, `tools/capped.sh` and local builds are not in
  this kit: check your arithmetic by reading the source carefully instead.
- `render.py`, `after` and `finish` take the picture with a Chrome or
  Chromium on this computer (or Docker). Without one, say so in the thread
  and finish the note without the picture rather than stopping.
- Keep scratch files in `./work/` (made for you); drawings from `show` go
  to the temporary folder the command prints.
- This folder is replaced when the kit is updated: never keep anything you
  need in it except under `./work/`.
- The person keeps you running for as long as they develop. Stay in the
  loop: start `revisions.py wait` in the background and end your turn
  (in OpenCode just end your turn: OPENCODE.md).
"""

OPENCODE_MD = """\
# Running in OpenCode

You are run by OpenCode, not Claude Code. AGENTS.md and CLAUDE.md still
hold; these are the differences.

- **The watcher runs for you.** OpenCode's shell has no background mode,
  so never run `revisions.py wait` yourself: it would hold your turn
  and be cut off by the shell's time limit. When you have nothing left
  to do, end your turn. The kit's plugin (.opencode/plugins/redline-wait.js)
  then runs `revisions.py wait`, and when it returns - a queued note, a
  line in the thread, an answer - you get what it printed as the next
  message. Start every turn from that message: the thread first, then the
  queue, as AGENTS.md says.
- **Room agents** are the subagents `redline-3d`, `redline-pcb` and
  `redline-firmware` (.opencode/agents/). Hand a note over with the `task`
  tool, `subagent_type` set to the room's agent, the prompt giving the
  revision id. Pass `background: true` when the tool offers it (the seed
  turns it on): the room agent works while you go on, and its report comes
  back as a message when it is done - do not poll it. Without it the task
  call returns when the room agent is done; review then as AGENTS.md says.
- **Drawings**: `revisions.py show <id>` prints where it wrote the drawing;
  open that PNG with the `read` tool - it comes to you as a picture. If it
  does not (the model cannot see images), say so in the thread and do not
  guess where the red marks are.
- **Long commands**: `build`, `ask` (it waits for the person's answer)
  and `board run` take minutes. The seed raises the shell's time limit to
  an hour; when you run one, also pass the shell tool a `timeout` long
  enough (in milliseconds, e.g. 3600000).
- Never print, echo or write `REDLINE_TOKEN`; `.env` files are not yours
  to read.
- Keep your scratch files in `./work/`; edits elsewhere ask the person.
"""

MCP_JSON = {"mcpServers": {"redline": {"command": ".venv/bin/python", "args": ["tools/mcp_server.py"]}}}

SETTINGS_JSON = {
    "permissions": {
        "defaultMode": "acceptEdits",
        "allow": [
            "Bash(.venv/bin/python tools/revisions.py:*)",
            "Bash(.venv/bin/python tools/render.py:*)",
            "Bash(.venv/bin/python tools/mcp_server.py:*)",
            "mcp__redline",
            "Read", "Glob", "Grep",
            "Edit(./work/**)", "Write(./work/**)",
        ],
        "deny": ["Read(../.env)", "Read(./../.env)"],
    },
    "enableAllProjectMcpServers": True,
}


# OpenCode: the same server, permissions in its own words (the last rule that
# matches wins; edits are matched as paths from the git checkout around the
# kit, which in the seed is the seed's own, hence the kit/work forms).
_RUN = (".venv/bin/python tools/revisions.py", ".venv/bin/python tools/render.py",
        ".venv/bin/python tools/mcp_server.py")
_LOOK = ("ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "echo", "grep", "rg",
         "find", "sort", "uniq", "cut", "diff", "date", "which", "tree", "jq", "cd")
OPENCODE_JSON = {
    "$schema": "https://opencode.ai/config.json",
    "instructions": ["CLAUDE.md", "OPENCODE.md"],
    "mcp": {"redline": {"type": "local", "command": [".venv/bin/python", "tools/mcp_server.py"],
                        "enabled": True, "timeout": 20000}},
    "permission": {
        "read": {"*": "allow", "*.env": "deny", "*.env.*": "deny"},
        "glob": "allow", "grep": "allow", "list": "allow", "task": "allow",
        "external_directory": "allow",
        "edit": {"*": "ask", "work/*": "allow", "kit/work/*": "allow", "*/kit/work/*": "allow"},
        "bash": {"*": "ask",
                 **{f"{c} *": "allow" for c in _RUN},
                 **{f"REDLINE_AGENT=* {c} *": "allow" for c in _RUN},
                 # Looking around asks nobody, as Claude Code's read-only commands.
                 **{p: "allow" for c in _LOOK for p in (c, f"{c} *")},
                 "mkdir work*": "allow", "mkdir -p work*": "allow",
                 "find * -delete*": "ask", "find * -exec*": "ask",
                 "*REDLINE_TOKEN*": "deny", "env": "deny", "env *": "deny", "printenv*": "deny",
                 "*.env": "deny", "*.env *": "deny"},
        "webfetch": "ask",
    },
}

ROOM_AGENTS = (".claude/agents/redline-3d.md", ".claude/agents/redline-pcb.md",
               ".claude/agents/redline-firmware.md")
# Copied into the kit under another name.
RENAMED = {"tools/opencode/redline-wait.js": ".opencode/plugins/redline-wait.js"}


def opencode_agent(text: str) -> str:
    """A room agent of .claude/agents/ as an OpenCode subagent: the same
    instructions, `mode: subagent`, no `model` (Claude's `sonnet` means
    nothing there; the subagent then runs on the main agent's model unless
    the seed's room_model names one), the Read tool called by its name
    there."""
    _, front, body = text.split("---\n", 2)
    keep = [ln for ln in front.splitlines() if ln.startswith("description:")]
    body = re.sub(r"\b([Tt]he)(\s+)Read(\s+)tool\b", r"\1\2`read`\3tool", body)
    return "---\n" + "\n".join(keep + ["mode: subagent"]) + "\n---\n" + body


def _modfile(mod: str) -> Path | None:
    p = ROOT.joinpath(*mod.split("."))
    if p.is_dir() and (p / "__init__.py").is_file():
        return p / "__init__.py"
    f = p.with_suffix(".py")
    return f if f.is_file() else None


def _server(mod: str) -> bool:
    return any(mod == s or mod.startswith(s + ".") for s in SERVER)


def _imports(path: Path, package: str) -> list[str]:
    """Every backend module a file imports, at the top or inside a function."""
    out = []
    for n in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(n, ast.ImportFrom):
            if n.level:
                parts = package.split(".")
                base = ".".join(parts[:len(parts) - (n.level - 1)] + ([n.module] if n.module else []))
            else:
                base = n.module or ""
            if not base.startswith("backend"):
                continue
            for a in n.names:
                sub = f"{base}.{a.name}"
                out.append(sub if _modfile(sub) else base)
        elif isinstance(n, ast.Import):
            out += [a.name for a in n.names if a.name.startswith("backend")]
        elif (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_MODULES" for t in n.targets)
              and isinstance(n.value, (ast.Tuple, ast.List))):
            # Siblings loaded by name (`_MODULES = ("catalog_lcsc", ...)` then
            # import_module(f"{__package__}.{name}"), as catalog_builtin does):
            # no import statement names them, so they are added here, or the
            # kit ships without them and `revisions.py files` fails on them.
            out += [f"{package}.{e.value}" for e in n.value.elts
                    if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return out


def modules() -> list[str]:
    """The backend modules the command line reaches, server's own left out."""
    seen: set[str] = set()
    todo = [m for e in ENTRY for m in _imports(ROOT / e, "tools")]
    while todo:
        mod = todo.pop()
        if mod in seen or _server(mod):
            continue
        f = _modfile(mod)
        if not f:
            continue
        seen.add(mod)
        parts = mod.split(".")
        todo += [".".join(parts[:i]) for i in range(1, len(parts))]
        todo += _imports(f, mod if f.name == "__init__.py" else mod.rpartition(".")[0])
    return sorted(seen)


def files() -> list[str]:
    """The kit's files from the checkout, as paths relative to it."""
    out = list(ENTRY) + list(DATA)
    for m in modules():
        out.append(str(_modfile(m).relative_to(ROOT)))
    for g in DOC_GLOBS:
        out += [str(p.relative_to(ROOT)) for p in sorted(ROOT.glob(g)) if p.is_file()]
    return sorted(set(out))


def _sources() -> list[str]:
    """Every checkout file the kit is made from: its own, the renamed ones
    and the room agents the OpenCode ones are made from."""
    return sorted(set(files()) | set(RENAMED) | {p for p in ROOM_AGENTS if (ROOT / p).is_file()})


def _generated() -> dict[str, bytes]:
    return {
        "CLAUDE.md": CLAUDE_MD.encode(),
        ".mcp.json": (json.dumps(MCP_JSON, indent=2) + "\n").encode(),
        ".claude/settings.json": (json.dumps(SETTINGS_JSON, indent=2) + "\n").encode(),
        "requirements.txt": REQUIREMENTS.encode(),
        "work/.keep": b"",
        "OPENCODE.md": OPENCODE_MD.encode(),
        "opencode.json": (json.dumps(OPENCODE_JSON, indent=2) + "\n").encode(),
        **{dest: (ROOT / src).read_bytes() for src, dest in RENAMED.items()},
        **{".opencode/agents/" + Path(p).name: opencode_agent((ROOT / p).read_text(encoding="utf-8")).encode()
           for p in ROOM_AGENTS if (ROOT / p).is_file()},
    }


def _signature(paths: list[str]) -> tuple:
    out = []
    for p in paths:
        st = (ROOT / p).stat()
        out.append((p, st.st_mtime_ns, st.st_size))
    return tuple(out)


_LOCK = threading.Lock()
_CACHE: dict = {}


FRESH_S = 30.0       # how long a kit is served before its files are looked at again


def build() -> tuple[str, bytes]:
    """(version, the tarball). Its files are looked at again after FRESH_S,
    and it is rebuilt only when one of them changed."""
    with _LOCK:
        if _CACHE and time.monotonic() - _CACHE["at"] < FRESH_S:
            return _CACHE["version"], _CACHE["blob"]
    paths = files()
    sig = _signature(_sources())
    with _LOCK:
        if _CACHE.get("sig") == sig:
            _CACHE["at"] = time.monotonic()
            return _CACHE["version"], _CACHE["blob"]
    members = {p: (ROOT / p).read_bytes() for p in paths}
    members.update(_generated())
    version = hashlib.sha256(b"".join(
        hashlib.sha256(k.encode() + b"\0" + v).digest() for k, v in sorted(members.items()))).hexdigest()[:16]
    members["VERSION"] = (version + "\n").encode()
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name in sorted(members):
            data = members[name]
            info = tarfile.TarInfo("redline-agent-kit/" + name)
            info.size, info.mtime, info.mode = len(data), 0, 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    blob = gzip.compress(raw.getvalue(), compresslevel=9, mtime=0)
    with _LOCK:
        _CACHE.update(sig=sig, version=version, blob=blob, at=time.monotonic())
    return version, blob


# ---------------------------------------------------------------- connected?

# An agent counts as connected while its token was used this recently. The
# token's last use is written at most once a minute (backend/auth.py
# token_agent, CACHE_S) and a waiting main agent asks every 30 s, so ten
# minutes is a stopped agent, not a quiet one.
CONNECTED_S = 600


async def status(raw_db, workspace: str) -> dict:
    """The space's agents, as the first-run guide and the token page show
    them: how many tokens work, when one was last used, whether an agent
    is connected now. No names, no tokens."""
    from datetime import datetime, timezone

    from . import auth
    now = datetime.now(timezone.utc)
    active, last = 0, None
    async for d in raw_db[auth.TOKENS].find({"workspace": workspace},
                                            {"revoked": 1, "expires_at": 1, "last_used": 1}):
        if d.get("revoked") or auth.token_expired(d):
            continue
        active += 1
        seen = auth._aware(d.get("last_used"))
        if seen and (last is None or seen > last):
            last = seen
    ago = int((now - last).total_seconds()) if last else None
    return {"tokens": active, "last_seen": last.isoformat() if last else None, "seen_s": ago,
            "connected": ago is not None and ago <= CONNECTED_S, "window_s": CONNECTED_S,
            "seed": SEED_URL}
