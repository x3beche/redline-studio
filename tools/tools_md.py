#!/usr/bin/env python
"""Write the catalog section of TOOLS.md from every tool's manifest.

    .venv/bin/python tools/tools_md.py          # rewrites between the markers
    .venv/bin/python tools/tools_md.py --all    # also tools not yet added to git

By default only the tools git knows (committed or staged) are listed, so
the section matches what a commit holds while other tools are half-built.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ROOT / "frontend" / "public" / "tools"
DOC = ROOT / "TOOLS.md"
GROUPS = [("pcb", "PCB & electronics"), ("embedded", "Embedded"), ("mechanical", "Mechanical & 3D"),
          ("web", "Web & design"), ("mobile", "Mobile"), ("code", "Code, data & prompts"),
          ("project", "Project")]
ROOMS = {"pcb": "PCB", "embedded": "Embedded", "cad": "3D", "web": "Web", "mobile": "Mobile",
         "analyze": "Analytics", "all": "all"}


def manifests(all_: bool) -> list[Path]:
    found = sorted(PAGES.glob("*/manifest.json"))
    if all_:
        return found
    known = set(subprocess.run(["git", "ls-files", "--", "frontend/public/tools/*/manifest.json"],
                               cwd=ROOT, capture_output=True, text=True).stdout.split())
    return [p for p in found if str(p.relative_to(ROOT)) in known]


def section(all_: bool = False) -> str:
    tools = [json.loads(p.read_text()) for p in manifests(all_)]
    out = [f"{len(tools)} tools. **MCP** marks the ones agents can run with `run_tool`.", ""]
    for gid, label in GROUPS:
        rows = sorted((t for t in tools if t.get("group") == gid), key=lambda t: t["name"].lower())
        if not rows:
            continue
        out += [f"### {label}", "", "| Tool | id | What it answers | Rooms |", "|---|---|---|---|"]
        for t in rows:
            mcp = " · MCP" if (PAGES / t["id"] / "tool.js").exists() else ""
            rooms = ", ".join(ROOMS.get(r, r) for r in t.get("rooms") or [])
            blurb = t.get("blurb", "").replace("|", "\\|")
            out.append(f"| **{t['name']}**{mcp} | `{t['id']}` | {blurb} | {rooms} |")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def main() -> None:
    text = DOC.read_text()
    new = re.sub(r"(<!-- catalog:start -->\n).*?(<!-- catalog:end -->)",
                 lambda m: m.group(1) + section("--all" in sys.argv) + m.group(2), text, flags=re.S)
    DOC.write_text(new)
    print(f"{DOC.name}: catalog section rewritten")


if __name__ == "__main__":
    main()
