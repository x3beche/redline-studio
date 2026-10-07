"""Linked components: a part is used by reference, and a change travels.

What has to hold (backend/links.py, backend/board3d.py):

- what a model uses is read from its imports with `ast`, never by
  searching the text, and mapped to model and board ids the way the build
  lays the modules out (bare names while unambiguous, boards by name);
- a change marks every dependent stale, transitively, and stops at a pin;
- rebuilds run in topological order, debounced, a few at a time; a
  failure blocks what depends on it; a cycle is reported, never built;
- a board's generated module carries its named data and reads its STEP
  only when `part` is asked for;
- a board something imports is not deleted without force.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import struct
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from backend import auth, board3d, links, store
from backend import main as M


# ---------------------------------------------------------------- a small Mongo

def _get(doc, key):
    for part in key.split("."):
        if not isinstance(doc, dict) or part not in doc:
            return None, False
        doc = doc[part]
    return doc, True


def _match(doc, q) -> bool:
    for k, v in (q or {}).items():
        if k == "$and":
            if not all(_match(doc, x) for x in v):
                return False
            continue
        if k == "$or":
            if not any(_match(doc, x) for x in v):
                return False
            continue
        got, has = _get(doc, k)
        if isinstance(v, dict) and any(op.startswith("$") for op in v):
            for op, a in v.items():
                if op == "$exists" and has != bool(a):
                    return False
                if op == "$ne" and got == a:
                    return False
                if op == "$in" and got not in a:
                    return False
        elif got != v:
            return False
    return True


def _set(doc, key, value):
    *head, last = key.split(".")
    for part in head:
        doc = doc.setdefault(part, {})
    doc[last] = copy.deepcopy(value)


def _unset(doc, key):
    *head, last = key.split(".")
    for part in head:
        doc = doc.get(part) or {}
    doc.pop(last, None)


class Res:
    def __init__(self, n=1, upserted=None):
        self.matched_count = self.modified_count = self.deleted_count = n
        self.upserted_id = upserted
        self.inserted_id = None


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        self.rows.sort(key=lambda r: (_get(r, key)[0] or 0) if isinstance(key, str) else 0,
                       reverse=direction < 0)
        return self

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def __aiter__(self):
        async def gen():
            for r in self.rows:
                yield r
        return gen()


class Coll:
    def __init__(self):
        self.rows: list[dict] = []

    def _one(self, q):
        return next((r for r in self.rows if _match(r, q)), None)

    async def insert_one(self, doc, *a, **kw):
        self.rows.append(copy.deepcopy(doc))
        return Res()

    async def find_one(self, q=None, projection=None, *a, **kw):
        row = self._one(q)
        return copy.deepcopy(row) if row else None

    def find(self, q=None, projection=None, *a, **kw):
        return Cursor([copy.deepcopy(r) for r in self.rows if _match(r, q)])

    async def update_one(self, q, update, upsert=False, *a, **kw):
        row = self._one(q)
        made = None
        if row is None:
            if not upsert:
                return Res(0)
            row = {k: v for k, v in (q or {}).items() if not k.startswith("$")}
            self.rows.append(row)
            made = row.get("_id")
        for k, v in (update.get("$set") or {}).items():
            _set(row, k, v)
        for k, v in (update.get("$setOnInsert") or {}).items():
            if made is not None:
                _set(row, k, v)
        for k in (update.get("$unset") or {}):
            _unset(row, k)
        return Res(1, made)

    async def update_many(self, q, update, *a, **kw):
        n = 0
        for row in [r for r in self.rows if _match(r, q)]:
            for k, v in (update.get("$set") or {}).items():
                _set(row, k, v)
            n += 1
        return Res(n)

    async def replace_one(self, q, doc, upsert=False, *a, **kw):
        row = self._one(q)
        if row is None:
            if upsert:
                self.rows.append(copy.deepcopy(doc))
            return Res(0)
        row.clear()
        row.update(copy.deepcopy(doc))
        return Res(1)

    async def delete_one(self, q, *a, **kw):
        row = self._one(q)
        if row is None:
            return Res(0)
        self.rows.remove(row)
        return Res(1)

    async def delete_many(self, q, *a, **kw):
        keep = [r for r in self.rows if not _match(r, q)]
        n = len(self.rows) - len(keep)
        self.rows[:] = keep
        return Res(n)

    async def count_documents(self, q=None, **kw):
        return sum(1 for r in self.rows if _match(r, q))

    async def distinct(self, key, q=None, **kw):
        return list(dict.fromkeys(_get(r, key)[0] for r in self.rows if _match(r, q)))


class FakeDb:
    def __init__(self):
        self.colls: dict[str, Coll] = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]

    async def command(self, *a, **kw):
        return {"ok": 1}


def model(mid, source, **kw):
    return {"_id": mid, "name": mid.rpartition("/")[2], "title": mid.rpartition("/")[2],
            "source": source, "sha256": store.hashlib.sha256(source.encode()).hexdigest(),
            "folder": mid.rpartition("/")[0], **kw}


@pytest.fixture
def db():
    return FakeDb()


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- reading imports

def test_imports_are_read_from_the_syntax_not_the_text():
    src = '''
"""Mentions stand and base in a docstring, which is not an import."""
import os
import fan_pro as F
from stand import PLUG_Z
import demoboard_gerber_zip.sub
from . import nothing
if True:
    import late_one
import importlib
B = importlib.import_module("dynamic_one")
x = "import fake"
'''
    assert links.imported_names(src) == [
        "os", "fan_pro", "stand", "demoboard_gerber_zip", "late_one", "importlib", "dynamic_one"]


def test_a_source_that_does_not_parse_still_says_what_it_imports():
    assert links.imported_names("import stand\nfrom base import X\ndef broken(:\n") == ["stand", "base"]


def test_names_map_to_models_and_boards_like_the_build_lays_them_out():
    models = [model("iot-fan/parts/stand", ""), model("a/base", ""), model("b/base", ""),
              model("root", ""), model("x/controller", "")]
    boards = [{"_id": "demoboard-gerber-zip"}, {"_id": "controller"}]
    table = links.module_table(models, boards)
    assert table["stand"] == ("model", "iot-fan/parts/stand")
    assert table["iot-fan__parts__stand"] == ("model", "iot-fan/parts/stand")
    assert "base" not in table                                   # ambiguous: by folder only
    assert table["a__base"] == ("model", "a/base")
    assert table["demoboard_gerber_zip"] == ("board", "demoboard-gerber-zip")
    assert table["pcb_demoboard_gerber_zip"] == ("board", "demoboard-gerber-zip")
    # A model of the same name keeps the bare name; the board is still pcb_.
    assert table["controller"] == ("model", "x/controller")
    assert table["pcb_controller"] == ("board", "controller")

    uses = links.resolve("import stand as S\nimport stand\nimport os\nimport demoboard_gerber_zip as B\n"
                         "import root\n", table, self_id="root")
    assert uses == [{"kind": "model", "id": "iot-fan/parts/stand", "module": "stand"},
                    {"kind": "board", "id": "demoboard-gerber-zip", "module": "demoboard_gerber_zip"}]
    assert links.module_for("board", "demoboard-gerber-zip", table) == "demoboard_gerber_zip"
    assert links.module_for("board", "controller", table) == "pcb_controller"


def test_uses_are_stored_on_the_model_and_kept_current(db):
    db["models"].rows += [model("p/part", "X = 1\n"), model("p/asm", "import part\n")]
    g = run(links.load(db))
    assert g.uses["model:p/asm"] == ["model:p/part"]
    stored = next(r for r in db["models"].rows if r["_id"] == "p/asm")
    assert stored["uses"] == [{"kind": "model", "id": "p/part", "module": "part"}]
    # A board of the name the assembly imports appears: read again.
    db["models"].rows[1]["source"] = "import part\nimport demo as B\n"
    db["models"].rows[1]["sha256"] = "changed"
    db["boards"].rows.append({"_id": "demo"})
    g = run(links.load(db))
    assert g.uses["model:p/asm"] == ["model:p/part", "board:demo"]


# ---------------------------------------------------------------- the graph

def graph(edges: dict[str, list[str]], pins=None) -> links.Graph:
    g = links.Graph()
    names = set(edges) | {u for us in edges.values() for u in us}
    for n in names:
        g.add(n, {"kind": links.split(n)[0], "id": links.split(n)[1], "title": n, "version": 1},
              edges.get(n, []), (pins or {}).get(n))
    return g


def test_dependents_are_transitive_and_a_pin_stops_a_change():
    g = graph({"model:asm": ["model:sub", "board:pcb"], "model:sub": ["model:part"],
               "model:tray": ["board:pcb"], "model:top": ["model:asm"]})
    assert g.dependents("model:part") == ["model:asm", "model:sub", "model:top"]
    assert g.dependents("board:pcb") == ["model:asm", "model:top", "model:tray"]
    assert g.upstream("model:top") == ["board:pcb", "model:asm", "model:part", "model:sub"]
    pinned = graph({"model:asm": ["model:sub", "board:pcb"], "model:sub": ["model:part"],
                    "model:tray": ["board:pcb"], "model:top": ["model:asm"]},
                   pins={"model:asm": {"board:pcb": 3}})
    assert pinned.dependents("board:pcb") == ["model:tray"]
    assert pinned.dependents("board:pcb", follow_pins=True) == ["model:asm", "model:top", "model:tray"]


def test_rebuild_order_puts_every_component_before_what_uses_it():
    g = graph({"model:top": ["model:asm"], "model:asm": ["model:sub", "model:b"],
               "model:sub": ["model:a"], "model:b": ["model:a"]})
    order, stuck = g.order(["model:top", "model:asm", "model:sub", "model:b", "model:a"])
    assert stuck == []
    pos = {k: i for i, k in enumerate(order)}
    for k, us in g.uses.items():
        for u in us:
            assert pos[u] < pos[k], (u, k)
    # Only the ones asked about, still in dependency order across a gap.
    order, _ = g.order(["model:top", "model:sub"])
    assert order == ["model:sub", "model:top"]


def test_cycles_are_found_and_cannot_be_ordered():
    g = graph({"model:a": ["model:b"], "model:b": ["model:c"], "model:c": ["model:a"],
               "model:d": ["model:a"], "model:e": []})
    assert g.cycles() == [["model:a", "model:b", "model:c"]]
    order, stuck = g.order(["model:a", "model:b", "model:d"])
    assert order == [] and stuck == ["model:a", "model:b", "model:d"]


# ---------------------------------------------------------------- propagation

def three_deep(db):
    db["models"].rows += [model("p/part", "W = 12.5\n"),
                          model("p/sub", "import part\n"),
                          model("p/asm", "import sub\nimport tray\n"),
                          model("p/tray", "import demo as B\n"),
                          model("p/other", "X = 1\n")]
    db["boards"].rows.append({"_id": "demo", "component": {"version": 4, "digest": "d4"}})


def test_a_change_marks_every_dependent_stale_and_queues_it(db, monkeypatch):
    three_deep(db)
    out = run(links.changed(db, "model", "p/part", version=2))
    assert sorted(out["queued"]) == ["p/asm", "p/sub"]
    rows = {r["_id"]: r for r in db["models"].rows}
    for mid in ("p/sub", "p/asm"):
        assert rows[mid]["stale"] is True
        assert rows[mid]["link"]["state"] == "queued"
        assert rows[mid]["link"]["because"] == {"kind": "model", "id": "p/part", "title": "part",
                                                "version": 2}
    assert "link" not in rows["p/tray"] and "link" not in rows["p/other"]

    out = run(links.changed(db, "board", "demo", version=5))
    assert sorted(out["queued"]) == ["p/asm", "p/tray"]


def test_a_cycle_is_reported_on_its_members_and_not_queued(db):
    db["models"].rows += [model("c/a", "import b\n"), model("c/b", "import a\n"),
                          model("c/user", "import a\n"), model("c/base", "X=1\n")]
    db["models"].rows[1]["source"] = "import a\nimport base\n"
    db["models"].rows[1]["sha256"] = "x"
    out = run(links.changed(db, "model", "c/base"))
    assert out["cycles"] == [["c/a", "c/b"]]
    rows = {r["_id"]: r for r in db["models"].rows}
    assert rows["c/a"]["link"]["state"] == rows["c/b"]["link"]["state"] == "cycle"
    assert "c/a -> c/b -> c/a" in rows["c/a"]["link"]["error"]
    assert out["queued"] == ["c/user"]


def test_saving_a_part_bumps_its_version_and_queues_its_users(db):
    db["models"].rows += [model("p/asm", "import part\nPARTS = []\n")]
    doc = run(store.save_model(db, "p/part", "W = 1.0\nPARTS = []\n"))
    assert doc["version"] == 1 and doc["propagation"]["queued"] == ["p/asm"]
    doc = run(store.save_model(db, "p/part", "W = 2.0\nPARTS = []\n"))
    assert doc["version"] == 2
    # The same text again is not a new version and sends nothing.
    doc = run(store.save_model(db, "p/part", "W = 2.0\nPARTS = []\n"))
    assert doc["version"] == 2 and doc["propagation"]["queued"] == []
    kept = sorted(r["_id"] for r in db["component_versions"].rows)
    assert kept == ["model:p/part:v1", "model:p/part:v2"]


class Builds:
    """A builder that takes real time and remembers the order."""

    def __init__(self, fail=(), secs=0.05):
        self.order, self.live, self.most = [], 0, 0
        self.fail, self.secs = set(fail), secs

    async def __call__(self, db, mid):
        self.live += 1
        self.most = max(self.most, self.live)
        self.order.append(mid)
        await asyncio.sleep(self.secs)
        self.live -= 1
        if mid in self.fail:
            raise RuntimeError(f"{mid}: NameError: name 'W' is not defined")
        return {"model": mid}


async def drain(db, sched, rounds=50):
    for _ in range(rounds):
        await sched.tick(db)
        await asyncio.sleep(0.02)
        if not sched.running and not await db["models"].count_documents({"link.state": "queued"}):
            break
    await sched.idle()


def test_rebuilds_run_in_topological_order_a_few_at_a_time(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [model("p/a", "W = 1\n"), model("p/b", "import a\n"),
                          model("p/c", "import a\n"), model("p/d", "import b\nimport c\n"),
                          model("p/e", "import d\n")]

    async def go():
        await links.changed(db, "model", "p/a")
        builds = Builds()
        sched = links.Scheduler(builds, parallel=2)
        await drain(db, sched)
        return builds

    builds = run(go())
    assert builds.order[:2] in (["p/b", "p/c"], ["p/c", "p/b"])
    assert builds.order[2:] == ["p/d", "p/e"]
    assert builds.most == 2                       # b and c together, never more
    assert {r["_id"]: r.get("link", {}).get("state") for r in db["models"].rows} == {
        "p/a": None, "p/b": "done", "p/c": "done", "p/d": "done", "p/e": "done"}


def test_a_debounced_change_waits_and_a_burst_is_one_rebuild(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 30)
    db["models"].rows += [model("p/a", "W = 1\n"), model("p/b", "import a\n")]

    async def go():
        for _ in range(3):
            await links.changed(db, "model", "p/a")
        builds = Builds()
        sched = links.Scheduler(builds)
        assert await sched.tick(db) == []         # not due yet
        row = next(r for r in db["models"].rows if r["_id"] == "p/b")
        row["link"]["due"] = store.now()          # the time passes
        await drain(db, sched)
        return builds

    assert run(go()).order == ["p/b"]


def test_a_dependent_that_breaks_says_why_and_blocks_what_uses_it(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [model("p/a", "W = 1\n"), model("p/b", "import a\n"),
                          model("p/c", "import b\n"), model("p/z", "import a\n")]

    async def go():
        await links.changed(db, "model", "p/a", version=7)
        builds = Builds(fail={"p/b"})
        await drain(db, links.Scheduler(builds))
        return builds

    builds = run(go())
    assert "p/c" not in builds.order
    rows = {r["_id"]: r for r in db["models"].rows}
    assert rows["p/b"]["link"]["state"] == "failed"
    assert "NameError" in rows["p/b"]["link"]["error"]
    assert rows["p/b"]["link"]["because"]["version"] == 7
    assert rows["p/c"]["link"]["state"] == "blocked"
    assert rows["p/z"]["link"]["state"] == "done"


def test_a_change_during_a_rebuild_queues_it_again(db, monkeypatch):
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    db["models"].rows += [model("p/a", "W = 1\n"), model("p/b", "import a\n")]

    async def go():
        await links.changed(db, "model", "p/a")
        builds = Builds(secs=0.2)
        sched = links.Scheduler(builds)
        await sched.tick(db)
        await asyncio.sleep(0.05)
        await links.changed(db, "model", "p/a")   # while b is building
        await sched.idle()
        row = next(r for r in db["models"].rows if r["_id"] == "p/b")
        assert row["link"]["state"] == "queued"    # the old build did not mark it done
        await drain(db, sched)
        return builds

    assert run(go()).order == ["p/b", "p/b"]


def test_after_a_restart_an_interrupted_rebuild_is_queued_again(db):
    db["models"].rows.append(model("p/b", "import a\n", building=True,
                                   link={"state": "building", "token": "t"}))
    assert run(links.recover(db)) == 1
    row = db["models"].rows[0]
    assert row["link"]["state"] == "queued" and row["building"] is False


def test_what_a_build_is_built_against_changes_when_a_component_does():
    g = graph({"model:tray": ["board:pcb", "model:part"]})
    first = links.against(g, "model:tray")
    assert set(first["against"]) == {"board:pcb", "model:part"}
    g.nodes["board:pcb"]["version"] = 2
    assert links.against(g, "model:tray")["hash"] != first["hash"]
    g.pins["model:tray"] = {"board:pcb": 1}
    pinned = links.against(g, "model:tray")
    assert pinned["against"]["board:pcb"] == {**pinned["against"]["board:pcb"], "version": 1, "pinned": True}


# ---------------------------------------------------------------- the board as a component

INFO = {
    "box": [20.0, 20.0, 70.0, 50.0], "thickness": 1.6,
    "outline": [{"outer": [[20, 20], [70, 20], [70, 50], [20, 50]], "holes": []}],
    "holes": [
        {"x": 23.0, "y": 47.0, "d": 3.2, "plated": False, "ref": "H1", "footprint": "MountingHole_3.2mm"},
        {"x": 67.0, "y": 23.0, "d": 3.2, "plated": False, "ref": "H2", "footprint": "MountingHole_3.2mm"},
        {"x": 40.0, "y": 30.0, "d": 0.8, "plated": True, "ref": "J1", "footprint": "C123"},
    ],
    "footprints": [
        {"ref": "H1", "value": "", "footprint": "MountingHole_3.2mm", "x": 23, "y": 47, "side": "top",
         "box": [21, 45, 25, 49], "models": [], "pads": 1},
        {"ref": "H2", "value": "", "footprint": "MountingHole_3.2mm", "x": 67, "y": 23, "side": "top",
         "box": [65, 21, 69, 25], "models": [], "pads": 1},
        {"ref": "J1", "value": "USB-C", "footprint": "C123", "x": 20.5, "y": 35, "side": "top",
         "box": [19, 31, 25, 39], "models": ["/work/3d/C123.step"], "pads": 12},
        {"ref": "U1", "value": "MCU", "footprint": "C999", "x": 45, "y": 35, "side": "top",
         "box": [42, 32, 48, 38], "models": ["/work/3d/C999.wrl"], "pads": 32},
    ],
}
BOXES = {"J1": [-1.0, 11.0, 1.6, 6.0, 19.0, 4.8], "U1": [22.0, 12.0, 1.6, 28.0, 18.0, 2.6]}


def test_the_named_data_is_in_the_boards_own_frame():
    d = board3d.describe(INFO, BOXES)
    assert d["size"] == [50.0, 30.0] and d["thickness"] == 1.6
    # y flipped: KiCad's page has y down, the board frame y up.
    assert [{k: h[k] for k in ("x", "y", "d", "plated", "ref")} for h in d["holes"]] == [
        {"x": 3.0, "y": 3.0, "d": 3.2, "plated": False, "ref": "H1"},
        {"x": 47.0, "y": 27.0, "d": 3.2, "plated": False, "ref": "H2"}]
    # Nothing stands near either hole: a screw head has the room it wants.
    assert d["holes"][0]["above"] is None and d["holes"][0]["below"] is None
    # The connector's own peg hole is a drill; its own body does not count...
    assert d["drills"][0]["above"] is None
    # ...but a part standing next to a hole does.
    near = board3d.describe(INFO, {**BOXES, "U1": [3.5, 4.5, 1.6, 8.0, 9.0, 4.1]})
    assert near["holes"][0]["above"] == pytest.approx(2.5)
    assert [h["ref"] for h in d["drills"]] == ["J1"]
    (j1,) = d["connectors"]
    assert (j1["ref"], j1["edge"], j1["along"], j1["overhang"]) == ("J1", "left", 15.0, 1.0)
    assert j1["height"] == pytest.approx(3.2)
    assert d["approximate"] == ["U1"]                # a WRL-only part: a box stands in
    assert d["keepout"]["top"] == pytest.approx(3.2)
    assert d["outline"] == [[0, 0], [50, 0], [50, 30], [0, 30]]


def _glb(nodes, meshes_pts):
    import numpy as np
    buf, views, accs, meshes = bytearray(), [], [], []
    for pts in meshes_pts:
        p = np.asarray(pts, dtype=np.float32)
        idx = np.arange(len(p), dtype=np.uint32)
        for data, target in ((p.tobytes(), 34962), (idx.tobytes(), 34963)):
            views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": target})
            buf.extend(data)
        accs.append({"bufferView": len(views) - 2, "componentType": 5126, "count": len(p),
                     "type": "VEC3", "min": p.min(0).tolist(), "max": p.max(0).tolist()})
        accs.append({"bufferView": len(views) - 1, "componentType": 5125, "count": len(p), "type": "SCALAR"})
        meshes.append({"primitives": [{"attributes": {"POSITION": len(accs) - 2}, "indices": len(accs) - 1}]})
    doc = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": nodes, "meshes": meshes, "accessors": accs, "bufferViews": views,
           "buffers": [{"byteLength": len(buf)}]}
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(buf), 0x004E4942) + bytes(buf)
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def test_bodies_and_stl_come_out_of_the_glb_in_the_board_frame():
    # KiCad's GLB: metres, X along the page, Y up, Z down the page. One
    # part under a nameless root, moved by its node.
    tri = [[0, 0, 0], [0.002, 0, 0], [0, 0.001, 0.003]]
    glb = _glb([{"children": [1]}, {"name": "U1", "mesh": 0, "translation": [0.045, 0.0016, 0.035]}], [tri])
    frame = board3d.frame_of(INFO)
    boxes = board3d.glb_boxes(glb, frame)
    # x 45..47 page -> 25..27; page y 35..38 -> board y 15..12; z 1.6..2.6
    assert boxes["U1"] == [25.0, 12.0, 1.6, 27.0, 15.0, 2.6]
    stl = board3d.glb_stl(glb, frame)
    assert struct.unpack_from("<I", stl, 80)[0] == 1 and len(stl) == 84 + 50


def test_a_board_module_carries_its_data_and_reads_the_step_only_when_asked(tmp_path):
    d = board3d.describe(INFO, BOXES)
    src = board3d.module_source("demo-board", "Demo", d, 12, "f" * 64, "demo-board.step")
    assert board3d.module_name("demo-board") == "demo_board"
    assert "REDLINE_IMPORT_ONLY" in src and "X3_" not in src
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "demo_board.py").write_text(src)
    probe = (
        "import os, sys\n"
        "os.environ['REDLINE_IMPORT_ONLY'] = '1'\n"
        "sys.path.insert(0, 'models')\n"
        "import demo_board as B\n"
        "assert not B.STANDALONE\n"
        "assert B.VERSION == 12 and B.THICKNESS == 1.6 and B.SIZE == (50.0, 30.0)\n"
        "assert [(h.x, h.y, h.d) for h in B.HOLES] == [(3.0, 3.0, 3.2), (47.0, 27.0, 3.2)]\n"
        "assert B.CONNECTORS[0].edge == 'left' and B.CONNECTORS[0].ref == 'J1'\n"
        "assert 'build123d' not in sys.modules\n"          # nothing heavy until asked
        "try:\n"
        "    B.part\n"
        "except Exception as exc:\n"
        "    print('NOSTEP', type(exc).__name__)\n"
    )
    out = subprocess.run([sys.executable, "-c", probe], cwd=tmp_path, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert "NOSTEP" in out.stdout                      # it looked for the STEP only then


def test_write_board_lays_down_the_module_its_alias_and_its_step(db, tmp_path):
    d = board3d.describe(INFO, BOXES)
    db["boards"].rows.append({"_id": "demo-board", "title": "Demo",
                              "component": {"version": 3, "digest": "abc" * 20}})

    async def go():
        await store.put_artifact(db, "demo-board", "board3d", json.dumps(d).encode(), collection="boards")
        await store.put_artifact(db, "demo-board", "step", b"ISO-10303-21;\nDATA;\nENDSEC;", collection="boards")
        table = links.module_table([], db["boards"].rows)
        (tmp_path / "models").mkdir()
        return await links.write_board(db, tmp_path / "models", tmp_path, "demo-board", table)

    class Bucket:
        files: dict = {}

        async def upload_from_stream(self, name, data):
            fid = f"f{len(self.files)}"
            self.files[fid] = data
            return fid

        async def delete(self, fid):
            self.files.pop(fid, None)

        async def open_download_stream(self, fid):
            class S:
                async def read(_):
                    return self.files[fid]
            return S()

    mp = pytest.MonkeyPatch()
    mp.setattr(store, "bucket", lambda db, name: Bucket())
    mp.setattr(store, "CACHE", tmp_path / "cache")
    try:
        got = run(go())
    finally:
        mp.undo()
    assert got == {"board": "demo-board", "version": 3, "module": "demo_board"}
    assert "VERSION = 3" in (tmp_path / "models" / "demo_board.py").read_text()
    assert "import_module('demo_board')" in (tmp_path / "models" / "pcb_demo_board.py").read_text()
    assert (tmp_path / "_boards" / "demo-board.step").read_bytes().startswith(b"ISO-10303-21")


def test_a_board_without_3d_says_how_to_get_it(db, tmp_path):
    db["boards"].rows.append({"_id": "bare"})
    with pytest.raises(links.NoBoard3d, match="lay it out"):
        run(links.write_board(db, tmp_path, tmp_path, "bare", {"bare": ("board", "bare")}))


def test_copied_numbers_are_pointed_out():
    exports = {"B": board3d_exports(), "stand": links.model_exports("PLUG_Z = 14.25\nN = 3\n")}
    src = "import demo as B\nimport stand\nt = 1.6\nz = 14.25\nn = 3\nok = B.THICKNESS\n"
    hits = links.copied_numbers(src, exports)
    assert [(h["line"], h["value"]) for h in hits] == [(3, 1.6), (4, 14.25)]
    assert hits[0]["names"] == ["B.THICKNESS"] and hits[1]["names"] == ["stand.PLUG_Z"]


def board3d_exports():
    return links.board_exports(board3d.describe(INFO, BOXES))


# ---------------------------------------------------------------- the API

@pytest.fixture
def api(monkeypatch):
    raw = FakeDb()
    monkeypatch.setattr(M, "_raw_db", lambda: raw)
    monkeypatch.setattr(auth, "enabled", lambda: False)
    return raw


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=M.app), base_url="http://test")


@pytest.mark.asyncio
async def test_a_board_a_model_imports_is_not_deleted_without_force(api):
    api["boards"].rows += [{"_id": "demo-board"}, {"_id": "loose"}]
    api["models"].rows.append(model("p/tray", "import demo_board as B\nPARTS = []\n"))
    async with client() as c:
        r = await c.delete("/api/boards/demo-board", headers={"x-redline-csrf": "1"})
        assert r.status_code == 409, r.text
        assert "p/tray" in r.json()["detail"]
        assert await api["boards"].count_documents({"_id": "demo-board"}) == 1
        r = await c.delete("/api/boards/loose", headers={"x-redline-csrf": "1"})
        assert r.status_code == 200
        r = await c.delete("/api/boards/demo-board?force=true", headers={"x-redline-csrf": "1"})
        assert r.status_code == 200 and r.json()["was_imported_by"] == ["p/tray"]


@pytest.mark.asyncio
async def test_the_catalog_and_the_picker_say_who_uses_what(api):
    api["boards"].rows.append({"_id": "demo-board", "title": "Demo", "folder": "",
                               "component": {"version": 12, "digest": "x"}})
    api["models"].rows += [model("tray", "import demo_board as B\nimport part\nPARTS = []\n",
                                 ready=True, artifacts={}),
                           model("part", "W = 1\nPARTS = []\n", ready=True, artifacts={})]
    async with client() as c:
        picker = (await c.get("/api/components")).json()
        board = next(p for p in picker if p["kind"] == "board")
        assert board["line"] == "import demo_board as B" and board["used_by"] == ["tray"]
        tree = (await c.get("/api/catalog")).json()
        tray = next(m for m in tree["models"] if m["id"] == "tray")
        assert [(u["kind"], u["id"], u["version"]) for u in tray["uses"]] == [
            ("board", "demo-board", 12), ("model", "part", 1)]
        assert tree["boards"][0]["used_by"][0]["id"] == "tray"
        info = (await c.get("/api/models/tray/links")).json()
        assert [u["id"] for u in info["uses"]] == ["demo-board", "part"]
        part = (await c.get("/api/models/part/links")).json()
        assert part["used_by"] == [{"id": "tray", "title": "tray"}]


def test_old_versions_go_but_a_pinned_one_is_kept(db, monkeypatch):
    monkeypatch.setattr(links, "KEEP", 2)
    db["models"].rows.append(model("p/tray", "import part\n", pins={"model:p/part": 1}))
    for v in range(1, 5):
        run(links.archive(db, "model", "p/part", v, {"source": f"W = {v}\n"}))
    kept = sorted(r["version"] for r in db["component_versions"].rows)
    assert kept == [1, 3, 4]
    assert run(links.version_of(db, "model", "p/part", 1))["source"] == "W = 1\n"


def test_a_pinned_model_is_built_at_its_pinned_source(db, tmp_path):
    db["models"].rows += [model("p/part", "W = 9\n", version=4),
                          model("p/tray", "import part\n", pins={"model:p/part": 2})]
    run(links.archive(db, "model", "p/part", 2, {"source": "W = 2\n"}))
    got = run(links.prepare(db, "p/tray", tmp_path, tmp_path))
    assert (tmp_path / "part.py").read_text() == "W = 2\n"
    assert got["against"]["model:p/part"]["version"] == 2 and got["against"]["model:p/part"]["pinned"]


def test_a_legacy_default_model_queued_later_is_still_rebuilt(db, monkeypatch):
    """A model saved before workspaces has no workspace_id. Mongo's
    distinct() leaves a missing field out, so the loop used to look at no
    workspace at all once its first tick was over: the station sat
    "queued" for good after a part it uses changed."""
    monkeypatch.setattr(links, "DEBOUNCE", 0)
    monkeypatch.setattr(links, "TICK", 0.02)
    real_distinct = Coll.distinct

    async def mongo_distinct(self, key, q=None, **kw):     # as Mongo: no None for a missing field
        return [v for v in await real_distinct(self, key, q, **kw) if v is not None]

    monkeypatch.setattr(Coll, "distinct", mongo_distinct)
    db["models"].rows += [model("p/a", "W = 1\n"), model("p/b", "import a\n")]

    async def go():
        builds = Builds(secs=0.01)
        stop = asyncio.Event()
        task = asyncio.create_task(links.loop(lambda: db, builds, stop))
        await asyncio.sleep(0.1)                  # the first tick has come and gone
        await links.changed(db, "model", "p/a")
        for _ in range(100):
            await asyncio.sleep(0.02)
            if builds.order:
                break
        await asyncio.sleep(0.05)
        stop.set()
        await task
        return builds

    assert run(go()).order == ["p/b"]
    row = next(r for r in db["models"].rows if r["_id"] == "p/b")
    assert row["link"]["state"] == "done"


@pytest.mark.asyncio
async def test_renaming_a_model_carries_its_links_revisions_and_versions(api):
    """A rename (move with `name`) is a new id and a new module name. What
    the graph keeps under the old id goes with it; the sources that import
    the old name are the person's to change, and until then they use
    nothing by it."""
    api["folders"].rows.append({"_id": "q", "name": "q", "parent": ""})
    api["models"].rows += [
        model("p/stand", "W = 1\nPARTS = []\n", ready=True, artifacts={}, version=2),
        model("p/tray", "import stand\nPARTS = []\n", ready=True, artifacts={},
              pins={"model:p/stand": 1},
              built={"at": "x", "hash": "h", "against": {"model:p/stand": {"version": 1}}})]
    api["revisions"].rows.append({"_id": "r1", "model": "p/stand"})
    api["component_versions"].rows.append(
        {"_id": "model:p/stand:v1", "kind": "model", "component": "p/stand", "version": 1})
    h = {"x-redline-csrf": "1"}
    async with client() as c:
        r = await c.post("/api/models/p/stand/move?folder=q&name=fan_mount", headers=h)
        assert r.status_code == 200, r.text
        assert r.json() == {"from": "p/stand", "to": "q/fan_mount"}
        r = await c.post("/api/models/q/fan_mount/move?folder=q&name=bad%20name", headers=h)
        assert r.status_code == 400
    rows = {m["_id"]: m for m in api["models"].rows}
    assert "p/stand" not in rows
    assert rows["q/fan_mount"]["name"] == "fan_mount" and rows["q/fan_mount"]["folder"] == "q"
    assert rows["p/tray"]["pins"] == {"model:q/fan_mount": 1}
    assert list(rows["p/tray"]["built"]["against"]) == ["model:q/fan_mount"]
    assert api["revisions"].rows[0]["model"] == "q/fan_mount"
    assert [(v["_id"], v["component"]) for v in api["component_versions"].rows] == [
        ("model:q/fan_mount:v1", "q/fan_mount")]
    assert rows["p/tray"]["uses"] == []            # `import stand` names nothing now
    tray = next(m for m in api["models"].rows if m["_id"] == "p/tray")
    tray.update(model("p/tray", "import fan_mount\nPARTS = []\n"))   # the person's edit
    g = await links.load(api)
    assert g.uses["model:p/tray"] == ["model:q/fan_mount"]
