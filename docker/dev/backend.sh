#!/usr/bin/env bash
# API container entrypoint: install Python packages when requirements.txt
# changed since the last start, then serve with live reload.
set -euo pipefail
cd "$APP"

if [ ! -x /venv/bin/python ]; then
  python -m venv /venv
  /venv/bin/python -m pip install --quiet --upgrade pip
fi
want="$(sha256sum requirements.txt | cut -d' ' -f1)"
if [ "$(cat /venv/.requirements 2>/dev/null)" != "$want" ]; then
  echo "> installing python packages (build123d included, the first time takes minutes)"
  /venv/bin/python -m pip install --quiet -r requirements.txt
  echo "$want" > /venv/.requirements
fi

echo "> FastAPI  http://127.0.0.1:${API_PORT}  (--reload)"
exec /venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT" \
     --reload --reload-dir backend
