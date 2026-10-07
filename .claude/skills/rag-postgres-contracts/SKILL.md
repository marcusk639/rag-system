---
name: rag-postgres-contracts
description: This repo's local Postgres/pgvector contracts that a generic Postgres skill cannot see — the 768-dimension chain, the boot-time index assertions, the forward-only migration journal, the intentional image divergence, and which decisions are deliberate so reviewers stop flagging them. Use before any schema, migration, index, embedding-dimension, pgvector or hybrid-retrieval work here, and before trusting a generic postgres-* skill's verdict on this codebase. Triggers on migration, drizzle journal, vector(768), HNSW, pgvector, embedding dimensions, required indexes, REINDEX, hybrid search, RRF, queries.ts size.
---

# rag-postgres Contracts

Thin companion to the user-level `postgres-*` suite. Those skills know Postgres;
this one knows **what is already decided here**. Load a generic skill for the
mechanics, this one for the constraints it cannot see.

## Load the generic skill for mechanics

| Task                                | Generic skill                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| New/edited migration                | `postgres-agents-migration-reviewer`, `postgres-impl-zero-downtime-migrations` |
| Slow query, EXPLAIN                 | `postgres-impl-query-performance-toolkit`                                      |
| Index choice                        | `postgres-impl-indexing-strategy`                                              |
| Vector search, opclass, HNSW tuning | `postgres-impl-pgvector-similarity`                                            |
| tsvector / ranking                  | `postgres-syntax-full-text-search`                                             |
| Bloat, REINDEX, autovacuum          | `postgres-impl-vacuum-bloat`                                                   |
| Drizzle schema/query authoring      | `postgres-drizzle`, `drizzle-orm-expert`                                       |

## The 768-dimension chain — four places, all must agree

1. `chunks.embedding` is `vector(768)` (`packages/db/src/schema.ts`, pinned by
   migration `0000_init.sql`).
2. `EMBEDDING_COLUMN_DIMENSIONS = 768` (`packages/db/src/embedding-dimensions.ts:18`).
3. `assertEmbeddingDimensions(configured)` throws at startup when they disagree
   (same file, line 32).
4. `defaultEmbeddingModel(provider)` (`packages/core/src/config.ts`) picks the
   model: `gemini-embedding-001`, `Xenova/bge-base-en-v1.5`, or
   `text-embedding-3-small`.

All three defaults are 768-compatible, but **only two are natively 768**.
`text-embedding-3-small` is natively 1536 and is truncated by the provider: the
factory threads `dimensions` into `OpenAIEmbeddingProvider`, which passes it to
the API. Gemini does the same via `outputDimensionality`. Do not "fix" the
apparent 1536/768 mismatch — it is handled at the API call.

**`assertEmbeddingDimensions` validates the DECLARED number against the column,
never the model's actual width.** An explicitly mismatched
`EMBEDDING_MODEL` + `EMBEDDING_DIMENSIONS` pair still fails at insert time, not
startup. That gap is known and open.

Changing the embedding model means: re-embed every chunk, change the column, and
drop/rebuild the HNSW index. Embeddings are immutable per
(provider, model, dimensions); `chunks` records the model so mixed-model
collections are detectable.

## Boot-time index assertions

`packages/db/src/required-indexes.ts` exports `REQUIRED_SEARCH_INDEXES` and
`REQUIRED_CHUNK_TRIGGERS` (`chunks_tsv_update`), asserted at startup. api and mcp
**crash-loop** if these are missing. The worker boots _without_ the assert on
purpose — it is the single migration owner and must be able to start on an
un-migrated database to run migrations. Do not add the assert to the worker, and
do not give api/mcp a `preDeployCommand` migration step.

## Migrations are forward-only

`packages/db/drizzle/` plus `meta/_journal.json`. The journal's `when` must be
**strictly monotonic** — this repo has shipped a non-monotonic-timestamp bug.
Before adding a migration, check the journal tail against `origin/main`: another
branch may already hold the next index (0020 and 0021 both landed recently).
Hand-authored migrations here have no `meta/NNNN_snapshot.json`; that is the
established pattern, not an omission.

## Deliberate decisions — do NOT flag these

A generic reviewer will raise all of these. They are intentional:

- **`packages/db/src/queries.ts` exceeds the 800-line cap** and is grandfathered
  (`.claude/rules/quality-gates.md`). Shrink it; never extend the grandfather list.
- **Production Postgres is a different image from local/CI.** Railway runs
  `ghcr.io/railwayapp-templates/postgres-ssl:16.14`; local, the single-VM stack
  and CI run `pgvector/pgvector:pg16`. The divergence is deliberate.
- **`archive_mode=on` and the `postgres` superuser role must keep existing** on
  Railway or pgBackRest WAL archiving stops silently.

## Two operational hazards

**A Postgres image bump can silently invalidate every text index.** `postgres-ssl`
tags track Debian, so a rebuild at the same PG minor can still move glibc. The
image's boot script then runs `ALTER DATABASE ... REFRESH COLLATION VERSION`
_without reindexing_, which silences the warning and destroys the only evidence.
After any image change: check `select version()` for a changed `pgdgNN`, and if it
moved, `REINDEX DATABASE` **before** the refresh — for every connectable database
(`rag`, `postgres`, `template1`, and any `rag_premigration_*` leftovers).

**`railway connect rag-postgres` detects the DB from the image NAME.** It matches
against a keyword list (`postgres`, `mysql`, `redis`, …), so `pgvector/pgvector:pg16`
fails with "No supported database found in service" however it is configured. It
also needs a `DATABASE_URL` on the database service itself. To read production:
`railway ssh --service rag-postgres` — `railway run` cannot resolve the private
hostname.

## Hybrid retrieval shape

Dense (pgvector cosine) + sparse (tsvector) fused with RRF in
`packages/db/src/hybrid-search.ts`. Two invariants:

- **Mandatory filters (unreadable, withdrawn) run INSIDE the dense/sparse
  CTEs, before pool truncation**, so they cannot cost a candidate-pool slot.
  Do not move them outward.
- **Optional caller narrowing (`sourceIds`, the metadata filter) is still
  applied AFTER truncation**, and can crowd a selective query out of the pool —
  returning fewer than `topK` rows with no error. That is why there is a
  single retry at the largest pool the HNSW index can serve
  (`hybrid-search.ts:408`). `enforcedSourceIds` is deliberately not counted
  toward that retry: as a pre-filter it cannot truncate the pool, and counting
  it charged a second round trip to nearly every scoped query.
- `document.url` is assembled there straight from `metadata.url`, and is a
  _separate_ field from the metadata copy. Both are class-gated in
  `packages/core/src/metadata-policy.ts` — gating only one is cosmetic.

## Access-control test trap

`resolveSourceIdsForUser` (`packages/db/src/queries.ts:951`) is a UNION of two
grant paths — `staff_client_assignments` joined through
`source_client_assignments`, and direct `staff_source_assignments` — both
requiring `revoked_at IS NULL`. An empty scope is fail-closed. So a test
authenticating as a fresh user retrieves **zero** documents and can pass for the
wrong reason. Seed a grant for the test user's oid, assert it is non-empty, and
pair any "scoped user CAN see" assertion with a second unassigned identity
asserted to resolve to `[]` — otherwise the test passes against a lookup that
ignores its argument.
