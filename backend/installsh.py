"""The one line that installs an agent, served by the server itself.

    GET /api/public/install.sh      the installer, this server's address in it

The seed repository (github x3beche/redline-agent-seed) holds start.sh, which
is the real work: it fetches the kit, checks the runners, keeps the token,
starts the agent in tmux, installs the service. This is the thin thing in
front of it - fetch or update the seed, ask the few things that can only be
answered on the person's own computer, hand it over - so a person types one
short line and not the long one:

    curl -fsSL https://<server>/api/public/install.sh | bash -s -- --token rlat_...

Everything else is asked here, on the terminal, because this is the one place
that runs on their computer: which runner (Claude Code or OpenCode, whichever
is installed), which model (listed from their own `opencode models`, since
OpenCode's providers and sign-ins are theirs and the server knows nothing of
them), the tmux session's name, and whether it should start after a reboot.
Answers go to start.sh as its own flags, which keep them in config.yaml, so
they are asked once. A run with no terminal - a pipe with the answers given,
or a script - is not asked anything, and `--setup` asks again on purpose.

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
# when it is run again, and hands everything to the seed's start.sh. The first
# time - and with --setup - it asks what only this computer can answer: which
# runner, which model, the tmux session's name, and whether the agent should
# start by itself after a reboot.
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
RUNNER=""
MODEL=""
SESSION=""
SERVICE=0
DRY=0
SETUP=0
ARGS=()

die() { echo "install.sh: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Workbench agent installer, run through:
  curl -fsSL <server>/api/public/install.sh | bash -s -- --token rlat_...

  --token rlat_...      the agent token (Settings > Agent tokens); asked for
                        when it is left out, and not shown then
  --dir <folder>        where the seed goes (default ~/redline-agent-seed)
  --api <address>       the server, when not the one this script came from
  --setup               ask the settings again (runner, model, session,
                        service), even when they were chosen before
  --runner claude|opencode, --model provider/model, --name <agent name>,
  --session <tmux session>, --headless, --service, --dry-run
                        answered already: handed to the seed's start.sh, which
                        keeps them in config.yaml
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token) [ $# -ge 2 ] || die "--token needs the token"; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a folder"; DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --api) [ $# -ge 2 ] || die "--api needs the address"; API="$2"; shift 2 ;;
    --api=*) API="${1#*=}"; shift ;;
    --runner) [ $# -ge 2 ] || die "--runner needs claude or opencode"; RUNNER="$2"; ARGS+=(--runner "$2"); shift 2 ;;
    --runner=*) RUNNER="${1#*=}"; ARGS+=("$1"); shift ;;
    --model) [ $# -ge 2 ] || die "--model needs provider/model"; MODEL="$2"; ARGS+=(--model "$2"); shift 2 ;;
    --model=*) MODEL="${1#*=}"; ARGS+=("$1"); shift ;;
    --session) [ $# -ge 2 ] || die "--session needs a name"; SESSION="$2"; ARGS+=(--session "$2"); shift 2 ;;
    --session=*) SESSION="${1#*=}"; ARGS+=("$1"); shift ;;
    --service) SERVICE=1; ARGS+=(--service); shift ;;
    --headless) ARGS+=(--headless); shift ;;
    --dry-run) DRY=1; ARGS+=(--dry-run); shift ;;
    --setup|--ask) SETUP=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    --*) ARGS+=("$1"); shift ;;          # start.sh knows its own and refuses the rest
    *) die "unknown argument: $1 (--help)" ;;
  esac
done

[ -n "$API" ] || die "no server address - pass --api https://your-server"

# `curl | bash` makes stdin the script itself: every question is asked on the
# terminal, and a pipe with nothing to ask reads none of it.
if [ -z "$TOKEN" ]; then
  if { true >/dev/tty; } 2>/dev/null; then
    printf 'Agent token (rlat_..., from Settings > Agent tokens; not shown): ' >/dev/tty
    read -r -s TOKEN </dev/tty
    printf '\n' >/dev/tty
  else
    die "no token - pass --token rlat_... (make one in Settings > Agent tokens)"
  fi
fi
case "$TOKEN" in
  rlat_*) ;;
  *) die "an agent token starts with rlat_ - make one in Workbench under Settings > Agent tokens" ;;
esac

command -v git >/dev/null 2>&1 || die "git is needed (apt install git, or brew install git)"

if [ -d "$DIR/.git" ]; then
  echo "updating $DIR"
  git -C "$DIR" pull --ff-only --quiet \
    || die "could not update $DIR - move it aside and run this again"
else
  [ -e "$DIR" ] && die "$DIR is in the way - pass --dir for another folder"
  mkdir -p "$(dirname "$DIR")"
  echo "fetching the seed into $DIR"
  git clone --quiet "$SEED" "$DIR" || die "could not clone $SEED"
fi

have_tty=0
if { true >/dev/tty; } 2>/dev/null; then have_tty=1; fi

# What the person answers here, on their own computer: the runner that is
# installed there, the models their own OpenCode is signed in to, the session
# name, and whether it should come back after a reboot. Once - the answers are
# kept in config.yaml - and again with --setup.
if [ "$have_tty" = 1 ] && [ "$DRY" = 0 ] && { [ "$SETUP" = 1 ] || [ ! -f "$DIR/config.yaml" ]; }; then
  say() { printf '%s\n' "$*" >/dev/tty; }
  ask() {  # ask <prompt> <default> -> REPLY
    printf '%s' "$1" >/dev/tty
    IFS= read -r REPLY </dev/tty || REPLY=""
    [ -n "$REPLY" ] || REPLY="$2"
  }
  have_claude=0; command -v claude >/dev/null 2>&1 && have_claude=1
  have_oc=0
  if command -v opencode >/dev/null 2>&1 || [ -x "$HOME/.opencode/bin/opencode" ]; then have_oc=1; fi

  if [ -z "$RUNNER" ]; then
    if [ "$have_claude" = 0 ] && [ "$have_oc" = 0 ]; then
      say "Neither Claude Code nor OpenCode is installed on this computer."
      say "Install one (https://opencode.ai/docs/ or the Claude Code docs) and run this line again."
      exit 1
    fi
    default=1
    [ "$have_claude" = 0 ] && default=2
    say ""
    say "Which runner should the agent use?"
    say "  1) Claude Code$([ "$have_claude" = 1 ] && echo "  (installed)" || echo "  (not installed)")"
    say "  2) OpenCode$([ "$have_oc" = 1 ] && echo "  (installed)" || echo "  (not installed)")"
    ask "1 or 2 [$default]: " "$default"
    case "$REPLY" in
      2|o|O|opencode|OpenCode) RUNNER=opencode ;;
      *) RUNNER=claude ;;
    esac
  fi
  ARGS+=(--runner "$RUNNER")

  if [ "$RUNNER" = opencode ] && [ -z "$MODEL" ]; then
    OC="$(command -v opencode 2>/dev/null || true)"
    [ -n "$OC" ] || OC="$HOME/.opencode/bin/opencode"
    models=""
    [ -x "$OC" ] && models="$("$OC" models 2>/dev/null | head -60 || true)"
    say ""
    if [ -z "$models" ]; then
      say "OpenCode has no model to use yet: run 'opencode auth login' first, then this line again."
      say "The red marks on notes are pictures, so pick a model that reads images."
    else
      say "Which model? It has to read images - the red marks on notes are pictures."
      i=0
      printf '%s\n' "$models" | while IFS= read -r m; do i=$((i + 1)); printf '  %2d) %s\n' "$i" "$m" >/dev/tty; done
      ask "number, or Enter for OpenCode's own default: " ""
      case "$REPLY" in
        ''|*[!0-9]*) ;;
        *) n=0
           while IFS= read -r m; do
             n=$((n + 1))
             [ "$n" = "$REPLY" ] && { MODEL="$m"; break; }
           done <<EOF
$models
EOF
           ;;
      esac
      [ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
    fi
  fi

  if [ -z "$SESSION" ]; then
    ask "tmux session name [redline-agent]: " "redline-agent"
    [ "$REPLY" = "redline-agent" ] || ARGS+=(--session "$REPLY")
  fi

  if [ "$SERVICE" = 0 ]; then
    ask "Start it by itself after every reboot? [y/N]: " "N"
    case "$REPLY" in y|Y|yes|Yes) ARGS+=(--service) ;; esac
  fi
  say ""
fi

cd "$DIR"
# start.sh reads the settings, checks the runners and starts the agent in tmux;
# the answers above and the options the person gave go through as its own flags.
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
