"""Who may do what: the roles, in one table.

Every API request is sorted into one action - looking, drawing a note,
running something, changing the design, deleting, the workspace's
settings, its members, its agent tokens - by its method and path, in
`action()` below. The middleware in main.py asks `allowed(role, action)`
once per request, so no route has to remember to check, and a route added
later falls under the rule for its method (GET looks, DELETE deletes,
anything else changes the design) until it is listed here.

In local mode (sign-in off) the person at the machine is the owner and
everything is allowed, as it always was.
"""

from __future__ import annotations

import contextvars
import re

ROLES = ("owner", "admin", "editor", "reviewer", "viewer")

# The role of the request being served; the middleware sets it. Local mode:
# the owner.
ROLE: contextvars.ContextVar[str | None] = contextvars.ContextVar("role", default="owner")


def current() -> str | None:
    return ROLE.get()


# What each action is, in the words the page shows when one is refused.
ACTIONS = {
    "view": "look at the workspace",
    "draw": "draw notes, save drafts, chat and answer questions",
    "run": "queue notes and run builds",
    "edit": "change models and boards",
    "delete": "delete",
    "settings": "change the workspace's settings",
    "tokens": "hand out agent tokens",
    "members": "invite people and change roles",
}

CAN: dict[str, frozenset[str]] = {
    "viewer": frozenset({"view"}),
    "reviewer": frozenset({"view", "draw"}),
    "editor": frozenset({"view", "draw", "run", "edit", "delete", "tokens"}),
    "admin": frozenset({"view", "draw", "run", "edit", "delete", "tokens", "settings", "members"}),
    "owner": frozenset(ACTIONS),
}

# What a role is for, in a line - the members list shows it.
ABOUT = {
    "owner": "everything, including who owns the workspace",
    "admin": "everything but ownership: members, settings, tokens",
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
    # signing in, and an invitation's own page
    ("*", "/api/auth/.*", NONE),
    ("*", "/api/invite/.*", NONE),
    ("*", "/api/reset/.*", NONE),
    ("GET", "/api/health", NONE),
    # one's own profile (backend/profile.py): anyone signed in, and only
    # themselves - the routes take no one else's id but a picture's
    ("*", "/api/me(/.*)?", "view"),
    # the people and the agents
    ("*", "/api/members(/.*)?", "members"),
    ("*", "/api/invites(/.*)?", "members"),
    ("*", "/api/agent-tokens(/.*)?", "tokens"),
    # the workspaces: seeing and opening one's own, making one, naming this one
    ("GET", "/api/workspaces", "view"),
    ("POST", "/api/workspaces/{}/open", "view"),      # membership of the other is checked
    ("POST", "/api/workspaces", "members"),
    ("PATCH", "/api/workspaces/{}", "settings"),
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
    # notes: anyone who may draw a note on a model may jot one down; the
    # route itself keeps deleting someone else's to those who may delete
    ("POST", "/api/notes", "draw"),
    ("PATCH", "/api/notes/{}", "draw"),
    ("DELETE", "/api/notes/{}", "draw"),
    ("POST", "/api/notes/{}/send", "draw"),
    # files: bringing one in, or pointing an agent at it, is like writing a
    # note; the route keeps deleting someone else's to those who may delete
    ("POST", "/api/files", "draw"),
    ("PATCH", "/api/files/{}", "draw"),
    ("DELETE", "/api/files/{}", "draw"),
    ("POST", "/api/files/{}/send", "draw"),
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
    # custom themes (backend/themes.py): anyone in the workspace may make
    # one; the routes keep changing or deleting someone else's to its maker,
    # an owner or an admin
    ("*", "/api/themes(/{})?", "view"),
    # LLM settings: the keys and the models are the workspace's settings
    ("PUT", "/api/llm/settings", "settings"),
    ("POST", "/api/llm/test", "settings"),
    ("PUT", "/api/proxy/settings", "settings"),
    ("PUT", "/api/costs", "settings"),
    ("POST", "/api/fx/refresh", "settings"),
    ("POST", "/api/proxy/test", "settings"),
    # Telegram (backend/tgbot/api.py): Telegram itself, with the webhook's
    # secret header and no session; the bot is the server's settings;
    # linking one's own chat, and what one hears about, is anyone's;
    # unlinking someone else is managing the members
    ("POST", "/api/telegram/webhook", NONE),
    ("*", "/api/telegram/(link|me|me/test)", "view"),
    ("DELETE", "/api/telegram/links/{}", "members"),
    ("PUT", "/api/telegram/(token|mode|settings|profile|profile/photo|profile/photo/default)", "settings"),
    ("DELETE", "/api/telegram/(bot|profile/photo|profile/lang/{})", "settings"),
    ("POST", "/api/telegram/profile/(translate|done)", "settings"),
    # releases: making one runs the builds' outputs; downloading is looking
    ("POST", "/api/releases", "run"),
    # talking with the agents
    ("POST", "/api/chat", "draw"),
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
    # the board's 3D component, exported again from its layout: a run's step
    ("POST", "/api/boards/{}/component", "run"),
    ("POST", "/api/boards/{}/rules/check", "view"),     # a check, nothing is written
    ("POST", "/api/tools/(check|run)", "run"),
    # bringing a board in makes a board
    ("POST", "/api/boards/import", "edit"),
    ("POST", "/api/tools/(find|usage)", "view"),
    # the workspace's settings
    ("PUT", "/api/settings", "settings"),
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
# reads. Not even the few writes a viewer may make - opening another
# workspace, the agents' way in - and nothing a person signs in or out with
# but leaving.
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
    """Owner 0 ... viewer 4: lower is more."""
    return ROLES.index(role) if role in ROLES else len(ROLES)


def refusal(role: str, act: str) -> str:
    """Why a request was refused, for the person who made it."""
    who = next((r for r in reversed(ROLES) if act in CAN[r]), "owner")
    return f"as {role} you cannot {ACTIONS.get(act, act)} - ask someone who is {who} or above"
