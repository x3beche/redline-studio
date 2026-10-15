"""A model's technical drawing has a small PNG of its sheet and a JSON of
what the sheet holds beside its PDF (backend/release.py, tools/techdraw.py
--png/--info). GET /api/models/<id>/drawing.png gives the picture only when
the drawing is already made - a 404 "not made yet" otherwise, and that
route never makes one. drawing/status says where each model's drawing is,
per model and per STEP; POST .../drawing makes it in the background."""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess

import pytest
from fastapi import HTTPException

from backend import access, main, release
from test_telegram import Coll

SHA = "ab" * 32
OTHER = "cd" * 32


class Models:
    def __init__(self, docs):
        self.docs = docs

    async def find_one(self, q, projection=None):
        return self.docs.get(q["_id"])


class Db:
    def __init__(self, docs):
        self.models = Models(docs)
        self.colls: dict = {}

    def __getitem__(self, name):
        return self.colls.setdefault(name, Coll())


DB = Db({"p/lid": {"_id": "p/lid", "title": "Lid", "artifacts": {"step": {"sha256": SHA, "bytes": 10}},
                   "built": {"version": 7, "at": "2026-10-12T10:00:00+00:00"}},
         "p/base": {"_id": "p/base", "artifacts": {"step": {"sha256": OTHER, "bytes": 20}}},
         "p/bare": {"_id": "p/bare", "artifacts": {}}})


@pytest.fixture
def kept(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    monkeypatch.setattr(DB, "colls", {})
    monkeypatch.setattr(release, "_DUE", {})

    async def never(*a, **kw):
        raise AssertionError("the preview made a drawing")
    monkeypatch.setattr(release, "drawing", never)
    monkeypatch.setattr(main, "db", lambda: DB)
    return tmp_path


def stem(sha=SHA):
    return f"{sha[:24]}-v{release.DRAW_VERSION}"


def test_not_made_yet_is_a_404_and_makes_nothing(kept):
    for mid in ("p/lid", "p/bare", "p/gone"):
        with pytest.raises(HTTPException) as e:
            asyncio.run(main.model_drawing_preview(mid))
        assert e.value.status_code == 404
    assert not list(kept.glob("*-v*"))


def test_a_made_drawing_gives_its_picture(kept):
    (kept / f"{stem()}.png").write_bytes(b"PNG")
    # Not until the PDF is there too: that is what says the drawing is made.
    with pytest.raises(HTTPException):
        asyncio.run(main.model_drawing_preview("p/lid"))
    (kept / f"{stem()}.pdf").write_bytes(b"%PDF")
    res = asyncio.run(main.model_drawing_preview("p/lid"))
    assert res.body == b"PNG" and res.media_type == "image/png"
    assert "immutable" in res.headers["cache-control"]
    # Another model's STEP is another drawing: not this one's picture.
    with pytest.raises(HTTPException):
        asyncio.run(main.model_drawing_preview("p/base"))



def test_the_sheet_for_the_layout_editor_is_made_once_from_the_drawing(kept, monkeypatch):
    made = []

    async def raster(pdf, out):
        made.append(pdf.name)
        out.write_bytes(b"BIG")
    monkeypatch.setattr(release, "_rasterise", raster)
    # No drawing yet: nothing to show, and nothing made.
    with pytest.raises(HTTPException):
        asyncio.run(main.model_drawing_preview("p/lid", size="sheet"))
    assert made == []
    (kept / f"{stem()}.pdf").write_bytes(b"%PDF")
    for _ in range(2):
        res = asyncio.run(main.model_drawing_preview("p/lid", size="sheet"))
        assert res.body == b"BIG"
    assert made == [f"{stem()}.pdf"]

def test_the_status_is_per_model_and_per_step(kept):
    st = asyncio.run(release.drawing_status(DB, "p/lid"))
    assert st["state"] == "none" and st["step"]["sha"] == SHA[:12] and st["built"]["version"] == 7
    assert asyncio.run(release.drawing_status(DB, "p/bare"))["state"] == "no_step"

    (kept / f"{stem()}.pdf").write_bytes(b"%PDF-x")
    (kept / f"{stem()}.png").write_bytes(b"PNG")
    (kept / f"{stem()}.json").write_text(json.dumps({"sheet": "A3 landscape", "scale": "1:2",
                                                      "views": ["Front", "Top"], "size_mm": [1, 2, 3]}))
    st = asyncio.run(release.drawing_status(DB, "p/lid"))
    assert st["state"] == "ready" and st["key"] == stem()
    assert st["made"]["pdf_bytes"] == 6 and st["made"]["scale"] == "1:2" and st["made"]["preview"]
    # The other model is untouched by it.
    assert asyncio.run(release.drawing_status(DB, "p/base"))["state"] == "none"

    # Being made (its job row, from any process): how far, and only for the drawing it is about.
    jobs = DB[release.JOBS]
    row = {"state": "making", "pct": 48, "stage": "projecting the right view", "by": "chat", "pid": 1,
           "host": "elsewhere", "beat": __import__("time").time(), "started_at": "2026-10-12T14:00:00+00:00"}
    jobs.docs[f"default|p/base|{stem(OTHER)}"] = {"_id": f"default|p/base|{stem(OTHER)}", **row}
    st = asyncio.run(release.drawing_status(DB, "p/base"))
    assert (st["state"], st["pct"], st["stage"]) == ("making", 48, "projecting the right view")
    assert st["job"]["by"] == "chat" and st["job"]["heartbeat"]
    jobs.docs.clear()
    jobs.docs["default|p/base|ee"] = {"_id": "default|p/base|ee", "state": "failed", "error": "old STEP"}
    assert asyncio.run(release.drawing_status(DB, "p/base"))["state"] == "none"
    jobs.docs[f"default|p/base|{stem(OTHER)}"] = {"_id": f"default|p/base|{stem(OTHER)}", "state": "failed",
                                                   "error": "out of memory"}
    st = asyncio.run(release.drawing_status(DB, "p/base"))
    assert st["state"] == "failed" and st["failed"]["reason"] == "out of memory"
    release._DUE["p/bare"] = "2026-10-12T14:32:00+00:00"
    assert asyncio.run(release.drawing_status(DB, "p/bare"))["scheduled_at"].startswith("2026-10-12T14:32")


def test_making_follows_progress_and_keeps_a_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    monkeypatch.setattr(DB, "colls", {})
    monkeypatch.setattr(release, "BEAT_S", 0.01)
    seen = []

    async def fake(step, out, *, preview=False, on_progress=None, **kw):
        assert preview
        on_progress(30, "projecting the top view")
        await asyncio.sleep(0.05)                  # beaten meanwhile, with the progress
        seen.append(await release.drawing_status(DB, "p/lid"))
        out.with_suffix(".png").write_bytes(b"PNG")
        out.write_bytes(b"%PDF")

    async def step(db, mid, label):
        return b"STEP"
    monkeypatch.setattr(release, "drawing", fake)
    monkeypatch.setattr(release.store, "get_artifact", step)
    assert asyncio.run(release.model_drawing(DB, "p/lid")) == b"%PDF"
    assert seen[0]["state"] == "making" and seen[0]["pct"] == 30 and seen[0]["job"]["by"] == "room"
    assert DB[release.JOBS].docs == {}             # made: the file says so, no row is left
    assert asyncio.run(release.model_drawing_preview(DB, "p/lid")) == b"PNG"

    async def broken(step, out, **kw):
        return "drawing failed: out of memory"
    monkeypatch.setattr(release, "drawing", broken)
    with pytest.raises(RuntimeError):
        asyncio.run(release.model_drawing(DB, "p/lid", again=True))
    assert [r["state"] for r in DB[release.JOBS].docs.values()] == ["failed"]
    st = asyncio.run(release.drawing_status(DB, "p/lid"))
    assert st["state"] == "ready" and "out of memory" in st["failed"]["reason"]   # the last one stays


def test_the_progress_lines_are_followed(tmp_path, monkeypatch):
    """drawing() reads techdraw.py's @progress lines as they come."""
    script = tmp_path / "fake.sh"
    script.write_text("#!/bin/sh\necho '@progress 10 projecting the front view'\necho noise\n"
                      "echo '@progress 95 writing the PDF'\nexit 3\n")
    script.chmod(0o755)
    real = asyncio.create_subprocess_exec

    async def run(*argv, **kw):
        return await real(str(script), **kw)
    monkeypatch.setattr(release.asyncio, "create_subprocess_exec", run)
    heard = []
    why = asyncio.run(release.drawing(b"STEP", tmp_path / "x.pdf", title="t", project="p", tag="", ident="p/x",
                                      sha="", preview=True, on_progress=lambda p, s: heard.append((p, s))))
    assert heard == [(10, "projecting the front view"), (95, "writing the PDF")]
    assert why == "noise"


def test_making_needs_the_right_to_run_looking_does_not():
    assert access.action("POST", "/api/models/p/lid/drawing") == "run"
    assert access.page_allowed("GET", "/api/models/p/lid/drawing/status")
    assert access.page_allowed("GET", "/api/models/p/lid/drawing.png")


@pytest.mark.skipif(not shutil.which("docker"), reason="needs docker and the redline-draw image")
def test_the_sheet_preview_and_info(tmp_path):
    """techdraw.py --png --info, in its own image: a Turkish name drawn (a
    Unicode font), and a small part on A4 at the largest scale it fits."""
    if subprocess.run(["docker", "image", "inspect", "redline-draw"], capture_output=True).returncode:
        pytest.skip("the redline-draw image is not built")
    tmp_path.chmod(0o777)
    script = ("from build123d import Box, Cylinder, export_step\n"
              "export_step(Box(40, 30, 10) - Cylinder(5, 20), '/work/m.step')\n"
              "import subprocess, sys\n"
              "sys.exit(subprocess.run([sys.executable, '/tools/techdraw.py', '/work/m.step', '/work/d.pdf',"
              " '--title', 'Anahtarlık İskelet', '--png', '/work/d.png', '--info', '/work/d.json']).returncode)\n")
    run = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{tmp_path}:/work",
                          "-v", f"{release.ROOT / 'tools'}:/tools:ro", "--entrypoint", "python",
                          "redline-draw", "-c", script], capture_output=True, text=True, timeout=240)
    assert run.returncode == 0, run.stdout + run.stderr
    assert re.search(r"@progress \d+ projected the isometric view \(\d of 4\)", run.stdout)
    png = (tmp_path / "d.png").read_bytes()
    assert png.startswith(b"\x89PNG") and len(png) < 100_000
    assert int.from_bytes(png[16:20], "big") == 480                      # its width
    info = json.loads((tmp_path / "d.json").read_text())
    assert info["sheet"] == "A4 landscape" and info["scale"] == "2:1"
    assert info["views"] == ["Front", "Right", "Top", "Isometric"]


def test_a_crash_is_tried_once_more(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    monkeypatch.setattr(DB, "colls", {})
    tries = []

    async def flaky(step, out, **kw):
        tries.append(1)
        if len(tries) == 1:
            return "the drawing crashed (exit 139)"
        out.write_bytes(b"%PDF")

    async def step(db, mid, label):
        return b"STEP"
    monkeypatch.setattr(release, "drawing", flaky)
    monkeypatch.setattr(release.store, "get_artifact", step)
    assert asyncio.run(release.model_drawing(DB, "p/lid")) == b"%PDF" and len(tries) == 2


def test_a_large_step_is_given_longer_to_draw():
    """A 108 MB assembly's six views did not fit in 300 s: the time grows
    with the STEP, within a ceiling."""
    assert release.draw_timeout(0) == release.DRAW_TIMEOUT
    assert 700 < release.draw_timeout(108 * 2**20) < 800
    assert release.draw_timeout(10 * 2**30) == release.DRAW_TIMEOUT_MAX
