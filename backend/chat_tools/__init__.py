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
    step: str = ""                   # the answer's step running the tool (ccgen.run_step): its change is kept for undo


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
    # A tool below "delete" that asks first for some inputs (memory_write's removals): given the input.
    asks: Callable[[dict], bool] | None = None
    # What a tool that asks first would change, shown with Allow / Deny (wiki_write's diff): given the input.
    # A ToolError here ends the step without asking.
    preview: Callable[[Ctx, dict], Awaitable[str]] | None = None
    # How what it changed is undone (backend/chat_undo.py): None - the generic inverse of every write it made;
    # False - nothing kept (a cache); "words" - kept and shown, not undoable, the words say why; or its own
    # `async (ctx, change, apply: bool)`, which raises chat_undo.Conflict when it cannot.
    undo: Any = None

    def __post_init__(self) -> None:
        # A writing tool run as a step is recorded: what it wrote, for the Chat's undo.
        handler = self.run

        async def run(ctx: Ctx, args: dict) -> Result:
            if self.level == "read" or self.undo is False or not getattr(ctx, "step", ""):
                return await handler(ctx, args)
            from .. import chat_undo
            return await chat_undo.recorded(self, handler, ctx, args)
        self.run = run

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
    Package("mfr", "Parts", "Parts: the makers' catalogs, the LCSC drawer, McMaster-Carr, GrabCAD and My Items - "
                            "and how many of each are on hand."),
    Package("commandcode", "Chat", "The Chat's conversations and what it can do on its own: the clock, the web, PDFs."),
    Package("files", "Files", "The Files room."),
    Package("wiki", "Wiki", "Each project's wiki: what was decided and why, dimensions and limits, sourcing, "
                            "open questions, production notes."),
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
    "(drawer_add) when it is the right one; then answer from its datasheet: datasheet_search with the question's "
    "words and the part (passages with their page numbers; it puts the datasheet in the datasheet library the "
    "first time - datasheet_get does that alone and lists its headings, and keeps a PDF link you give it) and "
    "datasheet_read for the page or section a passage points to (tables come as rows; a scanned page as a "
    "picture) before quoting a value. There is no separate datasheet answering tool: you answer from those "
    "passages yourself, and cite the datasheet page for every value you quote, e.g. (datasheet p. 4); for a "
    "limit, say whether it is an Absolute Maximum Rating or a Recommended Operating Condition. Use the tools only when "
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
    "when they give the product's details themselves; then inventory_add can count it in stock. Edit or remove catalog products "
    "(catalog_edit_product, catalog_remove_product) or add a maker by its site (catalog_add_maker; exploring its whole "
    "site reads up to 100 pages and costs tokens) only when asked. What the person has on hand is stock on the Parts page: every stock line counts one Parts product "
    "(a site's, the LCSC drawer's, McMaster-Carr's, GrabCAD's or a My Items product), how many and where it is kept - "
    "found with inventory_search and read with inventory_read; when they say they got, used or moved something, add "
    "it (inventory_add: several at once, the same product already counted is topped up, not doubled; name its Parts "
    "product - manufacturer_search gives its ids and what is in stock of it - or an LCSC part; a thing no site sells "
    "becomes a My Items product from its name) or change its quantity with a reason "
    "(inventory_adjust); edit a stock line's place, unit or minimum (inventory_edit) or remove it (inventory_remove) "
    "only when asked - what a thing is (name, code, price) is its product's (catalog_edit_product). Leave a note in a room's queue (room_note) only when asked to. "
    "The person's own notes (the Notes tab) are found with notes_search and read with note_read; write, tick or edit "
    "one (note_write, note_todo, note_edit) only when asked; a note you write reads as a page - a title line, its #tags "
    "under it, a short summary first, '## ' sections, '- [ ] ' to-dos, tables with units where they fit, no filler. What the rooms' agents have queued or are working on - "
    "the notes for the 3D, PCB and Firmware rooms - is read with queue_list and queue_read. Earlier conversations are "
    "found with chat_list and read with chat_read. Questions about the person's own usage and costs - what they spent, which model or room costs most, where the tokens went, what the cache saved, build times, the most expensive notes, API errors, the month's budget - are answered from analytics_read (the Analytics room's own figures; a range, a section, a project): quote its figures with their units and currency rather than estimating, and give its Analytics link. Rename this conversation (rename_chat) or archive it (chat_archive) "
    "only when asked to. When the person asks for a document - a report, a datasheet summary, a BOM, a comparison, a "
    "spec - or for a PDF, gather the facts with the tools first, then write it with pdf_make: a few-word title, a "
    "one-line purpose, a short summary first, '## ' sections, tables with units, the sources cited (datasheet pages, "
    "LCSC numbers), no filler; then link the file it returns in your answer. What you make (PDFs, renders, lists) is "
    "kept in the Chat's own area of Files, not in the person's My files: when they ask to save it to their files "
    "(\"save it to my files\", \"dosyalarıma kaydet\"), copy it with file_save_to_my_files - never say it is saved "
    "already. For what is not in this workspace - a "
    "maker's site, a product or a standard on the web - search the web (web_search: titles, addresses and snippets) "
    "and read the page you need (web_read) before quoting it, and link the pages you use. For a bought mechanical "
    "part - a screw, a bearing, a standoff - find it on McMaster-Carr (mcmaster_find), and for a ready CAD model of "
    "a part or product look in GrabCAD's library (grabcad_find): both are web searches, never the sites, and give "
    "each one's page and what to click there for its STEP; give those links with that hint (for GrabCAD, say to "
    "check the model's licence), and save the ones the person wants (mcmaster_save, grabcad_save). Any Parts product - a site's, an LCSC part, "
    "a McMaster-Carr or GrabCAD item, a My Items one - holds files: when the person attaches a STEP, PDF or picture "
    "and asks to add it to a product (\"add this to this product as its 3D model\"), attach it with "
    "product_file_attach (a file they attached comes as a file @-mention with its Files id; a STEP is measured and "
    "the answer gives its size). Get a product's ids with product_find when you have none, and ask which one when "
    "several match. product_files_read lists a product's files and its measured size, product_files_missing which "
    "products have no 3D model or datasheet, product_set_main makes an attached picture or model the product's own, "
    "product_to_model puts its model into a CAD project, product_file_detach takes a file off (only when asked) and "
    "product_to_my_items copies a product to My Items. How many of a board or a 3D assembly the stock builds, what "
    "limits it and what is short for a number of builds is build_count; shopping_list prices what is short (or a list "
    "given) across the sellers Parts knows, cheapest first per line; when the person says they built some, "
    "stock_consume takes their parts out of stock (it asks first). To show a 3D model or a board (\"show me the lid\"), "
    "render it with model_render: the Chat shows the pictures under its step. "
    "A product's price and stock over time are price_history; what is low in stock, how many to reorder and from whom is stock_low (it puts them on a shopping list only when asked). Files are searched as the Files tab's "
    "search box does with files_search (My files, In the app, Deleted files), and a deleted one comes back with "
    "files_restore. When the person wants a preference kept as taste, propose it with taste_propose: it waits "
    "in the Taste tab for them to review. A manufacturer's whole site is explored with manufacturer_explore only "
    "when asked (one at a time). Their direct messages with other people are read with dm_read and sent with "
    "dm_send, in the exact words they asked for. Which model each LLM job uses, this month's LLM spend and the "
    "backups' state are settings_read. Those that change something ask the person first. A project's wiki - what was decided on it "
    "and why, its dimensions and limits, sourcing, open questions, production notes - is found with wiki_search and read "
    "with wiki_read: look there before answering what was decided on a project. Write to it with wiki_write when the "
    "person asks (the person is always asked first and sees the change); the wiki is the project's facts, while "
    "general design preferences are Taste. You do not know today's "
    "date or the time: when they matter - a date asked for, how long ago, a deadline, \"today\" - read them with "
    "clock first and never guess them."
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
