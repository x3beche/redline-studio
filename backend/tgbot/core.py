"""The Telegram bot's settings, its client, its log, and what everything
else in this package shares.

One bot for the whole server, like the LLM keys (backend/llm.py): its
token is typed in Settings > Telegram and kept in the `telegram_settings`
document and only there - never read from .env or the environment, never
sent to a browser (the page learns whether one is set and its last four
characters), never logged. Every line this package logs, and every error
it keeps, goes through `redact()` first, and the HTTP client's own loggers
get a filter that does the same: a Bot API URL carries the token.

The client is python-telegram-bot's `Bot` (async, httpx underneath): the
Bot API's methods, its types, its errors (RetryAfter, Forbidden, ...) and
its helpers, without us writing any of them. The updates themselves come
in through our own route (webhook) or our own loop (long polling), and
are handled by inbound.py - plain functions, easy to test with a fake bot.
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

log = logging.getLogger("redline.telegram")

# Machine-wide collections: the bot is the server's, people link across it.
SETTINGS = "telegram_settings"
DOC_ID = "bot"
LINKS = "telegram_links"          # _id: the app user's id
CODES = "telegram_codes"          # one-time link codes, kept as their SHA-256
LOG = "telegram_log"              # what went out and came in, for 30 days
OUTBOX = "telegram_outbox"        # the send queue
MSGS = "telegram_msgs"            # messages we may edit later (questions, prompts)
PENDING = "telegram_pending"      # a message waiting for "note / ask / ignore"
EVENTS = "telegram_events"        # what has been announced, so nothing is twice
TRIES = "telegram_tries"          # wrong link codes, per chat, for 15 minutes

LOG_DAYS = 30
EVENT_DAYS = 14
PENDING_HOURS = 24
CODE_MINUTES = 10
TRY_LIMIT, TRY_MINUTES = 5, 15        # wrong codes a chat may send in that time

WEBHOOK_PATH = "/api/telegram/webhook"
SECRET_HEADER = "x-telegram-bot-api-secret-token"
ALLOWED_UPDATES = ["message", "callback_query"]

# A bot token: "<bot id>:<35 characters>". Anything that looks like one is
# rubbed out of every log line and every kept error.
_TOKEN_RE = re.compile(r"\d{5,}:[A-Za-z0-9_-]{30,}")
TOKEN_SHAPE = re.compile(r"^\d{5,}:[A-Za-z0-9_-]{30,}$")


def redact(text: Any) -> str:
    return _TOKEN_RE.sub("<bot-token>", str(text))


class _Redact(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:                               # noqa: BLE001
            return True
        if _TOKEN_RE.search(msg):
            record.msg, record.args = redact(msg), ()
        return True


for _name in ("httpx", "httpcore", "telegram", "telegram.Bot", "telegram.ext", "telegram.request",
              "redline.telegram"):
    logging.getLogger(_name).addFilter(_Redact())


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or now()).isoformat()


def aware(v) -> datetime | None:
    """A datetime from what Mongo hands back (naive UTC) or an ISO string."""
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def esc(text: Any) -> str:
    """Text for a message sent with parse_mode=HTML."""
    return html.escape(str(text if text is not None else ""), quote=False)


def clip(text: str | None, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


# ---------------- the database ----------------

_raw_getter: Callable[[], Any] | None = None


def bind(raw_getter: Callable[[], Any]) -> None:
    """Where the database is: main.py hands a getter for the raw database."""
    global _raw_getter
    _raw_getter = raw_getter


def raw():
    if _raw_getter is None:
        raise RuntimeError("the Telegram bot has no database bound")
    return _raw_getter()


def raw_of(db):
    return db.raw if getattr(type(db), "SCOPED", False) else db


async def ensure_indexes(db) -> None:
    db = raw_of(db)
    await db[LOG].create_index("at", expireAfterSeconds=LOG_DAYS * 86400)
    await db[EVENTS].create_index("at", expireAfterSeconds=EVENT_DAYS * 86400)
    await db[CODES].create_index("expires", expireAfterSeconds=0)
    await db[PENDING].create_index("at", expireAfterSeconds=PENDING_HOURS * 3600)
    await db[OUTBOX].create_index("done_at", expireAfterSeconds=7 * 86400)
    await db[OUTBOX].create_index([("status", 1), ("due", 1)])
    await db[MSGS].create_index([("chat", 1), ("message_id", 1)])
    await db[MSGS].create_index([("kind", 1), ("state", 1)])
    await db[LINKS].create_index("chat")
    await db[TRIES].create_index("at", expireAfterSeconds=TRY_MINUTES * 60)


# ---------------- the settings ----------------

async def settings(db=None) -> dict:
    db = raw_of(db) if db is not None else raw()
    return await db[SETTINGS].find_one({"_id": DOC_ID}) or {"_id": DOC_ID}


async def patch_settings(db, fields: dict, unset: list[str] | None = None) -> None:
    db = raw_of(db)
    upd: dict = {"$set": fields} if fields else {}
    if unset:
        upd["$unset"] = {k: "" for k in unset}
    if upd:
        await db[SETTINGS].update_one({"_id": DOC_ID}, upd, upsert=True)


async def remember_error(db, text: str, where: str = "") -> None:
    """The last thing that went wrong, for the "last error" tile - redacted."""
    msg = redact(f"{where}: {text}" if where else text)[:500]
    log.warning("telegram: %s", msg)
    await patch_settings(db, {"last_error": {"at": now(), "text": msg}})


def token_of(doc: dict) -> str | None:
    return (doc.get("token") or "").strip() or None


def hint(token: str | None) -> str | None:
    return ("…" + token[-4:]) if token else None


def new_secret() -> str:
    """A webhook secret: 1-256 of A-Z a-z 0-9 _ - (the Bot API's rule)."""
    return secrets.token_urlsafe(36)


def webhook_url(public_url: str | None) -> str | None:
    base = (public_url or "").strip().rstrip("/")
    return base + WEBHOOK_PATH if base else None


# ---------------- the client ----------------

def make_bot(token: str):
    """python-telegram-bot's Bot. Tests replace this with a fake."""
    from telegram import Bot
    from telegram.request import HTTPXRequest
    return Bot(token,
               request=HTTPXRequest(connection_pool_size=8, read_timeout=20, write_timeout=30,
                                    connect_timeout=10),
               get_updates_request=HTTPXRequest(read_timeout=40, connect_timeout=10))


_bot: Any = None
_bot_key: str | None = None


async def bot(db=None):
    """The bot for the saved token, or None with no token."""
    global _bot, _bot_key
    token = token_of(await settings(db))
    if not token:
        await drop_bot()
        return None
    key = digest(token)
    if _bot is None or _bot_key != key:
        await drop_bot()
        _bot, _bot_key = make_bot(token), key
    return _bot


async def drop_bot() -> None:
    global _bot, _bot_key
    b, _bot, _bot_key = _bot, None, None
    if b is not None and hasattr(b, "shutdown"):
        try:
            await b.shutdown()
        except Exception:                               # noqa: BLE001
            pass


def to_dict(obj) -> dict:
    """A Bot API object as a plain dict (PTB objects have to_dict)."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    return obj.to_dict() if hasattr(obj, "to_dict") else dict(vars(obj))


# ---------------- the log ----------------

async def journal(db, direction: str, kind: str, *, chat=None, user: str | None = None,
                  ok: bool = True, error: str | None = None, preview: str | None = None,
                  workspace: str | None = None) -> None:
    """One row of telegram_log. Never raises."""
    try:
        await raw_of(db)[LOG].insert_one({
            "at": now(), "dir": direction, "kind": kind, "chat": chat, "user": user, "ok": ok,
            "error": redact(error)[:300] if error else None,
            "preview": clip(re.sub(r"<[^>]+>", "", preview or ""), 140) or None,
            "workspace": workspace})
    except Exception:                                   # noqa: BLE001
        pass


async def counts(db, days: int = 7) -> dict:
    db = raw_of(db)
    since = now() - timedelta(days=days)
    sent = await db[LOG].count_documents({"dir": "out", "ok": True, "at": {"$gte": since}})
    failed = await db[LOG].count_documents({"dir": "out", "ok": False, "at": {"$gte": since}})
    got = await db[LOG].count_documents({"dir": "in", "at": {"$gte": since}})
    return {"sent": sent, "failed": failed, "received": got, "days": days}
