#!/usr/bin/env bash
#
# Item #2 then #3: re-embed the corpus with real Gemini embeddings, then run
# the streaming /ask/stream smoke test against a real Gemini generator.
#
# Usage:
#   GEMINI_API_KEY=your-key bash scripts/reembed-and-stream.sh
#
# Prereqs: `pnpm docker:up` (rag-postgres + rag-parser healthy). The Gemini key
# is read from the environment only — never written to .env or committed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "ERROR: GEMINI_API_KEY is not set." >&2
  echo "Run: GEMINI_API_KEY=your-key bash scripts/reembed-and-stream.sh" >&2
  exit 1
fi

# Embedding config so the re-embed and the API agree on provider/model/dims.
export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-gemini}"
export EMBEDDING_MODEL="${EMBEDDING_MODEL:-gemini-embedding-001}"
export EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-768}"
export DATABASE_URL="${DATABASE_URL:-postgres://rag:rag@localhost:5432/rag}"
# loadConfig() validates the FULL config (incl. a non-empty API_TOKENS), even
# though the re-embed step itself never authenticates. Set it so the re-embed
# process passes validation; the stream step reuses the same value.
export API_TOKENS="${API_TOKENS:-dev-token-change-me}"

echo "==> [2] Re-embedding chunks with Gemini (${EMBEDDING_MODEL}) ..."
pnpm --filter @rag/runtime exec tsx "$ROOT/scripts/reembed-chunks.ts"

echo ""
echo "==> [3] Streaming /ask/stream smoke test ..."
# local-ask-stream-test.sh boots the API, fires /ask/stream + /ask, tears down.
bash "$ROOT/scripts/local-ask-stream-test.sh"
