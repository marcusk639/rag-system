#!/usr/bin/env bash
#
# Nightly logical backup of the TWK KB database.
#
# Runs as a Railway CRON SERVICE inside the private network — Postgres has no
# public TCP domain, so this cannot run anywhere else. It must exit cleanly:
# Railway skips the next scheduled run if the previous one is still Active.
#
# Deliberately a plain shell script. A backup job is the last thing that should
# depend on the application's own runtime, its dependency tree, or its build
# succeeding — if the app is broken, the backup still has to run.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${AZURE_SAS_URL:?AZURE_SAS_URL is required (container SAS, not account key)}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
NAME="twk-kb-${STAMP}.sql.gz"
OUT="/tmp/${NAME}"

log() { echo "[backup] $*"; }

log "start ${STAMP}"

# --no-owner --no-acl: without them the dump embeds role grants that don't
# exist in a fresh target, and the restore fails partway — leaving a
# half-populated database that looks restored. Proven in the drill.
# pipefail makes a pg_dump failure fail the script even though gzip succeeds.
timeout "${DUMP_TIMEOUT_SECONDS:-3600}" \
  pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip -9 >"$OUT"

SIZE="$(stat -c%s "$OUT")"
log "dump complete: ${SIZE} bytes"

# A truncated dump that uploads cleanly is the worst failure mode here: it
# replaces a good backup with a broken one and reports success. Baseline at
# time of writing is ~35.5 MB gzipped, so a floor of 10 MB catches catastrophic
# truncation without tripping on normal growth. Raise it as the KB grows.
MIN="${BACKUP_MIN_BYTES:-10000000}"
if [ "$SIZE" -lt "$MIN" ]; then
  log "FATAL: dump is ${SIZE} bytes, below floor ${MIN} — refusing to upload" >&2
  exit 1
fi

# Verify the gzip stream is intact before shipping it. Cheap, and catches a
# dump truncated mid-stream that still cleared the size floor.
gzip -t "$OUT"
log "gzip integrity OK"

# Optional client-side encryption. If AGE_RECIPIENT is set the storage
# provider never sees plaintext.
#
# ⚠ This introduces a key you can lose. An age-encrypted backup whose private
# key died with the laptop that held it is not a backup. Store the private key
# somewhere that survives the same disaster it is meant to protect against —
# NOT only on a workstation, and NOT only in this Railway project.
if [ -n "${AGE_RECIPIENT:-}" ]; then
  age -r "$AGE_RECIPIENT" -o "${OUT}.age" "$OUT"
  rm -f "$OUT"
  OUT="${OUT}.age"
  NAME="${NAME}.age"
  log "encrypted -> ${NAME}"
else
  log "WARNING: AGE_RECIPIENT unset — uploading unencrypted (relying on storage-side encryption at rest only)"
fi

# AZURE_SAS_URL is a *container* SAS:
#   https://<account>.blob.core.windows.net/<container>?sv=...&sig=...
# Split it so the blob name lands before the query string.
BASE="${AZURE_SAS_URL%%\?*}"
QS="${AZURE_SAS_URL#*\?}"

# ⚠ The timeout is load-bearing, not defensive garnish. azcopy retries a bad
# endpoint effectively forever (observed hanging indefinitely against an
# unreachable SAS URL during testing). Railway SKIPS the next scheduled run
# while the previous one is still Active — so a single hung upload silently
# stops backups permanently, with the service showing "Active" the whole time.
# Bounded failure is recoverable; an indefinite hang is not.
timeout "${UPLOAD_TIMEOUT_SECONDS:-1800}" \
  azcopy copy "$OUT" "${BASE}/${NAME}?${QS}" --from-to=LocalBlob \
  || {
    rc=$?
    [ "$rc" -eq 124 ] \
      && log "FATAL: upload exceeded ${UPLOAD_TIMEOUT_SECONDS:-1800}s and was killed" >&2 \
      || log "FATAL: azcopy failed with exit ${rc}" >&2
    rm -f "$OUT"
    exit 1
  }
log "uploaded ${NAME}"

rm -f "$OUT"

# Dead-man's switch. A backup job that fails silently is worse than no backup,
# because it manufactures confidence. If HEARTBEAT_URL is set, it is pinged
# only on full success — the monitor alerts on the ABSENCE of a ping, which is
# the only way a job that never starts gets noticed.
if [ -n "${HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$HEARTBEAT_URL" >/dev/null && log "heartbeat sent"
fi

log "done"
