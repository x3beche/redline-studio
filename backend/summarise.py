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

log = logging.getLogger("x3.summarise")

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "deepseek/deepseek-v4.1-flash"
TIMEOUT = 15.0
MAX_TOKENS = 60
TEMPERATURE = 0.2
RETRIES = 2                 # on top of the first try
MAX_WORDS = 12              # over this, ask once more
IMAGE_EDGE = 512            # long edge sent to the model
BUDGET_USD = 0.005          # per request; expected around 0.0002

# Kept byte-identical on every request so the provider can cache the prefix.
SYSTEM_PROMPT = (
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


def build_messages(comment: str, png: bytes | None) -> list[dict]:
    content: list[dict] = [{"type": "text", "text": comment.strip()}]
    if png:
        url = "data:image/jpeg;base64," + base64.b64encode(shrink_png(png)).decode()
        content.append({"type": "image_url", "image_url": {"url": url}})
    return [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content}]


def api_key() -> str | None:
    return os.environ.get("OPENROUTER_API_KEY") or None


# Notes get written in whatever language comes to hand, while the model
# sources, the card summaries and the rest of this app are English. Turning
# the note into an English request at the door means everything downstream -
# the summary, the model comments, a reader six months from now - reads the
# same way.
TRANSLATE_PROMPT = (
    "Translate the user's CAD revision request into English. Keep it a "
    "request: same instructions, same numbers, same part names, nothing "
    "added and nothing dropped. Keep the wording plain and direct. If it is "
    "already English, return it unchanged. Write only the translation."
)
TRANSLATE_TOKENS = 400


async def _post(messages: list[dict], max_tokens: int = MAX_TOKENS) -> dict:
    import httpx

    key = api_key()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens,
            "temperature": TEMPERATURE, "reasoning": {"enabled": False},
            "usage": {"include": True}}
    delay = 1.0
    last: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                r = await client.post(
                    ENDPOINT, json=body,
                    headers={"Authorization": f"Bearer {key}",
                             "Content-Type": "application/json"})
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
            r.raise_for_status()
            return r.json()
        except Exception as exc:                      # noqa: BLE001 - retry any
            last = exc
            if attempt == RETRIES:
                break
            log.warning("summarise attempt %d failed: %s", attempt + 1, exc)
            await asyncio.sleep(delay)
            delay *= 2
    raise RuntimeError(f"summarise failed after {RETRIES + 1} tries: {last}")


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


async def summarise(comment: str, png: bytes | None = None) -> tuple[str, dict]:
    """Return (sentence, usage). Raises if the call cannot be made."""
    messages = build_messages(comment, png)
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
                f"Cok uzun. En fazla {MAX_WORDS} kelimeyle, tek cumle, "
                "sadece ozet."}])
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
    payload = await _post(
        [{"role": "system", "content": TRANSLATE_PROMPT},
         {"role": "user", "content": text}], max_tokens=TRANSLATE_TOKENS)
    usage = _report_usage(payload)
    out = clean(payload["choices"][0]["message"]["content"] or "")
    return (out or text), usage
