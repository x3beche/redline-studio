"""The Chat's tools that do what another tab already does (backend/chat_tools:
price_history, stock_low, files_search, files_restore, taste_propose,
manufacturer_explore, dm_read, dm_send, settings_read).

What matters: each reads and writes what its tab reads and writes, with the
rights the tab's routes need; what it hands back is bounded; a tool that
writes, launches or sends asks first (and nothing runs without a yes); what
it writes in the workspace is undone by the Chat's undo; an exploration
never starts while another one goes on, nor on McMaster-Carr or GrabCAD;
Settings are read without a key or a key's last characters. Everything
runs on the tests' fake databases: no network, no crawl, no model."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend import access, actors, ccgen, chat_tools, chat_undo, files, files_virtual, llm, taste
from backend import inventory as inv
from backend import manufacturers as mf
from backend.chat_tools import Ctx, ToolError
from tests.test_chat_undo import ME, call, changes, run, undo, ws  # noqa: F401 - ws is a fixture
from tests.test_dm import db as dmdb  # noqa: F401 - a fixture

NAMES = ("price_history", "stock_low", "files_search", "files_restore", "taste_propose", "manufacturer_explore",
         "dm_read", "dm_send", "settings_read")
YOU = {"id": "u-you", "name": "You", "type": "person"}


def tool(name):
    return chat_tools.tools()[name]


def now(**kw) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kw)).isoformat()


# ---- how they are made ----------------------------------------------------------------

def test_their_packages_levels_defaults_and_who_asks_first():
    got = {n: (t.package, t.level, t.default) for n, t in chat_tools.tools().items() if n in NAMES}
    assert got == {"price_history": ("mfr", "read", True), "stock_low": ("mfr", "change", True),
                   "files_search": ("files", "read", True), "files_restore": ("files", "change", True),
                   "taste_propose": ("taste", "change", True), "manufacturer_explore": ("mfr", "change", False),
                   "dm_read": ("commandcode", "read", False), "dm_send": ("commandcode", "change", False),
                   "settings_read": ("general", "read", True)}
    # Writing, launching and sending ask every time; stock_low only when it puts things on a list.
    for n in ("files_restore", "taste_propose", "manufacturer_explore", "dm_send"):
        assert tool(n).asks and tool(n).asks({}), n
    assert tool("stock_low").asks({"add": True}) and not tool("stock_low").asks({})
    for n in ("price_history", "files_search", "dm_read", "settings_read"):
        assert tool(n).asks is None, n
    for n in NAMES:
        assert n in chat_tools.SYSTEM_NOTE, n


def test_their_sentences_are_in_turkish_and_they_have_icons_and_packages():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()
    for n in NAMES:
        t = tool(n)
        for s in (t.label, t.about, t.running, t.failed):
            assert f"'{s}':" in tr or f'"{s}":' in tr, (n, s)
        assert f"{n}:" in icons, n
    from backend import cc_tools
    assert cc_tools.group_of(tool("dm_send")) == "dm" and cc_tools.group_of(tool("settings_read")) == "settings"
    assert cc_tools.group_of(tool("stock_low")) == "stock" and cc_tools.group_of(tool("price_history")) == "parts"
    assert cc_tools.groups_in("Bora bana ne mesaj yazdı?") == {"dm"}
    assert "settings" in cc_tools.groups_in("dün geceki yedek çalıştı mı?")
    readme = open("backend/chat_tools/README.md", encoding="utf-8").read()
    for n in NAMES:
        assert f"`{n}`" in readme, n


def test_a_tool_that_asks_runs_nothing_without_a_yes(monkeypatch):
    ran = []

    async def handler(ctx, args):
        ran.append(args)
        return chat_tools.Result(text="sent", say="sent")
    t = chat_tools.Tool(name="dm_send", description="d", schema={"type": "object"}, level="change", run=handler,
                        running="r", failed="f", asks=lambda a: True, undo="words")
    out = {"text": "", "steps": [], "rev": 0, "answers": {}}

    async def go():
        task = asyncio.create_task(ccgen.run_step({"name": "dm_send", "arguments": '{"person": "Bora", "text": "hi"}'},
                                                  {"dm_send": t}, Ctx(db=None), out))
        while not out["steps"] or out["steps"][0]["status"] != "ask":
            await asyncio.sleep(0.01)
        out["answers"][out["steps"][0]["id"]] = False
        return await task
    monkeypatch.setattr(ccgen, "FLUSH", 0.01, raising=False)
    said, err = asyncio.run(go())
    assert err and "did not allow" in said and not ran and out["steps"][0]["status"] == "denied"
    # the args the card shows before Allow are the step's own, whole
    assert out["steps"][0]["args"] == {"person": "Bora", "text": "hi"}


# ---- price_history -------------------------------------------------------------------

def _product(rows):
    return ({"_id": "m1", "name": "Robo90", "domain": "robo90.com"},
            {"id": "p1", "name": "UB0228 Vida M3x30", "url": "https://www.robo90.com/ub0228",
             "price": {"amount": 12.0, "currency": "TRY", "source": "ld"}, "history": rows})


def test_price_history_reads_the_charts_rows_with_a_trend(ws, monkeypatch):
    db, _, state = ws
    rows = [{"at": f"2026-0{m}-01T10:00:00+00:00", "amount": a, "currency": "TRY", "stock": "in", "qty": q}
            for m, a, q in ((1, 10.0, 50), (2, 12.5, 40), (3, 9.0, 0), (4, 12.0, 30))]
    from backend.chat_tools import price_history as ph

    async def resolve(ctx, product, manufacturer=""):
        return _product(rows)
    monkeypatch.setattr(ph, "resolve", resolve)
    r = call(db, "price_history", {"product": "UB0228"})
    assert "lowest 9.00, highest 12.50, last 12.00, +20.0% from the first reading" in r.text
    assert r.text.count(" | TRY | ") == 4 and "/parts/m1/p1" in r.text
    assert r.vars["spark"] == "28 99 0 85"
    assert r.vars["change"] == "+20.0%" and r.vars["cur"] == "TRY"
    # bounded: at most the product's HISTORY rows, and a short text
    many = [{"at": f"2026-01-{d:02d}T00:00:00+00:00", "amount": float(d), "currency": "TRY"} for d in range(1, 29)]
    monkeypatch.setattr(ph, "resolve", lambda *a, **k: asyncio.sleep(0, _product(many)))
    r = call(db, "price_history", {"product": "UB0228"})
    assert r.text.count(" | TRY | ") == mf.HISTORY and len(r.text) < 6_100
    # none kept: said so
    monkeypatch.setattr(ph, "resolve", lambda *a, **k: asyncio.sleep(0, _product([])))
    assert "No price or stock readings" in call(db, "price_history", {"product": "UB0228"}).text
    # its right is the Parts page's GET: nobody without one reads it
    state["role"] = None
    with pytest.raises(ToolError):
        call(db, "price_history", {"product": "UB0228"})


# ---- stock_low -----------------------------------------------------------------------

def _line(db, _id, name, qty, lo, maker, log=()):
    run(db[inv.COLL].insert_one({"_id": _id, "name": name, "quantity": qty, "unit": "pcs", "min_stock": lo,
                                  "catalog": {"manufacturer": "m1", "product": _id, "manufacturer_name": maker},
                                  "log": list(log)}))


def test_stock_low_lists_the_low_lines_by_seller_with_reorder_quantities(ws, monkeypatch):
    db, fake, state = ws
    used = [{"at": now(days=-10), "kind": "adjusted", "delta": -30}, {"at": now(days=-40), "kind": "adjusted", "delta": -30}]
    _line(db, "a", "M3 screw", 5, 10, "Robo90", used)            # low, with a month's use
    _line(db, "b", "M3 nut", 2, 4, "Robo90")                     # low, minimum only
    _line(db, "c", "Bearing", 0, 0, "Other")                     # low at a minimum of 0: says what is missing
    _line(db, "d", "Spring", 50, 10, "Robo90")                   # not low
    r = call(db, "stock_low", {})
    assert r.vars == {"n": 3, "sellers": 2, "reorder": 2, "missing": 1}
    assert r.text.index("Other:") < r.text.index("Robo90:")                  # sellers by name
    assert "a  M3 screw: 5 pcs on hand, minimum 10 -> reorder" in r.text
    assert "b  M3 nut: 2 pcs on hand, minimum 4 -> reorder 6 pcs (up to twice the minimum" in r.text
    assert "c  Bearing" in r.text and "no reorder quantity: missing a minimum above 0" in r.text
    assert "Spring" not in r.text
    assert not fake[chat_undo.COLL].docs                         # reading keeps nothing
    # a threshold counts lines at or below it too
    assert call(db, "stock_low", {"threshold": 60}).vars["n"] == 4
    # add: shopping_list's own path, with the reorder lines
    from backend.chat_tools import shopping_list
    got = {}

    async def fake_list(ctx, args):
        got.update(args)
        return chat_tools.Result(text="list", say="x", vars={"file": "f1", "name": "list.md", "total": "1 TRY"})
    monkeypatch.setattr(shopping_list, "run", fake_list)
    r = call(db, "stock_low", {"add": True})
    qty = {i["name"]: i["qty"] for i in got["items"]}
    assert set(qty) == {"M3 screw", "M3 nut"} and qty["M3 nut"] == 6 and qty["M3 screw"] >= 15
    assert got["export"] == "md" and r.vars["file"] == "f1"
    # a viewer reads it
    state["role"] = "viewer"
    assert call(db, "stock_low", {}).vars["n"] == 3


# ---- files_search / files_restore ------------------------------------------------------

def _file(db, fid, name, folder="", by=ME, context=None, coll=files.COLL, **kw):
    run(db[coll].insert_one({"_id": fid, "name": name, "kind": files.kind_of(name), "bytes": 1000, "folder": folder,
                             "created_at": now(), "by": dict(by), "context": context or {}, "note": "",
                             "gridfs_id": "g-" + fid, **kw}))


def test_files_search_looks_where_the_tab_does(ws, monkeypatch):
    db, _, state = ws
    monkeypatch.setattr(files_virtual, "tree", lambda d: asyncio.sleep(0, {"folders": [], "links": [], "files": [
        {"id": "v:ms:x", "name": "fan-case.step", "folder": "v:projects", "kind": "step", "bytes": 10,
         "created_at": "", "where": "projects"}]}))
    _file(db, "f1", "Fan BOM.csv")
    _file(db, "f2", "fan datasheet.pdf", context={"product": "m1:p1"})          # Parts' own: In the app
    _file(db, "f3", "old fan.pdf", coll=files.TRASH, deleted_at=now(), purge_at=now(days=20), folder_path="Docs")
    hits = {r: call(db, "files_search", {"query": "FAN", "area": r}).vars for r in ("mine", "app", "deleted", "all")}
    assert (hits["mine"]["n"], hits["app"]["n"], hits["deleted"]["n"], hits["all"]["n"]) == (1, 2, 1, 4)
    r = call(db, "files_search", {"query": "fan", "area": "all", "kind": "pdf"})
    assert r.vars["n"] == 2 and "/files/deleted" in r.text and "/api/files/f2" in r.text
    with pytest.raises(ToolError):
        call(db, "files_search", {"query": "fan", "area": "elsewhere"})
    # bounded: SHOW files named, the rest counted
    for i in range(60):
        _file(db, f"n{i}", f"note {i}.txt")
    r = call(db, "files_search", {"query": "note", "area": "mine"})
    assert r.vars["n"] == 60 and "and 20 more" in r.text and r.text.count("place: ") == 40
    state["role"] = None
    with pytest.raises(ToolError):
        call(db, "files_search", {"query": "fan"})


def test_files_restore_brings_a_deleted_file_back_and_undo_deletes_it_again(ws):
    db, fake, state = ws
    _file(db, "t1", "drawing.pdf", coll=files.TRASH, deleted_at=now(days=-2), purge_at=now(days=28))
    _file(db, "t2", "theirs.pdf", by=YOU, coll=files.TRASH, deleted_at=now(), purge_at=now(days=30))
    _file(db, "t3", "expired.pdf", coll=files.TRASH, deleted_at=now(days=-40), purge_at=now(days=-10))
    r = call(db, "files_restore", {"file": "drawing"}, step="r1")
    assert r.vars["file"] == "t1" and run(db[files.COLL].find_one({"_id": "t1"}))
    assert not run(db[files.TRASH].find_one({"_id": "t1"}))
    # someone else's needs the right to delete, as the route says
    with pytest.raises(ToolError, match="theirs.pdf is someone else's"):
        call(db, "files_restore", {"file": "t2"})
    state["role"] = "admin"
    assert call(db, "files_restore", {"file": "t2"}).vars["file"] == "t2"
    # past its 30 days it is gone for good
    with pytest.raises(ToolError, match="no deleted file"):
        call(db, "files_restore", {"file": "t3"})
    # undo: back among the Deleted files, as it was
    c = next(c for c in changes(db) if c["tool"] == "files_restore" and c["step"] == "r1")
    undo(c["id"])
    assert run(db[files.TRASH].find_one({"_id": "t1"})) and not run(db[files.COLL].find_one({"_id": "t1"}))


# ---- taste_propose ------------------------------------------------------------------

def test_taste_propose_waits_in_the_taste_tab_and_is_undone(ws):
    db, fake, _ = ws
    run(db[taste.COLL].insert_one({"_id": "pal1", "name": "Enclosures", "items": []}))
    r = call(db, "taste_propose", {"text": "Outside edges filleted 1 mm", "strength": "prefer", "scope": "visible",
                                   "palette": "Enclosures"}, step="t1")
    (job,) = run(db[taste.JOBS].find({}).to_list(None))
    assert job["status"] == "done" and job["project"] == {"kind": "chat", "id": "c1", "label": "Chat"}
    assert job["proposals"][0]["text"] == "Outside edges filleted 1 mm" and job["proposals"][0]["applies_to"] == "visible"
    assert job["target"] == {"id": "pal1", "name": "Enclosures"} and r.vars["link"] == f"/taste/run/{job['_id']}"
    assert not run(db[taste.COLL].find_one({"_id": "pal1"}))["items"]          # nothing in the palette yet
    call(db, "taste_propose", {"text": "No glossy plastics", "strength": "avoid"}, step="t2")
    job = run(db[taste.JOBS].find_one({"_id": job["_id"]}))
    assert [p["strength"] for p in job["proposals"]] == ["prefer", "avoid"]
    with pytest.raises(ToolError):
        call(db, "taste_propose", {"text": "x", "strength": "must"})
    undo(next(c["id"] for c in changes(db) if c["step"] == "t2"))
    assert len(run(db[taste.JOBS].find_one({"_id": job["_id"]}))["proposals"]) == 1
    undo(next(c["id"] for c in changes(db) if c["step"] == "t1"))
    assert not run(db[taste.JOBS].find_one({"_id": job["_id"]}))


# ---- manufacturer_explore -------------------------------------------------------------

def test_manufacturer_explore_refuses_mcmaster_grabcad_and_a_second_run(ws, monkeypatch):
    db, fake, _ = ws
    started = []

    async def start_job(d, mid, route=None, by=None, *a, **kw):
        started.append(mid)
        return {"_id": "j1", "status": "queued", "manufacturer": {"id": mid}}, True

    async def no_net(url):
        raise AssertionError("no network in the tests")
    monkeypatch.setattr(mf, "start_job", start_job)
    monkeypatch.setattr(mf, "check", no_net)
    for url in ("https://www.mcmaster.com/91290A115/", "grabcad.com/library/fan-1"):
        with pytest.raises(ToolError, match="never crawled"):
            call(db, "manufacturer_explore", {"url": url})
    run(db[mf.COLL].insert_one({"_id": "mc", "name": "McM", "domain": "mcmaster.com", "url": "https://www.mcmaster.com/"}))
    with pytest.raises(ToolError, match="never crawled"):
        call(db, "manufacturer_explore", {"manufacturer": "mc"})
    # a run going on (alive: another process, beating) - here or in another workspace: nothing starts
    alive = {"status": "crawling", "worker": {"host": "elsewhere", "pid": 1, "boot": "x"}, "beat": now(),
             "started_at": now(), "manufacturer": {"id": "m1", "name": "Robo90"}}
    run(db[mf.JOBS].insert_one({"_id": "jbusy", **alive}))
    with pytest.raises(ToolError, match="Robo90 is crawling"):
        call(db, "manufacturer_explore", {"manufacturer": "Robo90"})
    run(db[mf.JOBS].delete_one({"_id": "jbusy"}))
    run(fake[mf.JOBS].insert_one({"_id": "jother", "workspace_id": "other-space", **alive}))
    with pytest.raises(ToolError, match="another workspace"):
        call(db, "manufacturer_explore", {"manufacturer": "Robo90"})
    assert not started
    run(fake[mf.JOBS].delete_one({"_id": "jother"}))
    r = call(db, "manufacturer_explore", {"manufacturer": "Robo90"})
    assert started == ["m1"] and r.vars["run"] == "j1" and r.vars["status"] == "queued" and "/parts/run/j1" in r.text
    assert isinstance(tool("manufacturer_explore").undo, str)


# ---- dm_read / dm_send ----------------------------------------------------------------

def _as(uid, name):
    return actors.CURRENT.set({"id": uid, "name": name, "type": "user"})


def test_dm_send_writes_to_the_person_named_whole_and_dm_read_reads_it(dmdb, monkeypatch):
    from backend import dm
    monkeypatch.setattr(access, "current", lambda: "user")
    tok = _as("u-ayse", "Ayşe")
    try:
        assert "No direct conversations" in run(tool("dm_read").run(Ctx(db=None), {})).text
        with pytest.raises(ToolError, match="whole name"):
            run(tool("dm_send").run(Ctx(db=None), {"person": "bor", "text": "hello"}))
        r = run(tool("dm_send").run(Ctx(db=None), {"person": "bora", "text": "Kart yarın hazır."}))
        assert r.vars["name"] == "Bora"
        cid = r.vars["thread"]
        (line,) = run(dmdb[dm.MSGS].find({}).to_list(None))
        assert line["text"] == "Kart yarın hazır." and line["chat"] == cid
        with pytest.raises(ToolError, match="disabled|nobody"):
            run(tool("dm_send").run(Ctx(db=None), {"person": "Gone", "text": "x"}))
    finally:
        actors.CURRENT.reset(tok)
    tok = _as("u-bora", "Bora")
    try:
        lst = run(tool("dm_read").run(Ctx(db=None), {}))
        assert lst.vars == {"n": 1, "unread": 1}
        r = run(tool("dm_read").run(Ctx(db=None), {"person": "Ayşe", "limit": 500}))
        assert r.vars["n"] == 1 and "Ayşe: Kart yarın hazır." in r.text
        assert "1 unread" in r.text                                       # reading here marks nothing read
    finally:
        actors.CURRENT.reset(tok)
    tok = _as("u-cem", "Cem")                                             # not a member: the routes' own 404
    try:
        with pytest.raises(ToolError, match="no such conversation"):
            run(tool("dm_read").run(Ctx(db=None), {"person": cid}))
    finally:
        actors.CURRENT.reset(tok)
    tok = actors.CURRENT.set(actors.agent("bot"))                         # only people
    try:
        with pytest.raises(ToolError, match="between people"):
            run(tool("dm_read").run(Ctx(db=None), {}))
    finally:
        actors.CURRENT.reset(tok)


# ---- settings_read ---------------------------------------------------------------------

def test_settings_read_names_the_models_and_never_a_key(ws, monkeypatch):
    db, _, state = ws
    secret = "sk-or-v1-0123456789abcdefWXYZ"
    monkeypatch.setattr(llm, "public", lambda: {
        "providers": {"openrouter": {"name": "OpenRouter", "set": True, "hint": "…" + secret[-4:], "source": "db"},
                      "claude": {"name": "Claude", "set": False, "hint": None, "source": None}},
        "jobs": {"chat": {"label": "Chat room", "provider": "openrouter", "model": "x/model-a",
                          "default": {"provider": "openrouter", "model": "x/model-a"}},
                 "taste": {"label": "Taste extraction", "provider": "claude", "model": "claude-x",
                           "default": {"provider": "openrouter", "model": "y"}}}})
    from backend import llm_api
    monkeypatch.setattr(llm_api, "summary", lambda days=14: asyncio.sleep(0, {
        "month": {"calls": 120, "input": 9000, "output": 1000, "tokens": 10000, "cost_usd": 3.5},
        "today": {"calls": 4, "tokens": 300, "cost_usd": 0.1}}))
    monkeypatch.setattr(llm_api, "usage", lambda provider="all", days=30: asyncio.sleep(0, {
        "days": days, "by_kind": [{"name": "Chat room", "calls": 100, "cost_usd": 3.0}],
        "by_model": [{"name": "x/model-a", "calls": 100, "cost_usd": 3.0}], "by_provider": [], "unpriced_providers": []}))
    from backend import backups
    monkeypatch.setattr(backups, "state", lambda: asyncio.sleep(0, {
        "schedule": {"at": "03:30", "tz": "Europe/Istanbul", "keep_days": 7},
        "archives": [{"name": "redline-2026-10-14_0330.archive.gz", "kind": "nightly", "newest": True}],
        "dumps": [{"ok": True, "at": "2026-10-14T03:31"}], "checks": [{"ok": False, "archive": "redline-2026-10-12_0330.archive.gz",
                                                                        "at": "2026-10-12T04:00"}],
        "health": {"dump_ok": True, "fresh": True, "newest_age_s": 3600 * 5, "check_ok": False, "plaintext": 0},
        "key": {"fingerprint": "abcdef123456"}}))
    r = call(db, "settings_read", {})
    assert "Chat room (chat): OpenRouter / x/model-a" in r.text and "its provider has no key" in r.text
    assert "$3.50" in r.text and "Chat room $3.00" in r.text
    assert "only the owner and the admins" in r.text and "Last restore check" not in r.text
    for leak in (secret, secret[-4:], "hint", "abcdef123456"):
        assert leak not in r.text and leak not in str(r.vars) and leak not in r.summary
    state["role"] = "admin"
    r = call(db, "settings_read", {"what": "backups"})
    assert "Last restore check: FAILED" in r.text and "redline-2026-10-14_0330" in r.text
    assert "abcdef123456" not in r.text and r.vars["backup"] == "check"
    state["role"] = "user"
    assert "only the owner and the admins" in call(db, "settings_read", {"what": "backups"}).text
