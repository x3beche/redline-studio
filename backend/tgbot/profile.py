"""The bot's profile, set from Settings > Telegram instead of @BotFather:
its name, description (what people read before they press Start), short
description (the "about" line on its profile), picture and command menu.

Per language: the default, which everyone sees whose Telegram language has
no text of its own, and any ISO 639-1 language (languages.py). Telegram has
no call that lists the languages a bot has text in, and asking all 184
three times each is not a page load, so the languages written from here are
kept (`profile_langs` in the settings) and read back live with the default.

Read back live from Telegram (getMyName, getMyDescription,
getMyShortDescription, getMyCommands, and the bot's own profile photos),
so the page can tell what is saved on Telegram from what was only typed.
Saving sends only the fields that changed and says how each one went.

Redline's own defaults come with it - the name "Redline", a description and a
short description in English and Turkish, and a picture: the app's mark,
640×640 (default-avatar.png, drawn from frontend/public/favicon.svg).
A new language can be translated from the default by the Reading
translation job (backend/reading.py, llm.py's cheap default model).

The picture: setMyProfilePhoto takes a static JPG. Whatever is uploaded
is cut to a centred square, scaled to 640×640 (at least 160 px a side is
needed) and saved as a JPG, so any common picture works.
"""

from __future__ import annotations

import io
from pathlib import Path

from . import core, languages

FIELDS = ("name", "description", "short_description")
LIMITS = {"name": 64, "description": 512, "short_description": 120}
MIN_SIDE = 160
SIDE = 640
MAX_UPLOAD = 10 * 1024 * 1024
DEFAULT_PHOTO = Path(__file__).with_name("default-avatar.png")

# Redline's words for its bot, in the languages the app itself speaks.
DEFAULTS = {
    "default": {
        "name": "Redline",
        "description": ("Redline's bot. Linked people get the agents' questions with answer buttons, "
                        "applied and failed notes with their pictures, and the other updates they choose. "
                        "Send /note (or a photo with a caption) to leave a note on a model or board, "
                        "or /ask to write to the agent.\n\n"
                        "To link this chat: Redline → Settings → Telegram → Link my Telegram."),
        "short_description": "The agents' questions, your notes' results, and notes from your phone - for Redline.",
    },
    "tr": {
        "name": "Redline",
        "description": ("Redline'ın botu. Bağlı kişilere ajanların soruları yanıt düğmeleriyle, uygulanan ve "
                        "başarısız notlar resimleriyle ve seçtikleri diğer güncellemeler gelir. Bir model ya da "
                        "karta not bırakmak için /note (ya da açıklamalı bir fotoğraf), ajana yazmak için /ask "
                        "gönderin.\n\n"
                        "Bu sohbeti bağlamak için: Redline → Ayarlar → Telegram → Telegram'ımı bağla."),
        "short_description": "Ajanların soruları, notlarınızın sonuçları ve telefonunuzdan notlar - Redline için.",
    },
}

# The command menu, per language: set when the token is saved.
COMMANDS = {
    "": [("note", "a draft note on a model or board"), ("queue", "queue the last draft note"),
         ("ask", "write to the agent's thread"), ("status", "what is working now"),
         ("lang", "the language questions come in"), ("help", "what the bot can do"),
         ("stop", "unlink this chat")],
    "tr": [("note", "bir model ya da karta taslak not"), ("queue", "son taslak notu sıraya al"),
           ("ask", "ajanın konuşmasına yaz"), ("status", "şu an ne çalışıyor"),
           ("lang", "soruların geleceği dil"), ("help", "bot neler yapabilir"),
           ("stop", "bu sohbetin bağlantısını kaldır")],
}


def code_of(lang: str | None) -> str | None:
    """"default" (or nothing) is None - Telegram's "no language"; anything
    else has to be an ISO 639-1 code."""
    lang = (lang or "").strip().lower()
    if lang in ("", "default"):
        return None
    if not languages.known(lang):
        raise ValueError("language: default, or an ISO 639-1 code like tr, de or ja")
    return lang


def _text(v, attr: str) -> str:
    if v is None:
        return ""
    if isinstance(v, dict):
        return v.get(attr) or ""
    return getattr(v, attr, "") or ""


async def set_commands(b) -> dict:
    from telegram import BotCommand
    out = {}
    for lang, cmds in COMMANDS.items():
        try:
            await b.set_my_commands([BotCommand(c, a) for c, a in cmds], language_code=lang or None)
            out[lang] = True
        except Exception as exc:                              # noqa: BLE001
            out[lang] = core.redact(exc)[:200]
    return out


async def read_one(b, lc: str | None) -> dict:
    return {
        "name": _text(await b.get_my_name(language_code=lc), "name"),
        "description": _text(await b.get_my_description(language_code=lc), "description"),
        "short_description": _text(await b.get_my_short_description(language_code=lc), "short_description"),
        "commands": [{"command": getattr(c, "command", None) or c["command"],
                      "about": getattr(c, "description", None) or c["description"]}
                     for c in (await b.get_my_commands(language_code=lc) or [])],
    }


async def read(b, langs: list[str] | None = None) -> dict:
    """What Telegram has now: the default and each language asked for."""
    out = {"default": await read_one(b, None)}
    for lang in langs or []:
        lc = code_of(lang)
        if lc and lc not in out:
            out[lc] = await read_one(b, lc)
    return out


async def save(b, lang: str, fields: dict) -> dict:
    """Send the fields given (and only those). {field: {"ok": bool, "error"?}}."""
    from telegram.error import TelegramError
    lc = code_of(lang)
    calls = {"name": b.set_my_name, "description": b.set_my_description,
             "short_description": b.set_my_short_description}
    out = {}
    for f, v in fields.items():
        if f not in calls or v is None:
            continue
        v = v.strip()
        if len(v) > LIMITS[f]:
            out[f] = {"ok": False, "error": f"at most {LIMITS[f]} characters"}
            continue
        try:
            # An empty text takes the language's own text away (the default shows).
            await calls[f](v, language_code=lc)
            out[f] = {"ok": True}
        except TelegramError as exc:
            out[f] = {"ok": False, "error": core.redact(exc)[:200]}
    return out


def fit(text: str, limit: int) -> tuple[str, bool]:
    """A translation that came out too long, cut at a word: (text, cut?)."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text, False
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,.;:-")
    return cut + "…", True


async def translate(db, lang: str, source: dict) -> dict:
    """The default's fields in `lang`, by the Reading translation job. The
    name is a name: it stays as it is. {fields, cut, provider, model}."""
    from .. import reading
    lc = code_of(lang)
    if not lc:
        raise ValueError("pick a language to translate into")
    reading._check_key()
    name = languages.english(lc)
    fields, cut, via = {}, {}, {}
    for f in FIELDS:
        text = (source.get(f) or "").strip()
        if not text or f == "name":
            fields[f] = text
            continue
        out, via = await reading.one(db, text, name, "reading:bot-profile")
        fields[f], cut[f] = fit(out, LIMITS[f])
    return {"lang": lc, "fields": fields, "cut": cut, **via}


def square_jpeg(data: bytes) -> bytes:
    """Any picture as the square JPG a bot's profile photo has to be."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    if len(data) > MAX_UPLOAD:
        raise ValueError("the picture is over 10 MB")
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("that is not a picture (PNG, JPG, WebP or GIF)") from exc
    side = min(im.size)
    if side < MIN_SIDE:
        raise ValueError(f"the picture is too small - at least {MIN_SIDE}×{MIN_SIDE} pixels")
    left, top = (im.width - side) // 2, (im.height - side) // 2
    im = im.crop((left, top, left + side, top + side)).resize((min(SIDE, side),) * 2, Image.LANCZOS)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    out = io.BytesIO()
    im.convert("RGB").save(out, "JPEG", quality=90)
    return out.getvalue()


async def set_photo(b, data: bytes) -> bytes:
    from telegram import InputProfilePhotoStatic
    jpg = square_jpeg(data)
    await b.set_my_profile_photo(InputProfilePhotoStatic(jpg))
    return jpg
