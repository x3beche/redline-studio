"""The coding rooms: a project's checkout, its diff, and what a mark is on.

Real git in a temporary directory, never the checkout this runs from: the
point of `dirty` is that somebody else's uncommitted work stays out of a
note's diff, and that has to be shown with a second person's edit in the
tree, not assumed.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from backend import apps, webshot


def run(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True,
                   capture_output=True)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "proj"
    r.mkdir()
    run(r, "init", "-q", "-b", "main")
    run(r, "config", "user.email", "t@example.com")
    run(r, "config", "user.name", "t")
    (r / "src").mkdir()
    (r / "src" / "a.ts").write_text("one\ntwo\nthree\n")
    (r / "src" / "b.ts").write_text("alpha\n")
    run(r, "add", ".")
    run(r, "commit", "-q", "-m", "first")
    return r


def test_a_note_diff_leaves_out_what_was_already_dirty(repo):
    # Somebody else is half way through b.ts when the note is drawn.
    (repo / "src" / "b.ts").write_text("alpha\nsomebody else's line\n")
    base = apps.head(repo)
    then = apps.dirty(repo)
    assert list(then) == ["src/b.ts"]

    # The work the note asked for: a.ts changes, and a new file appears.
    (repo / "src" / "a.ts").write_text("one\nTWO\nthree\n")
    (repo / "src" / "new.ts").write_text("fresh\n")

    paths = apps.changed_since(repo, base, then)
    assert paths == ["src/a.ts", "src/new.ts"]

    d = apps.parse(apps.patch(repo, base, paths))
    by = {f["path"]: f for f in d["files"]}
    assert set(by) == {"src/a.ts", "src/new.ts"}
    assert by["src/a.ts"]["added"] == 1 and by["src/a.ts"]["removed"] == 1
    assert by["src/new.ts"]["status"] == "added"
    assert (d["added"], d["removed"]) == (2, 1)


def test_a_file_that_moves_again_joins_the_note(repo):
    """Already dirty when drawn, then edited for the note: it is the note's
    now, because its content is not what it was."""
    (repo / "src" / "b.ts").write_text("alpha\nx\n")
    base, then = apps.head(repo), apps.dirty(repo)
    (repo / "src" / "b.ts").write_text("alpha\nx\ny\n")
    assert apps.changed_since(repo, base, then) == ["src/b.ts"]


def test_a_file_dirty_when_drawn_is_diffed_from_how_it_was_then(
        repo, tmp_path, monkeypatch):
    """Somebody's half-finished edit is in the file the note is about. The
    note's diff is the note's work: their lines are not in it."""
    monkeypatch.setattr(apps, "BLOBS", tmp_path / "blobs")
    (repo / "src" / "a.ts").write_text("one\ntheirs\ntwo\nthree\n")
    base, then = apps.head(repo), apps.dirty(repo)
    assert apps.snapshot(repo, then) == 1
    assert apps.blob_sha((repo / "src" / "a.ts").read_bytes()) == then["src/a.ts"]

    (repo / "src" / "a.ts").write_text("one\ntheirs\ntwo\nTHREE\n")
    paths = apps.changed_since(repo, base, then)
    d = apps.parse(apps.patch(repo, base, paths, then))
    f = d["files"][0]
    assert f["path"] == "src/a.ts"
    changed = [l for h in f["hunks"] for l in h["lines"] if l[0] != " "]
    assert changed == [["-", 4, None, "three"], ["+", None, 4, "THREE"]]


def test_a_copy_is_only_kept_under_its_own_hash(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(apps, "BLOBS", tmp_path / "blobs")
    (repo / "src" / "a.ts").write_text("changed\n")
    assert apps.snapshot(repo, {"src/a.ts": "0" * 40}) == 0


def test_committed_work_still_counts(repo):
    base, then = apps.head(repo), apps.dirty(repo)
    (repo / "src" / "a.ts").write_text("one\n")
    run(repo, "commit", "-qam", "the fix")
    assert apps.changed_since(repo, base, then) == ["src/a.ts"]
    d = apps.parse(apps.patch(repo, base, ["src/a.ts"]))
    assert d["removed"] == 2


def test_hunk_lines_carry_both_line_numbers():
    text = ("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n"
            "@@ -10,3 +10,3 @@ def f():\n a\n-b\n+B\n c\n")
    f = apps.parse(text)["files"][0]
    assert f["hunks"][0]["lines"] == [
        [" ", 10, 10, "a"], ["-", 11, None, "b"], ["+", None, 11, "B"],
        [" ", 12, 12, "c"]]


def test_a_huge_diff_is_cut_and_says_so(monkeypatch):
    monkeypatch.setattr(apps, "MAX_FILE_LINES", 5)
    body = "".join(f"+line {i}\n" for i in range(50))
    text = f"diff --git a/l b/l\n--- a/l\n+++ b/l\n@@ -0,0 +1,50 @@\n{body}"
    d = apps.parse(text)
    f = d["files"][0]
    assert d["cut"] and f["cut"]
    assert len(f["hunks"][0]["lines"]) == 5
    # The count is of the whole change, not of what was shown.
    assert f["added"] == 50


def test_test_counts_are_read_from_the_runner_summary():
    assert apps.counts("...\n===== 170 passed, 2 failed in 5.1s =====\n") \
        == {"passed": 170, "failed": 2}
    assert apps.counts("Tests:       3 passed, 3 total\n") == {"passed": 3}
    assert apps.counts("no summary at all") == {}
    # node --test, as TAP
    assert apps.counts("# tests 4\n# pass 4\n# fail 0\n# duration_ms 95\n") == {"passed": 4}
    assert apps.counts("# pass 3\n# fail 1\n") == {"passed": 3, "failed": 1}


def test_a_project_must_be_a_git_checkout(tmp_path, repo):
    with pytest.raises(ValueError):
        apps.clean({"repo": str(tmp_path / "nowhere"), "platform": "web"})
    with pytest.raises(ValueError):
        apps.clean({"repo": str(repo), "platform": "desktop"})
    ok = apps.clean({"repo": str(repo), "platform": "mobile", "url": "http://x"})
    assert ok["platform"] == "mobile" and ok["url"] == "http://x"
    assert apps.entry({"_id": "p", "platform": "embedded"})["ext"] == ".fw"


# ---------------- what a mark is on ----------------
TOOLBAR = {"i": 0, "tag": "div", "sel": "div.bar", "box": [600, 50, 110, 30]}
BUILD = {"i": 1, "tag": "button", "sel": "button.build", "box": [605, 54, 46, 24]}
LABEL = {"i": 2, "tag": "span", "sel": "button.build > span", "box": [612, 58, 30, 16]}
LAYOUT = {"i": 3, "tag": "button", "sel": "button.layout", "box": [655, 54, 50, 24]}
PAGE = {"i": 4, "tag": "main", "sel": "main", "box": [0, 0, 1280, 800]}
ELS = [PAGE, TOOLBAR, BUILD, LABEL, LAYOUT]


def test_a_ring_means_the_outermost_thing_it_covers():
    # Drawn round the build button, grazing half of the toolbar.
    got = webshot.under(ELS, [{"box": [598, 46, 60, 36], "tip": None}],
                        width=1280, height=800)
    assert [e["sel"] for e in got] == ["button.build"]


def test_an_arrow_means_what_its_head_is_on():
    # The arrow's box crosses both buttons; its head is on "lay out".
    got = webshot.under(ELS, [{"box": [500, 30, 180, 40], "tip": [680, 66]}],
                        width=1280, height=800)
    assert [e["sel"] for e in got] == ["button.layout"]


def test_the_whole_page_is_never_the_answer():
    got = webshot.under(ELS, [{"box": [100, 300, 50, 50], "tip": None}],
                        width=1280, height=800)
    assert got == []


def test_a_component_is_found_by_its_selector_and_its_markup_file(repo):
    comp = repo / "src" / "room.ts"
    comp.write_text("@Component({\n  selector: 'app-room-thing',\n"
                    "  templateUrl: './room.html',\n})\nexport class RoomThing {}\n")
    run(repo, "add", ".")
    webshot._FILES.clear()
    got = webshot.source_of(repo, "app-room-thing")
    assert got == {"ts": "src/room.ts", "file": "src/room.html"}
    assert webshot.source_of(repo, "app-nothing") is None

    d = webshot.describe(repo, {**BUILD, "text": "build",
                                "own": {"tag": "app-room-thing",
                                        "name": "_RoomThing"}})
    assert d["file"] == "src/room.html" and d["component"] == "RoomThing"
    assert webshot.label(d) == 'button.build "build" · src/room.html'


# ---------------- the picture itself ----------------
def test_a_note_can_be_any_of_the_three_coding_kinds():
    from pydantic import ValidationError

    from backend.main import RevisionIn

    for kind in ("web", "embedded", "mobile", "pcb", "cad"):
        assert RevisionIn(comment="x", kind=kind).kind == kind
    with pytest.raises(ValidationError):
        RevisionIn(comment="x", kind="code")
    note = RevisionIn(comment="x", kind="web",
                      code={"route": "/", "viewport": [1280, 800], "dom": []})
    assert note.code["viewport"] == [1280, 800]


def test_a_frozen_page_waits_on_disk_not_in_memory(tmp_path, monkeypatch):
    """The server reloads itself whenever a file changes, and a person can
    draw for as long as they like between the freeze and the save."""
    monkeypatch.setattr(webshot, "SHOTS", tmp_path / "shots")
    sid = webshot.keep({"png": b"\x89PNG...", "width": 10, "height": 10,
                        "elements": [BUILD]}, {"app": "p", "route": "/x"})
    back = webshot.recall(sid)
    assert back["route"] == "/x" and back["elements"][0]["sel"] == "button.build"
    assert webshot.picture(sid) == b"\x89PNG..."
    with pytest.raises(KeyError):
        webshot.recall("../../etc/passwd")


PAGE_HTML = b"""<!doctype html><html><body style="margin:0">
<main style="padding:20px"><button id="go" style="width:120px;height:40px">Go on</button>
<p class="note">a line of text</p></main></body></html>"""


def _web_image() -> bool:
    from backend import sandbox
    return sandbox.have_image("web")


@pytest.mark.skipif(not _web_image(), reason="needs the redline-code-web image")
def test_a_real_browser_photographs_the_page_and_lists_what_is_on_it():
    import http.server
    import threading

    class One(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.end_headers()
            self.wfile.write(PAGE_HTML)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), One)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    import asyncio
    try:
        # In the Web Programming container, the way the room takes it: the
        # page is on the host's loopback, and the container shares it.
        got, job = asyncio.run(webshot.shoot_in_container(
            f"http://127.0.0.1:{srv.server_port}/", 400, 300, wait=10))
    finally:
        srv.shutdown()
    assert got["png"].startswith(b"\x89PNG")
    from PIL import Image
    import io
    assert Image.open(io.BytesIO(got["png"])).size == (400, 300)
    button = next(e for e in got["elements"] if e["tag"] == "button")
    assert button["sel"] == "#go" and button["text"] == "Go on"
    # The box is where the button is on the picture: 20 px of padding in.
    assert button["box"] == [20, 20, 120, 40]
    assert job["wall_s"] > 0 and job["where"] == "container"
    # A ring round it on the picture comes back as the button.
    hit = webshot.under(got["elements"], [{"box": [10, 10, 150, 60], "tip": None}],
                        width=400, height=300)
    assert [e["sel"] for e in hit] == ["#go"]


# ---------------- one shared run, two agents ----------------
class _Runs:
    """Just the runs and revisions an agent's start and finish touch."""

    def __init__(self, rows):
        self.rows = {r["_id"]: dict(r) for r in rows}

    async def find_one(self, q):
        r = self.rows.get(q["_id"])
        return dict(r) if r else None

    async def replace_one(self, q, doc, upsert=False):
        self.rows[q["_id"]] = dict(doc)

    async def update_one(self, q, u, upsert=False):
        if q["_id"] in self.rows or upsert:
            self.rows.setdefault(q["_id"], {"_id": q["_id"]}).update(u["$set"])

    async def update_many(self, q, u, upsert=False):
        for i in q["_id"]["$in"]:
            if i in self.rows:
                self.rows[i].update(u["$set"])

    async def insert_one(self, doc):
        pass


class _Db:
    def __init__(self, runs):
        self.runs = _Runs(runs)
        self.revisions = _Runs([])
        self.activity = _Runs([])


def test_start_will_not_take_over_somebody_elses_open_run(monkeypatch):
    """A CAD run and a code run crossed on one database: the second start
    re-pointed the shared run, and the first agent's finish closed it."""
    import argparse
    import asyncio

    from tools import revisions

    db = _Db([{"_id": "current", "revision": "cad-1", "status": "running",
               "title": "screws", "started_at": "2026-09-24T07:19"}])
    monkeypatch.setattr(revisions, "connect", lambda: db)
    with pytest.raises(SystemExit) as out:
        asyncio.run(revisions.cmd_start(argparse.Namespace(
            id="web-1", title="run tests", force=False)))
    assert "cad-1" in str(out.value)
    assert db.runs.rows["current"]["revision"] == "cad-1"


def test_finish_by_id_closes_only_that_run(monkeypatch):
    import argparse
    import asyncio

    from tools import revisions

    db = _Db([{"_id": "current", "revision": "cad-1", "status": "running"},
              {"_id": "cad-1", "revision": "cad-1", "status": "running"},
              {"_id": "web-1", "revision": "web-1", "status": "running"}])
    monkeypatch.setattr(revisions, "connect", lambda: db)
    asyncio.run(revisions.cmd_finish(argparse.Namespace(
        id="web-1", failed=False, no_shot=True, room="cad")))
    assert db.runs.rows["web-1"]["status"] == "done"
    assert db.runs.rows["current"]["status"] == "running"
    assert db.runs.rows["cad-1"]["status"] == "running"


def test_rooms_have_runs_of_their_own(monkeypatch):
    """A tab's agent works while another room's run is open: the code note's
    run goes in its own room's document, and the 3D room's is untouched."""
    import argparse
    import asyncio

    from tools import revisions

    db = _Db([{"_id": "current", "revision": "cad-1", "status": "running"}])
    db.revisions = _Runs([{"_id": "web-1", "kind": "web"}])
    monkeypatch.setattr(revisions, "connect", lambda: db)
    asyncio.run(revisions.cmd_start(argparse.Namespace(
        id="web-1", title="run tests", force=False)))
    assert db.runs.rows["current:web"]["revision"] == "web-1"
    assert db.runs.rows["current"]["revision"] == "cad-1"
    asyncio.run(revisions.cmd_finish(argparse.Namespace(
        id="web-1", failed=False, no_shot=True, room="cad")))
    assert db.runs.rows["current:web"]["status"] == "done"
    assert db.runs.rows["current"]["status"] == "running"


# ---------------- the queues, over MCP ----------------
def test_mcp_server_speaks_the_protocol_over_stdio():
    """initialize, tools/list, and an unknown method - through a real
    process, the way an agent starts it from .mcp.json."""
    import json as _json
    import sys as _sys

    root = Path(__file__).resolve().parent.parent
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "nonsense"},
    ]
    out = subprocess.run([_sys.executable, str(root / "tools/mcp_server.py")],
                         input="".join(_json.dumps(m) + "\n" for m in msgs),
                         capture_output=True, text=True, timeout=30)
    replies = [_json.loads(line) for line in out.stdout.splitlines()]
    # The notification gets no answer; the three requests get one each.
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[0]["result"]["serverInfo"]["name"] == "redline"
    names = {t["name"] for t in replies[1]["result"]["tools"]}
    assert {"queue", "show", "start", "finish", "done", "ask", "chat"} <= names
    assert replies[2]["error"]["code"] == -32601


def test_mcp_tools_are_the_cli_commands():
    from tools import mcp_server as m

    assert m.argv("queue", {"room": "web"}) == ["queue", "--room", "web"]
    assert m.argv("log", {"text": "x", "room": "pcb", "percent": 40}) == \
        ["log", "x", "--room", "pcb", "-l", "info", "-p", "40"]
    assert m.argv("ask", {"text": "which?", "options": ["a", "b"]}) == \
        ["ask", "which?", "-o", "a", "-o", "b"]
    assert m.argv("finish", {"id": "r1", "failed": True}) == ["finish", "r1", "--failed"]
    with pytest.raises(ValueError):
        m.argv("start", {"id": "r1"})
    got = m.call("nope", {})
    assert got["isError"]


# ---------------- firmware ----------------
# Lines as arm-none-eabi-nm -S --size-sort -l and the linker's
# --print-memory-usage printed them for the STM32H743 firmware in PS.
NM_OUT = """\
08000194 00000048 t deregister_tm_clones
080057a0 00001414 T HAL_RCCEx_PeriphCLKConfig\t/p/fw/Drivers/STM32H7xx_HAL_Driver/Src/stm32h7xx_hal_rcc_ex.c:105
20000bf4 00002603 B memp_memory_PBUF_POOL_base\t/p/fw/cmake/stm32cubemx/../../Middlewares/LwIP/memp_std.h:134
24000010 00000100 D uwTickPrio\t/p/fw/Core/Src/main.c:40
0800a000 00000200 T memcpy\t/usr/lib/newlib/memcpy.c:12
"""
MEM_OUT = """Memory region         Used Size  Region Size  %age Used
          DTCMRAM:           0 B       128 KB      0.00%
           RAM_D2:       20612 B       288 KB      6.99%
           FLASH:      152128 B         2 MB      7.25%
"""


def test_firmware_symbols_carry_their_source():
    from backend import firmware

    syms = firmware.parse_nm(NM_OUT, "/p")
    by = {s["name"]: s for s in syms}
    # Largest first: 0x2603 of pool, then 0x1414 of clock setup.
    assert [s["name"] for s in syms[:2]] == ["memp_memory_PBUF_POOL_base",
                                             "HAL_RCCEx_PeriphCLKConfig"]
    assert by["HAL_RCCEx_PeriphCLKConfig"]["where"] == "flash"
    assert by["HAL_RCCEx_PeriphCLKConfig"]["file"] == \
        "fw/Drivers/STM32H7xx_HAL_Driver/Src/stm32h7xx_hal_rcc_ex.c"
    assert by["HAL_RCCEx_PeriphCLKConfig"]["line"] == 105
    # CubeMX's ../.. is resolved before the path is made relative.
    assert by["memp_memory_PBUF_POOL_base"]["file"] == "fw/Middlewares/LwIP/memp_std.h"
    assert by["memp_memory_PBUF_POOL_base"]["where"] == "ram"
    assert by["uwTickPrio"]["where"] == "both"
    # The C library is not the project's: no file, no line.
    assert by["memcpy"]["file"] is None and by["memcpy"]["line"] is None
    assert by["deregister_tm_clones"]["file"] is None


def test_firmware_memory_regions_from_the_linker():
    from backend import firmware

    mem = firmware.parse_memory(MEM_OUT)
    assert [r["name"] for r in mem] == ["DTCMRAM", "RAM_D2", "FLASH"]
    assert mem[2] == {"name": "FLASH", "used": 152128, "size": 2 * 1024 ** 2,
                      "pct": 7.25}


def test_the_firmware_page_tags_each_block_with_its_source():
    from backend import firmware

    data = {"regions": firmware.parse_memory(MEM_OUT),
            "symbols": firmware.parse_nm(NM_OUT, "/p"),
            "before": {"regions": [{"name": "FLASH", "used": 150000,
                                    "size": 2 * 1024 ** 2, "pct": 7.15}]}}
    page = firmware.page("PS", data)
    assert 'data-src="fw/Core/Src/main.c:40"' in page
    assert 'data-sym="HAL_RCCEx_PeriphCLKConfig"' in page
    # A region that grew says by how much.
    assert "+2.1 kB" in page


# ---------------- the phone ----------------
DUMP = """<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.x.app" content-desc="" bounds="[0,0][1080,2400]">
  <node index="0" text="Save" resource-id="com.x.app:id/save_button" class="android.widget.Button" package="com.x.app" content-desc="" bounds="[60,2000][520,2140]" />
  <node index="1" text="" resource-id="" class="android.widget.ImageView" package="com.x.app" content-desc="avatar" bounds="[40,120][200,280]" />
  <node index="2" text="" resource-id="android:id/navigationBarBackground" class="android.view.View" package="com.android.systemui" content-desc="" bounds="[0,2274][1080,2400]" />
</node></hierarchy>"""


def test_a_phone_screen_lists_its_views_by_resource_id():
    from backend import phone

    els = phone.parse_dump(DUMP)
    save = next(e for e in els if e["text"] == "Save")
    assert save["sel"] == "#save_button" and save["tag"] == "Button"
    assert save["box"] == [60, 2000, 460, 140]
    # No id: named by class and place, and its description is its text.
    avatar = next(e for e in els if e["tag"] == "ImageView")
    assert avatar["text"] == "avatar" and "ImageView[1]" in avatar["sel"]
    # A ring round the button on the screenshot is the button.
    hit = webshot.under(els, [{"box": [40, 1980, 500, 180], "tip": None}],
                        width=1080, height=2400)
    assert [e["sel"] for e in hit] == ["#save_button"]


def test_a_page_in_the_phones_browser_ends_at_the_navigation_bar():
    from backend import phone

    els = phone.parse_dump(DUMP)
    # 780 CSS px tall at 2.625: 2047.5 px, ending where the bar starts.
    assert phone.content_top(els, 2400, 780, 2.625) == 2274 - 2048


def test_a_view_is_traced_to_the_layout_that_declares_it(repo):
    from backend import phone

    (repo / "res").mkdir()
    (repo / "res" / "main.xml").write_text(
        '<LinearLayout>\n  <Button android:id="@+id/save_button" />\n</LinearLayout>\n')
    run(repo, "add", ".")
    assert phone.source_of_view(repo, "com.x.app:id/save_button") == \
        {"file": "res/main.xml", "line": 2}
    assert phone.source_of_view(repo, "") is None
    d = webshot.describe(repo, {**{"i": 0, "tag": "Button", "sel": "#save_button",
                                   "text": "Save", "box": [60, 2000, 460, 140]},
                                "own": {"rid": "com.x.app:id/save_button"}})
    assert d["file"] == "res/main.xml" and d["line"] == 2
    assert d["component"] == "save_button"


def test_an_esp32s_memory_comes_from_its_own_size_tool():
    from backend import firmware

    out = ('Not using an unsupported version of tool cmake\n'
           '{"version": "1.2", "layout": ['
           '{"name": "Flash Code", "total": 3342304, "used": 136894, "free": 3205410},'
           '{"name": "DRAM", "total": 180736, "used": 11508, "free": 169228},'
           '{"name": "RTC FAST", "total": 8192, "used": 0, "free": 8192}]}')
    regions = firmware.parse_idf_size(out)
    assert [r["name"] for r in regions] == ["Flash Code", "DRAM"]      # unused left out
    assert regions[1] == {"name": "DRAM", "used": 11508, "size": 180736, "pct": 6.37}
    assert firmware._idf_size("idf.py -C esp32 -B $BUILD build") == \
        "idf.py -C esp32 -B $BUILD size --format json2 2>/dev/null"
    assert firmware._idf_size("cmake -S . && ninja") is None


def test_a_plain_page_is_traced_by_the_id_it_is_written_with(repo):
    (repo / "index.html").write_text('<main>\n  <b id="duty">0</b>\n</main>\n')
    run(repo, "add", ".")
    d = webshot.describe(repo, {"i": 0, "tag": "span", "sel": "#duty > span",
                                "text": "", "box": [0, 0, 10, 10], "own": None})
    assert (d["file"], d["line"]) == ("index.html", 2)
    # No id: found by its classes, all of them.
    (repo / "index.html").write_text('<main>\n <section class="card">\n'
                                     ' <section class="card speed">\n</main>\n')
    run(repo, "add", ".")
    d = webshot.describe(repo, {"i": 0, "tag": "section", "sel": "main > section.card.speed",
                                "text": "", "box": [0, 0, 10, 10], "own": None})
    assert (d["file"], d["line"]) == ("index.html", 3)
