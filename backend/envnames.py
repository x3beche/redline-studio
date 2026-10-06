"""The settings' names in the environment.

Every setting is `REDLINE_<NAME>` (see INSTALL.md). They were `X3_<NAME>`
first; an old name still works - it is copied to the new one when the new
one is not set, so an older .env or agent setup keeps running unchanged.
"""

from __future__ import annotations

import os

PREFIX, OLD_PREFIX = "REDLINE_", "X3_"
# Names that changed more than their prefix.
RENAMED = {"X3_AUTH": "REDLINE_REQUIRE_SIGNIN"}


def adopt(env: dict | None = None) -> None:
    """Copy each old X3_ name to its REDLINE_ name, unless that is set."""
    env = os.environ if env is None else env
    for old, value in list(env.items()):
        if not old.startswith(OLD_PREFIX):
            continue
        new = RENAMED.get(old) or PREFIX + old[len(OLD_PREFIX):]
        env.setdefault(new, value)


adopt()
