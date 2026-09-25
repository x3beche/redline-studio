# Accounts and sign-in: how to run them, and how to get back in

What to do on the machine that runs Redline when sign-in is on
(`X3_AUTH=on` in `.env`). Nothing private belongs in this file - no
addresses, passwords, links or tokens; the repository is public.

## Forgot the password, or the address

Passwords are kept only as a salted hash (scrypt): nobody can read one
back, not even from the database. Make a new one instead - from the
machine itself, since it needs the database:

```bash
.venv/bin/python tools/account.py list             # every account: address, name, role in each workspace
.venv/bin/python tools/account.py reset <email>    # prints a link
```

Open the printed link (`http://127.0.0.1:4200/?reset=...`) on the machine
within an hour and choose the new password there. The link works once;
making another cancels the last. Setting the password signs you in and
ends every other session of that account. To send the link to someone on
the office network, give the page's address: `--base http://<machine's
address>:4200`.

`list` also answers "which address did I sign up with?".

## Who is in, and what they may do

- The first account, made on the first visit, owns the workspace.
- Everyone else is invited: your name (top right) > **Members** > an email
  address and a role. You get a link, good for a week and one use - Redline
  sends no email, you pass it on.
- Roles: owner, admin, editor, reviewer, viewer (`backend/access.py`,
  `docs/USERS-PLAN.md` phase 5). The last owner cannot be demoted; make
  someone else owner first.
- Separate workspaces (e.g. one per customer): your name > **New
  workspace**. Invitations and agent tokens belong to the workspace you
  are in.

## The agents

The agents on the machine share one token, `X3_TOKEN` in `.env`, made for
them when sign-in was switched on (named "local agents", role editor).
`tools/revisions.py` and the MCP server read it from `.env`; `X3_AGENT`
still names each agent. To replace it: your name > **Agent tokens** > make
a new one, put it in `.env` as `X3_TOKEN=...`, then **Take back** the old
one. A command that says it "wants an agent token" means this line is
missing or the token was taken back.

## The office network

- `X3_WEB_HOST=0.0.0.0` in `.env`, then `./start.sh`: the page (port 4200)
  opens to the network; the API (8000) stays on the machine behind it.
- Make the owner's account before opening it - otherwise whoever visits
  first becomes the owner.
- The firewall must let the office in, on the machine:
  `sudo ufw allow from <office subnet, e.g. 10.40.30.0/24> to any port 4200 proto tcp`

## Turning sign-in off again

`X3_AUTH=off` in `.env` and restart (`./start.sh`): local mode, no
sign-in, everything done as the local user - the accounts stay in the
database for when it is switched back on.
