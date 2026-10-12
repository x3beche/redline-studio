"""A model's technical drawing has an SVG preview beside its PDF (backend/
release.py, tools/techdraw.py --svg): GET /api/models/<id>/drawing.svg
gives it only when the drawing is already made - a 404 "not made yet"
otherwise, and that route never makes one."""

from __future__ import annotations

import asyncio
import shutil
import subprocess

import pytest
from fastapi import HTTPException

from backend import main, release

SHA = "ab" * 32


class Models:
    def __init__(self, docs):
        self.docs = docs

    async def find_one(self, q, projection=None):
        return self.docs.get(q["_id"])


class Db:
    def __init__(self, docs):
        self.models = Models(docs)


DB = Db({"p/lid": {"_id": "p/lid", "title": "Lid", "artifacts": {"step": {"sha256": SHA, "bytes": 10}}},
         "p/bare": {"_id": "p/bare", "artifacts": {}}})


@pytest.fixture
def kept(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)

    async def never(*a, **kw):
        raise AssertionError("the preview made a drawing")
    monkeypatch.setattr(release, "drawing", never)
    monkeypatch.setattr(main, "db", lambda: DB)
    return tmp_path


def test_not_made_yet_is_a_404_and_makes_nothing(kept):
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.model_drawing_preview("p/lid"))
    assert e.value.status_code == 404 and e.value.detail == "not made yet"
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.model_drawing_preview("p/bare"))         # no STEP to draw from
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.model_drawing_preview("p/gone"))
    assert e.value.status_code == 404
    assert not list(kept.glob("*-v*"))


def test_a_made_drawing_gives_its_svg(kept):
    stem = f"{SHA[:24]}-v{release.DRAW_VERSION}"
    (kept / f"{stem}.svg").write_text("<svg/>")
    # Not until the PDF is there too: that is what says the drawing is made.
    with pytest.raises(HTTPException):
        asyncio.run(main.model_drawing_preview("p/lid"))
    (kept / f"{stem}.pdf").write_bytes(b"%PDF")
    res = asyncio.run(main.model_drawing_preview("p/lid"))
    assert res.body == b"<svg/>" and res.media_type == "image/svg+xml"
    # A drawing of an older version is not this one.
    (kept / f"{stem}.svg").rename(kept / f"{SHA[:24]}-v{release.DRAW_VERSION - 1}.svg")
    with pytest.raises(HTTPException):
        asyncio.run(main.model_drawing_preview("p/lid"))


def test_making_a_drawing_asks_for_the_preview_too(tmp_path, monkeypatch):
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    seen = {}

    async def fake(step, out, *, svg=None, **kw):
        seen["svg"] = svg
        svg.write_text("<svg/>")
        out.write_bytes(b"%PDF")

    async def step(db, mid, label):
        return b"STEP"
    monkeypatch.setattr(release, "drawing", fake)
    monkeypatch.setattr(release.store, "get_artifact", step)
    assert asyncio.run(release.model_drawing(DB, "p/lid")) == b"%PDF"
    assert seen["svg"].name == f"{SHA[:24]}-v{release.DRAW_VERSION}.svg"
    assert asyncio.run(release.model_drawing_preview(DB, "p/lid")) == b"<svg/>"


@pytest.mark.skipif(not shutil.which("docker"), reason="needs docker and the redline-draw image")
def test_the_sheet_as_svg(tmp_path):
    """techdraw.py --svg, in its own image: the views, dimensions and
    title block of the PDF, as SVG."""
    have = subprocess.run(["docker", "image", "inspect", "redline-draw"], capture_output=True)
    if have.returncode:
        pytest.skip("the redline-draw image is not built")
    tmp_path.chmod(0o777)
    script = ("from build123d import Box, Cylinder, export_step\n"
              "export_step(Box(40, 30, 10) - Cylinder(5, 20), '/work/m.step')\n"
              "import subprocess, sys\n"
              "sys.exit(subprocess.run([sys.executable, '/tools/techdraw.py', '/work/m.step', '/work/d.pdf',"
              " '--title', 'Plate', '--svg', '/work/d.svg']).returncode)\n")
    run = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{tmp_path}:/work",
                          "-v", f"{release.ROOT / 'tools'}:/tools:ro", "--entrypoint", "python",
                          "redline-draw", "-c", script], capture_output=True, text=True, timeout=240)
    assert run.returncode == 0, run.stdout + run.stderr
    svg = (tmp_path / "d.svg").read_text()
    assert svg.startswith("<svg") and 'viewBox="0 0 420 297"' in svg
    for word in (">FRONT<", ">ISOMETRIC<", ">Plate<", ">40<", ">30<", ">2:1<"):
        assert word in svg
    assert "stroke-dasharray" in svg                          # the hole's hidden edges
    assert 'transform="rotate(-90' in svg                     # a vertical dimension's figure
