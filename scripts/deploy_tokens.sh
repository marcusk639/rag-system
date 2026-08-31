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

echo "Setting API_PRINCIPALS on rag-api..." >&2
railway variables --service rag-api --set "API_PRINCIPALS=$PRINCIPALS"

echo "Setting API_PRINCIPALS on rag-mcp..." >&2
railway variables --service rag-mcp --set "API_PRINCIPALS=$PRINCIPALS"

echo "" >&2
echo "Done. Redeploying services..." >&2
railway redeploy --service rag-api
railway redeploy --service rag-mcp
echo "Deploy triggered. Check Railway dashboard for status." >&2
