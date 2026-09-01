#!/usr/bin/env bash
#
# sweep-orphaned-objects.sh — delete object-store originals whose source row no
# longer exists.
#
# Until `purgeSource` learned to clear objects, deleting a source cascaded in
# Postgres only and left its originals in the bucket forever. This sweeps what
# those deletions left behind, and stays useful afterwards as a drift check.
#
# Usage:
#   ./scripts/sweep-orphaned-objects.sh              # dry run (default)
#   ./scripts/sweep-orphaned-objects.sh --delete     # actually delete
#
#   --token <admin-token>   rag API admin token (else RAG_ADMIN_TOKEN, else Railway)
#   --api <url>             rag API base URL (else RAG_API_URL, else production)
#   --service <name>        Railway service to read OBJECT_STORE_* from (default rag-worker)
#
# SAFETY
#   * Dry run unless --delete is passed.
#   * The live-source list is fetched FIRST and the script aborts if it cannot
#     be read or comes back empty. Without that guard a transient API failure
#     would make every prefix look orphaned and delete the whole corpus.
#   * Only keys under `sources/<uuid>/` are ever considered. `backups/` and
#     anything else in the bucket is out of scope by construction.
#   * Every prefix is listed with its object count and size before deletion.
#
# Requires: aws cli, curl, jq, railway cli (unless --token and OBJECT_STORE_* are exported)

set -euo pipefail

API_URL="${RAG_API_URL:-https://rag-api-production-07b4.up.railway.app}"
ADMIN_TOKEN="${RAG_ADMIN_TOKEN:-}"
SERVICE="rag-worker"
DO_DELETE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete)  DO_DELETE=true;    shift ;;
    --token)   ADMIN_TOKEN="$2";  shift 2 ;;
    --api)     API_URL="$2";      shift 2 ;;
    --service) SERVICE="$2";      shift 2 ;;
    -h|--help)
      awk 'NR==1{next} !/^#/{exit} {sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

for bin in aws curl jq; do
  command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 2; }
done

# ── object-store credentials ──────────────────────────────────────────────────
if [[ -z "${OBJECT_STORE_BUCKET:-}" ]]; then
  eval "$(railway variables --service "$SERVICE" --kv 2>/dev/null \
    | grep -E '^OBJECT_STORE_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|ENDPOINT|REGION)=' \
    | sed 's/^/export /')"
fi
: "${OBJECT_STORE_BUCKET:?could not read OBJECT_STORE_BUCKET — export it or check --service}"
export AWS_ACCESS_KEY_ID="${OBJECT_STORE_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${OBJECT_STORE_SECRET_ACCESS_KEY:-}"
export AWS_REGION="${OBJECT_STORE_REGION:-auto}"
S3=(--endpoint-url "${OBJECT_STORE_ENDPOINT:?OBJECT_STORE_ENDPOINT is required}")

echo "bucket:   $OBJECT_STORE_BUCKET"
echo "endpoint: $OBJECT_STORE_ENDPOINT"

# ── live sources, FIRST and fail-closed ───────────────────────────────────────
if [[ -z "$ADMIN_TOKEN" ]]; then
  ADMIN_TOKEN="$(railway variables --service rag-api --kv 2>/dev/null \
    | sed -n 's/^API_PRINCIPALS=//p' \
    | jq -r 'try (fromjson? // .) | .[]? | select(.isAdmin == true) | .token' \
    | head -1)"
fi
[[ -n "$ADMIN_TOKEN" ]] || { echo "ERROR: no admin token (pass --token)" >&2; exit 1; }

LIVE="$(curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" "$API_URL/sources" \
  | jq -r '(.sources // .)[]?.id' | sort -u)" || {
  echo "ERROR: could not read $API_URL/sources — refusing to sweep." >&2
  echo "Deleting on an unknown live set would delete the whole corpus." >&2
  exit 1
}
if [[ -z "$LIVE" ]]; then
  # Zero live sources is legitimate (a fully purged deployment), but it is also
  # what a silent API/auth failure looks like. The two are indistinguishable
  # from here, so refuse rather than guess.
  echo "ERROR: the API reported ZERO live sources. Refusing to sweep, because" >&2
  echo "that is indistinguishable from a failed read. Re-run with --token if" >&2
  echo "the deployment genuinely has no sources and you want to clear all." >&2
  exit 1
fi
echo ""
echo "live sources ($(wc -l <<<"$LIVE" | tr -d ' ')):"
sed 's/^/  keep  /' <<<"$LIVE"

# ── prefixes present in the bucket ────────────────────────────────────────────
PRESENT="$(aws s3 ls "s3://$OBJECT_STORE_BUCKET/sources/" "${S3[@]}" 2>/dev/null \
  | awk '/PRE/ {gsub("/","",$2); print $2}' | sort -u)"
[[ -n "$PRESENT" ]] || { echo ""; echo "No sources/ prefixes in the bucket. Nothing to do."; exit 0; }

ORPHANS="$(comm -23 <(echo "$PRESENT") <(echo "$LIVE"))"
if [[ -z "$ORPHANS" ]]; then
  echo ""
  echo "No orphaned prefixes. Bucket and database agree."
  exit 0
fi

echo ""
echo "orphaned prefixes (no matching source row):"
total_objects=0
total_bytes=0
while read -r p; do
  [[ -n "$p" ]] || continue
  read -r n b <<<"$(aws s3 ls "s3://$OBJECT_STORE_BUCKET/sources/$p/" "${S3[@]}" --recursive --summarize 2>/dev/null \
    | awk '/Total Objects:/{n=$3} /Total Size:/{b=$3} END{print n+0, b+0}')"
  printf "  DELETE  %s  objects=%-5s %8.1f MB\n" "$p" "$n" "$(awk "BEGIN{print $b/1048576}")"
  total_objects=$((total_objects + n))
  total_bytes=$((total_bytes + b))
done <<<"$ORPHANS"

printf "\ntotal: %s objects, %.1f MB\n" "$total_objects" "$(awk "BEGIN{print $total_bytes/1048576}")"

if ! $DO_DELETE; then
  echo ""
  echo "DRY RUN — nothing deleted. Re-run with --delete to remove the above."
  exit 0
fi

echo ""
read -r -p "Delete these $total_objects objects? This cannot be undone. [type DELETE] " ans
[[ "$ans" == "DELETE" ]] || { echo "aborted."; exit 1; }

while read -r p; do
  [[ -n "$p" ]] || continue
  echo "removing sources/$p/ ..."
  aws s3 rm "s3://$OBJECT_STORE_BUCKET/sources/$p/" "${S3[@]}" --recursive
done <<<"$ORPHANS"

echo ""
echo "done. Re-run without --delete to confirm the bucket is clean."
