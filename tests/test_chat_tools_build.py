"""The Chat's build tools (backend/chat_tools: build_count, shopping_list,
stock_consume; their shared part _build.py).

What matters: a board's BOM lines (or an assembly's bought parts) are set
against the stock lines that count the same product, LCSC number or MPN;
the number of whole builds, the parts that limit it and the shortfall for a
target come out right; the purchase list takes the cheapest seller per line
in the display currency (LCSC price breaks and least quantities, a site's
price in its own currency, McMaster-Carr's pack price), with the totals per
seller and a CSV kept in Files; taking stock for builds asks first, is all
or nothing and writes "used N for ..." in each line's log. Fake databases,
no LCSC, no model."""

from __future__ import annotations

import pytest

from backend import access, actors, bom_cost, chat_tools, files, fx, scope
from backend import inventory as inv
from backend.chat_tools import Ctx, ToolError
from backend.chat_tools import _build as b
from test_telegram import FakeDb
from tests.test_chat_tools import run

ME = {"id": "u-me", "name": "Me", "type": "person"}
NAMES = ("build_count", "shopping_list", "stock_consume")

LINES = [  # what bom_cost.board_lines gives for the fan board
    {"lcsc": "C25744", "refs": ["R1", "R2", "R3", "R4"], "qty": 4, "value": "10k", "bom_mpn": "0603WAF1002T5E"},
    {"lcsc": "C2040", "refs": ["U1"], "qty": 1, "value": "RP2040", "bom_mpn": "RP2040"},
    {"lcsc": None, "refs": ["J1"], "qty": 1, "value": "USB-C", "bom_mpn": "TYPE-C-31-M-12"},
]

SITE = {"_id": "robo", "name": "robotistan.com", "products": [
    {"id": "p-usb", "name": "USB-C socket 16p", "sku": "TYPE-C-31-M-12", "url": "https://robo.example/usb",
     "price": {"amount": 20.0, "currency": "TRY", "vat": "incl"}},
    {"id": "p-rp", "name": "RP2040 chip", "sku": "RP2040", "price": {"amount": 1.5, "currency": "EUR"}}]}
MCM = {"_id": "mcmaster", "name": "McMaster-Carr", "builtin": True, "products": [
    {"id": "91290A115", "name": "M3x8 socket screw", "sku": "91290A115", "url": "https://www.mcmaster.com/91290A115/",
     "specs": {"Price": "$12.00 per pack of 100"}}]}
DRAWER = {"_id": "lcsc", "name": "LCSC", "builtin": True, "products": [
    {"id": "C25744", "name": "10k 0603", "part": {"min": 100}, "price": {"amount": 0.002, "currency": "USD"}},
    {"id": "C2040", "name": "RP2040", "part": {"min": 1}}]}


def _tool(name):
    return chat_tools.tools()[name]


@pytest.fixture
def ws(monkeypatch):
    fake = FakeDb()
    state = {"role": "reviewer"}
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(actors, "current", lambda: ME)
    db = scope.ScopedDb(fake, "default")
    run(db["boards"].insert_one({"_id": "fan-board", "title": "Fan board"}))

    async def lines(db_, bid):
        if bid != "fan-board":
            raise KeyError(bid)
        return [dict(x) for x in LINES]
    monkeypatch.setattr(bom_cost, "board_lines", lines)
    offers = {"C25744": {"breaks": [[100, 0.0021], [1000, 0.0011]], "stock": 900000, "mpn": "0603WAF1002T5E"},
              "C2040": {"breaks": [[1, 1.20], [10, 0.95]], "stock": 5000, "mpn": "RP2040"}}
    monkeypatch.setattr(bom_cost, "cached_offer", lambda part: offers.get(part))

    async def every(db_):
        return [SITE, MCM, DRAWER]
    monkeypatch.setattr(b, "every", every)
    monkeypatch.setattr(fx, "_latest", {**fx._latest, "rates": {"USD": 1.0, "EUR": 0.9, "TRY": 40.0}, "date": "2026-10-14"})

    class Bucket:
        async def upload_from_stream(self, name, data):
            return "grid-" + name
    monkeypatch.setattr(files, "_bucket", lambda db_: Bucket())
    return db, fake, state


def call(db, name, args):
    return run(_tool(name).run(Ctx(db=db, actor=ME, chat="c1"), args))


def stock(db, **kw):
    """A stock line as the Parts page keeps it (its catalog link taken as given)."""
    d = {"_id": f"i{len(run(inv.everything(db)))}-{kw['name'][:4]}", "unit": "pcs", "lcsc": "", "mpn": "", **kw}
    run(db["inventory"].insert_one(d))
    return d


def test_they_are_the_parts_packages_and_stock_taking_asks_first():
    got = {n: (t.package, t.level, t.default) for n, t in chat_tools.tools().items() if n in NAMES}
    assert got == {"build_count": ("mfr", "read", True), "shopping_list": ("mfr", "change", True),
                   "stock_consume": ("mfr", "delete", True)}
    for n in NAMES:
        assert n in chat_tools.SYSTEM_NOTE


def test_their_sentences_are_in_turkish_too():
    tr = open("frontend/src/app/i18n.ts", encoding="utf-8").read()
    icons = open("frontend/src/app/rooms/cc-tools.ts", encoding="utf-8").read()
    for n in NAMES:
        t = _tool(n)
        for s in (t.label, t.about, t.running, t.failed):
            assert f"'{s}':" in tr, (n, s)
        assert f"{n}:" in icons, n
    for s in ("{what}: {n} can be built", "{what} has no parts to count", "Shopping list for {what}: {total}",
              "Nothing to buy for {what}", "Took {n} lines out of stock for {what}"):
        assert f"'{s}':" in tr, s


def test_build_count_says_how_many_what_limits_and_what_is_short(ws):
    db, _, _ = ws
    stock(db, name="10k 0603", lcsc="C25744", quantity=10)               # by the LCSC number: 2 boards
    stock(db, name="RP2040", mpn="RP2040", quantity=3)                    # by the MPN: 3 boards
    stock(db, name="USB-C", catalog={"manufacturer": "robo", "product": "p-usb", "sku": "TYPE-C-31-M-12"}, quantity=5)
    got = call(db, "build_count", {"board": "fan", "builds": 5})
    assert got.say == "{what}: {n} can be built" and got.vars["n"] == 2 and got.vars["what"] == "fan-board"
    assert "Limiting: 10k 0603WAF1002T5E C25744" in got.text
    assert "need 20, have 10, short 10" in got.text            # resistors for 5 boards
    assert "RP2040 C2040 (U1): need 5, have 3, short 2" in got.text
    assert got.vars["short"] == 2 and "TYPE-C" not in got.text.split("Per part")[0].split("Short for")[1]
    # Nothing of a part on hand: none can be built, and it says so.
    db2 = scope.ScopedDb(FakeDb(), "default")
    run(db2["boards"].insert_one({"_id": "fan-board", "title": "Fan board"}))
    zero = call(db2, "build_count", {"board": "fan-board"})
    assert zero.vars["n"] == 0 and "(none in stock)" in zero.text


def test_an_assemblys_bought_parts_are_its_product_models(ws):
    db, _, _ = ws
    for d in ({"_id": "fan/assemblies/main", "title": "Fan", "uses": [
                   {"kind": "model", "id": "fan/purchased/screw"}, {"kind": "model", "id": "fan/parts/lid"},
                   {"kind": "model", "id": "fan/assemblies/motor"}]},
              {"_id": "fan/assemblies/motor", "title": "Motor block", "uses": [
                   {"kind": "model", "id": "fan/purchased/screw"}, {"kind": "model", "id": "fan/purchased/bearing"}]},
              {"_id": "fan/purchased/screw", "title": "McMaster-Carr 91290A115 M3x8"},
              {"_id": "fan/purchased/bearing", "title": "608ZZ bearing"},
              {"_id": "fan/parts/lid", "title": "Lid"}):
        run(db["models"].insert_one(d))
    stock(db, name="M3x8", catalog={"manufacturer": "mcmaster", "product": "91290A115"}, quantity=7)
    stock(db, name="608ZZ bearing", quantity=1)
    got = call(db, "build_count", {"model": "fan/assemblies/main"})
    # Two screws a build (the assembly's and the motor's), one bearing; the lid is made, not bought.
    assert got.vars["n"] == 1
    assert "M3x8 socket screw | 2 | 7" in got.text and "608ZZ bearing | 1 | 1" in got.text
    assert "Taken as made, not bought" in got.text and "Lid" in got.text and "fan/assemblies/motor" in got.text


def test_the_shopping_list_takes_the_cheapest_seller_per_line(ws):
    db, fake, _ = ws
    run(db.settings.insert_one({"_id": "costs", "display_currency": "TRY"}))
    stock(db, name="RP2040", mpn="RP2040", quantity=3)
    got = call(db, "shopping_list", {"board": "fan-board", "builds": 5, "export": "csv"})
    assert got.say == "Shopping list for {what}: {total}" and got.vars["what"] == "fan-board x5"
    t = got.text
    # 20 resistors: LCSC sells at least 100 - the 100 break is what is bought.
    assert "| 10k 0603WAF1002T5E | 20 | 100 | LCSC | [C25744]" in t and "price break 100+" in t
    # 2 RP2040: LCSC $1.20 = 48 TRY each beats the site's 1.5 EUR = 66.67 TRY.
    rp = next(ln for ln in t.splitlines() if ln.startswith("| RP2040 "))
    assert "| LCSC |" in rp and "96.00" in rp and "robotistan.com" in rp
    # 5 USB-C: no LCSC number, the site's own price in TRY (VAT said).
    usb = next(ln for ln in t.splitlines() if ln.startswith("| USB-C "))
    assert "robotistan.com" in usb and "100.00" in usb and "VAT incl." in usb
    assert "| LCSC | 2 |" in t and "| robotistan.com | 1 |" in t and "exchange rates of 2026-10-14" in t
    (f,) = fake["files"].docs.values()
    assert f["name"] == "Shopping list - fan-board x5.csv" and f["context"] == {"room": "commandcode", "chat": "c1"}
    assert got.vars["file"] == f["_id"] and f"/api/files/{f['_id']}" in t


def test_a_given_list_and_mcmaster_packs(ws):
    db, _, _ = ws
    got = call(db, "shopping_list", {"items": [{"name": "M3x8", "product": "mcmaster:91290A115", "qty": 150}]})
    line = next(ln for ln in got.text.splitlines() if ln.startswith("| M3x8 "))
    assert "| 150 | 200 | McMaster-Carr |" in line and "2 packs of 100" in line and "24.00" in line
    assert got.vars["total"] == "24.00 USD"


def test_lcsc_takes_a_bigger_break_when_it_costs_less():
    assert b._best_lcsc([[100, 0.0021], [1000, 0.0011]], 600, 100) == (1000, 0.0011, 1000)
    assert b._best_lcsc([[1, 1.2], [10, 0.95]], 2, 1) == (2, 1.2, 1)
    assert b.mcmaster_price("$3.10 each") == (3.10, 1) and b.mcmaster_price("") is None


def test_taking_stock_for_builds_is_all_or_nothing_and_logged(ws):
    db, _, _ = ws
    assert _tool("stock_consume").level == "delete"
    a = stock(db, name="10k 0603", lcsc="C25744", quantity=6, location="A")
    a2 = stock(db, name="10k 0603", lcsc="C25744", quantity=3, location="B", mpn="x-other")
    stock(db, name="RP2040", mpn="RP2040", quantity=1)
    with pytest.raises(ToolError, match="nothing was taken"):
        call(db, "stock_consume", {"board": "fan-board", "builds": 2})
    rows = {d["_id"]: d for d in run(inv.everything(db))}
    assert rows[a["_id"]]["quantity"] == 6
    stock(db, name="USB-C", mpn="TYPE-C-31-M-12", quantity=4)
    stock(db, name="RP2040 spare", mpn="RP2040", quantity=1)
    got = call(db, "stock_consume", {"board": "fan-board", "builds": 2})
    assert got.say == "Took {n} lines out of stock for {what}" and got.vars["what"] == "fan-board x2"
    rows = {d["_id"]: d for d in run(inv.everything(db))}
    # Eight resistors: the larger line first, then the rest from the other.
    assert rows[a["_id"]]["quantity"] == 0 and rows[a2["_id"]]["quantity"] == 1
    assert rows[a["_id"]]["log"][-1]["reason"] == "used 6 for fan-board x2"
    assert rows[a2["_id"]]["log"][-1]["reason"] == "used 2 for fan-board x2"
    state = ws[2]
    state["role"] = "viewer"
    with pytest.raises(ToolError):
        call(db, "stock_consume", {"board": "fan-board", "builds": 1})
