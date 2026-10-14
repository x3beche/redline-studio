"""product_find: a Parts product of any source found by words - a site's,
the LCSC drawer's, a McMaster-Carr part or GrabCAD model saved here, a My
Items one - with the ids the product tools take (maker:product) and what
files it holds (backend/product_files.py)."""

from __future__ import annotations

from .. import manufacturers as mf
from .. import product_files as pf
from . import Ctx, Result, Tool, ToolError, clip
from ._product import every, ids

SHOW = 15


async def run(ctx: Ctx, args: dict) -> Result:
    q = str(args.get("query") or "").strip()
    if not q:
        raise ToolError("say what to look for: words of the product's name or its code")
    docs = await every(ctx.db)
    hits = mf.search(docs, q, "", SHOW)
    if not hits:
        return Result(text=f"No product in Parts matches {q!r}. Try fewer words, the code, or the word in the "
                           "catalog's language (Turkish: vida, rulman, menteşe).",
                      say="Nothing found for {q}", vars={"q": q}, summary="no match")
    held = (await pf.summary(ctx.db))["products"]
    lines = []
    for d, p, _ in hits:
        h = held.get(ids(d, p)) or {}
        files = ""
        if h:
            roles = ", ".join(f"{n} {pf.ROLE_NAMES.get(r, r)}" for r, n in h["roles"].items())
            files = f"  files: {roles}" + (f" (3D model {h['cad_name']})" if h.get("cad") else "")
        elif (p.get("part") or {}).get("has_3d"):
            files = "  (LCSC's own 3D model)"
        lines.append(f"- {ids(d, p)}  {p.get('name')}" + (f"  code {p['sku']}" if p.get("sku") else "")
                     + f"  - {d.get('name')}{files}")
    one = hits[0]
    text = (f"{len(hits)} product(s) for {q!r}, best first. The first column is the product's ids "
            "(maker:product) - pass it as `product` to product_file_attach, product_files_read and the other "
            "product tools. When several could be meant, ask the person which one:\n" + "\n".join(lines))
    return Result(text=clip(text), say="Found {n} products for {q}",
                  vars={"n": len(hits), "q": q, **({"m": one[0]["_id"], "pid": str(one[1]["id"])} if len(hits) == 1 else {})},
                  summary="\n".join(f"{p.get('name')} · {d.get('name')}" for d, p, _ in hits[:10]))


TOOL = Tool(
    name="product_find", package="mfr", level="read", order=68,
    label="Find a product",
    about="Finds a Parts product by words in every source and gives its ids and what files it has.",
    description="Find a product in Parts by words of its name or code, across every source at once (the makers' "
                "catalogs, the LCSC drawer, McMaster-Carr and GrabCAD items saved here, My Items). Returns each "
                "match's ids as maker:product - what product_file_attach, product_files_read and the other product "
                "tools take - and which files it holds (3D model, datasheet). Use it first when the person names a "
                "product you have no ids for; when several match, ask which one.",
    schema={"type": "object", "properties": {
        "query": {"type": "string", "description": "Words of the product's name or its code, e.g. \"UB0228\" or \"M3 vida\""}},
        "required": ["query"]},
    running="Looking for {query} in Parts", failed="Could not search Parts",
    run=run)
