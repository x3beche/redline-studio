"""product_to_my_items: a Parts product of another source copied to My
Items (backend/catalog_own.py) - its name, code, category, description,
specs, page and price -, and its stock lines and attached files moved to
the copy, so it is counted and kept as the workspace's own thing. The
product it came from stays where it is (a site lists it; catalog_remove_product
removes it when asked)."""

from __future__ import annotations

from .. import catalog_own
from .. import inventory as inv
from .. import product_files as pf
from . import Ctx, Result, Tool, ToolError
from ._product import resolve
from ._rights import need


async def run(ctx: Ctx, args: dict) -> Result:
    m, p = await resolve(ctx, args.get("product"), args.get("manufacturer"))
    mid, pid = m["_id"], str(p["id"])
    if mid == catalog_own.MID:
        raise ToolError(f"{p.get('name')} is a My Items product already")
    need("POST", f"/api/manufacturers/{catalog_own.MID}/products")
    f = {k: p[k] for k in ("name", "sku", "category", "description") if p.get(k)}
    f["specs"] = {k: v for k, v in (p.get("specs") or {}).items() if "(measured from" not in k}
    for k in ("url", "image"):
        if str(p.get(k) or "").startswith(("http://", "https://")):
            f[k] = p[k]
    if (p.get("price") or {}).get("amount") is not None:
        f["price"], f["currency"] = p["price"]["amount"], p["price"].get("currency") or ""
    try:
        own = await catalog_own.ensure(ctx.db, f, ctx.actor or None)
    except ValueError as exc:
        raise ToolError(str(exc)) from exc
    moved_lines = 0
    if args.get("move_stock", True):
        lines = ((await inv.stock_of(ctx.db, mid)).get(mid) or {}).get(pid, {}).get("items") or []
        if lines:
            need("PATCH", "/api/inventory/x")
        for iid in lines:
            await inv.patch(ctx.db, iid, {"catalog": {"manufacturer": catalog_own.MID, "product": own["id"]}},
                            ctx.actor or None, reason="moved to My Items")
            moved_lines += 1
    v = await pf.view(ctx.db, m, p)
    moved_files = 0
    if v["files"]:
        main = (v.get("cad") or {}).get("file")
        order = [main, *[x["file"] for x in v["files"] if x["file"] != main]] if main else [x["file"] for x in v["files"]]
        _, reps = await pf.attach(ctx.db, catalog_own.MID, own["id"], order, by=ctx.actor or None)
        moved_files = sum(1 for r in reps if r["status"] in ("attached", "already"))
    text = (f"{p.get('name')} is a My Items product now: [{catalog_own.MID}:{own['id']}]"
            + (f"; {moved_lines} stock line(s) count it there" if moved_lines else "")
            + (f"; its {moved_files} file(s) are attached to it (the same files in Files)" if moved_files else "")
            + f". The original stays in {m.get('name')} [{mid}:{pid}].")
    return Result(text=text, say="Copied {product} to My Items",
                  vars={"product": p.get("name") or pid, "m": catalog_own.MID, "pid": own["id"]}, summary=text[:600])


TOOL = Tool(
    name="product_to_my_items", package="mfr", level="change", order=92, default=False,
    label="Copy a product to My Items",
    about="Copies a Parts product to My Items with its files, and moves its stock lines to the copy.",
    description="Make a product of another source (a site, LCSC, McMaster-Carr, GrabCAD) a My Items product: its "
                "name, code, category, description, specs, page and price copied, its attached files attached to the "
                "copy, and its stock lines moved to count the copy (`move_stock` false keeps them). The original "
                "stays. Use it only when the person asks to move or copy a product to My Items.",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids, or words of its name"},
        "manufacturer": {"type": "string"},
        "move_stock": {"type": "boolean", "description": "Move its stock lines to the copy (default true)"}}},
    running="Copying a product to My Items", failed="Could not copy it to My Items",
    run=run)
