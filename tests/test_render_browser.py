"""render.py finds a browser wherever there is one.

It used to run "google-chrome" and nothing else; on a machine with
Chromium, or with no browser but the container, the after shot died with
FileNotFoundError before looking anywhere.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import render  # noqa: E402


def finder(on_path=(), files=(), image=False):
    return dict(which=lambda n: f"/usr/bin/{n}" if n in on_path else None,
                exists=lambda p: p in files,
                image_there=lambda i: image)


def test_google_chrome_first():
    got = render.find_browser({}, **finder(on_path=("chromium", "google-chrome")))
    assert got == ("local", "/usr/bin/google-chrome")


@pytest.mark.parametrize("name", ["chromium", "chromium-browser", "google-chrome-stable"])
def test_chromium_when_there_is_no_chrome(name):
    assert render.find_browser({}, **finder(on_path=(name,))) == ("local", f"/usr/bin/{name}")


def test_a_known_place_off_path():
    got = render.find_browser({}, **finder(files=("/snap/bin/chromium",)))
    assert got == ("local", "/snap/bin/chromium")


def test_the_container_when_nothing_is_installed():
    assert render.find_browser({}, **finder(image=True)) == ("docker", render.IMAGE)


def test_nothing_anywhere_says_what_it_tried():
    with pytest.raises(render.NoBrowser) as exc:
        render.find_browser({}, **finder())
    assert "chromium-browser" in str(exc.value) and render.IMAGE in str(exc.value)


def test_the_env_names_one_outright():
    env = {"REDLINE_CHROME": "/opt/my/chrome"}
    got = render.find_browser(env, **finder(on_path=("google-chrome",),
                                            files=("/opt/my/chrome",)))
    assert got == ("local", "/opt/my/chrome")


def test_the_env_can_ask_for_the_container():
    env = {"REDLINE_CHROME": "docker:my/chrome:1"}
    got = render.find_browser(env, **finder(on_path=("google-chrome",), image=True))
    assert got == ("docker", "my/chrome:1")


def test_an_env_that_points_nowhere_is_an_error_not_a_fallback():
    with pytest.raises(render.NoBrowser):
        render.find_browser({"REDLINE_CHROME": "nope"}, **finder(on_path=("chromium",)))


def test_local_argv():
    argv = render.browser_argv(("local", "/usr/bin/chromium"), 9411, 800, 600,
                               "/tmp/p", "http://x/", "n")
    assert argv[0] == "/usr/bin/chromium"
    assert "--remote-debugging-port=9411" in argv and "--user-data-dir=/tmp/p" in argv
    assert argv[-1] == "http://x/"


def test_docker_argv_shares_the_host_network_and_renders_in_software(monkeypatch):
    monkeypatch.delenv("REDLINE_CHROME_NETWORK", raising=False)
    argv = render.browser_argv(("docker", "img"), 9411, 800, 600, "/tmp/p",
                               "http://127.0.0.1:4200/?rev=r", "redline-render-1")
    assert argv[:2] == ["docker", "run"]
    assert "--network" in argv and argv[argv.index("--network") + 1] == "host"
    assert argv[argv.index("--name") + 1] == "redline-render-1"
    assert "--no-sandbox" in argv and "--use-angle=swiftshader" in argv
    assert "--user-data-dir=/tmp/p" not in argv        # the host path means nothing there
    assert argv[-1] == "http://127.0.0.1:4200/?rev=r"


def test_deployed_the_browser_joins_the_api_containers_network(monkeypatch):
    # docker-compose.yml: REDLINE_CHROME_NETWORK=self - the DevTools port on
    # the API container's 127.0.0.1, the page reached as http://web.
    from backend import browser
    monkeypatch.setenv("REDLINE_CHROME_NETWORK", "self")
    monkeypatch.setattr(browser, "own_container", lambda: "c" * 64)
    argv = render.browser_argv(("docker", "img"), 9411, 800, 600, "/tmp/p", "http://web/", "n")
    assert argv[argv.index("--network") + 1] == "container:" + "c" * 64
    assert "--remote-debugging-address=127.0.0.1" in argv
    monkeypatch.setattr(browser, "own_container", lambda: None)
    with pytest.raises(browser.NoBrowser, match="not in a container"):
        browser.network()
    assert browser.network({"REDLINE_CHROME_NETWORK": "wb_default"}) == "wb_default"


def test_own_container_reads_the_mounted_hostname(monkeypatch, tmp_path):
    from backend import browser
    cid = "ab12" * 16
    info = tmp_path / "mountinfo"
    info.write_text("1 2 0:1 / / rw - overlay overlay rw\n"
                    f"3 1 8:1 /var/lib/docker/containers/{cid}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n")
    real = open
    monkeypatch.setattr("builtins.open", lambda p, *a, **k: real(info if p == "/proc/self/mountinfo" else p, *a, **k))
    assert browser.own_container() == cid


def test_a_missing_work_image_names_its_compose_profile_when_deployed(monkeypatch):
    from backend import workimages
    monkeypatch.delenv("REDLINE_DEPLOY", raising=False)
    assert workimages.build_hint("img", "docker build -t img .", "kicad") == "docker build -t img ."
    monkeypatch.setenv("REDLINE_DEPLOY", "compose")
    said = workimages.build_hint("ghcr.io/x/workbench-kicad:1", "docker build -t img .", "kicad")
    assert "COMPOSE_PROFILES" in said and "kicad" in said and "ghcr.io/x/workbench-kicad:1" in said
    assert "docker build" not in said
