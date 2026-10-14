"""Which of the Chat's tools go with a line: the packages it needs, not all.

Every tool a person has on used to go to the model with every line - some
60 tool schemas, 12-15 thousand tokens before the conversation even starts,
and again for every round of a tool loop. Now a line gets the packages its
words, its @-mentions and its conversation point to (`pick`), always with a
few core tools, and the model can ask for more mid-answer (`tools_more`,
`more_tool`). The person's own on/off choices still decide which tools
there are at all: a package only ever brings tools that are on.

The packages here are finer than the Tools panel's (chat_tools.PACKAGES,
one a tab): the Parts tab's tools are the catalog and its files ("parts")
apart from the stock ("stock"); the Chat's own are the web, the
conversations and PDFs. A tool not named in GROUP goes by its panel
package.

The first pass is cheap and deterministic - no model is asked: words in
English and Turkish (stems, so "notlarımı" is a note), a link (the web and
the catalog), the mentions' kinds (an attached file brings Files and the
Parts product files, so product_file_attach is there even for a small
model), and the packages the conversation's last answers used or were sent
- a conversation keeps its tools from one line to the next, which also
keeps the start of what is sent the same for the provider's prompt cache
(backend/llm.py). A line that points nowhere, in a conversation whose last
answers point nowhere either, gets every tool that is on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import chat_tools
from .chat_tools import Ctx, Result, Tool

# Always sent (when on): reading the clock, the workspace's memory, and the
# way to more tools.
CORE = ("clock", "memory_read", "memory_write")
MORE = "tools_more"
RECENT = 2                      # the conversation's last answers whose packages are kept

# A tool's package for this, where it is not its Tools panel package.
GROUP = {
    "analytics_read": "analytics",
    "queue_list": "queue", "queue_read": "queue", "room_note": "queue",
    "web_search": "web", "web_read": "web", "mcmaster_find": "web", "grabcad_find": "web",
    "chat_list": "chats", "chat_read": "chats", "chat_archive": "chats", "rename_chat": "chats",
    "pdf_make": "pdf",
    "inventory_search": "stock", "inventory_read": "stock", "inventory_add": "stock", "inventory_adjust": "stock",
    "inventory_edit": "stock", "inventory_remove": "stock", "build_count": "stock", "shopping_list": "stock",
    "stock_consume": "stock",
    "datasheet_get": "datasheets", "datasheet_read": "datasheets", "datasheet_search": "datasheets",
    "stock_low": "stock", "dm_read": "dm", "dm_send": "dm", "settings_read": "settings",
}
# panel package -> package here
PANEL = {"mfr": "parts", "commandcode": "chats", "general": "queue"}

# The packages, as the steps line and tools_more name them (English keys of i18n.ts).
LABELS = {
    "parts": "Parts", "stock": "Stock", "pcb": "PCB", "datasheets": "Datasheets", "cad": "3D", "firmware": "Firmware", "notes": "Notes",
    "taste": "Taste", "files": "Files", "web": "Web", "chats": "Chats", "pdf": "PDF", "analytics": "Analytics",
    "queue": "Queues", "tools": "Calculators", "dm": "Messages", "settings": "Settings", "wiki": "Wiki", "tasks": "Tasks",
}
ABOUT = {
    "parts": "Parts products: makers' catalogs, product pages, McMaster/GrabCAD saves, a product's files "
             "(attach a STEP, PDF or picture to a product, its 3D model)",
    "stock": "what is on hand: stock lines, adding and using up, how many builds the stock makes, shopping lists",
    "pcb": "boards, the LCSC parts drawer, LCSC search",
    "datasheets": "the datasheet library: search datasheets by question with page numbers, read pages, fetch one",
    "cad": "3D models: reading, rendering, drawings",
    "firmware": "firmware builds, their errors and sizes",
    "notes": "the person's notes: search, read, write, to-dos",
    "taste": "the person's design taste palettes",
    "files": "the Files room: reading, searching and restoring files",
    "web": "web search and reading pages; McMaster-Carr and GrabCAD searches",
    "chats": "earlier conversations: list, read, rename, archive",
    "pdf": "writing a PDF document",
    "analytics": "usage, costs and tokens from the Analytics room",
    "queue": "the rooms' agent queues and notes for them",
    "tools": "the Basic Tools calculators",
    "tasks": "scheduled tasks: recurring reports and refreshes, made, listed and run now",
    "dm": "direct messages with the other people of this server: reading them, sending one (asks first)",
    "settings": "which model each LLM job uses, this month's LLM usage and spend, the backups' state",
    "wiki": "each project's wiki: decisions and why, dimensions and limits, sourcing, open questions",
}

# Words that point to a package: English and Turkish stems, matched at the
# start of a word (Turkish suffixes are left free). A stem with "$" after it
# must be the whole word.
WORDS: dict[str, tuple[str, ...]] = {
    "parts": ("part", "product", "catalog", "manufactur", "maker", "supplier", "seller", "vendor", "shop",
              "buy", "price", "screw", "bolt", "nut$", "nuts$", "bearing", "standoff", "washer", "insert$",
              "spring", "motor", "sensor", "module", "mcmaster", "grabcad", "my items", "attach", "step$",
              "stp$", "3d model", "parça", "ürün", "katalog", "üretici", "satıcı", "tedarik", "mağaza", "fiyat",
              "satın", "vida", "somun", "rulman", "pul$", "yay$", "motor", "sensör", "modül", "iliştir"),
    "stock": ("stock", "inventor", "on hand", "how many", "in stock", "ran out", "used up", "consum", "shopping",
              "build count", "how many can", "bom", "stok", "envanter", "elimde", "kaç tane", "kaç adet", "adet",
              "bitti", "depo", "alışveriş", "eksik", "kaç kart", "kaç tane yap"),
    "pcb": ("board", "pcb", "schematic", "footprint", "lcsc", "drawer", "datasheet", "mosfet", "resistor",
            "capacitor", "diode", "transistor", "regulator", "ldo", "buck", "boost", "mcu", "esp32", "stm32",
            "rp2040", "pinout", "rds", "volt", "current", "ohm", "ic$", "chip", "net$", "nets$", "kart",
            "devre", "şema", "çekmece", "direnç", "kondansatör", "kapasitör", "diyot", "transistör",
            "regülatör", "bacak", "voltaj", "gerilim", "akım", "entegre", "lehim", "veri sayfa"),
    # A question a datasheet answers: its limits, pins, figures (the drawer's tools come with "pcb" words).
    "datasheets": ("datasheet", "data sheet", "maximum", "max ", "minimum", "absolute", "rating", "pinout", "pin out",
                   "pins", "electrical", "current", "volt", "power dissipation", "thermal", "junction", "rds",
                   "leakage", "quiescent", "spec", "veri sayfa", "maksimum", "azami", "minimum", "akım", "gerilim",
                   "voltaj", "bacak", "sınır", "dayan", "güç", "sıcaklı", "entegre", "teknik özellik"),
    "cad": ("3d", "cad", "model", "assembl", "drawing", "sketch", "extrud", "fillet", "chamfer", "enclosure",
            "case$", "lid", "bracket", "mount", "render", "stl", "mesh", "print", "çizim", "montaj", "kutu",
            "kapak", "muhafaza", "braket", "baskı", "yazıcı", "tasarım"),
    "firmware": ("firmware", "build", "compile", "flash", "platformio", "arduino", "code", "yazılım", "derle",
                 "gömülü", "kod"),
    "notes": ("note", "todo", "to-do", "jot", "tag", "notu", "notum", "notlar", "notun", "nota$", "notta$",
              "notla$", "yapılacak", "etiket"),
    "taste": ("taste", "palette", "style", "my rule", "preference", "zevk", "palet", "kural", "stil", "tercih"),
    "files": ("file", "upload", "attachment", "folder", "zip", "image", "photo", "picture", "document",
              "dosya", "belge", "klasör", "yükle", "resim", "fotoğraf", "görsel"),
    "web": ("web", "internet", "online", "search", "google", "website", "site", "url", "link", "look up",
            "ara$", "araştır", "bağlantı", "çevrimiçi", "sitesi"),
    "chats": ("conversation", "chat", "last time", "earlier we", "we talked", "rename", "archive", "title",
              "sohbet", "konuşma", "geçen sefer", "daha önce", "başlık", "arşiv", "adını"),
    "pdf": ("pdf", "report", "datasheet summary", "export", "rapor", "döküman"),
    "analytics": ("cost", "spend", "spent", "usage", "token", "budget", "bill", "analytic", "expensive",
                  "cache", "maliyet", "harca", "kullanım", "bütçe", "fatura", "analitik", "pahalı", "ne kadar tuttu"),
    "queue": ("queue", "agent", "task", "working on", "room note", "kuyruk", "ajan", "görev"),
    "tools": ("calculat", "compute", "formula", "convert", "hesap", "hesapla", "dönüştür", "formül"),
    "tasks": ("schedul", "every day", "every week", "every monday", "every morning", "every night", "nightly",
              "weekly report", "daily report", "recurring", "cron", "her gün", "her hafta", "her pazartesi",
              "her sabah", "her gece", "her akşam", "haftalık", "günlük rapor", "zamanla", "tekrarla", "periyodik",
              "otomatik gönder", "zamanlanmış"),
    "dm": ("direct message", "message", "dm$", "dms$", "inbox", "wrote me", "wrote to me", "mesaj", "ileti",
           "yazdı", "yazmış"),
    "settings": ("setting", "backup", "provider", "which model", "llm", "restore check", "ayar", "yedek",
                 "sağlayıcı", "hangi model"),
    "wiki": ("wiki", "decision", "decided", "why did we", "why we", "open question", "limit", "dimension",
             "tolerance", "sourcing", "production note", "karar", "neden böyle", "açık soru", "sınır", "ölçü",
             "tolerans", "üretim not"),
}
# A mention's kind -> packages (cc_context.KINDS). An attached file can be a
# product's new file: Parts too.
MENTIONS = {"model": ("cad",), "board": ("pcb",), "file": ("files", "parts"), "note": ("notes",),
            "revision": ("queue", "cad"), "part": ("pcb", "parts", "datasheets"), "taste": ("taste",),
            "manufacturer": ("parts",)}
LINK = re.compile(r"https?://|www\.", re.I)


def _rx(stems: tuple[str, ...]) -> re.Pattern:
    alts = [re.escape(s[:-1]) + r"\b" if s.endswith("$") else re.escape(s) for s in stems]
    return re.compile(r"(?<![\w])(?:" + "|".join(alts) + ")", re.I)


_WORDS = {g: _rx(w) for g, w in WORDS.items()}


def lower(text: str) -> str:
    """Lower case, with Turkish İ as a plain i (str.lower() leaves a dot behind)."""
    return (text or "").replace("İ", "i").lower()


def group_of(t: Tool) -> str:
    return GROUP.get(t.name) or PANEL.get(t.package, t.package)


def groups_in(text: str) -> set[str]:
    """The packages a line's words point to."""
    low = lower(text)
    got = {g for g, rx in _WORDS.items() if rx.search(low)}
    if LINK.search(low):
        got |= {"web", "parts"}
    return got


@dataclass
class Pick:
    groups: list[str]                          # the packages sent, in LABELS' order
    names: set[str]                            # the tools sent (core included)
    all: bool = False                          # everything that is on (nothing narrowed)
    why: dict[str, list[str]] = field(default_factory=dict)


def _ordered(gs) -> list[str]:
    rank = {g: i for i, g in enumerate(LABELS)}
    return sorted(set(gs), key=lambda g: (rank.get(g, len(rank)), g))


def pick(convo: list[dict], on: dict[str, Tool]) -> Pick:
    """The tools for the conversation's last line, out of those that are on."""
    last = convo[-1] if convo else {}
    why: dict[str, list[str]] = {}

    def add(gs, reason):
        for g in gs:
            why.setdefault(g, []).append(reason)

    add(groups_in(last.get("content") or ""), "words")
    for m in last.get("mentions") or []:
        add(MENTIONS.get(m.get("kind") or "", ()), "mention")
    if last.get("attach"):
        add(("files", "parts"), "attachment")
    # The conversation's last answers: the packages they were sent and the tools they ran.
    seen = 0
    for m in reversed(convo[:-1]):
        if m.get("role") != "assistant":
            continue
        if not m.get("packages_all"):          # a line that got everything says nothing of its own
            add(m.get("packages") or [], "conversation")
        add(m.get("packages_added") or [], "conversation")
        add([group_of(on[s["tool"]]) if s.get("tool") in on else GROUP.get(s.get("tool") or "", "")
             for s in m.get("steps") or []], "conversation")
        seen += 1
        if seen >= RECENT:
            break
    why.pop("", None)
    present = {group_of(t) for n, t in on.items() if n not in CORE}
    chosen = set(why) & present
    if not chosen:
        chosen = present                       # nothing to go by: everything that is on
    names = {n for n, t in on.items() if n in CORE or group_of(t) in chosen}
    return Pick(groups=_ordered(chosen), names=names, all=chosen == present, why=why)


def note(p: Pick, on: dict[str, Tool]) -> str:
    """What the model is told about the packages it was not sent."""
    if p.all:
        return ""
    rest = _ordered({group_of(t) for n, t in on.items() if n not in p.names})
    if not rest:
        return ""
    return (f" Only the tool packages this line seems to need were sent ({', '.join(LABELS.get(g, g) for g in p.groups) or 'none'}). "
            "The instructions above also name tools of other packages; when you need one you do not have - or a "
            f"package of these: {', '.join(rest)} - call {MORE} with it first, then go on. Never say you lack a tool "
            f"without asking {MORE} for it.")


def more_tool(on: dict[str, Tool], sent: dict[str, Tool], out: dict) -> Tool:
    """tools_more for one answer: adds the packages (or the tools) asked for,
    of those that are on, to `sent` - the next round has them."""
    rest = _ordered({group_of(t) for n, t in on.items() if n not in sent})

    async def run(ctx: Ctx, args: dict) -> Result:
        want = {str(g).strip().lower() for g in (args.get("packages") or []) if str(g).strip()}
        names = {str(n).strip() for n in (args.get("tools") or []) if str(n).strip()}
        by_label = {v.lower(): k for k, v in LABELS.items()}
        want = {by_label.get(g, g) for g in want}
        added = [n for n, t in on.items() if n not in sent and (group_of(t) in want or n in names)]
        off = sorted(n for n in names if n not in on and n in chat_tools.tools())
        unknown = sorted((want - set(LABELS)) | {n for n in names if n not in chat_tools.tools()})
        for n in added:
            sent[n] = on[n]
        got = _ordered({group_of(on[n]) for n in added})
        out.setdefault("packages_added", [])
        out["packages_added"] = _ordered({*out["packages_added"], *got})
        lines = []
        if added:
            lines.append(f"Added {len(added)} tools ({', '.join(got)}): {', '.join(added)}. They are yours from the next step on.")
        else:
            lines.append("No tools were added: the ones asked for are already yours, or none matched.")
        if off:
            lines.append(f"Turned off by the person in the Chat's Tools panel (not available): {', '.join(off)}.")
        if unknown:
            lines.append(f"No such package or tool: {', '.join(unknown)}. Packages: {', '.join(LABELS)}.")
        label = ", ".join(LABELS.get(g, g) for g in got) or "-"
        return Result(text=" ".join(lines), say="Took more tools: {packages}", vars={"packages": label},
                      summary=" ".join(lines)[:600])

    listing = "; ".join(f"{g} ({ABOUT.get(g, '')})" for g in rest)
    return Tool(
        name=MORE, package="commandcode", level="read", order=0,
        label="More tools", about="Lets the model take tool packages it was not sent with the line.",
        description=("Ask for more tools for this answer. Only the tool packages this line seemed to need were sent; "
                     f"these others exist: {listing}. Name the packages (or tool names) you need; they are yours from "
                     "the next step on. Use it whenever the person's request needs a tool you do not have."),
        schema={"type": "object", "properties": {
            "packages": {"type": "array", "items": {"type": "string", "enum": rest or list(LABELS)},
                         "description": "packages to add"},
            "tools": {"type": "array", "items": {"type": "string"}, "description": "or tool names to add"}}},
        running="Taking more tools", failed="Could not take more tools", run=run)
