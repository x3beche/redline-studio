"""The build view: what fills flash, read from a real build, and the
firmware's commits read from a git repository.

The fixtures in tests/fixtures/fw_build/ come from real builds of
iot-fan: esp32_raw.json is esp-idf-size 1.5 (`--ng --format raw`) on the
DemoBoard ESP32 link map, cut down to four archives; stm32_nm.txt is
`arm-none-eabi-nm -S --size-sort -l` of the STM32F042 image.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from fastapi import HTTPException

from backend import firmware
from backend.embedded import build as view

FX = Path(__file__).parent / "fixtures" / "fw_build"
REPO = "/mnt/ssd/3d-arena/projects/iot-fan"      # where the fixtures were built


def esp_raw() -> str:
    return (FX / "esp32_raw.json").read_text()


# ---------------- ESP32: esp-idf-size ----------------
def test_raw_report_rows_are_what_goes_into_the_image():
    rows = firmware.parse_idf_raw(esp_raw())
    names = {(r["archive"].split("/")[-1], r["symbol"]) for r in rows}
    assert ("libmain.a", "app_main()") in names
    # bss takes RAM, not flash: main.c's OLED frame buffer is not here
    assert not any(r["symbol"].startswith("oled$") for r in rows)
    # a function's literal pool joins the function
    assert not any(r["symbol"].startswith(".literal.") for r in rows)
    app_main = sum(r["size"] for r in rows if r["symbol"] == "app_main()")
    assert app_main == 549 + 28


def test_raw_rows_add_up_to_each_object_file():
    data = json.loads(esp_raw())
    want = 0
    for mem in data["memory_types"].values():
        for name, sec in mem["sections"].items():
            if firmware.NOLOAD.search(name):
                continue
            for a in sec["archives"].values():
                want += sum(o["size"] for o in a["object_files"].values())
    assert sum(r["size"] for r in firmware.parse_idf_raw(esp_raw())) == want


def test_junk_is_no_rows():
    assert firmware.parse_idf_raw("esp_idf_size: error") == []
    assert firmware.parse_idf_raw("") == []


def components(tmp_path: Path) -> tuple[Path, dict]:
    build = tmp_path / "build"
    build.mkdir()
    text = (FX / "project_description.json").read_text() \
        .replace("@REPO@", REPO).replace("@BUILD@", str(build))
    (build / "project_description.json").write_text(text)
    return build, firmware.idf_components(build, REPO)


def test_the_projects_own_components_are_yours(tmp_path):
    _, mine = components(tmp_path)
    assert mine == {"esp-idf/main/libmain.a": f"{REPO}/firmware/demoboard/main"}
    assert firmware.idf_group("esp-idf/main/libmain.a", mine) == "yours"
    assert firmware.idf_group("esp-idf/freertos/libfreertos.a", mine) == "framework"
    # ESP-IDF's newlib glue is the framework; the C library itself is runtime
    assert firmware.idf_group("esp-idf/newlib/libnewlib.a", mine) == "framework"
    assert firmware.idf_group(
        "/opt/esp/tools/xtensa-esp-elf/lib/esp32/no-rtti/libc.a", mine) == "runtime"
    assert firmware.idf_group("/x/libstdc++.a", mine) == "runtime"
    assert firmware.idf_group("/x/libgcc.a", mine) == "runtime"


def test_esp32_grouped_with_sources_from_nm(tmp_path):
    _, mine = components(tmp_path)
    nm = [{"name": "app_main", "file": "firmware/demoboard/main/main.c", "line": 120},
          {"name": "fan_curve", "file": "firmware/common/fan.c", "line": 9}]
    s = firmware.sizes_from(firmware.idf_rows(firmware.parse_idf_raw(esp_raw()), mine, nm, REPO),
                            "esp-idf-size")
    g = s["groups"]
    assert set(g) == {"yours", "framework", "runtime"}
    assert s["total"] == sum(g.values())
    assert g["yours"] == 3863                  # libmain.a's flash bytes, as built
    assert 0 < g["yours"] < g["runtime"] < g["framework"]
    files = {f["path"]: f["size"] for f in s["files"]}
    # fan.c is compiled into main from firmware/common: nm says where
    assert "firmware/common/fan.c" in files and "firmware/demoboard/main/main.c" in files
    top = s["top"][0]
    assert top["name"] == "app_main()" and top["file"] == "firmware/demoboard/main/main.c" \
        and top["line"] == 120
    # the linker's merged string pool is nobody's own
    strings = [a for a in s["archives"] if a["path"] == firmware.STRINGS]
    assert strings and strings[0]["group"] == "framework"


def test_tree_is_sorted_and_sums():
    s = firmware.sizes_from(firmware.idf_rows(firmware.parse_idf_raw(esp_raw()), {}, [], REPO),
                            "esp-idf-size")

    def walk(n):
        kids = n.get("children") or []
        if kids:
            assert sum(k["size"] for k in kids) == n["size"], n["name"]
            if n["kind"] != "root":
                sizes = [k["size"] for k in kids if k["kind"] != "rest"]
                assert sizes == sorted(sizes, reverse=True)
        for k in kids:
            walk(k)
    walk(s["tree"])
    assert [n["name"] for n in s["tree"]["children"]] == ["framework", "runtime"]


def test_a_files_small_symbols_are_folded():
    rows = [{"group": "runtime", "archive": "libc", "archive_label": "libc", "file": "f.c",
             "file_label": "f.c", "symbol": f"s{i}", "size": 100 - i} for i in range(60)]
    f = firmware.size_tree(rows)["children"][0]["children"][0]["children"][0]
    assert len(f["children"]) == firmware.KEEP_SYMBOLS + 1
    assert f["children"][-1]["kind"] == "rest"
    assert sum(c["size"] for c in f["children"]) == f["size"]


# ---------------- STM32: nm -l ----------------
def test_stm32_grouped_by_source_path():
    nm = firmware.parse_nm_paths((FX / "stm32_nm.txt").read_text())
    rows = firmware.nm_rows(nm, REPO)
    s = firmware.sizes_from(rows, "nm")
    assert s["groups"]["yours"] == 1240
    assert s["groups"]["framework"] == 0       # no HAL: the startup is the project's own
    files = [f["path"] for f in s["files"]]
    assert files == ["firmware/stm32/src/main.c", "firmware/common/fan.c",
                     "firmware/stm32/src/startup.c"]
    libs = {a["name"] for a in s["archives"] if a["group"] == "runtime"}
    assert {"libc", "libgcc", "libnosys"} <= libs


def test_stm32_aliases_count_once_and_ram_is_not_flash():
    text = ("08000100 00000010 T Reset_Handler\t/p/startup.c:5\n"
            "08000110 00000002 W USART1_IRQHandler\n"
            "08000110 00000002 W TIM2_IRQHandler\n"
            "20000000 00000400 B buffer\t/p/main.c:3\n")
    nm = firmware.parse_nm_paths(text)
    assert [s["name"] for s in nm] == ["Reset_Handler", "USART1_IRQHandler"]


def test_stm32_vendor_code_is_framework():
    nm = [{"name": "HAL_Init", "size": 40, "type": "T", "line": 1,
           "path": "/r/Drivers/STM32F0xx_HAL_Driver/Src/stm32f0xx_hal.c"},
          {"name": "Reset_Handler", "size": 8, "type": "T", "line": 1,
           "path": "/r/Core/Startup/startup_stm32f042f6px.s"},
          {"name": "main", "size": 30, "type": "T", "line": 1, "path": "/r/Core/Src/main.c"},
          {"name": "memcpy", "size": 20, "type": "T", "line": None, "path": None}]
    g = {r["symbol"]: r["group"] for r in firmware.nm_rows(nm, "/r")}
    assert g == {"HAL_Init": "framework", "Reset_Handler": "framework", "main": "yours",
                 "memcpy": "runtime"}


def test_what_the_linker_adds_is_counted_against_the_region():
    rows = [{"group": "yours", "archive": "a", "archive_label": "a", "file": "f", "file_label": "f",
             "symbol": "x", "size": 100}]
    out = firmware.linker_rest(rows, [{"name": "FLASH", "used": 130, "size": 1000}])
    assert out[-1]["size"] == 30 and out[-1]["group"] == "runtime"
    assert firmware.linker_rest(rows, [{"name": "FLASH", "used": 90, "size": 1000}]) == rows


# ---------------- history ----------------
def test_history_keeps_the_last_ten():
    h: list[dict] = []
    for i in range(14):
        h = firmware.push_history(h, {"at": str(i)})
    assert len(h) == firmware.HISTORY == 10
    assert [e["at"] for e in h] == [str(i) for i in range(4, 14)]


def entry(at, yours, flash):
    return firmware.history_entry(at, {"total": yours + 1000, "groups": {
        "yours": yours, "framework": 1000, "runtime": 0}},
        [{"name": "FLASH", "used": flash, "size": 32768}], "abc1234")


def test_change_states():
    assert view.change([])["state"] == "none"
    assert view.change([entry("1", 10, 100)])["state"] == "first"
    same = view.change([entry("1", 10, 100), entry("2", 10, 100)])
    assert same["state"] == "same" and same["total"] == 0
    c = view.change([entry("0", 1, 1), entry("1", 10, 100), entry("2", 42, 164)])
    assert c["state"] == "changed"
    assert c["groups"] == {"yours": 32, "framework": 0, "runtime": 0}
    assert c["regions"] == [{"name": "FLASH", "used": 164, "size": 32768, "delta": 64}]
    assert c["total"] == 32 and c["was_at"] == "1" and c["at"] == "2"


# ---------------- commits ----------------
def sh(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          text=True).stdout


@pytest.fixture
def repo(tmp_path, monkeypatch):
    r = tmp_path / "proj"
    (r / "firmware" / "main").mkdir(parents=True)
    (r / "web").mkdir()
    sh(r, "init", "-q", "-b", "main")
    sh(r, "config", "user.email", "t@example.com")
    sh(r, "config", "user.name", "Tester")
    (r / "firmware" / "main" / "main.c").write_text("int main(void) {\n  return 0;\n}\n")
    (r / "web" / "index.html").write_text("<p>hi</p>\n")
    sh(r, "add", ".")
    sh(r, "commit", "-q", "-m", "first")
    (r / "firmware" / "main" / "main.c").write_text("int main(void) {\n  for (;;) {}\n}\n")
    (r / "web" / "index.html").write_text("<p>hello</p>\n")
    sh(r, "commit", "-q", "-am", "loop forever")
    (r / "web" / "app.js").write_text("x\n")
    sh(r, "add", ".")
    sh(r, "commit", "-q", "-m", "web only")
    app = {"_id": "fw", "platform": "embedded", "repo": str(r), "cwd": "firmware"}

    async def fake(aid):
        if aid != "fw":
            raise HTTPException(404, aid)
        return app
    monkeypatch.setattr(view, "_app", fake)
    return r


def run(coro):
    return asyncio.run(coro)


def test_commits_are_the_firmware_dirs_own(repo):
    out = run(view.commits("fw"))
    assert out["git"] and out["dir"] == "firmware"
    subjects = [c["subject"] for c in out["commits"]]
    assert subjects == ["loop forever", "first"]         # not "web only"
    top = out["commits"][0]
    assert (top["added"], top["removed"], top["files"]) == (1, 1, 1)
    assert top["author"] == "Tester" and len(top["short"]) >= 7
    assert out["worktree"] == []


def test_working_tree_changes(repo):
    (repo / "firmware" / "main" / "main.c").write_text("int main(void) {\n  return 1;\n}\n")
    (repo / "firmware" / "main" / "new.c").write_text("a\nb\n")
    (repo / "web" / "index.html").write_text("changed\n")
    wt = {f["path"]: f for f in run(view.commits("fw"))["worktree"]}
    assert set(wt) == {"firmware/main/main.c", "firmware/main/new.c"}
    assert wt["firmware/main/main.c"]["state"] == "modified"
    assert (wt["firmware/main/main.c"]["added"], wt["firmware/main/main.c"]["removed"]) == (1, 1)
    assert wt["firmware/main/new.c"]["state"] == "untracked" and wt["firmware/main/new.c"]["added"] == 2
    d = {f["path"]: f for f in run(view.worktree_diff("fw"))["files"]}
    assert d["firmware/main/main.c"]["before"].count("for (;;)") == 1
    assert "return 1" in d["firmware/main/main.c"]["after"]
    assert d["firmware/main/new.c"]["before"] == "" and d["firmware/main/new.c"]["after"] == "a\nb\n"


def test_a_commits_diff(repo):
    h = sh(repo, "log", "-1", "--format=%h", "HEAD~1").strip()
    d = run(view.commit_diff("fw", h))
    assert d["subject"] == "loop forever"
    assert [f["path"] for f in d["files"]] == ["firmware/main/main.c"]   # web/ left out
    f = d["files"][0]
    assert "return 0" in f["before"] and "for (;;)" in f["after"]
    first = sh(repo, "rev-list", "--max-parents=0", "HEAD").strip()
    root = run(view.commit_diff("fw", first))
    assert root["parent"] is None and root["files"][0]["before"] == ""


def test_a_commit_is_hex_and_must_exist(repo):
    for bad in ("HEAD", "abc", "../../etc", "zzzzzzz", "a" * 41):
        with pytest.raises(HTTPException) as e:
            run(view.commit_diff("fw", bad))
        assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        run(view.commit_diff("fw", "deadbeef"))
    assert e.value.status_code == 404


def test_paths_outside_the_repository_are_refused(tmp_path):
    assert view.inside(str(tmp_path), "../x") is None
    assert view.inside(str(tmp_path), "/etc/passwd") is None
    assert view.inside(str(tmp_path), "a/b.c") == (tmp_path / "a" / "b.c").resolve()


def test_not_a_repository(tmp_path, monkeypatch):
    app = {"_id": "fw", "platform": "embedded", "repo": str(tmp_path), "cwd": ""}

    async def fake(aid):
        return app
    monkeypatch.setattr(view, "_app", fake)
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))
    assert run(view.commits("fw"))["git"] is False
