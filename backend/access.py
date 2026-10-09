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
    # a page telling the server what broke in it (backend/client_errors.py)
    ("POST", "/api/client-errors", "view"),
    # one's own profile (backend/profile.py): anyone signed in, and only
    # themselves - the routes take no one else's id but a picture's
    ("*", "/api/me(/.*)?", "view"),
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
    ("PUT", "/api/revisions/{}/image/after", "run"),
    # finishing a firmware note's work: its diff, build and picture on the card
    ("POST", "/api/revisions/{}/firmware-result", "run"),
    # notes: anyone who may draw a note on a model may jot one down; the
    # route itself keeps deleting someone else's to those who may delete
    ("POST", "/api/notes", "draw"),
    ("PATCH", "/api/notes/{}", "draw"),
    ("DELETE", "/api/notes/{}", "draw"),
    ("POST", "/api/notes/{}/send", "draw"),
    # files: bringing one in, or pointing an agent at it, is like writing a
    # note; the route keeps deleting someone else's to those who may delete
    ("POST", "/api/files", "draw"),
    # its folders, moving and deleting several: the same right; deleting a
    # folder with someone else's file in it needs "delete" (files_api.py)
    ("POST", "/api/files/(folders|move|bulk-delete)", "draw"),
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
    ("DELETE", "/api/cc/chats/{}(/messages/{}|/queue/{})?", "draw"),
    # custom themes (backend/themes.py): anyone may make one in their own
    # space; the routes keep changing or deleting one to its maker or the
    # space's person
    ("*", "/api/themes(/{})?", "view"),
    # LLM settings: the keys and the models are the server's settings
    ("PUT", "/api/llm/settings", "settings"),
    ("POST", "/api/llm/test", "settings"),
    ("PUT", "/api/proxy/settings", "settings"),
    ("PUT", "/api/costs", "settings"),
    ("POST", "/api/fx/refresh", "settings"),
    ("POST", "/api/proxy/test", "settings"),
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
    # the next question, suggested after an answer: for whoever may write
    # the line it suggests - it costs a model call (backend/suggest.py)
    ("POST", "/api/suggest", "draw"),
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
    ("POST", "/api/boards/{}/(build|layout|schematic|run)", "run"),
    # firmware: a build, or pins.h written again from the board, runs
    # something; making one or changing its code changes the design
    ("POST", "/api/firmware/{}/(build|pins)", "run"),
    # flashing happens in the person's browser; recording one is running something
    ("POST", "/api/firmware/{}/flashes(/{})?", "run"),
    # the board's 3D component, exported again from its layout: a run's step
    ("POST", "/api/boards/{}/component", "run"),
    ("POST", "/api/boards/{}/rules/check", "view"),     # a check, nothing is written
    ("POST", "/api/tools/(check|run)", "run"),
    # bringing a board in makes a board
    ("POST", "/api/boards/import", "edit"),
    ("POST", "/api/tools/(find|usage)", "view"),
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
