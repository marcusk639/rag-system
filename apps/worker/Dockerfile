# syntax=docker/dockerfile:1
# Production image for @rag/worker (pg-boss ingestion worker).
# Build from the REPO ROOT context (pnpm workspace with internal @rag/* deps):
#   docker build -f apps/worker/Dockerfile -t rag-worker .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ── installer: hydrate the full workspace (layer cached while lockfile unchanged)
FROM base AS installer
WORKDIR /workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY tests ./tests
COPY examples ./examples
COPY docs/compliance ./docs/compliance
COPY packs ./packs
# scripts/warm-model.ts (see the `warmer` stage below) needs the warm-up
# script itself in the build context — it is not part of any workspace
# package, so none of the COPYs above picks it up.
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# ── builder: compile all workspace packages (tsconfig per package)
FROM installer AS builder
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

# ── warmer: pre-populate the local ONNX embedding model cache at BUILD time.
#    All of the reasoning, and every failure branch, lives in one place:
#    scripts/warm-model-verified.sh. Keep it there — this block was previously
#    ~20 lines duplicated into three Dockerfiles, which is the same drift risk
#    the shared script was written to remove, one layer up in the comments.
FROM builder AS warmer
ENV HF_CACHE_DIR=/app/.hf-cache
# Gate on verified on-disk state rather than the exit code: onnxruntime-node
# v1.21.0 SIGABRTs (exit 134) during teardown AFTER a successful warm. The
# script requires warm-model.ts's own success line before tolerating 134, so
# that tolerance cannot mask a real failure, and it fails the build on an
# unpopulated cache. Shared by worker/api/mcp so the three cannot drift.
RUN sh scripts/warm-model-verified.sh

# ── pruner: extract a self-contained production bundle for this app only.
#    pnpm deploy resolves all prod deps (including workspace packages with their
#    built dist/) into /deploy — no devDeps, no other apps, no monorepo layout.
FROM builder AS pruner
RUN pnpm --filter "@rag/worker" deploy --prod /deploy

# ── runtime: minimal final image — only /deploy content lands here
FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=pruner --chown=node:node /deploy .
# COMPLIANCE_MODE=client-data's boot gate (packages/core/src/config.ts) reads
# docs/compliance/vendor-dpa-*.md relative to cwd at runtime — pnpm deploy's
# pruned output doesn't include it, so copy it separately from installer.
COPY --from=installer --chown=node:node /workspace/docs/compliance ./docs/compliance
# WORKER_SCANNER_PACK_DIR (default packs/cpa) is likewise resolved relative to
# cwd at startup, and buildDeps refuses to boot without a loadable pack. Same
# reason as above: pnpm deploy prunes non-package files.
COPY --from=installer --chown=node:node /workspace/packs ./packs
# Pre-warmed local ONNX embedding model cache (see the `warmer` stage above and
# scripts/warm-model-verified.sh). HF_CACHE_DIR must name the SAME absolute
# path the warm wrote to: a `~/.cache/huggingface` default would silently miss
# this COPY, since $HOME here need not match the warm stage's.
ENV HF_CACHE_DIR=/app/.hf-cache
COPY --from=warmer --chown=node:node /app/.hf-cache ./.hf-cache

USER node
ENV NODE_ENV=production

# Worker polls pg-boss; no HTTP listener.
# preDeployCommand on Railway runs `node node_modules/@rag/db/dist/migrate.js`
# before this service starts — worker is the designated migration owner (see
# DEPLOYMENT.md).
#
# NOT `pnpm --filter @rag/db migrate`: this runtime stage is plain node:22-slim
# and has no pnpm, and `pnpm deploy --prod` prunes the tsx that the `migrate`
# script shells out to. That command could never have worked against this
# image — it went unnoticed for ~7 weeks because every deploy in between was a
# `railway redeploy`, which re-runs the previously built image rather than
# building the current commit.
CMD ["node", "dist/main.js"]
