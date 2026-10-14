"""Who may do what: the roles, in one table.

Every API request is sorted into one action - looking, drawing a note,
running something, changing the design, deleting, one's own settings, the
server's settings, the accounts, agent tokens - by its method and path, in
`action()` below. The middleware in main.py asks `allowed(role, action)`
once per request, so no route has to remember to check, and a route added
later falls under the rule for its method (GET looks, DELETE deletes,
anything else changes the design) until it is listed here.

A person's role is their system role (backend/auth.py): owner, admin or
user. Each of them works in a private space of their own, so in it they may
do all the work; what sets them apart is the server - its settings and its
accounts are the owner's and the admins'. An agent's token carries a role
of its own, editor at most, in the space of the account that made it.

In local mode (sign-in off) the person at the machine is the owner and
everything is allowed, as it always was.
"""

from __future__ import annotations

import contextvars
import re

# The people's roles first (backend/auth.py SYSTEM_ROLES), then the
# agents' (TOKEN_ROLES): lower in the list is less.
ROLES = ("owner", "admin", "user", "editor", "reviewer", "viewer")
PEOPLE = ("owner", "admin", "user")

# The role of the request being served; the middleware sets it. Local mode:
# the owner.
ROLE: contextvars.ContextVar[str | None] = contextvars.ContextVar("role", default="owner")


def current() -> str | None:
    return ROLE.get()


# What each action is, in the words the page shows when one is refused.
ACTIONS = {
    "view": "look at it",
    "draw": "draw notes, save drafts, chat and answer questions",
    "run": "queue notes and run builds",
    "edit": "change models and boards",
    "delete": "delete",
    "tokens": "hand out agent tokens",
    "space": "change your own settings",
    "settings": "change the server's settings",
    "users": "manage the accounts",
}

_WORK = frozenset({"view", "draw", "run", "edit", "delete", "tokens"})
CAN: dict[str, frozenset[str]] = {
    "viewer": frozenset({"view"}),
    "reviewer": frozenset({"view", "draw"}),
    "editor": _WORK,
    "user": _WORK | {"space"},
    "admin": _WORK | {"space", "settings", "users"},
    "owner": frozenset(ACTIONS),
}

# What a role is for, in a line - the admin panel and the token page show it.
ABOUT = {
    "owner": "everything; the only one who changes roles and deletes accounts",
    "admin": "the server's settings and the users' accounts",
    "user": "their own private space: projects, notes, agents",
    "editor": "designs, queues, builds and deletes; hands out agent tokens",
    "reviewer": "draws notes and drafts, chats, answers - does not queue, build or delete",
    "viewer": "looks and downloads",
}

# The roles an agent's token may carry: it works, it does not manage.
TOKEN_ROLES = ("editor", "reviewer", "viewer")

# Routes that answer without anyone signed in.
NONE = "none"

# (method, path pattern, action), first match wins. Patterns are matched
# against the whole path; {x} is one path segment.
_RULES: list[tuple[str, str, str]] = [
    # a headless browser's page session, traded for an agent's token: the
    # token has to be good (any token role may look); the route itself
    # takes nothing but a bearer token (backend/auth.py, page sessions)
    ("POST", "/api/auth/page-session", "view"),
    # remembering the signed-in account on this browser: a person, signed in
    # (backend/accounts.py); a page session may not, as it may not write
    ("POST", "/api/auth/remember", "view"),
    # signing in, and a password-reset link's own page; the remembered
    # accounts - listing them, a picture, switching, removing - which a
    # signed-out browser's chooser needs (each holds its own token)
    ("*", "/api/auth/.*", NONE),
    ("*", "/api/reset/.*", NONE),
    ("GET", "/api/health", NONE),
    # a shared link, opened by whoever holds it (backend/shares.py checks
    # the link, its password and its end itself)
    ("*", "/api/public/.*", NONE),
    # making a shared link of something, and turning one off: whoever may
    # look at it; the routes keep it to people, and turning off to the
    # link's maker and the admins (backend/shares.py)
    ("POST", "/api/shares", "view"),
    ("POST", "/api/shares/{}/revoke", "view"),
    # a page telling the server what broke in it (backend/client_errors.py)
    ("POST", "/api/client-errors", "view"),
    # one's own profile (backend/profile.py): anyone signed in, and only
    # themselves - the routes take no one else's id but a picture's
    ("*", "/api/me(/.*)?", "view"),
    # one's own notifications and what comes in them (backend/notifications.py):
    # anyone signed in, about themselves only; a page session only reads them
    ("*", "/api/notifications(/.*)?", "view"),
    # the accounts (backend/admin.py): the owner and the admins; the routes
    # keep what only the owner may do (roles, deleting) to the owner
    ("*", "/api/admin(/.*)?", "users"),
    # the agents
    ("*", "/api/agent-tokens(/.*)?", "tokens"),
    # the agents' way in: agent_api checks writes against the token's role
    ("*", "/api/agent/.*", "view"),
    # notes: drawing and editing one is a reviewer's; queueing it is not
    ("POST", "/api/revisions", "draw"),
    ("POST", "/api/revisions/english", "draw"),
    ("POST", "/api/revisions/{}/summary", "draw"),
    ("PUT", "/api/revisions/{}", "draw"),
    ("PATCH", "/api/revisions/{}", "status"),          # see action(): by the status asked for
    ("PATCH", "/api/revisions/{}/archive", "edit"),
    # the Taste check before a note is marked applied (backend/taste_check.py):
    # what marking it applied takes - it renders and asks a model
    ("POST", "/api/revisions/{}/taste-check", "run"),
    ("PUT", "/api/revisions/{}/image/after", "run"),
    # finishing a firmware note's work: its diff, build and picture on the card
    ("POST", "/api/revisions/{}/firmware-result", "run"),
    # notes: anyone who may draw a note on a model may jot one down; the
    # route itself keeps deleting someone else's to those who may delete
    ("POST", "/api/notes", "draw"),
    ("PATCH", "/api/notes/{}", "draw"),
    ("DELETE", "/api/notes/{}", "draw"),
    ("POST", "/api/notes/{}/send", "draw"),
    # taste palettes (backend/taste.py): like notes - making, changing,
    # attaching one, and asking for proposals from a project (a model call,
    # as a suggestion is); the route keeps deleting someone else's palette
    # to those who may delete. An extraction runs as a job: starting,
    # cancelling, marking where it was saved and deleting one are the same
    # right; reading the runs (GET /api/taste/jobs) is looking
    ("POST", "/api/taste(/.*)?", "draw"),
    ("PATCH", "/api/taste/.+", "draw"),
    ("PUT", "/api/taste/.+", "draw"),
    ("DELETE", "/api/taste/.+", "draw"),
    # manufacturers (backend/manufacturers.py): the same as taste - adding
    # one, its notes, exploring its site (a crawl and model calls, as an
    # extraction is) and cancelling a run; the routes keep deleting someone
    # else's manufacturer or run to those who may delete. Reading them,
    # their runs and the proxy's state is looking
    # a product's 3D model into a project as a model of its own changes the
    # design, as Files' "Add to project" (backend/product_files.py); attaching
    # files to a product is the catalog's, detaching someone else's needs the
    # right to delete (the route says)
    ("POST", "/api/manufacturers/{}/products/{}/to-model", "edit"),
    ("POST", "/api/manufacturers(/.*)?", "draw"),
    ("PATCH", "/api/manufacturers/.+", "draw"),
    ("PUT", "/api/manufacturers/.+", "draw"),
    ("DELETE", "/api/manufacturers/.+", "draw"),
    # McMaster-Carr and GrabCAD (backend/linked.py): saving a part or a
    # model, its notes and its CAD files is like the catalog's; a search
    # costs Jina tokens, so it is too; a CAD file into a project as a model
    # changes the design, as Files' "Add to project"; the routes keep
    # removing someone else's to those who may delete
    ("POST", "/api/linked/{}/parts/{}/to-model", "edit"),
    ("GET", "/api/linked/{}/search", "draw"),
    ("POST", "/api/linked/{}/parts(/.*)?", "draw"),
    ("PATCH", "/api/linked/{}/parts/{}", "draw"),
    ("DELETE", "/api/linked/{}/parts/{}", "draw"),
    # the McMaster-Carr API's credentials are the server's, like Jina's key
    ("PUT", "/api/mcmaster/settings", "settings"),
    ("POST", "/api/mcmaster/(settings/cert|test)", "settings"),
    ("DELETE", "/api/mcmaster/settings/cert", "settings"),
    # the inventory (backend/inventory.py): like notes - adding items (one,
    # several, a file), changing them and their quantities; the routes keep
    # deleting someone else's item to those who may delete. Reading the
    # items, their figures and the export is looking
    ("POST", "/api/inventory(/.*)?", "draw"),
    ("PATCH", "/api/inventory/.+", "draw"),
    ("DELETE", "/api/inventory/.+", "draw"),
    # files: bringing one in, or pointing an agent at it, is like writing a
    # note; the route keeps deleting someone else's to those who may delete
    ("POST", "/api/files", "draw"),
    # its folders, moving and deleting several: the same right; deleting a
    # folder with someone else's file in it needs "delete" (files_api.py)
    ("POST", "/api/files/(folders|move|bulk-delete)", "draw"),
    # the trash: putting back or deleting for good one's own, anyone's with "delete" (files_api.py)
    ("POST", "/api/files/trash/(restore|purge)", "draw"),
    # a copy of anything - the app's, an agent's, a room's - into one's own folders: like bringing a file in
    ("POST", "/api/files/{}/copy", "draw"),
    ("PATCH", "/api/files/folders/{}", "draw"),
    ("DELETE", "/api/files/folders/{}", "draw"),
    ("PATCH", "/api/files/{}", "draw"),
    ("DELETE", "/api/files/{}", "draw"),
    ("POST", "/api/files/{}/send", "draw"),
    ("POST", "/api/files/{}/to-model", "edit"),
    # a STEP's 3D preview: made once on the server, but it is looking at it
    ("GET", "/api/files/{}/mesh", "view"),
    # a 3D file's picture, drawn in the page and kept for everyone: a
    # reviewer's, as bringing the file in is
    ("PUT", "/api/files/{}/thumb", "draw"),
    # the Command Code room: talking is like writing a note; the routes keep
    # deleting someone else's conversation, or line, to those who may delete
    # (bulk delete, a line, an edit or a regenerated answer that drops others');
    # the trash likewise: restoring or dropping for good one's own is a
    # reviewer's, anyone else's needs "delete" (cc_chat.py checks)
    # stopping an answer: whoever asked, or anyone who may delete (cc_chat.py checks)
    # the queue (lines sent while an answer is written): one's own, or anyone's with "delete" (cc_chat.py checks)
    ("POST", "/api/cc/chats(/{}/(messages|regenerate|restore|stop|queue/resume|queue/clear)|/bulk-delete|/bulk-restore|/empty-trash)?", "draw"),
    ("PATCH", "/api/cc/chats/{}(/queue/{})?", "draw"),
    # one's own chat tools (on/off), and a yes or no to a tool that asks
    # first (cc_chat.py keeps that to whoever asked, or who may delete)
    ("PUT", "/api/cc/tools", "draw"),
    ("POST", "/api/cc/chats/{}/steps/{}", "draw"),
    # Undo and redo of what a tool changed: each also needs the rights the change needed (chat_undo.py).
    ("POST", "/api/cc/chats/{}/changes/(undo|{}/redo)", "draw"),
    ("DELETE", "/api/cc/chats/{}(/messages/{}|/queue/{})?", "draw"),
    # custom themes (backend/themes.py): anyone may make one in their own
    # space; the routes keep changing or deleting one to its maker or the
    # space's person
    ("*", "/api/themes(/{})?", "view"),
    # LLM settings: the keys and the models are the server's settings
    ("PUT", "/api/llm/settings", "settings"),
    ("POST", "/api/llm/test", "settings"),
    ("PUT", "/api/proxy/settings", "settings"),
    ("PUT", "/api/proxy/routes", "settings"),           # each lookup's order of routes (backend/netroutes.py)
    ("PUT", "/api/costs", "settings"),
    ("POST", "/api/fx/refresh", "settings"),
    ("POST", "/api/proxy/test", "settings"),
    # Jina AI (backend/jina.py): its key is the server's; the balance and
    # the counts are looking
    ("PUT", "/api/jina/settings", "settings"),
    ("POST", "/api/jina/test", "settings"),
    # Telegram (backend/tgbot/api.py): Telegram itself, with the webhook's
    # secret header and no session; the bot is the server's settings;
    # linking one's own chat, and what one hears about, is anyone's
    ("POST", "/api/telegram/webhook", NONE),
    ("*", "/api/telegram/(link|me|me/test)", "view"),
    ("PUT", "/api/telegram/(token|mode|settings|profile|profile/photo|profile/photo/default)", "settings"),
    ("DELETE", "/api/telegram/(bot|profile/photo|profile/lang/{})", "settings"),
    ("POST", "/api/telegram/profile/(translate|done)", "settings"),
    # releases: making one runs the builds' outputs; downloading is looking
    ("POST", "/api/releases", "run"),
    # talking with the agents
    ("POST", "/api/chat", "draw"),
    # a spoken line or note, written out for the box it goes in: whoever may
    # write the line - it costs a model call (backend/voice.py)
    ("POST", "/api/voice/transcribe", "draw"),
    # the next question, suggested after an answer: for whoever may write
    # the line it suggests - it costs a model call (backend/suggest.py)
    ("POST", "/api/suggest", "draw"),
    # the empty Chat's example questions written again now: a model call,
    # for whoever may start a conversation (backend/chat_ideas.py)
    ("POST", "/api/cc/ideas/refresh", "draw"),
    # direct messages (backend/dm.py): reading them is looking, writing one,
    # editing or deleting one's own line and marking read is chatting
    ("GET", "/api/dm(/.*)?", "view"),
    # a thing sent, added to one's own space: making something
    ("POST", "/api/dm/items/{}/add", "edit"),
    ("*", "/api/dm(/.*)?", "draw"),
    # a ```task block in a chat, queued with its button: queueing a note
    # (backend/tasks.py), so it is the same right as queueing one
    ("POST", "/api/chat/{}/task/{}/queue", "run"),
    ("POST", "/api/cc/chats/{}/messages/{}/task/{}/queue", "run"),
    ("POST", "/api/chat/{}/task/{}/reject", "run"),
    ("POST", "/api/cc/chats/{}/messages/{}/task/{}/reject", "run"),
    ("POST", "/api/questions", "draw"),
    ("POST", "/api/questions/{}/answer", "draw"),
    # an agent's question or reply in the reader's language: reading, so a
    # viewer's - it costs a model call, once per question and language, kept
    # on the question (backend/reading.py), as the tool finder costs one
    ("POST", "/api/(questions|chat)/{}/translate", "view"),
    # the work itself: what the agents do, and what starts it
    ("POST", "/api/run/start", "run"),
    ("POST", "/api/run/finish", "run"),
    ("POST", "/api/usage/ingest", "run"),
    ("POST", "/api/activity", "run"),
    ("POST", "/api/models/.+/build", "run"),
    ("POST", "/api/models/.+/drawing", "run"),
    ("POST", "/api/boards/{}/(build|layout|schematic|run)", "run"),
    # firmware: a build, or pins.h written again from the board, runs
    # something; making one or changing its code changes the design
    ("POST", "/api/firmware/{}/(build|pins)", "run"),
    # flashing happens in the person's browser; recording one is running something
    ("POST", "/api/firmware/{}/flashes(/{})?", "run"),
    # the board's 3D component, exported again from its layout: a run's step
    ("POST", "/api/boards/{}/component", "run"),
    ("POST", "/api/boards/{}/rules/check", "view"),     # a check, nothing is written
    # a part's drawn 3D body taken off it (backend/bodies.py): changing the
    # design, as binding one is - the model itself stays
    ("DELETE", "/api/parts/{}/bodies/{}", "edit"),
    # asking the 3D room for a body files a queued note: queueing one
    ("POST", "/api/parts/{}/body-request", "run"),
    # a part's 3D pose on one board (backend/poses.py): taking one off is
    # changing the board, like the rules it sits beside - not deleting
    ("DELETE", "/api/boards/{}/poses(/{})?", "edit"),
    ("POST", "/api/tools/(check|run)", "run"),
    # bringing a board in makes a board
    ("POST", "/api/boards/import", "edit"),
    ("POST", "/api/tools/(find|usage)", "view"),
    # a datasheet put in the datasheet library (backend/datasheets.py): a cache of what LCSC or the product
    # holds, kept for search - as much as asking the Chat, which may do the same
    ("POST", "/api/datasheets/product/{}/{}", "draw"),
    # one's own space's settings (auto-archive, auto-translate)
    ("PUT", "/api/settings", "space"),
    # the server's
    ("PUT", "/api/insights/(settings|kwh-price)", "settings"),
    # by method, for everything else
    ("GET", ".*", "view"),
    ("HEAD", ".*", "view"),
    ("OPTIONS", ".*", NONE),
    ("DELETE", ".*", "delete"),
    ("*", ".*", "edit"),
]

_COMPILED = [(m, re.compile(p.replace("{}", "[^/]+") + r"\Z"), a) for m, p, a in _RULES]


def action(method: str, path: str, query: dict | None = None) -> str:
    """The action a request is, for the role check."""
    for m, pattern, act in _COMPILED:
        if (m == "*" or m == method) and pattern.match(path):
            if act == "status":
                # Back to draft is the note's author's; anything else
                # (queued, and the agents' working/applied/failed) runs it.
                return "draw" if (query or {}).get("status") == "draft" else "run"
            return act
    return "edit"


def allowed(role: str | None, act: str) -> bool:
    return act == NONE or act in CAN.get(role or "", frozenset())


# What a page session (a headless browser taking a picture) may send: it
# reads. Not even the few writes a viewer may make - the agents' way in -
# and nothing a person signs in or out with but leaving.
PAGE_METHODS = ("GET", "HEAD")


def page_allowed(method: str, path: str, query: dict | None = None) -> bool:
    """Whether a page session may make this request. Stricter than
    allowed("viewer", ...): looking, and only by GET or HEAD."""
    if method == "OPTIONS":
        return True
    if method == "POST" and path == "/api/auth/logout":
        return True
    return method in PAGE_METHODS and action(method, path, query) in ("view", NONE)


def can(role: str | None) -> list[str]:
    return sorted(CAN.get(role or "", frozenset()))


def rank(role: str) -> int:
    """Owner 0 ... viewer 5: lower is more."""
    return ROLES.index(role) if role in ROLES else len(ROLES)


def refusal(role: str, act: str) -> str:
    """Why a request was refused, for the person who made it."""
    who = next((r for r in reversed(ROLES) if act in CAN[r]), "owner")
    return f"as {role} you cannot {ACTIONS.get(act, act)} - ask someone who is {who} or above"
