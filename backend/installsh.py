"""The one line that installs an agent, served by the server itself.

    GET /api/public/install.sh      the installer, this server's address in it

The seed repository (github x3beche/redline-agent-seed) holds start.sh, which
is the real work: it fetches the kit, checks the runners, keeps the token,
starts the agent in tmux, installs the service. This is the thin thing in
front of it - fetch or update the seed, hand it the token - so a person types
one short line and not the long one:

    curl -fsSL https://<server>/api/public/install.sh | bash -s -- --token rlat_...

Serving it here rather than from the repository is what lets the server's own
address be already in it: whoever downloaded the script from a server installs
against that server, and `--api` is only needed to point somewhere else.

The public routes live under auth.OPEN_PREFIX `/api/public/` (access "none",
like shared links and the Android build) because the site's proxies pass only
/api on to the API - a top-level /setup.sh cannot reach it. Rate-limited per
address like the build's description.

The seed is the same one `GET /api/agent/status` names and the kit is fetched
from (backend/agent_kit.py SEED_URL), so a server that points its agents at
another repository serves that one here too.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from . import agent_kit, ratelimit, shares

router = APIRouter()

PUBLIC = {**shares.PUBLIC, "Cache-Control": "no-cache"}
# Per address: a few kB and a rare request, but it must not be a free amplifier.
SH_HITS = ratelimit.Window("install-sh", 60, 60)

SCRIPT = r'''#!/usr/bin/env bash
# Workbench agent installer.
#
#   curl -fsSL __API__/api/public/install.sh | bash -s -- --token rlat_...
#
# It fetches the seed (__SEED__) into a folder of its own, keeps it up to date
# when it is run again, and hands everything to the seed's start.sh: the
# settings, the runner, the tmux session, the service.
#
# The token is a secret and the line carries it: it is also in your shell's
# history. On a shared computer leave --token out - it is then asked for and
# not shown - and revoke the token under Settings > Agent tokens when this
# computer goes away.
set -eu

API="__API__"
SEED="__SEED__"
DIR="${HOME}/redline-agent-seed"
TOKEN=""
ARGS=()

usage() {
  cat <<'USAGE'
Workbench agent installer, run through:
  curl -fsSL <server>/api/public/install.sh | bash -s -- --token rlat_...

  --token rlat_...      the agent token (Settings > Agent tokens); asked for
                        when it is left out, and not shown then
  --dir <folder>        where the seed goes (default ~/redline-agent-seed)
  --api <address>       the server, when not the one this script came from
  --runner claude|opencode, --model provider/model, --name <agent name>,
  --session <tmux session>, --headless, --service, --dry-run
                        handed to the seed's start.sh as they are
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) [ $# -ge 2 ] || { echo "install.sh: --token needs the token" >&2; exit 1; }; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --dir) [ $# -ge 2 ] || { echo "install.sh: --dir needs a folder" >&2; exit 1; }; DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --api) [ $# -ge 2 ] || { echo "install.sh: --api needs the address" >&2; exit 1; }; API="$2"; shift 2 ;;
    --api=*) API="${1#*=}"; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

[ -n "$API" ] || { echo "install.sh: no server address - pass --api https://your-server" >&2; exit 1; }

if [ -z "$TOKEN" ]; then
  # `curl | bash` makes stdin the script itself, so the token is asked for on
  # the terminal - and when there is none, said so instead of dying on the
  # redirect (and never read a line of the script as a token).
  if { true >/dev/tty; } 2>/dev/null; then
    printf 'Agent token (rlat_..., from Settings > Agent tokens; not shown): ' >/dev/tty
    read -r -s TOKEN </dev/tty
    printf '\n' >/dev/tty
  else
    echo "install.sh: no token - pass --token rlat_... (make one in Settings > Agent tokens)" >&2
    exit 1
  fi
fi
case "$TOKEN" in
  rlat_*) ;;
  *) echo "install.sh: an agent token starts with rlat_ - make one in Workbench under Settings > Agent tokens" >&2; exit 1 ;;
esac

command -v git >/dev/null 2>&1 || { echo "install.sh: git is needed (apt install git, or brew install git)" >&2; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "updating $DIR"
  git -C "$DIR" pull --ff-only --quiet \
    || { echo "install.sh: could not update $DIR - move it aside and run this again" >&2; exit 1; }
else
  if [ -e "$DIR" ]; then
    echo "install.sh: $DIR is in the way - pass --dir for another folder" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DIR")"
  echo "fetching the seed into $DIR"
  git clone --quiet "$SEED" "$DIR" || { echo "install.sh: could not clone $SEED" >&2; exit 1; }
fi

cd "$DIR"
# start.sh reads the settings, checks the runners and starts the agent in tmux;
# the options the person gave go through untouched (it refuses an unknown one).
exec ./start.sh --api "$API" --token "$TOKEN" ${ARGS[@]+"${ARGS[@]}"}
'''


def base(request: Request) -> str:
    """The address this reply came in on, so the line needs no --api.

    Behind the site's proxy the public host is in X-Forwarded-Host; a direct
    call (127.0.0.1:8000) has it in Host. The proxy speaks https to the person
    even when it speaks http to us, so a forwarded host means https unless the
    proxy says otherwise."""
    forwarded = request.headers.get("x-forwarded-host")
    host = (forwarded or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        return ""
    proto = request.headers.get("x-forwarded-proto")
    if not proto:
        proto = "https" if forwarded else request.url.scheme
    return f"{proto.split(',')[0].strip() or 'https'}://{host}".rstrip("/")


async def _limit(window: ratelimit.Window, request: Request) -> None:
    ok, wait = await window.hit(shares._db(), shares.client(request))
    if not ok:
        raise HTTPException(429, "too many requests - wait a minute",
                            headers={**PUBLIC, "Retry-After": str(wait)})


@router.get("/api/public/install.sh")
async def install_sh(request: Request):
    """The installer, with this server's address already in it."""
    await _limit(SH_HITS, request)
    text = SCRIPT.replace("__API__", base(request)).replace("__SEED__", agent_kit.SEED_URL)
    return PlainTextResponse(text, media_type="text/x-shellscript; charset=utf-8", headers=PUBLIC)
