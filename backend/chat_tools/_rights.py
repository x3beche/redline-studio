"""A tool does nothing its person could not do on the page: the right the
same request on the API needs (backend/access.py), checked for the asker."""

from __future__ import annotations

from .. import access
from . import ToolError


def need(method: str, path: str) -> None:
    """The right `method path` needs on the API, or a ToolError saying why not."""
    who = access.current()
    act = access.action(method, path)
    if not access.allowed(who, act):
        raise ToolError(access.refusal(who or "nobody", act))
