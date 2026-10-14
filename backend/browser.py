"""Which headless browser takes the pictures, and how it is started.

Used by tools/render.py (a model, from a revision's angle). Standard
library only.

Where a browser is looked for, in order. REDLINE_CHROME names one outright
(a path, a command on PATH, or "docker" / "docker:<image>" for the
container below); then whatever is installed; then a headless Chromium in a
container, which is what a machine with no browser of its own has. It used
to be "google-chrome" and nothing else, and a box with Chromium - or none -
failed with FileNotFoundError before it had looked anywhere.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess

NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
         "chrome")
PLACES = ("/opt/google/chrome/chrome", "/usr/bin/google-chrome",
          "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
IMAGE = os.environ.get("REDLINE_CHROME_IMAGE", "zenika/alpine-chrome:with-puppeteer")
# In the container there is no GPU: WebGL goes through SwiftShader, and
# there is no user namespace for Chrome's sandbox.
DOCKER_FLAGS = ["--headless=new", "--no-first-run", "--no-sandbox",
                "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                "--disable-dev-shm-usage"]


class NoBrowser(RuntimeError):
    pass


def own_container() -> str | None:
    """This process's container id, when it runs in one: Docker mounts the
    container's own hostname file from /var/lib/docker/containers/<id>/."""
    try:
        with open("/proc/self/mountinfo") as fh:
            for line in fh:
                m = re.search(r"/containers/([0-9a-f]{64})/(?:hostname|resolv\.conf|hosts)\s", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return None


def network(env: dict | None = None) -> str:
    """The container browser's network. REDLINE_CHROME_NETWORK: "host" (the
    default - the dev setup, where the page and the API are on the host's
    127.0.0.1), "self" (the network of the container this runs in: the
    deployed API, docker-compose.yml - its DevTools port is then on this
    container's 127.0.0.1, and the page is reached by its service name,
    REDLINE_WEB=http://web), or anything `docker run --network` takes."""
    env = os.environ if env is None else env
    want = (env.get("REDLINE_CHROME_NETWORK") or "").strip() or "host"
    if want == "self":
        me = own_container()
        if not me:
            raise NoBrowser("REDLINE_CHROME_NETWORK=self: this process is not in a container")
        return f"container:{me}"
    return want


def _image_there(image: str) -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", image],
                              capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def find_browser(env: dict | None = None, which=shutil.which,
                 exists=os.path.exists, image_there=_image_there) -> tuple[str, str]:
    """("local", path) for an installed browser, ("docker", image) for the
    container. Raises NoBrowser naming everything it tried."""
    env = os.environ if env is None else env
    want = (env.get("REDLINE_CHROME") or "").strip()
    if want:
        if want == "docker" or want.startswith("docker:"):
            image = want.partition(":")[2] or IMAGE
            if image_there(image):
                return "docker", image
            raise NoBrowser(f"REDLINE_CHROME={want}: no docker image {image}")
        got = which(want) or (want if exists(want) else None)
        if got:
            return "local", got
        raise NoBrowser(f"REDLINE_CHROME={want}: not found")
    for name in NAMES:
        got = which(name)
        if got:
            return "local", got
    for place in PLACES:
        if exists(place):
            return "local", place
    if image_there(IMAGE):
        return "docker", IMAGE
    raise NoBrowser("no browser: tried " + ", ".join(NAMES) + " on PATH, "
                    + ", ".join(PLACES) + f", and the docker image {IMAGE}. "
                    "Install Chrome/Chromium, or set REDLINE_CHROME to one.")


def argv(found: tuple[str, str], *, port: int, width: int, height: int,
         profile: str, url: str, name: str, flags: list[str]) -> list[str]:
    """The command line that starts the browser `found` with its DevTools on
    127.0.0.1:`port`. `flags` are for an installed browser; the container
    always gets DOCKER_FLAGS."""
    how, what = found
    tail = [f"--remote-debugging-port={port}", f"--window-size={width},{height}"]
    if how == "docker":
        # Host network (or the calling container's, network()): the page is
        # on 127.0.0.1 and the DevTools port has to be reachable on the
        # caller's 127.0.0.1 too. The profile lives and dies in the container.
        return ["docker", "run", "--rm", "--name", name, "--network", network(),
                "--shm-size", "1g", "--entrypoint", "chromium-browser", what,
                *DOCKER_FLAGS, *tail, "--remote-debugging-address=127.0.0.1",
                "--user-data-dir=/tmp/profile", url]
    return [what, *flags, *tail, f"--user-data-dir={profile}", url]


def free_port() -> int:
    """A port nobody is listening on, for a browser whose profile - and so
    its DevToolsActivePort file - is out of reach in a container."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def stop(found: tuple[str, str], proc: subprocess.Popen, name: str) -> None:
    """End the browser; a container too, which killing its client does not
    always do."""
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    if found[0] == "docker":
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
