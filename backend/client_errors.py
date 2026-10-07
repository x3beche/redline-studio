"""What went wrong in a browser, told to the server.

An error in the page - a template that throws, a promise nobody caught -
shows only in that browser's console, so a panel that comes up half drawn
on someone's screen looks fine everywhere else and leaves nothing to go on.
The page's ErrorHandler (frontend/src/app/error-report.ts) sends each one
here: kept two weeks in `client_errors`, and logged, so the API's log says
what broke, where and for whom.

Only what the error says and where: its message and stack, the page's
address, the browser - capped in size and in how many a session may send.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/client-errors")
log = logging.getLogger("redline.client")
COLLECTION = "client_errors"
KEEP_DAYS = 14
PER_MINUTE = 30
_recent: dict[str, deque] = defaultdict(deque)
_indexed = False


def _raw():
    from .main import _raw_db
    return _raw_db()


class ClientError(BaseModel):
    message: str = Field(default="", max_length=4000)
    stack: str = Field(default="", max_length=16000)
    url: str = Field(default="", max_length=1000)
    agent: str = Field(default="", max_length=400)
    kind: str = Field(default="error", max_length=40)


def _allowed(who: str) -> bool:
    now = time.monotonic()
    q = _recent[who]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= PER_MINUTE:
        return False
    q.append(now)
    return True


@router.post("")
async def report(body: ClientError) -> dict:
    from . import actors
    global _indexed
    who = actors.current()
    key = f"{who.get('type')}:{who.get('id')}"
    if not _allowed(key):
        return {"kept": False}
    raw = _raw()
    if not _indexed:
        await raw[COLLECTION].create_index("at", expireAfterSeconds=KEEP_DAYS * 86400)
        _indexed = True
    doc = {"at": datetime.now(timezone.utc), "by": {"type": who.get("type"), "id": who.get("id"),
                                                     "name": who.get("name")},
           "kind": body.kind, "message": body.message[:4000], "stack": body.stack[:16000],
           "url": body.url[:1000], "agent": body.agent[:400]}
    await raw[COLLECTION].insert_one(doc)
    first = (body.message or "").splitlines()[0][:300] if body.message else "?"
    log.warning("browser error (%s, %s): %s", who.get("name") or who.get("id"), body.url[:120], first)
    return {"kept": True}


async def recent(hours: int = 24) -> list[dict]:
    """The latest, newest first - for an admin, or the agent reading the log."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    out = []
    async for d in _raw()[COLLECTION].find({"at": {"$gte": since}}, {"_id": 0}).sort("at", -1).limit(100):
        d["at"] = d["at"].isoformat()
        out.append(d)
    return out
