"""Every instruction the app sends to a model, and the owner's own wording of it.

Settings > LLM settings > Prompts lists them: the Chat's system line (and
the parts the code adds to it as it runs), its titles, the next-question
suggestion, the example questions, the card summaries and translations,
the tool finder, the part drawer, Taste, the manufacturer reading, voice
to text and the scheduled questions. Each one's text stays where it always
was (cc_chat.SYSTEM, suggest.PROMPT...): that is its default. An override
typed on the page is kept in the LLM settings document (`prompts`), for the
whole machine like the keys and the jobs, and every process that reads the
LLM settings (llm.load) reads it with them - the Chat's answer runner and
the job processes included, so a change counts from the next call.

A prompt the code fills as it runs names its holes as {name} (`slots`).
An override must keep the required ones - the page is told which is
missing and nothing is saved; one that lost them anyway (a slot added
later, a document edited by hand) is not used: the default is, with a
warning in the log, and the page shows the prompt as falling back.
"""

from __future__ import annotations

import hashlib
import importlib
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from . import llm

FIELD = "prompts"                # in the llm_settings document: {id: {text, at, by}}
MAX_CHARS = 50_000               # an override's length
# A token is counted as this many characters - an estimate for the page
# (backend/tool_router.py counts the same way).
CHARS_PER_TOKEN = 3.6
SLOT = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _mod(name: str):
    return importlib.import_module(f"backend.{name}")


def _unbrace(text: str) -> str:
    """A str.format template as the page shows it: {{ and }} written once
    (fill() replaces only the slots, so a JSON example stays as it is)."""
    return text.replace("{{", "{").replace("}}", "}")


@dataclass(frozen=True)
class Prompt:
    id: str
    name: str                          # as the page lists it
    job: str                           # the llm.JOBS job whose model gets it
    where: str                         # when and how it is sent
    default: Callable[[], str]         # the text in the code, read when asked
    group: str = "Chat"
    role: str = "system"               # "system", or "user" when it goes in the person's line
    source: str = ""                   # module.CONSTANT
    slots: dict[str, str] = field(default_factory=dict)      # {name: what fills it}
    required: tuple[str, ...] = ()
    runtime: tuple[str, ...] = ()      # what the code adds around it as it runs
    editable: bool = True


PROMPTS: tuple[Prompt, ...] = (
    Prompt("chat_system", "Chat: system line", "chat",
           "Starts the system line of every Chat answer (backend/cc_chat.py history, sent by backend/ccgen.py).",
           lambda: _mod("cc_chat").SYSTEM, source="cc_chat.SYSTEM",
           runtime=("The note on earlier tool runs, when earlier answers ran tools",
                    "The workspace memory: what the people of this workspace pinned",
                    "The tools note and the exact list of the tools sent, when tools are sent",
                    "Which tool packages were left out, and how to ask for them")),
    Prompt("chat_steps", "Chat: earlier tool runs", "chat",
           "Added to the Chat's system line when earlier answers in the conversation ran tools.",
           lambda: _mod("cc_chat").STEPS_NOTE, source="cc_chat.STEPS_NOTE"),
    Prompt("chat_tools", "Chat: how to use the tools", "chat",
           "Added to the Chat's system line when the answer is sent tools, and to a scheduled question's; "
           "the list of the tools sent follows it.",
           lambda: _mod("chat_tools").SYSTEM_NOTE, source="chat_tools.SYSTEM_NOTE",
           runtime=("The tools sent this time, by package",
                    "Which tool packages were left out, and how to ask for them")),
    Prompt("chat_title", "Chat titles: first naming", "summary",
           "System line when a new conversation is named from its first line and the start of the answer "
           "(backend/cc_chat.py make_title).",
           lambda: _mod("cc_chat").TITLE_PROMPT, source="cc_chat.TITLE_PROMPT",
           runtime=("The first line and the start of the answer, as the person's line",)),
    Prompt("chat_retitle", "Chat titles: renaming", "summary",
           "System line when a conversation is named again from all of it: Retitle, and the renaming at rest.",
           lambda: _mod("cc_chat").RETITLE_PROMPT, source="cc_chat.RETITLE_PROMPT",
           runtime=("The conversation, shortened, as the person's line",)),
    Prompt("suggest", "Next-question suggestion", "suggest",
           "System line of the suggestion call after an answer (backend/suggest.py).",
           lambda: _mod("suggest").PROMPT, source="suggest.PROMPT",
           runtime=("The end of the conversation, as the person's line",)),
    Prompt("chat_ideas", "Chat example questions", "chat_suggestions",
           "System line when the empty Chat's example questions are written (backend/chat_ideas.py).",
           lambda: _unbrace(_mod("chat_ideas").PROMPT), source="chat_ideas.PROMPT",
           slots={"n": "how many questions (the job's setting)",
                  "chars": "at most this many characters a question",
                  "lang": "the page's language"},
           required=("n", "lang"),
           runtime=("The workspace summary, as the person's line",)),
    Prompt("summary_tr", "Card summary (Turkish)", "summary",
           "System line when a revision card gets its one-sentence summary in Turkish; the note and its "
           "drawing follow (backend/summarise.py).",
           lambda: _mod("summarise").SYSTEM_PROMPT_TR, group="Notes", source="summarise.SYSTEM_PROMPT_TR",
           runtime=("The note and its drawing, as the person's line",)),
    Prompt("summary_en", "Card summary (English)", "summary",
           "System line when a revision card gets its one-sentence summary in English.",
           lambda: _mod("summarise").SYSTEM_PROMPT_EN, group="Notes", source="summarise.SYSTEM_PROMPT_EN",
           runtime=("The note and its drawing, as the person's line",)),
    Prompt("translate", "English translation of notes", "translate",
           "System line when a note is turned into an English request (backend/summarise.py translate).",
           lambda: _mod("summarise").TRANSLATE_PROMPT, group="Notes", source="summarise.TRANSLATE_PROMPT",
           runtime=("The note, as the person's line",)),
    Prompt("reading", "Reading translation", "reading",
           "System line when an agent's question or reply, or the Telegram bot's profile, is translated into "
           "the reader's language (backend/reading.py).",
           lambda: _unbrace(_mod("reading").PROMPT), group="Notes", source="reading.PROMPT",
           slots={"lang": "the reader's language"}, required=("lang",),
           runtime=("The text, as the person's line",)),
    Prompt("router", "Tool finder", "router",
           "System line of the tool finder: the MCP server's find_tool and /api/tools/find (backend/tool_router.py).",
           lambda: _mod("tool_router").SYSTEM, group="Tools", source="tool_router.SYSTEM",
           runtime=("The index of the Basic Tools and the task, as the person's line",)),
    Prompt("part_category", "Part category", "part_category",
           "System line when a new LCSC part's drawer place is not clear from its facts (backend/lcsc.py).",
           lambda: _mod("lcsc").CATEGORY_PROMPT, group="Parts", source="lcsc.CATEGORY_PROMPT",
           slots={"places": "the drawer's groups and branches, one a line"}, required=("places",),
           runtime=("The part's LCSC facts, as the person's line",)),
    Prompt("taste_extract", "Taste extraction", "taste",
           "System line of a Taste extraction (backend/taste.py); one of the additions below follows it.",
           lambda: _mod("taste").EXTRACT_PROMPT, group="Taste", source="taste.EXTRACT_PROMPT",
           runtime=("One of the additions: a whole folder, with renders, or text only",
                    "The project's source, measurements, notes and renders, as the person's line")),
    Prompt("taste_folder", "Taste extraction: a whole folder", "taste",
           "Added after the Taste extraction's system line when a whole project folder is read.",
           lambda: _mod("taste").FOLDER_PROMPT.strip(), group="Taste", source="taste.FOLDER_PROMPT"),
    Prompt("taste_look", "Taste extraction: with renders", "taste",
           "Added after the Taste extraction's system line when renders and measurements come with the material.",
           lambda: _mod("taste").LOOK_PROMPT.strip(), group="Taste", source="taste.LOOK_PROMPT"),
    Prompt("taste_text_only", "Taste extraction: text only", "taste",
           "Added after the Taste extraction's system line for a model or a folder read without pictures.",
           lambda: _mod("taste").TEXT_ONLY_PROMPT.strip(), group="Taste", source="taste.TEXT_ONLY_PROMPT"),
    Prompt("taste_check", "Taste check", "taste",
           "System line when a finished design is checked against its taste palette (backend/taste_check.py).",
           lambda: _mod("taste_check").CHECK_PROMPT, group="Taste", source="taste_check.CHECK_PROMPT",
           runtime=("The palette's statements and the renders, as the person's line",)),
    Prompt("manufacturer", "Manufacturer exploration", "manufacturer",
           "System line for each part of a maker's pages read for the catalog (backend/manufacturers.py).",
           lambda: _mod("manufacturers").EXTRACT_PROMPT, group="Parts", source="manufacturers.EXTRACT_PROMPT",
           runtime=("The site's name and its pages, as the person's line",)),
    Prompt("manufacturer_only", "Manufacturer exploration: picked pages", "manufacturer",
           "Put at the start of the person's line when the pages were picked by hand rather than crawled.",
           lambda: _mod("manufacturers").ONLY_PROMPT, group="Parts", role="user", source="manufacturers.ONLY_PROMPT"),
    Prompt("voice", "Voice to text", "voice",
           "Sent with the recording, as the text of the person's line (backend/voice.py).",
           lambda: _mod("voice").PROMPT.replace(_mod("voice").NOTHING, "{nothing}"), group="Voice", role="user",
           source="voice.PROMPT", slots={"nothing": "what the model writes when it hears no speech: (no speech)"},
           required=("nothing",),
           runtime=("The language expected: Turkish, English or either", "The recording")),
    Prompt("file_ocr", "Read a file's text (OCR)", "file_ocr",
           "System line when the words on a picture or a scanned page are read, a page at a time "
           "(backend/ocrtext.py).",
           lambda: _mod("ocrtext").PROMPT, group="Files", source="ocrtext.PROMPT",
           slots={"lang": "the language to write the words in, as a phrase"},
           required=("lang",),
           runtime=("The pages' pictures, each with the line that names its page",)),
    Prompt("scheduled_ask", "Scheduled question", "chat",
           "System line of a scheduled task that asks the Chat a question (backend/sched/kinds.py).",
           lambda: _mod("sched.kinds").ASK_SYSTEM, group="Scheduled", source="sched.kinds.ASK_SYSTEM",
           runtime=("'Answer in Turkish.' when the task's language is Turkish",
                    "The tools note and the list of the tools, read-only ones only",
                    "The task's question, as the person's line")),
    Prompt("llm_test", "Settings test", "",
           "The one line a Test button on this page sends, to prove a key and a model answer (backend/llm_api.py).",
           lambda: "Reply with exactly: OK", group="Settings", role="user", source="llm_api.test",
           editable=False),
)
BY_ID = {p.id: p for p in PROMPTS}
# The prompts the Chat's system line is made of: a change to any of them is
# a new start for the provider's cache of a conversation (session()).
CHAT = ("chat_system", "chat_steps", "chat_tools")

_warned: set[tuple[str, str]] = set()


def _overrides() -> dict:
    """The overrides as the settings were last read (llm.load)."""
    got = llm._conf.get(FIELD) if isinstance(llm._conf, dict) else None
    return got if isinstance(got, dict) else {}


def override(pid: str) -> dict | None:
    """{text, at, by} kept for a prompt, or None."""
    o = _overrides().get(pid)
    return o if isinstance(o, dict) and isinstance(o.get("text"), str) and o["text"].strip() else None


def missing(p: Prompt, text: str) -> list[str]:
    """The required slots a text lacks."""
    return [s for s in p.required if "{" + s + "}" not in text]


def unknown(p: Prompt, text: str) -> list[str]:
    """{names} in a text that are not this prompt's slots: sent as written."""
    return sorted({m for m in SLOT.findall(text) if m not in p.slots})


def fill(p: Prompt, text: str, values: dict) -> str:
    """The text with its slots filled; anything else in braces as it is."""
    if not p.slots:
        return text
    return SLOT.sub(lambda m: str(values[m.group(1)]) if m.group(1) in p.slots and m.group(1) in values
                    else m.group(0), text)


def text(pid: str, **values) -> str:
    """The prompt as it is sent now: the override when there is a usable
    one, else the code's own; its slots filled from `values`."""
    p = BY_ID[pid]
    o = override(pid) if p.editable else None
    body = p.default()
    if o is not None:
        lost = missing(p, o["text"])
        if lost:
            key = (pid, o.get("at") or "")
            if key not in _warned:
                _warned.add(key)
                llm.log.warning("prompt %s: the override lacks %s - the default is used",
                                pid, ", ".join("{" + s + "}" for s in lost))
        else:
            body = o["text"]
    return fill(p, body, values)


def stamp(ids=CHAT) -> str:
    """A short mark of the overrides in use among `ids`: "" when none."""
    used = [(pid, override(pid)["text"]) for pid in ids if override(pid) and not missing(BY_ID[pid], override(pid)["text"])]
    if not used:
        return ""
    return hashlib.sha256(repr(used).encode()).hexdigest()[:10]


def session(chat: str | None) -> str | None:
    """The conversation's key for the provider's cache (llm.SESSION): its
    id, and the mark of the Chat's prompts once one of them is overridden -
    another system line is another start to cache."""
    if not chat:
        return None
    s = stamp(CHAT)
    return f"{chat}~{s}" if s else chat


def tools_note(on: list) -> str:
    """chat_tools.note() with the overridden tools note in place of
    SYSTEM_NOTE: the list of the tools sent follows it as before."""
    from . import chat_tools
    whole = chat_tools.note(on)
    return text("chat_tools") + whole[len(chat_tools.SYSTEM_NOTE):]


def tokens(s: str) -> int:
    return math.ceil(len(s) / CHARS_PER_TOKEN) if s else 0


def _entry(p: Prompt) -> dict:
    default = p.default()
    o = override(p.id) if p.editable else None
    lost = missing(p, o["text"]) if o else []
    shown = o["text"] if o and not lost else default
    job = llm.JOBS.get(p.job) or {}
    return {"id": p.id, "name": p.name, "group": p.group, "job": p.job, "job_label": job.get("label") or "",
            "where": p.where, "role": p.role, "source": p.source, "editable": p.editable,
            "slots": [{"name": k, "about": v, "required": k in p.required} for k, v in p.slots.items()],
            "runtime": list(p.runtime), "default": default,
            "default_chars": len(default), "default_tokens": tokens(default),
            "override": o["text"] if o else None, "at": (o or {}).get("at"), "by": (o or {}).get("by"),
            "state": "fallback" if lost else "override" if o else "default", "missing": lost,
            "chars": len(shown), "tokens": tokens(shown)}


def public() -> dict:
    return {"prompts": [_entry(p) for p in PROMPTS], "max_chars": MAX_CHARS,
            "chars_per_token": CHARS_PER_TOKEN}


def check(pid: str, body: str) -> tuple[Prompt, str, list[str]]:
    """(prompt, the text as kept, warnings) - ValueError when it cannot be kept."""
    p = BY_ID.get(pid)
    if p is None:
        raise KeyError(pid)
    if not p.editable:
        raise ValueError(f"{p.name}: this one is not changed here")
    body = (body or "").replace("\r\n", "\n").strip()
    if not body:
        raise ValueError(f"{p.name}: the text is empty - use Back to the default instead")
    if len(body) > MAX_CHARS:
        raise ValueError(f"{p.name}: at most {MAX_CHARS} characters ({len(body)})")
    lost = missing(p, body)
    if lost:
        raise ValueError(f"{p.name}: the text must keep " + ", ".join("{" + s + "}" for s in lost)
                         + " - the code fills it in as it runs")
    warn = [f"{{{u}}} is not filled by the code: it is sent as written" for u in unknown(p, body)]
    return p, body, warn


async def save(db, pid: str, body: str, by: dict | None = None) -> tuple[dict, list[str]]:
    """Keep an override (the default's own text is the same as none)."""
    p, body, warn = check(pid, body)
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    if body == p.default().strip():
        await raw[llm.COLL].update_one({"_id": llm.DOC_ID}, {"$unset": {f"{FIELD}.{pid}": ""}}, upsert=True)
    else:
        who = {k: v for k, v in (by or {}).items() if k in ("id", "name", "type")}
        await raw[llm.COLL].update_one({"_id": llm.DOC_ID}, {"$set": {f"{FIELD}.{pid}": {
            "text": body, "at": datetime.now(timezone.utc).isoformat(), "by": who}}}, upsert=True)
    await llm.load(db)
    return _entry(p), warn


async def reset(db, pid: str) -> dict:
    """Back to the code's own text."""
    p = BY_ID.get(pid)
    if p is None:
        raise KeyError(pid)
    raw = db.raw if getattr(type(db), "SCOPED", False) else db
    await raw[llm.COLL].update_one({"_id": llm.DOC_ID}, {"$unset": {f"{FIELD}.{pid}": ""}}, upsert=True)
    await llm.load(db)
    return _entry(p)
