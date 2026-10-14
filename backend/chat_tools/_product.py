"""What the product-file tools share (product_find, product_files_read,
product_files_missing, product_file_attach, product_file_detach,
product_set_main, product_to_model, product_to_my_items): one Parts product
of any source - a site's, the LCSC drawer's, a McMaster-Carr part or a
GrabCAD model saved here, a My Items one - named the way a person says it,
and the files attached to it (backend/product_files.py).

A product is named by "maker:product" ids (what product_find and
manufacturer_search give), by its ids apart, or by words of its name or
code across every source. Several fit: a ToolError naming them with their
ids, so a small model asks the person which one. Nothing named at all ("add
this to this product"): the product the conversation last worked on - the
last step of these tools that named one - is meant.

A file is named by its Files id. The Chat sends what the person attached
to a line as @-mentions of their Files ids (backend/cc_context.py: a
<context kind="file" id="..."> block); a tool given no file takes the
files attached to the person's latest line that has any."""

from __future__ import annotations

import re

from .. import catalog_builtin
from .. import inventory as inv
from .. import manufacturers as mf
from .. import product_files as pf
from . import Ctx, ToolError

SHOW = 12                  # products a "which one?" names


def ids(m: dict, p: dict) -> str:
    return f"{m['_id']}:{p['id']}"


async def every(db) -> list[dict]:
    """Every source with products: the workspace's sites and the built-in sources."""
    built = [d for d in await catalog_builtin.makers(db) if d.get("products")]
    return [*await mf.listing(db), *built]


async def _last_named(ctx: Ctx) -> tuple[str, str] | None:
    """The product this conversation's last product step named (its vars m and pid)."""
    if not ctx.chat:
        return None
    from .. import cc_chat
    doc = await ctx.db[cc_chat.COLL].find_one({"_id": ctx.chat}, {"messages.steps": 1})
    for msg in reversed((doc or {}).get("messages") or []):
        for st in reversed(msg.get("steps") or []):
            v = st.get("vars") or {}
            if v.get("m") and v.get("pid") and st.get("status") == "done":
                return str(v["m"]), str(v["pid"])
    return None


async def resolve(ctx: Ctx, product: str = "", manufacturer: str = "") -> tuple[dict, dict]:
    """(maker, product) the words name - or the conversation's last one."""
    product, manufacturer = str(product or "").strip(), str(manufacturer or "").strip()
    if ":" in product and not manufacturer:
        a, b = product.split(":", 1)
        got = await catalog_builtin.find_product(ctx.db, a.strip(), b.strip())
        if got:
            return got
    if manufacturer and product:
        try:
            return await inv.resolve_catalog(ctx.db, manufacturer, product)
        except ValueError as exc:
            raise ToolError(f"{exc}. product_find searches every source by words") from exc
    if not product:
        last = await _last_named(ctx)
        if last:
            got = await catalog_builtin.find_product(ctx.db, *last)
            if got:
                return got
        raise ToolError("say which product: its ids (maker:product, from product_find) or words of its name or code")
    docs = await every(ctx.db)
    # Its id alone, in any source.
    by_id = [(d, p) for d in docs for p in d.get("products") or [] if str(p.get("id")) == product]
    if len(by_id) == 1:
        return by_id[0]
    hits = mf.search(docs, product, "", 60)
    whole = [(d, p) for d, p, _ in hits if mf.fold(p.get("name")) == mf.fold(product)
             or (p.get("sku") and mf.fold(p.get("sku")) == mf.fold(product))]
    if len(whole) == 1:
        return whole[0]
    if len(hits) == 1:
        return hits[0][0], hits[0][1]
    if not hits:
        raise ToolError(f"no product in Parts matches {product!r} - try fewer words, the code, or the word in the "
                        "catalog's language (Turkish: vida, rulman, menteşe)")
    names = "; ".join(f"{ids(d, p)} {p.get('name')}" + (f" (code {p['sku']})" if p.get("sku") else "")
                      + f" - {d.get('name')}" for d, p, _ in hits[:SHOW])
    raise ToolError(f"{len(hits)} products match {product!r}: {names}. Ask the person which one, then call again "
                    "with its ids as product (maker:product)")


async def by_file_names(ctx: Ctx, fids: list[str]) -> tuple[dict, dict, str] | None:
    """The one product a file's name names ("UB0228.STEP" -> the product
    coded or named UB0228), when no product was said: (maker, product,
    the words). None when no name fits exactly one product."""
    from pathlib import PurePosixPath

    from .. import files
    docs = await every(ctx.db)
    for fid in fids:
        f = await ctx.db[files.COLL].find_one({"_id": fid}, {"name": 1})
        stem = re.sub(r"[_\-]+", " ", PurePosixPath((f or {}).get("name") or "").stem).strip()
        if len(stem) < 3:
            continue
        hits = mf.search(docs, stem, "", 5)
        if len(hits) == 1:
            return hits[0][0], hits[0][1], stem
    return None


async def mentioned_files(ctx: Ctx) -> list[str]:
    """The Files ids attached (@-mentioned) to the person's latest line that has files."""
    if not ctx.chat:
        return []
    from .. import cc_chat
    doc = await ctx.db[cc_chat.COLL].find_one({"_id": ctx.chat}, {"messages.role": 1, "messages.mentions": 1})
    for msg in reversed((doc or {}).get("messages") or []):
        if msg.get("role") != "user":
            continue
        got = [str(m["id"]) for m in msg.get("mentions") or [] if m.get("kind") == "file" and m.get("id")]
        if got:
            return got
    return []


def measured_text(v: dict) -> str:
    """What its model measured, for the model to read."""
    ms = v.get("measured")
    if not v.get("cad"):
        return "no 3D model attached"
    if not ms:
        return f"3D model {v['cad']['name']} (not measured: {v['cad']['kind']})"
    if ms.get("pending"):
        return f"3D model {v['cad']['name']}: still being measured - read it again in a moment (product_files_read)"
    if ms.get("error"):
        return f"3D model {v['cad']['name']}: could not be measured - {ms['error']}"
    rows = "; ".join(f"{a}: {b}" for a, b in ms.get("rows") or [])
    bad = "; ".join(f"its words say {b['what']} {b['said']} but the model measures {b['measured']}"
                    for b in ms.get("mismatch") or [])
    return f"3D model {v['cad']['name']} measured: {rows}" + (f". MISMATCH: {bad}" if bad else "")


def files_text(v: dict) -> str:
    """A product's files, one line each, for the model."""
    head = f"{v['name']} [{v['maker']}:{v['product']}] of {v['maker_name']}"
    if not v["files"]:
        extra = " (an LCSC part: its EasyEDA 3D model comes with the drawer)" if v.get("lcsc_3d") else ""
        return f"{head}: no files attached{extra}."
    lines = [f"{head}: {len(v['files'])} file(s) attached."]
    for f in v["files"]:
        tag = " [its 3D model]" if (v.get("cad") or {}).get("file") == f["file"] else \
            " [its picture]" if (v.get("picture") or {}).get("file") == f["file"] else ""
        lines.append(f"- {f['file']}  {f['name']}  {pf.ROLE_NAMES.get(f['role'], f['role'])}, {f.get('kind')}, "
                     f"{max(1, (f.get('bytes') or 0) // 1024)} KB{tag}  </api/files/{f['file']}>")
    lines.append(measured_text(v))
    lines.append("A PDF is read with file_read and its Files id.")
    return "\n".join(lines)
