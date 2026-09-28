#!/usr/bin/env bash
# UI container entrypoint: `npm ci` when package-lock.json changed since the
# last start, then the Angular dev server with hot reload.
set -euo pipefail
cd "$APP/frontend"

want="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ "$(cat node_modules/.lock-hash 2>/dev/null)" != "$want" ]; then
  echo "> installing npm packages"
  npm ci --no-audit --no-fund --loglevel=error
  echo "$want" > node_modules/.lock-hash
fi

echo "> Angular  http://${WEB_HOST}:${WEB_PORT}  (hot reload)"
exec npx ng serve --port "$WEB_PORT" --host "$WEB_HOST"
