"""A board's BOM cost at LCSC's price breaks, its stock warnings, and the
offers kept on disk. LCSC is never called: `_ask` is stood in for."""

from __future__ import annotations

import asyncio
import json
import time

from backend import bom_cost, lcsc

BREAKS = [[1, 0.10], [10, 0.08], [100, 0.05], [1000, 0.03]]


def row(number, stock=10000, price=None, **kw):
    return {"number": number, "mpn": kw.get("mpn", "MPN-" + number), "package": kw.get("package", "0603"),
            "manufacturer": "X", "stock": stock,
            "price": price if price is not None else [[q, str(p), str(p)] for q, p in BREAKS]}


def fake_search(rows_by_term, calls):
    def ask(url):
        term = url.split("keyword=")[1].split("&")[0]
        calls.append(term)
        return {"result": {"productList": rows_by_term.get(term, [])}}
    return ask


# ---------------- price breaks ----------------

def test_breaks_are_read_and_sorted():
    raw = [[100, "0.05", "0.06"], [1, "0.10", "0.11"], [10, "on request", ""], ["x"]]
    assert bom_cost.parse_breaks(raw) == [[1, 0.10], [100, 0.05]]


def test_the_break_is_the_largest_at_or_below_the_need():
    assert bom_cost.unit_price(BREAKS, 1) == (0.10, 1)
    assert bom_cost.unit_price(BREAKS, 9) == (0.10, 1)
    assert bom_cost.unit_price(BREAKS, 10) == (0.08, 10)
    assert bom_cost.unit_price(BREAKS, 999) == (0.05, 100)
    assert bom_cost.unit_price(BREAKS, 50000) == (0.03, 1000)


def test_below_the_smallest_break_its_price_applies():
    assert bom_cost.unit_price([[20, 0.5], [100, 0.4]], 3) == (0.5, 20)


def test_no_breaks_no_price():
    assert bom_cost.unit_price([], 5) == (None, None)


# ---------------- stock ----------------

def test_stock_states():
    assert bom_cost.stock_state(0, 10) == "out"
    assert bom_cost.stock_state(5, 10) == "short"
    assert bom_cost.stock_state(300, 10) == "low"              # under the threshold
    assert bom_cost.stock_state(1500, 1000) == "low"           # under twice the need
    assert bom_cost.stock_state(100000, 10) == "ok"
    assert bom_cost.stock_state(None, 10) == "unknown"


# ---------------- cost per quantity ----------------

def lines():
    return [{"lcsc": "C101", "refs": ["R1", "R2", "R3"], "qty": 3, "value": "10k", "footprint": "R0603"},
            {"lcsc": "C102", "refs": ["U1"], "qty": 1, "value": "MCU", "footprint": "QFN"},
            {"lcsc": None, "refs": ["J9"], "qty": 1, "value": "jack", "footprint": None}]


def offers():
    return {"C101": {"breaks": BREAKS, "stock": 100000, "jlc_class": "Basic Part", "source": "search", "ts": time.time()},
            "C102": {"breaks": [[1, 2.0], [100, 1.5]], "stock": 50, "jlc_class": "Extended Part",
                   "source": "search", "ts": time.time()}}


def test_cost_per_quantity_uses_parts_per_board_times_boards():
    out = bom_cost.cost(lines(), offers(), 10)
    q = {r["qty"]: r for r in out["quantities"]}
    # 1 board: 3 R at the 1-piece break, 1 MCU at 1.
    assert abs(q[1]["per_board_usd"] - (3 * 0.10 + 2.0)) < 1e-9
    # 10 boards: 30 R at the 10 break, 10 MCU still at 1.
    assert abs(q[10]["per_board_usd"] - (3 * 0.08 + 2.0)) < 1e-9
    assert abs(q[10]["total_usd"] - 10 * (3 * 0.08 + 2.0)) < 1e-9
    # 100 boards: 300 R at the 100 break, 100 MCU at the 100 break.
    assert abs(q[100]["per_board_usd"] - (3 * 0.05 + 1.5)) < 1e-9
    # 1000 boards: 3000 R at the 1000 break.
    assert abs(q[1000]["per_board_usd"] - (3 * 0.03 + 1.5)) < 1e-9
    assert out["per_board_usd"] == q[10]["per_board_usd"]


def test_a_custom_quantity_is_costed_too():
    out = bom_cost.cost(lines(), offers(), 37)
    assert out["qty"] == 37
    assert abs(out["per_board_usd"] - (3 * 0.05 + 2.0)) < 1e-9     # 111 R at 100
    assert 37 not in {r["qty"] for r in out["quantities"]}


def test_flags_extended_fee_and_stock_problems():
    out = bom_cost.cost(lines(), offers(), 100)
    by = {tuple(l["refs"]): l for l in out["lines"]}
    assert by[("J9",)]["flags"] == ["no LCSC number"] and by[("J9",)]["state"] == "no_part"
    assert by[("U1",)]["state"] == "short"                          # 50 on the shelf, 100 needed
    assert out["priced"] == 2 and out["unpriced"] == [["J9"]]
    assert out["extended"] == 1 and out["extended_fee_usd"] == bom_cost.EXTENDED_FEE_USD
    assert [p["refs"] for p in out["problems"]] == [["U1"]]
    assert out["stock"]["short"] == 1


def test_a_part_without_a_price_is_flagged():
    o = offers()
    o["C102"] = {"breaks": [], "stock": 0, "source": "search", "ts": time.time(), "missing": True}
    out = bom_cost.cost(lines(), o, 1)
    u1 = next(l for l in out["lines"] if l["refs"] == ["U1"])
    assert "no price" in u1["flags"] and u1["state"] == "out" and u1["unit_usd"] is None


def test_lines_group_by_part_and_sort_refs_naturally():
    comps = [{"ref": "R10", "part": "C101"}, {"ref": "R2", "part": "C101"}, {"ref": "U1", "part": ""}]
    out = bom_cost.lines_of(comps, {"R2": {"value": "10k", "mpn": "M"}})
    assert out[0]["refs"] == ["R2", "R10"] and out[0]["qty"] == 2 and out[0]["value"] == "10k"
    assert out[1]["lcsc"] is None and out[1]["refs"] == ["U1"]


# ---------------- fetching and caching ----------------

def test_an_offer_is_fetched_once_and_kept_with_its_time(monkeypatch):
    calls = []
    monkeypatch.setattr(lcsc, "_ask", fake_search({"C101": [row("C1099"), row("C101", stock=42)]}, calls))
    offer = asyncio.run(bom_cost.fetch_offer("C101"))
    assert offer["stock"] == 42 and offer["breaks"] == BREAKS and offer["source"] == "search"
    kept = json.loads((lcsc.LOOK / "C101" / bom_cost.OFFER).read_text())
    assert kept["ts"] == offer["ts"] and calls == ["C101"]
    assert bom_cost.cached_offer("C101")["stock"] == 42
    assert not bom_cost.needs_asking(kept)
    assert bom_cost.to_refresh(["C101"]) == []                         # fresh: not asked again


def test_an_old_offer_is_asked_again_and_a_missing_one_is_written_down(monkeypatch):
    old = {"lcsc": "C101", "breaks": BREAKS, "stock": 1, "source": "search", "ts": time.time() - 2 * 86400}
    (lcsc.LOOK / "C101").mkdir()
    (lcsc.LOOK / "C101" / bom_cost.OFFER).write_text(json.dumps(old))
    assert bom_cost.to_refresh(["C101", "C102"]) == ["C101", "C102"]
    calls = []
    monkeypatch.setattr(lcsc, "_ask", fake_search({"C101": [row("C101", stock=7)]}, calls))
    asyncio.run(bom_cost.fetch_offer("C102"))
    assert bom_cost.cached_offer("C102")["missing"] is True


def test_force_still_waits_ten_minutes():
    (lcsc.LOOK / "C101").mkdir()
    (lcsc.LOOK / "C101" / bom_cost.OFFER).write_text(json.dumps(
        {"breaks": BREAKS, "stock": 1, "source": "search", "ts": time.time() - 60}))
    assert bom_cost.to_refresh(["C101"], force=True) == []


def test_component_record_is_the_fallback(monkeypatch):
    (lcsc.LOOK / "C105").mkdir()
    (lcsc.LOOK / "C105" / "component.json").write_text(json.dumps({"success": True, "result": {
        "lcsc": {"price": 0.5, "stock": 3, "min": 5},
        "dataStr": {"head": {"c_para": {"JLCPCB Part Class": "Basic Part", "Manufacturer Part": "ABC"}}}}}))
    o = bom_cost.cached_offer("C105")
    assert o["source"] == "component" and o["breaks"] == [[5, 0.5]] and o["jlc_class"] == "Basic Part"
    assert bom_cost.needs_asking(o)                                 # never searched: refresh asks


def test_a_refresh_asks_each_stale_part_once_and_reports_progress(monkeypatch):
    calls = []
    monkeypatch.setattr(lcsc, "_ask", fake_search({p: [row(p)] for p in ("C101", "C102", "C103")}, calls))

    async def go():
        st = bom_cost.start_refresh("b", ["C101", "C102", "C103"])
        assert st["running"] and st["total"] == 3
        again = bom_cost.start_refresh("b", ["C101", "C102", "C103"])
        assert again is st                                          # one run per board
        await st["task"]
        return st
    st = asyncio.run(go())
    assert st["done"] == 3 and st["asked"] == 3 and not st["running"]
    assert sorted(calls) == ["C101", "C102", "C103"]

    async def second():
        return bom_cost.start_refresh("b", ["C101", "C102", "C103"])
    st2 = asyncio.run(second())
    assert st2["total"] == 0 and not st2["running"] and len(calls) == 3   # all fresh, nothing asked


def test_a_refusal_ends_the_refresh(monkeypatch):
    def ask(url):
        raise lcsc.Refused("cooling off")
    monkeypatch.setattr(lcsc, "_ask", ask)

    async def go():
        st = bom_cost.start_refresh("b2", ["C101", "C102"])
        await st["task"]
        return st
    st = asyncio.run(go())
    assert st["error"] and st["done"] == 0 and not st["running"]


def test_alternatives_are_same_package_in_stock_and_kept(monkeypatch):
    calls = []
    monkeypatch.setattr(lcsc, "_ask", fake_search({"MPN-C102": [
        row("C102", package="QFN-16_L3"), row("C107", stock=0, package="QFN-16_L3"),
        row("C108", stock=900, package="QFN-16_X"), row("C109", stock=10, package="SOIC-8")]}, calls))
    line = {"lcsc": "C102", "mpn": "MPN-C102", "package": "QFN-16_L3.0", "value": "MCU", "qty": 1}
    out = asyncio.run(bom_cost.find_alternatives(line, 10))
    assert [r["lcsc"] for r in out["rows"]] == ["C108"]
    asyncio.run(bom_cost.find_alternatives(line, 10))
    assert len(calls) == 1                                           # kept a day


def test_a_passive_alternative_comes_from_the_table_without_asking(monkeypatch):
    monkeypatch.setattr(lcsc, "passive", lambda k, v, s: {"key": f"{k} 100n {s}", "lcsc": "C1591",
                                                           "mpn": "CL10", "package": s, "stock": 10 ** 6})
    alt = bom_cost.passive_alternative({"lcsc": "C9999", "value": "0.1u", "footprint": "C0603"}, 100)
    assert alt and alt["lcsc"] == "C1591"
    assert bom_cost.passive_alternative({"lcsc": "C1591", "value": "100n", "footprint": "C0603"}, 1) is None


def test_two_listings_that_disagree_make_a_part_unsure_not_out():
    (lcsc.LOOK / "C104").mkdir()
    (lcsc.LOOK / "C104" / "component.json").write_text(json.dumps({"success": True, "result": {
        "lcsc": {"price": 0.002, "stock": 9_000_000}, "dataStr": {"head": {"c_para": {}}}}}))
    line = [{"lcsc": "C104", "refs": ["R1"], "qty": 1, "value": "10k", "footprint": "R0603"}]
    o = {"C104": {"breaks": BREAKS, "stock": 0, "source": "search", "ts": time.time()}}
    out = bom_cost.cost(line, o, 10)
    assert out["lines"][0]["state"] == "unsure" and out["lines"][0]["stock_record"] == 9_000_000
    assert out["stock"]["unsure"] == 1 and out["problems"] == []
    # Without a record to say otherwise, out is out.
    assert bom_cost.cost([{**line[0], "lcsc": "C105"}], {"C105": o["C104"]}, 10)["lines"][0]["state"] == "out"


def test_the_search_term_is_value_and_package_or_the_part_number():
    assert bom_cost.search_term({"value": "1uH", "mpn": "ABG04A20M1R0", "package": "4020"}) == "1uH 4020"
    assert bom_cost.search_term({"value": "BQ24074RGTR", "mpn": "BQ24074RGTR", "package": "QFN-16"}) == "BQ24074RGTR"
    assert bom_cost.search_term({"value": "OLED-0.91-128x32", "mpn": "X091", "package": "-"}) == "OLED-0.91-128x32"
    assert bom_cost.search_term({"value": "1k", "mpn": "0603WAF1001T5E", "package": "0603",
                                 "footprint": "R0603"}) == "1k 0603 resistor"
