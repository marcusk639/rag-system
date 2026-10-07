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
# scripts/ is a pnpm WORKSPACE PACKAGE (@rag/scripts, added so `pnpm -r run
# test` collects the build-gate tests), so `pnpm install --frozen-lockfile`
# below fails without its package.json present. This COPY was originally here
# to supply the warm-up script to a local `warmer` stage; that stage is gone
# (the cache now comes from the pinned base image in the runtime stage), but
# the COPY is still required for the install to resolve the workspace.
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# ── builder: compile all workspace packages (tsconfig per package)
FROM installer AS builder
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

# ── pruner: extract a self-contained production bundle for this app only.
#    pnpm deploy resolves all prod deps (including workspace packages with their
#    built dist/) into /deploy — no devDeps, no other apps, no monorepo layout.
FROM builder AS pruner
RUN pnpm --filter "@rag/mcp" deploy --prod /deploy

# ── warmcache: the shared pre-warmed model cache, pinned BY DIGEST.
#    `--platform=linux/amd64` is required, not incidental: the base is built on
#    ubuntu-latest (.github/workflows/warm-base.yml), so its manifest is
#    amd64-only and a bare `COPY --from=<ref>` fails on an arm64 host with "no
#    match for platform in manifest" — which would have blocked every Apple
#    Silicon developer from building this image at all.
#
#    Forcing the platform is safe here and nowhere else: the base is FROM
#    scratch and holds only model weights — inert data, never executed, byte-
#    identical on every architecture. See docker/Dockerfile.warm-base for why
#    it is pinned by digest rather than tag.
FROM --platform=linux/amd64 ghcr.io/marcusk639/rag-warm-base@sha256:6c518bd041a895f9f6fcf7427e452ce2f02aaff2ef0c175c4be9fb613acccb48 AS warmcache

# ── runtime: minimal final image — only /deploy content lands here
FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=pruner --chown=node:node /deploy .
# COMPLIANCE_MODE=client-data's boot gate (packages/core/src/config.ts) reads
# docs/compliance/vendor-dpa-*.md relative to cwd at runtime — pnpm deploy's
# pruned output doesn't include it, so copy it separately from installer.
COPY --from=installer --chown=node:node /workspace/docs/compliance ./docs/compliance
# Pre-warmed local ONNX embedding model cache, pulled from the shared base
# image (docker/Dockerfile.warm-base, published by
# .github/workflows/warm-base.yml). Pinned BY DIGEST, not by tag, so an
# upstream rebuild cannot silently change the weights this image ships —
# changing the model is a reviewable commit that moves this line.
#
# Fetched once for all three services instead of three times per release.
# HF_CACHE_DIR must name the SAME absolute
# path the warm wrote to: a `~/.cache/huggingface` default would silently miss
# this COPY, since $HOME here need not match the warm stage's.
ENV HF_CACHE_DIR=/app/.hf-cache
COPY --from=warmcache --chown=node:node /hf-cache ./.hf-cache

USER node
ENV NODE_ENV=production

# Exposed when MCP_TRANSPORT=http (set MCP_HTTP_PORT to override default 3001).
# stdio transport uses no port — omit EXPOSE in that deployment mode.
EXPOSE 3001

CMD ["node", "dist/main.js"]
