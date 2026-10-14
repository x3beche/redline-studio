"""Parts' Deleted: a product taken out of Parts, and everything that was
its, kept together for KEEP_DAYS and restorable as one.

Whatever deletes a product - the page's Delete, the Chat's
catalog_remove_product, an agent through the API, its maker deleted - goes
through `trash_products` (or `trash_maker`): the product (a site's from its
maker's catalog, a My Items one, a saved McMaster-Carr or GrabCAD item, an
LCSC part of the drawer), its stock lines with their logs
(backend/inventory.py) and the references to its attached files
(backend/product_files.py) leave together and are kept here as one *unit*
(`parts_trash`, the workspace's - backend/scope.py): what it was, who
deleted it and when, and when it goes for good. So a stock line never
counts a product that is not in Parts, and the stock tools and the
catalog tools always agree: a line in a unit is no longer in the
inventory, so no stock read, search, build count or shopping list sees it.

Restoring a unit puts it all back. A product found again since - a site
read again under a new id, the same code or name - is not doubled: the
lines and files go to that one. A site's product whose maker is gone for
good comes back as a My Items product (backend/catalog_own.py), its lines
and files with it; one whose maker is in Deleted itself waits for that
maker to be restored first.

After KEEP_DAYS (REDLINE_CC_UNDO_DAYS, as long as Files' trash and the
Chat's undo keep things) a unit is purged: the unit goes, and of its files
those that were put in Files for this product (their context names it) and
that no other product - in Parts or in Deleted - refers to go to Files'
trash, where Files' own rules free their bytes. A file the person brought
into Files themselves and attached stays in Files.

A full exploration of a site never deletes a product that holds stock or
files (manufacturers.fold_in `keep`): it stays, marked `gone_at` - gone
from the site - until the site lists it again.

Rights: deleting is the route's own (the catalog's, the drawer's...).
Restoring and purging one's own deletion is the catalog's right; anyone
else's needs the right to delete, as in Files' trash.
"""

from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import access, actors

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/manufacturers/trash")

COLL = "parts_trash"
KEEP_DAYS = max(1, int(os.environ.get("REDLINE_CC_UNDO_DAYS", "30") or 30))
MOST = 500                          # products one call deletes


class Refused(Exception):
    """What cannot be done, said to the person."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _who(by: dict | None = None) -> dict:
    by = by or actors.current() or {}
    return {k: by[k] for k in ("id", "name", "type") if by.get(k)}


def _bare(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k != "workspace_id"}


def source_of(mid: str) -> str:
    """"site", "own" (My Items), "linked" (McMaster-Carr, GrabCAD) or "lcsc" (the drawer)."""
    from . import catalog_builtin, catalog_own, linked
    if mid == catalog_own.MID:
        return "own"
    if mid in linked.KINDS:
        return "linked"
    if mid == "lcsc":
        return "lcsc"
    if catalog_builtin.is_builtin(mid):
        return "builtin"
    return "site"


# ---------------------------------------------------------------- what goes with a product

async def _lines(db, mid: str, pids: list[str] | None) -> list[dict]:
    from . import inventory
    q: dict = {"catalog.manufacturer": mid}
    if pids is not None:
        q["catalog.product"] = {"$in": list(pids)}
    return [_bare(d) async for d in db[inventory.COLL].find(q)]


async def _holders(db, mid: str, pids: list[str] | None) -> list[dict]:
    from . import product_files
    q: dict = {"mid": mid}
    if pids is not None:
        q["pid"] = {"$in": list(pids)}
    return [_bare(d) async for d in db[product_files.COLL].find(q)]


def _files_of(unit: dict) -> list[dict]:
    """The file references a unit holds: its products' files documents' and its saved items' own."""
    out = []
    for d in unit.get("files") or []:
        out += [{**f, "_key": f"{unit['mid']}:{d['pid']}"} for f in d.get("files") or []]
    for d in unit.get("raw") or []:
        out += [{**f, "_key": f"{unit['mid']}:{d.get('key')}"} for f in d.get("files") or []]
    return out


async def goes_with(db, mid: str, pids: list[str] | None = None) -> dict:
    """What deleting these products (or, with no `pids`, the maker) takes
    with it: {products, stock, files, lines: [names]} - for the question
    the page asks first."""
    from . import catalog_builtin
    m = await catalog_builtin.maker_doc(db, mid)
    if not m:
        raise LookupError(f"no manufacturer {mid}")
    every = [str(p.get("id")) for p in m.get("products") or []]
    want = every if pids is None else [p for p in dict.fromkeys(map(str, pids)) if p in every]
    lines = await _lines(db, mid, want)
    held = await _holders(db, mid, want)
    nfiles = sum(len(d.get("files") or []) for d in held)
    if source_of(mid) == "linked":
        from . import linked
        nfiles += sum(len(d.get("files") or []) async for d in db[linked.COLL].find({"source": mid, "key": {"$in": want}}))
    return {"products": len(want), "stock": len(lines), "files": nfiles, "days": KEEP_DAYS,
            "lines": [f"{d.get('name') or '?'} ({_qty(d)})" for d in lines][:20]}


def _qty(d: dict) -> str:
    from . import inventory
    return f"{inventory.qty(d.get('quantity'))} {d.get('unit') or 'pcs'}"


# ---------------------------------------------------------------- deleting

def _unit(kind: str, mid: str, maker_name: str, name: str, how: str, note: str = "",
          at: datetime | None = None) -> dict:
    at = at or _now()
    return {"_id": "t" + secrets.token_hex(6), "kind": kind, "mid": mid, "source": source_of(mid),
            "maker_name": maker_name, "name": name, "how": how, "note": note,
            "deleted_at": at.isoformat(), "deleted_by": _who(), "purge_at": (at + timedelta(days=KEEP_DAYS)).isoformat(),
            "products": [], "raw": [], "stock": [], "files": []}


async def trash_products(db, mid: str, pids: list[str], how: str = "hand") -> int:
    """Products out of Parts, each into Deleted with its stock lines and its
    files' references, as one unit a product. How many went (a product not
    in the catalog is no error, as before). LookupError: no such maker."""
    from . import catalog_builtin, catalog_own, linked
    from . import manufacturers as mf
    ids = [str(p) for p in dict.fromkeys(pids or []) if p]
    if len(ids) > MOST:
        raise ValueError(f"at most {MOST} products at once")
    src = source_of(mid)
    if src == "lcsc":
        return await _trash_drawer(db, ids, how)
    m = await catalog_builtin.maker_doc(db, mid)
    if not m:
        raise LookupError(f"no manufacturer {mid}")
    have = {str(p.get("id")): p for p in m.get("products") or []}
    gone = [p for p in ids if p in have]
    if not gone:
        return 0
    raws: dict[str, dict] = {}
    if src == "own":
        raws = {d["_id"]: _bare(d) async for d in db[catalog_own.COLL].find({"_id": {"$in": gone}})}
    elif src == "linked":
        raws = {d["key"]: _bare(d) async for d in db[linked.COLL].find({"source": mid, "key": {"$in": gone}})}
    units = await _pack(db, mid, m.get("name") or mid, [have[p] for p in gone], raws, how)
    # Then out of where they were kept.
    if src == "site":
        await mf.drop_products(db, mid, gone)
    elif src == "own":
        await catalog_own.delete(db, gone)
    elif src == "linked":
        for r in raws.values():
            await db[linked.COLL].delete_one({"_id": r["_id"]})
    await _unhook(db, units)
    return len(gone)


async def _pack(db, mid: str, maker_name: str, prods: list[dict], raws: dict, how: str) -> list[dict]:
    """A unit a product, with its stock lines and files' references, kept in Deleted."""
    ids = [str(p.get("id")) for p in prods]
    lines = await _lines(db, mid, ids)
    held = await _holders(db, mid, ids)
    units = []
    for p in prods:
        pid = str(p.get("id"))
        u = _unit("product", mid, maker_name, p.get("name") or pid, how)
        u["products"] = [p]
        u["raw"] = [raws[pid]] if pid in raws else []
        u["stock"] = [d for d in lines if d["catalog"]["product"] == pid]
        u["files"] = [d for d in held if d["pid"] == pid]
        await db[COLL].insert_one(u)
        units.append(u)
    return units


async def _unhook(db, units: list[dict]) -> None:
    """The units' stock lines and files' references, out of the inventory and the products' files."""
    from . import inventory, product_files
    for u in units:
        for d in u["stock"]:
            await db[inventory.COLL].delete_one({"_id": d["_id"]})
        for d in u["files"]:
            await db[product_files.COLL].delete_one({"_id": d["_id"]})
    if units:
        u = units[0]
        await actors.audit(db, "parts-trash", f"{u['mid']}: {', '.join(x['name'] for x in units)}"[:200],
                           {"products": len(units), "stock": sum(len(x["stock"]) for x in units),
                            "files": sum(len(x["files"]) for x in units), "how": u["how"]})


async def dropped(db, mid: str, before: list[dict], how: str = "agent") -> int:
    """Products a write took out of a site's catalog document directly (an
    agent's database write, backend/agent_api.py), `before` being the
    catalog as it was: those gone into Deleted with their stock and files
    after the fact. How many."""
    from . import manufacturers as mf
    now = await mf.get(db, mid)
    if now is None:
        return 0
    left = {str(p.get("id")) for p in now.get("products") or []}
    gone = [p for p in before if str(p.get("id")) not in left]
    await _unhook(db, await _pack(db, mid, now.get("name") or mid, gone, {}, how))
    return len(gone)


async def _trash_drawer(db, ids: list[str], how: str) -> int:
    """LCSC parts out of this workspace's drawer: the shared cache keeps the
    part while a unit here may want it back (lcsc.let_go `keep`)."""
    from . import catalog_builtin, lcsc
    n = 0
    for c in ids:
        if not await lcsc.holds(db, c):
            continue
        got = await catalog_builtin.find_product(db, "lcsc", c)
        units = await _pack(db, "lcsc", "LCSC", [got[1] if got else {"id": c, "name": c}], {}, how)
        await lcsc.let_go(db, c, keep=True)
        await _unhook(db, units)
        n += 1
    return n


async def trash_maker(db, mid: str, how: str = "hand") -> bool:
    """A site's maker out of Parts, with its whole catalog, every stock line
    and every file reference of its products, as one unit; its runs and
    their kept pages are not kept (manufacturers.remove)."""
    from . import manufacturers as mf
    doc = await mf.get(db, mid)
    if not doc:
        return False
    u = _unit("maker", mid, doc.get("name") or mid, doc.get("name") or mid, how)
    u.update(maker=_bare(doc), products=doc.get("products") or [], stock=await _lines(db, mid, None),
             files=await _holders(db, mid, None))
    await db[COLL].insert_one(u)
    await mf.remove(db, mid)
    await _unhook(db, [u])
    return True


# ---------------------------------------------------------------- restoring

async def restore(db, tid: str) -> dict:
    """A unit back where it was. {name, to: "maker:product" (the products'
    new home when it moved), stock, files}. Refused: it cannot come back
    now (its maker is in Deleted, or back already); LookupError: no unit."""
    from . import catalog_builtin, inventory, linked, product_files
    from . import manufacturers as mf
    u = await db[COLL].find_one({"_id": tid})
    if not u:
        raise LookupError(f"nothing {tid} in Parts' Deleted")
    mid, src = u["mid"], u.get("source") or source_of(u["mid"])
    moved: dict[str, tuple[str, str]] = {}          # product id in the unit -> (maker, product) it counts now
    if u["kind"] == "maker":
        if await mf.get(db, mid):
            raise Refused(f"{u['name']} is in Parts already")
        await db[mf.COLL].insert_one({**u["maker"], "_id": mid})
    elif src == "site":
        m = await mf.get(db, mid)
        if not m:
            if await db[COLL].find_one({"kind": "maker", "mid": mid}):
                raise Refused(f"its maker {u['maker_name']} is in Deleted too - restore the maker first")
            for p in u["products"]:
                moved[str(p["id"])] = await _to_own(db, p, u)
        else:
            have = m.get("products") or []
            add = []
            for p in u["products"]:
                same = next((x for x in have if str(x.get("id")) == str(p["id"])), None) or \
                    next((x for x in have if mf.product_key(x) == mf.product_key(p)), None)
                if same:
                    moved[str(p["id"])] = (mid, str(same["id"]))
                else:
                    add.append(p)
            if add:
                await db[mf.COLL].update_one({"_id": mid}, {"$set": {"products": (have + add)[:mf.MAX_PRODUCTS],
                                                                      "updated_at": _now().isoformat()}})
    elif src == "own":
        from . import catalog_own
        here = await catalog_own.products(db)
        for r in u["raw"]:
            same = next((x for x in here if x["id"] == r["_id"]), None) or \
                next((x for x in here if mf.product_key(x) == mf.product_key(catalog_own.product_of(r))), None)
            if same:
                moved[r["_id"]] = (mid, same["id"])
            else:
                await db[catalog_own.COLL].insert_one(dict(r))
    elif src == "linked":
        for r in u["raw"]:
            if await db[linked.COLL].find_one({"source": r["source"], "key": r["key"]}):
                continue                                  # saved again since: the lines count that one
            r = dict(r)
            if await db[linked.COLL].find_one({"_id": r["_id"]}):
                r["_id"] = secrets.token_hex(6)
            await db[linked.COLL].insert_one(r)
    elif src == "lcsc":
        from . import lcsc
        for p in u["products"]:
            c = str(p["id"])
            if await db[lcsc.PARTS].find_one({"_id": c}, {"_id": 1}):
                await lcsc.hold(db, c)
            else:
                try:
                    await lcsc.fetch(db, c)
                except Exception as exc:                  # noqa: BLE001 - the lines come back all the same
                    log.warning("fetching %s again failed: %s", c, exc)
                    moved[c] = await _to_own(db, p, u)
    # Its stock lines, counting the product where it is now, a line in each log saying so.
    who, now = _who(), _now().isoformat()
    for d in u.get("stock") or []:
        d = dict(d)
        pid = d["catalog"]["product"]
        if pid in moved:
            to_m, to_p = moved[pid]
            got = await catalog_builtin.find_product(db, to_m, to_p)
            d["catalog"] = {**d["catalog"], "manufacturer": to_m, "product": to_p,
                            **({"manufacturer_name": got[0].get("name") or to_m, "product_name": got[1].get("name") or ""}
                               if got else {})}
        if await db[inventory.COLL].find_one({"_id": d["_id"]}, {"_id": 1}):
            d["_id"] = "i" + secrets.token_hex(5)
        d["log"] = inventory._log(d, inventory._line(now, who, "edited", reason="restored from Parts' Deleted"))
        await db[inventory.COLL].insert_one(d)
    # Its files' references, merged into the ones of the product it counts now.
    for h in u.get("files") or []:
        h = dict(h)
        to_m, to_p = moved.get(h["pid"], (h["mid"], h["pid"]))
        h["mid"], h["pid"] = to_m, to_p
        there = await db[product_files.COLL].find_one({"mid": to_m, "pid": to_p})
        if there:
            ids = {f.get("file") for f in there.get("files") or []}
            more = [f for f in h.get("files") or [] if f.get("file") not in ids]
            sets: dict = {"files": (there.get("files") or []) + more}
            if not there.get("cad") and h.get("cad"):
                sets["cad"] = h["cad"]
            if not there.get("picture") and h.get("picture"):
                sets["picture"] = h["picture"]
            await db[product_files.COLL].update_one({"_id": there["_id"]}, {"$set": sets})
        else:
            if await db[product_files.COLL].find_one({"_id": h["_id"]}, {"_id": 1}):
                h["_id"] = secrets.token_hex(6)
            await db[product_files.COLL].insert_one(h)
    await db[COLL].delete_one({"_id": tid})
    await actors.audit(db, "parts-restore", f"{mid}: {u['name']}"[:200],
                       {"stock": len(u.get("stock") or []), "files": len(u.get("files") or [])})
    to = sorted({f"{a}:{b}" for a, b in moved.values()})
    return {"id": tid, "name": u["name"], "to": to, "stock": len(u.get("stock") or []),
            "files": len(_files_of(u))}


async def _to_own(db, p: dict, u: dict) -> tuple[str, str]:
    """A product whose maker is gone for good, back as a My Items product (the one of its code or name, else new)."""
    from . import catalog_own
    f = {k: p[k] for k in ("name", "sku", "category", "description") if p.get(k)}
    f["name"] = f.get("name") or str(p.get("id"))
    f["specs"] = dict(p.get("specs") or {})
    if u.get("maker_name"):
        f["specs"].setdefault("Maker", u["maker_name"])
    for k in ("url", "image"):
        if str(p.get(k) or "").startswith(("http://", "https://")):
            f[k] = p[k]
    own = await catalog_own.ensure(db, f, actors.current())
    return catalog_own.MID, own["id"]


# ---------------------------------------------------------------- for good

async def _still_used(db, fid: str, but: str) -> bool:
    from . import product_files
    if [x for x in await product_files.users_of(db, fid) if x != but]:
        return True
    async for t in db[COLL].find({}):
        if any(f.get("file") == fid and f["_key"] != but for f in _files_of(t)):
            return True
    return False


async def purge(db, tid: str) -> dict | None:
    """A unit deleted for good: of its files, those put in Files for its
    product that nothing else refers to go to Files' trash. {name, files}."""
    from . import files
    from . import lcsc
    u = await db[COLL].find_one({"_id": tid})
    if not u:
        return None
    await db[COLL].delete_one({"_id": tid})
    removed = 0
    for f in _files_of(u):
        fd = await db[files.COLL].find_one({"_id": f.get("file")}, {"context": 1})
        if not fd or (fd.get("context") or {}).get("product") != f["_key"]:
            continue                                          # gone already, or the person's own file
        if await _still_used(db, f["file"], f["_key"]):
            continue
        removed += int(await files.remove(db, f["file"]))
    if u.get("source") == "lcsc":
        for p in u.get("products") or []:
            await lcsc.drop_unheld(db, str(p["id"]))
    await actors.audit(db, "parts-purge", f"{u['mid']}: {u['name']}"[:200], {"files": removed})
    return {"id": tid, "name": u["name"], "files": removed}


async def sweep(db) -> int:
    """The units past their days, purged."""
    now = _now().isoformat()
    gone = [d["_id"] async for d in db[COLL].find({"purge_at": {"$lt": now}})]
    for tid in gone:
        await purge(db, tid)
    return len(gone)


async def sweep_all(raw) -> int:
    """Every workspace's units past their days, each purged in its own workspace."""
    from . import scope
    n = 0
    for ws in {d.get("workspace_id") or scope.DEFAULT async for d in raw[COLL].find({}, {"workspace_id": 1})}:
        tok = scope.WORKSPACE.set(ws)
        try:
            n += await sweep(scope.ScopedDb(raw, ws))
        finally:
            scope.WORKSPACE.reset(tok)
    return n


async def trash_loop(raw, every: float = 3600.0) -> None:
    """Every hour, as Files' trash is."""
    import asyncio
    while True:
        try:
            await sweep_all(raw)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                          # noqa: BLE001 - tried again next hour
            log.warning("sweeping Parts' Deleted failed: %s", exc)
        await asyncio.sleep(every)


# ---------------------------------------------------------------- what was left behind before

async def orphans(db) -> list[dict]:
    """Stock lines and files' references whose product is not in Parts -
    left behind by deletes from before this module - grouped by the
    product they name: [{mid, pid, stock, files}]."""
    from . import inventory, product_files
    have = await product_files._catalog_keys(db)
    groups: dict[tuple[str, str], dict] = {}
    for d in await inventory.everything(db):
        link = inventory.linked_to(d)
        if link and f"{link[0]}:{link[1]}" not in have:
            groups.setdefault(link, {"mid": link[0], "pid": link[1], "stock": [], "files": []})["stock"].append(_bare(d))
    async for h in db[product_files.COLL].find({}):
        if h.get("files") and f"{h['mid']}:{h['pid']}" not in have:
            k = (h["mid"], h["pid"])
            groups.setdefault(k, {"mid": k[0], "pid": k[1], "stock": [], "files": []})["files"].append(_bare(h))
    return list(groups.values())


async def _deleted_when(db, mid: str, pid: str) -> tuple[str, datetime | None]:
    """("maker" | "product", when) its deletion is in the audit trail, else ("", None)."""
    for what, target in (("product", f"/api/manufacturers/{mid}/products/{pid}"), ("maker", f"/api/manufacturers/{mid}")):
        rows = [d async for d in db["audit"].find({"action": "delete", "target": target}).sort("at", -1).limit(1)]
        if rows:
            at = rows[0].get("at")
            if isinstance(at, str):
                at = datetime.fromisoformat(at)
            return what, (at.replace(tzinfo=timezone.utc) if at and at.tzinfo is None else at)
    return "", None


async def adopt_orphans(db, apply: bool = False) -> list[dict]:
    """Every orphan (`orphans`) as a unit of Parts' Deleted - "deleted with
    <maker> on <date>", restorable for KEEP_DAYS from now: its stock lines
    with their logs and its files' references move in, nothing is deleted
    for good. With `apply` off, only what would be done. [{unit, name,
    maker, note, stock, files}]."""
    from . import manufacturers as mf
    out = []
    for g in await orphans(db):
        line = next((d.get("catalog") or {} for d in g["stock"]), {})
        m = await mf.get(db, g["mid"]) if source_of(g["mid"]) == "site" else None
        maker_name = line.get("manufacturer_name") or (m or {}).get("name") or g["mid"]
        name = line.get("product_name") or next((d.get("name") for d in g["files"] if d.get("name")), "") or \
            next((d.get("name") for d in g["stock"] if d.get("name")), "") or g["pid"]
        what, at = await _deleted_when(db, g["mid"], g["pid"])
        day = at.date().isoformat() if at else ""
        note = (f"deleted with {maker_name} on {day}" if what == "maker" else
                f"deleted from {maker_name} on {day}" if what == "product" else
                f"its product was deleted from {maker_name} before deletes kept it")
        p = {"id": g["pid"], "name": name, **{k: line[k] for k in ("sku", "url") if line.get(k)}}
        u = _unit("product", g["mid"], maker_name, name, "migrated", note)
        u.update(products=[p], stock=g["stock"], files=g["files"], deleted_by={"id": "system", "name": "Workbench"})
        if at:
            u["deleted_on"] = at.isoformat()
        if apply:
            await db[COLL].insert_one(u)
            await _unhook(db, [u])
        out.append({"unit": u["_id"] if apply else None, "name": name, "maker": maker_name, "note": note,
                    "stock": [f"{d.get('name')} ({_qty(d)}, {len(d.get('log') or [])} log lines)" for d in g["stock"]],
                    "files": sum(len(d.get("files") or []) for d in g["files"])})
    return out


# ---------------------------------------------------------------- listing

def mine(u: dict) -> bool:
    """One's own deletion, or anyone's with the right to delete."""
    return (u.get("deleted_by") or {}).get("id") == (actors.current() or {}).get("id") or \
        access.allowed(access.current(), "delete")


def out(u: dict) -> dict:
    try:
        left = datetime.fromisoformat(u["purge_at"]) - _now()
        days = max(0, left.days + (1 if left.seconds else 0))
    except (KeyError, TypeError, ValueError):
        days = None
    fl = _files_of(u)
    return {"id": u["_id"], "kind": u["kind"], "mid": u["mid"], "source": u.get("source"), "name": u["name"],
            "maker_name": u.get("maker_name") or "", "how": u.get("how") or "hand", "note": u.get("note") or "",
            "products": len(u.get("products") or []),
            "product": (lambda p: {k: p.get(k) for k in ("id", "name", "sku", "category", "image", "url")})(
                (u.get("products") or [{}])[0]) if u["kind"] == "product" else None,
            "stock": [{"id": d["_id"], "name": d.get("name") or "", "quantity": d.get("quantity"),
                       "unit": d.get("unit") or "pcs", "location": d.get("location") or "",
                       "log": len(d.get("log") or [])} for d in u.get("stock") or []],
            "files": [{"file": f.get("file"), "name": f.get("name") or "", "role": f.get("role")} for f in fl][:50],
            "nfiles": len(fl), "deleted_at": u.get("deleted_at"), "deleted_by": u.get("deleted_by") or {},
            "purge_at": u.get("purge_at"), "days_left": days, "may": mine(u)}


async def listing(db) -> list[dict]:
    await sweep(db)
    return [out(u) async for u in db[COLL].find({}).sort("deleted_at", -1)]


# ---------------------------------------------------------------- the API
# Included before the catalog's routes (main.py), so /api/manufacturers/trash
# is this and not a maker called "trash". Restoring and purging are POSTs
# under /api/manufacturers: the catalog's right (access.py); the routes keep
# anyone else's deletion to those who may delete.

def _db():
    from .main import db
    return db()


@router.get("")
async def api_list() -> dict:
    """Parts' Deleted: the latest first."""
    return {"days": KEEP_DAYS, "units": await listing(_db())}


@router.get("/goes-with")
async def api_goes_with(maker: str, products: str = "") -> dict:
    """What a delete would take with it - asked before the page deletes."""
    try:
        return await goes_with(_db(), maker, [p for p in products.split(",") if p] if products else None)
    except LookupError as exc:
        raise HTTPException(404, str(exc).strip("'\"")) from exc


class UnitsIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=500)


async def _units(ids: list[str]) -> list[dict]:
    us = [u async for u in _db()[COLL].find({"_id": {"$in": ids}})]
    if any(not mine(u) for u in us):
        raise HTTPException(403, "only whoever deleted it, or someone who may delete, can do that - "
                            + access.refusal(access.current() or "nobody", "delete"))
    return us


@router.post("/restore")
async def api_restore(body: UnitsIn) -> dict:
    back, refused = [], []
    for u in await _units(body.ids):
        try:
            back.append(await restore(_db(), u["_id"]))
        except (Refused, LookupError, ValueError) as exc:
            refused.append({"id": u["_id"], "name": u["name"], "why": str(exc).strip("'\"")})
    return {"restored": back, "refused": refused}


@router.post("/purge")
async def api_purge(body: UnitsIn) -> dict:
    got = [await purge(_db(), u["_id"]) for u in await _units(body.ids)]
    return {"purged": [g for g in got if g]}
