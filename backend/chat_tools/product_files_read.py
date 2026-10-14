"""product_files_read: the files attached to one Parts product - its 3D
model, datasheets, drawings, pictures - and what its model measured
(backend/product_files.py, linked_measure.py)."""

from __future__ import annotations

from .. import product_files as pf
from . import Ctx, Result, Tool
from ._product import files_text, resolve


async def run(ctx: Ctx, args: dict) -> Result:
    m, p = await resolve(ctx, args.get("product"), args.get("manufacturer"))
    v = await pf.view(ctx.db, m, p)
    ms = v.get("measured") or {}
    return Result(text=files_text(v), say="Read the files of {product}",
                  vars={"product": v["name"], "n": len(v["files"]), "m": m["_id"], "pid": str(p["id"])},
                  summary=f"{len(v['files'])} file(s)" + (f" · {v['cad']['name']}" if v.get("cad") else "")
                          + (" · " + "; ".join(f"{a} {b}" for a, b in ms.get("rows") or []) if ms.get("rows") else ""))


TOOL = Tool(
    name="product_files_read", package="mfr", level="read", order=86,
    label="Read a product's files",
    about="Lists the files attached to a Parts product and the size its 3D model measured.",
    description="The files attached to one Parts product (any source) - its 3D model, datasheets, drawings, "
                "pictures, each with its Files id - and what its 3D model measured: the box in mm, a screw's length "
                "under the head, head and shank, an assembly's solids, and any mismatch with what its name or specs "
                "say. Use it when the person asks what files a product has, its real dimensions, or whether its STEP "
                "matches. `product`: its ids (maker:product, from product_find) or words of its name; left out, the "
                "product this conversation last worked on.",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids, or words of its name or code"},
        "manufacturer": {"type": "string", "description": "The maker's id or name, when `product` is words"}}},
    running="Reading a product's files", failed="Could not read the product's files",
    run=run)
