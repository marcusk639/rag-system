#!/usr/bin/env bash
# deploy_tokens.sh — generate principals and deploy them to Railway.
#
# Usage:
#   ./scripts/deploy_tokens.sh "<user>:<sourceId>[,<sourceId>...]" [more users...]
#
# Example:
#   ./scripts/deploy_tokens.sh \
#     "alice:11111111-1111-1111-1111-111111111111" \
#     "bob:11111111-1111-1111-1111-111111111111"
#
# Source UUIDs come from GET /sources (run gen-principals.sh to refresh). They
# are deployment-specific and are NOT hard-coded here: this script is generic
# tooling, and a live deployment's source ids and staff names do not belong in
# the repository.
#
# A "service-admin" principal with unrestricted access is always appended.
# TOKEN MAP is printed to stderr — save it before this terminal closes.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 \"<user>:<sourceId>[,<sourceId>...]\" [more users...]" >&2
  exit 1
fi

PRINCIPALS=$(./scripts/gen-tokens.sh "$@" "service-admin::isAdmin")

# This REPLACES the deployed principal set wholesale, and that set is an
# access-control boundary: omitting a user from argv silently revokes them, and
# nothing here would say so. Print what is deployed now, so the operator can see
# what they are about to overwrite before it happens.
# SHAPE ONLY — never the token values. An earlier version of this block printed
# the raw API_PRINCIPALS JSON on both sides, which put every live bearer token
# (the admin one included) into stderr, and therefore into any `2>&1 | tee`, CI
# log, or terminal scrollback. The operator needs to see WHO is being granted
# WHAT, which a fingerprint conveys just as well as the secret does.
summarize_principals() {
  jq -r '
    to_entries[]
    | "  [\(.key)] sources=\(.value.allowedSourceIds | length)"
      + (if .value.isAdmin then "  ADMIN (unrestricted)" else "" end)
      + "  token=" + (.value.token | .[0:6] + "…" + .[-4:])
  ' 2>/dev/null || echo "  (unparseable)"
}

echo "Current API_PRINCIPALS on rag-api (about to be REPLACED):" >&2
railway variables --service rag-api --kv 2>/dev/null \
  | sed -n 's/^API_PRINCIPALS=//p' | summarize_principals >&2 \
  || echo "  (none set, or could not be read)" >&2
echo "" >&2
echo "New principal set:" >&2
printf '%s' "$PRINCIPALS" | summarize_principals >&2
echo "" >&2

echo "Setting API_PRINCIPALS on rag-api..." >&2
railway variables --service rag-api --set "API_PRINCIPALS=$PRINCIPALS"

echo "Setting API_PRINCIPALS on rag-mcp..." >&2
railway variables --service rag-mcp --set "API_PRINCIPALS=$PRINCIPALS"

echo "" >&2
echo "Done. Redeploying services..." >&2
railway redeploy --service rag-api
railway redeploy --service rag-mcp
echo "Deploy triggered. Check Railway dashboard for status." >&2
