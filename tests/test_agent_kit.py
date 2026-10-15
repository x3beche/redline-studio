"""The agent kit and the agents' status: the kit only for a good agent token,
nothing of the server's or a secret in it, the same bytes for the same files;
the status a space's first-run guide reads - no token, made but not
connected, connected - from each token's last use. Sign-in is on; the
database is test_telegram's fake (as test_agent_tokens)."""

from __future__ import annotations

import gzip
import io
import re
import tarfile
from datetime import datetime, timedelta, timezone

from backend import agent_kit, auth
from test_agent_tokens import agent, db, make, person, run  # noqa: F401  (fixture)


def kit_names(blob: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        return {m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}


def test_the_kit_is_for_a_good_agent_token_only(db):
    ed = person(db, "u-ed")
    tok = make(ed, "laptop")["token"]
    # A person, an unknown token, a revoked one: no kit.
    assert ed.get("/api/agent/kit").status_code == 403
    assert agent("rlat_nottherightone").get("/api/agent/kit").status_code == 401
    r = agent(tok).get("/api/agent/kit")
    assert r.status_code == 200 and r.headers["content-type"] == "application/gzip"
    v = agent(tok).get("/api/agent/kit/version").json()["version"]
    assert r.headers["x-redline-kit-version"] == v
    # Unchanged: not sent again.
    assert agent(tok).get("/api/agent/kit", headers={"If-None-Match": f'"{v}"'}).status_code == 304
    tid = next(t["id"] for t in ed.get("/api/agent-tokens").json() if t["name"] == "laptop")
    assert ed.delete(f"/api/agent-tokens/{tid}").status_code == 200
    assert agent(tok).get("/api/agent/kit").status_code == 401


def test_the_kit_holds_the_command_line_not_the_server():
    version, blob = agent_kit.build()
    files = kit_names(blob)
    names = {n.removeprefix("redline-agent-kit/") for n in files}
    assert all(n.startswith("redline-agent-kit/") for n in files)
    for need in ("tools/revisions.py", "tools/remote_db.py", "tools/mcp_server.py", "tools/render.py",
                 "backend/store.py", "backend/lcsc.py", "AGENTS.md", "CLAUDE.md", ".mcp.json",
                 ".claude/settings.json", ".claude/agents/redline-3d.md", "requirements.txt", "VERSION"):
        assert need in names, need
    assert files["redline-agent-kit/VERSION"].decode().strip() == version
    # None of the server's own: the app, sign-in, accounts, the tokens'
    # way in, the chat; no .env, no build123d or OpenCascade to install.
    for never in ("backend/main.py", "backend/auth.py", "backend/accounts.py", "backend/admin.py",
                  "backend/agent_api.py", "backend/agent_kit.py", "backend/cc_chat.py", ".env",
                  "export_model.py"):
        assert never not in names, never
    assert not any(n.startswith(("backend/tgbot/", "backend/chat_tools/", "frontend/", "tests/", "docs/"))
                   or n.endswith(".env") for n in names)
    assert "build123d" not in files["redline-agent-kit/requirements.txt"].decode()
    # No secret anywhere in it.
    text = b"\n".join(files.values()).decode(errors="replace")
    assert not re.search(r"rlat_[A-Za-z0-9_-]{20,}", text)
    assert not re.search(r"mongodb(\+srv)?://[^\s\"'/]*:[^\s\"'/]*@", text)
    assert not re.search(r"\bsk-[A-Za-z0-9_-]{20,}", text)


def test_the_kit_is_the_same_bytes_for_the_same_files():
    agent_kit._CACHE.clear()
    a = agent_kit.build()
    agent_kit._CACHE.clear()
    b = agent_kit.build()
    assert a == b
    with tarfile.open(fileobj=io.BytesIO(a[1]), mode="r:gz") as tar:
        assert all(m.mtime == 0 and m.uid == 0 and not m.uname for m in tar.getmembers())
    assert gzip.decompress(a[1])                      # a plain gzip, no name or time in it


def test_every_import_the_command_line_makes_is_in_the_kit():
    """Following imports stops only at the server's own modules - so a module
    the command line needs at load time is never left out."""
    import ast
    kit = set(agent_kit.modules())
    for mod in kit:
        f = agent_kit._modfile(mod)
        tree = ast.parse(f.read_text())
        pkg = mod if f.name == "__init__.py" else mod.rpartition(".")[0]
        for n in tree.body:                         # the top level: run at import
            if isinstance(n, ast.ImportFrom) and n.level:
                base = ".".join(pkg.split(".")[:len(pkg.split(".")) - (n.level - 1)] + ([n.module] if n.module else []))
                for a in n.names:
                    sub = f"{base}.{a.name}"
                    want = sub if agent_kit._modfile(sub) else base
                    assert want in kit, (mod, want)


def test_status_from_no_token_to_connected(db):
    ed = person(db, "u-ed")
    s = ed.get("/api/agent/status").json()
    assert s == {**s, "tokens": 0, "last_seen": None, "connected": False, "can_make": True}
    assert s["seed"].startswith("https://") and s["window_s"] == agent_kit.CONNECTED_S
    tok = make(ed, "laptop")["token"]
    s = ed.get("/api/agent/status").json()
    assert (s["tokens"], s["connected"], s["last_seen"]) == (1, False, None)
    # The agent asks once: it is connected, and the person sees when.
    assert agent(tok).get("/api/agent/kit/version").status_code == 200
    s = ed.get("/api/agent/status").json()
    assert s["connected"] and s["seen_s"] is not None and s["seen_s"] < 60
    # Quiet for longer than the window: not connected any more.
    old = datetime.now(timezone.utc) - timedelta(seconds=agent_kit.CONNECTED_S + 30)
    for d in db["agent_tokens"].docs.values():
        d["last_used"] = old
    s = ed.get("/api/agent/status").json()
    assert s["tokens"] == 1 and not s["connected"] and s["seen_s"] > agent_kit.CONNECTED_S
    # A revoked token counts for nothing, however recent its last use.
    for d in db["agent_tokens"].docs.values():
        d["last_used"], d["revoked"] = datetime.now(timezone.utc), True
    s = ed.get("/api/agent/status").json()
    assert (s["tokens"], s["connected"], s["last_seen"]) == (0, False, None)


def test_status_is_per_space_and_says_no_names(db):
    ed, other = person(db, "u-ed"), person(db, "u-view")
    tok = make(ed, "laptop")["token"]
    agent(tok).get("/api/agent/kit/version")
    assert other.get("/api/agent/status").json()["tokens"] == 0
    s = ed.get("/api/agent/status").json()
    assert "laptop" not in str(s) and auth.TOKEN_PREFIX not in str(s)
    # An agent may ask too; it may not make tokens.
    a = agent(tok).get("/api/agent/status").json()
    assert a["connected"] and a["can_make"] is False


def test_last_use_is_written_at_most_once_a_minute(db):
    ed = person(db, "u-ed")
    tok = make(ed, "laptop")["token"]
    writes = []
    coll = db["agent_tokens"]
    real = coll.update_one

    async def counted(q, u, *a, **kw):
        if "last_used" in (u.get("$set") or {}):
            writes.append(1)
        return await real(q, u, *a, **kw)
    coll.update_one = counted
    try:
        for _ in range(5):
            run(auth.token_agent(db, tok))
    finally:
        coll.update_one = real
    assert len(writes) == 1


def test_every_module_in_the_kit_imports_from_the_kit_alone(tmp_path):
    """Built and unpacked as a person's computer gets it, every backend
    module of the kit imports with only the kit on the path. The kit once
    left out the catalog modules catalog_builtin loads by name (and the
    form-data package FastAPI needs for an upload route), so `revisions.py
    files` failed on people's machines."""
    import io
    import subprocess
    import sys
    import tarfile
    from backend import agent_kit

    _, blob = agent_kit.build()
    tarfile.open(fileobj=io.BytesIO(blob)).extractall(tmp_path, filter="data")
    kit = tmp_path / "redline-agent-kit"
    assert (kit / "backend" / "catalog_lcsc.py").exists()
    assert "python-multipart" in (kit / "requirements.txt").read_text()
    code = (
        "import importlib, pathlib, sys\n"
        f"sys.path[:] = [p for p in sys.path if p not in ('', {str(agent_kit.ROOT)!r})]\n"
        "sys.path.insert(0, '.')\n"
        "bad = []\n"
        "for p in sorted(pathlib.Path('backend').rglob('*.py')):\n"
        "    m = '.'.join(p.with_suffix('').parts).replace('.__init__', '')\n"
        "    try:\n"
        "        importlib.import_module(m)\n"
        "    except Exception as e:\n"
        "        bad.append(f'{m}: {type(e).__name__}: {e}')\n"
        "print('\\n'.join(bad))\n"
        "sys.exit(1 if bad else 0)\n")
    r = subprocess.run([sys.executable, "-c", code], cwd=kit, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stdout + r.stderr


def test_the_kit_runs_with_opencode_too():
    """The seed's `--runner opencode`: opencode.json with the same MCP server
    and permissions as Claude Code's settings, the room agents as OpenCode
    subagents made from .claude/agents/, the watcher plugin, OPENCODE.md -
    and what Claude Code gets is still there."""
    import json
    _, blob = agent_kit.build()
    files = {n.removeprefix("redline-agent-kit/"): b for n, b in kit_names(blob).items()}
    cfg = json.loads(files["opencode.json"])
    assert cfg["mcp"]["redline"] == {**cfg["mcp"]["redline"], "type": "local", "enabled": True,
                                     "command": [".venv/bin/python", "tools/mcp_server.py"]}
    assert set(cfg["instructions"]) == {"CLAUDE.md", "OPENCODE.md"}
    perm = cfg["permission"]
    assert perm["read"]["*.env"] == "deny" and perm["edit"]["*"] == "ask"
    assert perm["edit"]["work/*"] == perm["edit"]["kit/work/*"] == "allow"
    bash = perm["bash"]
    assert bash["*"] == "ask" and bash[".venv/bin/python tools/revisions.py *"] == "allow"
    assert bash["REDLINE_AGENT=* .venv/bin/python tools/revisions.py *"] == "allow"
    # The last rule that matches wins in OpenCode: the token's denials come last.
    assert list(bash)[-6:] == ["*REDLINE_TOKEN*", "env", "env *", "printenv*", "*.env", "*.env *"]
    assert all(bash[k] == "deny" for k in list(bash)[-6:])
    for room in ("redline-3d", "redline-pcb", "redline-firmware"):
        text = files[f".opencode/agents/{room}.md"].decode()
        front = text.split("---\n")[1]
        assert "mode: subagent" in front and "description:" in front, room
        assert "model:" not in front and "name:" not in front, room
        assert "Read tool" not in " ".join(text.split()), room
        # The same instructions as Claude Code's.
        claude = files[f".claude/agents/{room}.md"].decode().split("---\n", 2)[2]
        assert text.split("---\n", 2)[2].replace("`read`", "Read") == claude, room
    plugin = files[".opencode/plugins/redline-wait.js"].decode()
    assert "session.idle" in plugin and '"tools/revisions.py", "wait"' in plugin
    assert b"never run `revisions.py wait` yourself" in files["OPENCODE.md"]
    # Claude Code's own files, unchanged.
    assert json.loads(files[".mcp.json"]) == agent_kit.MCP_JSON
    assert json.loads(files[".claude/settings.json"]) == agent_kit.SETTINGS_JSON
    assert b"model: sonnet" in files[".claude/agents/redline-3d.md"]
