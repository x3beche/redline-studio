"""A model's technical drawing laid out by hand (backend/drawlayout.py,
tools/techdraw.py --spec, the chat tool drawing_layout).

What matters: a spec is checked and kept in one form, on the model, per
workspace, versioned, with a 409 for a save over someone else's; putting
it back to automatic drops it; saving it needs the right to edit, reading
it is looking; the kept drawing's name carries the spec's fingerprint, so
a changed layout is a new drawing (and the automatic one's still there),
and making it hands the spec to techdraw.py; techdraw.py itself lays out
the boxes, leaves parts out and draws the sheet the spec says (in its own
image)."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess

import pytest
from fastapi import HTTPException

from backend import access, actors, chat_tools, drawlayout, main, release, scope
from backend.chat_tools import Ctx, ToolError
from tests.test_cc_mentions_live_search import Raw as FakeDb
from tests.test_chat_tools import run as run_tool

SHA = "ab" * 32
ME = {"id": "u-me", "name": "Me", "type": "person"}

SPEC = {"sheet": {"size": "A4", "orientation": "portrait"},
        "views": [{"view": "front", "x": .06, "y": .05, "w": .5, "h": .35, "scale": "auto", "dims": True},
                  {"view": "left", "x": .58, "y": .05, "w": .36, "h": .35, "hidden_lines": False},
                  {"view": "bottom", "x": .06, "y": .42, "w": .5, "h": .38, "scale": "1:1", "dims": False},
                  {"view": "iso", "x": .58, "y": .42, "w": .36, "h": .38}],
        "parts": {"hide": ["button"], "highlight": ["post"]}, "title": "Custom  Title", "notes": "My notes"}


def test_a_spec_is_kept_in_one_form():
    got = drawlayout.validate(SPEC)
    assert got["sheet"] == {"size": "A4", "orientation": "portrait"}
    # No scale given (or an older "auto"/"fit"): the view fills its box.
    assert got["views"][1] == {"view": "left", "x": .58, "y": .05, "w": .36, "h": .35, "scale": "fill",
                               "hidden_lines": False, "dims": True}
    # The isometric view: no hidden lines and no dimensions unless said - never dimensions.
    assert got["views"][3]["hidden_lines"] is False and got["views"][3]["dims"] is False
    assert got["parts"] == {"hide": ["button"], "highlight": ["post"]}
    assert got["title"] == "Custom Title" and got["notes"] == "My notes"
    assert drawlayout.validate({"views": [{"view": "top", "x": 0, "y": 0, "w": 1, "h": 1}]})["sheet"] == \
        {"size": "auto", "orientation": "landscape"}


@pytest.mark.parametrize("bad, said", [
    ({"views": []}, "at least one"),
    ({"views": [{"view": "side", "x": 0, "y": 0, "w": .5, "h": .5}]}, "view must be one of"),
    ({"views": [{"view": "top", "x": .7, "y": 0, "w": .5, "h": .5}]}, "off the sheet"),
    ({"views": [{"view": "top", "x": 0, "y": 0, "w": .01, "h": .5}]}, "at least"),
    ({"views": [{"view": "top", "x": 0, "y": 0, "w": .5, "h": .5, "scale": "3:0"}]}, "scale must be"),
    ({"views": [{"view": "top", "x": "0", "y": 0, "w": .5, "h": .5}]}, "must be a number"),
    ({"views": [{"view": "top", "x": 0, "y": 0, "w": .5, "h": .5}], "sheet": {"size": "A0"}}, "sheet size"),
    ({"views": [{"view": "top", "x": 0, "y": 0, "w": .5, "h": .5}], "colour": 1}, "unknown field"),
    ({"views": [{"view": "top", "x": 0, "y": 0, "w": .2, "h": .2}] * 9}, "at most 8"),
    ({"views": [{"view": "top", "x": 0, "y": 0, "w": .5, "h": .5}], "parts": {"hide": "lid"}}, "list of part"),
])
def test_a_wrong_spec_is_said(bad, said):
    with pytest.raises(drawlayout.LayoutError) as e:
        drawlayout.validate(bad)
    assert said in str(e.value)


def test_the_fingerprint_follows_the_spec():
    a = drawlayout.validate(SPEC)
    b = drawlayout.validate({**SPEC, "notes": "Other"})
    assert drawlayout.digest(None) == "" and drawlayout.digest(a) == drawlayout.digest(drawlayout.validate(SPEC))
    assert drawlayout.digest(a) != drawlayout.digest(b)
    meta = {"sha256": SHA}
    assert release._kept(meta).name == f"{SHA[:24]}-v{release.DRAW_VERSION}.pdf"
    assert release._kept(meta, ".png", drawlayout.digest(a)).name == \
        f"{SHA[:24]}-v{release.DRAW_VERSION}-l{drawlayout.digest(a)}.png"


@pytest.fixture
def ws(monkeypatch, tmp_path):
    """A workspace with a model, its routes' database, and who asks."""
    fake = FakeDb()
    fake["models"].rows["p/lid"] = {"_id": "p/lid", "title": "Lid", "name": "lid",
                                    "artifacts": {"step": {"sha256": SHA, "bytes": 10}}}
    fake["models"].rows["q/other"] = {"_id": "q/other", "title": "Other", "workspace_id": "u-else",
                                      "artifacts": {"step": {"sha256": SHA, "bytes": 10}}}
    db = scope.ScopedDb(fake, "default")
    state = {"role": "editor"}
    monkeypatch.setattr(main, "db", lambda: db)
    monkeypatch.setattr(actors, "current", lambda: ME)
    monkeypatch.setattr(access, "current", lambda: state["role"])
    monkeypatch.setattr(release, "DRAWINGS", tmp_path)
    from test_telegram import Coll
    fake.colls[release.JOBS] = Coll()           # the job rows: claimed, beaten, cleared
    return db, fake, state


def test_the_routes_keep_it_on_the_model_versioned(ws):
    db, fake, _ = ws
    got = asyncio.run(drawlayout.layout_get("p/lid"))
    assert got["spec"] is None and got["version"] == 0
    body = drawlayout.LayoutIn(spec=SPEC, version=0, names=["base", "post", "button"])
    got = asyncio.run(drawlayout.layout_put("p/lid", body))
    assert got["version"] == 1 and got["spec"]["views"][0]["view"] == "front" and got["key"]
    kept = fake["models"].rows["p/lid"]["drawing_layout"]
    assert kept["by"]["name"] == "Me" and kept["names"] == ["base", "post", "button"]
    # A save made on version 0 again: someone saved since.
    with pytest.raises(HTTPException) as e:
        asyncio.run(drawlayout.layout_put("p/lid", drawlayout.LayoutIn(spec=SPEC, version=0)))
    assert e.value.status_code == 409
    with pytest.raises(HTTPException) as e:
        asyncio.run(drawlayout.layout_put("p/lid", drawlayout.LayoutIn(spec={"views": []})))
    assert e.value.status_code == 400
    # Back to automatic; the names stay for the next one.
    got = asyncio.run(drawlayout.layout_put("p/lid", drawlayout.LayoutIn(spec=None, version=1)))
    assert got["spec"] is None and got["version"] == 2 and got["names"] == ["base", "post", "button"]
    # Another workspace's model is not there.
    for call in (drawlayout.layout_get("q/other"),
                 drawlayout.layout_put("q/other", drawlayout.LayoutIn(spec=SPEC))):
        with pytest.raises(HTTPException) as e:
            asyncio.run(call)
        assert e.value.status_code == 404
    assert "drawing_layout" not in fake["models"].rows["q/other"]


def test_saving_is_editing_the_model_and_the_route_is_its_own():
    assert access.action("PUT", "/api/models/p/lid/drawing/layout") == "edit"
    assert access.page_allowed("GET", "/api/models/p/lid/drawing/layout")
    assert not access.page_allowed("PUT", "/api/models/p/lid/drawing/layout")
    # Matched before PUT /api/models/{id}, which would save it as a model's source.
    from starlette.routing import Match
    scope_ = {"type": "http", "path": "/api/models/p/lid/drawing/layout", "method": "PUT"}
    first = next(r for r in main.app.routes if getattr(r, "matches", None) and r.matches(scope_)[0] == Match.FULL)
    assert getattr(first, "original_router", None) is drawlayout.router or \
        getattr(first, "endpoint", None) is drawlayout.layout_put


def test_a_changed_layout_is_a_new_drawing_made_with_it(ws):
    db, fake, _ = ws
    seen = []

    async def fake_draw(step, out, *, spec=None, preview=False, on_progress=None, **kw):
        seen.append((out.name, spec))
        out.with_suffix(".png").write_bytes(b"PNG")
        out.write_bytes(b"%PDF" + out.name.encode())

    async def step(db_, mid, label):
        return b"STEP"
    import backend.release as rel
    rel.drawing, old = fake_draw, rel.drawing
    rel.store.get_artifact, old_get = step, rel.store.get_artifact
    try:
        auto = asyncio.run(release.model_drawing(db, "p/lid"))
        assert seen[-1][1] is None and "-l" not in seen[-1][0]
        st = asyncio.run(release.drawing_status(db, "p/lid"))
        assert st["state"] == "ready" and st["layout"]["custom"] is False

        asyncio.run(drawlayout.write(db, "p/lid", SPEC, names=["base", "post"], actor=ME))
        st = asyncio.run(release.drawing_status(db, "p/lid"))
        # The automatic one's drawing is not this layout's.
        assert st["state"] == "none" and st["layout"]["custom"] and st["key"].endswith(st["layout"]["key"])
        assert asyncio.run(release.model_drawing_preview(db, "p/lid")) is None
        made = asyncio.run(release.model_drawing(db, "p/lid"))
        assert made != auto and f"-l{st['layout']['key']}" in seen[-1][0]
        spec = seen[-1][1]
        assert spec["views"][2]["scale"] == "1:1" and spec["parts"] == {"hide": ["button"], "highlight": ["post"],
                                                                      "names": ["base", "post"]}
        assert asyncio.run(release.model_drawing_preview(db, "p/lid")) == b"PNG"
        # Back to automatic: the first drawing again, not made anew.
        n = len(seen)
        asyncio.run(drawlayout.write(db, "p/lid", None, actor=ME))
        assert asyncio.run(release.model_drawing(db, "p/lid")) == auto and len(seen) == n
    finally:
        rel.drawing, rel.store.get_artifact = old, old_get


def test_the_spec_goes_to_techdraw_as_a_file(tmp_path, monkeypatch):
    """drawing() writes the spec beside the STEP and names it with --spec."""
    argvs = []

    async def run(*argv, **kw):
        argvs.append(argv)
        work = next(a for a in argv if str(a).endswith(":/work")).split(":")[0]
        argvs.append(json.loads(open(f"{work}/spec.json").read()))
        return await real("true", **kw)
    real = asyncio.create_subprocess_exec
    monkeypatch.setattr(release.asyncio, "create_subprocess_exec", run)
    asyncio.run(release.drawing(b"STEP", tmp_path / "x.pdf", title="t", project="p", tag="", ident="p/x", sha="",
                                spec={"views": [1]}))
    assert "--spec" in argvs[0] and argvs[1] == {"views": [1]}


def test_the_chat_tool_reads_sets_and_resets(ws):
    db, fake, state = ws
    tool = chat_tools.tools()["drawing_layout"]
    assert (tool.package, tool.level) == ("cad", "change")

    def call(args):
        return run_tool(tool.run(Ctx(db=db, actor=ME), args))
    got = call({"model": "p/lid"})
    assert "automatically" in got.text
    got = call({"model": "Lid", "action": "set", "spec": SPEC})
    assert "Layout version 1" in got.text and fake["models"].rows["p/lid"]["drawing_layout"]["spec"]["views"]
    with pytest.raises(ToolError) as e:
        call({"model": "p/lid", "action": "set", "spec": {"views": [{"view": "top"}]}})
    assert "number" in str(e.value)
    got = call({"model": "p/lid", "action": "reset"})
    assert fake["models"].rows["p/lid"]["drawing_layout"]["spec"] is None and "automatically" in got.text
    # Someone who may only look cannot change it.
    state["role"] = "viewer"
    assert "automatically" in call({"model": "p/lid"}).text
    with pytest.raises(ToolError):
        call({"model": "p/lid", "action": "set", "spec": SPEC})


def test_the_chat_tools_make_runs_in_a_process_of_its_own(ws, monkeypatch):
    """make=true starts the drawing the way drawing_get's Make now does - a
    detached process (chat_tools/_drawing_job.py), shown waiting at once -
    not a task in the answer's runner, which ends with the answer."""
    from backend.chat_tools import _drawing_job
    db, fake, state = ws
    spawned = []

    async def spawn(ws_, mid, again):
        spawned.append((ws_, mid, again))
        return 1

    async def never(*a, **kw):
        raise AssertionError("made inside the answer's runner")
    monkeypatch.setattr(_drawing_job, "spawn", spawn)
    monkeypatch.setattr(release, "start_drawing", never)
    monkeypatch.setattr(release, "model_drawing", never)
    tool = chat_tools.tools()["drawing_layout"]
    got = run_tool(tool.run(Ctx(db=db, actor=ME), {"model": "p/lid", "action": "set", "spec": SPEC, "make": True}))
    assert spawned == [("default", "p/lid", True)] and "being made" in got.text
    st = asyncio.run(release.drawing_status(db, "p/lid"))
    assert st["state"] == "queued" and st["job"]["by"] == "chat" and st["key"].endswith(st["layout"]["key"])
    # Asked again while it is under way: not a second one.
    run_tool(tool.run(Ctx(db=db, actor=ME), {"model": "p/lid", "action": "set", "spec": SPEC, "make": True}))
    assert len(spawned) == 1


@pytest.mark.skipif(not shutil.which("docker"), reason="needs docker and the redline-draw image")
def test_techdraw_draws_the_layout(tmp_path):
    """techdraw.py --spec, in its own image: an assembly on A4 portrait with
    its boxes, one part left out (the overall size without it), one drawn
    heavier, a box at a scale of its own, and the title and notes put in."""
    if subprocess.run(["docker", "image", "inspect", "redline-draw"], capture_output=True).returncode:
        pytest.skip("the redline-draw image is not built")
    tmp_path.chmod(0o777)
    (tmp_path / "spec.json").write_text(json.dumps(drawlayout.for_drawing({"spec": drawlayout.validate(SPEC)})))
    script = ("from build123d import Box, Cylinder, Compound, Pos, export_step\n"
              "a = Box(60, 40, 10); a.label = 'base'\n"
              "b = Pos(0, 0, 15) * Cylinder(8, 20); b.label = 'post'\n"
              "c = Pos(20, 10, 40) * Box(6, 6, 6); c.label = 'button'\n"
              "export_step(Compound(label='Station', children=[a, Compound(label='Top Parts', children=[b, c])]),"
              " '/work/m.step')\n"
              "import subprocess, sys\n"
              "sys.exit(subprocess.run([sys.executable, '/tools/techdraw.py', '/work/m.step', '/work/d.pdf',"
              " '--png', '/work/d.png', '--info', '/work/d.json', '--spec', '/work/spec.json']).returncode)\n")
    run = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{tmp_path}:/work",
                          "-v", f"{release.ROOT / 'tools'}:/tools:ro", "--entrypoint", "python",
                          "redline-draw", "-c", script], capture_output=True, text=True, timeout=240)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "projected the left view" in run.stdout and "projected the bottom view" in run.stdout
    info = json.loads((tmp_path / "d.json").read_text())
    assert info["sheet"] == "A4 portrait" and info["layout"] == "custom"
    assert info["views"] == ["Front", "Left", "Bottom", "Isometric"]
    # The button (up at z 37..43) is left out: 30 mm tall, not 43.
    assert info["size_mm"] == [60.0, 40.0, 30.0]
    assert info["parts"] == ["base", "Top_Parts", "post", "button"] and info["unmatched"] == []
    assert [b["scale"] for b in info["boxes"]] == ["fill", "fill", "1:1", "auto"]
    assert info["boxes"][0]["x"] == pytest.approx(.06, abs=.001)
    png = (tmp_path / "d.png").read_bytes()
    assert png.startswith(b"\x89PNG") and int.from_bytes(png[16:20], "big") == 480
    words = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{tmp_path}:/work",
                            "--entrypoint", "python", "redline-draw", "-c",
                            "import fitz; print(' '.join(w[4] for w in fitz.open('/work/d.pdf')[0].get_text('words')))"],
                           capture_output=True, text=True, timeout=60).stdout
    for w in ("FRONT", "LEFT", "BOTTOM", "ISOMETRIC", "Custom Title", "My notes"):
        assert w in words


def test_every_view_fills_its_own_box(tmp_path):
    """Each box's view is drawn as large as its box allows, at a ratio in
    steps of 0.05 ("auto" and "fit" of older layouts read as that too); the
    title block then says AS SHOWN, each view its own scale."""
    assert drawlayout.validate({"views": [{"view": "front", "x": .05, "y": .05, "w": .5, "h": .6, "scale": "fit"},
                                          {"view": "top", "x": .6, "y": .05, "w": .3, "h": .3, "scale": "fill"}]})
    if subprocess.run(["docker", "image", "inspect", "redline-draw"], capture_output=True).returncode:
        pytest.skip("the redline-draw image is not built")
    tmp_path.chmod(0o777)
    spec = {"sheet": {"size": "A3", "orientation": "landscape"},
            "views": [{"view": "front", "x": .03, "y": .04, "w": .6, "h": .7, "scale": "fit"},
                      {"view": "right", "x": .66, "y": .04, "w": .12, "h": .2, "scale": "auto"},
                      {"view": "top", "x": .66, "y": .4, "w": .3, "h": .3, "scale": "fill"}]}
    (tmp_path / "spec.json").write_text(json.dumps(drawlayout.for_drawing({"spec": drawlayout.validate(spec)})))
    script = ("from build123d import Box, export_step\n"
              "export_step(Box(60, 40, 30), '/work/m.step')\n"
              "import subprocess, sys\n"
              "sys.exit(subprocess.run([sys.executable, '/tools/techdraw.py', '/work/m.step', '/work/d.pdf',"
              " '--info', '/work/d.json', '--spec', '/work/spec.json']).returncode)\n")
    run = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{tmp_path}:/work",
                          "-v", f"{release.ROOT / 'tools'}:/tools:ro", "--entrypoint", "python",
                          "redline-draw", "-c", script], capture_output=True, text=True, timeout=240)
    assert run.returncode == 0, run.stdout + run.stderr
    info = json.loads((tmp_path / "d.json").read_text())
    assert [b["scale"] for b in info["boxes"]] == ["fill", "fill", "fill"]
    assert info["scale"] == "AS SHOWN"
    words = subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", f"{tmp_path}:/work",
                            "--entrypoint", "python", "redline-draw", "-c",
                            "import fitz; print(' '.join(w[4] for w in fitz.open('/work/d.pdf')[0].get_text('words')))"],
                           capture_output=True, text=True, timeout=60).stdout
    # The big box draws its view larger than the small one does, each to scale.
    assert "NOT TO SCALE" not in words
    assert "FRONT" in words and ":1)" in words, words


def test_a_typed_scale_is_kept_as_a_ratio():
    got = drawlayout.validate({"views": [{"view": "front", "x": .05, "y": .05, "w": .5, "h": .6, "scale": "1,70 : 1"}]})
    assert got["views"][0]["scale"] == "1.7:1"
    for bad in ("1:0", "abc", "1000:1", "1:1000"):
        with pytest.raises(drawlayout.LayoutError):
            drawlayout.validate({"views": [{"view": "front", "x": .05, "y": .05, "w": .5, "h": .6, "scale": bad}]})


def test_fill_takes_a_ratio_to_a_tenth_either_way():
    """Above 1:1 the ratio is n:1, below it 1:n, in steps of 0.05 so the view still fits."""
    # techdraw.py runs in its own image (fpdf2, build123d): the function alone is read here.
    src = (release.ROOT / "tools" / "techdraw.py").read_text()
    ns: dict = {}
    exec(src[src.index("def fill_ratio"):src.index("def pads(")], ns)
    fill_ratio = ns["fill_ratio"]
    assert fill_ratio(1.74) == (1.7, 1)
    assert fill_ratio(2.0) == (2, 1)
    assert fill_ratio(0.77) == (1, 1.3)
    assert fill_ratio(0.42) == (1, 2.4)
    assert fill_ratio(0.5) == (1, 2)
    assert fill_ratio(0.8) == (1, 1.25)
    assert fill_ratio(1.76) == (1.75, 1)
