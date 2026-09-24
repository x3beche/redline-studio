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
