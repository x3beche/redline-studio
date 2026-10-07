"""The send queue: every message the bot sends goes through here.

A message is a row in `telegram_outbox` first and a Bot API call second, so
a reload of the server (uvicorn --reload restarts it on every save) loses
nothing, and Telegram's limits are kept in one place:

- about 30 messages a second for the whole bot - we keep to 25;
- about one a second to any one chat - we keep to one per 1.05 s;
- "429 Too Many Requests, retry after N" (RetryAfter) - the row waits N
  seconds, and so does every other row: the limit is the bot's;
- a network error or a timeout - tried again later, 2 s, 4 s, 8 s ... up
  to ten minutes apart, six times, then given up and logged;
- the person blocked the bot (Forbidden) - their link is marked blocked
  and nothing more is sent to them until they write to the bot again;
- a bad request is not retried: it would fail the same way.

What was sent, and what failed, goes into `telegram_log` (core.journal).
Rows that are done are dropped after a week (a TTL index on done_at).
"""

from __future__ import annotations

import asyncio
import io
import logging
import random
import time
import uuid

from .. import scope, store
from . import core

log = logging.getLogger("redline.telegram")

GLOBAL_GAP = 1 / 25
CHAT_GAP = 1.05
MAX_ATTEMPTS = 6
MAX_FLOODS = 10
LEASE_S = 120
CAPTION_MAX = 1024
TEXT_MAX = 4096

_wake = asyncio.Event()
_last_any = 0.0
_last_chat: dict = {}
_paused_until = 0.0


def backoff(attempts: int) -> float:
    """Seconds to wait before try number `attempts + 1`."""
    return min(600.0, 2.0 * (2 ** max(0, attempts - 1))) + random.uniform(0, 0.5)


async def enqueue(db, chat, *, text: str, kind: str, user: str | None = None, ws: str | None = None,
                  markup: dict | None = None, photo: dict | None = None, track: dict | None = None,
                  op: str = "send", message_id: int | None = None, is_photo: bool = False) -> str:
    """Put one message in the queue; it goes out within a second or so.

    `markup` is the Bot API's own JSON (inline_keyboard / force_reply), so
    the row can wait in the database. `photo` names where the picture is:
    {"revision": id, "which": "after"|"before"} or {"test": True}. `track`
    says what to remember about the message once it is sent (a question's
    message, to edit when it is answered). `op` "edit" changes a message
    already sent (`message_id`; `is_photo` when its text is a caption)."""
    job = {"_id": uuid.uuid4().hex, "at": core.now(), "due": core.now(), "status": "pending",
           "attempts": 0, "floods": 0, "op": op, "chat": chat, "user": user, "ws": ws, "kind": kind,
           "text": text, "markup": markup, "photo": photo, "track": track,
           "message_id": message_id, "is_photo": is_photo}
    await core.raw_of(db)[core.OUTBOX].insert_one(job)
    _wake.set()
    return job["_id"]


def ptb_markup(markup: dict | None):
    """The stored JSON as python-telegram-bot's markup objects."""
    if not markup:
        return None
    from telegram import ForceReply, InlineKeyboardButton, InlineKeyboardMarkup
    if markup.get("force_reply"):
        return ForceReply(selective=True, input_field_placeholder=markup.get("input_field_placeholder"))
    rows = markup.get("inline_keyboard") or []
    return InlineKeyboardMarkup([[InlineKeyboardButton(**b) for b in row] for row in rows])


async def photo_bytes(job: dict) -> bytes | None:
    p = job.get("photo") or {}
    if p.get("test"):
        return test_picture()
    if p.get("revision"):
        sdb = scope.ScopedDb(core.raw(), job.get("ws") or scope.DEFAULT)
        doc = await sdb.revisions.find_one({"_id": p["revision"]}) or {}
        key = "image_after" if p.get("which") == "after" else "image"
        img = doc.get(key) or (doc.get("image") if key == "image_after" else None)
        if img and img.get("gridfs_id") is not None:
            return await store.get_shot(sdb, img["gridfs_id"])
    return None


def test_picture() -> bytes:
    """A small picture for the test message, so sendPhoto is tried too.
    Drawn here: an image is pigment, not chrome."""
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (480, 240), (24, 28, 34))
    d = ImageDraw.Draw(im)
    d.rectangle((16, 16, 463, 223), outline=(226, 61, 61), width=4)
    d.line((60, 170, 200, 80, 300, 150, 420, 60), fill=(226, 61, 61), width=6)
    d.text((32, 196), "Redline - test picture", fill=(220, 224, 230))
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


async def _pace(chat) -> None:
    global _last_any
    while True:
        t = time.monotonic()
        wait = max(_paused_until - t, _last_any + GLOBAL_GAP - t,
                   _last_chat.get(chat, 0.0) + CHAT_GAP - t)
        if wait <= 0:
            break
        await asyncio.sleep(min(wait, 5.0))
    _last_any = _last_chat[chat] = time.monotonic()


async def call(bot, job: dict):
    """The Bot API call for one row. Returns the Message (or True for an edit)."""
    from telegram.constants import ParseMode
    from telegram import LinkPreviewOptions
    markup = ptb_markup(job.get("markup"))
    text = job.get("text") or ""
    if job["op"] == "markup":
        return await bot.edit_message_reply_markup(chat_id=job["chat"], message_id=job["message_id"],
                                                   reply_markup=markup)
    if job["op"] == "edit":
        if job.get("is_photo"):
            return await bot.edit_message_caption(chat_id=job["chat"], message_id=job["message_id"],
                                                  caption=text[:CAPTION_MAX], parse_mode=ParseMode.HTML,
                                                  reply_markup=markup)
        return await bot.edit_message_text(text=text[:TEXT_MAX], chat_id=job["chat"],
                                           message_id=job["message_id"], parse_mode=ParseMode.HTML,
                                           reply_markup=markup,
                                           link_preview_options=LinkPreviewOptions(is_disabled=True))
    if job.get("photo"):
        png = await photo_bytes(job)
        if png and len(text) <= CAPTION_MAX:
            return await bot.send_photo(chat_id=job["chat"], photo=png, caption=text or None,
                                        parse_mode=ParseMode.HTML, reply_markup=markup,
                                        filename="redline.png")
    return await bot.send_message(chat_id=job["chat"], text=text[:TEXT_MAX], parse_mode=ParseMode.HTML,
                                  reply_markup=markup,
                                  link_preview_options=LinkPreviewOptions(is_disabled=True))


async def _done(db, job: dict, msg) -> None:
    raw = core.raw_of(db)
    mid = getattr(msg, "message_id", None)
    was_photo = bool(getattr(msg, "photo", None))
    await raw[core.OUTBOX].update_one({"_id": job["_id"]}, {"$set": {
        "status": "sent", "done_at": core.now(), "sent_message_id": mid}})
    await core.journal(raw, "out", job.get("kind") or job["op"], chat=job["chat"], user=job.get("user"),
                       preview=job.get("text"), workspace=job.get("ws"))
    track = job.get("track")
    if track and mid is not None:
        await raw[core.MSGS].insert_one({
            "_id": uuid.uuid4().hex, "at": core.now(), **track, "chat": job["chat"], "message_id": mid,
            "user": job.get("user"), "ws": job.get("ws"), "photo": was_photo, "state": "open",
            "text": job.get("text")})


async def _failed(db, job: dict, error: str, *, retry_in: float | None = None,
                  flood: bool = False) -> None:
    raw = core.raw_of(db)
    attempts = job.get("attempts", 0) + (0 if flood else 1)
    floods = job.get("floods", 0) + (1 if flood else 0)
    give_up = retry_in is None or attempts >= MAX_ATTEMPTS or floods >= MAX_FLOODS
    patch = {"attempts": attempts, "floods": floods, "error": core.redact(error)[:300]}
    if give_up:
        patch.update(status="failed", done_at=core.now())
        await core.journal(raw, "out", job.get("kind") or job["op"], chat=job["chat"], user=job.get("user"),
                           ok=False, error=error, preview=job.get("text"), workspace=job.get("ws"))
        await core.remember_error(raw, error, "sending")
    else:
        patch.update(status="pending", due=core.now() + _td(retry_in))
    await raw[core.OUTBOX].update_one({"_id": job["_id"]}, {"$set": patch})


def _td(seconds: float):
    from datetime import timedelta
    return timedelta(seconds=seconds)


def _secs(v) -> float:
    return v.total_seconds() if hasattr(v, "total_seconds") else float(v or 1)


async def send_one(db, bot, job: dict) -> bool:
    """Try one row once. True if it went."""
    global _paused_until
    from telegram.error import BadRequest, Forbidden, InvalidToken, NetworkError, RetryAfter, TelegramError
    await _pace(job["chat"])
    try:
        msg = await call(bot, job)
    except RetryAfter as exc:
        wait = _secs(exc.retry_after) + 0.5
        _paused_until = time.monotonic() + wait
        await _failed(db, job, str(exc), retry_in=wait, flood=True)
        return False
    except Forbidden as exc:
        # Blocked by the person, or the chat is gone: stop writing to it.
        await core.raw_of(db)[core.LINKS].update_one({"chat": job["chat"]}, {"$set": {"blocked": True}})
        await _failed(db, job, f"forbidden: {exc}")
        return False
    except InvalidToken as exc:
        await _failed(db, job, f"the token was refused: {exc}")
        return False
    except BadRequest as exc:
        text = str(exc).lower()
        if job["op"] in ("edit", "markup") and ("not modified" in text or "not found" in text
                                    or "can't be edited" in text):
            await _done(db, job, None)          # nothing left to change
            return True
        await _failed(db, job, f"bad request: {exc}")
        return False
    except NetworkError as exc:                  # TimedOut included
        await _failed(db, job, f"network: {exc}", retry_in=backoff(job.get("attempts", 0) + 1))
        return False
    except TelegramError as exc:
        await _failed(db, job, str(exc), retry_in=backoff(job.get("attempts", 0) + 1))
        return False
    except Exception as exc:                      # noqa: BLE001 - e.g. the picture would not load
        await _failed(db, job, f"{type(exc).__name__}: {exc}", retry_in=backoff(job.get("attempts", 0) + 1))
        return False
    await _done(db, job, msg)
    return True


async def drain(db, limit: int = 200) -> int:
    """Send what is due. Returns how many went."""
    raw = core.raw_of(db)
    b = await core.bot(raw)
    if b is None:
        return 0
    stale = core.now() - _td(LEASE_S)
    await raw[core.OUTBOX].update_many({"status": "sending", "lease": {"$lt": stale}},
                                       {"$set": {"status": "pending"}})
    sent = 0
    for _ in range(limit):
        job = await raw[core.OUTBOX].find_one_and_update(
            {"status": "pending", "due": {"$lte": core.now()}},
            {"$set": {"status": "sending", "lease": core.now()}},
            sort=[("due", 1)], return_document=True)
        if not job:
            break
        if await send_one(raw, b, job):
            sent += 1
    return sent


async def loop() -> None:
    while True:
        try:
            await drain(core.raw())
        except Exception as exc:                      # noqa: BLE001 - try again in a second
            log.warning("telegram outbox: %s", core.redact(exc))
        try:
            await asyncio.wait_for(_wake.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass
        _wake.clear()


async def clear(db) -> None:
    """The token went: what was waiting will not go."""
    await core.raw_of(db)[core.OUTBOX].update_many(
        {"status": {"$in": ["pending", "sending"]}},
        {"$set": {"status": "failed", "error": "the bot was removed", "done_at": core.now()}})
