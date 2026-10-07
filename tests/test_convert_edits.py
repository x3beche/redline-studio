"""A convert run again does not throw away what was changed by hand.

The demo board's SW3: a re-convert put `signal p4 ~ pin 4` back after the
pcb agent had taken it out, and its four mounting legs were one net again.
Now what a convert writes is fingerprinted; the next one compares the
stored source with it and refuses, naming the lines - unless told to
write over them (force, a backup kept first) or to merge them in
(keep_edits, refused where the merge conflicts).
"""

from __future__ import annotations

import asyncio
import copy
import json

import pytest

from backend import ato, convert, store

BID = "demo"

SOURCE_V1 = """component SWITCH:
    # C431540 · SW3
    footprint = "SW-TH_MSK12C02"
    signal p1 ~ pin 1
    signal p2 ~ pin 2
    signal p3 ~ pin 3
    signal p4 ~ pin 4

component LED:
    # C2286 · D1
    signal A ~ pin 1
    signal K ~ pin 2

module App:
    sw3 = new SWITCH
    d1 = new LED
"""


# ---- the merge and the summary on their own ----

def test_a_hand_edit_merges_onto_a_convert_that_changed_elsewhere():
    ours = SOURCE_V1.replace("    signal p4 ~ pin 4\n", "")
    theirs = SOURCE_V1.replace("# C2286 · D1", "# C2286 · D1 (from the BOM)")
    merged, conflicts = convert.merge3(SOURCE_V1, ours, theirs)
    assert not conflicts
    assert "signal p4 ~ pin 4" not in merged
    assert "# C2286 · D1 (from the BOM)" in merged
    assert merged.count("signal p3 ~ pin 3") == 1


def test_both_sides_changing_one_line_differently_is_a_conflict():
    ours = SOURCE_V1.replace("signal p4 ~ pin 4", "# p4 left open by hand")
    theirs = SOURCE_V1.replace("signal p4 ~ pin 4", "signal legs ~ pin 4")
    merged, conflicts = convert.merge3(SOURCE_V1, ours, theirs)
    assert merged is None
    assert len(conflicts) == 1 and "line 7" in conflicts[0]
    assert "p4 left open by hand" in conflicts[0] and "signal legs ~ pin 4" in conflicts[0]


def test_the_same_change_on_both_sides_is_taken_once():
    both = SOURCE_V1.replace("    signal p4 ~ pin 4\n", "")
    merged, conflicts = convert.merge3(SOURCE_V1, both, both)
    assert not conflicts and merged == both


def test_nothing_changed_by_hand_takes_the_new_output_as_it_is():
    theirs = SOURCE_V1.replace("d1 = new LED", "d1 = new LED\n    d2 = new LED")
    assert convert.merge3(SOURCE_V1, SOURCE_V1, theirs) == (theirs, [])


def test_the_summary_names_the_changed_lines():
    ours = SOURCE_V1.replace("    signal p4 ~ pin 4\n", "")
    assert convert.diff_summary(SOURCE_V1, ours) == ["line 7: - signal p4 ~ pin 4"]
    many = convert.diff_summary("", "\n".join(f"x{i}" for i in range(30)), limit=5)
    assert len(many) == 6 and many[-1] == "... and 25 more changed lines"


# ---- a convert run against a stored board ----

class Coll:
    def __init__(self):
        self.docs: dict = {}

    async def find_one(self, q, proj=None):
        d = self.docs.get(q["_id"])
        return copy.deepcopy(d) if d is not None else None

    async def insert_one(self, doc):
        if doc["_id"] in self.docs:
            raise KeyError("duplicate")
        self.docs[doc["_id"]] = copy.deepcopy(doc)

    async def update_one(self, q, upd, upsert=False):
        d = self.docs.setdefault(q["_id"], {"_id": q["_id"]})
        for k, v in (upd.get("$set") or {}).items():
            cur = d
            *head, last = k.split(".")
            for h in head:
                cur = cur.setdefault(h, {})
            cur[last] = copy.deepcopy(v)
        for k in upd.get("$unset") or {}:
            d.pop(k, None)
        for k, v in (upd.get("$push") or {}).items():
            items = d.setdefault(k, []) + copy.deepcopy(v["$each"])
            d[k] = items[v["$slice"]:] if "$slice" in v else items


class FakeDb(dict):
    def __missing__(self, name):
        self[name] = Coll()
        return self[name]


class FakePart:
    def __init__(self, ref):
        self.ref, self.guessed, self.problems = ref, False, []

    def report(self):
        return {"ref": self.ref}


@pytest.fixture
def board(monkeypatch):
    """A converted board; `out["next"]` is what the next convert writes."""
    db = FakeDb()
    arts = {"imported_graph": json.dumps({"nets": [{"name": "GND", "nodes": []}],
                                          "components": [{"ref": "SW3"}]}).encode()}
    out = {"next": SOURCE_V1, "identified": 0}

    async def get_artifact(db_, bid, label, coll=None):
        if label not in arts:
            raise KeyError(label)
        return arts[label]

    async def put_artifact(db_, bid, label, data, collection=None):
        arts[label] = data

    async def identify(*a, **k):
        out["identified"] += 1
        return [FakePart("SW3")], []

    async def build(db_, bid):
        arts["graph"] = arts["imported_graph"]
        return {"components": 1, "nets": 1, "joins": 0}

    monkeypatch.setattr(store, "get_artifact", get_artifact)
    monkeypatch.setattr(store, "put_artifact", put_artifact)
    monkeypatch.setattr(convert, "identify", identify)
    monkeypatch.setattr(convert, "findings", lambda *a: [])
    monkeypatch.setattr(convert, "outline_from", lambda s: None)
    monkeypatch.setattr(convert, "import_geometry", lambda *a: {"holes": [], "min_edge": None})
    monkeypatch.setattr(convert, "write", lambda *a: (out["next"], {"open_pins": []}))
    monkeypatch.setattr(convert, "equivalence", lambda a, b: {
        "equivalent": True, "parts": {"built": 1}, "nets": {"same": 1, "only_imported": 0},
        "pads_joined": {"built": 0}})
    monkeypatch.setattr(ato, "build", build)
    db["boards"].docs[BID] = {"_id": BID, "kind": "imported", "title": "board",
                              "artifacts": {"imported_graph": {}}}
    asyncio.run(convert.run(db, BID))                  # the first convert
    return db, out


def _source(db):
    return db["boards"].docs[BID]["source"]


def _edit(db, text):
    db["boards"].docs[BID].update({"source": text, "saved_at": store.now()})


def test_the_convert_keeps_a_fingerprint_of_what_it_wrote(board):
    db, _ = board
    gen = db["boards"].docs[BID]["convert"]["generated"]
    assert gen["sha"] == convert._sha(SOURCE_V1) and gen["rev"] == gen["sha"][:16]
    assert db["source_blobs"].docs[gen["sha"]]["text"] == SOURCE_V1


def test_converting_an_untouched_source_again_just_converts(board):
    db, out = board
    out["next"] = SOURCE_V1.replace("# C2286 · D1", "# C2286 · D1 (BOM)")
    got = asyncio.run(convert.run(db, BID))
    assert got["status"] == "converted" and "hand_edits" not in got
    assert _source(db) == out["next"]
    assert not db["boards"].docs[BID].get("source_backups")


def test_a_hand_edit_stops_the_convert_and_names_the_lines(board):
    db, out = board
    edited = SOURCE_V1.replace("    signal p4 ~ pin 4\n", "")
    _edit(db, edited)
    before = out["identified"]
    with pytest.raises(convert.Edited) as exc:
        asyncio.run(convert.run(db, BID))
    assert "line 7: - signal p4 ~ pin 4" in str(exc.value)
    assert "--force" in str(exc.value) and "--keep-edits" in str(exc.value)
    assert exc.value.changed == ["line 7: - signal p4 ~ pin 4"]
    assert _source(db) == edited                       # nothing written
    assert out["identified"] == before                 # nothing asked of LCSC either


def test_force_keeps_a_backup_and_writes_over_the_edits(board):
    db, _ = board
    edited = SOURCE_V1.replace("    signal p4 ~ pin 4\n", "")
    _edit(db, edited)
    got = asyncio.run(convert.run(db, BID, force=True))
    assert _source(db) == SOURCE_V1
    backups = db["boards"].docs[BID]["source_backups"]
    assert len(backups) == 1 and backups[0]["sha"] == convert._sha(edited)
    assert db["source_blobs"].docs[backups[0]["sha"]]["text"] == edited
    assert got["hand_edits"] == {"kept": "discarded", "backup": backups[0]["rev"],
                                 "changed": ["line 7: - signal p4 ~ pin 4"]}
    # Written over, the source is the convert's own again: no refusal next time.
    asyncio.run(convert.run(db, BID))


def test_keep_edits_merges_them_onto_the_new_source(board):
    db, out = board
    edited = SOURCE_V1.replace("    signal p4 ~ pin 4\n", "")
    _edit(db, edited)
    out["next"] = SOURCE_V1.replace("# C2286 · D1", "# C2286 · D1 (BOM)")
    got = asyncio.run(convert.run(db, BID, keep_edits=True))
    src = _source(db)
    assert "signal p4 ~ pin 4" not in src and "# C2286 · D1 (BOM)" in src
    assert got["hand_edits"]["kept"] == "merged"
    assert db["boards"].docs[BID]["source_backups"][0]["sha"] == convert._sha(edited)
    # The fingerprint is of the convert's output, not of the merge: the
    # edits are still edits, and the next plain convert says so.
    assert got["generated"]["sha"] == convert._sha(out["next"])
    with pytest.raises(convert.Edited):
        asyncio.run(convert.run(db, BID))


def test_keep_edits_refuses_where_the_edits_conflict(board):
    db, out = board
    edited = SOURCE_V1.replace("signal p4 ~ pin 4", "# legs left open by hand")
    _edit(db, edited)
    out["next"] = SOURCE_V1.replace("signal p4 ~ pin 4", "signal legs ~ pin 4")
    with pytest.raises(convert.Edited) as exc:
        asyncio.run(convert.run(db, BID, keep_edits=True))
    assert exc.value.conflicts and "do not merge" in str(exc.value)
    assert _source(db) == edited
    assert not db["boards"].docs[BID].get("source_backups")


def test_a_board_converted_before_the_fingerprint_is_judged_by_its_save_time(board):
    db, _ = board
    doc = db["boards"].docs[BID]
    doc["convert"].pop("generated")
    assert asyncio.run(convert.hand_edits(db, doc)) is None       # saved with the convert
    doc["saved_at"] = "2099-01-01T00:00:00+00:00"
    found = asyncio.run(convert.hand_edits(db, doc))
    assert found["base"] is None and "cannot be named" in found["changed"][0]
    with pytest.raises(convert.Edited, match="cannot be merged"):
        asyncio.run(convert.run(db, BID, keep_edits=True))
