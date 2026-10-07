"""`part keep <C...> --refresh`: a part in the drawer fetched again.

U1 (C2925423) pointed at a temp file long gone, Q3 (C518800) had only a
WRL and U6 (C18723017) named no model; `part seat` said "no model stored"
and `part keep` "already in the drawer", so nothing could fetch them
again. lcsc.refresh asks EasyEDA's record afresh, downloads the footprint
and model again (fetch, force), seats the model, and says plainly when
EasyEDA has no 3D model for the part.
"""

from __future__ import annotations

import asyncio
import copy

import pytest

from backend import atoenv, lcsc, store

FP = '(footprint "X"\n  (pad "1" smd rect (at 0 0) (size 1 1))\n  (model "{}" (offset (xyz 0 0 0))))\n'


class Parts:
    def __init__(self, docs=None):
        self.docs = docs or {}

    async def find_one(self, q, proj=None):
        d = self.docs.get(q["_id"])
        return copy.deepcopy(d) if d else None

    async def replace_one(self, q, doc, upsert=False):
        self.docs[q["_id"]] = copy.deepcopy(doc)

    async def update_one(self, q, upd):
        self.docs[q["_id"]].update(copy.deepcopy(upd["$set"]))


def _download(monkeypatch, *, model: bytes | None):
    """easyeda2kicad stood in for: the footprint, and the STEP if `model`."""
    monkeypatch.setattr(atoenv, "easyeda", lambda: (["easyeda2kicad"], {}))
    asked = []

    async def polite(kind, target, url, fn, argv, cwd, weight=1):
        asked.append((kind, target, weight))
        (cwd / "lib.pretty").mkdir()
        (cwd / "lib.pretty" / "X.kicad_mod").write_text(FP.format(cwd / "lib.3dshapes" / "X.wrl"))
        if model:
            (cwd / "lib.3dshapes").mkdir()
            (cwd / "lib.3dshapes" / "X.step").write_bytes(model)
        return 0, "ok"

    stored = {}

    async def put_artifact(db, pid, label, data, collection=None):
        stored[(pid, label)] = data
        db[lcsc.PARTS].docs[pid].setdefault("artifacts", {})[label] = {"bytes": len(data)}

    seated = []

    async def seat_model(db, code, component=None):
        seated.append(code)
        return {"lcsc": code, "status": "seated", "offset": (0, 0, 0), "was": None}

    monkeypatch.setattr(lcsc, "_polite", polite)
    monkeypatch.setattr(store, "put_artifact", put_artifact)
    monkeypatch.setattr(lcsc, "seat_model", seat_model)
    return asked, stored, seated


def test_the_temp_folder_is_not_named_after_anybody():
    from pathlib import Path
    text = (Path(lcsc.__file__)).read_text()
    assert 'prefix="redline-lcsc-"' in text and "x3lcsc" not in text


def test_fetched_again_without_its_model_a_part_keeps_the_one_it_had(monkeypatch):
    parts = Parts({"C1001": {"_id": "C1001", "footprint": FP.format("/tmp/gone/X.wrl"),
                          "artifacts": {"model": {"bytes": 9}}, "model_kind": "step",
                          "model_name": "X"}})
    db = {lcsc.PARTS: parts}
    asked, stored, seated = _download(monkeypatch, model=None)
    doc = asyncio.run(lcsc.fetch(db, "C1001", force=True))
    assert asked == [("download", "C1001", 3)]
    assert doc["artifacts"]["model"] == {"bytes": 9} and doc["model_kind"] == "step"
    assert doc.get("model_kept_at") == doc["at"] and "model_missing_at" not in doc
    assert "/tmp/gone" not in doc["footprint"]         # the new footprint, the old model
    assert seated == ["C1001"]


def test_fetched_again_with_a_model_the_new_one_is_stored(monkeypatch):
    parts = Parts({"C1001": {"_id": "C1001", "footprint": FP.format("/tmp/gone/X.wrl"),
                          "artifacts": {"model": {"bytes": 9}}, "model_kind": "wrl"}})
    asked, stored, seated = _download(monkeypatch, model=b"STEP")
    doc = asyncio.run(lcsc.fetch({lcsc.PARTS: parts}, "C1001", force=True))
    assert stored == {("C1001", "model"): b"STEP"}
    assert doc["model_kind"] == "step" and not doc.get("model_kept_at")


@pytest.mark.parametrize("upstream", [None, "abc123"])
def test_refresh_asks_afresh_and_says_whether_there_is_a_model(monkeypatch, upstream):
    asked_fresh = []

    async def component(code, fresh=False):
        asked_fresh.append(fresh)
        return {"packageDetail": {"dataStr": {"shape": [
            'SVGNODE~{"attrs": {"c_etype": "outline3D", "uuid": "%s", "title": "X"}}' % upstream
        ] if upstream else []}}}

    monkeypatch.setattr(lcsc, "_component", component)
    parts = Parts({"C9009": {"_id": "C9009", "footprint": '(footprint "OLED")'}})
    _download(monkeypatch, model=b"STEP" if upstream else None)
    if not upstream:
        # EasyEDA names no model: easyeda2kicad writes a footprint without one.
        async def polite(kind, target, url, fn, argv, cwd, weight=1):
            (cwd / "lib.pretty").mkdir()
            (cwd / "lib.pretty" / "OLED.kicad_mod").write_text('(footprint "OLED")\n')
            return 0, "ok"
        monkeypatch.setattr(lcsc, "_polite", polite)
    got = asyncio.run(lcsc.refresh({lcsc.PARTS: parts}, "C9009"))
    assert asked_fresh == [True]
    if upstream:
        assert got["upstream_model"] == "abc123" and got["model_kind"] == "step"
        assert got["seat"] == "seated" and "step model" in got["said"]
    else:
        assert got["upstream_model"] is None and got["model_kind"] is None
        assert got["said"].startswith("LCSC/EasyEDA has no 3D model for this part")
        assert parts.docs["C9009"].get("model_missing_at")


def test_refresh_takes_only_part_numbers():
    with pytest.raises(ValueError):
        asyncio.run(lcsc.refresh({}, "U6"))


def test_part_keep_takes_refresh():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    text = (Path(__file__).resolve().parent.parent / "tools" / "revisions.py").read_text()
    assert 'add_argument("--refresh"' in text and "lcsc.refresh(db, code)" in text


def test_the_component_refresh_uses_a_step_fetched_since_the_layout(monkeypatch):
    """Q3 was laid out with only a WRL; refreshed, it has a STEP. The
    component made from that layout points the part at the STEP, so it is
    a body in the board's STEP, not a box in B.part."""
    from backend import kicad, links
    routed = ('(kicad_pcb (footprint "C518800" (model "/work/3d/C518800.wrl" '
              '(offset (xyz 0 0 0))))\n (footprint "C2925423" (model "/work/3d/C2925423.step")))')

    async def available():
        return True

    async def get_artifact(db, bid, label, coll=None):
        if label == "routed":
            return routed.encode()
        raise KeyError(label)

    async def model_of(db, code):
        return (b"STEP " + code.encode(), "step")

    seen = {}

    async def component_of(work, bid, glb, library=None):
        seen["pcb"] = (work / "board.kicad_pcb").read_text()
        seen["files"] = sorted(p.name for p in (work / "3d").iterdir())
        return b"step", {}, None, "digest"

    async def library_footprints(db, bid):
        return {}

    async def board_component(db, bid, step, data, stl, digest="", glb_digest=""):
        return {"version": 1}

    monkeypatch.setattr(kicad, "available", available)
    monkeypatch.setattr(store, "get_artifact", get_artifact)
    monkeypatch.setattr(lcsc, "model_of", model_of)
    monkeypatch.setattr(kicad, "component_of", component_of)
    monkeypatch.setattr(kicad, "library_footprints", library_footprints)
    monkeypatch.setattr(links, "board_component", board_component)
    asyncio.run(kicad.refresh_component({}, "demo"))
    assert '(model "/work/3d/C518800.step"' in seen["pcb"] and ".wrl" not in seen["pcb"]
    assert seen["files"] == ["C2925423.step", "C518800.step"]
