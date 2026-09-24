"""The board room's Analytics tab: figures from what is already known.

The bill is priced from LCSC's answers already on disk and nothing else -
a summary that spent the request budget would cost more than it said -
so these tests give it a disk with two answers on it and no network.
"""

from __future__ import annotations

import json

from backend import board_stats, lcsc


def _answer(part: str, price, jlc: str | None) -> None:
    d = lcsc.LOOK / part
    d.mkdir(parents=True, exist_ok=True)
    (d / "component.json").write_text(json.dumps({"success": True, "result": {
        "lcsc": {"number": part, "price": price},
        "dataStr": {"head": {"c_para": {"JLCPCB Part Class": jlc} if jlc else {}}},
    }}))


def test_the_bill_is_priced_from_disk_and_counts_what_it_cannot_price():
    _answer("C1525", 0.0021, "Basic Part")          # 100 nF, used four times
    _answer("C2969989", 1.25, "Extended Part")      # the MCU, once
    comps = ([{"ref": f"C{i}", "part": "C1525"} for i in range(4)]
             + [{"ref": "U1", "part": "C2969989"},
                {"ref": "U2", "part": "C99999999"},   # never asked about
                {"ref": "J1", "part": None}])         # no part number at all
    got = board_stats.bom(comps)
    assert got["lines"] == 3 and got["priced"] == 2
    assert got["cost_usd"] == round(4 * 0.0021 + 1.25, 4)
    assert (got["basic"], got["extended"]) == (1, 1)
    assert got["unpartnumbered"] == 1


def test_nothing_on_disk_means_nothing_priced_not_free():
    got = board_stats.bom([{"ref": "U1", "part": "C2969989"}])
    assert got["priced"] == 0 and got["cost_usd"] == 0.0 and got["lines"] == 1
    # And it asked nobody: the journal of asks is still empty.
    assert lcsc.journal(10) == []


def test_a_parts_kind_comes_from_its_footprint_not_its_reference():
    # atopile calls every part U<n>; the footprint says what it is.
    k = board_stats.kind_of
    assert k("lib:R0402") == "resistors" and k("lib:C0603") == "capacitors"
    assert k("lib:LED0603-RD") == "LEDs" and k("lib:TYPE-C-SMD_20009-UCAF001-X") == "connectors"
    assert k("lib:TSSOP-20_L6.5-W4.4") == "ICs" and k("lib:SOT-23-5_L3.0-W1.7") == "ICs"
    assert k("lib:SOT-23_L2.9-W1.3-P") == "transistors" and k("lib:SOD-123F") == "diodes"
    assert k("lib:SW-SMD_4P-L5.1-W5.1") == "switches" and k(None) == "other"
    assert board_stats.block_of("elec/src/main.ato:Controller::power.r_cc1") == "power"
    assert board_stats.block_of("elec/src/main.ato:Controller::mcu") == "mcu"


def test_nets_spread_by_the_pins_they_join():
    nets = [{"nodes": [1]}] * 3 + [{"nodes": [1, 2]}] * 2 + [{"nodes": list(range(35))}]
    assert board_stats.fanout(nets) == [
        {"label": "1", "value": 3}, {"label": "2", "value": 2}, {"label": "3-4", "value": 0},
        {"label": "5-9", "value": 0}, {"label": "10+", "value": 1}]


def test_the_rest_folds_into_one_row_past_the_top():
    from collections import Counter
    rows = board_stats.ranked(Counter({"a": 5, "b": 4, "c": 1, "d": 1}), top=2)
    assert rows == [{"label": "a", "value": 5}, {"label": "b", "value": 4},
                    {"label": "the rest", "value": 2}]
