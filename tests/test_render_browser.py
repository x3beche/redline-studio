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


def test_docker_argv_shares_the_host_network_and_renders_in_software():
    argv = render.browser_argv(("docker", "img"), 9411, 800, 600, "/tmp/p",
                               "http://127.0.0.1:4200/?rev=r", "redline-render-1")
    assert argv[:2] == ["docker", "run"]
    assert "--network" in argv and argv[argv.index("--network") + 1] == "host"
    assert argv[argv.index("--name") + 1] == "redline-render-1"
    assert "--no-sandbox" in argv and "--use-angle=swiftshader" in argv
    assert "--user-data-dir=/tmp/p" not in argv        # the host path means nothing there
    assert argv[-1] == "http://127.0.0.1:4200/?rev=r"
