"""Telegram: notifications, the agents' questions, and notes and messages
from people's phones (Settings > Telegram).

    core     the settings, the client (python-telegram-bot's Bot), the log
    links    who a chat is: one-time codes, roles, acting as the person
    outbox   the send queue: rate limits, retries with backoff
    fmt      what the bot says
    notify   watches the database for events, closes answered question cards
    inbound  what people send, and what it does
    api      the routes, the webhook among them

`start()` runs three loops beside the API: the send queue, the watcher, and
- when updates come by long polling rather than the webhook - the poller.
"""

from __future__ import annotations

import asyncio
import logging

from . import core

log = logging.getLogger("redline.telegram")

_started = False
POLL_TIMEOUT = 25


async def poll_loop() -> None:
    """Long polling: ask Telegram for updates while the mode says so."""
    from telegram.error import Conflict, InvalidToken, NetworkError, TelegramError
    from . import inbound
    while True:
        try:
            raw = core.raw()
            st = await core.settings(raw)
            b = await core.bot(raw) if st.get("mode") == "polling" else None
            if b is None:
                await asyncio.sleep(3)
                continue
            ups = await b.get_updates(offset=st.get("poll_offset"), timeout=POLL_TIMEOUT,
                                      allowed_updates=core.ALLOWED_UPDATES)
            await core.patch_settings(raw, {"online": {"ok": True, "at": core.now()}})
            for u in ups:
                await inbound.handle(raw, core.to_dict(u))
                await core.patch_settings(raw, {"poll_offset": u.update_id + 1})
        except Conflict as exc:
            await core.remember_error(core.raw(), f"another process takes this bot's updates ({exc})", "polling")
            await asyncio.sleep(15)
        except InvalidToken as exc:
            await core.remember_error(core.raw(), str(exc), "polling")
            await asyncio.sleep(60)
        except (NetworkError, TelegramError) as exc:
            log.info("telegram polling: %s", core.redact(exc))
            await asyncio.sleep(5)
        except Exception as exc:                          # noqa: BLE001
            log.warning("telegram polling: %s", core.redact(exc))
            await asyncio.sleep(10)


async def _boot() -> None:
    from . import notify, outbox
    try:
        await core.ensure_indexes(core.raw())
    except Exception as exc:                              # noqa: BLE001 - it still works, only untidier
        log.warning("telegram indexes not made: %s", exc)
    asyncio.create_task(outbox.loop())
    asyncio.create_task(notify.loop())
    asyncio.create_task(poll_loop())


def start(raw_getter) -> None:
    """Called once at the API's start-up with a getter for the raw database."""
    global _started
    core.bind(raw_getter)
    if _started:
        return
    _started = True
    asyncio.create_task(_boot())
