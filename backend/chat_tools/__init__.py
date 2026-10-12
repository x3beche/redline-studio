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
RECALL = 1_500                       # characters of it kept on the step for later turns (cc_chat.history)


class ToolError(Exception):
    """The tool could not do it; the message says why (to the model and the page)."""


@dataclass
class Ctx:
    """What a tool runs with: the workspace's database, whether the model
    reads images, who asked, and in which conversation."""
    db: Any
    vision: bool = False
    actor: dict = field(default_factory=dict)
    chat: str = ""


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
    package: str = "other"           # its package (PACKAGES below): how the Tools panel and the model see it

    def spec(self) -> dict:
        """As a model is told about it (OpenAI's shape; llm.py turns it
        into Anthropic's)."""
        return {"name": self.name, "description": self.description, "parameters": self.schema}

    def public(self) -> dict:
        pk = PACKAGE.get(self.package) or Package(self.package, self.package.title(), "")
        return {"name": self.name, "label": self.label or self.name, "level": self.level,
                "description": self.about or self.description.split(". ")[0], "default": self.default,
                "package": pk.name, "package_label": pk.label, "package_about": pk.about}


@dataclass(frozen=True)
class Package:
    """Tools that belong together - a room's, the drawer's. Each stays a
    tool of its own, with its own switch (reading on, writing off); the
    package is how the Tools panel shows them, with one switch for all of
    them, and how the model is told about them."""
    name: str
    label: str                       # an English key of i18n.ts
    about: str


PACKAGES = (
    # What belongs to no one tab first; then one package per tab of the top
    # bar, named by the tab's id (frontend/src/app/workspaces.ts) and in its
    # order. The Tools panel draws a card for every tab from that list, so a
    # new tab has its package there at once, empty until a tool names it.
    Package("general", "General", "What belongs to no one tab: the rooms' queues."),
    Package("cad", "3D Drawing", "The 3D room's models."),
    Package("pcb", "PCB Design", "The PCB room's boards, its parts drawer, LCSC's catalogue and the parts' datasheets."),
    Package("firmware", "Firmware", "The Firmware room's builds."),
    Package("notes", "Notes", "The notes jotted down in Notes: #tags, @boards, to-dos."),
    Package("taste", "Taste", "The person's design taste, kept as palettes."),
    Package("mfr", "Product Catalog", "The makers' catalogs saved in Product Catalog."),
    Package("inventory", "Inventory", "What is on hand: items, quantities and where they are."),
    Package("commandcode", "Chat", "The Chat's conversations: their titles, and what was said in them."),
    Package("files", "Files", "The Files room."),
    Package("tools", "Basic Tools", "The Basic Tools calculators."),
)
PACKAGE = {p.name: p for p in PACKAGES}


_TOOLS: dict[str, Tool] | None = None


def tools() -> dict[str, Tool]:
    """Every tool in this folder, by name, in their order."""
    global _TOOLS
    if _TOOLS is None:
        found: list[Tool] = []
        for mod in pkgutil.iter_modules(__path__):
            if mod.name.startswith("_"):
                continue
            m = importlib.import_module(f"{__name__}.{mod.name}")
            # One TOOL a module, or a TOOLS list made from data (basic_tools.py: a calculator each).
            for t in [getattr(m, "TOOL", None), *getattr(m, "TOOLS", [])]:
                if isinstance(t, Tool):
                    if t.level not in LEVELS:
                        raise ValueError(f"chat tool {t.name}: level {t.level!r} is not one of {LEVELS}")
                    found.append(t)
        rank = {p.name: i for i, p in enumerate(PACKAGES)}
        _TOOLS = {t.name: t for t in sorted(found, key=lambda t: (rank.get(t.package, len(rank)), t.order, t.name))}
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
    "You have tools for electronic parts and for this workspace. When asked about a specific part (an IC, a MOSFET, a "
    "connector...), do not answer its electrical values from memory: first look for it in the "
    "drawer (drawer_search); if it is not there, find it on LCSC (lcsc_search) and add it "
    "(drawer_add) when it is the right one; then get its datasheet (datasheet_get, always before "
    "reading: it says where the datasheet came from) and read the pages that matter (datasheet_read, "
    "by page or with a query; a scanned page as a picture) before quoting a value. Cite the "
    "datasheet page for every value you quote, e.g. (datasheet p. 2). Use the tools only when "
    "they help the question, and only those you have; say plainly when a datasheet does not give "
    "a value. To see what the drawer holds - which parts, which of them have a datasheet kept - "
    "list it (drawer_list) rather than guessing. For this workspace's own things - its boards "
    "(board_read), 3D models (model_read), firmware builds (firmware_build) and "
    "files (file_read) - read them with those tools before answering about them; each lists what there "
    "is when called without an id. The person's design taste - their own rules, kept as taste palettes - "
    "is read with taste_read: read it when they ask about their taste or rules, or before advising on a "
    "design. When the person needs a part or product from a maker, or says to look at a manufacturer, look in "
    "the manufacturers they saved (manufacturer_search: their catalogs, read from the makers' own sites) before "
    "anywhere else, and link the product pages it gives. When the person gives a product or shop page, or asks to add "
    "something to the catalog, add it with catalog_read_page (it reads the page into the catalog of the maker kept for its "
    "site, or makes that maker; when the run is still going, give the person its link) - or with catalog_add_product "
    "when they give the product's details themselves; then inventory_add can stock it. Edit or remove catalog products "
    "(catalog_edit_product, catalog_remove_product) or add a maker by its site (catalog_add_maker; exploring its whole "
    "site reads up to 100 pages and costs tokens) only when asked. What the person has on hand - items, how many and where they are kept "
    "(the Inventory tab) - is found with inventory_search and read with inventory_read; when they say they got, used or "
    "moved something, add it (inventory_add: several at once, the same thing already kept is topped up, not doubled; "
    "link a Product Catalog product - manufacturer_search gives its ids and what is in stock of it - or an LCSC part "
    "when it came from there) or change its quantity with a reason "
    "(inventory_adjust); edit or remove items (inventory_edit, inventory_remove) only when asked. Leave a note in a room's queue (room_note) only when asked to. "
    "The person's own notes (the Notes tab) are found with notes_search and read with note_read; write, tick or edit "
    "one (note_write, note_todo, note_edit) only when asked; a note you write reads as a page - a title line, its #tags "
    "under it, a short summary first, '## ' sections, '- [ ] ' to-dos, tables with units where they fit, no filler. What the rooms' agents have queued or are working on - "
    "the notes for the 3D, PCB and Firmware rooms - is read with queue_list and queue_read. Earlier conversations are "
    "found with chat_list and read with chat_read; rename this conversation (rename_chat) or archive it (chat_archive) "
    "only when asked to. When the person asks for a document - a report, a datasheet summary, a BOM, a comparison, a "
    "spec - or for a PDF, gather the facts with the tools first, then write it with pdf_make: a few-word title, a "
    "one-line purpose, a short summary first, '## ' sections, tables with units, the sources cited (datasheet pages, "
    "LCSC numbers), no filler; then link the file it returns in your answer."
)


def note(on: list[Tool]) -> str:
    """The system note for a line answered with tools: how to use them, and
    exactly which ones there are this time (named, not counted by the model:
    writing a ```task block is not a tool), grouped by their packages."""
    by: dict[str, list[str]] = {}
    for t in on:
        by.setdefault(t.package, []).append(t.name)
    names = "; ".join(f"{(PACKAGE.get(k) or Package(k, k, '')).label}: {', '.join(v)}" for k, v in by.items())
    return (SYSTEM_NOTE + f" The tools you have now are exactly these {len(on)}, by package - {names}. Writing a "
            "```task block for the queue is something you write, not a tool.")
