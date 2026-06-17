# syntax=docker/dockerfile:1
# Production image for @rag/api (Fastify HTTP API).
# Build from the REPO ROOT context (pnpm workspace with internal @rag/* deps):
#   docker build -f apps/api/Dockerfile -t rag-api .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# --- deps: install the whole workspace from the lockfile ---
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY tests ./tests
COPY examples ./examples
RUN pnpm install --frozen-lockfile

# --- build: compile all packages + apps (tsc) ---
FROM deps AS build
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

# --- runtime: ship built dist + installed node_modules ---
FROM build AS runtime
ENV NODE_ENV=production
# Railway injects PORT; the app reads API_PORT (default 3000). Map at deploy time.
EXPOSE 3000
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/main.js"]
