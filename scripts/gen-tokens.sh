#!/usr/bin/env bash
# gen-tokens.sh — Generate real bearer tokens and build an API_PRINCIPALS blob.
#
# Each positional argument defines one principal:
#
#   <label>:<sourceId1>[,<sourceId2>,...]   scoped to listed source IDs
#   <label>::isAdmin                        unrestricted admin grant
#
# A fresh cryptographic token is generated for every principal.
# The script prints two things:
#   1. A human-readable TOKEN MAP (stderr) — save this somewhere safe.
#   2. The ready-to-set API_PRINCIPALS value (stdout) — pipe to railway.
#
# Usage examples:
#
#   # Generate tokens for two staff members and one admin service account
#   ./scripts/gen-tokens.sh \
#     "marcus:a538dc0f98a49250236ff32ca6921172cf507e26ca4cd4b80b4177ae3e82680b" \
#     "chris:5f7472857c98ddf3987e74f6c5031c92eb90f2407f99abc224405183eb79028f" \
#     "service-admin::isAdmin"
#
#   # Generate and deploy to Railway in one step
#   ./scripts/gen-tokens.sh [principals...] | ./scripts/deploy-principals.sh
#
#   # Full pipeline: list sources, then build and deploy principals
#   ./scripts/gen-principals.sh         # <- find source UUIDs
#   ./scripts/gen-tokens.sh [...]       # <- build JSON with real tokens
#
# Requires: openssl, jq

set -euo pipefail

if [[ $# -eq 0 || "$1" == "-h" || "$1" == "--help" ]]; then
  awk 'NR==1{next} !/^#/{exit} {sub(/^# ?/,""); print}' "$0"
  echo ""
  echo "Run ./scripts/gen-principals.sh first to see available source UUIDs."
  exit 0
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required (brew install jq)." >&2
  exit 1
fi

# ── build principals ──────────────────────────────────────────────────────────
TOKEN_MAP=()   # "label = token" lines for the human-readable summary
JSON_ENTRIES=()

for arg in "$@"; do
  # Parse: label:sourceIds  or  label::isAdmin
  label="${arg%%:*}"
  rest="${arg#*:}"

  if [[ -z "$label" ]]; then
    echo "ERROR: bad argument format '$arg' — expected 'label:sourceId1[,...]' or 'label::isAdmin'" >&2
    exit 1
  fi

  # Generate a cryptographic token
  token=$(openssl rand -hex 32)

  if [[ "$rest" == ":isAdmin" ]]; then
    # Admin principal — all-corpus access
    entry=$(jq -n \
      --arg token "$token" \
      --arg label "$label" \
      '{token: $token, allowedSourceIds: [], isAdmin: true, _label: $label}')
    TOKEN_MAP+=("$label (ADMIN)  =  $token")
  else
    # Scoped principal — split comma-separated source IDs
    IFS=',' read -ra source_ids <<< "$rest"

    # Validate: each element should look like a UUID (rough check)
    for sid in "${source_ids[@]}"; do
      if [[ ! "$sid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        echo "ERROR: '$sid' in '$arg' doesn't look like a UUID." >&2
        echo "  Run ./scripts/gen-principals.sh to get the correct source IDs." >&2
        exit 1
      fi
    done

    # Build jq-compatible JSON array of source IDs
    sources_json=$(printf '%s\n' "${source_ids[@]}" | jq -R . | jq -s .)

    entry=$(jq -n \
      --arg token "$token" \
      --arg label "$label" \
      --argjson sources "$sources_json" \
      '{token: $token, allowedSourceIds: $sources, _label: $label}')
    TOKEN_MAP+=("$label  =  $token")
  fi

  JSON_ENTRIES+=("$entry")
done

# ── assemble final JSON array ─────────────────────────────────────────────────
PRINCIPALS_JSON=$(printf '%s\n' "${JSON_ENTRIES[@]}" | jq -s .)

# ── print token map to stderr (save this!) ────────────────────────────────────
echo "" >&2
echo "======================================================================" >&2
echo "  TOKEN MAP — save these somewhere secure, they cannot be recovered" >&2
echo "======================================================================" >&2
for line in "${TOKEN_MAP[@]}"; do
  echo "  $line" >&2
done
echo "" >&2
echo "  Each token above is the bearer token for that principal." >&2
echo "  Share only the token — never the source IDs or this map — with the" >&2
echo "  end user or integration." >&2
echo "" >&2
echo "  To deploy:" >&2
echo "    Minified value (stdout below) is ready for:" >&2
echo "      railway variables --service rag-api --set \"API_PRINCIPALS=\$(./scripts/gen-tokens.sh ...)\"" >&2
echo "      railway variables --service rag-mcp --set \"API_PRINCIPALS=\$(./scripts/gen-tokens.sh ...)\"" >&2
echo "" >&2
echo "  NOTE: Running this script again generates DIFFERENT tokens." >&2
echo "        Redeploy with the SAME stdout output to avoid invalidating tokens." >&2
echo "======================================================================" >&2
echo "" >&2

# ── print minified JSON to stdout ─────────────────────────────────────────────
echo "$PRINCIPALS_JSON" | jq -c .
