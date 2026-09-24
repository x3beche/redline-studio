"""Every tool in the Tools tab: its manifest, that it runs, and that the
picker can see all of them inside a small model's window.

A tool is a folder under frontend/public/tools with a manifest.json; a kit
tool also has tool.js (pure, runs in Node) and index.html. These tests read
every one, so a tool added later is held to the same bar.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend import tool_router, tools_api

PAGES = tools_api.PAGES
MANIFESTS = sorted(PAGES.glob("*/manifest.json"))
KIT = [m.parent for m in MANIFESTS if (m.parent / "tool.js").exists()]
TYPES = {"number", "text", "textarea", "select", "bool", "table"}
GROUPS = {"pcb", "embedded", "mechanical", "web", "mobile", "code", "project"}


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_there_are_tools():
    assert len(MANIFESTS) >= 16 and KIT


@pytest.mark.parametrize("path", MANIFESTS, ids=lambda p: p.parent.name)
def test_a_manifest_says_what_the_catalog_needs(path):
    m = load(path)
    assert m["id"] == path.parent.name
    assert m.get("name") and m.get("blurb")
    assert m.get("group") in GROUPS, f"group {m.get('group')!r}"
    assert isinstance(m.get("rooms"), list) and m["rooms"]
    assert isinstance(m.get("keywords"), list)


@pytest.mark.parametrize("folder", KIT, ids=lambda p: p.name)
def test_a_kit_tool_is_complete(folder):
    m = load(folder / "manifest.json")
    assert (folder / "index.html").exists()
    assert "../kit/kit.js" in (folder / "index.html").read_text()
    if m.get("view"):
        assert (folder / "view.js").exists()
    keys = [d["key"] for d in m["inputs"]]
    assert len(keys) == len(set(keys)), "input keys repeat"
    for d in m["inputs"]:
        assert d.get("type") in TYPES, f"{d.get('key')}: type {d.get('type')!r}"
        assert d.get("label")
        if d["type"] == "select":
            assert d.get("options"), f"{d['key']}: a select with no options"
        if d["type"] == "table":
            assert d.get("columns"), f"{d['key']}: a table with no columns"
    assert m.get("usage"), "agents need the usage line"
    assert len(m.get("keywords") or []) >= 4, "too few keywords to be found"


NODE = shutil.which("node")


@pytest.mark.skipif(not NODE, reason="node is not on this machine")
@pytest.mark.parametrize("folder", KIT, ids=lambda p: p.name)
def test_a_kit_tool_runs_its_example_cleanly(folder):
    m = load(folder / "manifest.json")
    example = (m.get("examples") or [{}])[0].get("input") or {}
    out = subprocess.run([NODE, str(PAGES / "kit" / "cli.mjs"), folder.name],
                         input=json.dumps(example), capture_output=True, text=True, timeout=30)
    res = json.loads(out.stdout)
    assert res["ok"], res.get("error")
    text = json.dumps(res["result"])
    for bad in ("NaN", "undefined", "Infinity", "null,\"unit\""):
        assert bad not in text, f"{bad} in the result"
    assert any(res["result"].get(k) for k in ("values", "tables", "texts", "charts")), "nothing came back"


# ---------------- the picker ----------------
def fake(n: int) -> list[dict]:
    return [{"id": f"tool-{i}", "name": f"Tool {i}",
             # as long as a real blurb is at the long end (the real ones average ~80)
             "blurb": "the long description of what this imaginary engineering tool computes, and from what",
             "rooms": ["pcb", "embedded"], "keywords": []} for i in range(n)]


def test_the_picker_request_fits_a_small_models_window_however_many_tools():
    task = "size the pull-up resistors for an i2c bus " * 20
    for n in (10, 175, 2000):
        index, seen = tool_router.index_for(task, fake(n))
        total = (tool_router.tokens(tool_router.SYSTEM) + tool_router.tokens(index)
                 + tool_router.tokens(task[:tool_router.TASK_MAX]) + tool_router.ANSWER)
        assert total <= tool_router.CONTEXT, (n, total)
        # A catalog of this app's size fits whole; a huge one is cut to the
        # best-scoring tools rather than overflowing the window.
        assert seen == n if n <= 175 else seen < n


def test_every_real_tool_fits_the_window_at_once():
    cat = tools_api.catalog()
    index, seen = tool_router.index_for("anything", cat)
    assert seen == len(cat), f"only {seen} of {len(cat)} tools fit the picker's window"


def test_the_keyword_fallback_finds_the_obvious_tool():
    picks = tool_router.keyword_picks("pull-up resistor for SDA and SCL", tools_api.catalog())
    assert picks and picks[0]["id"] == "i2c-pullup"


def test_tools_md_lists_every_tool():
    """TOOLS.md's catalog section is written from the manifests
    (tools/tools_md.py); a tool missing from it was added without rerunning."""
    doc = (PAGES.parent.parent.parent / "TOOLS.md").read_text()
    missing = [m.parent.name for m in MANIFESTS if f"`{m.parent.name}`" not in doc]
    assert not missing, f"not in TOOLS.md (run tools/tools_md.py): {missing}"
