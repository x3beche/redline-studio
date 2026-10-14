"""product_to_model: a Parts product's 3D model into a CAD project as a
model of its own, as Files' "Add to project" makes one and `revisions.py
linked to-model` does for a McMaster-Carr part (backend/product_files.py
to_model -> main.py files_to_model): the bytes copied into the model, a
build started - no agent is run."""

from __future__ import annotations

from fastapi import HTTPException

from .. import product_files as pf
from . import Ctx, Result, Tool, ToolError
from ._product import resolve
from ._rights import need


async def run(ctx: Ctx, args: dict) -> Result:
    m, p = await resolve(ctx, args.get("product"), args.get("manufacturer"))
    mid, pid = m["_id"], str(p["id"])
    folder = str(args.get("folder") or "").strip().strip("/")
    if not folder:
        names = sorted({d["_id"] async for d in ctx.db["folders"].find({}, {"_id": 1})})[:40]
        raise ToolError("say which project folder it goes in" + (f": {', '.join(names)}" if names else ""))
    need("POST", f"/api/manufacturers/{mid}/products/{pid}/to-model")
    try:
        got = await pf.to_model(ctx.db, mid, pid, folder, str(args.get("title") or "").strip() or None,
                                str(args.get("file") or "").strip() or None)
    except (pf.Refused, LookupError) as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    except HTTPException as exc:
        why = str(exc.detail)
        if exc.status_code == 404:
            names = sorted({d["_id"] async for d in ctx.db["folders"].find({}, {"_id": 1})})[:40]
            why += f" - the project folders are: {', '.join(names) or 'none'}"
        raise ToolError(why) from exc
    text = (f"The 3D model of {p.get('name')} is model {got['model']} ({got['title']}) in {folder} now, "
            f"from {got['upload']}; it is being built (job {got.get('build_job')}). A design imports it by that name.")
    return Result(text=text, say="Added {product} to {folder} as a model",
                  vars={"product": p.get("name") or pid, "folder": folder, "model": got["model"], "m": mid, "pid": pid},
                  summary=text[:600])


TOOL = Tool(
    name="product_to_model", package="mfr", level="change", order=90, default=True,
    label="Use a product's 3D model in a project",
    about="Adds a product's attached STEP to a CAD project as a model of its own, as Files' Add to project does.",
    description="Put a Parts product's 3D model (its attached STEP or mesh) into a CAD project folder as a model "
                "of its own - the bytes copied, the model built; no agent runs. Use it when the person asks to use "
                "a product's model in a project or design. `folder`: the project folder (e.g. lamp/purchased); "
                "`file`: another of its attached models instead of its main one.",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids, or words of its name"},
        "manufacturer": {"type": "string"},
        "folder": {"type": "string", "description": "The project folder it goes in"},
        "title": {"type": "string", "description": "The model's name (default: the maker and product)"},
        "file": {"type": "string", "description": "One of its attached models' Files id, instead of its main one"}},
        "required": ["folder"]},
    running="Adding a product's model to a project", failed="Could not add the model",
    run=run)
