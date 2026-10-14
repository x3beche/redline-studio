"""product_file_attach: a file attached to a Parts product of any source -
a STEP as its 3D model (measured), a PDF as its datasheet or drawing, a
picture - from the files the person attached in the Chat, from Files by
id, or downloaded from an address they gave (backend/product_files.py).
The file stays one file in Files; the product refers to it."""

from __future__ import annotations

from .. import product_files as pf
from . import Ctx, Result, Tool, ToolError
from ._product import by_file_names, mentioned_files, measured_text, resolve
from ._rights import need

WAIT = 20.0                 # seconds a STEP's measuring is waited for before the answer says "measuring"


async def run(ctx: Ctx, args: dict) -> Result:
    fids = args.get("files") or []
    if isinstance(fids, str):
        fids = [fids]
    fids = [str(x).strip() for x in fids if str(x).strip()]
    url = str(args.get("url") or "").strip()
    role = str(args.get("role") or "").strip() or None
    main = args.get("main")
    main = bool(main) if isinstance(main, bool) else None
    where = "Files"
    if not fids and not url:
        fids = await mentioned_files(ctx)
        where = "the Chat"
        if not fids:
            raise ToolError("no file to attach: the person attaches it to their message (it comes as a file "
                            "@-mention with a Files id), or give `files` (Files ids) or `url`")
    guessed = ""
    try:
        m, p = await resolve(ctx, args.get("product"), args.get("manufacturer"))
    except ToolError:
        # No product said and none worked on yet: the one the file's own name names ("UB0228.STEP").
        got = None if (args.get("product") or args.get("manufacturer")) else await by_file_names(ctx, fids)
        if not got:
            raise
        m, p, guessed = got
    mid, pid = m["_id"], str(p["id"])
    need("POST", f"/api/manufacturers/{mid}/products/{pid}/files/attach")
    try:
        if url:
            name, data = await pf.fetch(url)
            v, reps = await pf.put(ctx.db, mid, pid, name, data, role=role, main=main, by=ctx.actor or None)
            where = url
        else:
            v, reps = await pf.attach(ctx.db, mid, pid, fids, role=role, main=main, by=ctx.actor or None)
    except (pf.Refused, LookupError, ValueError) as exc:
        raise ToolError(str(exc).strip("'\"")) from exc
    if not any(r["status"] in ("attached", "already") for r in reps):
        raise ToolError("; ".join(r.get("why") or r["name"] for r in reps) or "nothing was attached")
    if v.get("measured", {}) and (v["measured"] or {}).get("pending") and any(r.get("main") for r in reps):
        v = await pf.wait_measured(ctx.db, mid, pid, WAIT)
    lines = []
    for r in reps:
        what = pf.ROLE_NAMES.get(r.get("role") or "", r.get("role") or "file")
        if r["status"] == "attached":
            s = f"attached {r['name']} ({r['file']}) as {what}"
        elif r["status"] == "already":
            s = f"{r['why']} - nothing changed"
        else:
            s = f"NOT attached {r['name']}: {r['why']}"
        if r.get("main") and r.get("role") == "model":
            s += " - it is the product's 3D model now" + (f" (in place of {r['replaced']}, which stays attached; "
                                                          "detach it with product_file_detach if it should go)"
                                                          if r.get("replaced") else "")
        lines.append(s)
    done = [r for r in reps if r["status"] == "attached"]
    head = f"{v['name']} [{mid}:{pid}] of {v['maker_name']}:"
    if guessed:
        head = (f"No product was named; the file's name ({guessed}) names this one - say so if another was meant. "
                + head)
    text = head + "\n- " + "\n- ".join(lines) + "\n" + measured_text(v)
    if v.get("lcsc_3d") and any(r.get("role") == "model" for r in done):
        text += "\nThis LCSC part has its own EasyEDA 3D model too; the attached one is shown with the product."
    ms = v.get("measured") or {}
    dims = "; ".join(f"{a} {b}" for a, b in ms.get("rows") or [])
    first = (done or reps)[0]
    if ms.get("pending"):
        say = "Attached {file} to {product} - measuring it"
    elif dims and any(r.get("main") for r in reps):
        say = "Attached {file} to {product}: {dims}"
    else:
        say = "Attached {file} to {product}"
    return Result(text=text, say=say,
                  vars={"file": first["name"] + (f" +{len(done) - 1}" if len(done) > 1 else ""), "product": v["name"],
                        "dims": dims, "m": mid, "pid": pid, "from": where},
                  summary="\n".join(lines)[:600])


TOOL = Tool(
    name="product_file_attach", package="mfr", level="change", order=87, default=True,
    label="Attach a file to a product",
    about="Attaches a STEP, PDF or picture to any Parts product: a 3D model is measured, a PDF kept as its datasheet.",
    description="Attach a file to a product in Parts - any source: a site's product, My Items, an LCSC part, a "
                "McMaster-Carr or GrabCAD item. Use this when the person attaches a STEP/STP (or STL, 3MF, OBJ), a "
                "PDF or a picture and asks to add it to a product - \"add this to this product as its 3D model\", "
                "\"this is its datasheet\". The kind is worked out: a STEP or mesh becomes the product's 3D model and "
                "is measured (its size in mm, a screw's length; the answer says it, or that it is still measuring), "
                "a PDF its datasheet (a drawing when its name says so), an image a picture. Give the file as `files` "
                "(Files ids: a file the person attached to their message is a <context kind=\"file\" id=...> - "
                "leave `files` out and the files attached to their latest message are taken) or `url` (a direct "
                "link to the file the person gave; never McMaster-Carr or GrabCAD, which the person downloads "
                "themselves). `product`: its ids (maker:product, from product_find) or words of its name; left out, "
                "the product this conversation last worked on. A new STEP replaces the product's earlier model, "
                "which stays attached; the same file twice is attached once.",
    schema={"type": "object", "properties": {
        "product": {"type": "string", "description": "maker:product ids (product_find), or words of its name or code"},
        "manufacturer": {"type": "string", "description": "The maker's id or name, when `product` is words"},
        "files": {"type": "array", "items": {"type": "string"},
                  "description": "Files ids; leave out for the files attached to the person's latest message"},
        "url": {"type": "string", "description": "A direct link to the file, instead of `files`"},
        "role": {"type": "string", "enum": ["", "model", "datasheet", "drawing", "image"],
                 "description": "Only when the kind would come out wrong (a PDF that is a drawing)"},
        "main": {"type": "boolean", "description": "true: this 3D model becomes the product's model even over a "
                                                    "STEP; this picture becomes its picture. false: only attach it"}}},
    running="Attaching a file to a product", failed="Could not attach the file",
    run=run)
