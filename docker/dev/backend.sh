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
# A reload waits for open connections to close - an open SSE stream never
# does, and while it waits nothing answers on the port. start.sh has had
# the limit; the container had not, and hung on "Waiting for connections to
# close". The long board steps are jobs of their own (backend/jobs.py), so
# cutting a request short loses no work.
#
# Not exec'd: this shell stays PID 1 and reaps. Builds and board jobs run in
# processes of their own (backend/jobs.py, backend/buildjobs.py) that outlive
# the reload that started them, so they end as children of PID 1 - and
# uvicorn's reloader, when it was PID 1, never waited for them: every one
# stayed a zombie until the container restarted. bash reaps whatever it is
# handed, and passes a stop on to uvicorn.
/venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port "$API_PORT" \
     --reload --reload-dir backend --timeout-graceful-shutdown 3 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

# The watchdog. uvicorn's reloader only starts a new worker when a file
# changes: a worker that dies on its own (it happened: no traceback, the
# port just stopped answering) leaves the reloader waiting and the API
# silent until someone restarts the container. Three failed health checks
# in a row, once it has had time to start, stop uvicorn - this script then
# exits and Docker's restart policy (unless-stopped) brings it back.
(
  sleep 120
  misses=0
  while kill -0 "$pid" 2>/dev/null; do
    if curl -fsS -m 10 -o /dev/null "http://127.0.0.1:${API_PORT}/api/health"; then
      misses=0
    else
      misses=$((misses + 1))
      echo "> watchdog: /api/health did not answer ($misses/3)"
      if [ "$misses" -ge 3 ]; then
        echo "> watchdog: the API is not answering - stopping uvicorn so the container restarts"
        kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null
        break
      fi
    fi
    sleep 20
  done
) &
rc=0
while kill -0 "$pid" 2>/dev/null; do
  if wait "$pid"; then rc=0; else rc=$?; fi
done
# Whatever ended uvicorn - a stop, a crash, the watchdog - the container
# goes with it, so the restart policy can bring the API back.
[ "$rc" = 0 ] && rc=1
exit "$rc"
