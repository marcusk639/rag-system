---
title: Design decisions
status: current
last_verified: 2026-10-21
verified_against: 89ca54a
answers: Why the system is built the way it is — each durable design decision, the alternatives rejected and why, and whether it still holds.
read_when: Before changing a structural choice (queue, vector store, auth, scoping, tenancy, egress, migrations), or when a review flags something that may be deliberate.
supersedes:
  [
    QUEUE-ARCHITECTURE-REVIEW.md (decision),
    DEPLOYMENT-TARGET.md (D1),
    design rationale in archived plans and specs,
  ]
code:
  [
    packages/ingestion/src/queue.ts,
    packages/core/src/internal-scope-auth.ts,
    packages/core/src/egress-policy.ts,
    apps/teams-bot/src/scope.ts,
  ]
---

# Design decisions

This is the log of durable design decisions: what was chosen, why, what was rejected, and whether it still holds.
It records reasons, not mechanism. How each piece works today is in [`ARCHITECTURE.md`](./ARCHITECTURE.md) and
[`RETRIEVAL.md`](./RETRIEVAL.md), and the ground rules are in the root [`CLAUDE.md`](../../CLAUDE.md). If a choice
below looks wrong, read its entry before changing it: most were made after the obvious alternative failed or was
measured.

## How entries work

- Each entry is `D-<nn>`, numbered once and never reused. Headings are stable anchors.
- **Date** is when the decision was made, from the source document or the commit that shipped it.
- **Status** is one of: `active` (true in the code today); `superseded-by-D-<nn>`; `revisit-when-<trigger>` (active,
  with a named condition that reopens it); `not adopted` (designed or proposed, never built).
- **Source** is the archived plan, spec or review the decision came from. Those are history; where they disagree with
  this file or the code, the code wins.
- Questions not yet decided live in [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md), not here.

## Index

| ID                                                               | Decision                                                          | Date       | Status                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- | --------------------------------------- |
| [D-01](#d-01-rag-system-is-the-platform-of-record)               | rag-system is the platform; cpa-backend retired, not ported       | 2026-06-23 | active                                  |
| [D-02](#d-02-single-vm-and-docker-compose-for-tenant-1)          | Single VM + docker-compose for tenant #1 (D1)                     | 2026-06-14 | superseded-by-D-03                      |
| [D-03](#d-03-railway-is-the-deployment-target)                   | Railway is the deployment target                                  | 2026-06-21 | active                                  |
| [D-04](#d-04-host-the-web-app-on-railway-not-vercel)             | Host the web app on Railway, not Vercel                           | 2026-06-21 | active                                  |
| [D-05](#d-05-one-isolated-deployment-per-tenant)                 | One isolated deployment per tenant; no `tenant_id`; no forks (D5) | 2026-06-14 | active                                  |
| [D-06](#d-06-postgres-and-pgvector-for-everything)               | Postgres + pgvector for vectors, data and queue                   | 2026-05-29 | revisit-when-vectors-reach-millions     |
| [D-07](#d-07-pg-boss-is-the-job-queue)                           | pg-boss is the job queue                                          | 2026-06-19 | revisit-when-an-outgrow-trigger-fires   |
| [D-08](#d-08-serialize-syncs-with-the-singleton-queue-policy)    | Serialize syncs with the `singleton` queue policy                 | 2026-06-20 | active                                  |
| [D-09](#d-09-parse-documents-in-a-python-sidecar)                | Parse documents in a Python sidecar                               | 2026-05-29 | active                                  |
| [D-10](#d-10-fuse-dense-and-sparse-results-with-rrf)             | Fuse dense and sparse results with RRF                            | 2026-05-26 | active                                  |
| [D-11](#d-11-mandatory-filters-run-inside-the-candidate-ctes)    | Mandatory filters run inside the candidate CTEs                   | 2026-10-03 | active                                  |
| [D-12](#d-12-structure-aware-chunking)                           | Structure-aware chunking: heading path, table chunker             | 2026-05-26 | active                                  |
| [D-13](#d-13-content-hash-short-circuit)                         | Content-hash short-circuit on re-ingest                           | 2026-05-26 | active                                  |
| [D-14](#d-14-embeddings-are-immutable-per-model)                 | Embeddings are immutable per provider and model                   | 2026-05-29 | active                                  |
| [D-15](#d-15-drizzle-migrations-are-hand-checked-and-when-gated) | Drizzle migrations: bootstrap outside the journal, `when` gating  | 2026-05-26 | active                                  |
| [D-16](#d-16-originals-in-object-storage-and-404-not-403)        | Originals in object storage; out-of-scope download is 404         | 2026-06-26 | active                                  |
| [D-17](#d-17-prefer-deletion-over-abstraction)                   | `@rag/runtime` outside core; prefer deletion over abstraction     | 2026-06-08 | active                                  |
| [D-18](#d-18-the-generator-interface-lives-in-core)              | The `Generator` interface lives in `@rag/core`                    | 2026-06-23 | active                                  |
| [D-19](#d-19-constant-time-bearer-token-comparison)              | Constant-time bearer comparison (SHA-256 + `timingSafeEqual`)     | 2026-05-26 | active                                  |
| [D-20](#d-20-bff-mints-a-scope-assertion-jwt)                    | The BFF mints a short-lived scope-assertion JWT                   | 2026-07-06 | active                                  |
| [D-21](#d-21-scope-secret-handling)                              | Scope secrets: 64+ chars, sign one, verify many, JSON-or-CSV      | 2026-07-06 | active                                  |
| [D-22](#d-22-identity-is-the-aad-oid-and-admin-is-a-group)       | Identity is the AAD `oid`; admin is an AAD group                  | 2026-07-06 | active                                  |
| [D-23](#d-23-browser-talks-only-to-the-bff)                      | The browser talks only to the BFF                                 | 2026-06-16 | active                                  |
| [D-24](#d-24-teams-bot-is-a-bff-with-channel-intersection-scope) | Teams bot is a BFF; channel scope is the member intersection      | 2026-07-16 | active                                  |
| [D-25](#d-25-direct-grants-get-their-own-table)                  | Direct grants get their own table, not a NULL sentinel            | 2026-07-10 | active                                  |
| [D-26](#d-26-audit-stores-the-raw-oid-and-a-question-hash)       | Audit stores the raw `oid` and only a question hash               | 2026-07-08 | active                                  |
| [D-27](#d-27-conversation-memory-b0)                             | Conversation memory B0: client-held history, retrieval-only       | 2026-08-01 | revisit-when-question-retention-decided |
| [D-28](#d-28-chat-sessions-are-ephemeral-in-the-browser)         | Chat sessions are ephemeral in the browser                        | 2026-06-16 | active                                  |
| [D-29](#d-29-reranker-built-but-off)                             | Reranker built but off by default                                 | 2026-06-26 | revisit-when-vendor-dpa-and-gain-shown  |
| [D-30](#d-30-uploads-are-validated-at-the-bff-and-the-api)       | Uploads are validated at both the BFF and the API                 | 2026-06-16 | active                                  |
| [D-31](#d-31-dates-are-evidence-not-a-verdict)                   | Dates in the prompt are evidence, not a verdict                   | 2026-08-03 | active                                  |
| [D-32](#d-32-core-enforces-packs-supply-policy)                  | Core enforces; packs supply policy; no dynamic loading or npm     | 2026-08-03 | active                                  |
| [D-33](#d-33-egress-hardening-rules)                             | Egress hardening rules learned from local generation              | 2026-08-03 | active                                  |
| [D-34](#d-34-never-auto-relax-the-tri-gate-for-local-endpoints)  | Never auto-relax the TRI gate for "local" endpoints               | 2026-08-03 | active                                  |
| [D-35](#d-35-content-safety-layering)                            | Content-safety layering (pointer)                                 | 2026-08-03 | active                                  |
| [D-36](#d-36-approaches-deliberately-not-adopted)                | Approaches deliberately not adopted                               | various    | not adopted                             |

## Platform

### D-01: rag-system is the platform of record

- **Date:** 2026-06-23.
- **Decision:** Build on `rag-system`. The standalone `cpa-knowledge-base` UI mock is deprecated; its shell became
  `apps/web`. `cpa-backend` (Express, Mongo, Vespa) is retired and **not to be ported**; its session-CRUD and
  S3-presign route shapes are reference only.
- **Why:** rag-system returns grounded, cited answers; the other stack's RAG pipeline was dead code with no call
  sites. The weighted comparison scored 6.9 against 2.0.
- **Rejected:** merging the backends (nothing worth merging); continuing the standalone UI (drift).
- **Consequences:** the memo's premise that the SharePoint corpus held no client data was later falsified. That
  changed compliance posture, not this choice.
- **Status:** active. **Source:** [`compliance/records/DECISION-CPA-KB-RAG-CONVERGENCE.md`](../compliance/records/DECISION-CPA-KB-RAG-CONVERGENCE.md);
  `archive/plans/PLAN-LIVE-DEPLOY-AND-CHAT-UI.md` (do-not-port note).

### D-02: Single VM and docker-compose for tenant 1

- **Date:** 2026-06-14 (decision D1).
- **Decision:** One cloud VM running `docker/compose.prod.yml`, with the Postgres volume on an encrypted disk.
- **Why:** low ops burden, full control of the encrypted volume and pgvector image, one data-residency story, and
  the compose file doubled as the per-tenant provisioning unit.
- **Consequences:** `docker/compose.prod.yml` remains a working self-host option, and the VM reasoning (encrypted
  volume; move to namespace-per-tenant Kubernetes only when N compose hosts become unwieldy) still applies to it.
- **Status:** superseded-by-D-03. **Source:** `archive/history/DEPLOYMENT-TARGET.md`; `archive/plans/PLAN-LAUNCH-READINESS.md`.

### D-03: Railway is the deployment target

- **Date:** by 2026-06-21 (Railway services ran the first SharePoint sync).
- **Decision:** Every app deploys to Railway from its own `railway.json`; `rag-worker`'s pre-deploy command is the
  single migration owner.
- **Why:** managed hosting with a private network between services, for no more ops effort than one VM.
- **Rejected:** D-02's single VM; managed Postgres (production runs the `postgres-ssl` image for the reasons in the
  root `CLAUDE.md`).
- **Status:** active. Services and deploy order: [`../operations/DEPLOYMENT.md`](../operations/DEPLOYMENT.md).
  **Source:** `archive/history/PHASE-3-FIRST-SYNC-RESUME.md`; `archive/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md` §2.5.

### D-04: Host the web app on Railway, not Vercel

- **Date:** 2026-06-21; deploy config shipped 2026-07-12 (`e285d89`).
- **Decision:** `apps/web` runs as the Railway service `rag-web`.
- **Why:** one platform and bill, and the BFF reaches `rag-api` over the private network
  (`http://rag-api.railway.internal:8080`).
- **Rejected:** Vercel: the best Next.js experience, but a second vendor and a BFF that needs `rag-api` public.
- **Consequences:** `rag-api` still has a public domain for other callers; the BFF just doesn't depend on it.
- **Status:** active. **Source:** `archive/history/PHASE-3-FIRST-SYNC-RESUME.md`.

### D-05: One isolated deployment per tenant

- **Date:** 2026-06-14 (decision D5); restated 2026-07-17.
- **Decision:** Each tenant gets its own deployment: Postgres and volume, connector credentials, secrets, and Railway
  project or environment. No shared database with a `tenant_id` column, and no fork per customer. Tenants differ by
  env file and data; a security fix reaches every tenant by redeploy.
- **Why:** isolation is the compliance story. Tenant A can't reach tenant B because it is a different database, not
  because a filter ran. Forks would turn every security fix into N merges.
- **Rejected:** commingled multi-tenant tables; a hosted multi-tenant control plane; a fork per customer (a hard fork
  is only for a deployment that will never re-sync).
- **Consequences:** the 2026-07-17 provisioning script (`scripts/provision-tenant.sh`), `tenants/` directory and code
  plugin registry were never built; data-first packs ([D-32](#d-32-core-enforces-packs-supply-policy)) replaced the
  registry. Per-source connector credentials, the multi-tenant prerequisite, are not built either.
- **Status:** active for isolation and no-fork; not adopted for the provisioning script and plugin registry.
  **Source:** `archive/plans/PLAN-LAUNCH-READINESS.md`; `archive/specs/2026-07-17-platform-tenancy-and-plugin-boundary.md`.

## Storage, queue and retrieval

### D-06: Postgres and pgvector for everything

- **Date:** 2026-05-29 (initial commit).
- **Decision:** Embeddings, documents, sources, ingestion history and the job queue share one Postgres with pgvector
  HNSW.
- **Why:** one database gives uniform backups, point-in-time recovery and access control; metadata filters are plain
  SQL; HNSW is competitive with dedicated stores up to several million vectors.
- **Rejected:** a dedicated vector store (Pinecone, Weaviate, Qdrant, Milvus): a second stateful system and filter
  language.
- **Status:** revisit-when-vectors-reach-millions; even then IVFFlat or a read replica comes before a new store.
  **Source:** archived `ARCHITECTURE.md` "Why these specific choices" (git `6d5b458^`).

### D-07: pg-boss is the job queue

- **Date:** chosen 2026-05-29; reaffirmed by the queue review on 2026-06-19.
- **Decision:** Keep pg-boss in the same Postgres. Changing queue library needs its own decision with an outgrow
  trigger met.
- **Why:** job rate is tiny (one job covers a few pages of one source), so pg-boss's ceiling is orders of magnitude
  above need. It adds no infrastructure. Enqueue shares a database with the app's bookkeeping, so there is no
  dual-write "committed one, lost the other" hazard. Singleton keys, retries with backoff, expiry, archival,
  graceful drain and row-locked dispatch are built in.
- **Outgrow triggers:** per-document or per-page fan-out at thousands of jobs per second; a need for sub-second
  pickup; Postgres becoming the contention point.
- **Consequences:** the review's real finding, coarse whole-sync jobs, was fixed with per-page continuation, not a new
  queue. Keep `singletonKey`, and keep `triggerSync` the only writer of `ingestion_jobs` rows. There is no
  dead-letter queue ([`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md)).
- **Status:** revisit-when-an-outgrow-trigger-fires. **Source:** `archive/reviews/QUEUE-ARCHITECTURE-REVIEW.md`.

Rejected alternatives for D-07:

| Option                     | Why not                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| BullMQ (Redis)             | A second stateful service and a dual-write hazard; overkill at this job rate          |
| Graphile Worker            | A real peer with lower latency, but pg-boss's feature set is richer and already wired |
| Temporal                   | Best fit for long resumable workflows, but heavy to operate                           |
| SQS / Cloud Tasks / PubSub | Loses transactional enqueue; doesn't fit a persistent worker on Railway               |

### D-08: Serialize syncs with the singleton queue policy

- **Date:** spike 2026-06-19 to 2026-06-20; shipped 2026-06-26 (`f57366c`).
- **Decision:** `createQueue` applies `policy: "singleton"` to `rag.sync_source` with `boss.updateQueue` on every boot
  (`packages/ingestion/src/queue.ts`).
- **Why:** under the default `standard` policy a `singletonKey` deduplicates nothing; pg-boss gates its uniqueness
  indexes on policy. `singleton` allows one active job per key and queues the rest, so a per-page continuation can
  queue behind its own job while two jobs never race on `sources.cursor`.
- **Rejected:** dropping and recreating the queue (`updateQueue` is idempotent and reversible); `boss.insert` for the
  continuation (no singleton support); `singletonNextSlot` (changes timing).
- **Consequences:** a duplicate external trigger now queues instead of returning 409. Whether to restore a hard
  reject with a `running`-row guard is undecided ([`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md)).
- **Status:** active. **Source:** `archive/plans/PLAN-PER-PAGE-REENQUEUE.md`.

### D-09: Parse documents in a Python sidecar

- **Date:** 2026-05-29.
- **Decision:** All format conversion runs in `services/parser-py`, a separate container, and Python stays there.
- **Why:** the long tail (legacy `.doc`, scanned PDFs, complex spreadsheets) is materially better served in Python,
  and heavy native dependencies (LibreOffice, Tesseract, Poppler) stay out of the TypeScript images.
- **Rejected:** TypeScript parsers (`pdf-parse`, `mammoth`): weaker on the long tail.
- **Consequences:** the wire format is camelCase via pydantic aliases to match the consumer; TS types are generated
  from the parser's OpenAPI schema (`pnpm gen:parser-types`), and parser output isn't re-validated at runtime.
- **Status:** active. **Source:** archived `ARCHITECTURE.md` (git `6d5b458^`); `archive/history/SESSION-2026-05-26.md`.

### D-10: Fuse dense and sparse results with RRF

- **Date:** 2026-05-26.
- **Decision:** Reciprocal Rank Fusion, `k = 60`, weighted 0.7 dense and 0.3 sparse by default and overridable per
  query.
- **Why:** dense search misses identifiers and sparse misses paraphrases. RRF fuses by rank, so the scale mismatch
  between cosine similarity and unbounded `ts_rank_cd` doesn't matter.
- **Rejected:** score-level fusion (needs a normalization the arms don't share). For the sparse arm,
  `plainto_tsquery` and `websearch_to_tsquery` were rejected because both AND every term, which left the arm dead on a
  third of real questions; it uses an OR `tsquery`.
- **Status:** active ([mechanism](./RETRIEVAL.md#hybrid-search)). **Source:** `archive/history/SESSION-2026-05-26.md`;
  `archive/reviews/PROTOTYPE-READINESS-REVIEW-2026-08-01.md` (H-1).

### D-11: Mandatory filters run inside the candidate CTEs

- **Date:** 2026-10-03 (`e834dd0`).
- **Decision:** The ACL and the withdrawal gate run inside both candidate CTEs, before `LIMIT pool`, and again in the
  final `SELECT`.
- **Why:** as post-filters, unreadable or withdrawn chunks still took candidate slots and pushed servable chunks out
  of the pool, giving a silently short result list. The adaptive retry hid this for scoped users but not for an admin
  query with no caller filter.
- **Rejected:** the 2026-05-26 design of filtering only in the outer `SELECT`, chosen so HNSW could serve the dense
  arm unfiltered.
- **Consequences:** the planner may sequential-scan the filtered dense arm, which is faster at today's corpus size.
  `hnsw.iterative_scan` waits on the production pgvector version (UNVERIFIED; see
  [`RETRIEVAL.md`](./RETRIEVAL.md#filter-placement)).
- **Status:** active. **Source:** commit `e834dd0`; `archive/history/SESSION-2026-05-26.md`.

### D-12: Structure-aware chunking

- **Date:** 2026-05-26.
- **Decision:** Markdown splits by heading hierarchy, keeps code blocks whole and prefixes each chunk with its
  heading path. Spreadsheets skip the markdown chunker and go to `TableChunker`, which repeats the header in every
  chunk, never splits a row and overlaps 2 rows (`apps/worker/src/deps.ts` `rowOverlap: 2`).
- **Why:** vectors score chunks in isolation, and the heading path restores the context the split removed. A
  recursive splitter slices tables and fences. A spreadsheet's markdown is its rendered tables, so both chunkers
  would duplicate chunks; the row overlap keeps a totals row next to the rows it sums.
- **Rejected:** a naive recursive splitter; text-to-SQL routing for tabular sheets (deferred until a workload needs
  it).
- **Status:** active ([mechanism](./RETRIEVAL.md#chunking)). **Source:** `archive/history/SESSION-2026-05-26.md`.

### D-13: Content-hash short-circuit

- **Date:** 2026-05-26.
- **Decision:** `ingestOne` (`packages/ingestion/src/pipeline.ts`) skips parse, chunk and embed when a document's
  content hash is unchanged. A matching hash with no chunks is treated as changed, so a half-ingested document heals.
- **Why:** most of a re-sync is unchanged files, and retries become nearly free.
- **Status:** active. **Source:** `archive/history/SESSION-2026-05-26.md`.

### D-14: Embeddings are immutable per model

- **Date:** 2026-05-29.
- **Decision:** Each chunk records `embedding_provider` and `embedding_model`; dense search compares only chunks from
  the active embedder. Changing model means re-embedding.
- **Why:** vectors from different models aren't comparable, and mixing them degrades ranking silently.
- **Status:** active ([procedure](./RETRIEVAL.md#changing-the-model)). **Source:** root `CLAUDE.md`;
  `packages/db/src/schema.ts`.

### D-15: Drizzle migrations are hand-checked and when-gated

- **Date:** 2026-05-26 (bootstrap outside the journal); guard test 2026-07-08 (`df6541d`).
- **Decision:**
  - `0000_init.sql` is idempotent and applied outside Drizzle's journal.
  - A migration is hand-authored whenever `drizzle-kit`'s diff would touch objects it can't see; `0002` was, to keep
    the HNSW and GIN indexes and the tsvector trigger.
  - Journal `when` values must strictly increase, enforced by `packages/db/src/migration-guard.test.ts`.
  - UUID keys use `uuid_generate_v4()` from `uuid-ossp`.
- **Why:** Drizzle's breakpoint parser can't split `DO $$` blocks and triggers. Drizzle runs an entry only if its
  `when` exceeds the `MAX(created_at)` already applied, so a lower `when` (usually from a merge resolution) is skipped
  silently and forever; this has happened here. `pgcrypto` isn't installed, and `gen_random_uuid()` would drift from
  the schema defaults.
- **Rejected:** generating every migration with `drizzle-kit generate` (it emits `DROP INDEX` for the search
  indexes); relying on review to catch `when` order.
- **Consequences:** migrations are forward-only, and concurrent branches agree migration numbers up front. A
  hand-applied migration must also write its tracking row
  ([procedure](../operations/BACKUP-AND-RECOVERY.md#applying-a-drizzle-migration-by-hand)).
- **Status:** active ([mechanism](./ARCHITECTURE.md#two-phase-migrations)). **Source:**
  `archive/plans/PLAN-POST-MERGE-FOLLOWUPS.md`; `archive/plans/PLAN-PILOT-READINESS-AUTOMATABLE.md`; the `0002` header.

### D-16: Originals in object storage and 404 not 403

- **Date:** 2026-06-26 (`f57366c`).
- **Decision:** Original bytes go to an S3-compatible `ObjectStore` (`packages/core/src/interfaces.ts`), never a
  Postgres `bytea` column. A download that is out of scope, missing or not stored returns 404, as `getDocumentById`
  does.
- **Why:** large blobs stay out of the primary database. A 403 would confirm that a document the caller can't see
  exists.
- **Rejected:** `bytea` storage; 403 for out-of-scope.
- **Consequences:** a deployment without a bucket still runs; downloads just 404.
- **Status:** active. **Source:** `archive/plans/PLAN-SHAREPOINT-READINESS.md`.

## Code structure

### D-17: Prefer deletion over abstraction

- **Date:** 2026-06-08 (`c9279ce`).
- **Decision:** The composition root `buildCoreDeps` lives in its own `@rag/runtime` package, not `@rag/core`.
  Duplicated logic gets one owner, not a framework: no `BaseConnector` class, no DI container or service registry, no
  `withGeneration` flag or options bags. Connectors share two small utilities. MCP HTTP keeps its Origin allowlist and
  zero-token refusal although the token check is shared. A connector's `done` means the feed is exhausted, not that a
  page was empty.
- **Why:** `@rag/core` is the dependency-free contracts package; a factory there would import db, rag and ingestion
  and form a cycle. Abstractions for imagined variation had produced the duplicated paths being removed. The MCP
  extras defend against browser DNS-rebinding, which the API doesn't face.
- **Status:** active. **Source:** `archive/plans/PLAN-FIVE-SYSTEMS.md`.

### D-18: The Generator interface lives in core

- **Date:** 2026-06-23 (option D-1a); shipped 2026-06-26.
- **Decision:** `Generator` and `GenerationResult` are declared in `packages/core/src/interfaces.ts` beside the other
  provider interfaces and re-exported from `@rag/rag`.
- **Why:** `@rag/test-fixtures`' `FakeGenerator` needs the type, and `@rag/rag`'s tests depend on the fixtures, so
  importing it from `@rag/rag` would be a declared dependency cycle.
- **Rejected:** leaving `FakeGenerator` out of the shared fixtures (D-1b).
- **Status:** active. **Source:** `archive/plans/2026-06-23-test-fixtures-package.md`.

### D-19: Constant-time bearer token comparison

- **Date:** 2026-05-26.
- **Decision:** Static bearer tokens are compared as SHA-256 digests with `timingSafeEqual`, checking every candidate
  even after a match (`packages/core/src/auth.ts`).
- **Why:** `Set.has` leaks through timing; hashing first equalizes lengths so neither length nor content leaks.
- **Status:** active. **Source:** `archive/history/SESSION-2026-05-26.md`.

## Authentication and scope

### D-20: BFF mints a scope-assertion JWT

- **Date:** 2026-07-06 (design); shipped 2026-07-07 (`e8aba14`).
- **Decision:** The web BFF signs the user in with Entra, resolves their source grants from Postgres, and sends the
  API an HS256 JWT with a 60-second expiry asserting `allowedSourceIds`. The API verifies it with
  `InternalScopeAuthProvider` (`packages/core/src/internal-scope-auth.ts`) inside the composite provider.
- **Why:** it reuses the per-user grant tables and the pluggable `AuthProvider` pattern, and any surface that can
  identify its user can mint the same token ([D-24](#d-24-teams-bot-is-a-bff-with-channel-intersection-scope)). A
  60-second token needs no revocation list: a revoked grant stops on the next request.
- **Rejected:** forwarding the user's Entra token and mapping AAD groups with `OIDC_SCOPE_MAP` (one AAD group per
  client engagement, and it ignores the database grants); an HMAC-signed scope header (same idea, bespoke protocol);
  the earlier third-party session provider plus a static service token (removed).
- **Consequences:** `algorithms: ["HS256"]` is passed explicitly to block `alg: none` and algorithm swaps. A failed
  grant lookup fails closed, and an empty list becomes deny-all. `WEB_AUTH_MODE=static-fallback` is a temporary
  break-glass only.
- **Status:** active ([web wiring](../../apps/web/CLAUDE.md)). **Source:** `archive/specs/2026-07-06-web-app-auth-design.md`.

### D-21: Scope secret handling

- **Date:** 2026-07-06; JSON-array form 2026-07-08 (`1e884db`).
- **Decision:** Scope secrets must be at least 64 characters (32 random bytes as hex), checked when signing
  (`signInternalScopeToken`) and when the API loads config. The BFF signs with one secret (`INTERNAL_SCOPE_JWT_SECRET`);
  the API verifies against a list (`INTERNAL_SCOPE_JWT_SECRETS`). Multi-value secrets parse as a JSON array, or as
  comma-separated values when the value doesn't start with `[` (`packages/core/src/config.ts` `parseMultiValueSecret`).
- **Why:** this secret has the largest blast radius in the system: a leak forges a token for every source. One signer
  and many verifiers gives zero-downtime rotation (add, deploy, wait out the 60-second tokens, remove). JSON covers
  values containing a comma; CSV keeps deployed values working.
- **Rejected:** changing the delimiter, which would break deployed values.
- **Consequences:** the design also requires a real secret manager and an alert on a sustained rise in verification
  failures. UNVERIFIED: whether either exists in production; settle by checking Railway variables and Sentry alert
  rules.
- **Status:** active. **Source:** `archive/specs/2026-07-06-web-app-auth-design.md`; `archive/plans/PLAN-POST-MERGE-FOLLOWUPS.md`.

### D-22: Identity is the AAD oid and admin is a group

- **Date:** 2026-07-06.
- **Decision:** The identity key is the AAD `oid`, and sign-in fails without it (`apps/web/src/lib/auth.ts`). Admin
  means membership of the `RAG-Admins` group (`RAG_ADMINS_GROUP_ID`); under Entra groups overage, membership is checked
  with Graph `checkMemberGroups` (`apps/web/src/lib/admin-check.ts`). Sign-in uses its own delegated-permission app
  registration, separate from the connectors' application-permission app.
- **Why:** `oid` is immutable while `upn` changes with email. AAD groups already govern the connectors, so there is
  no roles table to drift. Under overage the `groups` claim is absent, and reading that as "not admin" would be wrong.
  Delegated sign-in and app-only Graph access are different flows, and a client secret carries every permission on its
  app.
- **Rejected:** an `is_admin` column or roles table; keying on `upn`; reusing the connectors' app.
- **Status:** active. **Source:** `archive/specs/2026-07-06-web-app-auth-design.md`.

### D-23: Browser talks only to the BFF

- **Date:** 2026-06-16.
- **Decision:** No API credential reaches the browser; Next.js server routes call the API. The middleware exempts
  `/api/auth` and its children by exact-or-child path match only.
- **Why:** a token in the browser can be lifted by anyone. A plain `startsWith("/api/auth")` would also exempt paths
  like `/api/authz`.
- **Rejected:** browser-to-API calls with CORS (`API_ALLOWED_ORIGINS` was never added and isn't needed).
- **Consequences:** the middleware is tested by calling it directly with an encoded session cookie
  (`apps/web/src/middleware.test.ts`).
- **Status:** active. **Source:** `archive/plans/PLAN-CHAT-FRONTEND.md`; `archive/plans/PLAN-POST-MERGE-FOLLOWUPS.md`.

### D-24: Teams bot is a BFF with channel-intersection scope

- **Date:** 2026-07-16 (design and scope code, `38c0826`).
- **Decision:** The Teams bot gets the asker's `oid` from Teams SSO and mints the same scope token as the web BFF. A
  direct message uses the asker's grants. A channel uses the intersection of every member's grants minus
  `client_confidential` sources, in one query (`packages/db/src/queries.ts` `resolveSharedSourceIdsForUsers`,
  `apps/teams-bot/src/scope.ts` `mintScope`).
- **Why:** every member sees a channel answer, so it may only draw on sources every member can read; the intersection
  is leak-free by construction. A guest or member without an `oid` shrinks it toward empty, the safe direction. The
  `client_confidential` exclusion holds even if such a source were granted to everyone. Reusing the single-user grant
  logic keeps DM and channel scope from diverging.
- **Rejected:** the on-behalf-of flow, with the API accepting Entra tokens: a second enforcement path for the
  confidentiality boundary, and an API auth change.
- **Consequences:** the token's `sub` is still the asker, so the audit row names who asked; the bot sends
  `X-RAG-Channel: teams`. The isolation test is mandatory. Deployment state is in
  [`../launch/LAUNCH-STATUS.md`](../launch/LAUNCH-STATUS.md).
- **Status:** active. **Source:** `archive/specs/2026-07-16-teams-bot-design.md`.

### D-25: Direct grants get their own table

- **Date:** 2026-07-10 (`c481929`).
- **Decision:** Per-user, per-source grants live in `staff_source_assignments` beside the client-routed grants and are
  combined with `UNION`, guarded by a negative isolation test.
- **Why:** the alternative needed a NULL-matching join branch that would grant every "direct" user every "direct"
  source.
- **Rejected:** a nullable `clientId` sentinel on the existing assignment table.
- **Status:** active. **Source:** `archive/plans/PLAN-PILOT-READINESS-AUTOMATABLE.md`.

### D-26: Audit stores the raw oid and a question hash

- **Date:** 2026-07-08 (`b287399`).
- **Decision:** `audit_log.principal_subject` holds the raw AAD `oid`. The question is stored only as `question_hash`
  unless `AUDIT_LOG_CONTENT=full` is set deliberately.
- **Why:** requirement CR-10 expects a plain per-user identity in retrieval logs for anomaly detection
  ([`../compliance/REQUIREMENTS.md`](../compliance/REQUIREMENTS.md)). Question text can carry client data, and
  retaining it is a separate privacy decision.
- **Rejected:** hashing or salting the subject.
- **Status:** active. **Source:** `archive/plans/PLAN-POST-MERGE-FOLLOWUPS.md`.

## Answers

### D-27: Conversation memory B0

- **Date:** decided 2026-08-01; shipped 2026-09-16 (`631c5c5`).
- **Decision:** Clients send bounded, client-held `history` with `/ask`. A small model call condenses a follow-up
  into a standalone question used **for retrieval only**; the generator still gets the original question. A
  server-side session store is the eventual destination and isn't built.
- **Why:** a server store creates a transcript retention surface the system has never had, while even retaining
  question text is undecided. Ephemeral history gets the usability win without forcing that decision. History in the
  generation prompt would invite answers from the conversation instead of the documents.
- **Seam rules:** `@rag/services` receives resolved history and doesn't know its origin, so a future store changes
  only the route. The turn window is the condenser's policy (`packages/rag/src/retrieval/contextualize.ts`,
  `maxTurns` default 6); client caps (`MAX_HISTORY_TURNS` = 12) are DoS bounds. No `sessionId` field until something
  honours it.
- **Rejected:** history in the prompt; a server store now. The cpa-consulting "r1" rule-out of query rewriting doesn't
  apply: it covers single-turn vocabulary rewriting, not conversational condensation.
- **Consequences:** the question and the rewrite are both TRI-screened, and a blocked rewrite falls back to the
  original question (`packages/services/src/ask.ts` `retrievalQuery`).
- **Status:** revisit-when-question-retention-decided. **Source:** `archive/plans/superpowers/2026-08-01-reranking-and-conversation-memory.md`.

### D-28: Chat sessions are ephemeral in the browser

- **Date:** 2026-06-16.
- **Decision:** Chat sessions live in React state only, with no tables, persistence endpoints or `localStorage`
  (`apps/web/src/hooks/use-chat-sessions.tsx`). A reload clears them.
- **Why:** no transcript is stored anywhere, which keeps the retention question closed.
- **Consequences:** revised, not replaced, by [D-27](#d-27-conversation-memory-b0): the in-memory session now feeds
  bounded history to `/ask`.
- **Status:** active. **Source:** `archive/plans/PLAN-CHAT-FRONTEND.md`.

### D-29: Reranker built but off

- **Date:** built 2026-06-26; egress and wire-contract fixes 2026-08.
- **Decision:** `RERANK_PROVIDER` defaults to `none`. A hosted reranker is checked against the egress allow-list,
  refuses redirects, and is refused outright under `COMPLIANCE_MODE=client-data` (`packages/rag/src/retrieval/reranker.ts`).
- **Why:** it sends chunk text to a third party, which needs a vendor and DPA decision first, and its gain hasn't been
  measured on the gold set.
- **Consequences:** `pnpm eval` on the starter corpus stays flat with reranking on; that reflects the corpus, not the
  reranker.
- **Status:** revisit-when-vendor-dpa-and-gain-shown ([`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md)). **Source:**
  `archive/plans/superpowers/2026-08-01-reranking-and-conversation-memory.md`.

### D-30: Uploads are validated at the BFF and the API

- **Date:** 2026-06-16 (design); shipped 2026-06-26.
- **Decision:** The BFF (`apps/web/src/app/api/upload/route.ts`) and the API (`apps/api/src/routes/sources.ts`
  `ALLOWED_UPLOAD_MIME`) each check the upload. An unfinished upload feature hides its modal rather than showing a dead
  button.
- **Why:** the API has callers besides the BFF, and the client's declared MIME type can't be trusted on its own.
- **Status:** active. **Source:** `archive/plans/PLAN-CHAT-FRONTEND.md`.

### D-31: Dates are evidence, not a verdict

- **Date:** 2026-08-03 (`896170e`).
- **Decision:** The system prompt tells the model to cite `modified=` dates as evidence and surface conflicts between
  documents, never resolve them (`packages/rag/src/generation/generator.ts`).
- **Why:** a newer file isn't necessarily authoritative; the corpus has year twins and draft-versus-final pairs, and a
  silent pick reads as a confident wrong answer.
- **Rejected:** "prefer the newer document", as planned in the pilot-readiness plan.
- **Status:** active. **Source:** `archive/plans/PLAN-PILOT-READINESS-AUTOMATABLE.md`.

## Safety and egress

### D-32: Core enforces, packs supply policy

- **Date:** 2026-08-03 (design); fail-closed pack loader 2026-09-01 (`a11b44c`).
- **Decision:** `@rag/core` owns the guarantees: the sensitivity gate exists and fails closed, and every answer is
  scoped and audited. A vertical pack (`packs/cpa/pack.yaml`) supplies data only: what trips the gate and what the
  tiers mean. A pack never widens or reimplements enforcement. Named extensions must be compiled into the image;
  nothing loads dynamically, and `@rag/*` isn't published to npm.
- **Why:** otherwise core accumulates every vertical's scanners and regulatory taxonomy. Static extensions keep the
  supply chain auditable. There is no external library consumer, and publishing would put corpus findings from code
  comments on a public registry.
- **Rejected:** code plugins with a registry (the 2026-07-17 design); dynamic module loading; npm publishing.
- **Consequences:** an unknown pack field or an incompatible `PACK_CONTRACT_VERSION` fails boot. The unbuilt slices
  are tracked in [`../specs/multi-vertical-platform.md`](../specs/multi-vertical-platform.md).
- **Status:** active. **Source:** `archive/specs/2026-08-03-multi-vertical-rag-platform-design.md`.

### D-33: Egress hardening rules

- **Date:** 2026-08-03 (`d12ea9a`); redirects 2026-08-31 (`6fc48ab`).
- **Decision:** four rules, each from a defect found after local generation shipped:
  1. Pass security-relevant SDK options unconditionally. A conditional `...(baseURL ? { baseURL } : {})` let the OpenAI
     SDK fall back to `OPENAI_BASE_URL`; the generator now always passes `effectiveBaseURL`.
  2. Check SDK capability claims against the SDK's types before writing a security rationale. Google's SDK does have a
     base-URL option; `GeminiGenerator` pins it and refuses `baseURL`.
  3. Never send a hosted vendor's key to a self-hosted URL. Precedence is explicit key, then a placeholder when
     `GENERATION_BASE_URL` is set, then the embedding key only when vendors match
     (`packages/core/src/generation-credentials.ts` `resolveGenerationCredentials`).
  4. Refuse redirects on egress-checked calls. `assertAllowed` sees only the first hop, and `fetch` re-sends the body on
     307/308 (`packages/core/src/egress-policy.ts` `NO_REDIRECT_INIT`). A provider that needs redirects gets a per-hop
     re-check, not blind following.
- **Why:** each closed a path for the assembled prompt or a production key to reach an unchecked host.
- **Status:** active ([operator guide](../operations/LOCAL-GENERATION.md)). **Source:**
  `archive/plans/superpowers/2026-08-03-local-generation.md` (Corrections).

### D-34: Never auto-relax the TRI gate for local endpoints

- **Date:** 2026-08-03.
- **Decision:** `GENERATION_TRI_POLICY` is never inferred from the generation endpoint. An air-gapped deployment may
  relax it only by setting it explicitly.
- **Why:** "looks local" isn't a security property; `localhost:11434` can be an SSH tunnel to anywhere.
- **Rejected:** inferring a relaxed policy from a local-looking `GENERATION_BASE_URL`. Decided against, not deferred.
- **Status:** active. Why the policy is `warn` today: [`../compliance/CONTENT-SAFETY-DESIGN.md`](../compliance/CONTENT-SAFETY-DESIGN.md).
  **Source:** `archive/specs/2026-08-03-multi-vertical-rag-platform-design.md` §5.2.

### D-35: Content-safety layering

- **Date:** 2026-08-03 onward.
- **Decision:** the content-safety decisions are recorded once, in
  [`../compliance/CONTENT-SAFETY-DESIGN.md`](../compliance/CONTENT-SAFETY-DESIGN.md): redaction is an egress control,
  not a confidentiality control (citations still open the original); identifying patterns block while contextual ones
  only flag; exclusion beats redaction; and there is no NER or Presidio gate.
- **Consequences:** the `data_class` enum collapses Classes C and D, so a change that lets C through lets D through
  (root `CLAUDE.md`, "Effort calibration").
- **Status:** active. **Source:** [`../compliance/CONTENT-SAFETY-DESIGN.md`](../compliance/CONTENT-SAFETY-DESIGN.md).

### D-36: Approaches deliberately not adopted

- **Date:** 2026-06-21 to 2026-09-16.
- **Decision:** none of the approaches in the table below is built, and each needs new evidence before it is proposed
  again.
- **Status:** not adopted. **Source:** `archive/reviews/RAG-CRITICAL-REVIEW-2026-09-16.md`;
  `archive/specs/2026-08-03-multi-vertical-rag-platform-design.md` §7; `archive/off-topic/timeline-weeks/2026-W25-Jun15-to-Jun21.md`.

| Approach                                        | Why not                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Graph RAG (phase 1)                             | Rejected for phase 1 on 2026-06-21. UNVERIFIED: the named re-evaluation trigger isn't in any source |
| LangChain / LangGraph scaffolding               | Conflicts with the transport-agnostic `@rag/services` layer                                         |
| HyDE, multi-query, parent-document retrieval    | Measured neutral-to-negative on single-document procedural corpora; adds a model call per query     |
| MMR diversity                                   | The per-document cap (`MAX_CHUNKS_PER_DOCUMENT`) already provides diversity                         |
| Semantic response caching                       | Low volume, answers must track current documents, and a cache shared across principals leaks scope  |
| HNSW `m`/`ef_construction` tuning, quantization | Irrelevant at the current corpus size                                                               |

The open backlog, including what is deferred rather than rejected, is [`../KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).
