"""product_set_main: an attached file made a Parts product's own - a
picture its main picture (shown on its card and in its detail instead of
the one its page gave), a 3D model its model (measured)
(backend/product_files.py set_main)."""

from __future__ import annotations

from .. import product_files as pf
from . import Ctx, Result, Tool, ToolError
from ._product import measured_text, resolve
from ._rights import need


async def run(ctx: Ctx, args: dict) -> Result:
    m, p = await resolve(ctx, args.get("product"), args.get("manufacturer"))
    mid, pid = m["_id"], str(p["id"])
    need("PATCH", f"/api/manufacturers/{mid}/products/{pid}/files/x")
    v = await pf.view(ctx.db, m, p)
    fid = str(args.get("file") or "").strip()
    want = str(args.get("as") or "").strip()
    if not fid:
        pool = [f for f in v["files"] if not want or f["role"] == want]
        if len(pool) != 1:
            raise ToolError(f"say which file (its Files id). {v['name']} has: "
                            + (", ".join(f"{f['file']} {f['name']} ({f['role']})" for f in v["files"]) or "none - "
                               "attach one first with product_file_attach"))
        fid = pool[0]["file"]
    hit = next((f for f in v["files"] if f["file"] == fid or f["name"].lower() == fid.lower()), None)
    if not hit:
        raise ToolError(f"{fid} is not attached to {v['name']} - attach it first with product_file_attach")
    try:
        v = await pf.set_main(ctx.db, mid, pid, hit["file"])
    except (pf.Refused, LookupError) as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    if hit["role"] == "image":
        text = f"{hit['name']} is the picture of {v['name']} [{mid}:{pid}] now (its card and detail show it)."
        say = "Made {file} the picture of {product}"
    else:
        if (v.get("measured") or {}).get("pending"):
            v = await pf.wait_measured(ctx.db, mid, pid, 20.0)
        text = f"{hit['name']} is the 3D model of {v['name']} [{mid}:{pid}] now. " + measured_text(v)
        say = "Made {file} the 3D model of {product}"
    return Result(text=text, say=say, vars={"file": hit["name"], "product": v["name"], "m": mid, "pid": pid},
                  summary=text[:600])


TOOL = Tool(
    name="product_set_main", package="mfr", level="change", order=89, default=True,
    label="Set a product's picture or model",
    about="Makes an attached picture a product's main picture, or an attached 3D model its model.",
    description="Make a file already attached to a Parts product its own: a picture becomes the product's main "
                "picture (its card shows it instead of the site's), a 3D model becomes its model (and is measured). "
                "Use it when the person says \"use this picture for the product\" or \"make this STEP its model\" - "
                "attach the file first (product_file_attach) when it is not attached yet. `file`: the attached "
                "file's Files id; left out, the only attached file of kind `as`.",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids, or words of its name"},
        "manufacturer": {"type": "string"},
        "file": {"type": "string", "description": "The attached file's Files id"},
        "as": {"type": "string", "enum": ["", "image", "model"], "description": "Which kind, when `file` is left out"}}},
    running="Setting a product's picture or model", failed="Could not set it",
    run=run)
