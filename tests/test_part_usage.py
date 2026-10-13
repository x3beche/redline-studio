"""Which boards use a part (backend/part_usage.py): read from the boards of
the asking workspace when asked - their build, their KiCad files, their
atopile source - nothing stored, kept a minute while nothing changed.

What has to hold:

- an atopile board names a part by `lcsc_id`/`mpn`, its build by
  reference; a KiCad layout or schematic by its "LCSC" property;
- a part used twice on a board is one line with both references, ×2;
- a part on no board is on none; another workspace's boards are not seen;
- a board saved or rebuilt is read again at once, an unchanged one is not;
- the routes answer one part and several, and refuse what is not a number.
"""

from __future__ import annotations

import asyncio
import json
import types

import pytest
from fastapi.testclient import TestClient

from backend import actors, auth, lcsc, part_usage, scope, store
from backend import main as M
from test_component_pins import Bucket
from test_links import FakeDb

ATO = '''
component Resistor_10k:
    lcsc_id = "C25744"
    footprint = "R0402"

component LED_Red:
    # C2286 · D1
    mpn = "C2286"

module App:
    r1 = new Resistor_10k
    r2 = new Resistor_10k
'''

PCB = '''(kicad_pcb (version 20221018)
  (footprint "lib:R0402" (layer "F.Cu")
    (property "Reference" "R11" (at 0 0))
    (property "LCSC" "C25744" (at 0 0))
  )
  (footprint "lib:SOT-23" (layer "F.Cu")
    (property "Reference" "Q1" (at 0 0))
    (property "LCSC Part" "C20917" (at 0 0))
  )
  (footprint "lib:MountingHole" (layer "F.Cu")
    (property "Reference" "H1" (at 0 0))
  )
)'''

SCH = '''(kicad_sch (version 20230121)
  (lib_symbols
    (symbol "Device:C" (property "Reference" "C" (at 0 0)) (property "LCSC" "C1525" (at 0 0)))
  )
  (symbol (lib_id "Device:C") (at 10 10 0)
    (property "Reference" "C4" (at 0 0))
    (property "LCSC" "C1525" (at 0 0))
  )
  (symbol (lib_id "power:GND") (at 10 10 0)
    (property "Reference" "#PWR01" (at 0 0))
  )
)'''


def run(c):
    return asyncio.run(c)


@pytest.fixture
def world(monkeypatch, tmp_path):
    """Two boards of the default workspace - atopile with a build, KiCad
    without one - and one board of team2's that uses the same part."""
    db = FakeDb()
    bucket = Bucket()
    monkeypatch.setattr(store, "bucket", lambda d, name: bucket)
    monkeypatch.setattr(store, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(M, "_raw_db", lambda: db)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    part_usage.forget()
    sdb = scope.ScopedDb(db, scope.DEFAULT)
    team = scope.ScopedDb(db, "team2")

    async def seed():
        await sdb["boards"].insert_one({"_id": "fan", "title": "Fan controller", "folder": "iot-fan/electronics",
                                        "source": ATO, "saved_at": "2026-10-01T10:00:00+00:00",
                                        "component": {"version": 4}})
        graph = {"components": [{"ref": "R7", "part": "C25744"}, {"ref": "R3", "part": "C25744"},
                                {"ref": "D1", "part": "C2286"}, {"ref": "U1", "part": "C8734"}]}
        await store.put_artifact(sdb, "fan", "graph", json.dumps(graph).encode(), collection="boards")
        await sdb["boards"].insert_one({"_id": "imported", "title": "Imported", "folder": "",
                                        "saved_at": "2026-10-02T10:00:00+00:00"})
        await store.put_artifact(sdb, "imported", "pcb", PCB.encode(), collection="boards")
        await store.put_artifact(sdb, "imported", "schematic", SCH.encode(), collection="boards")
        await team["boards"].insert_one({"_id": "fan", "title": "Their fan", "source": ATO,
                                         "saved_at": "2026-10-01T10:00:00+00:00"})
    run(seed())
    tokens = (actors.CURRENT.set(actors.local_user()), scope.WORKSPACE.set(scope.DEFAULT))
    yield types.SimpleNamespace(db=db, sdb=sdb, team=team, web=TestClient(M.app))
    actors.CURRENT.reset(tokens[0])
    scope.WORKSPACE.reset(tokens[1])
    part_usage.forget()


def get(w, path):
    r = w.web.get(path)
    return r.status_code, r.json()


# ---------------------------------------------------------------- reading the files

def test_atopile_names_parts_by_field_and_the_converter_s_comment_by_reference():
    got = part_usage.from_ato(ATO)
    assert got == {"C25744": set(), "C2286": {"D1"}}


def test_kicad_names_parts_by_their_lcsc_property():
    assert part_usage.from_kicad(PCB) == {"C25744": {"R11"}, "C20917": {"Q1"}}
    # the library's own definitions are not parts, power symbols have no number
    assert part_usage.from_kicad(SCH) == {"C1525": {"C4"}}


# ---------------------------------------------------------------- the route

def test_a_part_used_twice_is_one_line_with_both_references(world):
    st, rows = get(world, "/api/parts/C25744/used-in")
    assert st == 200
    assert [(r["board"], r["name"], r["refs"], r["qty"]) for r in rows] == [
        ("fan", "Fan controller", ["R3", "R7"], 2), ("imported", "Imported", ["R11"], 1)]
    fan = rows[0]
    assert fan["project"] == "iot-fan" and fan["path"] == "iot-fan/electronics/fan" and fan["version"] == 4
    assert fan["built"] and fan["built_at"] and set(fan["from"]) == {"graph", "source"}
    assert not rows[1]["built"] and set(rows[1]["from"]) == {"pcb"}


def test_a_part_from_the_schematic_and_a_part_on_no_board(world):
    assert [r["refs"] for r in get(world, "/api/parts/C1525/used-in")[1]] == [["C4"]]
    assert get(world, "/api/parts/C99999/used-in") == (200, [])
    assert get(world, "/api/parts/c2286/used-in")[1][0]["refs"] == ["D1"]


def test_another_workspace_s_boards_are_not_seen(world):
    rows = run(part_usage.used_in(world.team, "C25744"))
    assert [(r["board"], r["name"], r["refs"], r["qty"], r["built"]) for r in rows] == [
        ("fan", "Their fan", [], None, False)]
    assert all(r["name"] != "Their fan" for r in get(world, "/api/parts/C25744/used-in")[1])
    assert run(part_usage.used_in(world.team, "C1525")) == []


def test_several_parts_at_once_and_a_bad_number(world):
    st, got = get(world, "/api/parts-used-in?parts=C25744,C99999,nonsense")
    assert st == 200 and set(got) == {"C25744", "C99999"} and got["C99999"] == []
    assert len(got["C25744"]) == 2
    assert get(world, "/api/parts/R10k/used-in")[0] == 400


def test_kept_while_unchanged_and_read_again_once_saved(world, monkeypatch):
    reads = []
    real = part_usage.read_board

    async def counting(db, doc):
        reads.append(doc["_id"])
        return await real(db, doc)
    monkeypatch.setattr(part_usage, "read_board", counting)
    get(world, "/api/parts/C25744/used-in")
    get(world, "/api/parts/C2286/used-in")
    assert sorted(reads) == ["fan", "imported"]                 # read once for both cards
    world.db["boards"].rows[0]["source"] = ATO.replace('"C2286"', '"C2287"')
    world.db["boards"].rows[0]["saved_at"] = "2999-01-01T10:00:00+00:00"
    assert [r["board"] for r in get(world, "/api/parts/C2287/used-in")[1]] == ["fan"]
    assert sorted(reads) == ["fan", "fan", "imported"]          # only the saved board again
    assert get(world, "/api/parts/C2287/used-in")[1][0]["stale"]   # saved since its build


def test_the_drawer_search_says_where_a_part_is_used(world, monkeypatch):
    from backend import chat_tools
    from backend.chat_tools import Ctx

    async def known(db):
        return [{"lcsc": "C25744", "name": "R0402", "mpn": "0402WGF1002TCE", "maker": "UNI-ROYAL",
                 "group": "Passives", "branch": "Resistors"}]
    monkeypatch.setattr(lcsc, "known", known)
    got = run(chat_tools.tools()["drawer_search"].run(Ctx(db=world.sdb), {"query": "C25744"}))
    assert "used on 2 boards: Fan controller (R3, R7), Imported (R11)" in got.text
