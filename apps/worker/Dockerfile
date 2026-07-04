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
RUN pnpm install --frozen-lockfile

# ── builder: compile all workspace packages (tsconfig per package)
FROM installer AS builder
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

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

USER node
ENV NODE_ENV=production

# Worker polls pg-boss; no HTTP listener.
# preDeployCommand on Railway runs `pnpm --filter @rag/db migrate` before this
# service starts — worker is the designated migration owner (see DEPLOYMENT.md).
CMD ["node", "dist/main.js"]
