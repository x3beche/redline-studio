"""Make the owner's account on a deployment's first start, from the environment.

Run by docker/deploy/api-entrypoint.sh when REDLINE_OWNER_EMAIL is set:

    REDLINE_OWNER_EMAIL, REDLINE_OWNER_PASSWORD (10+ characters), REDLINE_OWNER_NAME

It does what the page's first-visit setup does (POST /api/auth/setup,
backend/auth.make_first_user) and nothing once any account exists, so it is
safe on every start. Without it the first person to open the page makes the
owner's account - which is fine on a machine nobody else reaches yet.
"""

import asyncio
import os
import sys

from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, os.getcwd())          # the code in REDLINE_HOST_DIR/app
from backend import auth                  # noqa: E402


async def main() -> int:
    if not auth.enabled():
        print("> owner bootstrap skipped: sign-in is off (REDLINE_REQUIRE_SIGNIN)")
        return 0
    email = os.environ.get("REDLINE_OWNER_EMAIL", "").strip()
    password = os.environ.get("REDLINE_OWNER_PASSWORD", "")
    if not password:
        print("> owner bootstrap skipped: REDLINE_OWNER_PASSWORD is not set")
        return 0
    client = AsyncIOMotorClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=30000)
    raw = client[os.environ.get("MONGODB_DB", "redline")]
    try:
        if await auth.any_user(raw):
            return 0
        user = await auth.make_first_user(raw, email, os.environ.get("REDLINE_OWNER_NAME", ""), password)
        print(f"> owner account made for {user['email']}")
    except (ValueError, PermissionError) as exc:
        print(f"> owner bootstrap: {exc}")
        return 1
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
