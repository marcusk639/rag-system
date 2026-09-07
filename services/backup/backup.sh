#!/usr/bin/env bash
#
# Nightly logical backup of the knowledge-base database.
#
# Runs as a Railway CRON SERVICE inside the private network — Postgres has no
# public TCP domain, so this cannot run anywhere else. It must exit cleanly:
# Railway skips the next scheduled run if the previous one is still Active.
#
# Deliberately a plain shell script. A backup job is the last thing that should
# depend on the application's own runtime, its dependency tree, or its build
# succeeding — if the app is broken, the backup still has to run.
#
# BACKUP_DEST selects where the artifact goes:
#   sharepoint  the intended destination — firm-controlled, needs admin consent
#   s3          S3-compatible (incl. Railway's own bucket) — STOPGAP ONLY, see below
#   azure       Azure Blob via container SAS — blocked where the operating
#               tenant has no Azure subscription
#
# ⚠ s3-to-Railway is a deliberate stopgap, not a backup strategy. It lives with
# the database it protects, so it does NOT survive project or account loss. It
# does cover corruption, a bad migration, and a volume wipe (which destroys
# Railway's volume backups). Strictly better than nothing; replace it.
set -euo pipefail

# ⚠ TLS: this script uses pg_dump, i.e. LIBPQ — and libpq does NOT accept
# `sslmode=no-verify`. It rejects the value outright ("invalid sslmode value")
# and the dump fails before it starts. The app services (node-postgres) use
# exactly that value, so copying a working DATABASE_URL from rag-api or
# rag-worker into this service BREAKS the nightly backup.
#
# For libpq the equivalent is `sslmode=require`: encrypt, do not verify the
# certificate — which is what Railway's self-signed postgres-ssl cert needs.
# libpq already defaults to `prefer` (opportunistic TLS), so an unset sslmode
# is normally encrypted anyway; `require` is what makes it mandatory rather
# than silently falling back to plaintext.
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DEST:?BACKUP_DEST is required (sharepoint | s3 | azure)}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
# Artifact FILENAME prefix. Parameterised rather than hard-coded because it is an
# OPERATIONAL identifier, not a label: archives already written carry whatever
# prefix produced them, and the restore procedure matches on it. A deployment
# with existing backups should set BACKUP_NAME_PREFIX to the prefix those use,
# or its restore glob stops matching the older half of the archive.
#
# Deliberately NOT called BACKUP_PREFIX: that name is already taken, further
# down, for the upload FOLDER (`PREFIX="${BACKUP_PREFIX:-backups}"`). Assigning
# BACKUP_PREFIX here would kill that default and silently relocate every upload
# from `backups/` to the filename prefix — backups would keep succeeding, the
# heartbeat would keep firing, and the runbook's own verification step would
# keep listing the old folder full of healthy-looking historical files.
BACKUP_NAME_PREFIX="${BACKUP_NAME_PREFIX:-kb}"
NAME="${BACKUP_NAME_PREFIX}-${STAMP}.sql.gz"
OUT="/tmp/${NAME}"

log() { echo "[backup] $*"; }
die() {
  log "FATAL: $*" >&2
  rm -f "$OUT"
  exit 1
}

log "start ${STAMP} -> ${BACKUP_DEST}"

# Validate destination config BEFORE spending minutes on a dump we cannot ship.
case "$BACKUP_DEST" in
sharepoint)
  : "${GRAPH_TENANT_ID:?required for BACKUP_DEST=sharepoint}"
  : "${GRAPH_CLIENT_ID:?required for BACKUP_DEST=sharepoint}"
  : "${GRAPH_CLIENT_SECRET:?required for BACKUP_DEST=sharepoint}"
  : "${GRAPH_SITE_ID:?required for BACKUP_DEST=sharepoint}"
  ;;
s3)
  : "${S3_BUCKET:?required for BACKUP_DEST=s3}"
  : "${S3_ENDPOINT:?required for BACKUP_DEST=s3}"
  : "${AWS_ACCESS_KEY_ID:?required for BACKUP_DEST=s3}"
  : "${AWS_SECRET_ACCESS_KEY:?required for BACKUP_DEST=s3}"
  ;;
azure)
  : "${AZURE_SAS_URL:?required for BACKUP_DEST=azure}"
  ;;
*) die "unknown BACKUP_DEST '${BACKUP_DEST}' (expected sharepoint | s3 | azure)" ;;
esac

# ── dump ────────────────────────────────────────────────────────────────────
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
[ "$SIZE" -lt "$MIN" ] && die "dump is ${SIZE} bytes, below floor ${MIN} — refusing to upload"

# Verify the gzip stream is intact before shipping it. Cheap, and catches a
# dump truncated mid-stream that still cleared the size floor.
gzip -t "$OUT" || die "gzip stream is corrupt"
log "gzip integrity OK"

# ── optional client-side encryption ─────────────────────────────────────────
# If AGE_RECIPIENT is set the storage provider never sees plaintext.
#
# ⚠ This introduces a key you can lose. An age-encrypted backup whose private
# key died with the laptop that held it is not a backup. Store the private key
# somewhere that survives the same disaster it is meant to protect against —
# NOT only on a workstation, and NOT only in this Railway project.
if [ -n "${AGE_RECIPIENT:-}" ]; then
  age -r "$AGE_RECIPIENT" -o "${OUT}.age" "$OUT" || die "age encryption failed"
  rm -f "$OUT"
  OUT="${OUT}.age"
  NAME="${NAME}.age"
  log "encrypted -> ${NAME}"
else
  log "WARNING: AGE_RECIPIENT unset — uploading unencrypted (relying on storage-side encryption at rest only)"
fi

# ── upload ──────────────────────────────────────────────────────────────────
# ⚠ Every uploader below is wrapped in a hard timeout, and that is load-bearing
# rather than defensive garnish. azcopy was observed retrying an unreachable
# endpoint indefinitely during testing. Railway SKIPS the next scheduled run
# while the previous one is still Active — so a single hung upload silently
# stops backups permanently, with the service showing "Active" the whole time.
# Bounded failure is recoverable; an indefinite hang is not.
UPLOAD_TIMEOUT="${UPLOAD_TIMEOUT_SECONDS:-1800}"
PREFIX="${BACKUP_PREFIX:-backups}"

upload_s3() {
  timeout "$UPLOAD_TIMEOUT" \
    aws --endpoint-url "$S3_ENDPOINT" s3 cp "$OUT" \
    "s3://${S3_BUCKET}/${PREFIX}/${NAME}" --only-show-errors
}

upload_azure() {
  # AZURE_SAS_URL is a *container* SAS:
  #   https://<account>.blob.core.windows.net/<container>?sv=...&sig=...
  local base="${AZURE_SAS_URL%%\?*}" qs="${AZURE_SAS_URL#*\?}"
  timeout "$UPLOAD_TIMEOUT" \
    azcopy copy "$OUT" "${base}/${NAME}?${qs}" --from-to=LocalBlob
}

upload_sharepoint() {
  # App-only (client credentials). Delegated auth is not viable for a cron job:
  # the tokens expire and re-prompt for MFA, which no headless job survives.
  local token
  token="$(
    curl -fsS -m 60 \
      -d "client_id=${GRAPH_CLIENT_ID}" \
      -d "client_secret=${GRAPH_CLIENT_SECRET}" \
      -d "scope=https://graph.microsoft.com/.default" \
      -d "grant_type=client_credentials" \
      "https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token" |
      jq -r '.access_token // empty'
  )" || return 1
  [ -n "$token" ] || {
    log "could not obtain a Graph token — check client id/secret and that admin consent was granted" >&2
    return 1
  }

  # Graph simple upload is documented up to 250 MB. Above that it needs a
  # resumable upload session — fail loudly rather than silently truncating.
  if [ "$(stat -c%s "$OUT")" -gt 250000000 ]; then
    log "artifact exceeds Graph's 250 MB simple-upload limit — needs an upload session" >&2
    return 1
  fi

  local folder="${GRAPH_FOLDER:-$PREFIX}"
  timeout "$UPLOAD_TIMEOUT" curl -fsS -X PUT \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${OUT}" \
    "https://graph.microsoft.com/v1.0/sites/${GRAPH_SITE_ID}/drive/root:/${folder}/${NAME}:/content" \
    -o /dev/null
}

case "$BACKUP_DEST" in
s3) upload_s3 ;;
azure) upload_azure ;;
sharepoint) upload_sharepoint ;;
esac || {
  rc=$?
  [ "$rc" -eq 124 ] &&
    die "upload exceeded ${UPLOAD_TIMEOUT}s and was killed" ||
    die "upload to ${BACKUP_DEST} failed with exit ${rc}"
}

log "uploaded ${NAME} -> ${BACKUP_DEST}/${PREFIX}"
rm -f "$OUT"

# ── dead-man's switch ───────────────────────────────────────────────────────
# A backup job that fails silently is worse than no backup, because it
# manufactures confidence. If HEARTBEAT_URL is set, it is pinged only on full
# success — the monitor alerts on the ABSENCE of a ping, which is the only way
# a job that never starts gets noticed.
if [ -n "${HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$HEARTBEAT_URL" >/dev/null && log "heartbeat sent"
fi

log "done"
