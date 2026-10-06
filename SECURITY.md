# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: **Security → Report a vulnerability**
on this repository (private vulnerability reporting). Include what you
found, how to reproduce it, and what an attacker could do with it. You
will get an answer within a few days; a fix for a confirmed problem goes
to `main` first.

Only the latest `main` is supported. There are no maintained release
branches.

## What is in scope

Redline is meant to run on one machine or a small private server, behind
a reverse proxy with TLS. Problems worth reporting include:

- signing in, sessions, invitations and roles (`backend/auth.py`,
  `backend/access.py`) - one person or agent reaching another's
  workspace, or doing more than its role allows
- agent tokens (`rlat_...`) being usable beyond their workspace, room or
  role
- a way to read the server's keys (LLM providers, the proxy, the
  database) from the browser or the API
- code from a note, a tool or an upload running outside its container
  (`--network none`, memory cap) or on the host
- cross-site requests that change something without the app's own page

Out of scope: running with `REDLINE_REQUIRE_SIGNIN=false` (local mode trusts everyone who
can reach the port, by design), denial of service on a single-user box,
and findings that need shell access to the machine already.

## How the app protects itself

- **Passwords** are hashed with scrypt, salted per account. Five failed
  sign-ins in fifteen minutes lock that address out for a while.
- **Sessions** are random tokens in an `HttpOnly`, `SameSite=Lax` cookie
  (`Secure` over HTTPS). The database keeps only their SHA-256, so a copy
  of the database signs nobody in.
- **CSRF**: every change must carry the `X-Redline-CSRF` header, which
  only the app's own page sends.
- **Agent tokens** are shown once, kept as SHA-256, scoped to a workspace
  (and optionally a room), never above the editor role, and can be
  revoked.
- **Roles** (viewer, reviewer, editor, admin) are checked on every route
  in one place, `backend/access.py`; changes are written to an audit log.
- **Server keys** (OpenRouter, Command Code, the proxy, MongoDB) live in
  `.env` or the database and never reach a browser: the page sees only
  whether a key is set and its last four characters.
- **Untrusted code** (builds, tools, releases) runs in throwaway Docker
  containers with no network and a memory cap.

## Running it safely

- Keep `.env` out of git (it is in `.gitignore`); `.env.example` holds
  placeholders only.
- Set `REDLINE_REQUIRE_SIGNIN=true` on anything reachable from another machine, and serve
  it over HTTPS.
- Do not expose MongoDB to the internet; bind it to the host or a private
  network and give it its own user and password.
- Rotate any key that was ever pasted into a chat, a log or a ticket. The
  PII & Secret Redactor tool (Basic Tools) masks keys before text goes to
  a model.

## Known false positives

Secret scanners flag a few strings that are examples, not secrets:

- `.env.example` - a MongoDB URI with `USER:PASSWORD` placeholders
- `frontend/public/tools/pii-redactor/` - made-up keys (`...EXAMPLE...`)
  that show what the redactor finds

None of them work anywhere.
