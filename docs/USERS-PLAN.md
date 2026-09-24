# Users in Redline - research and work plan

Status: **in progress** - phases 1, 2 and 3 done (2026-09-24). Decisions
below are recorded in section 6.

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

### Phase 2 - workspaces in the data (done)

`backend/scope.py`. `main.db()` - the only way a route reaches the database,
`code_api` included - returns a `ScopedDb` for the request's workspace
(a context variable, "default" until sign-in). Collections that belong to a
workspace (models, folders, uploads, notes, runs, the thread, questions,
activity, boards, apps, settings, board runs, item history, weekly
reports, the audit trail, compute jobs, analytics) come back wrapped: reads
are kept to the workspace, writes stamped with it, aggregations start by
keeping to it, upserts set it on insert. What belongs to the machine or to
everyone - the LCSC parts cache, machine samples, API timings, server
events, LLM calls and the stored files - passes through. Ids that exist
once per workspace (the settings document, a room's current run) get the
workspace appended outside the default one.

No data was migrated: a document without `workspace_id` is the default
workspace's. Checked on the live database: every collection counts the
same through the default scope as raw; a second workspace sees none of it;
a real upsert through a scope gets its `_id` and its workspace. Tests: the
leak test (a second workspace cannot read, count, aggregate, update or
delete the first's), stamping, pass-through, and a guard that fails if a
route module reaches the database around `db()`.

Known limit, for when a second workspace is real: ids are still global -
two workspaces cannot both have a model called `iot-fan/station`. Phase 5
(members) has to namespace new ids per workspace or refuse a clash.

### Phase 3 - signing in (done)

`backend/auth.py`, `frontend/src/app/auth.ts`. `X3_AUTH` in `.env`: off (the
default) is local mode, exactly the app as before; on asks every API
request for a session except `/api/auth/state`, `/login`, `/setup` and
`/api/health`. Accounts are email and password, hashed with scrypt from the
standard library, salted. The first account - made while there is none,
from the sign-in card - owns the default workspace; after that a second
"first account" is refused (people are invited in phase 5). Sessions are a
random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS), 30
days; the database keeps only its SHA-256, and lookups are cached for a
minute because the database is far away. Every change must carry the
`X-Redline-CSRF` header, which only the app's page sends. Five wrong
passwords in fifteen minutes and that address waits; a wrong address takes
as long as a wrong password. Sign-ins and the first account go into the
audit trail. The page shows the sign-in card when signed out, and the
signed-in user at the far right of the top bar with *Sign out*.

No new secret: session tokens are random and stored hashed, so there is
nothing for `.env` beyond `X3_AUTH`.

Verified on a separate server with sign-in on and a throw-away database
(dropped afterwards): 401 without a session; the first account, then a
second refused; a change without the CSRF header refused and with it
accepted; a wrong password refused; sign-out ends the session; in the
browser the card, a wrong password's message, the app with the user
signed in, sign-out back to the card, and the first-account card. Local
mode on this machine unchanged.

Limit until phase 4 (now lifted): with sign-in on, the agents' API calls
had no session and were refused.

### Phase 4 - agents on the API (done)

`backend/agent_api.py`, `tools/remote_db.py`, tokens in `backend/auth.py`,
the *Agent tokens* dialog in the user menu (`frontend/src/app/auth.ts`).

- **Tokens.** A person makes one per agent: `rlat_` plus 32 random bytes,
  shown once, stored only as its SHA-256 in `agent_tokens`, with the
  agent's name, the workspace, who made it and when it was last used.
  Taking it back refuses it at once in this server (the lookup cache is
  cleared; another server process forgets it within a minute). Only a
  person can make, list or take back tokens - an agent's token cannot.
- **Requests.** `Authorization: Bearer rlat_...` on any `/api/` request
  makes the request that agent, in the token's workspace, whatever the
  sign-in mode; a wrong or taken-back token is a 401. Bearer requests
  need no CSRF header (no cookie is involved).
- **The database, through the server.** `revisions.py` with
  `X3_TRANSPORT=api` gets `RemoteDb` from `connect()` instead of Motor:
  the same calls, each one a `POST /api/agent/db` (stored files:
  `/api/agent/files/{bucket}`). The server runs it on the scoped database,
  so the workspace applies. Open to agents: the workspace's collections
  (audit read-only), the LCSC parts cache, the LLM-call log; `ping`,
  `dbstats`, `collstats`. Refused: accounts, sessions, tokens, members;
  any other command; `$lookup`, `$graphLookup`, `$unionWith`, `$out`,
  `$merge`, `$where`, `$function`, `$accumulator` anywhere in a request.
  A person's session is refused here (403): it is the agents' way in.
- **Writes stay in the workspace.** Found while testing: a document or an
  update naming another workspace used to keep it. Now `scope.py` always
  stamps the view's own workspace and strips `workspace_id` from updates
  (pipeline updates end by setting it), for routes and agents alike.
- **Both paths side by side.** Direct mode is unchanged and still the
  default. Compared line for line on the live data, direct against
  through-the-server: `queue`, `chat --keep-unread`, `models`, `source`,
  `kind`, `wait` and `show` (the same 307 203-byte picture) are identical.

Verified on a separate server with sign-in on and a throw-away database
(dropped afterwards): no token 401; a person's session 403 at the agents'
way in, also when it claims to be an agent; token made, listed, used,
taken back, then 401; unknown token 401; `users`, `agent_tokens`,
`dropDatabase` and `$lookup` into `users` refused; a token making a token
refused; a stored file put, read back byte for byte and deleted; the
command line (`queue`, `models`, `chat`) working over a token, and a plain
message without one. Two tokens in two workspaces: B counts 0 of A's
notes, cannot read, change or delete A's, and a note B names as A's lands
in B. In the browser: the user menu, *Agent tokens*, a token made and
shown once with the lines to give the agent, and taken back.

Still open, for phase 5: ids are global, so a refused duplicate id tells
workspace B that A has a document with that id; room-limited tokens (the
`room` field is stored, not yet enforced).

### Phase 5 - roles and members (done)

`backend/access.py` is the one table: five roles, eight actions.

| role | may |
|---|---|
| owner | everything, including making and unmaking owners |
| admin | members, invitations, settings, tokens, and all an editor does |
| editor | change designs, queue notes, run builds, delete, hand out agent tokens |
| reviewer | draw notes and drafts, edit them, chat, answer questions |
| viewer | look and download |

- **One check, every route.** Instead of a `require()` on each route, the
  middleware sorts every `/api/` request into an action by method and path
  (`access.action`) and asks the table once. Nothing to forget in a new
  route: a GET looks, a DELETE deletes, any other method changes the
  design, until it is listed otherwise. Queueing is `PATCH
  /api/revisions/{id}?status=queued`, so the status asked for decides:
  back to draft is drawing, anything else is running. Local mode is the
  owner, so nothing changed on this machine.
- **Refusals say why**: 403 with "as reviewer you cannot queue notes and
  run builds - ask someone who is editor or above"; the page shows it at
  the top, and the 3D room's note buttons the role cannot use are pale
  with that reason on hover.
- **Members** (user menu, owners and admins): the people and their roles,
  pending invitations. Nobody gives a role above their own; only an owner
  makes or changes an owner; the last owner stays one; you cannot take
  yourself out. Taking someone out ends their sessions at once in this
  server (others within a minute), and they can no longer sign in.
- **Invitations**: an address and a role give a link, shown once, good for
  a week, one per address; Redline sends no email. The link opens a card
  saying who invited you, to what, as which role; a new address chooses a
  name and password, an existing account signs in with its password. The
  link works once. Owners are not invited - they are made from the list.
- **Agent tokens carry a role** too: editor (the default, and the most), reviewer or
  viewer, never above the person making it. The agents' database way in
  checks each operation against it: a reviewer's token reads, and writes
  nothing. Tokens from phase 4 are editors.
- **Tests**: `tests/test_access.py` builds the matrix from the app's own
  route list (113 routes x 5 roles) - every route is a known action and
  each role may do exactly its actions - plus the promises: a viewer only
  looks, a reviewer draws but does not queue, build or delete, an editor
  works but does not manage, signed out reaches only signing in.

Verified on a separate server with sign-in on and a throw-away database
(dropped afterwards): the owner invited an admin, an editor, a reviewer
and a viewer, each joined through their link (a second use refused). The
reviewer made a note, was refused queueing and deleting it, chatted, was
refused members and tokens; the viewer read and was refused a note and a
build; the editor queued the reviewer's note and was refused settings and
invitations; the admin was refused changing the owner or inviting an
owner, and made the editor a reviewer, whose next queue was refused. The
owner could not demote themselves as the last owner; took the reviewer
out, whose session ended and whose sign-in was then refused. A reviewer
token read and was refused a write and a queue; an admin token was
refused. In the browser: the owner's menu with Members and Agent tokens,
an invitation made and its link shown, the members with their roles; the
link's card ("Olive Owner invited you to Redline as reviewer ..."), joining,
the link gone from the address bar, the newcomer's menu without Members
or tokens, and the note's queue, archive and delete buttons disabled with
their reasons. Not seen in the browser: the refusal banner (the buttons
that would trigger it are disabled; it is covered by the API checks).

Still open: room-limited tokens.

### Phase 6 - separate workspaces and container limits (done)

Decided 2026-09-24: separate workspaces are needed (e.g. one per
customer); limits only on the build containers, no spending limits; the
machine is reached from the office network only; sign-in on.

- **Container limits** (`backend/limits.py`): every container the coding
  rooms and the PCB room start gets `--cpus`, `--memory`, `--pids-limit` -
  by default half the cores, 40 % of the memory up to 12g, 4096 processes
  (`X3_BOX_*` in `.env`). Seen inside one: 14 cores, 12 GB, 4096.
- **Same names in two workspaces** (`scope.Ids`): the default workspace's
  documents keep their names exactly; another workspace's text names are
  stored with its suffix (`controller@customer-a`), added and removed in
  the scope layer, so no route, room or agent sees it. Exact names, `$in`
  / `$nin` lists and `$match` stages are translated; nothing in the code
  filters names by pattern.
- **Workspaces** (user menu): the ones you are in, with your role in
  each; opening one moves this browser's session there and reloads the
  page. *New workspace* (owners and admins) makes an empty one you own;
  invitations and agent tokens belong to the workspace you are in.
- **Analytics** is per workspace: its cache is keyed by it, and a
  workspace other than the default one counts only the LLM calls made
  during its own runs (calls with no run open are the default one's).
  Machine figures (CPU, power, the database's size) are the machine's and
  show in every workspace.

Verified on a separate server with sign-in on and a throw-away database
(dropped afterwards): a board `controller` in the default workspace and
another in *Customer A*, each workspace reading its own under the same
name (stored as `controller` and `controller@customer-a`); notes apart; a
reviewer invited to *Customer A* sees only its note and is refused opening
the default workspace; each workspace's agent token lists only its own
queued note, and cannot open the other's; switching in the browser.

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
