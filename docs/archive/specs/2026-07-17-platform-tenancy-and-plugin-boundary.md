# Platform Model: Per-Tenant Provisioning + Vertical Plugin Boundary

**Status:** Design — 2026-07-17.
**Purpose:** Make `rag-system` a reusable **core platform** that serves many firms/businesses **without forking the code**. Two mechanisms replace "a fork per customer": (1) a **per-tenant provisioning template** — one command stands up an isolated instance parameterized by config + data; (2) a **vertical plugin boundary** — domain logic (e.g. CPA) is a package that implements core interfaces, not a copy of core.

**Grounded in the real code:** core interfaces in `packages/core/src/interfaces.ts`; provider factories `createConnector` (`packages/connectors/src/factory.ts:40`), `createEmbeddingProvider` (`packages/rag/src/embeddings/factory.ts:17`), `createGenerator` (`packages/rag/src/generation/generator.ts:270`), `createReranker`, `createAuthProvider` (`packages/core/src/auth-provider-factory.ts:52`); composition root `buildCoreDeps(config, logger)` (`packages/runtime/src/index.ts:115`); config via `loadConfig()`.

---

## 1. The three layers (what lives where)

| Layer                    | Repo/package                                                              | Varies by                           | Never contains                                       | Updated by                              |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| **Core**                 | `rag-system` (one versioned codebase + Docker images)                     | nothing per tenant                  | tenant config, domain rules                          | — (it IS the source of truth)           |
| **Vertical plugin**      | a package, e.g. `@rag/plugin-cpa`, in the product repo (`cpa-consulting`) | domain (CPA vs veteran-claims vs …) | tenant secrets/sources, the confidentiality boundary | bump its `@rag/core` dependency version |
| **Tenant config + data** | `tenants/<name>.env` + the tenant's own DB                                | firm/business (the pilot vs firm B) | any code                                             | it's just config — nothing to "update"  |

**The load-bearing rule:** the confidentiality/scoping/audit boundary (per-user scope, `dataClass` gate, `resolveSourceIdsForUser`, `InternalScopeAuthProvider`) lives **only in core**. Plugins add domain _behavior_ (classification, prompting, connectors) but can never widen or reimplement the security boundary — same rule the Teams-bot design enforced.

> **Anti-pattern this replaces:** forking core per customer. Forks accrue local edits → every core update is an N-way merge conflict → a security fix must be hand-merged into every fork (miss one = a customer runs vulnerable). What differs per customer is **config + data**, not code, so we vary those axes directly.

---

## 2. Per-tenant provisioning template

**Goal:** `provision-tenant kb` → a fully isolated, running the firm instance on the same images every other tenant runs.

### 2.1 Isolation guarantees (decision D5, `PLAN-LAUNCH-READINESS.md`)

Each tenant gets its **own** Postgres database + volume, its **own** connector credentials, its **own** secrets. **No shared, commingled `tenant_id` database.** Tenants never share data at rest; a query in tenant A physically cannot reach tenant B (different DB). This is the compliance story, not a cost optimization.

### 2.2 The provisioning unit

`docker/compose.prod.yml` (the full stack: postgres · parser · api · mcp · worker · web · teams-bot) parameterized entirely by an env file. The **only** per-tenant artifact is `tenants/<name>.env` (+ a secrets file). Same images, different env → different tenant.

### 2.3 The per-tenant env contract

Every value below flows through `loadConfig()`; nothing is hard-coded. Grouped:

```
# --- identity / storage (isolated per tenant) ---
TENANT_NAME=kb
DATABASE_URL=postgres://…/<tenant-db>        # own DB
DATABASE_SSL=require
OBJECT_STORE_…=<tenant bucket/prefix>        # own originals store
# --- providers (compliance-driven; see the DPA analysis) ---
EMBEDDING_PROVIDER=local                      # corpus never leaves at ingest
GENERATION_PROVIDER=<gemini|openai|anthropic> + its API key
EGRESS_ALLOWED_HOSTS=<only the generator's host>
COMPLIANCE_MODE=client-data                   # if client-adjacent
# --- connectors (tenant's own source systems) ---
MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET   # this firm's SharePoint app
# --- auth (tenant's own Entra tenant) ---
AUTH_ENTRA_TENANT_ID / CLIENT_ID / SECRET / AUTH_SECRET / RAG_ADMINS_GROUP_ID
# --- Teams bot (if enabled) ---
MICROSOFT_APP_ID / PASSWORD / BOT_ENTRA_SSO_SCOPE / BOT_OAUTH_CONNECTION_NAME
# --- shared secrets (generated per tenant) ---
INTERNAL_SCOPE_JWT_SECRET / PARSER_SECRET     # openssl rand -hex 32
# --- vertical plugin selection (§3) ---
PLUGINS=cpa
# --- branding ---
APP_NAME="<Firm> Knowledge Base"  /  domain
```

### 2.4 `scripts/provision-tenant.sh <name>` — the one command

1. **Load** `tenants/<name>.env`; **generate** any missing secrets (`INTERNAL_SCOPE_JWT_SECRET`, `AUTH_SECRET`, `PARSER_SECRET`) into `tenants/<name>.secrets.env` (git-ignored).
2. **Provision isolated storage**: create the tenant's Postgres DB + encrypted volume (compose volume pinned to an encrypted disk, or a Railway project's managed volume) + object-store bucket/prefix.
3. **Boot in migration order** (the repo's deploy-ordering rule): start `postgres` + `parser` → run migrations via the **worker** (`rag-worker` `preDeployCommand`, the single migration owner) → then start `api`/`mcp`/`web`/`teams-bot` (they boot with the index-assert once the schema exists).
4. **Register sources**: `POST /sources` (admin token) for each configured SharePoint site (scoped to the audited research/SOP libraries — see the content-audit gate), then `POST /sources/:id/sync {mode:"full"}`.
5. **Smoke**: `/ready` 200 after migrations; one `/ask` returns a real answer against the seeded sources.

`scripts/redeploy-tenant.sh <name>` = pull the new core image tag + `compose up -d` (or Railway redeploy). **No merge, ever** — the tenant holds no code, only config + data.

### 2.5 Railway mapping (the live target)

One **Railway project (or environment) per tenant**, same service definitions (`railway.json` per app), env scoped to that project. `rag-worker` owns migrations via its `preDeployCommand`. Per-tenant volume = that project's Postgres volume. (`docs/DEPLOYMENT-TARGET.md` still says "VM+compose" — that's stale; Railway is the live target, and the compose file remains a valid self-host option.)

---

## 3. Vertical plugin boundary

**Goal:** CPA-specific behavior (and later veteran-claims, etc.) is a **package that implements core interfaces**, wired at composition, not a fork.

### 3.1 The extension points core already exposes

Core defines these interfaces (`packages/core/src/interfaces.ts`) — the seams a plugin implements:

| Interface                    | Line | What a vertical plugin would customize                                                                                               |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Connector`                  | :164 | a domain-specific source (e.g. a practice-management system)                                                                         |
| `EmbeddingProvider`          | :14  | rarely — usually stays `local` for compliance                                                                                        |
| `Generator`                  | :46  | domain prompt framing / answer style (CPA disclaimer, tax-aware system prompt)                                                       |
| `Reranker`                   | :82  | domain-tuned reranking (e.g. favor lexical for CPA jargon: BOI, K-1, UPE)                                                            |
| `Chunker`                    | :121 | domain-aware chunking (e.g. keep IRS-form line items together)                                                                       |
| _(new)_ `DocumentClassifier` | —    | **the primary CPA seam**: SOP vs template vs research vs client-example → `dataClass`/`contentType` (the deferred classifier design) |

### 3.2 The one enabling refactor core needs (make factories _open_)

Today the factories are **closed switches** — e.g. `createConnector` (`connectors/src/factory.ts:40`) is `switch(kind){ case "sharepoint": … }`, and `createEmbeddingProvider`/`createGenerator` are similar. A plugin can't add a connector/classifier without editing core.

**Change:** turn each factory into a **registry** that plugins populate at startup:

```ts
// @rag/core — a tiny registry per extension point
export interface PluginRegistry {
  registerConnector(kind: string, make: ConnectorFactory): void;
  registerGenerator(name: string, make: GeneratorFactory): void;
  registerReranker(name: string, make: RerankerFactory): void;
  registerChunker(name: string, make: ChunkerFactory): void;
  registerClassifier(name: string, make: ClassifierFactory): void;
}

// A plugin is just: export function register(reg: PluginRegistry): void
export interface RagPlugin {
  name: string;
  register(reg: PluginRegistry): void;
}
```

`buildCoreDeps` builds a registry, seeds it with the **built-in** implementations (the current switch cases become default registrations), then loads the plugins named in `config.plugins` (`PLUGINS=cpa`) and calls their `register()`. Selection stays **static + type-safe**: the plugin is a normal dependency in that tenant's image; `PLUGINS` just says which registered impls to activate. No dynamic `import()` of arbitrary paths (keeps the supply chain and the egress boundary auditable).

Migration is **non-breaking**: convert one factory at a time (built-ins register themselves; behavior identical until a plugin adds something).

### 3.3 Plugin package shape (concrete: `@rag/plugin-cpa`)

Lives in the product repo (`cpa-consulting`), depends on `@rag/core` (+ `@rag/rag` for base classes), **never** on tenant config:

```
plugin-cpa/
  src/
    index.ts        # export const plugin: RagPlugin = { name:"cpa", register(reg){…} }
    classifier.ts   # DocumentClassifier: SOP|template|research|example → contentType + dataClass
    generator.ts    # Generator wrapper adding CPA system-prompt framing (wraps core generator)
    reranker.ts     # (optional) lexical-favoring reranker for tax jargon
  package.json      # deps: @rag/core, @rag/rag
```

`register()` calls `reg.registerClassifier("cpa", …)`, `reg.registerGenerator("cpa", …)`, etc. A firm's tenant sets `PLUGINS=cpa` + `CLASSIFIER=cpa` in its env; the image includes `@rag/plugin-cpa`. Firm B on the same vertical reuses the _same plugin_, different tenant config. A different business writes its own plugin; core is untouched.

### 3.4 What a plugin must NOT do (the boundary's hard edges)

- Never touch the scope/audit/`dataClass`-gate machinery — those stay in core; a plugin only _classifies_ into `dataClass`, it doesn't _enforce_ access.
- Never read tenant secrets/sources directly — it receives only what core hands its interface methods.
- Never call an external service outside `EGRESS_ALLOWED_HOSTS` — egress stays core-enforced.

---

## 4. How this delivers exactly what was asked ("core forked per problem, each updated from core")

- **"A KB for firm A vs firm B"** → two **tenant instances** (`tenants/kb.env`, `tenants/firmB.env`), same images + same `@rag/plugin-cpa`. Different SharePoint, creds, DB, branding — all config.
- **"A different business"** → its own tenant instance + (if its domain differs) its own plugin package. Core unchanged.
- **"Each gets updated from core"** → `redeploy-tenant <name>` pulls the new core image tag. Security fixes reach every tenant by redeploy, not by N merges. Plugins bump a dependency version.
- **A genuine hard fork** is reserved for a deployment that will _never_ re-sync (a permanent divergence) — the opposite of "updated from core", so not used here.

---

## 5. Build order (if we implement this)

1. **Registry refactor in core** (non-breaking): introduce `PluginRegistry` + `RagPlugin`; convert `createConnector`/`createGenerator`/`createReranker`/`createChunker` to register built-ins into it; `buildCoreDeps` loads `config.plugins`. Ship a `DocumentClassifier` interface + a default no-op classifier.
2. **Provisioning template**: `tenants/<name>.env` contract + `scripts/provision-tenant.sh` + `scripts/redeploy-tenant.sh`, mapped to Railway (per-tenant project) with the worker-first migration order.
3. **`@rag/plugin-cpa`** (in `cpa-consulting`): the CPA `DocumentClassifier` first (the real domain value), then optional generator/reranker.
4. **Provision the firm** as tenant #1 through the template (local embeddings + chosen external generator, `PLUGINS=cpa`), once the content-audit gate clears.

## 6. Out of scope

- A shared multi-tenant control plane / tenant-admin UI (only needed at many-tenant scale; D5 defers it).
- Dynamic/remote plugin loading (static, in-image plugins only — auditable supply chain).
- Changing the confidentiality model (unchanged; plugins never touch it).
