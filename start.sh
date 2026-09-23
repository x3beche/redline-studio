#!/usr/bin/env bash
# Redline - development servers (Linux)
#
#   ./start.sh          Angular + FastAPI, both with live reload
#   ./start.sh --build  Compile the UI and serve it from a single port (8000)
#
# On first run it creates the Python virtual environment and installs npm deps.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

VENV="$HERE/.venv"
PY="$VENV/bin/python"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-4200}"

say() { printf '\033[1;36m> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node not found (>=20.19 required)"
command -v python3 >/dev/null || die "python3 not found (>=3.10 required)"

# --- Python environment ---
if [ ! -x "$PY" ]; then
  say "creating virtual environment"
  python3 -m venv "$VENV"
  "$PY" -m pip install --quiet --upgrade pip
fi
if ! "$PY" -c "import fastapi, motor, build123d" >/dev/null 2>&1; then
  say "installing python dependencies (build123d included, may take minutes)"
  "$PY" -m pip install --quiet -r requirements.txt
fi

# --- Node environment ---
[ -d frontend/node_modules ] || { say "installing npm dependencies"; (cd frontend && npm install); }

# Model data comes from the database; nothing is written to disk.

# --- Stop anything already listening ---
for port in "$API_PORT" "$WEB_PORT"; do
  pid="$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  [ -n "$pid" ] && { kill "$pid" 2>/dev/null || true; say "freed port $port ($pid)"; }
done
sleep 1

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ "${1:-}" = "--build" ]; then
  say "building the UI"
  (cd frontend && npx ng build)
  say "http://127.0.0.1:$API_PORT"
  exec "$PY" -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT"
fi

say "FastAPI  http://127.0.0.1:$API_PORT  (--reload)"
"$PY" -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT" --reload \
      --reload-dir backend &

say "Angular  http://127.0.0.1:$WEB_PORT  (hot reload)"
(cd frontend && npx ng serve --port "$WEB_PORT" --host 127.0.0.1)
