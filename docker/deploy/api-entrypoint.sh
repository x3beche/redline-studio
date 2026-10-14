#!/usr/bin/env bash
# The deployed API's start (docker/deploy/api.Dockerfile, docker-compose.yml).
#
# Runs as root only long enough to:
#   1. lay out REDLINE_HOST_DIR, the host directory mounted at the same path
#      in here - app/ (the code, and its .cache), tmp/ (TMPDIR), secrets/;
#   2. copy the image's code into app/, so the paths the API hands its work
#      containers (KiCad, drawings, PlatformIO) exist on the host too;
#   3. join the group that owns the Docker socket, whatever its id is here;
# then becomes the app user (uid 1000, the work images' too) and serves.
set -euo pipefail

H="${REDLINE_HOST_DIR:?REDLINE_HOST_DIR must be the host directory mounted at the same path}"
case "$H" in /*) ;; *) echo "REDLINE_HOST_DIR must be an absolute path: $H" >&2; exit 1 ;; esac
[ -d "$H" ] || { echo "REDLINE_HOST_DIR ($H) is not mounted - see docker-compose.yml" >&2; exit 1; }
APP="$H/app"
UID_="$(id -u app)"
GID_="$(id -g app)"

as_app() { setpriv --reuid="$UID_" --regid="$GID_" --init-groups -- "$@"; }

mkdir -p "$APP" "$APP/.cache" "$H/tmp" "$H/secrets"
chown "$UID_:$GID_" "$H" "$APP" "$APP/.cache" "$H/tmp" "$H/secrets"
chmod 700 "$H/secrets"

# The code, again on every start: what the image brings replaces what an
# older image left. .cache and the rest of the host directory stay.
for entry in /opt/workbench/* /opt/workbench/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  rm -rf "${APP:?}/$name"
  as_app cp -r "$entry" "$APP/$name"
done

# Scratch older than a day is what a stopped container left behind.
find "$H/tmp" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

export TMPDIR="$H/tmp"
export HOME=/home/app
# The key the secrets typed in Settings are encrypted with: REDLINE_SECRET_KEY,
# or else a file made once in the host directory - back it up with the data.
export REDLINE_SECRET_KEY_FILE="${REDLINE_SECRET_KEY_FILE:-$H/secrets/secret.key}"

groups="$GID_"
if [ -S /var/run/docker.sock ]; then
  groups="$groups,$(stat -c %g /var/run/docker.sock)"
else
  echo "> no Docker socket: drawings, KiCad, firmware and the tools' checks will say they cannot run"
fi

cd "$APP"
if [ -n "${REDLINE_OWNER_EMAIL:-}" ]; then
  as_app python /opt/workbench/docker/deploy/bootstrap_owner.py || true
fi

echo "> Workbench API on :${API_PORT:-8000} (code in $APP, scratch in $TMPDIR)"
exec setpriv --reuid="$UID_" --regid="$GID_" --groups="$groups" -- \
  python -m uvicorn backend.main:app --host 0.0.0.0 --port "${API_PORT:-8000}" \
    --proxy-headers --forwarded-allow-ips='*' --timeout-graceful-shutdown 10 \
    --log-level "${REDLINE_LOG_LEVEL:-info}"
