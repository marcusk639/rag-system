# syntax=docker/dockerfile:1
# Production image for @rag/teams-bot (Express + botbuilder CloudAdapter).
# Build from the REPO ROOT context (pnpm workspace with internal @rag/* deps):
#   docker build -f apps/teams-bot/Dockerfile -t rag-teams-bot .

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

# ── builder: compile all workspace packages (tsconfig per package)
FROM installer AS builder
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

# ── pruner: extract a self-contained production bundle for this app only.
#    pnpm deploy resolves all prod deps (including workspace packages with their
#    built dist/) into /deploy — no devDeps, no other apps, no monorepo layout.
FROM builder AS pruner
RUN pnpm --filter "@rag/teams-bot" deploy --prod /deploy

# ── runtime: minimal final image — only /deploy content lands here
FROM node:22-slim AS runtime

# Create a non-root user. The official node image provides the 'node' user
# (uid 1000); use it rather than creating a second one.
WORKDIR /app
COPY --from=pruner --chown=node:node /deploy .

USER node
ENV NODE_ENV=production

# Bot Framework CloudAdapter listens here for POST /api/messages; Railway/
# compose healthcheck hits GET /health on the same port.
EXPOSE 3978

CMD ["node", "dist/index.js"]
