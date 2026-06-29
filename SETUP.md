# rag-system — New Machine Setup

RAG API + MCP server + worker + web UI. TypeScript pnpm monorepo.

## Prerequisites

| Tool           | Version | Install                                                     |
| -------------- | ------- | ----------------------------------------------------------- |
| Node.js        | ≥20     | `brew install node` or [nvm](https://github.com/nvm-sh/nvm) |
| pnpm           | ≥9      | `npm install -g pnpm`                                       |
| Docker Desktop | latest  | [docker.com](https://docker.com)                            |
| Python         | 3.12    | `brew install python@3.12`                                  |

## Clone & Install

```bash
git clone https://github.com/marcusk639/rag-system.git
cd rag-system
pnpm install
```

## Environment

```bash
cp env.example .env
# Fill in values — see inline docs in env.example
```

Key secrets (retrieve from 1Password "rag-system"):

| Variable                                             | Source                                                    |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `GEMINI_API_KEY`                                     | Google AI Studio                                          |
| `API_TOKENS`                                         | Generated (see `scripts/gen-tokens.sh`)                   |
| `API_PRINCIPALS`                                     | Generated (see `scripts/gen-principals.sh`)               |
| `PARSER_SECRET`                                      | Any random string you set                                 |
| `DATABASE_URL`                                       | Local: auto-set by Docker. Railway: see Railway dashboard |
| `MS_CLIENT_ID` / `MS_TENANT_ID` / `MS_CLIENT_SECRET` | Azure Entra app registration                              |
| `OPENAI_API_KEY`                                     | OpenAI dashboard (if using OpenAI embeddings)             |

## Start (local dev)

```bash
# 1. Start Postgres + Python parser sidecar
pnpm docker:up

# 2. Apply DB migrations (first time only, or after schema changes)
pnpm db:migrate

# 3. Run services (each in a separate terminal)
pnpm dev:api       # HTTP API  → localhost:3000
pnpm dev:worker    # Ingestion worker
pnpm dev:mcp       # MCP server (stdio)
pnpm --filter apps/web dev  # Web UI → localhost:3001
```

## Verify

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

## Deployment (Railway)

Services: `rag-api`, `rag-worker`, `rag-mcp`. Deploy order matters — see `docs/DEPLOYMENT.md`.

- Worker deploys first (it runs `pnpm db:migrate` as `preDeployCommand`)
- api/mcp deploy after worker

Railway project IDs and env vars are in the Railway dashboard. API_PRINCIPALS and API_TOKENS must be set before the API accepts requests.

## Useful commands

```bash
pnpm db:studio        # Drizzle Studio — browse DB
pnpm docker:logs      # Tail Postgres + parser logs
pnpm test             # All tests
pnpm typecheck        # Type check all packages
pnpm eval             # Retrieval eval harness
```

## Notes

- `.env` is gitignored — never commit it
- Tool state dirs (`.serena/`, `.scratch/`, `PATHFINDER-*`) are regenerated automatically — do not commit
- Parser runs as a Docker sidecar; if parsing fails, check `docker ps` and `pnpm docker:logs`
- See `CLAUDE.md` for full architectural context
