"""Rate limits kept in the database, so they hold across API reloads (every
backend save restarts the API under --reload) and are one count for every
process that serves the site.

A limit is "at most `limit` events per key in a window of `window_s`
seconds", counted in fixed windows: one document per scope, key and window
start in the collection `rate_limits`, raised with an atomic $inc upsert.
Its `expires` (the window's end) carries a TTL index, so the counts clean
themselves up. A fixed window lets a burst of up to twice the limit through
around a window's edge; for these limits (shared links, the public APK) that
is fine, and it costs one write per event.

    allowed, retry_after = await hit(db, "share-hits", address, 300, 60)

When the database cannot be reached the limit does not shut the site: the
count falls back to this process's memory (as the limits were before) and a
warning is logged, at most once a minute.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

COLL = "rate_limits"
# How long a count may take before it is given up for the memory fallback.
TIMEOUT = 2.0

log = logging.getLogger("uvicorn.error")
_indexed = False
_warned = 0.0
# The fallback: _id -> count, for windows of this process only.
_local: dict[str, int] = {}


def _window(window_s: float, t: float) -> tuple[float, float]:
    start = math.floor(t / window_s) * window_s
    return start, start + window_s


def _id(scope: str, key: str, start: float) -> str:
    return f"{scope}|{key}|{int(start)}"


def _retry(end: float, t: float) -> int:
    return max(1, math.ceil(end - t))


def _at(t: float) -> datetime:
    return datetime.fromtimestamp(t, timezone.utc)


async def ensure_index(db) -> None:
    """The TTL index that forgets a window once it is over."""
    global _indexed
    if not _indexed:
        await db[COLL].create_index("expires", expireAfterSeconds=0)
        _indexed = True


def _failed(exc: BaseException) -> None:
    global _warned
    t = time.monotonic()
    if t - _warned >= 60:
        _warned = t
        log.warning("rate limits: the database did not answer (%s) - counting in memory",
                    type(exc).__name__)


def _local_hit(doc_id: str, end: float, t: float) -> int:
    if len(_local) > 20000:                          # a flood of keys: forget the windows that are over
        for k in [k for k in _local if float(k.rsplit("|", 1)[1]) + 3600 * 24 < t]:
            _local.pop(k, None)
    _local[doc_id] = _local.get(doc_id, 0) + 1
    return _local[doc_id]


async def _inc(db, doc_id: str, scope: str, key: str, start: float, end: float) -> int:
    await ensure_index(db)
    coll = db[COLL]
    for again in (True, False):
        try:
            doc = await coll.find_one_and_update(
                {"_id": doc_id},
                {"$inc": {"count": 1},
                 "$setOnInsert": {"scope": scope, "key": key, "start": _at(start), "expires": _at(end)}},
                upsert=True, return_document=ReturnDocument.AFTER)
            return int((doc or {}).get("count") or 1)
        except DuplicateKeyError:                    # two first hits at once: the other made it
            if not again:
                raise
    return 1


async def hit(db, scope: str, key: str, limit: int, window_s: float) -> tuple[bool, int]:
    """Count one event; (allowed, retry_after seconds). Not allowed once the
    key had already reached `limit` in this window."""
    t = time.time()
    start, end = _window(window_s, t)
    doc_id = _id(scope, key, start)
    try:
        n = await asyncio.wait_for(_inc(db, doc_id, scope, key, start, end), TIMEOUT)
    except Exception as exc:                         # noqa: BLE001 - never shut the site over a count
        _failed(exc)
        n = _local_hit(doc_id, end, t)
    return n <= limit, (0 if n <= limit else _retry(end, t))


async def full(db, scope: str, key: str, limit: int, window_s: float) -> tuple[bool, int]:
    """Whether the key is at its limit now, without counting; (full, retry_after)."""
    t = time.time()
    start, end = _window(window_s, t)
    doc_id = _id(scope, key, start)
    try:
        doc = await asyncio.wait_for(db[COLL].find_one({"_id": doc_id}), TIMEOUT)
        n = int((doc or {}).get("count") or 0)
    except Exception as exc:                         # noqa: BLE001
        _failed(exc)
        n = _local.get(doc_id, 0)
    return n >= limit, (_retry(end, t) if n >= limit else 0)


class Window:
    """One named limit: at most `limit` events per key in `seconds`."""

    def __init__(self, scope: str, limit: int, seconds: float):
        self.scope, self.limit, self.seconds = scope, limit, seconds

    async def hit(self, db, key: str) -> tuple[bool, int]:
        return await hit(db, self.scope, key, self.limit, self.seconds)

    async def full(self, db, key: str) -> tuple[bool, int]:
        return await full(db, self.scope, key, self.limit, self.seconds)

    def clear(self) -> None:
        """Forget this limit's fallback counts (the database's stay)."""
        for k in [k for k in _local if k.startswith(self.scope + "|")]:
            _local.pop(k, None)
