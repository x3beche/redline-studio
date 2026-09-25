"""Accounts, from the machine itself - for when nobody can sign in.

    .venv/bin/python tools/account.py list
        every account: email, name, and role in each workspace
    .venv/bin/python tools/account.py reset <email> [--base http://127.0.0.1:4200]
        a one-use link, good for an hour, that sets a new password;
        open it in a browser and choose the password there

It needs the database (MONGODB_URI in .env), so only someone who can run
things on this machine can use it. Passwords are never shown or chosen
here: they are kept only as a hash.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _db():
    from dotenv import load_dotenv
    from motor.motor_asyncio import AsyncIOMotorClient
    load_dotenv(ROOT / ".env")
    uri = os.getenv("MONGODB_URI", "").strip()
    if not uri:
        sys.exit("MONGODB_URI is not set (.env)")
    return AsyncIOMotorClient(uri)[os.getenv("MONGODB_DB", "assets_3d")]


async def _list() -> None:
    from backend import auth
    db = _db()
    n = 0
    async for u in db[auth.USERS].find({}, {"pw": 0}).sort("created_at", 1):
        n += 1
        roles = [f"{m.get('role')} in {m.get('workspace')}" async for m in db[auth.MEMBERS].find({"user": u["_id"]})]
        print(f"{u['email']:<36} {u.get('name') or '':<24} {', '.join(roles) or 'in no workspace'}"
              + ("  (disabled)" if u.get("disabled") else ""))
    if not n:
        print("no accounts yet - the first visit to the page makes the owner's")


async def _reset(email: str, base: str) -> None:
    from backend import auth
    try:
        key, doc = await auth.create_reset(_db(), email)
    except LookupError as exc:
        sys.exit(str(exc))
    print(f"Open this within {auth.RESET_MINUTES} minutes and choose a new password for {doc['email']}:")
    print(f"  {base.rstrip('/')}/?reset={key}")
    print("It works once; making another link cancels this one.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    r = sub.add_parser("reset")
    r.add_argument("email")
    r.add_argument("--base", default="http://127.0.0.1:4200", help="the page's address")
    a = ap.parse_args()
    asyncio.run(_list() if a.cmd == "list" else _reset(a.email, a.base))


if __name__ == "__main__":
    main()
