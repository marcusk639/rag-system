#!/usr/bin/env bash
#
# Local end-to-end smoke test for POST /ask/stream (and /ask) against a real
# Gemini generator.
#
# Usage:
#   GEMINI_API_KEY=your-key bash scripts/local-ask-stream-test.sh
#
# Prereqs: `pnpm docker:up` (rag-postgres + rag-parser healthy). The script
# boots the API in-process on port 3000, waits for /health, fires one streaming
# and one non-streaming request, prints the raw responses, then shuts the API
# down. The Gemini key is read from the environment only — it is never written
# to .env or committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "ERROR: GEMINI_API_KEY is not set." >&2
  echo "Run: GEMINI_API_KEY=your-key bash scripts/local-ask-stream-test.sh" >&2
  exit 1
fi

# --- Config (shell env; the app does not read .env) ---
export DATABASE_URL="${DATABASE_URL:-postgres://rag:rag@localhost:5432/rag}"
export PARSER_URL="${PARSER_URL:-http://localhost:8000}"
export API_PORT="${API_PORT:-3000}"
export AUTH_PROVIDER="${AUTH_PROVIDER:-composite}"
export API_TOKENS="${API_TOKENS:-dev-token-change-me}"
# Embedding provider MUST be gemini so GEMINI_API_KEY flows into
# config.embedding.apiKey, which the generator reuses (runtime index.ts).
export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-gemini}"
export EMBEDDING_MODEL="${EMBEDDING_MODEL:-gemini-embedding-001}"
export EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-768}"
export GENERATION_PROVIDER="${GENERATION_PROVIDER:-gemini}"
export GENERATION_MODEL="${GENERATION_MODEL:-gemini-2.5-flash}"

BASE="http://localhost:${API_PORT}"
TOKEN="${API_TOKENS%%,*}" # first token if comma-separated

echo "==> Booting API on ${BASE} (embedding+generation: gemini)"
pnpm --filter @rag/api exec tsx src/main.ts >/tmp/rag-api-local.log 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

echo "==> Waiting for /health ..."
for i in $(seq 1 40); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    echo "    API is up."
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "ERROR: API process exited early. Last log lines:" >&2
    tail -30 /tmp/rag-api-local.log >&2
    exit 1
  fi
  sleep 1
done

QUESTION='How do you do point-in-time recovery with PostgreSQL backups?'

echo ""
echo "==> POST /ask/stream (SSE, raw frames):"
echo "-------------------------------------------------------------"
curl -N -sS -X POST "${BASE}/ask/stream" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"question\": \"${QUESTION}\"}"
echo ""
echo "-------------------------------------------------------------"

echo ""
echo "==> POST /ask (non-streaming JSON, for comparison):"
echo "-------------------------------------------------------------"
curl -sS -X POST "${BASE}/ask" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"question\": \"${QUESTION}\"}" | head -c 2000
echo ""
echo "-------------------------------------------------------------"
echo ""
echo "==> Done. API log: /tmp/rag-api-local.log"
