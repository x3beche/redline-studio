"""What the part tools share: an LCSC number made plain, and whether a
datasheet is kept for it (without reading it)."""

from __future__ import annotations

from .. import lcsc
from . import ToolError


def code(args: dict, key: str = "lcsc") -> str:
    c = str(args.get(key) or "").strip().upper()
    if not lcsc.looks_like_a_part(c):
        raise ToolError(f"{c or 'that'} is not an LCSC part number (they look like C25744)")
    return c


def kept(c: str) -> bool:
    try:
        return (lcsc.LOOK / c / lcsc.DATASHEET).is_file()
    except OSError:
        return False


async def in_drawer(db, c: str) -> dict | None:
    return await lcsc.holds(db, c)


def why(exc: Exception) -> str:
    """LCSC's failures, said for a model and a person."""
    if isinstance(exc, lcsc.Refused):
        return f"LCSC is not being asked right now ({exc})"
    if isinstance(exc, LookupError):
        return str(exc)
    return f"LCSC did not answer: {str(exc)[:300]}"
