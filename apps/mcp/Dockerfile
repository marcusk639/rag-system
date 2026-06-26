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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── builder: compile all workspace packages (tsconfig per package)
FROM installer AS builder
RUN pnpm -r --filter=./packages/* --filter=./apps/* run build

# ── pruner: extract a self-contained production bundle for this app only.
#    pnpm deploy resolves all prod deps (including workspace packages with their
#    built dist/) into /deploy — no devDeps, no other apps, no monorepo layout.
FROM builder AS pruner
RUN pnpm --filter "@rag/mcp" deploy --prod /deploy

# ── runtime: minimal final image — only /deploy content lands here
FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=pruner --chown=node:node /deploy .

USER node
ENV NODE_ENV=production

# Exposed when MCP_TRANSPORT=http (set MCP_HTTP_PORT to override default 3001).
# stdio transport uses no port — omit EXPOSE in that deployment mode.
EXPOSE 3001

CMD ["node", "dist/main.js"]
