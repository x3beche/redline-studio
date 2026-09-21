#!/usr/bin/env bash
# X3 Studios Asset Manager - gelistirme sunucusu (Linux)
#
#   ./start.sh          Angular + FastAPI, ikisi de canli yeniden yukleme ile
#   ./start.sh --build  Modeli yeniden uretip tek sunucuda (8000) yayinlar
#
# Ilk calistirmada Python sanal ortamini ve npm bagimliliklarini kurar.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

VENV="$HERE/.venv"
PY="$VENV/bin/python"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-4200}"

say() { printf '\033[1;36m> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mhata: %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node bulunamadi (>=20.19 gerekir)"
command -v python3 >/dev/null || die "python3 bulunamadi (>=3.10 gerekir)"

# --- Python ortami ---
if [ ! -x "$PY" ]; then
  say "sanal ortam kuruluyor"
  python3 -m venv "$VENV"
  "$PY" -m pip install --quiet --upgrade pip
fi
if ! "$PY" -c "import fastapi, motor, build123d" >/dev/null 2>&1; then
  say "python bagimliliklari kuruluyor (build123d dahil, birkac dakika surebilir)"
  "$PY" -m pip install --quiet -r requirements.txt
fi

# --- Node ortami ---
[ -d frontend/node_modules ] || { say "npm bagimliliklari kuruluyor"; (cd frontend && npm install); }

# Model verisi veritabanindan gelir; diske bir sey yazilmaz.

# --- Calisan sunuculari kapat ---
for port in "$API_PORT" "$WEB_PORT"; do
  pid="$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  [ -n "$pid" ] && { kill "$pid" 2>/dev/null || true; say "port $port bosaltildi ($pid)"; }
done
sleep 1

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ "${1:-}" = "--build" ]; then
  say "arayuz derleniyor"
  (cd frontend && npx ng build)
  say "http://127.0.0.1:$API_PORT"
  exec "$PY" -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT"
fi

say "FastAPI  http://127.0.0.1:$API_PORT  (--reload)"
"$PY" -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT" --reload \
      --reload-dir backend &

say "Angular  http://127.0.0.1:$WEB_PORT  (hot reload)"
(cd frontend && npx ng serve --port "$WEB_PORT" --host 127.0.0.1)
