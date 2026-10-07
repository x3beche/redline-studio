# Accounts and sign-in: how to run them, and how to get back in

What to do on the machine that runs Redline when sign-in is on
(`REDLINE_REQUIRE_SIGNIN=true` in `.env`). Nothing private belongs in this file - no
addresses, passwords, links or tokens; the repository is public.

## Forgot the password, or the address

Passwords are kept only as a salted hash (scrypt): nobody can read one
back, not even from the database. Make a new one instead - from the
machine itself, since it needs the database:

```bash
.venv/bin/python tools/account.py list             # every account: address, name, role
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

- The first account, made on the first visit, is the **owner**. There is
  one owner; it cannot be demoted, disabled or deleted.
- There is no sign-up. The owner and the **admin**s add accounts: your name
  (top right) > **Admin panel** > **Add user** - a name, an address and a
  first password, which the person changes when they first sign in.
  Redline sends no email: you pass the password on.
- Roles (`backend/access.py`): owner, admin, user. Admins run the server's
  settings (LLM keys, proxy, Telegram bot, costs) and the users' accounts -
  edit, disable, reset a password, sign out everywhere. Only the owner
  changes roles and deletes accounts. Users see the server's settings
  read-only.
- Every account works in a private space of its own: the owner's holds the
  data from before accounts; anyone else starts empty and nobody else sees
  into it. Agent tokens belong to the account that made them, work in its
  space, and stop when it is disabled.

## The agents

The agents on the machine share one token, `REDLINE_TOKEN` in `.env`, made for
them when sign-in was switched on (named "local agents", role editor).
`tools/revisions.py` and the MCP server read it from `.env`; `REDLINE_AGENT`
still names each agent. To replace it: your name > **Agent tokens** > make
a new one, put it in `.env` as `REDLINE_TOKEN=...`, then **Take back** the old
one. A command that says it "wants an agent token" means this line is
missing or the token was taken back.

## The office network

- `REDLINE_WEB_HOST=0.0.0.0` in `.env`, then `./start.sh`: the page (port 4200)
  opens to the network; the API (8000) stays on the machine behind it.
- Make the owner's account before opening it - otherwise whoever visits
  first becomes the owner.
- The firewall must let the office in, on the machine:
  `sudo ufw allow from <office subnet, e.g. 10.40.30.0/24> to any port 4200 proto tcp`

## Turning sign-in off again

`REDLINE_REQUIRE_SIGNIN=false` in `.env` and restart (`./start.sh`): local mode, no
sign-in, everything done as the local user - the accounts stay in the
database for when it is switched back on.
