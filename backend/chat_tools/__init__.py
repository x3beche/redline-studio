"""Tools the Chat's models may use while they answer (backend/ccgen.py).

One module per tool in this folder, each with a `TOOL = Tool(...)`: its
name and description (what the model reads), its input as JSON Schema,
its permission level, the sentences the page shows for it, and the
handler. The registry finds them by itself (`tools()`); see README.md
here for adding one.

Levels:
  read   - runs freely; its step is shown.
  change - runs, and always shows a step (it keeps something: a part in
           the drawer, a datasheet on disk).
  delete - asks the person first: the step waits, with Allow / Deny on
           the page (POST /api/cc/chats/{id}/steps/{step}), and runs only
           when allowed.

Which tools go to the model is each person's own choice (the Chat's
"Tools" button), kept on the server per account (`PREFS`); a tool
nobody chose about yet is on or off as its `default` says.

The page's sentences are English templates with {name} holes, filled
from the step's `vars`: the page translates the template (i18n.ts, the
English is the key) and then fills it, so a tool's Turkish lives with
the rest of the page's words.
"""

from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

LEVELS = ("read", "change", "delete")
PREFS = "cc_tool_prefs"              # the machine's: one document per account, {_id: user id, tools: {name: bool}}
MAX_TEXT = 24_000                    # characters of one tool's answer the model gets
MAX_SUMMARY = 600                    # characters of it the page keeps on the step


class ToolError(Exception):
    """The tool could not do it; the message says why (to the model and the page)."""


@dataclass
class Ctx:
    """What a tool runs with: the workspace's database, whether the model
    reads images, and who asked."""
    db: Any
    vision: bool = False
    actor: dict = field(default_factory=dict)


@dataclass
class Result:
    text: str                        # what the model is handed back
    say: str                         # the page's sentence (an English template)
    vars: dict = field(default_factory=dict)
    summary: str = ""                # the expanded row's result, short
    image: bytes | None = None       # a PNG for a model that reads images


@dataclass
class Tool:
    name: str
    description: str
    schema: dict
    level: str
    run: Callable[[Ctx, dict], Awaitable[Result]]
    running: str                     # the sentence while it runs, e.g. "Looking in the drawer for “{query}”"
    failed: str                      # the sentence when it fails
    label: str = ""                  # its name on the Tools panel
    about: str = ""                  # its one line there (an English key of i18n.ts)
    default: bool = True             # on for someone who never chose
    order: int = 100

    def spec(self) -> dict:
        """As a model is told about it (OpenAI's shape; llm.py turns it
        into Anthropic's)."""
        return {"name": self.name, "description": self.description, "parameters": self.schema}

    def public(self) -> dict:
        return {"name": self.name, "label": self.label or self.name, "level": self.level,
                "description": self.about or self.description.split(". ")[0], "default": self.default}


_TOOLS: dict[str, Tool] | None = None


def tools() -> dict[str, Tool]:
    """Every tool in this folder, by name, in their order."""
    global _TOOLS
    if _TOOLS is None:
        found: list[Tool] = []
        for mod in pkgutil.iter_modules(__path__):
            if mod.name.startswith("_"):
                continue
            t = getattr(importlib.import_module(f"{__name__}.{mod.name}"), "TOOL", None)
            if isinstance(t, Tool):
                if t.level not in LEVELS:
                    raise ValueError(f"chat tool {t.name}: level {t.level!r} is not one of {LEVELS}")
                found.append(t)
        _TOOLS = {t.name: t for t in sorted(found, key=lambda t: (t.order, t.name))}
    return _TOOLS


async def prefs(db, uid: str | None) -> dict[str, bool]:
    """This person's own on/off choices (only those they made)."""
    if not uid:
        return {}
    raw = getattr(db, "raw", None)
    doc = await (db if raw is None else raw)[PREFS].find_one({"_id": uid}) or {}
    return {k: bool(v) for k, v in (doc.get("tools") or {}).items() if k in tools()}


def chosen(mine: dict[str, bool]) -> list[dict]:
    """Every tool, with whether it is on for this person."""
    return [{**t.public(), "on": mine.get(n, t.default)} for n, t in tools().items()]


async def save(db, uid: str, change: dict[str, bool]) -> dict[str, bool]:
    unknown = [k for k in change if k not in tools()]
    if unknown:
        raise ValueError(f"no chat tool {unknown[0]!r}")
    raw = getattr(db, "raw", None)
    coll = (db if raw is None else raw)[PREFS]
    await coll.update_one({"_id": uid}, {"$set": {f"tools.{k}": bool(v) for k, v in change.items()}}, upsert=True)
    return await prefs(db, uid)


async def enabled(db, uid: str | None) -> list[Tool]:
    """The tools that go to the model for this person's lines."""
    mine = await prefs(db, uid)
    return [t for n, t in tools().items() if mine.get(n, t.default)]


def clip(text: str, n: int = MAX_TEXT) -> str:
    return text if len(text) <= n else text[:n] + f"\n[... cut: {len(text) - n} more characters]"


def size(n: int) -> str:
    """1.2 MB, 340 KB."""
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{max(1, round(n / 1024))} KB"


SYSTEM_NOTE = (
    "You have tools for electronic parts. When asked about a specific part (an IC, a MOSFET, a "
    "connector...), do not answer its electrical values from memory: first look for it in the "
    "drawer (drawer_search); if it is not there, find it on LCSC (lcsc_search) and add it "
    "(drawer_add) when it is the right one; then get its datasheet (datasheet_get, always before "
    "reading: it says where the datasheet came from) and read the pages that matter (datasheet_read, "
    "by page or with a query; a scanned page as a picture) before quoting a value. Cite the "
    "datasheet page for every value you quote, e.g. (datasheet p. 2). Use the tools only when "
    "they help the question, and only those you have; say plainly when a datasheet does not give "
    "a value."
)
