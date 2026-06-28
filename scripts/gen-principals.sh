#!/usr/bin/env bash
# gen-principals.sh — Generate an API_PRINCIPALS JSON blob from live sources.
#
# Queries GET /sources (requires an admin bearer token), then prints a
# ready-to-paste API_PRINCIPALS value with placeholder tokens for each source.
# Optionally pushes the final value to Railway with --deploy.
#
# Usage:
#   ./scripts/gen-principals.sh [--token <admin-token>] [--api <url>] [--deploy]
#
# With no flags the script tries to pull the admin token from Railway and uses
# the production API URL.  Set RAG_ADMIN_TOKEN and/or RAG_API_URL in your
# environment to skip the Railway lookup.
#
# Requires: curl, jq (brew install jq)
# Optional: railway CLI (only needed without --token or RAG_ADMIN_TOKEN)

set -euo pipefail

# ── defaults ──────────────────────────────────────────────────────────────────
API_URL="${RAG_API_URL:-https://rag-api-production-07b4.up.railway.app}"
ADMIN_TOKEN="${RAG_ADMIN_TOKEN:-}"
DEPLOY=false

# ── arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)  ADMIN_TOKEN="$2"; shift 2 ;;
    --api)    API_URL="$2";     shift 2 ;;
    --deploy) DEPLOY=true;      shift   ;;
    -h|--help)
      awk 'NR==1{next} !/^#/{exit} {sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── resolve admin token ───────────────────────────────────────────────────────
if [[ -z "$ADMIN_TOKEN" ]]; then
  if ! command -v railway &>/dev/null; then
    echo "ERROR: no --token, no RAG_ADMIN_TOKEN, and 'railway' CLI not found." >&2
    echo "  Install railway CLI: npm i -g @railway/cli" >&2
    echo "  Or pass: --token <admin-token>" >&2
    exit 1
  fi
  echo "Fetching admin token from Railway..." >&2
  ADMIN_TOKEN=$(railway variables --service rag-api --kv 2>/dev/null \
    | grep '^API_TOKENS=' | cut -d= -f2- | cut -d, -f1)
  if [[ -z "$ADMIN_TOKEN" ]]; then
    echo "ERROR: could not read API_TOKENS from Railway. Are you logged in? (railway login)" >&2
    exit 1
  fi
  echo "Token resolved from Railway." >&2
fi

# ── dependency check ──────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required (brew install jq)." >&2
  exit 1
fi

# ── fetch sources ─────────────────────────────────────────────────────────────
echo "Fetching sources from $API_URL ..." >&2
HTTP_RESPONSE=$(curl -sf \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Accept: application/json" \
  "$API_URL/sources")

SOURCE_COUNT=$(echo "$HTTP_RESPONSE" | jq '.sources | length')
if [[ "$SOURCE_COUNT" -eq 0 ]]; then
  echo "No sources found.  Register at least one with POST /sources first." >&2
  exit 0
fi
echo "Found $SOURCE_COUNT source(s)." >&2

# ── print source table (for reference) ───────────────────────────────────────
echo "" >&2
echo "Sources available:" >&2
echo "$HTTP_RESPONSE" | jq -r '.sources[] | "  \(.id)  \(.kind)  \(.name)"' >&2
echo "" >&2

# ── build API_PRINCIPALS template ─────────────────────────────────────────────
#
# Produces one scoped principal per source with a placeholder token. Replace
# each <TOKEN-FOR-...> with a real secret (openssl rand -hex 32).
#
# To grant a user access to MULTIPLE sources, put their token on one entry
# with a list of source IDs:
#   {"token":"alice-tok","allowedSourceIds":["uuid1","uuid2"]}
#
PRINCIPALS=$(echo "$HTTP_RESPONSE" | jq -c '[
  .sources[] |
  {
    "token": ("<TOKEN-FOR-" + (.name | ascii_downcase | gsub("[^a-z0-9]";"-")) + ">"),
    "allowedSourceIds": [.id],
    "_source_name": .name,
    "_source_kind": .kind
  }
]')

echo "========================================================================" >&2
echo "  API_PRINCIPALS template — edit before applying" >&2
echo "========================================================================" >&2
echo "" >&2

# Pretty-print with source metadata as comments (JSON doesn't support real
# comments, so we use a field that the parser ignores — it will error on unknown
# fields if strict mode is on; strip _source_* if that matters).
echo "$PRINCIPALS" | jq .

echo "" >&2
echo "Steps:" >&2
echo "  1. Replace each <TOKEN-FOR-...> with:  openssl rand -hex 32" >&2
echo "  2. Remove the _source_name / _source_kind fields (or keep for readability —" >&2
echo "     the server ignores unknown fields)." >&2
echo "  3. Combine sources if a user needs access to more than one." >&2
echo "  4. Minify to one line, then set the variable:" >&2
echo "" >&2
echo "     railway variables --service rag-api --set \\" >&2
echo "       \"API_PRINCIPALS=\$(echo '\$JSON' | jq -c .)\"" >&2
echo "" >&2
echo "  5. Repeat for rag-mcp (same value)." >&2
echo "  6. Optionally set API_ENFORCE_SCOPING=true to flip plain API_TOKENS to deny-all." >&2

# ── deploy if requested ───────────────────────────────────────────────────────
if [[ "$DEPLOY" == "true" ]]; then
  echo "" >&2
  echo "WARNING: --deploy was passed but the template contains placeholder tokens." >&2
  echo "Replace all <TOKEN-FOR-...> values with real secrets before deploying." >&2
  echo "Skipping automatic deploy." >&2
fi
