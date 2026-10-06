# syntax=docker/dockerfile:1
# Production image for @rag/mcp (MCP server; stdio + Streamable HTTP transports).
# Build from the REPO ROOT context (pnpm workspace with internal @rag/* deps):
#   docker build -f apps/mcp/Dockerfile -t rag-mcp .

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
# scripts/warm-model.ts (see the `warmer` stage below) needs the warm-up
# script itself in the build context — it is not part of any workspace
# package, so none of the COPYs above picks it up.
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# ── builder: compile all workspace packages (tsconfig per package)
FROM installer AS builder
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

# ── warmer: pre-populate the local ONNX embedding model cache at BUILD time.
#    Why build-time, not a startup/entrypoint warm: COMPLIANCE_MODE=client-data
#    forbids runtime egress from the production container (see
#    packages/core/src/config.ts and the egress policy in @rag/core) — a
#    startup warm would perform exactly the outbound huggingface.co call that
#    mode exists to prevent. Baking the cache into the image means the
#    `client-data` cutover (which forces EMBEDDING_PROVIDER=local — see
#    packages/rag/src/embeddings/factory.ts) never hits a cold cache. The MCP
#    server embeds query text on every search/ask tool call, so it needs this
#    warm cache just as much as the worker does ingestion-side.
#
#    Runs from `builder`, not `installer`: scripts/warm-model.ts imports
#    "@rag/rag", which resolves to packages/rag/dist/index.js (see its
#    package.json `main`) — only `builder` has run the workspace build.
#
#    Never `npx tsx`: npx would fetch tsx from the network during the build,
#    and the `runtime` stage below (via `pnpm deploy --prod`) PRUNES tsx
#    entirely. `node_modules/.bin/tsx` is the copy pnpm already installed
#    from the lockfile in the `installer` stage — no extra network call.
#
#    EMBEDDING_MODEL is deliberately NOT inherited here. Railway sets
#    EMBEDDING_MODEL=gemini-embedding-001 (today's real provider is gemini,
#    not local — this stage is inert in that deployment and that is
#    intentional); docker/compose.prod.yml's `environment:` block injects the
#    same var into containers. Neither reaches a Docker build by default, but
#    the ENV below pins the local warm-up model explicitly anyway so this
#    stage can never accidentally try to download a HuggingFace repo named
#    "gemini-embedding-001".
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
RUN pnpm --filter "@rag/mcp" deploy --prod /deploy

# ── runtime: minimal final image — only /deploy content lands here
FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=pruner --chown=node:node /deploy .
# COMPLIANCE_MODE=client-data's boot gate (packages/core/src/config.ts) reads
# docs/compliance/vendor-dpa-*.md relative to cwd at runtime — pnpm deploy's
# pruned output doesn't include it, so copy it separately from installer.
COPY --from=installer --chown=node:node /workspace/docs/compliance ./docs/compliance
# Pre-warmed local ONNX embedding model cache (see the `warmer` stage above).
# HF_CACHE_DIR must point at the SAME absolute path the warm step wrote to —
# a bare `~/.cache/huggingface` default would silently miss this copy, since
# $HOME for the `node` user here need not match the warm stage's $HOME.
# Inert today (EMBEDDING_PROVIDER=gemini on Railway); becomes load-bearing
# the moment COMPLIANCE_MODE=client-data forces EMBEDDING_PROVIDER=local.
ENV HF_CACHE_DIR=/app/.hf-cache
COPY --from=warmer --chown=node:node /app/.hf-cache ./.hf-cache

USER node
ENV NODE_ENV=production

# Exposed when MCP_TRANSPORT=http (set MCP_HTTP_PORT to override default 3001).
# stdio transport uses no port — omit EXPOSE in that deployment mode.
EXPOSE 3001

CMD ["node", "dist/main.js"]
