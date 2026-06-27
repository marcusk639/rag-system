---
name: judge-review
description: Adversarial pre-review pass for rag-system code changes. Uses Tier C model (OpenRouter DeepSeek V4 Flash). Returns structured JSON findings before human review.
allowed-tools: Read, Grep, Glob, Bash
---

# Judge Review — rag-system

Run this skill after any multi-file change in rag-system, before creating a PR.

## When to invoke

- After any change touching 2+ files across packages
- Before creating a PR
- Skip for: documentation updates, pnpm-lock.yaml only, test-fixtures only

## Model to use

Use `TIER_C_MODEL` (OpenRouter DeepSeek V4 Flash via `$OPENROUTER_API_KEY`).
Escalate to Tier B ONLY if the change touches:

- `packages/core/` (shared type contracts across packages)
- `apps/api/` auth middleware or OIDC provider
- `packages/db/` schema migrations

## Judge prompt template

Use this prompt with the Tier C model, substituting [DIFF] with the actual code change:

---

You are an adversarial code reviewer for a TypeScript pnpm monorepo RAG system with packages: @rag/api (Fastify), @rag/mcp (MCP server), @rag/worker (pg-boss), @rag/rag (embeddings/retrieval), @rag/db (Drizzle/pgvector), @rag/connectors (SharePoint/Drive/Gmail), @rag/ingestion, @rag/services, @rag/runtime.

Review the following code change and check for ALL of the following issues:

1. Missing Zod validation on new Fastify route input (body, params, querystring)
2. Auth middleware (`authenticate` hook) not applied to new protected endpoints
3. Missing error handler registration on new pg-boss job types (unhandled job failures silently drop)
4. Drizzle query using `.execute()` without `await` (silent no-op)
5. New MCP tool missing `inputSchema` Zod validation
6. LocalEmbeddingProvider dimension mismatch — new embedding calls not checking vector(768) constraint
7. Missing `await` on async Fastify lifecycle hooks (onRequest, preHandler)
8. New connector not implementing the full `ConnectorService` interface contract

CODE CHANGE:
[DIFF]

Return a JSON object with this exact schema:
{
"issues": [
{
"severity": "critical" | "high" | "medium" | "low",
"location": "filename:line",
"rule": "one of the 8 checks above",
"description": "specific description of the problem",
"suggestion": "specific fix"
}
],
"verdict": "approve" | "revise",
"summary": "one sentence overall assessment"
}

## verdict is "revise" if ANY critical or high severity issue exists.

## Output

Returns raw JSON. Review issues before merging. Does NOT block commits.
