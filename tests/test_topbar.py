"""The top bar's order (frontend/src/app/topbar-order.ts, run in node): the
notification bell and Settings are items like the tabs, after More by
default; orders kept before they were items get them at the far right; and
what stands after More is the last to go under it when the bar is short of
room."""
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

APP = Path("frontend/src/app")
ORDER = APP / "topbar-order.ts"
ROOMS = ["cad", "pcb", "firmware", "notes", "taste", "mfr", "commandcode", "files", "wiki", "tools", "tasks",
         "settings", "notifications"]


def _run(harness: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    work = Path(tempfile.mkdtemp(prefix="topbar-test-"))
    try:
        (work / "topbar-order.mts").write_text(ORDER.read_text())
        (work / "run.mjs").write_text(harness)
        done = subprocess.run([node, "--experimental-strip-types", "--no-warnings", str(work / "run.mjs"),
                               json.dumps(ROOMS)], capture_output=True, text=True, timeout=60)
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)
    finally:
        shutil.rmtree(work, ignore_errors=True)


HARNESS = """
import { defaultOrder, migrateOrder, migrateHidden, dropOrder } from './topbar-order.mts';
const def = defaultOrder(JSON.parse(process.argv[2]));
const shown = ids => ids.filter(x => x !== 'gap' && x !== 'more');
const out = {
  def,
  // Kept before More could move (no More, no bell, no Settings).
  oldest: migrateOrder(['pcb', 'cad', 'firmware', 'gap', 'notes', 'files'], def),
  // Kept before the bell and Settings were items, More moved to the front.
  moreFirst: migrateOrder(['more', 'cad', 'pcb', 'gap', 'notes'], def),
  // Kept now: the bell first, Settings before More.
  kept: migrateOrder(['notifications', 'cad', 'settings', 'more'], def),
  none: migrateOrder(null, def),
  // The wiki: off by default, and off for an order kept before it was a tab;
  // an order kept with it keeps the choice.
  hidNone: migrateHidden(null, null),
  hidOld: migrateHidden(['cad', 'pcb', 'more'], ['pcb']),
  hidOn: migrateHidden(['cad', 'wiki', 'more'], []),
  drop: dropOrder(def, shown(def)),
  dropMoved: dropOrder(['cad', 'notifications', 'more', 'pcb', 'settings'], ['cad', 'notifications', 'pcb', 'settings']),
};
console.log(JSON.stringify(out));
"""


def test_the_bell_and_settings_are_items_after_more():
    got = _run(HARNESS)
    d = got["def"]
    assert d[-3:] == ["more", "notifications", "settings"]
    assert d.index("gap") == d.index("notes") - 1
    assert got["none"] == d


def test_old_orders_put_them_at_the_far_right():
    got = _run(HARNESS)
    kept = [x for x in got["oldest"] if x in ("pcb", "cad", "firmware", "gap", "notes", "files")]
    assert kept == ["pcb", "cad", "firmware", "gap", "notes", "files"]
    assert got["oldest"][-3:] == ["more", "notifications", "settings"]
    # More kept at the front; the bell and Settings still at the far right.
    assert got["moreFirst"][0] == "more"
    assert got["moreFirst"][-2:] == ["notifications", "settings"]
    # A kept order of the new kind is kept as it is.
    assert [x for x in got["kept"] if x in ("notifications", "cad", "settings", "more")] == \
        ["notifications", "cad", "settings", "more"]
    assert got["kept"][0] == "notifications"
    for k in ("oldest", "moreFirst", "kept"):
        assert sorted(got[k]) == sorted(got["def"])


def test_the_wiki_is_a_tab_off_by_default():
    got = _run(HARNESS)
    assert "wiki" in got["def"]
    assert got["hidNone"] == ["wiki"]
    assert got["hidOld"] == ["pcb", "wiki"]
    assert got["hidOn"] == []


def test_what_stands_after_more_goes_under_it_last():
    got = _run(HARNESS)
    drop = got["drop"]
    assert drop[0] == "tasks"
    assert drop[-2:] == ["settings", "notifications"]
    assert got["dropMoved"] == ["notifications", "cad", "settings", "pcb"]


def test_the_shell_draws_them_from_the_order():
    bar = (APP / "topbar.ts").read_text()
    assert "const FIXED = new Set<string>(['analyze']);" in bar
    app = (APP / "app.ts").read_text()
    assert "@else if (b.id === 'notifications')" in app and "@else if (b.id === 'settings')" in app
    # Hidden, they are in the menu under your name.
    assert "[bellN]=\"bar.isHidden('notifications')" in app and "[settingsItem]=\"bar.isHidden('settings')\"" in app
    # The count is polled (and toasted) with the bell out of the bar too.
    assert re.search(r"notices = inject\(NotifyStore\)", app)
    rows = (APP / "topbar-settings.ts").read_text()
    assert "data-fixed" not in rows


def test_the_new_words_are_in_turkish():
    i18n = (APP / "i18n.ts").read_text()
    for k in ["the bell and its unread count", "hidden: still in the menu under your name, More and Ctrl+K",
              "Unread count beside the bell", "Theme, language, shortcuts, LLM keys, the top bar", "Nothing unread"]:
        assert f"'{k}':" in i18n, k
