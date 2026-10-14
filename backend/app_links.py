"""Links into the app, written the way the page writes its own address
(frontend/src/app/nav-url.ts): a path per room and what is open in it,
/3d/<model>, /pcb/<board>, /chat/<conversation>, /parts/<maker> - so a link
in a Telegram message, a chat tool's answer or a printout reads like where
it goes, and the browser's Back works from it.

The old form (/?ws=pcb&board=ctl, /?model=..&rev=..) still opens the same
place; the page rewrites it. These return a path (and query) on the app's
own origin; app_url() puts a base in front.
"""
from __future__ import annotations

from urllib.parse import quote, urlencode

#: Each room's first path segment (nav-url.ts ROOM_PATH). The ids are the
#: page's own: commandcode is the Chat, mfr is Parts, tools is Basic Tools
#: (/basic-tools: /tools/<name> serves the tools' static pages).
ROOM_PATH = {
    "cad": "3d", "pcb": "pcb", "firmware": "firmware", "notes": "notes", "taste": "taste",
    "mfr": "parts", "commandcode": "chat", "files": "files", "tools": "basic-tools",
    "settings": "settings", "analyze": "analytics",
}
#: The names rooms had in old links (?ws=chat, ?ws=catalog).
OLD_NAMES = {"chat": "commandcode", "catalog": "mfr", "supply": "mfr", "inventory": "mfr", "parts": "mfr",
             "3d": "cad", "analytics": "analyze", "basic-tools": "tools"}


def seg(s: str) -> str:
    """One path segment, as encodeURIComponent with `:` `@` `,` left readable."""
    return quote(str(s), safe=":@,!*'()")


def segs(id_: str) -> str:
    """An id that may hold slashes itself (a model in a folder): one segment per part."""
    return "/".join(seg(p) for p in str(id_).split("/"))


def _q(**kw) -> str:
    kw = {k: v for k, v in kw.items() if v}
    return ("?" + urlencode(kw)) if kw else ""


def room(ws: str | None) -> str:
    """A room by its id or old name; the app's start for none."""
    if not ws:
        return "/"
    ws = OLD_NAMES.get(ws, ws)
    return "/" + ROOM_PATH[ws] if ws in ROOM_PATH else "/"


def model(mid: str, rev: str | None = None) -> str:
    """A model in the 3D room, at a revision's view when one is given."""
    return f"/3d/{segs(mid)}" + _q(rev=rev)


def revision(rev: str, ws: str = "cad") -> str:
    """A revision on its own: the page looks up what it is about and goes there."""
    return room(ws) + _q(rev=rev)


def board(bid: str) -> str:
    return f"/pcb/{segs(bid)}"


def firmware(fw: str) -> str:
    return f"/firmware/{segs(fw)}"


def chat(cid: str) -> str:
    """A conversation in the Chat tab."""
    return f"/chat/{seg(cid)}"


def thread(room_id: str) -> str:
    """A room's agent thread in the Chat tab."""
    return f"/chat/thread/{seg(room_id)}"


def parts(maker: str | None = None, run: str | None = None) -> str:
    """Parts: a manufacturer's catalog, or one of its reading runs."""
    if run:
        return f"/parts/run/{seg(run)}"
    return "/parts" + (f"/{seg(maker)}" if maker else "")


def share(token: str) -> str:
    """A shared link's own page (backend/shares.py): no room, no sign-in."""
    return f"/s/{seg(token)}"


def analytics(range_: str | None = None, project: str | None = None) -> str:
    return "/analytics" + _q(range=range_, project=project)


def app_url(base: str | None, path: str) -> str | None:
    """`path` on the app at `base` (https://redline.example.com); None without a base."""
    if not base:
        return None
    return base.rstrip("/") + path
