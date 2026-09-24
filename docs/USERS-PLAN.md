# Users in Redline - research and work plan

Status: **in progress** - phase 1 done (2026-09-24). Decisions below are
recorded in section 6.

## 1. Where things stand

Redline is a single-person tool today, and that assumption runs through all of it:

| area | today | why it matters for users |
|---|---|---|
| Serving | FastAPI and Angular on `127.0.0.1` only; CORS allows localhost | nobody else can reach it, so nothing asks who you are |
| API | 84 routes in `backend/main.py` (boards 20, revisions 12, parts 12, models 7…) plus the code rooms' routes; **none checks a caller** | every route needs an owner check, or it leaks across people |
| Data | ~20 MongoDB collections (`models`, `revisions`, `runs`, `folders`, `uploads`, `boards`, `apps`, `chat`, `questions`, `activity`, `jobs`, `calls`, `analytics`, `settings`, LCSC `parts`…) plus GridFS artefacts; **no owner field on any of them** | every document needs a workspace, and every query a filter |
| Agents | `tools/revisions.py` and the MCP server (which shells out to it) connect **straight to MongoDB** with the URI from `.env`; five room agents in `.claude/agents/` | an agent with the DB URI bypasses any permission the API adds, so agents must move onto the API with a token |
| Identity today | `chat.role` is `user`/`agent`; LCSC's journal has a `who` of `page`/`agent`; notes have no author | "you" is assumed to be one person |
| Rooms and runs | one run per room (`runs/current:<room>`), one queue, one catalog tree | with several people these become per workspace, and possibly per person |
| Sandboxes | code rooms run commands in Docker images with `--network host` | on a shared machine that is one user's code reaching another's services; needs isolation and limits |
| Spend | per-revision cost and compute (`usage.py`, `compute.py`), OpenRouter calls server-side | the natural base for per-user and per-workspace usage and limits |
| Secrets | `.env` (MongoDB URI, OpenRouter key), never in the frontend | stays so; sessions and tokens add new secrets that must follow the same rule |

## 2. What "a user system" should mean here

Separate the questions, because they have different costs:

1. **Authentication** - who you are: sign in, sessions, sign out.
2. **Tenancy** - whose things these are: workspaces (a team or a person), and projects inside them (`iot-fan` is a project).
3. **Authorisation** - what you may do: roles per workspace, optionally sharing per project.
4. **Agents as principals** - the agents act for a workspace with their own identity and limited rights, and everything they do is attributed.
5. **Attribution and audit** - who wrote the note, who answered the question, who ran the build, who deleted the board (one board already went missing with no trace).
6. **Limits and usage** - LLM spend, compute and sandboxes per workspace, per user.
7. **Exposure** - serving beyond localhost: HTTPS, secure cookies, CSRF, rate limits.

## 3. Options researched

### 3.1 Sign-in

| option | effort | notes |
|---|---|---|
| **A. First-party sessions**: email + password (Argon2id), server-side sessions in MongoDB, `HttpOnly; Secure; SameSite=Lax` cookie | medium | full control, no third party; we own password reset, lockout and email sending |
| **B. OAuth / OIDC sign-in** (GitHub, Google) via Authlib | low-medium | no passwords to keep; fits users who already live on GitHub; still needs our own sessions after the redirect |
| **C. Passkeys (WebAuthn)** via `py_webauthn` | medium | best security and UX today; good as a second method, not the only one |
| **D. Self-hosted identity provider** (Authentik, Keycloak, Zitadel) in front | medium to run, low to code | SSO and MFA for free; one more service to operate; FastAPI only validates OIDC tokens |
| **E. Hosted auth** (Clerk, Auth0, WorkOS, Supabase Auth) | low to code | fastest to "log in works"; a vendor, a monthly bill and user data outside our database |

**Recommendation:** B + A-style sessions first (GitHub and Google sign-in, sessions and cookies owned by us), then passkeys (C). Keep the session layer OIDC-shaped so D can be put in front later for a company that needs SSO. Avoid E unless time matters more than owning the data.

### 3.2 Tenancy model

- **Workspace** = the unit of sharing and billing (a team, or one person's own). Every document gets `workspace_id`.
- **Project** = top-level folder inside a workspace (`iot-fan`). Optional per-project sharing comes later.
- **Membership** = (user, workspace, role).
- A `personal` workspace per user is created at sign-up; teams are extra workspaces.

Alternatives considered: one database per workspace (strong isolation, awkward with Motor and GridFS and many workspaces), or a separate deployment per team (simplest isolation, no shared anything). The shared database with `workspace_id` on every document is the usual choice at this size. The risk is a query that forgets the filter, and that is handled in code (see 4.3), not by hoping.

### 3.3 Roles

| role | can |
|---|---|
| owner | everything, plus billing, delete the workspace, manage members |
| admin | manage members and settings, everything below |
| editor | create and edit models, boards and apps; queue notes; answer agent questions; run builds |
| reviewer | draw notes and save drafts, chat, answer questions - not queue, build or delete |
| viewer | look, download files |

The permissions live in one table in code (`role -> set of actions`), not scattered through routes.

### 3.4 Agents

- Each agent gets an **agent token**: a service identity bound to one workspace and optionally one room, with a role (usually `editor`) and a label ("pcb room agent").
- **The CLI and MCP server stop connecting to MongoDB** and call the API with that token. This is the biggest single change and the one that makes permissions real: while an agent holds the DB URI, nothing the API checks applies to it.
- Everything an agent writes carries `actor: {type: "agent", id, on_behalf_of}` - usually the user who queued the note.
- The main agent and room agents keep working as today; only their transport changes.

## 4. Design

### 4.1 New collections

- `users` - id, email, name, avatar, sign-in methods, created, last seen, disabled
- `identities` - provider (`github`/`google`/`password`/`passkey`), subject, user id
- `sessions` - hashed session id, user id, workspace id, created, last seen, expires, user agent and IP
- `workspaces` - id, name, slug, plan, limits, created by
- `memberships` - user id, workspace id, role, invited by, joined
- `invites` - workspace, email, role, token hash, expires
- `agent_tokens` - hashed token, workspace, room, role, label, created by, last used, revoked
- `audit` - who, what, target, when, from where (deletes, role changes, sign-ins, token use)

### 4.2 Changes to existing documents

Add `workspace_id` everywhere; add `created_by` / `actor` where a person or an agent is the author: notes (`revisions`), chat lines, question answers, runs, activity lines, uploads, boards, apps, models, folders, LCSC journal (`who` becomes a real id), usage, compute jobs. Unique keys that are global today (board ids like `controller`, folder paths, `runs/current:<room>`) become unique **per workspace**.

### 4.3 Backend structure

- `backend/auth.py` - OAuth routes, session create/read/revoke, a `current()` dependency returning `(user, workspace, role)` or an agent principal
- `backend/access.py` - the role -> action table and `require(action)` as a FastAPI dependency
- `backend/scope.py` - `scoped(db, principal)`, a thin wrapper whose `find`/`insert`/`update`/`delete` always add `workspace_id`. Routes use it instead of `db()` directly, and a test fails the build if `db()[...]` appears in a route module outside it.
- Middleware - CSRF (double-submit token or `Origin` check) for cookie sessions; rate limits on sign-in and the LLM-backed routes
- Settings, catalog, queue and runs read through the scope; the per-room run key becomes `current:<workspace>:<room>`

### 4.4 Frontend

- Sign-in page (GitHub and Google buttons, later passkeys), sign-out, a user menu at the foot of the catalog rail (avatar, workspace switcher, settings)
- Members page: invite by email, change roles, remove; agent tokens page: create, label, revoke, last used
- Author on everything: avatar and name on note cards, chat lines ("you" vs a name vs "pcb agent"), who answered a question, who started a run, who deleted what
- Actions hidden or disabled by role, with the reason on hover (a reviewer sees "Queue" disabled: "reviewers draw and comment; an editor queues")
- An `HttpInterceptor` for 401 (to sign-in) and 403 (a message, not a blank)

### 4.5 Sandboxes, compute and spend

- Code rooms' containers: drop `--network host` for a per-workspace Docker network; CPU, memory and PID limits per container; a per-workspace concurrency cap
- Per-workspace usage from the existing `usage`/`compute` data: LLM spend, build minutes, storage; soft limits with a warning, hard limits that refuse with a reason
- LCSC politeness budget stays global (it protects a third party), but the journal shows which workspace asked

### 4.6 Exposure beyond localhost

- Reverse proxy (Caddy: automatic HTTPS) in front of one port serving the built UI and the API
- Cookies `Secure`, `HttpOnly`, `SameSite=Lax`; HSTS; CORS narrowed to the real origin
- Nothing new in the frontend bundle: OAuth client secrets and the session secret live in `.env` like the MongoDB URI and the OpenRouter key, and the pre-commit secret grep is extended to them

## 5. Work plan

Each phase ships on its own and leaves the app working. Estimates are for one agent working with review.

| phase | what | done when | size |
|---|---|---|---|
| **0. Decisions** | answer section 6 | the plan is fixed | - |
| **1. Attribution, still single-user** | add `actor`/`created_by` to notes, chat, answers, runs, activity, deletes; an `audit` collection; a "local user" from `.env` | every card and line says who, deletes are traceable | S |
| **2. Workspaces in the data** | `workspace_id` on every collection, migration putting everything in one default workspace, `scope.py`, the "no raw db() in routes" test, per-workspace keys | all queries go through the scope, the app behaves exactly as before | M-L |
| **3. Sign-in and sessions** | `users`, `identities`, `sessions`; GitHub and Google OAuth; cookie sessions; CSRF; sign-in page, user menu; the first user to sign in owns the default workspace | nobody reaches the API without a session | M |
| **4. Agents on the API** | `agent_tokens`; the CLI and MCP server call the API instead of MongoDB (a thin client in `tools/`); room agents get room-scoped tokens; `.claude/agents/*` and `AGENTS.md` updated | no agent needs `MONGODB_URI`; everything they write carries an actor | L |
| **5. Roles and members** | `memberships`, `invites`, the role table, `require()` on every route, members and tokens pages, role-aware UI | a reviewer cannot queue or delete; an invite brings a new person in | M |
| **6. Isolation and limits** | per-workspace Docker networks and limits, usage and limits per workspace, rate limits | one workspace cannot see or starve another | M |
| **7. Going public** | Caddy, HTTPS, secure cookies, CORS, an `ops` page (sessions, audit) | reachable from outside, safely | S-M |
| **8. Later** | passkeys, per-project sharing, SSO through an IdP, presence ("who is looking at this board"), billing | - | - |

Tests along the way: an authorisation matrix (every route × every role → allowed or refused), a cross-workspace leak test (workspace B asks for A's board, note, artefact, chat, run → 404), session expiry and CSRF tests, and agent-token scope tests.

## 6. Decisions

Taken 2026-09-24, without further questions, as asked:

1. **Who it is for:** the owner plus a few invited people.
2. **Sign-in:** email and password first; passkeys later (phase 8).
3. **Workspaces:** one shared team space to start; the data model carries a
   workspace on everything, so personal spaces can come later unchanged.
4. **Sharing:** the workspace is enough.
5. **Agents:** one set of agents per workspace.
6. **Local mode:** kept - a no-login mode for running on this machine, so the
   agents and the current setup keep working until sign-in is switched on.
7. **Limits and billing:** not needed yet.

Changes to the plan these make:

- Phase 3 uses **email and password** (Argon2id, server-side sessions), not
  GitHub/Google OAuth; OAuth can be added later behind the same sessions.
- Phase 2 needs **no live migration to start with**: a document without a
  `workspace_id` belongs to the default workspace, read through the scope
  helper. New documents are written with one. A backfill script (dry run,
  backup first) can make it explicit later.

### Phase 1 - attribution (done)

`backend/actors.py`: the actor of every request - the local user (named by
`X3_LOCAL_USER`, default "you") or the agent named in the `X-Redline-Actor`
header - and of every command-line run (the agent named by `X3_AGENT`). New
notes carry `created_by`, status changes `status_by`, edits `edited_by`,
thread lines `by`, questions `asked_by` and `answered_by`, runs and log lines
`by`. Every DELETE, PATCH and settings or rules change is written to `audit`
by a middleware, whatever route it came through; `/api/audit` lists it and
the Analytics room shows it under *Recent changes*. Note cards say who wrote
them, and the thread names the agent.

### Original list of questions



1. **Who is it for?** Just you plus a few invited people on this machine, a team, or a public product people sign up to? This decides how far phases 6 and 7 go.
2. **Sign-in methods:** GitHub + Google, email + password, passkeys - which at first?
3. **Workspaces:** one shared team space, or personal spaces plus teams?
4. **Sharing granularity:** is the workspace enough, or must single projects (`iot-fan`) be shared with outsiders?
5. **Agents:** one set of agents per workspace (they see only that workspace), or per user?
6. **Local mode:** keep a no-login "local" mode for running on your own machine, as today?
7. **Limits and billing:** do per-user spending or build limits matter at the start?

## 7. Risks

- **A missing filter leaks data.** Mitigation: all access through `scope.py`, the test that forbids raw `db()` in routes, and the cross-workspace leak tests.
- **Agents moving off the database** touches every command they run. Mitigation: phase 4 on its own, the CLI keeping its commands and output while only the transport changes, and both paths run side by side for one release.
- **Migration** of live data (models, boards, GridFS artefacts, the 6k+ documents). Mitigation: idempotent migration script, a dry run with counts, and a backup first.
- **Two agents working in one repo** (as now) while the schema changes. Mitigation: phases 2 and 4 done by one agent, announced, on a branch.
