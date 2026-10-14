"""The secrets kept in the database, encrypted at rest.

The LLM providers' keys, Jina's key, the proxy's password, the McMaster-Carr
credentials (password, certificate and its password) and the Telegram bot's
token and webhook secret are typed in Settings and kept in MongoDB. Each one
is written as "enc1:" + a Fernet token (AES-128-CBC with an HMAC-SHA256), so a
copy of the database - a dump, a backup, Atlas' own view - holds no usable
secret.

The key is not in the database. It is `REDLINE_SECRET_KEY` (a Fernet key, or
any passphrase, which is hashed into one); unset, it is read from - or the
first time written to - `.secrets/secret.key` in the checkout (git-ignored,
mode 0600; `REDLINE_SECRET_KEY_FILE` moves it). Losing the key loses nothing
but the secrets: they are typed in Settings again.

A value without the prefix is an older plaintext one and is read as it is;
`python -m backend.secretbox migrate` encrypts those in place, once (run
again, it changes nothing). A value that will not decrypt - another key - is
logged with what to do and read as not set; it never stops the server.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger("redline.secretbox")

PREFIX = "enc1:"
KEY_ENV = "REDLINE_SECRET_KEY"
KEY_FILE_ENV = "REDLINE_SECRET_KEY_FILE"
KEY_FILE = Path(__file__).resolve().parent.parent / ".secrets" / "secret.key"

# Where each secret is kept: (collection, document id, its dotted fields).
# Machine-wide documents, all of them (not per workspace).
FIELDS: list[tuple[str, str, tuple[str, ...]]] = [
    ("server_settings", "jina", ("key",)),
    ("server_settings", "proxy", ("password",)),
    ("server_settings", "mcmaster", ("password", "cert_password", "cert.data")),
    ("telegram_settings", "bot", ("token", "secret")),
]
LLM_COLL, LLM_DOC = "llm_settings", "llm"        # every field under "keys"


class SecretError(RuntimeError):
    """A secret cannot be encrypted or decrypted: the key is wrong or missing."""


_lock = threading.Lock()
_fernet = None
_plain: dict[str, str] = {}                       # sealed -> plain, so a hot path decrypts once
_warned: set[str] = set()


def _key_file() -> Path:
    return Path(os.environ.get(KEY_FILE_ENV) or KEY_FILE)


def _as_fernet_key(text: str) -> bytes:
    """A Fernet key as it is, or any other text hashed into one."""
    raw = text.strip().encode()
    try:
        if len(base64.urlsafe_b64decode(raw)) == 32:
            return raw
    except (ValueError, TypeError):
        pass
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest())


def _load_key() -> bytes:
    env = (os.environ.get(KEY_ENV) or "").strip()
    if env:
        return _as_fernet_key(env)
    path = _key_file()
    if path.exists():
        text = path.read_text().strip()
        if not text:
            raise SecretError(f"the secret key file {path} is empty - restore it, or delete it to start a "
                              "new key (the saved secrets are then typed in Settings again)")
        return _as_fernet_key(text)
    from cryptography.fernet import Fernet
    new = Fernet.generate_key()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:                       # another process made it first: use that one
        return _as_fernet_key(path.read_text())
    with os.fdopen(fd, "wb") as f:
        f.write(new + b"\n")
    log.warning("secretbox: no %s set - created a new secret key at %s (keep it: without it the saved "
                "secrets must be typed in again)", KEY_ENV, path)
    return new


def _box():
    global _fernet
    if _fernet is None:
        with _lock:
            if _fernet is None:
                try:
                    from cryptography.fernet import Fernet
                except ImportError as exc:
                    raise SecretError("the cryptography package is missing - pip install -r requirements.txt") from exc
                _fernet = Fernet(_load_key())
    return _fernet


def reset() -> None:
    """Forget the key in memory (the tests change it)."""
    global _fernet
    with _lock:
        _fernet = None
        _plain.clear()
        _warned.clear()


def sealed(value) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def seal(value):
    """The value encrypted for the database. Empty, not text, or already
    sealed: as it is."""
    if not value or not isinstance(value, str) or sealed(value):
        return value
    return PREFIX + _box().encrypt(value.encode()).decode()


def unseal(value):
    """The plain value: a sealed one decrypted, anything else as it is (an
    older plaintext value). SecretError when it will not decrypt."""
    if not sealed(value):
        return value
    got = _plain.get(value)
    if got is not None:
        return got
    from cryptography.fernet import InvalidToken
    try:
        got = _box().decrypt(value[len(PREFIX):].encode()).decode()
    except InvalidToken as exc:
        raise SecretError(f"a saved secret does not decrypt with this server's key ({KEY_ENV} or "
                          f"{_key_file()}) - the key changed or was lost; type the secret in Settings again") from exc
    if len(_plain) > 256:
        _plain.clear()
    _plain[value] = got
    return got


def reveal(value, what: str):
    """unseal(), for the places that read a secret to use it: one that will
    not decrypt is logged (once) with what to do, and is None - not set -
    instead of an error in the middle of a request."""
    try:
        return unseal(value)
    except SecretError as exc:
        if what not in _warned:
            _warned.add(what)
            log.error("secretbox: %s: %s", what, exc)
        return None


def unreadable(value) -> bool:
    """A value is saved but will not decrypt with this key."""
    if not sealed(value):
        return False
    try:
        unseal(value)
        return False
    except SecretError:
        return True


# ---------------------------------------------------------------- the migration

def _get(doc: dict, dotted: str):
    for part in dotted.split("."):
        if not isinstance(doc, dict):
            return None
        doc = doc.get(part)
    return doc


async def migrate(raw) -> dict:
    """Encrypt the plaintext secrets of one database in place. Idempotent:
    a sealed value is left alone. Counts only - never a value."""
    out = {"encrypted": 0, "already": 0}

    async def one(coll: str, _id: str, fields) -> None:
        doc = await raw[coll].find_one({"_id": _id})
        if not doc:
            return
        sets = {}
        for f in fields:
            v = _get(doc, f)
            if not v or not isinstance(v, str):
                continue
            if sealed(v):
                out["already"] += 1
            else:
                sets[f] = seal(v)
        if sets:
            # Only where the value is still the plaintext that was read.
            q = {"_id": _id, **{f: _get(doc, f) for f in sets}}
            res = await raw[coll].update_one(q, {"$set": sets})
            if res.modified_count:
                out["encrypted"] += len(sets)

    for coll, _id, fields in FIELDS:
        await one(coll, _id, fields)
    llm = await raw[LLM_COLL].find_one({"_id": LLM_DOC}, {"keys": 1}) or {}
    await one(LLM_COLL, LLM_DOC, tuple(f"keys.{p}" for p in (llm.get("keys") or {})))
    return out


def _main(argv: list[str]) -> int:
    """python -m backend.secretbox migrate - the configured database."""
    import asyncio
    if argv[:1] != ["migrate"]:
        print("usage: python -m backend.secretbox migrate")
        return 2
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    from motor.motor_asyncio import AsyncIOMotorClient

    async def go() -> dict:
        client = AsyncIOMotorClient(os.environ["MONGODB_URI"])
        try:
            return await migrate(client[os.environ.get("MONGODB_DB") or "redline"])
        finally:
            client.close()

    print(asyncio.run(go()))
    return 0


if __name__ == "__main__":
    import sys
    raise SystemExit(_main(sys.argv[1:]))
