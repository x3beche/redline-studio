"""What the datasheet tools share (datasheet_search, datasheet_read,
datasheet_get): a part named the way a person names it, its datasheet put
in the library (backend/datasheets.py) when it is not there yet, failures
said plainly, and the page references the Chat's step shows as links.

A part is its LCSC number (C9864), a datasheet's library id, an MPN of the
library or the drawer (TPS5430DDAR), or a Parts product - its ids
(maker:product) or words of its name (chat_tools/_product.py)."""

from __future__ import annotations

from .. import datasheets as ds
from .. import lcsc, pdftext
from . import Ctx, ToolError

REFS = 6                             # page links one step carries (vars ref0..ref5)
CITE = "Quote every value with the page it is on, as (datasheet p. N)."


async def ref(ctx: Ctx, args: dict) -> ds.Ref:
    if str(args.get("lcsc") or "").strip() and not str(args.get("part") or "").strip():
        from ._parts import code
        return ds.lcsc_ref(code(args))                   # an LCSC number it must be
    words = str(args.get("part") or "").strip()
    if not words:
        raise ToolError("say which part: its LCSC number (like C9864), its MPN, or a Parts product (maker:product)")
    try:
        got = await ds.find_ref(ctx.db, words)
    except LookupError as exc:
        raise ToolError(str(exc)) from exc
    if got:
        return got
    from ._product import resolve
    try:
        m, p = await resolve(ctx, words)
    except ToolError as exc:
        raise ToolError(f"{words!r} is no LCSC number, no MPN in the datasheet library or the drawer, and: {exc}. "
                        "Find an IC with drawer_search or lcsc_search first") from exc
    try:
        return await ds.ref_for_product(ctx.db, str(m["_id"]), str(p["id"]))
    except LookupError as exc:
        raise ToolError(str(exc)) from exc


def failure(exc: Exception) -> str:
    """A fetch's failure, said for a model and a person."""
    if isinstance(exc, lcsc.Refused):
        return f"LCSC is not being asked right now ({exc})"
    if isinstance(exc, (LookupError, pdftext.PdfError)):
        return str(exc)
    if isinstance(exc, (OSError, TimeoutError)):
        return f"the datasheet could not be fetched: {str(exc)[:300]}"
    return str(exc)[:400]


async def ensure(ctx: Ctx, r: ds.Ref, *, url: str = "", refresh: bool = False) -> tuple[dict, str]:
    from .. import product_files as pf
    try:
        return await ds.ensure(ctx.db, r, url=url, refresh=refresh, by=ctx.actor or {})
    except (LookupError, ValueError, OSError, TimeoutError, pf.Refused) as exc:
        raise ToolError(failure(exc)) from exc


def name(e: dict) -> str:
    """TPS5430DDAR (C9864)."""
    p = e.get("part") or {}
    label = p.get("mpn") or p.get("name") or p.get("lcsc") or e["key"]
    return f"{label} ({p['lcsc']})" if p.get("lcsc") and p.get("lcsc") != label else label


def notes(e: dict) -> str:
    """What the model must know before it reads: language, scans, pages not read."""
    out = []
    if e.get("lang") == "zh":
        out.append("This datasheet is in Chinese: search it with Chinese words too (最大 maximum, 电流 current, "
                   "电压 voltage, 绝对最大额定值 absolute maximum ratings, 引脚 pins), or fetch the English one with "
                   "datasheet_get(part, url=<its PDF link>) when you know where it is.")
    sc = e.get("scanned") or []
    if sc:
        from .datasheet_read import span
        out.append(f"Pages {span(sc)} are pictures of text (a scan, no text here): look at one with "
                   "datasheet_read(image_page=N) when a value must come from it.")
    if (e.get("indexed") or 0) < (e.get("pages") or 0):
        out.append(f"Only its first {e.get('indexed')} of {e.get('pages')} pages were read.")
    return " ".join(out)


def ref_vars(rows: list[tuple[str, int, str]]) -> dict:
    """The page links of a step: ref0..ref5 = "<library id>:<page>:<label>" (the page opens the PDF there)."""
    out, seen = {}, set()
    for did, page, label in rows:
        if (did, page) in seen or len(out) >= REFS:
            continue
        seen.add((did, page))
        out[f"ref{len(out)}"] = f"{did}:{page}:{label[:40]}"
    return out
