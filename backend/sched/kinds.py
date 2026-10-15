"""What a scheduled task can do: built-in jobs, each with its inputs.

No task runs the person's code. A type is a job the app already knows how
to do - read the stock, read the makers' pages again, build a model, look
at the backups, add up what the models cost - with a few inputs, declared
here (`params`) and checked on the server (`check`): the page draws its
form from the same list. A type also says

    right       the access action its owner needs for it (access.py):
                draw for what anyone working may ask, run for builds,
                settings for the server's own (the backups)
    llm         it spends money on a model: cost caps apply, off at first
    rerun_safe  an interrupted run may simply be run again (a read, or a
                refresh that ends the same however often it runs)
    exclusive   it waits while something of its kind runs (the makers'
                pages are read one job at a time)
    writes      "none" or "refresh" - no type deletes or changes what the
                person keeps (tests/test_sched.py holds every type to it)

`run(ctx, params)` returns an Outcome: a one-line summary, the report in
Markdown, a little data for the page, a CSV when it is a table, and what it
cost. Each run is in the runner's process (backend/sched/runner.py), as the
owner, in the owner's space - and in the owner's language (`ctx.lang`, from
notifications.lang_of): every sentence of a report is written twice,
`ctx.t(english, turkish)`; names, numbers and model output stay as they are.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable


class Bad(ValueError):
    """Inputs that cannot be: the message says which and why."""


class Busy(RuntimeError):
    """Not now: something it must not overlap is running (said in words)."""


@dataclass
class Param:
    name: str
    kind: str                         # int, float, bool, str, text, enum, list
    label: str
    default: Any = None
    lo: float | None = None
    hi: float | None = None
    choices: tuple = ()               # enum: the values; list: the values allowed (empty: any, see `of`)
    of: str = ""                      # list: what the items are - "model", "board", "tool", "part" (the page offers them)
    about: str = ""
    max_len: int = 200
    max_items: int = 20
    required: bool = False

    def public(self) -> dict:
        return {"name": self.name, "kind": self.kind, "label": self.label, "default": self.default, "lo": self.lo,
                "hi": self.hi, "choices": list(self.choices), "of": self.of, "about": self.about,
                "max_len": self.max_len, "max_items": self.max_items, "required": self.required}

    def check(self, v: Any) -> Any:
        if v is None or v == "" and self.kind not in ("str", "text"):
            if self.required:
                raise Bad(f"{self.label}: required")
            return self.default
        k = self.kind
        if k == "bool":
            if isinstance(v, bool):
                return v
            if str(v).lower() in ("1", "true", "yes", "on"):
                return True
            if str(v).lower() in ("0", "false", "no", "off"):
                return False
            raise Bad(f"{self.label}: yes or no")
        if k in ("int", "float"):
            try:
                n = float(v)
            except (TypeError, ValueError):
                raise Bad(f"{self.label}: a number") from None
            if k == "int":
                if n != int(n):
                    raise Bad(f"{self.label}: a whole number")
                n = int(n)
            if self.lo is not None and n < self.lo or self.hi is not None and n > self.hi:
                raise Bad(f"{self.label}: from {self.lo:g} to {self.hi:g}")
            return n
        if k in ("str", "text"):
            s = str(v).strip()
            if len(s) > self.max_len:
                raise Bad(f"{self.label}: at most {self.max_len} characters")
            if self.required and not s:
                raise Bad(f"{self.label}: required")
            return s
        if k == "enum":
            if v not in self.choices:
                raise Bad(f"{self.label}: one of {', '.join(map(str, self.choices))}")
            return v
        if k == "list":
            if not isinstance(v, list):
                raise Bad(f"{self.label}: a list")
            out = []
            for x in v:
                x = str(x).strip()
                if not x or x in out:
                    continue
                if self.choices and x not in self.choices:
                    raise Bad(f"{self.label}: '{x}' is not one of {', '.join(self.choices)}")
                if len(x) > self.max_len:
                    raise Bad(f"{self.label}: an item is too long")
                out.append(x)
            if len(out) > self.max_items:
                raise Bad(f"{self.label}: at most {self.max_items}")
            if self.required and not out:
                raise Bad(f"{self.label}: at least one")
            return out
        raise Bad(f"{self.label}: unknown kind {k}")


@dataclass
class Outcome:
    summary: str
    markdown: str
    data: dict = field(default_factory=dict)
    csv: str | None = None
    cost_usd: float | None = None
    ok: bool = True                   # False: the run ends failed, with what it found kept


@dataclass
class Ctx:
    """What a run runs with: the owner's space (`db`, a ScopedDb), the
    database itself, who it runs as, the task and its run, and `beat()` to
    say it is still alive in a long wait."""
    db: Any
    raw: Any
    owner: dict
    role: str
    task: dict
    run: dict
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    beat: Callable[[str], Awaitable[None]] | None = None
    spent: float = 0.0               # what the LLM work cost so far in this run
    lang: str = "en"                 # the owner's: "en" or "tr"

    def t(self, en: str, tr: str) -> str:
        """The owner's language of a sentence written in both."""
        return tr if self.lang == "tr" else en

    async def say(self, what: str) -> None:
        if self.beat:
            await self.beat(what)


@dataclass
class Kind:
    id: str
    label: str
    about: str
    params: list[Param]
    run: Callable[[Ctx, dict], Awaitable[Outcome]]
    right: str = "draw"
    llm: bool = False
    rerun_safe: bool = True
    exclusive: str = ""               # a name: runs of kinds with the same name never overlap
    writes: str = "none"              # none | refresh
    timeout_s: int = 600
    table: bool = False               # gives a CSV

    def public(self) -> dict:
        return {"id": self.id, "label": self.label, "about": self.about, "right": self.right, "llm": self.llm,
                "rerun_safe": self.rerun_safe, "timeout_s": self.timeout_s, "table": self.table,
                "writes": self.writes, "params": [p.public() for p in self.params]}

    def check(self, params: dict | None) -> dict:
        params = dict(params or {})
        known = {p.name for p in self.params}
        extra = [k for k in params if k not in known]
        if extra:
            raise Bad(f"{self.label}: no input called {extra[0]}")
        return {p.name: p.check(params.get(p.name)) for p in self.params}


def md_cell(v: Any) -> str:
    return str("" if v is None else v).replace("|", "/").replace("\n", " ").strip()


def table(head: list[str], rows: list[list]) -> str:
    if not rows:
        return ""
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(md_cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def to_csv(head: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(head)
    for r in rows:
        w.writerow(["" if c is None else c for c in r])
    return buf.getvalue()


def money(v: float | None, cur: str = "USD") -> str:
    if v is None:
        return "-"
    return f"{v:,.2f} {cur}" if cur != "USD" else f"${v:,.2f}" if v >= 0.01 or v == 0 else f"${v:.4f}"


def plural(n: int, en: str, lang: str = "en") -> str:
    """"1 price change", "2 price changes" - Turkish keeps the singular."""
    return en if n == 1 or lang == "tr" else en + "s"


def qty(v: Any) -> str:
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return str(v)
    return str(int(f)) if f == int(f) else f"{f:g}"


def ago(t: float | None, now: float | None = None, lang: str = "en") -> str:
    tr = lang == "tr"
    if t is None:
        return "hiç" if tr else "never"
    s = max(0, (now or time.time()) - t)
    if s < 3600:
        return f"{int(s // 60)} dk önce" if tr else f"{int(s // 60)} min ago"
    if s < 86400 * 2:
        return f"{s / 3600:.1f} sa önce" if tr else f"{s / 3600:.1f} h ago"
    return f"{s / 86400:.1f} gün önce" if tr else f"{s / 86400:.1f} days ago"


# ================================================================= stock report

async def stock_report(ctx: Ctx, p: dict) -> Outcome:
    from .. import fx, inventory
    rows = await inventory.everything(ctx.db)
    out_ = [d for d in rows if float(d.get("quantity") or 0) <= 0]
    low = [d for d in rows if inventory.is_low(d) or float(d.get("quantity") or 0) <= 0]
    show = low if p["scope"] == "low" else rows
    show = sorted(show, key=lambda d: (not inventory.is_low(d), float(d.get("quantity") or 0), inventory.fold(d.get("name"))))
    t = ctx.t
    head = [t("Item", "Ürün"), "MPN / LCSC", t("On hand", "Eldeki"), t("Minimum", "Asgari"), t("Reorder", "Sipariş"),
            t("Place", "Yer"), t("Unit price", "Birim fiyat")]
    lines, buy_usd, unpriced = [], 0.0, 0
    for d in show[: p["limit"]]:
        q, lo = float(d.get("quantity") or 0), d.get("min_stock")
        need = None
        if lo is not None and (q <= float(lo) or p["scope"] == "low"):
            need = max(0.0, float(lo) * p["target"] - q)
        price = d.get("price")
        if need and price is not None:
            usd = fx.to_usd(float(price) * need, d.get("currency") or "USD")
            if usd is None:
                unpriced += 1
            else:
                buy_usd += usd
        elif need:
            unpriced += 1
        unit = d.get("unit") or t("pcs", "adet")
        lines.append([d.get("name") or "", d.get("mpn") or d.get("lcsc") or "", f"{qty(q)} {unit}",
                      "-" if lo is None else f"{qty(lo)} {unit}",
                      (t("set a minimum", "asgari belirleyin") if lo is None else "-") if need is None else (f"{qty(need)} {unit}" if need else "-"),
                      d.get("location") or "", "" if price is None else money(float(price), d.get("currency") or "USD")])
    st = inventory.stats(rows)
    md = [t(f"**{len(low)} of {len(rows)} stock lines are low or out** ({len(out_)} out of stock).",
            f"**{len(rows)} stok satırından {len(low)} tanesi azalmış ya da bitmiş** ({len(out_)} tanesi stokta yok).")]
    if lines:
        md += ["", table(head, lines)]
        if len(show) > p["limit"]:
            md.append(t(f"\n... and {len(show) - p['limit']} more.", f"\n... ve {len(show) - p['limit']} tane daha."))
    elif p["scope"] == "low":
        md.append(t("\nNothing is at or below its minimum.", "\nHiçbiri asgarisinde ya da altında değil."))
    if buy_usd or unpriced:
        md.append(t(f"\nReordering up to {p['target']}x the minimum costs about **{money(buy_usd)}**"
                    + (f" ({unpriced} without a price)" if unpriced else "") + ".",
                    f"\nAsgarinin {p['target']} katına kadar yeniden sipariş yaklaşık **{money(buy_usd)}** tutar"
                    + (f" ({unpriced} tanesinin fiyatı yok)" if unpriced else "") + "."))
    if p["value"] and st["value"]:
        total = sum(v for v in (fx.to_usd(a, c) for c, a in st["value"].items()) if v is not None)
        per = ", ".join(money(a, c) for c, a in sorted(st["value"].items()))
        md.append(t(f"\nStock value: **{money(total)}** ({per}).", f"\nStok değeri: **{money(total)}** ({per})."))
    summary = (t(f"{len(low)} low or out of {len(rows)}", f"{len(rows)} satırdan {len(low)} azalmış ya da bitmiş")
               if rows else t("no stock lines yet", "henüz stok satırı yok")) \
        + (t(f", reorder about {money(buy_usd)}", f", yeniden sipariş yaklaşık {money(buy_usd)}") if buy_usd else "")
    return Outcome(summary, "\n".join(md), {"items": len(rows), "low": len(low), "out": len(out_),
                                             "reorder_usd": round(buy_usd, 2), "value": st["value"]},
                   csv=to_csv(head, lines))


STOCK = Kind(
    "stock_report", "Stock report",
    "What is low or out of stock, what to reorder and how many, and what the stock is worth.",
    [Param("scope", "enum", "Stock lines", "low", choices=("low", "all"), about="Only the low and out-of-stock lines, or all"),
     Param("target", "int", "Reorder up to", 2, 1, 5, about="times the minimum"),
     Param("value", "bool", "Stock value", True, about="Add up what the stock is worth"),
     Param("limit", "int", "At most", 50, 5, 200, about="lines in the report")],
    stock_report, right="draw", timeout_s=120, table=True)


# ================================================================= price refresh

async def _makers_busy(raw) -> str | None:
    """A reason the makers' pages must not be read now, or None - in any
    space: an exploration or a re-read anywhere is left to finish first."""
    from .. import manufacturers as mf
    from .core import raw_of
    raw = raw_of(raw)
    job = await raw[mf.JOBS].find_one({"status": {"$in": list(mf.ACTIVE)}})
    if job:
        return f"{(job.get('manufacturer') or {}).get('name') or 'a site'} is being explored"
    chk = await raw[mf.CHECKS].find_one({"status": "running"})
    if chk:
        quiet = mf._seconds(chk.get("beat") or chk.get("started_at"))
        if quiet is not None and quiet < mf.CHECK_LOST:
            return "the catalog is being re-read"
    return None


async def busy_reason(kind: "Kind", raw) -> str | None:
    """Whether a run of this kind must wait (said why): for the scheduler,
    before it starts one."""
    if kind.exclusive == "makers":
        return await _makers_busy(raw)
    return None


async def _recheck_here(ctx: Ctx) -> dict:
    """The Parts page's "Re-read all products", run in this process and
    awaited: written as its catalog_checks row (the page shows it running),
    beating while it reads."""
    import secrets as _s

    from .. import manufacturers as mf
    why = await _makers_busy(ctx.raw)
    if why:
        raise Busy(why)
    now = mf._now()
    cid = _s.token_hex(6)
    await ctx.db[mf.CHECKS].insert_one({
        "_id": cid, "status": "running", "dry": False, "by": {**ctx.owner, "via": "schedule"}, "started_at": now,
        "finished_at": None, "beat": now, "worker": mf.WORKER, "done": 0, "total": None, "current": None,
        "counts": {}, "rows": [], "error": None})

    async def progress(done, total, current, report):
        res = await ctx.db[mf.CHECKS].update_one({"_id": cid, "status": "running"}, {"$set": {
            "done": done, "total": total, "current": current, "counts": report["counts"], "rows": report["rows"],
            "beat": mf._now()}})
        if not getattr(res, "matched_count", 1):
            raise mf.Stopped(cid)
        await ctx.say(f"reading pages {done}/{total or '?'}")

    try:
        report = await mf.recheck(ctx.db, False, progress)
    except mf.Stopped:
        raise RuntimeError("the re-read was cancelled on the Parts page") from None
    except BaseException as exc:
        await ctx.db[mf.CHECKS].update_one({"_id": cid, "status": "running"}, {"$set": {
            "status": "failed", "finished_at": mf._now(), "error": f"it stopped: {str(exc)[:300] or type(exc).__name__}"}})
        raise
    await ctx.db[mf.CHECKS].update_one({"_id": cid, "status": "running"}, {"$set": {
        "status": "done", "finished_at": mf._now(), "counts": report["counts"], "rows": report["rows"], "current": None}})
    return report


def _amount(pr: dict | None) -> tuple[float | None, str]:
    if not isinstance(pr, dict):
        return None, ""
    a = pr.get("amount")
    try:
        return (float(a) if a is not None else None), str(pr.get("currency") or "")
    except (TypeError, ValueError):
        return None, ""


async def price_refresh(ctx: Ctx, p: dict) -> Outcome:
    from .. import bom_cost, inventory, lcsc
    t = ctx.t
    md: list[str] = []
    changes: list[list] = []
    data: dict = {}
    stocked: set[tuple[str, str]] = set()
    if p["only_stocked"]:
        for d in await inventory.everything(ctx.db):
            link = inventory.linked_to(d)
            if link:
                stocked.add(link)
    if p["makers"]:
        await ctx.say("reading the makers' product pages")
        rep = await _recheck_here(ctx)
        c = rep["counts"]
        data["makers"] = c
        for r in rep["rows"]:
            pr = r.get("price")
            if not pr:
                continue
            (a, ca), (b, cb) = _amount(pr[0]), _amount(pr[1])
            if p["only_stocked"] and ((r.get("maker") or {}).get("id"), r.get("id")) not in stocked:
                continue
            pct = None if not a or b is None or ca != cb else (b - a) / a * 100
            if pct is not None and abs(pct) < p["min_change_pct"]:
                continue
            changes.append([(r.get("maker") or {}).get("name") or "", r.get("name") or "",
                            "-" if a is None else f"{a:g} {ca}", "-" if b is None else f"{b:g} {cb}",
                            "" if pct is None else f"{pct:+.1f}%"])
        md.append(t(f"**Makers' pages**: {c.get('read', 0)} of {c.get('pages', 0)} read, "
                    f"{c.get('price', 0)} prices and {c.get('stock', 0)} stock figures changed, "
                    f"{c.get('saved', 0)} saved, {c.get('failed', 0)} could not be read"
                    + (f", {c['busy']} left to an exploration running" if c.get("busy") else "") + ".",
                    f"**Üreticilerin sayfaları**: {c.get('pages', 0)} sayfadan {c.get('read', 0)} tanesi okundu, "
                    f"{c.get('price', 0)} fiyat ve {c.get('stock', 0)} stok bilgisi değişti, "
                    f"{c.get('saved', 0)} kaydedildi, {c.get('failed', 0)} okunamadı"
                    + (f", {c['busy']} tanesi süren bir keşfe bırakıldı" if c.get("busy") else "") + "."))
    boards = p["boards"]
    if boards:
        lcsc.PATIENT.set(True)
        asked, failed, moved = 0, [], 0
        for bid in boards:
            await ctx.say(f"LCSC offers for {bid}")
            try:
                lines = await bom_cost.board_lines(ctx.db, bid)
            except Exception as exc:                          # noqa: BLE001 - one board, said
                failed.append(f"{bid}: {str(exc)[:120]}")
                continue
            parts = sorted({ln["lcsc"] for ln in lines if ln.get("lcsc")})
            for part in bom_cost.to_refresh(parts):
                old = bom_cost.cached_offer(part) or {}
                try:
                    new = await bom_cost.fetch_offer(part)
                except lcsc.Refused as exc:
                    failed.append(t(f"LCSC is cooling off: {exc}", f"LCSC soğumayı bekliyor: {exc}"))
                    break
                except (OSError, ValueError, TimeoutError) as exc:
                    failed.append(f"{part}: {str(exc)[:80]}")
                    continue
                asked += 1
                a, b = bom_cost.unit_price(old.get("breaks") or [], 1)[0], bom_cost.unit_price(new.get("breaks") or [], 1)[0]
                if a and b and abs(b - a) / a * 100 >= max(p["min_change_pct"], 0.01):
                    moved += 1
                    changes.append(["LCSC", part, f"${a:.4f}", f"${b:.4f}", f"{(b - a) / a * 100:+.1f}%"])
                await ctx.say(f"LCSC {asked}")
        data["lcsc"] = {"asked": asked, "changed": moved, "failed": failed[:20]}
        md.append(t(f"**LCSC offers** for {len(boards)} {plural(len(boards), 'board')}: {asked} parts asked "
                    f"(those older than a day), {moved} prices moved"
                    + (f"; {len(failed)} problems: " + "; ".join(failed[:5]) if failed else "") + ".",
                    f"{len(boards)} kartın **LCSC teklifleri**: {asked} parça soruldu "
                    f"(bir günden eski olanlar), {moved} fiyat değişti"
                    + (f"; {len(failed)} sorun: " + "; ".join(failed[:5]) if failed else "") + "."))
    head = [t("Seller", "Satıcı"), t("Product", "Ürün"), t("Was", "Önceki"), t("Now", "Şimdi"), t("Change", "Değişim")]
    if changes:
        md += ["", table(head, changes[:200])]
    else:
        md.append(t("\nNo price changed" + (f" by {p['min_change_pct']:g}% or more" if p["min_change_pct"] else "") + ".",
                    "\n" + (f"%{p['min_change_pct']:g} ya da daha fazla değişen fiyat yok." if p["min_change_pct"]
                             else "Hiçbir fiyat değişmedi.")))
    data["changes"] = len(changes)
    return Outcome(t(f"{len(changes)} {plural(len(changes), 'price change')}", f"{len(changes)} fiyat değişimi"),
                   "\n".join(md), data, csv=to_csv(head, changes))


PRICES = Kind(
    "price_refresh", "Price refresh",
    "Reads the saved makers' product pages again (as Parts' \"Re-read all products\": robots.txt and a pause "
    "between requests) and the LCSC offers of chosen boards' parts, and lists the prices that changed.",
    [Param("makers", "bool", "Makers' pages", True, about="Re-read every saved product page"),
     Param("boards", "list", "Boards' LCSC prices", [], of="board", max_items=10,
           about="The LCSC offers of these boards' parts (older than a day)"),
     Param("only_stocked", "bool", "Only what is in stock", False, about="List changes only for products with a stock line"),
     Param("min_change_pct", "float", "Smallest change", 0, 0, 100, about="percent; smaller changes are left out")],
    price_refresh, right="draw", exclusive="makers", writes="refresh", timeout_s=3600, table=True)


# ================================================================= build refresh

async def build_refresh(ctx: Ctx, p: dict) -> Outcome:
    from .. import access, actors, buildjobs, release, store
    t = ctx.t
    rows, bad = [], 0
    for mid in p["models"]:
        if not await ctx.db.models.find_one({"_id": mid}, {"_id": 1}):
            rows.append([mid, t("not found", "bulunamadı"), "", ""])
            bad += 1
            continue
        await ctx.say(f"building {mid}")
        t0 = time.monotonic()
        try:
            version = await store.current_version(ctx.db, mid)
            job = await buildjobs.start(ctx.raw, mid, workspace=ctx.task["workspace"], by="schedule", version=version,
                                        actor=actors.CURRENT.get(), role=access.ROLE.get())
        except buildjobs.Busy as exc:
            job = exc.job
        while True:
            done = await buildjobs.get(ctx.raw, job["_id"])
            if not done or done.get("status") != "running":
                break
            await ctx.say(f"building {mid}")
            await asyncio.sleep(2)
        ok = bool(done and done.get("status") == "done")
        bad += 0 if ok else 1
        drawing = ""
        if ok and p["drawings"]:
            await ctx.say(f"drawing {mid}")
            try:
                await release.model_drawing(ctx.db, mid, again=True)
                drawing = t("made", "yapıldı")
            except Exception as exc:                          # noqa: BLE001 - said in the row
                drawing = t("failed", "olmadı") + f": {str(exc)[:80]}"
                bad += 1
        rows.append([mid, t("built", "derlendi") if ok else t("failed", "olmadı") + f": {str((done or {}).get('detail') or '')[:100]}",
                     f"{time.monotonic() - t0:.0f} " + t("s", "sn"), drawing])
    head = ["Model", t("Build", "Derleme"), t("Took", "Süre"), t("Drawing", "Çizim")]
    n = len(p["models"])
    return Outcome(t(f"{n - bad} of {n} built", f"{n} modelden {n - bad} tanesi derlendi") if not p["drawings"]
                   else t(f"{n} models, {bad} problems", f"{n} model, {bad} sorun"),
                   table(head, rows), {"models": n, "problems": bad}, csv=to_csv(head, rows), ok=bad == 0)


BUILDS = Kind(
    "build_refresh", "Build refresh",
    "Builds chosen models again (each in a process of its own), and makes their technical drawings anew if asked.",
    [Param("models", "list", "Models", [], of="model", max_items=10, required=True, max_len=300),
     Param("drawings", "bool", "Technical drawings too", False)],
    build_refresh, right="run", writes="refresh", timeout_s=3600)


# ================================================================= backup check

async def backup_check(ctx: Ctx, p: dict) -> Outcome:
    from .. import backups
    t, lang = ctx.t, ctx.lang
    st = await backups.state()
    if st.get("error") and not st.get("archives"):
        return Outcome(t("backups could not be read", "yedekler okunamadı"),
                       t(f"The backup folder could not be read: {st['error']}.", f"Yedek klasörü okunamadı: {st['error']}."),
                       {"error": st["error"]}, ok=False)
    h = st.get("health") or {}
    now = st.get("now") or time.time()
    newest = next((a for a in st.get("archives") or [] if a.get("newest")), None)
    dump = (st.get("dumps") or [None])[0]
    check = (st.get("checks") or [None])[0]
    disk = st.get("disk") or {}
    ok = bool(h.get("dump_ok") and h.get("fresh") and h.get("check_ok") is not False)
    lines = [f"**{t('Backups are fine', 'Yedekler iyi') if ok else t('Backups need a look', 'Yedeklere bakılmalı')}.**", ""]
    lines.append(t("- Newest nightly: ", "- En yeni gecelik: ") + (newest["name"] if newest else t("none", "yok"))
                 + (f", {ago(newest['mtime'], now, lang)}, {newest['size'] / 1e6:.1f} MB" if newest else ""))
    lines.append(t("- Last dump: ", "- Son döküm: ")
                 + (t("ok", "tamam") if dump and dump.get("ok") else t("FAILED", "OLMADI") if dump else t("none in the log", "günlükte yok"))
                 + (f" ({dump.get('at')})" if dump else ""))
    lines.append(t("- Restore check: ", "- Geri yükleme denetimi: ")
                 + (t("passed", "geçti") if check and check.get("ok") else t("FAILED", "OLMADI") if check else t("never run", "hiç çalışmadı"))
                 + (f" ({check.get('at')})" if check else ""))
    if h.get("plaintext"):
        lines.append(t(f"- {h['plaintext']} archives hold the saved secrets in plaintext (written before the secret key)",
                       f"- {h['plaintext']} arşiv kayıtlı gizli bilgileri düz metin olarak tutuyor (gizli anahtardan önce yazılmış)"))
    if disk.get("free") is not None:
        lines.append(t(f"- Disk free: {disk['free'] / 1e9:.1f} GB of {(disk.get('size') or 0) / 1e9:.1f} GB",
                       f"- Boş disk: {(disk.get('size') or 0) / 1e9:.1f} GB'ın {disk['free'] / 1e9:.1f} GB'ı"))
    if st.get("next_dump"):
        lines.append(t("- Next dump: ", "- Sonraki döküm: ")
                     + f"{datetime.fromtimestamp(st['next_dump'], timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC")
    summary = (t("fine", "iyi") if ok else t("needs a look", "bakılmalı")) \
        + (t(f", newest {ago(newest['mtime'], now)}", f", en yenisi {ago(newest['mtime'], now, lang)}") if newest
           else t(", no nightly archive", ", gecelik arşiv yok"))
    return Outcome(summary, "\n".join(lines), {"ok": ok, "health": h}, ok=True)


BACKUPS = Kind("backup_check", "Backup check",
               "The nightly database dumps: the newest and its age, the last dump, the restore check, the disk.",
               [], backup_check, right="settings", timeout_s=120)


# ================================================================= LLM usage

async def llm_usage(ctx: Ctx, p: dict) -> Outcome:
    from .. import scope, usage
    since = ctx.now - timedelta(days=p["days"])
    q = scope.within({"at": {"$gte": since.isoformat()}}, ctx.task["workspace"])
    rows = [r async for r in ctx.raw[usage.CALLS].find(q)]
    by_kind: dict[str, list] = {}
    by_model: dict[str, list] = {}
    total, calls, toks, unpriced = 0.0, 0, 0, 0
    for r in rows:
        c = r.get("cost_usd")
        t = int(r.get("input") or 0) + int(r.get("output") or 0) + int(r.get("cache_read") or 0) + int(r.get("cache_write") or 0)
        calls += 1
        toks += t
        if c is None:
            unpriced += 1
        total += float(c or 0)
        for key, bucket in ((r.get("kind") or r.get("surface") or "other", by_kind), (r.get("model") or "?", by_model)):
            b = bucket.setdefault(key, [0.0, 0, 0])
            b[0] += float(c or 0)
            b[1] += 1
            b[2] += t

    def top(bucket):
        return [[k, money(v[0]), v[1], f"{v[2]:,}"] for k, v in sorted(bucket.items(), key=lambda kv: -kv[1][0])[: p["top"]]]
    md = [ctx.t(f"**{money(total)}** over the last {p['days']} days: {calls:,} calls, {toks:,} tokens"
            + (f" ({unpriced} calls without a price)" if unpriced else "") + ".",
            f"Son {p['days']} günde **{money(total)}**: {calls:,} çağrı, {toks:,} token"
            + (f" ({unpriced} çağrının fiyatı yok)" if unpriced else "") + ".")]
    cols = [ctx.t("Cost", "Maliyet"), ctx.t("Calls", "Çağrı"), "Token" if ctx.lang == "tr" else "Tokens"]
    if rows:
        md += ["", ctx.t("By job:", "İşe göre:"), "", table([ctx.t("Job", "İş"), *cols], top(by_kind)),
               "", ctx.t("By model:", "Modele göre:"), "", table(["Model", *cols], top(by_model))]
    head = ["Model", ctx.t("Cost USD", "Maliyet USD"), cols[1], cols[2]]
    flat = [[k, round(v[0], 6), v[1], v[2]] for k, v in sorted(by_model.items(), key=lambda kv: -kv[1][0])]
    return Outcome(ctx.t(f"{money(total)} in {p['days']} days, {calls:,} calls", f"{p['days']} günde {money(total)}, {calls:,} çağrı"),
                   "\n".join(md),
                   {"usd": round(total, 6), "calls": calls, "tokens": toks}, csv=to_csv(head, flat))


USAGE = Kind("llm_usage", "LLM cost summary",
             "What the app's model calls cost in this space over the last days: by job and by model.",
             [Param("days", "int", "Days", 7, 1, 31), Param("top", "int", "Rows", 8, 3, 20, about="per table")],
             llm_usage, right="draw", timeout_s=120, table=True)


# ================================================================= Command Code window

async def cc_usage(ctx: Ctx, p: dict) -> Outcome:
    from .. import llm
    t = ctx.t
    acct = await llm.cc_account(ctx.raw, force=True)
    if not acct.get("set"):
        return Outcome(t("no Command Code key", "Command Code anahtarı yok"),
                       t("No Command Code key is saved (Settings > LLM settings).",
                         "Kayıtlı Command Code anahtarı yok (Ayarlar > LLM ayarları)."), {}, ok=False)
    w = acct.get("windows") or {}
    lines, worst = [], 0.0
    for key, name in (("five_hour", t("5-hour window", "5 saatlik pencere")), ("weekly", t("Weekly window", "Haftalık pencere")),
                      ("monthly", t("Month", "Ay"))):
        x = w.get(key) or None
        if not x:
            continue
        pct = x.get("pct")
        if pct is None and x.get("used") is not None and x.get("cap"):
            pct = round(100 * x["used"] / x["cap"], 1)
        worst = max(worst, float(pct or 0))
        reset = x.get("reset_at")
        when = datetime.fromtimestamp(reset / 1000, timezone.utc).strftime("%a %d %b %H:%M UTC") if isinstance(reset, (int, float)) else ""
        lines.append(f"- {name}: **{'-' if pct is None else f'{pct:g}%'}** " + t("used", "kullanıldı")
                     + (t(f" ({x.get('used'):g} of {x.get('cap'):g})", f" ({x.get('cap'):g} içinden {x.get('used'):g})")
                        if x.get("used") is not None and x.get("cap") else "")
                     + (t(f", resets {when}", f", sıfırlanma {when}") if when else "")
                     + (t(" - EXCEEDED", " - AŞILDI") if x.get("exceeded") else ""))
    if not lines:
        return Outcome(t("Command Code did not say", "Command Code söylemedi"),
                       t("Command Code did not give its usage windows this time.",
                         "Command Code bu sefer kullanım pencerelerini vermedi."), {}, ok=False)
    plan = (acct.get("plan") or {}).get("name")
    md = ["**Command Code**" + (f" ({plan})" if plan else "") + ":", "", *lines]
    return Outcome(t(f"highest window {worst:g}%", f"en yüksek pencere %{worst:g}"), "\n".join(md), {"windows": w, "worst_pct": worst})


CCUSAGE = Kind("cc_usage", "Command Code usage",
               "The Command Code account's usage windows: the 5-hour, the weekly and the month, and when each resets.",
               [], cc_usage, right="draw", timeout_s=60)


# ================================================================= ask the chat

ASK_ROUNDS = 6
ASK_TOKENS = 4000
ASK_SYSTEM = ("You are answering a scheduled request on its owner's behalf; nobody is watching live. "
              "Use the tools you are given to read what you need, then answer once, in Markdown, short and "
              "complete. You cannot change anything: your tools only read.")


def ask_tools(enabled: list) -> dict:
    """The tools an asked question may use: only the read-level ones."""
    return {t.name: t for t in enabled if t.level == "read"}


async def ask_chat(ctx: Ctx, p: dict) -> Outcome:
    from .. import chat_tools, llm
    if not p["accept_cost"]:
        raise Bad("this task spends money on a model: accept the cost first")
    provider, model = p["provider"], p["model"]
    if not provider or not model:
        provider, model = llm.route("chat")
    mine = ask_tools(await chat_tools.enabled(ctx.db, ctx.owner.get("id")))
    tools = {n: mine[n] for n in p["tools"] if n in mine}
    missing = [n for n in p["tools"] if n not in mine]
    tctx = chat_tools.Ctx(db=ctx.db, vision=False, actor={**ctx.owner, "via": "schedule"}, chat="")
    from .. import prompts
    system = prompts.text("scheduled_ask") + (" Answer in Turkish." if ctx.lang == "tr" else "")
    msgs = [{"role": "system", "content": system + ("\n\n" + prompts.tools_note(list(tools.values())) if tools else "")},
            {"role": "user", "content": p["prompt"]}]
    text, used_all, steps = "", {}, []
    stopped = ""
    for rnd in range(ASK_ROUNDS + 1):
        calls, said, turn, used = [], "", [], {}
        kw = {"tools": [t.spec() for t in tools.values()]} if tools and rnd < ASK_ROUNDS else {}
        async for piece in llm.stream(msgs, provider=provider, model=model, max_tokens=ASK_TOKENS, **kw):
            if "text" in piece:
                said += piece["text"] or ""
            elif "calls" in piece:
                calls = piece["calls"] or []
            elif "blocks" in piece:
                turn = piece["blocks"] or []
            elif "usage" in piece:
                used = piece["usage"] or {}
        cost = used.get("cost")
        if cost is None and provider == "claude":
            cost = llm.claude_cost(model, used)
        ctx.spent += float(cost or 0)
        for k, v in used.items():
            if isinstance(v, (int, float)):
                used_all[k] = (used_all.get(k) or 0) + v
        if used:
            await llm.record(ctx.db, provider=provider, model=model, surface="schedule", kind="sched-chat", used=used)
        text += said
        if not calls or not kw:
            break
        if ctx.spent >= p["max_usd"]:
            stopped = ctx.t(f"stopped: the run's cost cap ({money(p['max_usd'])}) was reached",
                            f"durduruldu: çalışmanın maliyet sınırına ({money(p['max_usd'])}) ulaşıldı")
            break
        msgs.append({"role": "assistant", "content": said, "tool_calls": [
            {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
            for c in calls], **({"blocks": turn} if turn else {})})
        for c in calls:
            tool = tools.get(c.get("name"))
            try:
                args = json.loads(c.get("arguments") or "{}")
            except ValueError:
                args = {}
            await ctx.say(f"tool {c.get('name')}")
            if tool is None:
                content, err = f"Error: there is no tool {c.get('name')!r}.", True
            else:
                try:
                    res = await asyncio.wait_for(tool.run(tctx, args if isinstance(args, dict) else {}), 120)
                    content, err = chat_tools.clip(res.text), False
                except Exception as exc:                      # noqa: BLE001 - the model is told
                    content, err = f"Error: {str(exc)[:300] or type(exc).__name__}", True
            steps.append({"tool": c.get("name"), "error": err})
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": content, **({"is_error": True} if err else {})})
    md = text.strip() or ctx.t("(no answer)", "(cevap yok)")
    if stopped:
        md += f"\n\n_{stopped}_"
    if missing:
        md += ctx.t(f"\n\n_Tools not used (off for you, or not read-only): {', '.join(missing)}_",
                    f"\n\n_Kullanılmayan araçlar (sizde kapalı ya da salt okunur değil): {', '.join(missing)}_")
    first = next((ln.strip("# ").strip() for ln in md.splitlines() if ln.strip()), "")
    return Outcome(first[:140] or ctx.t("answered", "cevaplandı"), md, {"provider": provider, "model": model, "steps": steps,
                                                   "tokens": used_all.get("prompt_tokens", 0) + used_all.get("completion_tokens", 0)},
                   cost_usd=round(ctx.spent, 6))


ASK = Kind(
    "ask_chat", "Ask the Chat",
    "A saved question answered by a model you choose, with read-only tools you choose; the answer is sent to you. "
    "It costs money every time it runs.",
    [Param("prompt", "text", "Question", "", required=True, max_len=4000),
     Param("provider", "str", "Provider", "", max_len=40, about="Empty: the Chat's model"),
     Param("model", "str", "Model", "", max_len=120, about="Empty: the Chat's model"),
     Param("tools", "list", "Tools", [], of="tool", max_items=12, max_len=60, about="read-only tools only"),
     Param("max_usd", "float", "Cost cap per run", 0.05, 0.01, 2, about="USD; the answer stops when it is passed"),
     Param("accept_cost", "bool", "I accept the cost", False, about="Each run spends money on the model")],
    ask_chat, right="draw", llm=True, rerun_safe=False, timeout_s=600)


# ================================================================= digest

DIGEST_PARTS = ("stock_report", "llm_usage", "cc_usage", "backup_check")


async def digest(ctx: Ctx, p: dict) -> Outcome:
    out_md, summary, data, ok = [], [], {}, True
    for k in p["parts"]:
        kind = KINDS[k]
        label = ctx.t(kind.label, LABELS_TR.get(kind.id, kind.label))
        await ctx.say(kind.label)
        try:
            o = await kind.run(ctx, kind.check({}))
        except Exception as exc:                              # noqa: BLE001 - one part, said
            failed = ctx.t("failed", "olmadı")
            o = Outcome(failed, f"_{failed}: {str(exc)[:200]}_", ok=False)
        ok = ok and o.ok
        out_md += [f"## {label}", "", o.markdown, ""]
        summary.append(f"{label}: {o.summary}")
        data[k] = o.data
    return Outcome("; ".join(summary)[:300], "\n".join(out_md).strip(), data, ok=ok)


DIGEST = Kind("digest", "Digest",
              "Several reports in one message: stock, LLM costs, Command Code usage, backups.",
              [Param("parts", "list", "Reports", list(DIGEST_PARTS[:2]), choices=DIGEST_PARTS, required=True, max_items=4)],
              digest, right="draw", timeout_s=300)


# The types' names in Turkish, for a report's headings (the page has its own, i18n.ts).
LABELS_TR = {"stock_report": "Stok raporu", "price_refresh": "Fiyat yenileme", "build_refresh": "Derleme yenileme",
             "backup_check": "Yedek kontrolü", "llm_usage": "LLM maliyet özeti", "cc_usage": "Command Code kullanımı",
             "ask_chat": "Sohbete sor", "digest": "Özet"}

KINDS: dict[str, Kind] = {k.id: k for k in (STOCK, PRICES, BUILDS, BACKUPS, USAGE, CCUSAGE, ASK, DIGEST)}
RIGHT_ORDER = ("view", "draw", "run", "edit", "settings")


def right_of(kind_id: str, params: dict | None = None) -> str:
    """The right a task of this kind needs: a digest the strictest of its parts'."""
    k = KINDS[kind_id]
    if kind_id == "digest":
        parts = (params or {}).get("parts") or []
        rights = [KINDS[x].right for x in parts if x in KINDS] or [k.right]
        return max(rights, key=RIGHT_ORDER.index)
    return k.right


def get(kind_id: str) -> Kind:
    k = KINDS.get(kind_id)
    if not k:
        raise Bad("no task type " + repr(kind_id) + "; one of " + ", ".join(KINDS))
    return k
