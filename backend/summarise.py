"""One short Turkish sentence describing what a revision card asks for.

The cards are free text a person typed while looking at the model, often
long and rambling, and the point of the sentence is that a collapsed card
still says something. The drawing goes with the text because the text
leans on it: "bu kisim", "bu yazi" only mean something next to the red
marks.

The call is made here, on the server. The key never reaches the browser.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import re

log = logging.getLogger("redline.summarise")

# Which provider and model: backend/llm.py, chosen in Settings > LLM settings.
# MODEL is the default the summary job starts with.
MODEL = "Qwen/Qwen3.8-Flash"
TIMEOUT = 30.0
MAX_TOKENS = 60
TEMPERATURE = 0.2
RETRIES = 2                 # on top of the first try
MAX_WORDS = 12              # over this, ask once more
IMAGE_EDGE = 512            # long edge sent to the model
BUDGET_USD = 0.005          # per request; expected around 0.0002

# Kept byte-identical on every request so the provider can cache the prefix.
# Two fixed prompts rather than one that says "use the input's language":
# the examples are what actually pins the register and the length, and an
# example in the wrong language drags the answer with it. Each is byte-stable
# so the prompt cache still works, one entry per language.
SYSTEM_PROMPT_EN = (
    "Summarise the instruction on a 3D design task card in one English "
    "sentence of 5-10 words. Write it as a command (e.g. 'shrink', "
    "'centre'). Use the marks on the image to understand phrases like 'this "
    "part' or 'this text'. Write only the sentence; no quotes, no "
    "explanation, no prefix.\n"
    "\n"
    "Examples:\n"
    "Input: the pockets are too deep all round, halve the depths top and "
    "bottom on both faces of the fan\n"
    "Output: Halve the pocket depths on both fan faces\n"
    "\n"
    "Input: lets drop the font on this text a bit and centre it vertically\n"
    "Output: Shrink the text and centre it vertically\n"
    "\n"
    "Input: fill this area in and make the pocket a bit smaller\n"
    "Output: Fill the gap and shrink the pocket"
)

SYSTEM_PROMPT_TR = (
    "3D tasarim gorev kartlarindaki talimati 5-10 kelimelik tek bir Turkce "
    "cumleyle ozetle. Emir kipinde yaz (or. 'kucult', 'ortala'). Goruntudeki "
    "isaretleri, metindeki 'bu kisim', 'bu yazi' gibi ifadeleri anlamak icin "
    "kullan. Sadece ozet cumlesini yaz; tirnak, aciklama veya on ek ekleme.\n"
    "\n"
    "Ornekler:\n"
    "Girdi: genel olarak yuvalari cok derin yuvalarin derinliklerini yari "
    "yariya yap altli ustlu fanin iki tarafi icin de\n"
    "Cikti: Fanin iki yuzundeki yuva derinliklerini yariya indir\n"
    "\n"
    "Girdi: bu yazinin fontunu birtaz daha dusurelim ve dikeyde ortalayalim\n"
    "Cikti: Yazinin fontunu kucult ve dikeyde ortala\n"
    "\n"
    "Girdi: bu kisimdaki yeri fill edelim yuva biraz daha kuculsun\n"
    "Cikti: Boslugu doldur ve yuvayi kucult"
)

# Kept for anything importing the old name.
SYSTEM_PROMPT = SYSTEM_PROMPT_TR

_PREFIX = re.compile(r"^\s*(ozet|özet|summary)\s*[:\-]\s*", re.IGNORECASE)
_QUOTES = "\"'“”‘’«»`"


def clean(raw: str) -> str:
    """Trim the model's reply down to one bare sentence."""
    text = (raw or "").strip()
    text = text.split("\n")[0].strip()          # tek satir
    # Tirnak ve onek ic ice gelebiliyor ("Ozet: ..."), o yuzden degisim
    # durana kadar donuyoruz.
    for _ in range(4):
        before = text
        text = text.strip(_QUOTES).strip()
        text = _PREFIX.sub("", text).strip()
        if text == before:
            break
    return re.sub(r"\s+", " ", text).strip()


def clean_translation(raw: str) -> str:
    """A translated note, whole: every line kept (unlike clean(), which is
    for one-sentence summaries and keeps only the first line - a multi-line
    note came back as its title). Only a wrapping code fence, wrapping
    quotes or a "Translation:" label are taken off."""
    text = (raw or "").strip()
    fence = re.match(r"^```[\w-]*\n(.*)\n```$", text, re.S)
    if fence:
        text = fence.group(1).strip()
    text = re.sub(r"^(?:english\s+)?translation\s*:\s*", "", text, flags=re.I).strip()
    if len(text) > 1 and text[0] in _QUOTES and text[-1] in _QUOTES and "\n" not in text:
        text = text.strip(_QUOTES).strip()
    return text


def word_count(text: str) -> int:
    return len([w for w in text.split(" ") if w])


def shrink_png(png: bytes, edge: int = IMAGE_EDGE) -> bytes:
    """Scale the drawing down; the marks survive, the request stays small."""
    from PIL import Image

    img = Image.open(io.BytesIO(png))
    if max(img.size) > edge:
        scale = edge / max(img.size)
        img = img.resize((max(1, round(img.width * scale)),
                          max(1, round(img.height * scale))), Image.LANCZOS)
    out = io.BytesIO()
    img.convert("RGB").save(out, format="JPEG", quality=82)
    return out.getvalue()


def build_messages(comment: str, png: bytes | None,
                   english: bool = False) -> list[dict]:
    content: list[dict] = [{"type": "text", "text": comment.strip()}]
    if png:
        url = "data:image/jpeg;base64," + base64.b64encode(shrink_png(png)).decode()
        content.append({"type": "image_url", "image_url": {"url": url}})
    return [{"role": "system",
             "content": SYSTEM_PROMPT_EN if english else SYSTEM_PROMPT_TR},
            {"role": "user", "content": content}]


def api_key(job: str = "summary") -> str | None:
    """The key of the provider this job is set to use (backend/llm.py)."""
    from . import llm
    return llm.key(llm.route(job)[0])


# Notes get written in whatever language comes to hand, while the model
# sources, the card summaries and the rest of this app are English. Turning
# the note into an English request at the door means everything downstream -
# the summary, the model comments, a reader six months from now - reads the
# same way.
TRANSLATE_PROMPT = (
    "Translate the user's CAD revision request into English. Keep it a "
    "request: same instructions, same numbers, same part names, nothing "
    "added and nothing dropped. Keep the wording plain and direct. Keep the "
    "layout: every line, list, heading and Markdown mark (**bold**, `code`, "
    "- items, 1. steps) where it was. If it is already English, return it "
    "unchanged. Write only the translation."
)
# Room for the whole note: a long note in, a long note out. The floor is
# what a short note needs; the ceiling keeps a runaway answer bounded.
TRANSLATE_TOKENS = 400
TRANSLATE_TOKENS_MAX = 4000


async def _post(messages: list[dict], max_tokens: int = MAX_TOKENS, job: str = "summary") -> dict:
    """One call for a job, to whichever provider and model it is set to use
    (Settings > LLM settings, backend/llm.py). The usage that comes back
    says which, so the bill names the right vendor."""
    from . import llm

    if not api_key(job):
        raise RuntimeError(llm.no_key(llm.route(job)[0], job))
    delay = 1.0
    last: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            payload = await llm.complete(messages, job=job, max_tokens=max_tokens,
                                         temperature=TEMPERATURE, reasoning=False, timeout=TIMEOUT)
            payload.setdefault("usage", {})
            payload["usage"] = {**(payload["usage"] or {}), "provider": payload["provider"],
                                "model": payload["model"]}
            return payload
        except Exception as exc:                      # noqa: BLE001 - retry any
            last = exc
            if attempt == RETRIES:
                break
            log.warning("%s attempt %d failed: %s", job, attempt + 1, exc)
            await asyncio.sleep(delay)
            delay *= 2
    raise RuntimeError(f"{job} failed after {RETRIES + 1} tries: {last}")


def _report_usage(payload: dict) -> dict:
    usage = payload.get("usage") or {}
    cost = usage.get("cost")
    log.info("summarise usage: prompt=%s completion=%s total=%s cost=%s USD",
             usage.get("prompt_tokens"), usage.get("completion_tokens"),
             usage.get("total_tokens"), cost)
    if isinstance(cost, (int, float)) and cost > BUDGET_USD:
        log.warning("summarise cost %.5f USD is over the %.5f USD budget",
                    cost, BUDGET_USD)
    return usage


async def summarise(comment: str, png: bytes | None = None,
                    english: bool = False) -> tuple[str, dict]:
    """Return (sentence, usage). Raises if the call cannot be made."""
    messages = build_messages(comment, png, english)
    payload = await _post(messages)
    usage = _report_usage(payload)
    text = clean(payload["choices"][0]["message"]["content"])

    if word_count(text) > MAX_WORDS:
        # One more go; if it is still long, keep it rather than cut a
        # sentence in half.
        log.info("summarise came back with %d words, retrying", word_count(text))
        retry = await _post(messages + [
            {"role": "assistant", "content": text},
            {"role": "user", "content":
                (f"Too long. One sentence, at most {MAX_WORDS} words, "
                 "the summary only.") if english else
                (f"Cok uzun. En fazla {MAX_WORDS} kelimeyle, tek cumle, "
                 "sadece ozet.")}])
        usage = _report_usage(retry)
        shorter = clean(retry["choices"][0]["message"]["content"])
        if shorter:
            text = shorter
    return text, usage


async def translate(text: str) -> tuple[str, dict]:
    """Turn a revision note into English. Returns (text, usage).

    Failure is not fatal anywhere it is called: the original note is kept and
    the card still saves, because a translation service being down is no
    reason to lose what someone just wrote.
    """
    text = (text or "").strip()
    if not text:
        return "", {}
    budget = min(TRANSLATE_TOKENS_MAX, max(TRANSLATE_TOKENS, len(text) // 2 + 200))
    payload = await _post(
        [{"role": "system", "content": TRANSLATE_PROMPT},
         {"role": "user", "content": text}], max_tokens=budget, job="translate")
    usage = _report_usage(payload)
    choice = payload["choices"][0]
    # A translation cut short by the token limit would replace the note with
    # its first half: keep the original instead.
    if choice.get("finish_reason") == "length":
        return text, usage
    out = clean_translation(choice["message"]["content"] or "")
    return (out or text), usage
