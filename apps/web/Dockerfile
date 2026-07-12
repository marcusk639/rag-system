# syntax=docker/dockerfile:1
# Production image for @rag/web (Next.js chat UI).
# Build from the REPO ROOT context (pnpm workspace with internal @rag/* deps):
#   docker build -f apps/web/Dockerfile -t rag-web .

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
RUN pnpm install --frozen-lockfile

# ── builder: build @rag/web's two workspace deps, then the Next.js app itself.
#    next.config.ts pins outputFileTracingRoot to the actual workspace root
#    (verified against this repo's real build output, not assumed) so the
#    standalone bundle below lands at a predictable apps/web/server.js path
#    regardless of where the build actually runs.
FROM installer AS builder
RUN pnpm --filter "@rag/core" --filter "@rag/db" run build
RUN pnpm --filter "@rag/web" run build

# ── runtime: minimal final image.
#    Next.js standalone output does NOT include .next/static or public/ —
#    both must be copied in separately (documented Next.js behavior,
#    confirmed against this repo's actual build: no public/ dir exists here).
FROM node:22-slim AS runtime
WORKDIR /app
COPY --from=builder --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static

USER node
ENV NODE_ENV=production
# Standalone server.js binds to this host/port; Railway/compose inject PORT.
ENV HOSTNAME="0.0.0.0"
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
