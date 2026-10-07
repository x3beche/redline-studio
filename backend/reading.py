"""What the agent wrote, in the reader's language.

The agents write in English: their questions ("Agent is asking") and their
replies in the room's thread. The person reading may rather read Turkish,
or German. So a question, or a thread line, can be translated on request
into a language the reader picks - by the "Reading translation" job
(backend/llm.py), on whichever provider and model Settings > LLM settings
gives it.

A translation is asked for once: it is kept on the question's (or the
line's) own document, under `translations.<language>`, with a hash of what
was translated. Read again, it comes from there; if the text were ever
changed, the hash no longer matches and it is translated afresh.

The direction is the opposite of the "English translation" job in
summarise.py, which turns a Turkish note into an English request at the
door; this one only changes what a reader sees, and writes nothing a model
or an agent reads.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import llm

log = logging.getLogger("redline.reading")

JOB = "reading"
TIMEOUT = 90.0
TEMPERATURE = 0.1

# What "no translation" is called: the agents write English.
ORIGINAL = {"", "en", "english", "original", "en-us", "en-gb", "ingilizce", "orijinal"}

# A code is a poor instruction to a model; a few are spelled out.
NAMES = {"tr": "Turkish", "de": "German", "es": "Spanish", "fr": "French", "it": "Italian",
         "ru": "Russian", "zh": "Chinese (Simplified)", "ja": "Japanese", "ar": "Arabic"}

# One prompt per language, byte-stable, so the provider can cache it.
PROMPT = (
    "You translate messages that a CAD and electronics design agent wrote for "
    "the person reviewing its work. Translate the user's message into {lang}.\n"
    "\n"
    "Rules:\n"
    "- Keep the Markdown structure exactly: the same headings, list items and "
    "their numbering, table rows and columns (every | and the --- separator "
    "row), block quotes, bold and italics, line breaks and blank lines.\n"
    "- Copy anything inside `inline code` or a ``` code block unchanged; never "
    "translate code.\n"
    "- Never translate or alter identifiers, file names, paths, function and "
    "variable names, model and part names, part numbers, URLs or units.\n"
    "- Keep every number exactly as written, with its sign, decimal point and "
    "unit: 2.5 mm stays 2.5 mm; M3, 0.4 mm, 12 V, ±0.1, 45° and 3x stay as "
    "they are.\n"
    "- Translate the meaning plainly. Add nothing, drop nothing, no notes or "
    "explanations.\n"
    "- If the message is already in {lang}, return it unchanged.\n"
    "- Return only the translation, not wrapped in quotes or a code block."
)


def language(lang: str | None) -> str | None:
    """The language as the prompt names it; None for the original (English).
    Anything but letters, spaces, hyphens and brackets is dropped - the name
    goes into a prompt."""
    raw = re.sub(r"[^\w\s()\-]", "", (lang or ""), flags=re.UNICODE)
    raw = re.sub(r"[\d_]", "", raw)
    raw = re.sub(r"\s+", " ", raw).strip()[:40]
    if raw.lower() in ORIGINAL:
        return None
    # A code from the app's one list (backend/tgbot/languages.py - the page's
    # picker sends codes): the model is told the language's name.
    from .tgbot import languages
    if languages.known(raw):
        return languages.english(raw)
    return NAMES.get(raw.lower(), raw) or None


def lang_key(name: str) -> str:
    """The field the translation is kept under: no dots, no dollars."""
    return re.sub(r"[.$\s]+", "-", name.strip().lower())


def source_hash(parts: list) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:16]


def messages(text: str, lang: str) -> list[dict]:
    return [{"role": "system", "content": PROMPT.format(lang=lang)},
            {"role": "user", "content": text}]


_FENCE = re.compile(r"\A```[\w-]*\n(.*)\n```\Z", re.S)


def unwrap(out: str, source: str) -> str:
    """The answer as written, but for a code fence wrapped round all of it
    when the source had none. Nothing else is touched: the Markdown is the
    point."""
    out = (out or "").strip("\n").rstrip()
    m = _FENCE.match(out.strip())
    if m and not source.lstrip().startswith("```"):
        out = m.group(1)
    return out


def max_tokens(text: str) -> int:
    # Scripts such as Chinese or Arabic cost about a token a character; a
    # thinking model spends some first. Only what is used is billed.
    return min(8000, 1500 + 2 * len(text))


async def one(db, text: str, lang: str, kind: str) -> tuple[str, dict]:
    """One piece translated: (translation, {provider, model})."""
    d = await llm.complete(messages(text, lang), job=JOB, max_tokens=max_tokens(text),
                           temperature=TEMPERATURE, reasoning=False, timeout=TIMEOUT)
    used = d.get("usage") or {}
    await llm.record(db, provider=d["provider"], model=d["model"], surface="reading",
                     kind=kind, used=used)
    try:
        out = d["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("the model's answer had no text") from exc
    out = unwrap(out, text)
    if not out.strip():
        raise RuntimeError("the model's answer was empty")
    return out, {"provider": d["provider"], "model": d["model"]}


def _check_key() -> None:
    provider = llm.route(JOB)[0]
    if not llm.key(provider):
        # 409: the request is fine, the server is not set up for it yet.
        raise HTTPException(409, llm.no_key(provider, JOB))


_locks: dict[str, asyncio.Lock] = {}


async def translate_doc(db, coll: str, doc_id: str, lang: str | None,
                        fields: tuple[str, ...], kind: str) -> dict:
    """Translate a document's `fields` (strings, or lists of strings) into
    `lang`, keep it on the document, and return it. Asked for again, it comes
    from the document."""
    doc = await db[coll].find_one({"_id": doc_id})
    if not doc:
        raise HTTPException(404, f"no {coll[:-1] if coll.endswith('s') else coll} with that id")
    name = language(lang)
    src = {f: doc.get(f) for f in fields}
    if name is None:                                  # the original is English
        return {"id": doc_id, "lang": None, **src, "original": True, "cached": True}
    key = lang_key(name)
    digest = source_hash([src[f] for f in fields])
    hit = ((doc.get("translations") or {}).get(key) or {})
    if hit.get("hash") == digest:
        return {"id": doc_id, "lang": name, **{f: hit.get(f) for f in fields},
                "provider": hit.get("provider"), "model": hit.get("model"), "cached": True}
    _check_key()

    lock = _locks.setdefault(f"{coll}:{doc_id}:{key}", asyncio.Lock())
    async with lock:
        # Someone else may have just done it.
        doc = await db[coll].find_one({"_id": doc_id}) or doc
        hit = ((doc.get("translations") or {}).get(key) or {})
        if hit.get("hash") == digest:
            return {"id": doc_id, "lang": name, **{f: hit.get(f) for f in fields},
                    "provider": hit.get("provider"), "model": hit.get("model"), "cached": True}

        # Every piece at once: the question, what the agent knows, each option.
        jobs, where = [], []
        for f in fields:
            v = src[f]
            if isinstance(v, list):
                for i, s in enumerate(v):
                    if isinstance(s, str) and s.strip():
                        jobs.append(one(db, s, name, kind)); where.append((f, i))
            elif isinstance(v, str) and v.strip():
                jobs.append(one(db, v, name, kind)); where.append((f, None))
        try:
            done = await asyncio.gather(*jobs)
        except HTTPException:
            raise
        except Exception as exc:                       # noqa: BLE001
            log.warning("reading translation of %s %s failed: %s", coll, doc_id, exc)
            raise HTTPException(502, f"the translation did not come: {exc}"[:300]) from exc

        out = {f: (list(src[f]) if isinstance(src[f], list) else src[f]) for f in fields}
        via: dict = {}
        for (f, i), (text, who) in zip(where, done):
            if i is None:
                out[f] = text
            else:
                out[f][i] = text
            via = who
        if not via:                                    # nothing to translate
            via = dict(zip(("provider", "model"), llm.route(JOB)))
        from datetime import datetime, timezone
        kept = {"lang": name, "hash": digest, **out, **via,
                "at": datetime.now(timezone.utc).isoformat()}
        await db[coll].update_one({"_id": doc_id}, {"$set": {f"translations.{key}": kept}})
        return {"id": doc_id, "lang": name, **out, **via, "cached": False}


# ---------------- the routes ----------------
# Reading is a viewer's (backend/access.py): it changes nothing anyone else
# reads, and each translation is paid for once per question and language.

router = APIRouter()


def _db():
    from .main import db
    return db()


class TranslateIn(BaseModel):
    lang: str = Field(min_length=1, max_length=40)


@router.post("/api/questions/{qid}/translate")
async def translate_question(qid: str, body: TranslateIn) -> dict:
    """{id, lang, text, context, options, provider, model, cached}"""
    from . import questions
    return await translate_doc(_db(), questions.QUESTIONS, qid, body.lang,
                               ("text", "context", "options"), "reading:question")


@router.post("/api/chat/{mid}/translate")
async def translate_chat_line(mid: str, body: TranslateIn) -> dict:
    """{id, lang, text, provider, model, cached} - a line of the room's thread."""
    from . import chat
    return await translate_doc(_db(), chat.CHAT, mid, body.lang, ("text",), "reading:chat")
