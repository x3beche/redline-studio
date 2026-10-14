"""Links into the app (backend/app_links.py) in the page's own address form
(frontend/src/app/nav-url.ts, whose spec checks the page's side): a path per
room and what is open in it. The old ?ws= form still opens the same place;
these are what the server writes now."""
from backend import app_links as L


def test_rooms_by_id_and_old_name():
    assert L.room("pcb") == "/pcb"
    assert L.room("commandcode") == "/chat" and L.room("chat") == "/chat"
    assert L.room("mfr") == "/parts" and L.room("catalog") == "/parts" and L.room("inventory") == "/parts"
    assert L.room("tools") == "/basic-tools"         # /tools/<name> is the tools' static pages
    assert L.room("analyze") == "/analytics"
    assert L.room(None) == "/" and L.room("nowhere") == "/"


def test_places():
    assert L.model("iot/box") == "/3d/iot/box"
    assert L.model("iot/box", "r1") == "/3d/iot/box?rev=r1"
    assert L.revision("r1") == "/3d?rev=r1" and L.revision("r1", "notes") == "/notes?rev=r1"
    assert L.board("ctl") == "/pcb/ctl"
    assert L.firmware("fan") == "/firmware/fan"
    assert L.chat("k1") == "/chat/k1"
    assert L.thread("cad") == "/chat/thread/cad"
    assert L.parts() == "/parts" and L.parts("lcsc") == "/parts/lcsc" and L.parts("m1", "j1") == "/parts/run/j1"
    assert L.analytics("7d") == "/analytics?range=7d"
    assert L.analytics("30d", "iot-fan") == "/analytics?range=30d&project=iot-fan"


def test_segments_are_escaped_like_the_page():
    # encodeURIComponent, with : @ , left readable (nav-url.ts seg)
    assert L.chat("a b/c?d") == "/chat/a%20b%2Fc%3Fd"
    assert L.board("v:x@y,z") == "/pcb/v:x@y,z"
    assert L.model("dir/a b") == "/3d/dir/a%20b"


def test_app_url():
    assert L.app_url("https://x.y/", "/pcb/ctl") == "https://x.y/pcb/ctl"
    assert L.app_url(None, "/pcb") is None
