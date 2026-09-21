#!/usr/bin/env bash
# Run a command under a hard memory ceiling.
#
# A build that imports a large STEP and booleans against it can grow without
# bound. Left alone it pushes the machine into swap and the desktop freezes -
# the process has to be killed by hand. With a ceiling and swap disabled the
# kernel kills the build instead, immediately, and the machine stays usable.
#
#   tools/capped.sh .venv/bin/python models/thing.py
#   X3_BUILD_MEM=12G tools/capped.sh ...      # raise it for one run
set -euo pipefail

LIMIT="${X3_BUILD_MEM:-6G}"

if command -v systemd-run >/dev/null 2>&1 &&
   systemd-run --user --scope -q -p MemoryMax="$LIMIT" true >/dev/null 2>&1; then
    # MemorySwapMax=0: hitting the ceiling is an instant kill, not a swap storm.
    exec systemd-run --user --scope -q --collect \
        -p MemoryMax="$LIMIT" -p MemorySwapMax=0 -- "$@"
fi

# No systemd user scope: fall back to an address-space limit. Coarser, and it
# counts reserved rather than resident memory, so give it more room.
kb=$(( ${LIMIT%G} * 2 * 1024 * 1024 ))
ulimit -v "$kb"
exec "$@"
