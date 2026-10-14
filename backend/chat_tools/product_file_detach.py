"""product_file_detach: a file no longer attached to a Parts product
(backend/product_files.py). It stays in Files unless asked to go, and then
only when no other product refers to it and the person may delete it
there. Asks first, as removing does."""

from __future__ import annotations

from .. import product_files as pf
from . import Ctx, Result, Tool, ToolError
from ._product import resolve
from ._rights import need


async def run(ctx: Ctx, args: dict) -> Result:
    m, p = await resolve(ctx, args.get("product"), args.get("manufacturer"))
    mid, pid = m["_id"], str(p["id"])
    fid = str(args.get("file") or "").strip()
    v = await pf.view(ctx.db, m, p)
    if not fid:
        raise ToolError(f"say which file: its Files id. {v['name']} has: "
                        + (", ".join(f"{f['file']} {f['name']}" for f in v["files"]) or "none"))
    hit = next((f for f in v["files"] if f["file"] == fid or f["name"].lower() == fid.lower()), None)
    if not hit:
        raise ToolError(f"{fid} is not attached to {v['name']}. It has: "
                        + (", ".join(f"{f['file']} {f['name']}" for f in v["files"]) or "none"))
    need("DELETE", f"/api/manufacturers/{mid}/products/{pid}/files/{hit['file']}")
    try:
        got = await pf.detach(ctx.db, mid, pid, hit["file"], delete_file=bool(args.get("delete_file")))
    except (LookupError, PermissionError) as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    text = f"Detached {got['removed']} from {v['name']} [{mid}:{pid}]."
    if (v.get("cad") or {}).get("file") == hit["file"]:
        text += f" Its 3D model is now {got['cad']}." if got["cad"] else " It has no 3D model now."
    if got["deleted"]:
        text += " The file was removed from Files too."
    elif args.get("delete_file"):
        text += f" The file stays in Files: {got['kept_because']}."
    else:
        text += " The file stays in Files."
    if got["models"]:
        text += f" The CAD model(s) made of it ({', '.join(got['models'])}) keep their own copy."
    return Result(text=text, say="Detached {file} from {product}",
                  vars={"file": got["removed"], "product": v["name"], "m": mid, "pid": pid}, summary=text[:600])


TOOL = Tool(
    name="product_file_detach", package="mfr", level="delete", order=88, default=True,
    label="Detach a file from a product",
    about="Takes a file off a Parts product; the file stays in Files unless asked.",
    description="Detach one file from a Parts product (its 3D model, a datasheet, a picture). The file stays in "
                "Files unless `delete_file` is true (then it goes only when no other product uses it and the person "
                "may delete it). Detaching the 3D model makes the next attached model the product's. Use it only "
                "when the person asks to remove or replace a product's file. `file`: its Files id "
                "(product_files_read lists them).",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids, or words of its name"},
        "manufacturer": {"type": "string"},
        "file": {"type": "string", "description": "The attached file's Files id"},
        "delete_file": {"type": "boolean", "description": "Remove it from Files too"}}, "required": ["file"]},
    running="Detaching a file from a product", failed="Could not detach the file",
    run=run)
