"""A tool does nothing its person could not do on the page: the right the
same request on the API needs (backend/access.py), checked for the asker."""

from __future__ import annotations

import contextvars

from .. import access
from . import ToolError

# The rights a recorded call checked (backend/chat_undo.py): undoing it needs them too.
CHECKED: contextvars.ContextVar[list | None] = contextvars.ContextVar("cc_tool_rights", default=None)


def need(method: str, path: str) -> None:
    """The right `method path` needs on the API, or a ToolError saying why not."""
    who = access.current()
    act = access.action(method, path)
    got = CHECKED.get()
    if got is not None and [method, path] not in got:
        got.append([method, path])
    if not access.allowed(who, act):
        raise ToolError(access.refusal(who or "nobody", act))
