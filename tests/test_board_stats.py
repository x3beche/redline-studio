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
