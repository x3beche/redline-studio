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
rc=0
while kill -0 "$pid" 2>/dev/null; do
  if wait "$pid"; then rc=0; else rc=$?; fi
done
exit "$rc"
