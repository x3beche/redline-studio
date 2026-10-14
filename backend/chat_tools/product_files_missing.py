"""product_files_missing: which Parts products have no 3D model, no
datasheet, or no files at all - in every source or one - and the files
kept for products no longer in Parts (backend/product_files.py summary)."""

from __future__ import annotations

from .. import product_files as pf
from . import Ctx, Result, Tool, clip
from ._product import every, ids

SHOW = 80


async def run(ctx: Ctx, args: dict) -> Result:
    want = str(args.get("missing") or "model").strip()
    src = str(args.get("manufacturer") or "").strip().lower()
    held = await pf.summary(ctx.db)
    docs = [d for d in await every(ctx.db)
            if not src or src in (str(d["_id"]).lower(), str(d.get("name") or "").lower(), str(d.get("domain") or "").lower())]
    lacking, total = [], 0
    for d in docs:
        for p in d.get("products") or []:
            total += 1
            h = held["products"].get(ids(d, p)) or {}
            roles = h.get("roles") or {}
            has_model = bool(h.get("cad")) or (d["_id"] == "lcsc" and (p.get("part") or {}).get("has_3d"))
            # An LCSC part's datasheet is LCSC's own (datasheet_get fetches it): never missing.
            gap = {"model": not has_model, "datasheet": not roles.get("datasheet") and d["_id"] != "lcsc",
                   "any": not h.get("files")}.get(want, not has_model)
            if gap:
                lacking.append(f"- {ids(d, p)}  {p.get('name')}  - {d.get('name')}")
    what = {"model": "a 3D model", "datasheet": "a datasheet", "any": "any file"}.get(want, "a 3D model")
    text = f"{len(lacking)} of {total} product(s) have no {what}:\n" + "\n".join(lacking[:SHOW])
    if len(lacking) > SHOW:
        text += f"\n(and {len(lacking) - SHOW} more)"
    if held["orphans"]:
        text += ("\nFiles are kept for products no longer in Parts (deleted by hand): " + ", ".join(held["orphans"][:20])
                 + " - their files are still in Files.")
    say = {"datasheet": "{n} products have no datasheet", "any": "{n} products have no files"}.get(
        want, "{n} products have no 3D model")
    return Result(text=clip(text), say=say, vars={"n": len(lacking)},
                  summary=text[:600])


TOOL = Tool(
    name="product_files_missing", package="mfr", level="read", order=91,
    label="Products missing files",
    about="Lists the Parts products that have no 3D model, no datasheet, or no files at all.",
    description="Which Parts products have no 3D model (`missing` model, the default), no datasheet (datasheet) or "
                "no attached file at all (any) - across every source, or one (`manufacturer`: its id or name). An LCSC "
                "part's own EasyEDA 3D model counts, and its datasheet is LCSC's (datasheet_get). Use it when the person asks which products still "
                "need a STEP or a datasheet.",
    schema={"type": "object", "properties": {
        "missing": {"type": "string", "enum": ["model", "datasheet", "any"]},
        "manufacturer": {"type": "string", "description": "Only this source or maker (id or name)"}}},
    running="Looking for products without files", failed="Could not list them",
    run=run)
