"""Exchange rates, for showing money in the currency people think in.

Every amount the app keeps is in US dollars - token prices, spend, the
cost of a note. People's own costs come in their own currency: a $200
subscription, 3 TL per kWh. So the server keeps the day's rates against
the dollar from Frankfurter (https://frankfurter.dev - the European
Central Bank's reference rates, published once a working day), asks for
them every hour, and keeps the last answer: without a network the app
goes on with the rates it had, and says how old they are.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

log = logging.getLogger("x3.fx")

COLL = "fx_rates"                  # machine-wide: "latest", and one document per date
SOURCE = "frankfurter.dev"
LATEST = "https://api.frankfurter.dev/v1/latest?base=USD"
NAMES = "https://api.frankfurter.dev/v1/currencies"
EVERY_S = 3600
STALE_H = 96                       # ECB rates skip weekends and holidays; four days is still "today's"

_latest: dict = {"base": "USD", "date": None, "fetched_at": None, "rates": {"USD": 1.0},
                 "names": {"USD": "United States Dollar"}, "source": SOURCE}
_db_getter = None


def _raw(db):
    return db.raw if getattr(type(db), "SCOPED", False) else db


def rates() -> dict[str, float]:
    return _latest["rates"]


def known(currency: str | None) -> bool:
    return bool(currency) and currency.upper() in _latest["rates"]


def to_usd(amount: float | None, currency: str | None) -> float | None:
    """An amount in `currency`, in US dollars at the latest rate."""
    if amount is None:
        return None
    cur = (currency or "USD").upper()
    r = _latest["rates"].get(cur)
    if not r:
        raise ValueError(f"no rate for {cur}")
    return amount / r


def from_usd(usd: float | None, currency: str | None) -> float | None:
    if usd is None:
        return None
    r = _latest["rates"].get((currency or "USD").upper())
    if not r:
        raise ValueError(f"no rate for {currency}")
    return usd * r


def public() -> dict:
    fetched = _latest.get("fetched_at")
    stale = True
    if fetched:
        age_h = (datetime.now(timezone.utc) - datetime.fromisoformat(fetched)).total_seconds() / 3600
        stale = age_h > STALE_H
    return {**_latest, "stale": stale}


async def _fetch() -> dict:
    import httpx
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(LATEST)
        r.raise_for_status()
        latest = r.json()
        names = {}
        try:
            n = await client.get(NAMES)
            if n.status_code < 400:
                names = n.json()
        except Exception:                              # noqa: BLE001 - names are a nicety
            pass
    rates = {k.upper(): float(v) for k, v in (latest.get("rates") or {}).items()}
    rates["USD"] = 1.0
    return {"base": "USD", "date": latest.get("date"), "rates": rates,
            "names": {**{"USD": "United States Dollar"}, **names},
            "fetched_at": datetime.now(timezone.utc).isoformat(), "source": SOURCE}


async def refresh(db=None) -> dict:
    """Ask Frankfurter now; keep the answer (and the day's rates) in the database."""
    global _latest
    got = await _fetch()
    _latest = got
    db = db or (_db_getter() if _db_getter else None)
    if db is not None:
        raw = _raw(db)
        await raw[COLL].replace_one({"_id": "latest"}, {"_id": "latest", **got}, upsert=True)
        if got.get("date"):
            await raw[COLL].update_one({"_id": got["date"]},
                                       {"$set": {"rates": got["rates"], "date": got["date"]}}, upsert=True)
    return public()


async def load(db) -> dict:
    """The last rates kept, before the first answer of this run comes in."""
    global _latest
    doc = await _raw(db)[COLL].find_one({"_id": "latest"})
    if doc:
        doc.pop("_id", None)
        _latest = {**_latest, **doc}
    return public()


async def loop(db_getter) -> None:
    """Every hour, for as long as the server runs."""
    global _db_getter
    _db_getter = db_getter
    while True:
        try:
            await refresh(db_getter())
        except Exception as exc:                       # noqa: BLE001 - keep the last rates
            log.warning("exchange rates not refreshed: %s", exc)
        await asyncio.sleep(EVERY_S)


# ---------------- the API ----------------

from fastapi import APIRouter, HTTPException  # noqa: E402

router = APIRouter(prefix="/api/fx")


@router.get("")
async def get_rates() -> dict:
    return public()


@router.post("/refresh")
async def post_refresh() -> dict:
    from .main import db
    try:
        return await refresh(db())
    except Exception as exc:                           # noqa: BLE001
        raise HTTPException(502, f"Frankfurter did not answer: {exc}"[:300]) from exc
