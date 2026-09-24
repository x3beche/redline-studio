"""Every build container gets its share of the machine, not all of it."""
from backend import kicad, limits, sandbox


def test_defaults_are_a_share_of_the_machine(monkeypatch):
    for k in ("X3_BOX_CPUS", "X3_BOX_MEMORY", "X3_BOX_PIDS"):
        monkeypatch.delenv(k, raising=False)
    box = limits.box()
    assert box[0::2] == ["--cpus", "--memory", "--pids-limit"]
    assert float(box[1]) >= 1 and box[3].endswith("g") and int(box[5]) > 0


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("X3_BOX_CPUS", "1.5")
    monkeypatch.setenv("X3_BOX_MEMORY", "512m")
    monkeypatch.setenv("X3_BOX_PIDS", "64")
    assert limits.box() == ["--cpus", "1.5", "--memory", "512m", "--pids-limit", "64"]


def test_the_rooms_containers_are_limited():
    from pathlib import Path
    for argv in (sandbox.argv("web", ["true"]), kicad._docker(Path("/tmp"), "img")):
        assert "--cpus" in argv and "--memory" in argv and "--pids-limit" in argv, argv
