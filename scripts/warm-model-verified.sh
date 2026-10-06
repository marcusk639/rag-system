#!/bin/sh
# Warm the local ONNX embedding model cache and VERIFY it actually happened.
#
# Used by the `warmer` stage of apps/{worker,api,mcp}/Dockerfile. It lives here
# rather than inline in each Dockerfile because all three need byte-identical
# logic: inline, the exit-code tolerance and the size floor below were three
# copies that had to be kept in step, and a gate whose copies can drift is a
# gate you cannot reason about.
#
# Why a build-time warm at all: COMPLIANCE_MODE=client-data forbids runtime
# egress from the production container, and it FORCES EMBEDDING_PROVIDER=local
# (packages/rag/src/embeddings/factory.ts). A startup warm would perform the
# exact outbound huggingface.co call that mode exists to prevent, so the cache
# has to be baked into the image instead.
#
# Run from the workspace root (the Dockerfile `builder` stage's WORKDIR), after
# `pnpm -r build`: warm-model.ts imports @rag/rag, which resolves to its built
# dist/.
set +e

# An unset HF_CACHE_DIR is the silent-no-op case, not a default: the warm would
# populate $HOME/.cache/huggingface in this stage, the Dockerfile's
# `COPY --from=warmer` would copy an empty path, and the image would ship with
# no cache while every check here still passed.
if [ -z "$HF_CACHE_DIR" ]; then
  echo "FATAL: HF_CACHE_DIR is not set. The warm would write to a default cache path that the image never copies, producing an empty cache that looks warmed." >&2
  exit 1
fi

# Pinned here, not inherited. Railway sets EMBEDDING_MODEL=gemini-embedding-001
# and docker/compose.prod.yml injects the same var; if either reached this
# script it would try to download a HuggingFace repo literally named
# "gemini-embedding-001". This script warms the LOCAL model, always.
EMBEDDING_MODEL="${WARM_MODEL_ID:-Xenova/bge-base-en-v1.5}"
export EMBEDDING_MODEL

# Minimum believable cache size, in KB. Xenova/bge-base-en-v1.5 is ~430MB; 50MB
# is low enough to never false-positive on a legitimate warm and high enough to
# catch a cache that was created but not populated.
MIN_CACHE_KB=51200

mkdir -p "$HF_CACHE_DIR"

# Never `npx tsx`: npx would fetch tsx over the network mid-build, and the
# runtime stage prunes tsx entirely via `pnpm deploy --prod`. This is the copy
# pnpm already installed from the lockfile.
node_modules/.bin/tsx scripts/warm-model.ts > /tmp/warm-model.log 2>&1
status=$?
cat /tmp/warm-model.log

# Gate on verified state, NOT on the exit code, and check the success line
# FIRST. onnxruntime-node v1.21.0 SIGABRTs (exit 134, "libc++abi: mutex lock
# failed: Invalid argument") during teardown AFTER a fully successful embed, so
# a plain `RUN` would fail the build on a correctly warmed cache. Requiring the
# script's own success line before tolerating 134 is what keeps that tolerance
# from masking a genuine failure. Deliberately no `|| true` anywhere.
if ! grep -q "Model ready" /tmp/warm-model.log; then
  echo "FATAL: warm-model.ts did not report success (exit $status) - this is a genuine failure, not the known onnxruntime-node teardown abort" >&2
  exit 1
fi

if [ "$status" -ne 0 ] && [ "$status" -ne 134 ]; then
  echo "FATAL: warm-model.ts exited $status, which is neither 0 nor the known onnxruntime-node SIGABRT-on-teardown code 134" >&2
  exit 1
fi

cache_kb=$(du -sk "$HF_CACHE_DIR" 2>/dev/null | cut -f1)
cache_kb=${cache_kb:-0}
echo "HF cache size: ${cache_kb} KB at $HF_CACHE_DIR"

if [ "$cache_kb" -lt "$MIN_CACHE_KB" ]; then
  echo "FATAL: HF cache at $HF_CACHE_DIR is only ${cache_kb} KB (expected >=$((MIN_CACHE_KB / 1024))MB of model weights) - the warm did not actually populate the cache" >&2
  exit 1
fi

echo "Local embedding model cache warmed and verified (${cache_kb} KB)."
