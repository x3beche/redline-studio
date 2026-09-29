"""The code editor on a firmware: its files on disk, what git says of them,
and a save that neither leaves the project nor lays over someone's change.

Real git in a temporary directory, never a real project."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.embedded import files


def run(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "proj"
    fw = r / "firmware"
    (fw / "board" / "main").mkdir(parents=True)
    (fw / "common").mkdir()
    (fw / "other").mkdir()
    (fw / "board" / "CMakeLists.txt").write_text("project(x)\n")
    (fw / "board" / "main" / "CMakeLists.txt").write_text(
        'idf_component_register(SRCS "main.c" "../../common/fan.c"\n'
        '                       INCLUDE_DIRS "." "../../common")\n')
    (fw / "board" / "main" / "main.c").write_text('#include "fan.h"\nint main(void){return 0;}\n')
    (fw / "common" / "fan.c").write_text('#include "fan.h"\n')
    (fw / "common" / "fan.h").write_text("void fan(void);\n")
    (fw / "other" / "secret.c").write_text("not this project\n")
    (fw / "board" / ".gitignore").write_text("sdkconfig\n")
    run(r, "init", "-q", "-b", "main")
    run(r, "config", "user.email", "t@example.com")
    run(r, "config", "user.name", "t")
    run(r, "add", ".")
    run(r, "commit", "-q", "-m", "first")
    # What a build and the tools leave behind.
    (fw / "board" / "build").mkdir()
    (fw / "board" / "build" / "gen.c").write_text("made\n")
    (fw / "board" / "sdkconfig").write_text("CONFIG=1\n")
    (fw / "board" / "main" / "logo.bin").write_bytes(b"\x00\x01\x02" * 10)
    (fw / "board" / "main" / "huge.h").write_text("x" * (files.MAX_BYTES + 1))
    return r


@pytest.fixture
def app(repo):
    return {"_id": "fw", "platform": "embedded", "repo": str(repo), "cwd": "firmware",
            "build": "idf.py -C board -B $BUILD build"}


def paths(app):
    return {f["path"]: f for f in files.listing(app)["files"]}


def test_the_project_is_the_build_dir_and_what_its_build_reaches(app):
    got = files.listing(app)
    assert got["root"] == "firmware" and got["project"] == "board"
    assert got["open"] == "board/main/main.c"
    assert set(got["includes"]) == {"board/main", "common"}
    p = paths(app)
    assert {"board/main/main.c", "common/fan.h", "common/fan.c"} <= set(p)
    assert "other/secret.c" not in p                     # a sibling nobody includes


def test_the_tree_skips_build_dirs_ignored_binary_and_large_files(app):
    p = paths(app)
    assert not any(k.startswith("board/build/") for k in p)
    assert "board/sdkconfig" not in p                    # .gitignore
    assert "board/main/logo.bin" not in p
    assert "board/main/huge.h" not in p
    assert p["board/main/main.c"]["language"] == "cpp"
    assert p["board/CMakeLists.txt"]["language"] == "plaintext"


def test_git_status_marks(app, repo):
    fw = repo / "firmware"
    (fw / "common" / "fan.h").write_text("void fan(int);\n")               # modified
    (fw / "board" / "main" / "new.c").write_text("int n;\n")                # untracked
    (fw / "common" / "fan.c").write_text("// staged\n")
    run(repo, "add", "firmware/common/fan.c")                                # staged only
    p = paths(app)
    assert p["common/fan.h"]["git"] == "modified"
    assert p["board/main/new.c"]["git"] == "untracked"
    assert p["common/fan.c"]["git"] == "staged"
    assert p["board/main/main.c"]["git"] is None


def test_status_codes():
    assert files.status_of("??") == "untracked"
    assert files.status_of(" M") == "modified"
    assert files.status_of("MM") == "modified"
    assert files.status_of("M ") == "staged"
    assert files.status_of("A ") == "staged"
    assert files.status_of("R ") == "staged"
    assert files.status_of("UU") == "modified"


@pytest.mark.parametrize("bad", ["../../etc/passwd", "/etc/passwd", "board/../../x.c",
                                 "board/main/../../../proj/x", "other/secret.c",
                                 "board/build/gen.c", "C:/x.c"])
def test_paths_out_of_the_project_are_refused(app, bad):
    with pytest.raises(files.HTTPException) as e:
        files.write_file(app, bad, "x", None)
    assert e.value.status_code in (400, 403)


def test_a_link_out_is_refused(app, repo, tmp_path):
    outside = tmp_path / "outside.c"
    outside.write_text("mine\n")
    os.symlink(outside, repo / "firmware" / "common" / "link.c")
    os.symlink(tmp_path, repo / "firmware" / "common" / "dirlink")
    for rel in ("common/link.c", "common/dirlink/outside.c"):
        with pytest.raises(files.HTTPException) as e:
            files.write_file(app, rel, "x", None)
        assert e.value.status_code == 403
    assert outside.read_text() == "mine\n"
    assert "common/link.c" not in paths(app)


def test_read_then_write_then_a_stale_write_is_a_conflict(app, repo):
    got = files.read_file(app, "common/fan.h")
    assert got["text"] == "void fan(void);\n" and got["language"] == "cpp"
    out = files.write_file(app, "common/fan.h", "void fan(int);\n", got["hash"])
    assert out["hash"] != got["hash"]
    assert (repo / "firmware" / "common" / "fan.h").read_text() == "void fan(int);\n"
    with pytest.raises(files.HTTPException) as e:        # still holding the old hash
        files.write_file(app, "common/fan.h", "mine\n", got["hash"])
    assert e.value.status_code == 409
    assert e.value.detail["text"] == "void fan(int);\n" and e.value.detail["hash"] == out["hash"]
    assert (repo / "firmware" / "common" / "fan.h").read_text() == "void fan(int);\n"


def test_binary_files_are_not_written(app):
    with pytest.raises(files.HTTPException) as e:
        files.write_file(app, "board/main/logo.bin", "text", None)
    assert e.value.status_code == 415


def test_the_routes(app, repo, monkeypatch):
    recorded = []

    async def load(aid):
        return app

    async def record(a, rel):
        recorded.append(rel)

    monkeypatch.setattr(files, "_load_app", load)
    monkeypatch.setattr(files, "_record", record)
    web = FastAPI()
    web.include_router(files.router)
    c = TestClient(web)
    tree = c.get("/api/embedded/fw/files").json()
    assert "board/main/main.c" in {f["path"] for f in tree["files"]}
    one = c.get("/api/embedded/fw/files/board/main/main.c").json()
    ok = c.put("/api/embedded/fw/files/board/main/main.c",
               json={"text": one["text"] + "// more\n", "base_hash": one["hash"]})
    assert ok.status_code == 200 and recorded == ["board/main/main.c"]
    clash = c.put("/api/embedded/fw/files/board/main/main.c",
                  json={"text": "x", "base_hash": one["hash"]})
    assert clash.status_code == 409 and clash.json()["detail"]["text"].endswith("// more\n")
    assert c.put("/api/embedded/fw/files/..%2F..%2Fx", json={"text": "x"}).status_code in (400, 403, 404)
    assert recorded == ["board/main/main.c"]
