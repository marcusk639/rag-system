#!/usr/bin/env bash
# Run the KB assistant locally against PRODUCTION data.
# Secrets are pulled from Railway at runtime — nothing is written to disk.
set -euo pipefail
cd /Users/marcusklein/dev/rag-system
V() { railway variables --service rag-web --kv 2>/dev/null | grep "^$1=" | cut -d= -f2-; }

export AUTH_ENTRA_TENANT_ID="$(V AUTH_ENTRA_TENANT_ID)"
export AUTH_ENTRA_CLIENT_ID="$(V AUTH_ENTRA_CLIENT_ID)"
export AUTH_ENTRA_CLIENT_SECRET="$(V AUTH_ENTRA_CLIENT_SECRET)"
export MS_TENANT_ID="$AUTH_ENTRA_TENANT_ID"
export MS_CLIENT_ID="$AUTH_ENTRA_CLIENT_ID"
export MS_CLIENT_SECRET="$AUTH_ENTRA_CLIENT_SECRET"
export AUTH_SECRET="$(V AUTH_SECRET)"
export RAG_ADMINS_GROUP_ID="$(V RAG_ADMINS_GROUP_ID)"
export INTERNAL_SCOPE_JWT_SECRET="$(V INTERNAL_SCOPE_JWT_SECRET)"

export AUTH_URL="http://localhost:3000"
export AUTH_TRUST_HOST=true
# Local DB holds ONLY source ids + your grant — no firm content.
export DATABASE_URL="postgres://rag:rag@localhost:5432/rag"
# Search/answers come from the deployed API, which has the real 858 documents.
export RAG_API_URL="https://rag-api-production-07b4.up.railway.app"

exec pnpm --filter @rag/web dev
