#!/usr/bin/env python
"""Redline's queues, as an MCP server.

The same operations as tools/revisions.py - what is queued in which room,
a note in full, the run and its log, the check, the thread, a question on
the person's screen - offered as tools to any agent that speaks the Model
Context Protocol. Each tool runs the matching revisions.py command and
returns what it printed, so an agent gets the same answers, the same
refusals (`done` while the tests fail) and the same side effects whichever
way it asks.

It also offers the Tools tab to agents: find_tool asks a small model which
of the tools fits the task and returns their manuals, run_tool runs one
offline in the tools image, and tool_data reads or writes a project tool's
shared record (Interface Contract, Project Constants...). Those go through
the app's API, which holds the model key.

Stdio, newline-delimited JSON-RPC 2.0, written against the protocol rather
than a library: it is three methods, and nothing new has to be installed.

    .venv/bin/python tools/mcp_server.py     # .mcp.json starts it for you
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = [sys.executable, str(ROOT / "tools" / "revisions.py")]
PROTOCOL = "2025-06-18"
ROOMS = ["cad", "pcb", "firmware"]


def _s(desc: str) -> dict:
    return {"type": "string", "description": desc}


# name -> (description, input schema properties, required, argv builder)
TOOLS: dict[str, tuple] = {
    "queue": (
        "What is queued, oldest first. With a room, only that room's notes: "
        "cad (3D models) or pcb (boards).",
        {"room": {"type": "string", "enum": ROOMS,
                  "description": "only this room's queue"}},
        [], lambda a: ["queue"] + (["--room", a["room"]] if a.get("room") else [])),
    "show": (
        "A note in full. It writes its drawing to disk - open that file and "
        "look at it before doing anything.",
        {"id": _s("revision id")}, ["id"], lambda a: ["show", a["id"]]),
    "start": (
        "Open the run for a note: the progress bar and live cost in its room. "
        "Refuses while another note's run is open in the same room, and while "
        "this note runs under another agent - take_over hands it to you on "
        "purpose, and the hand-over is recorded.",
        {"id": _s("revision id"), "title": _s("what you are doing, one line"),
         "take_over": {"type": "boolean",
                       "description": "take the note over from the agent it runs under"}},
        ["id", "title"], lambda a: ["start", a["id"], a["title"]]
        + (["--take-over"] if a.get("take_over") else [])),
    "log": (
        "One line in a room's log, optionally moving its progress bar.",
        {"text": _s("the line"),
         "room": {"type": "string", "enum": ROOMS},
         "percent": {"type": "number", "minimum": 0, "maximum": 100},
         "level": {"type": "string",
                   "enum": ["info", "work", "done", "warn", "error"]}},
        ["text"], lambda a: ["log", a["text"], "--room", a.get("room", "cad"),
                             "-l", a.get("level", "info")]
        + (["-p", str(a["percent"])] if a.get("percent") is not None else [])),
    "finish": (
        "Close a note's run: the after picture and what the work cost go onto "
        "its card.",
        {"id": _s("revision id"), "failed": {"type": "boolean"}},
        ["id"], lambda a: ["finish", a["id"]] + (["--failed"] if a.get("failed") else [])),
    "done": (
        "Mark a note applied.",
        {"id": _s("revision id")}, ["id"], lambda a: ["done", a["id"]]),
    "chat": (
        "Read the room's thread (in the Chat tab), and pick up what the person said. "
        "Each room (tab) has its own thread; with a room, only that one.",
        {"room": {"type": "string", "enum": ROOMS,
                  "description": "only this room's thread"}},
        [], lambda a: ["chat"] + (["--room", a["room"]] if a.get("room") else [])),
    "say": (
        "Answer in the thread, on the person's screen - in the room it was "
        "asked in (default: where the person last spoke).",
        {"text": _s("the answer"),
         "room": {"type": "string", "enum": ROOMS, "description": "which room's thread"}},
        ["text"], lambda a: ["say", a["text"]] + (["--room", a["room"]] if a.get("room") else [])),
    "ask": (
        "Ask the person a question on their screen and wait for the answer. "
        "Markdown. Use it when the answer changes what you build. Ask as you "
        "would a systems engineer who is not a specialist in this part: open "
        "with the decision in one plain sentence, say what each choice means "
        "for the product (time, cost, size, risk), keep jargon out and the "
        "evidence in `context`; options are short plain answers.",
        {"text": _s("the question, in Markdown"),
         "options": {"type": "array", "items": {"type": "string"}},
         "context": _s("what you already know"),
         "timeout": {"type": "integer", "description": "seconds; 0 waits"}},
        ["text"], lambda a: ["ask", a["text"]]
        + [x for o in a.get("options") or [] for x in ("-o", o)]
        + (["-c", a["context"]] if a.get("context") else [])
        + (["--timeout", str(a["timeout"])] if a.get("timeout") else [])),
    # Components (backend/links.py): models and boards as the 3D designs
    # that import them see them. Through the API with the agents' token.
    "component_list": (
        "Every component - each .3d model and each .pcb board a 3D design can "
        "import - with its version, how many it uses, how many use it, its pins "
        "and whether it is rebuilding, stale or broken.",
        {}, [], lambda a: ["component", "list"]),
    "component_show": (
        "One component in full: a board's named data (size, mounting holes, "
        "connectors, keepout), a model's uses with the versions it was built "
        "against, who uses it and who pins it, its kept versions with what each "
        "changed, and a rebuild's state and last error.",
        {"id": _s("model or board id (model:<id> / board:<id> when both exist)")},
        ["id"], lambda a: ["component", "show", a["id"]]),
    "component_deps": (
        "What a component uses and what uses it; with tree, the whole tree both "
        "ways - what a change to it rebuilds.",
        {"id": _s("model or board id"), "tree": {"type": "boolean"}},
        ["id"], lambda a: ["component", "deps", a["id"]] + (["--tree"] if a.get("tree") else [])),
    "component_pin": (
        "Use a component at a fixed kept version in a model (Fusion's break "
        "link) - its later versions then stop at this model - or 'latest' to "
        "follow it again. The model and what uses it are rebuilt.",
        {"model": _s("the model that uses it"), "component": _s("the model or board it uses"),
         "version": _s("a kept version number, or latest")},
        ["model", "component", "version"],
        lambda a: ["component", "pin", a["model"], a["component"], str(a["version"])]),
    "component_refresh": (
        "Export a board's 3D component (STEP, STL, named data) from its current "
        "layout now, without placing or routing. Refused while a job runs on the "
        "board. Every model that imports it is rebuilt if the 3D changed.",
        {"board": _s("board id")}, ["board"], lambda a: ["component", "refresh", a["board"]]),
}


API = os.environ.get("REDLINE_API", "http://127.0.0.1:8000")


def _token_from_env_file() -> None:
    """With sign-in on, the agents' token (REDLINE_TOKEN) - from the repo's .env
    when the MCP client did not pass it. Only that one line is read."""
    if os.environ.get("REDLINE_TOKEN"):
        return
    try:
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("REDLINE_TOKEN="):
                os.environ["REDLINE_TOKEN"] = line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass


_token_from_env_file()

# name -> (description, input schema properties, required, (method, path, body) builder)
HTTP_TOOLS: dict[str, tuple] = {
    "find_tool": (
        "Find the Tools-tab tool that fits a task - calculators, references and "
        "checkers for PCB, embedded, mechanical, web and mobile work (impedance, "
        "pull-ups, CRC, fits and tolerances, bolt torque, type scales, JWT...). "
        "Describe what you are trying to work out; a small model picks the best "
        "1-3 of all the tools and each comes back with its manual: inputs, "
        "units, an example. Then call run_tool. Use it before computing an "
        "engineering value by hand.",
        {"task": _s("what you are trying to work out, in a sentence or two"),
         "room": {"type": "string", "enum": ROOMS, "description": "the room you work in"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 5}},
        ["task"], lambda a: ("POST", "/api/tools/find",
                             {"task": a["task"], "room": a.get("room"),
                              "limit": a.get("limit", 3), "surface": "mcp"})),
    "tool_manual": (
        "A tool's manual by id: what it answers, its inputs with units and "
        "defaults, an example input, and whether run_tool can run it.",
        {"id": _s("tool id, e.g. i2c-pullup")}, ["id"],
        lambda a: ("GET", f"/api/tools/{a['id']}/manual?surface=mcp", None)),
    "run_tool": (
        "Run a tool with an input object keyed by its inputs (see tool_manual); "
        "numbers may be engineering notation strings such as '4k7' or '100n'. "
        "Runs offline in the tools image. Returns {values, tables, texts, "
        "warnings, notes}; read the warnings.",
        {"id": _s("tool id"), "input": {"type": "object", "description": "the tool's inputs"}},
        ["id"], lambda a: ("POST", "/api/tools/run",
                           {"id": a["id"], "input": a.get("input") or {}, "surface": "mcp"})),
    "tool_data": (
        "Read (no data) or replace (with data) a project tool's shared record - "
        "interface-contract, project-constants, decision-log, glossary, "
        "req-test-matrix - so every room and agent uses the same values.",
        {"id": _s("tool id"), "data": {"type": "object", "description": "the new record; omit to read"},
         "project": _s("project name, default 'default'")},
        ["id"], lambda a: (("PUT" if "data" in a else "GET"),
                           f"/api/tools/data/{a['id']}?project={a.get('project', 'default')}",
                           {"data": a["data"]} if "data" in a else None)),
}


def http(method: str, path: str, body: dict | None) -> tuple[bool, str]:
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json",
                                          # who is asking, for the tools' usage and the audit
                                          "X-Redline-Actor": "agent:" + os.environ.get("REDLINE_AGENT", "agent"),
                                          # with sign-in on, the agent's token (users phase 4)
                                          **({"Authorization": "Bearer " + os.environ["REDLINE_TOKEN"]}
                                             if os.environ.get("REDLINE_TOKEN") else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return True, r.read().decode()
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode(errors='replace')[:800]}"
    except OSError as e:
        return False, f"the app's API at {API} is not answering: {e}"


def tool_list() -> list[dict]:
    both = {**TOOLS, **HTTP_TOOLS}
    return [{"name": name, "description": desc,
             "inputSchema": {"type": "object", "properties": props,
                             "required": req}}
            for name, (desc, props, req, _) in both.items()]


def argv(name: str, args: dict) -> list[str]:
    if name not in TOOLS:
        raise KeyError(name)
    for need in TOOLS[name][2]:
        if need not in args:
            raise ValueError(f"{name}: {need} is required")
    return TOOLS[name][3](args)


def call(name: str, args: dict) -> dict:
    if name in HTTP_TOOLS:
        _, _, req, build = HTTP_TOOLS[name]
        missing = [k for k in req if k not in args]
        if missing:
            return {"content": [{"type": "text", "text": f"{name}: {missing[0]} is required"}],
                    "isError": True}
        ok, text = http(*build(args))
        return {"content": [{"type": "text", "text": text}], "isError": not ok}
    try:
        cmd = argv(name, args)
    except (KeyError, ValueError) as exc:
        return {"content": [{"type": "text", "text": str(exc)}], "isError": True}
    # `ask` waits for a person; everything else is minutes at most.
    timeout = None if name == "ask" else 900
    try:
        out = subprocess.run([*CLI, *cmd], capture_output=True, text=True,
                             timeout=timeout, cwd=str(ROOT))
    except subprocess.TimeoutExpired:
        return {"content": [{"type": "text", "text": f"{name}: timed out"}],
                "isError": True}
    text = (out.stdout + (("\n" + out.stderr) if out.stderr.strip() else "")).strip()
    return {"content": [{"type": "text", "text": text or "(no output)"}],
            "isError": out.returncode != 0}


def answer(msg: dict) -> dict | None:
    """One request in, one response out; notifications get none."""
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        result = {"protocolVersion": msg.get("params", {}).get(
                      "protocolVersion", PROTOCOL),
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "redline", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": tool_list()}
    elif method == "tools/call":
        p = msg.get("params") or {}
        result = call(p.get("name", ""), p.get("arguments") or {})
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            out = {"jsonrpc": "2.0", "id": None,
                   "error": {"code": -32700, "message": "not JSON"}}
        else:
            out = answer(msg)
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
