"""Who is doing something: a person or an agent, and a record of what.

Until sign-in exists there is one person - the local user, named in .env
as X3_LOCAL_USER (default "you") - and the agents, which say who they are:
the command line sets its actor to the agent named in X3_AGENT (default
"agent"), and its calls to the API carry the same name in the
X-Redline-Actor header. Everything written from then on carries an actor -
notes, thread lines, answers, runs, log lines - and every delete or change
of state is written to `audit`, so nothing disappears without a trace.

When sign-in comes (docs/USERS-PLAN.md, phase 3) the person here becomes
the signed-in user; nothing that reads an actor has to change.
"""

from __future__ import annotations

import contextvars
import os
from datetime import datetime, timezone

AUDIT = "audit"
HEADER = "x-redline-actor"


def local_user() -> dict:
    name = os.environ.get("X3_LOCAL_USER", "you").strip() or "you"
    return {"type": "user", "id": "local", "name": name}


def agent(name: str | None = None) -> dict:
    name = (name or os.environ.get("X3_AGENT", "agent")).strip() or "agent"
    return {"type": "agent", "id": name, "name": name}


CURRENT: contextvars.ContextVar[dict | None] = contextvars.ContextVar("actor", default=None)


def current() -> dict:
    """The actor of the request or command running now."""
    return CURRENT.get() or local_user()


def from_header(value: str | None) -> dict:
    """`agent:<name>` from the command line; anything else is the person."""
    if value and value.startswith("agent:"):
        return agent(value[len("agent:"):][:60])
    return local_user()


def header_for_agent() -> dict[str, str]:
    """What the command line sends so the API knows which agent is asking."""
    return {"X-Redline-Actor": "agent:" + agent()["name"]}


async def audit(db, action: str, target: str, detail: dict | None = None,
                actor: dict | None = None) -> None:
    """One line of the audit trail. Never raises: a trail that fails must
    not take the change it records down with it."""
    try:
        await db[AUDIT].insert_one({
            "at": datetime.now(timezone.utc), "actor": actor or current(),
            "action": action, "target": target, **({"detail": detail} if detail else {})})
    except Exception:
        pass


def audited(method: str, path: str) -> str | None:
    """Which requests are changes worth a line in the trail: every delete,
    every change of state, the settings and the rules. None for the rest."""
    if not path.startswith("/api/"):
        return None
    if method == "DELETE":
        return "delete"
    if method == "PATCH":
        return "change"
    if method == "PUT" and (path.startswith("/api/settings") or path.endswith("/rules")
                            or path.startswith("/api/insights/settings")):
        return "settings"
    return None
