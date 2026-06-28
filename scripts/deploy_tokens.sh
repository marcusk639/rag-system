#!/usr/bin/env bash
# deploy_tokens.sh — Generate principals for marcus + chris and deploy to Railway.
#
# Source UUIDs (from GET /sources — run gen-principals.sh to refresh):
#   52bb403e-2e59-472b-935a-c83f2eee7e4c  TWK CPA Firm
#   d3461cbe-b99f-4253-aded-b3610afe56de  TWK RAGTestSite
#
# Both users get both sources. service-admin gets unrestricted access.
# TOKEN MAP is printed to stderr — save it before this terminal closes.

set -euo pipefail

PRINCIPALS=$(./scripts/gen-tokens.sh \
  "marcus:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de" \
  "chris:52bb403e-2e59-472b-935a-c83f2eee7e4c,d3461cbe-b99f-4253-aded-b3610afe56de" \
  "service-admin::isAdmin")

echo "Setting API_PRINCIPALS on rag-api..." >&2
railway variables --service rag-api --set "API_PRINCIPALS=$PRINCIPALS"

echo "Setting API_PRINCIPALS on rag-mcp..." >&2
railway variables --service rag-mcp --set "API_PRINCIPALS=$PRINCIPALS"

echo "" >&2
echo "Done. Redeploying services..." >&2
railway redeploy --service rag-api
railway redeploy --service rag-mcp
echo "Deploy triggered. Check Railway dashboard for status." >&2
