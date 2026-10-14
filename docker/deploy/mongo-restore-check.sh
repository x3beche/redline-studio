#!/usr/bin/env bash
# Restore check for the nightly MongoDB backups (the "mongodb" stack's
# mongo-backup service writes ~/backups/mongodb/redline-*.archive.gz).
#
# Takes the newest archive, restores it into a throwaway mongod and checks
# that the copy is usable:
#   - mongorestore exits 0
#   - the key collections are there, and their counts are within the
#     tolerance of the live database's (read-only count queries on live)
#   - a sample document of each key collection reads back, a GridFS chunk too
#   - the encrypted settings are still "enc1:" tokens (as many as on live)
# One result line goes to backup.log, and metrics/restore_check.prom is
# written for node-exporter's textfile collector (Prometheus/Grafana).
#
# Two ways to run it:
#   inside a mongo:7.0 container that has /backups and MONGO_USER/MONGO_PASS
#   (the mongo-backup service runs it weekly, see mongo-backup.stack.yml):
#       bash /restore-check.sh
#   on the host, by hand: it starts a throwaway container for itself
#   (mongo-restore-check-<time>, removed afterwards), with the credentials
#   taken from the running mongo-backup container:
#       docker/deploy/mongo-restore-check.sh --docker
#
# The throwaway mongod listens on 127.0.0.1 inside its container only (no
# port is published, nothing else can reach it); its data directory is a
# temporary folder under /backups/.restore-check (disk, not RAM), deleted
# when the check ends, whatever the result.

set -u

if [ "${1:-}" = "--docker" ]; then
    here=$(cd "$(dirname "$0")" && pwd)
    backups=${BACKUP_HOST_DIR:-$HOME/backups/mongodb}
    name="mongo-restore-check-$(date +%Y%m%d-%H%M%S)"
    # The credentials go from the backup container's environment straight
    # into this one's; they are never written to a file or printed.
    exec docker run --rm --name "$name" --network mongodb_default \
        --memory 2g -e TZ=Europe/Istanbul \
        -v "$backups:/backups" -v "$here/mongo-restore-check.sh:/restore-check.sh:ro" \
        --env-file <(docker exec mongo-backup env | grep -E '^MONGO_(USER|PASS)=') \
        mongo:7.0 bash /restore-check.sh
fi

BACKUPS=${BACKUPS:-/backups}
DB=${RESTORE_CHECK_DB:-assets_3d}
LIVE=${RESTORE_CHECK_LIVE:-mongo:27017}
TOL_PCT=${RESTORE_CHECK_TOL_PCT:-25}   # key collection count may differ from live by this much
TOL_ABS=${RESTORE_CHECK_TOL_ABS:-25}   # ... or by this many documents, whichever is larger
PORT=27099
METRICS=$BACKUPS/metrics
LOG=$BACKUPS/backup.log
started=$(date +%s)

archive=$(ls -t "$BACKUPS"/redline-*.archive.gz 2>/dev/null | head -1)
mkdir -p "$BACKUPS/.restore-check" "$METRICS"
work=$(mktemp -d "$BACKUPS/.restore-check/rc.XXXXXX")

cleanup() {
    mongod --dbpath "$work/db" --shutdown >/dev/null 2>&1
    rm -rf "$work"
}
trap cleanup EXIT

# The last successful check's time stays in the metrics file across a failure.
last_ok=$(sed -n 's/^redline_restore_check_last_success_timestamp_seconds \([0-9]*\)$/\1/p' \
    "$METRICS/restore_check.prom" 2>/dev/null)

finish() {   # finish <ok 0|1> <message> [documents]
    local ok=$1 msg=$2 docs=${3:-0} now
    now=$(date +%s)
    [ "$ok" = 1 ] && last_ok=$now
    echo "$(date -Is) restore-check $([ "$ok" = 1 ] && echo ok || echo FAILED) ${archive:-none} $msg ($((now - started))s)" >> "$LOG"
    echo "restore-check $([ "$ok" = 1 ] && echo ok || echo FAILED): $msg"
    {
        echo "# HELP redline_restore_check_success 1 if the last restore check of the newest backup passed."
        echo "# TYPE redline_restore_check_success gauge"
        echo "redline_restore_check_success $ok"
        echo "# HELP redline_restore_check_last_run_timestamp_seconds When the last restore check ran."
        echo "# TYPE redline_restore_check_last_run_timestamp_seconds gauge"
        echo "redline_restore_check_last_run_timestamp_seconds $now"
        echo "# HELP redline_restore_check_last_success_timestamp_seconds When a restore check last passed."
        echo "# TYPE redline_restore_check_last_success_timestamp_seconds gauge"
        echo "redline_restore_check_last_success_timestamp_seconds ${last_ok:-0}"
        echo "# HELP redline_restore_check_documents Documents restored from the archive."
        echo "# TYPE redline_restore_check_documents gauge"
        echo "redline_restore_check_documents $docs"
        echo "# HELP redline_restore_check_duration_seconds How long the last restore check took."
        echo "# TYPE redline_restore_check_duration_seconds gauge"
        echo "redline_restore_check_duration_seconds $((now - started))"
    } > "$METRICS/restore_check.prom.tmp" && mv "$METRICS/restore_check.prom.tmp" "$METRICS/restore_check.prom"
    exit $((1 - ok))
}

[ -n "$archive" ] || finish 0 "no archive in $BACKUPS"
[ -n "${MONGO_USER:-}" ] && [ -n "${MONGO_PASS:-}" ] || finish 0 "MONGO_USER/MONGO_PASS not set"

mkdir -p "$work/db"
mongod --dbpath "$work/db" --port $PORT --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 0.25 \
    --fork --logpath "$work/mongod.log" >/dev/null || finish 0 "throwaway mongod did not start"

if ! mongorestore --quiet --gzip --archive="$archive" --uri "mongodb://127.0.0.1:$PORT" \
        2> "$work/restore.err"; then
    finish 0 "mongorestore failed: $(tail -c 300 "$work/restore.err" | tr '\n' ' ')"
fi

# The comparison, in mongosh. Prints one line: "OK <summary>|<docs>" or
# "FAIL <reasons>|<docs>". Secret values are only tested for their prefix.
cat > "$work/verify.js" <<'JS'
const DB = process.env.RC_DB, PCT = +process.env.RC_TOL_PCT, ABS = +process.env.RC_TOL_ABS;
const live = connect(`mongodb://${process.env.MONGO_USER}:${encodeURIComponent(process.env.MONGO_PASS)}@${process.env.RC_LIVE}/${DB}?authSource=admin`);
const copy = connect(`mongodb://127.0.0.1:${process.env.RC_PORT}/${DB}`);
const KEY = ["users", "cc_chats", "models", "boards", "inventory", "product_files", "settings",
             "llm_settings", "server_settings", "telegram_settings", "files", "workspaces"];
const fail = [], parts = [];
// A collection whose oldest document (by ObjectId time) is younger than the
// archive was made after the dump: not in it, and not lost either.
const DUMP = new Date(+process.env.RC_DUMP_TS * 1000);
// (Or, for string ids, the oldest created_at: a Date, epoch s/ms or ISO text.)
function when(v) {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string") { const t = Date.parse(v); return isNaN(t) ? null : new Date(t); }
  return null;
}
function newSince(c) {
  const d = live[c].find({}, {_id: 1}).sort({_id: 1}).limit(1).toArray()[0];
  if (d && d._id instanceof ObjectId) return d._id.getTimestamp() > DUMP;
  const e = live[c].find({created_at: {$exists: true}}, {created_at: 1}).sort({created_at: 1}).limit(1).toArray()[0];
  const t = e && when(e.created_at);
  return !!(t && t > DUMP);
}
const liveNames = new Set(live.getCollectionNames()), copyNames = new Set(copy.getCollectionNames());
let docs = 0;
for (const c of copyNames) docs += copy[c].countDocuments({});
for (const c of KEY) {
  const l = liveNames.has(c) ? live[c].countDocuments({}) : 0;
  if (!copyNames.has(c)) {
    if (l > 0 && !newSince(c)) fail.push(`${c} missing`); else if (l > 0) parts.push(`${c}=new-since-dump`);
    continue;
  }
  const r = copy[c].countDocuments({});
  parts.push(`${c}=${r}/${l}`);
  if (Math.abs(l - r) > Math.max(ABS, l * PCT / 100)) fail.push(`${c} ${r} vs live ${l}`);
  if (r > 0 && !copy[c].findOne({})) fail.push(`${c} sample unreadable`);
}
// A GridFS chunk (the model files) reads back with its bytes.
const ch = copyNames.has("model_files.chunks") ? copy["model_files.chunks"].findOne({}) : null;
if (live["model_files.chunks"].estimatedDocumentCount() > 0 && !(ch && ch.data && ch.data.length() > 0))
  fail.push("model_files chunk unreadable");
// Collections on live but not in the copy (new since the dump, or lost).
const gone = [...liveNames].filter(c => !copyNames.has(c) && live[c].estimatedDocumentCount() > 0);
// backend/secretbox.py FIELDS: every value still an "enc1:" token, as many as on live.
const SECRETS = [["server_settings", "jina", ["key"]], ["server_settings", "proxy", ["password"]],
  ["server_settings", "mcmaster", ["password", "cert_password", "cert.data"]],
  ["telegram_settings", "bot", ["token", "secret"]]];
const get = (o, p) => p.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
function sealed(d) {
  const out = [];
  for (const [c, id, fields] of SECRETS) {
    const doc = d[c].findOne({_id: id}); if (!doc) continue;
    for (const f of fields) { const v = get(doc, f); if (v) out.push(v); }
  }
  const llm = d.llm_settings.findOne({_id: "llm"});
  for (const v of Object.values((llm && llm.keys) || {})) if (v) out.push(v);
  return out;
}
const sc = sealed(copy), sl = sealed(live);
const plain = sc.filter(v => typeof v !== "string" || !v.startsWith("enc1:")).length;
if (plain) fail.push(`${plain} secret(s) not enc1:`);
if (sc.length !== sl.length) fail.push(`secrets ${sc.length} vs live ${sl.length}`);
parts.push(`secrets enc1 dump=${sc.length - plain}/${sc.length} live=${sl.filter(v => typeof v === "string" && v.startsWith("enc1:")).length}/${sl.length}`);
parts.push(`collections=${copyNames.size}/${liveNames.size}`);
if (gone.length) parts.push(`not-in-dump=${gone.join(",")}`);
print(`${fail.length ? "FAIL " + fail.join("; ") + " | " : "OK "}${parts.join(" ")}|${docs}`);
JS

out=$(RC_DUMP_TS=$(stat -c %Y "$archive") RC_DB=$DB RC_LIVE=$LIVE RC_PORT=$PORT RC_TOL_PCT=$TOL_PCT RC_TOL_ABS=$TOL_ABS \
      mongosh --quiet --nodb "$work/verify.js" 2> "$work/verify.err" | tail -1)
case "$out" in
    OK\ *)   r=${out#OK };   finish 1 "${r%|*}" "${out##*|}" ;;
    FAIL\ *) r=${out#FAIL }; finish 0 "${r%|*}" "${out##*|}" ;;
    *)       finish 0 "verify did not run: $(tail -c 300 "$work/verify.err" | tr '\n' ' ')" ;;
esac
