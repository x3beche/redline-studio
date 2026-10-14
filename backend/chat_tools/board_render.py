"""board_render: "show me the fan board from below" - a board as the PCB
room shows it, as a picture in the Chat: its 3D (the room's 3D tab, taken
the way model_render takes it: tools/render.py board:<id>), or its layout
drawing from the top or the bottom (the room's Layout tab: KiCad's
drawings, /api/boards/{id}/layout.svg and bottom.svg).

model_render's contract, as it is: the pictures are PNGs kept in Files >
Chat/Renders with what they show in their context (the board, the drawing's
or the 3D's date as the version, the view, the size) - the cache, and what
the step's `shot0` points at, so the Chat shows it inline and opens it in
its viewer; the picture also goes to a model that reads images. A drawing
is an SVG: it is printed to a picture by the PDF engine's headless
Chromium (backend/pdfdoc.py, no network) and read back with pdfium."""

from __future__ import annotations

import asyncio
import base64
import io

from .. import ato, files, links, pdfdoc, store
from . import Ctx, Result, Tool, ToolError, size
from . import model_render as mr
from ._rights import need
from ._things import find

VIEWS = {"top": "layout", "bottom": "bottom", "3d": None}          # view -> the drawing's artifact
BACKDROP = "#1d2126"                # the room's board backdrop in the dark theme: the drawings are made for it


def _page(svg: bytes, wh: tuple[int, int]) -> str:
    """One page holding the drawing in a box of the asked shape, on the board's backdrop."""
    w, h = wh
    src = "data:image/svg+xml;base64," + base64.b64encode(svg).decode()
    return (f"<!doctype html><html><head><meta charset='utf-8'><style>html,body{{margin:0;background:#fff}}"
            f".box{{width:100%;aspect-ratio:{w}/{h};background:{BACKDROP};display:flex}}"
            f".box img{{width:100%;height:100%;object-fit:contain}}</style></head>"
            f"<body><div class='box'><img src='{src}'></div></body></html>")


async def print_pdf(page: str) -> bytes:
    """The page as a PDF (backend/pdfdoc.py's Chromium). Its own function so a test can stand in."""
    return await pdfdoc.print_pdf(page, "<span></span>", "<span></span>")


def _picture(pdf: bytes, wh: tuple[int, int]) -> bytes:
    """The PDF's first page as a PNG: the drawing's box cut out of the page, at the asked size."""
    import pypdfium2 as pdfium
    from PIL import Image, ImageChops
    doc = pdfium.PdfDocument(pdf)
    try:
        img = doc[0].render(scale=3).to_pil().convert("RGB")
    finally:
        doc.close()
    box = ImageChops.difference(img, Image.new("RGB", img.size, (255, 255, 255))).getbbox()
    if box:
        img = img.crop(box)
    img.thumbnail(wh, Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()


async def render_drawing(db, bid: str, artifact: str, wh: tuple[int, int]) -> bytes:
    """A board's drawing (layout.svg or bottom.svg) as a PNG."""
    try:
        svg = await store.get_artifact(db, bid, artifact, ato.BOARDS)
    except KeyError as exc:
        raise ToolError("that drawing is not made yet - build the board first") from exc
    try:
        pdf = await print_pdf(_page(svg, wh))
    except pdfdoc.RenderError as exc:
        raise ToolError(f"the drawing could not be printed to a picture: {exc}") from exc
    return await asyncio.to_thread(_picture, pdf, wh)


async def run(ctx: Ctx, args: dict) -> Result:
    wh = mr.SIZES.get(str(args.get("size") or "medium").lower())
    if not wh:
        raise ToolError(f"size is one of {', '.join(mr.SIZES)}")
    view = str(args.get("view") or "3d").strip().lower()
    view = {"front": "top", "back": "bottom", "under": "bottom", "below": "bottom", "layout": "top"}.get(view, view)
    if view not in VIEWS:
        raise ToolError("view is top, bottom or 3d")
    ref = str(args.get("board") or "").strip()
    if not ref:
        raise ToolError("say which board (its id or title words - board_read lists them)")
    need("POST", "/api/files")
    if view == "3d":
        return await mr._board(ctx, ref, wh)          # model_render's own board: the room's 3D tab
    d = await find(ctx.db, ato.BOARDS, ref, ("title", "folder"), "board")
    bid, title = d["_id"], d.get("title") or d["_id"]
    need("GET", f"/api/boards/{bid}/layout.svg")
    if d.get("building") or (d.get("link") or {}).get("state") in links.UPDATING:
        raise ToolError(f"board {title} is being built right now - ask again when its build is done")
    art = VIEWS[view]
    meta = (d.get("artifacts") or {}).get(art)
    if not meta:
        raise ToolError(f"board {title} has no {view} drawing yet - lay it out first (board_route), or ask for 3d")
    version = meta.get("at") or str(meta.get("sha256") or "")[:16]
    sz, key = f"{wh[0]}x{wh[1]}", f"board:{bid}"
    hit = await mr._cached(ctx.db, key, version, view, sz)
    png = None
    if not hit:
        try:
            png = await asyncio.wait_for(render_drawing(ctx.db, bid, art, wh), mr.TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise ToolError(f"the picture took longer than {mr.TIMEOUT:.0f} s") from exc
        hit = await mr._keep(ctx, title, key, version, view, sz, png)
    elif ctx.vision:
        _, png = await files.get(ctx.db, hit["_id"])
    side = "from the top" if view == "top" else "from the bottom (seen from below)"
    return Result(text=f"Board {title} ({bid}): its layout drawing {side}, as the PCB room's Layout tab shows it, "
                       f"{sz}: file {hit['_id']}"
                       + (" (kept from before)" if png is None and not ctx.vision else "")
                       + f". The Chat shows the picture under this step; it is kept in Files > {mr.FOLDER}.",
                  say="Showed {title} · {view}",
                  vars={"title": title, "board": bid, "view": view, "n": 1, "shot0": f"{view}:{hit['_id']}"},
                  summary=f"{view} drawing · {size(hit.get('bytes') or 0)}", image=png)


TOOL = Tool(
    name="board_render", package="pcb", level="change", order=44, default=True,
    label="Show a board",
    about="Shows a board as the PCB room does - its 3D, or its layout from the top or the bottom - in the Chat.",
    description="Show a board as a picture in the Chat, as the PCB room shows it: `view` 3d (its 3D tab; its drawings "
                "when it has no 3D yet), top or bottom (the Layout tab's KiCad drawing of that side - copper, pads, "
                "silkscreen). The page shows the picture under the step - do not link or describe it as a file; you "
                "get it when you read images. A board being built is not shown (it says so). Name the board by id "
                "or title words.",
    schema={"type": "object", "properties": {
        "board": {"type": "string", "description": "The board's id or title words"},
        "view": {"type": "string", "enum": list(VIEWS), "description": "3d (default), top or bottom"},
        "size": {"type": "string", "enum": list(mr.SIZES), "description": "medium unless asked"}},
        "required": ["board"]},
    running="Rendering a board", failed="Could not render the board",
    run=run)
