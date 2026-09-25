"""Releases: the fab files in the columns a fab asks for, and a tag is
never taken twice."""
import asyncio

from backend import access, release


def test_the_position_file_in_jlcpcb_columns():
    pos = "Ref,Val,Package,PosX,PosY,Rot,Side\nU1,?,QFN,10.5,-3.25,90,top\nC3,?,0402,1,2,0,bottom\n"
    out = release._cpl(pos).splitlines()
    assert out[0] == "Designator,Mid X,Mid Y,Layer,Rotation"
    assert out[1] == "U1,10.5000mm,-3.2500mm,Top,90.0"
    assert out[2].endswith(",Bottom,0.0")


def test_copper_layers_come_from_the_board():
    four = '(layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))'
    assert release._copper_layers(four) == ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]
    assert release._copper_layers("") == ["F.Cu", "B.Cu"]


def test_the_bom_groups_by_part_and_prices_each_line(monkeypatch):
    async def preview(part):
        return {"mpn": f"MPN-{part}", "jlc_class": "Extended Part" if part == "C1" else "Basic Part"}

    async def price(part):
        return {"price": {"C1": 1.5, "C2": 0.01}.get(part), "stock": 100}
    monkeypatch.setattr(release.lcsc, "preview", preview)
    monkeypatch.setattr(release, "_price", price)
    graph = {"components": [{"ref": "U1", "part": "C1", "footprint": "lib:QFN"},
                            {"ref": "R2", "part": "C2", "footprint": "lib:0402"},
                            {"ref": "R10", "part": "C2", "footprint": "lib:0402"},
                            {"ref": "J1", "part": "C3", "footprint": "lib:USB"}]}
    jlc, priced, totals = asyncio.run(release._bom(graph, lambda s: None))
    assert "R2,R10" in jlc and "C2" in jlc                      # refs in order, one line per part
    assert totals["parts"] == 4 and totals["lines"] == 3
    assert abs(totals["total_usd"] - (1.5 + 2 * 0.01)) < 1e-9
    assert totals["unpriced"] == ["C3"] and totals["extended"] == 1


def test_tags():
    assert release.TAG.match("v1.2") and release.TAG.match("rev-A") and not release.TAG.match("v 1")
    assert not release.TAG.match("../x")


def test_making_a_release_needs_an_editor_downloading_does_not():
    assert access.allowed("editor", access.action("POST", "/api/releases"))
    assert not access.allowed("reviewer", access.action("POST", "/api/releases"))
    assert access.allowed("viewer", access.action("GET", "/api/releases/x/download"))
