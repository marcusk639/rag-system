# Generic Document Classification Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone document classification service — a new repo, `doc-classifier` — that classifies documents by sensitivity tier using direct-identifier detection plus retrieval-augmented, LLM-driven semantic classification, returning a structured result with confidence and cited rationale, exposed over both a REST API and an MCP server.

**Architecture:** A Fastify-based TypeScript service with three cooperating layers: (1) a PII/direct-identifier layer backed by a self-hosted Microsoft Presidio sidecar (Docker), (2) a RAG-grounded LLM classification core that retrieves reference context from an existing `rag-system` deployment and grounds a structured-output LLM call against it, and (3) a confidence gate that forces the most conservative tier and flags for human review below a per-product threshold. An evaluation harness validates classification accuracy against a labeled golden set, weighting false negatives (under-classification) as the worst error type.

**Tech Stack:** TypeScript (Node.js, `NodeNext` module resolution), Fastify, Zod, the Vercel AI SDK (`ai` package, `generateObject` with AI Gateway `provider/model` strings), `@modelcontextprotocol/sdk`, Vitest, pnpm, Microsoft Presidio (Docker sidecar, MIT license).

## Global Constraints

- This service does not duplicate `rag-system`'s retrieval infrastructure (vector DB, embeddings, hybrid search) — it is an HTTP client of `rag-system`'s existing search API, never a reimplementation.
- Every classification result includes a rationale citing which retrieved reference material drove the decision — never a bare tier label.
- Results below a per-product confidence threshold are forced to that product's conservative tier and flagged for human review (`needsReview: true`) — never silently trusted.
- Any direct-identifier finding (SSN, DOB, etc.) forces the conservative tier regardless of the semantic classifier's conclusion.
- Per-product classification configuration (reference source, prompt, thresholds) is external, loaded configuration — never hardcoded per-product logic in this service's own source.
- This is a new, independent repo. It does not block, and is not blocked by, any current work in `rag-system`, `cpa-consulting`, `veteran-claims-app`, or the TWK KB launch — existing consumers adopt it later, optionally, by implementing `rag-system`'s minimal `DocumentClassifier` interface against it.
- Adopt Microsoft Presidio (MIT license, self-hosted sidecar) for direct-identifier detection rather than hand-rolled regex — confirmed as the right building-block choice by dedicated research; see `rag-system/docs/superpowers/specs/2026-07-11-future-generic-classification-service-vision.md` §1.1 for the full rationale and caveats (raw OSS PII-detector accuracy is mediocre — adopt for extensibility infrastructure, not an assumption of high out-of-the-box accuracy).

---

## Source Documents (read before starting)

- `rag-system/docs/superpowers/specs/2026-07-11-future-generic-classification-service-vision.md` — the full design this plan implements, including the build-vs-adopt research findings.
- `rag-system/docs/superpowers/specs/2026-07-11-generic-document-classification-engine-design.md` — the minimal `DocumentClassifier` interface this service's output shape must stay compatible with, for future adoption by existing consumers.
- `veteran-disability-ai-resources/docs/superpowers/specs/2026-07-10-veteran-claims-platform-focus-design.md` §6.2 — one real consumer's eventual use case (veteran-claims-app's Document Workspace), useful for grounding examples in this plan.

## File Structure

New repo at `~/dev/doc-classifier` (created in Task 1):

```
doc-classifier/
├── src/
│   ├── types.ts                          # Task 1 — core shared types
│   ├── server.ts                         # Task 8 — Fastify REST API
│   ├── pii/
│   │   ├── presidio-client.ts            # Task 2
│   │   └── presidio-client.test.ts
│   ├── retrieval/
│   │   ├── rag-client.ts                 # Task 3
│   │   └── rag-client.test.ts
│   ├── config/
│   │   ├── product-config.ts             # Task 4
│   │   └── product-config.test.ts
│   ├── classification/
│   │   ├── classify.ts                   # Task 5
│   │   ├── classify.test.ts
│   │   ├── confidence-gate.ts            # Task 6
│   │   ├── confidence-gate.test.ts
│   │   ├── orchestrator.ts               # Task 7
│   │   └── orchestrator.test.ts
│   ├── mcp/
│   │   ├── server.ts                     # Task 10
│   │   ├── server.test.ts
│   │   └── index.ts
│   └── server.test.ts                    # Task 8
├── eval/
│   ├── golden-set.json                   # Task 9 — synthetic starter fixture
│   ├── eval-stats.ts
│   ├── eval-stats.test.ts
│   └── run-eval.ts
├── config/                               # per-product runtime config (gitignored except .example)
│   └── example.json.example
├── docker-compose.yml                    # Task 2 — Presidio sidecar
├── package.json
├── tsconfig.json
├── README.md
├── AGENTS.md
└── .gitignore
```

Files stay small and single-purpose: PII detection, retrieval, config loading, LLM classification, confidence gating, and orchestration are five separate files because each has one clear responsibility and its own test cycle — the orchestrator (Task 7) is the only file that knows about all of them together.

---

### Task 1: Repo Scaffolding & Core Types

**Files:**

- Create: `~/dev/doc-classifier/package.json`
- Create: `~/dev/doc-classifier/tsconfig.json`
- Create: `~/dev/doc-classifier/.gitignore`
- Create: `~/dev/doc-classifier/src/types.ts`
- Create: `~/dev/doc-classifier/README.md`
- Create: `~/dev/doc-classifier/AGENTS.md`

**Interfaces:**

- Produces: `DocumentClass`, `HandlingRules`, `ClassificationResult`, `RetrievedContext`, `PiiFinding` types — every later task imports from `./types.js`.

- [ ] **Step 1: Create the repo and package.json**

```bash
mkdir -p ~/dev/doc-classifier/src ~/dev/doc-classifier/eval ~/dev/doc-classifier/config
cd ~/dev/doc-classifier
git init
```

`package.json`:

```json
{
  "name": "doc-classifier",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "eval": "tsx eval/run-eval.ts",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "mcp": "tsx src/mcp/index.ts"
  },
  "dependencies": {
    "ai": "^7.0.17",
    "fastify": "^5.0.0",
    "zod": "^3.23.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*.ts", "eval/**/*.ts"]
}
```

`NodeNext` resolution requires `.js` extensions on relative imports even for `.ts` files (unlike bundler-style resolution) — every code sample in this plan already follows that convention. Get this wrong and the build fails only at `tsc`/`node` time, not in the editor.

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
*.log
config/*.json
!config/example.json.example
```

Per-product config files (Task 4) contain deployment-specific settings and are gitignored except the example template — matching the "external configuration, not committed product-specific content" constraint.

- [ ] **Step 4: Write the core shared types**

`src/types.ts`:

```typescript
import { z } from "zod";

export const DocumentClassSchema = z.enum(["A", "B", "C", "D"]);
export type DocumentClass = z.infer<typeof DocumentClassSchema>;

export const HandlingRulesSchema = z.object({
  allowedAccessScope: z.enum(["shared", "single-source-only"]),
  retentionRequirements: z.string().optional(),
  requiresContentScanning: z.boolean(),
  permittedForIngestion: z.boolean(),
});
export type HandlingRules = z.infer<typeof HandlingRulesSchema>;

export const ClassificationResultSchema = z.object({
  class: DocumentClassSchema,
  handlingRules: HandlingRulesSchema,
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  retrievedContextIds: z.array(z.string()),
  needsReview: z.boolean(),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export interface RetrievedContext {
  id: string;
  text: string;
  sourceTitle: string;
}

export interface PiiFinding {
  entityType: string;
  start: number;
  end: number;
  score: number;
}
```

This `ClassificationResult` shape is a superset of `rag-system`'s minimal `DocumentClassifier` interface's result type (`{ class, handlingRules, rationale?, confidence? }`) — here `rationale` and `confidence` are required, since this service always produces them, unlike the interim rule-based classifiers that may omit them.

- [ ] **Step 5: Verify the scaffold compiles**

```bash
cd ~/dev/doc-classifier
pnpm install
pnpm exec tsc --noEmit
```

Expected: no errors (there's no behavior to test yet — this step confirms the project structure and type definitions are valid).

- [ ] **Step 6: Write README.md and AGENTS.md**

`README.md`:

````markdown
# doc-classifier

A standalone document classification service: given a document's text, returns a sensitivity
tier, a confidence score, and a human-readable rationale citing what reference material informed
the decision — using direct-identifier pattern detection (Microsoft Presidio) plus retrieval-
augmented, LLM-grounded semantic classification.

## Why this exists

Built to serve multiple, genuinely different products (a CPA firm's tax-compliance documents, a
veterans' disability-claims app's health-adjacent documents) without embedding either product's
domain knowledge in this repo. Each product supplies its own configuration (a reference knowledge
base already ingested in `rag-system`, plus a classification prompt) — this repo only ships the
classification _mechanism_.

## Full design context

This repo implements a design originally specified elsewhere. Read these before making
architectural changes:

- `rag-system/docs/superpowers/specs/2026-07-11-future-generic-classification-service-vision.md`
  — the full design, including a dedicated build-vs-adopt research pass (§1.1) that concluded no
  existing product does this end-to-end, but Presidio should be adopted for the PII layer and the
  "Contextual Policy Engine" academic paper (arXiv 2508.06204) validates the retrieve→ground→
  structured-output architecture pattern used here (with real caveats — single-domain, vendor-
  authored preprint; this service's own eval harness is what actually validates _this_ use case).
- `rag-system/docs/superpowers/specs/2026-07-11-generic-document-classification-engine-design.md`
  — the minimal interface existing consumers (`veteran-claims-app`, eventually `cpa-consulting`)
  implement to adopt this service later. Nothing in this repo requires those consumers to change
  anything now.

## Architecture

1. **PII layer** (`src/pii/`): calls a self-hosted Presidio sidecar (Docker) for direct-identifier
   detection (SSN, DOB, etc.).
2. **RAG classification core** (`src/retrieval/`, `src/classification/classify.ts`): retrieves
   grounding context from an existing `rag-system` deployment's `search_documents` API, then calls
   an LLM (via the AI Gateway) with a per-product prompt to produce a structured
   `{tier, confidence, rationale}`.
3. **Confidence gate** (`src/classification/confidence-gate.ts`): below a per-product threshold,
   overrides to the conservative tier and flags for human review.
4. **Orchestrator** (`src/classification/orchestrator.ts`): combines all three — any PII finding
   also forces the conservative tier, regardless of the LLM's semantic conclusion.
5. **Delivery**: a Fastify REST API (`src/server.ts`) and an MCP server (`src/mcp/`) both call the
   same orchestrator — one core implementation, two transports.

## Development

```bash
pnpm install
docker compose up -d          # starts the Presidio sidecar
cp config/example.json.example config/test.json  # edit with real values
PRODUCT_CONFIG_DIR=./config RAG_API_TOKEN=<token> pnpm dev
pnpm test
pnpm eval                     # runs the golden-set evaluation harness
```
````

## What's deliberately not in this repo yet

- Real per-product classification prompts/knowledge bases for CPA or veteran-claims-app — those
  are each product's own task when they choose to adopt this service.
- Bootstrapping tooling for auto-ingesting regulatory text into a new domain's knowledge base
  (the vision spec's §2.4 describes this; not built in this initial plan).
- Multi-principal auth (this service uses a single shared bearer token for now, matching MVP scope
  — see `src/server.ts`).

````

`AGENTS.md`:

```markdown
# AGENTS.md

This is a standalone document classification service — read `README.md` first for what it is and
why. Notes specific to working on this codebase as an agentic worker:

- `NodeNext` module resolution is in effect (`tsconfig.json`) — all relative imports need explicit
  `.js` extensions even though the source files are `.ts`. Get this wrong and it only fails at
  build/run time, not in the editor.
- `src/classification/orchestrator.ts` is the only file that should know about PII detection, RAG
  classification, and the confidence gate together. Keep the other files independently testable
  and ignorant of each other.
- The eval harness (`eval/`) is a separate suite from `pnpm test` — it makes real LLM calls and
  isn't run in normal CI-speed test cycles. `eval/eval-stats.ts` contains the pure, unit-testable
  accuracy-computation logic; `eval/run-eval.ts` is the thin script wrapper — keep that split, don't
  merge pure logic back into the script.
- Any change to the `ClassificationResult` shape in `src/types.ts` should be checked against
  `rag-system`'s minimal `DocumentClassifier` interface spec (linked in README.md) for
  compatibility — this service's output is meant to satisfy that interface for future consumers.
````

- [ ] **Step 7: Commit**

```bash
cd ~/dev/doc-classifier
git add -A
git commit -m "chore: scaffold doc-classifier repo with core types"
```

---

### Task 2: PII Detection via Presidio Sidecar

**Files:**

- Create: `~/dev/doc-classifier/docker-compose.yml`
- Create: `~/dev/doc-classifier/src/pii/presidio-client.ts`
- Test: `~/dev/doc-classifier/src/pii/presidio-client.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks besides `PiiFinding` (Task 1).
- Produces: `detectPii(text: string): Promise<PiiFinding[]>` — used by Task 7's orchestrator.

- [ ] **Step 1: Add the Presidio sidecar to docker-compose.yml**

```yaml
services:
  presidio-analyzer:
    image: mcr.microsoft.com/presidio-analyzer:latest
    ports:
      - "5002:3000"
```

- [ ] **Step 2: Write the failing test**

`src/pii/presidio-client.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { detectPii } from "./presidio-client.js";

describe("detectPii", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Presidio's analyze response into PiiFinding[]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { entity_type: "US_SSN", start: 10, end: 21, score: 0.85 },
        ],
      }),
    );

    const findings = await detectPii("My SSN is 123-45-6789");

    expect(findings).toEqual([
      { entityType: "US_SSN", start: 10, end: 21, score: 0.85 },
    ]);
  });

  it("throws a clear error when the Presidio request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        }),
    );

    await expect(detectPii("text")).rejects.toThrow(
      "Presidio analyze request failed: 503 Service Unavailable",
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm exec vitest run src/pii/presidio-client.test.ts
```

Expected: FAIL — `presidio-client.ts` doesn't exist yet.

- [ ] **Step 4: Write the implementation**

`src/pii/presidio-client.ts`:

```typescript
import type { PiiFinding } from "../types.js";

const PRESIDIO_ANALYZE_URL =
  process.env.PRESIDIO_URL ?? "http://localhost:5002";

interface PresidioAnalyzeResponse {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export async function detectPii(text: string): Promise<PiiFinding[]> {
  const response = await fetch(`${PRESIDIO_ANALYZE_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language: "en" }),
  });

  if (!response.ok) {
    throw new Error(
      `Presidio analyze request failed: ${response.status} ${response.statusText}`,
    );
  }

  const results = (await response.json()) as PresidioAnalyzeResponse[];
  return results.map((r) => ({
    entityType: r.entity_type,
    start: r.start,
    end: r.end,
    score: r.score,
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm exec vitest run src/pii/presidio-client.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml src/pii/
git commit -m "feat: add Presidio-backed PII detection client"
```

---

### Task 3: RAG Retrieval Client

**Files:**

- Create: `~/dev/doc-classifier/src/retrieval/rag-client.ts`
- Test: `~/dev/doc-classifier/src/retrieval/rag-client.test.ts`

**Interfaces:**

- Consumes: `RetrievedContext` (Task 1).
- Produces: `retrieveContext(query: string, sourceIds: string[], topK?: number): Promise<RetrievedContext[]>` — used by Task 5.

- [ ] **Step 1: Write the failing test**

`src/retrieval/rag-client.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { retrieveContext } from "./rag-client.js";

describe("retrieveContext", () => {
  beforeEach(() => {
    process.env.RAG_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RAG_API_TOKEN;
  });

  it("parses rag-system's search response into RetrievedContext[]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              chunkId: "chunk-1",
              text: "PTSD involves hypervigilance.",
              document: { title: "PTSD Guide" },
            },
          ],
        }),
      }),
    );

    const context = await retrieveContext("hypervigilance", ["va-corpus"]);

    expect(context).toEqual([
      {
        id: "chunk-1",
        text: "PTSD involves hypervigilance.",
        sourceTitle: "PTSD Guide",
      },
    ]);
  });

  it("throws if RAG_API_TOKEN is not configured", async () => {
    delete process.env.RAG_API_TOKEN;
    await expect(retrieveContext("query", ["source"])).rejects.toThrow(
      "RAG_API_TOKEN environment variable is required",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/retrieval/rag-client.test.ts
```

Expected: FAIL — `rag-client.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/retrieval/rag-client.ts`:

```typescript
import type { RetrievedContext } from "../types.js";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:3000";

interface SearchDocumentsResponse {
  results: Array<{
    chunkId: string;
    text: string;
    document: { title: string };
  }>;
}

export async function retrieveContext(
  query: string,
  sourceIds: string[],
  topK = 5,
): Promise<RetrievedContext[]> {
  const token = process.env.RAG_API_TOKEN;
  if (!token) {
    throw new Error(
      "RAG_API_TOKEN environment variable is required to call rag-system's search API",
    );
  }

  const response = await fetch(`${RAG_API_URL}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, sourceIds, topK }),
  });

  if (!response.ok) {
    throw new Error(
      `rag-system search request failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as SearchDocumentsResponse;
  return body.results.map((r) => ({
    id: r.chunkId,
    text: r.text,
    sourceTitle: r.document.title,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/retrieval/rag-client.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/
git commit -m "feat: add rag-system retrieval client"
```

---

### Task 4: Product Configuration Loading

**Files:**

- Create: `~/dev/doc-classifier/src/config/product-config.ts`
- Test: `~/dev/doc-classifier/src/config/product-config.test.ts`
- Create: `~/dev/doc-classifier/config/example.json.example`

**Interfaces:**

- Produces: `ProductClassificationConfig` type and `loadProductConfig(configPath: string): ProductClassificationConfig` — used by Tasks 5, 6, 8, 9, 10.

- [ ] **Step 1: Write the failing test**

`src/config/product-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProductConfig } from "./product-config.js";

function writeFixture(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "doc-classifier-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("loadProductConfig", () => {
  it("loads and validates a well-formed config", () => {
    const path = writeFixture({
      productId: "veteran-claims-app",
      referenceSourceId: "va-corpus",
      classificationPrompt: "Classify by sensitivity.",
      model: "openai/gpt-4.1-mini",
      conservativeTier: "D",
      confidenceThreshold: 0.6,
    });

    const config = loadProductConfig(path);
    expect(config.productId).toBe("veteran-claims-app");
  });

  it("throws a clear error on malformed config", () => {
    const path = writeFixture({ productId: "missing-fields" });
    expect(() => loadProductConfig(path)).toThrow(
      /Invalid product classification config/,
    );
  });

  it("throws a clear error when the file doesn't exist", () => {
    expect(() => loadProductConfig("/nonexistent/config.json")).toThrow(
      /Could not read product classification config/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/config/product-config.test.ts
```

Expected: FAIL — `product-config.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/config/product-config.ts`:

```typescript
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DocumentClassSchema } from "../types.js";

export const ProductClassificationConfigSchema = z.object({
  productId: z.string(),
  referenceSourceId: z.string(),
  classificationPrompt: z.string(),
  model: z.string(),
  conservativeTier: DocumentClassSchema,
  confidenceThreshold: z.number().min(0).max(1),
});
export type ProductClassificationConfig = z.infer<
  typeof ProductClassificationConfigSchema
>;

export function loadProductConfig(
  configPath: string,
): ProductClassificationConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (cause) {
    throw new Error(
      `Could not read product classification config at ${configPath}`,
      { cause },
    );
  }

  const parsed = ProductClassificationConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Invalid product classification config at ${configPath}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/config/product-config.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Write the example config template**

`config/example.json.example`:

```json
{
  "productId": "example-product",
  "referenceSourceId": "rag-system-source-id-for-this-products-classification-reference-corpus",
  "classificationPrompt": "You are classifying documents for [product]. Given the reference material and the document, determine its sensitivity tier and explain your reasoning.",
  "model": "openai/gpt-4.1-mini",
  "conservativeTier": "D",
  "confidenceThreshold": 0.6
}
```

- [ ] **Step 6: Commit**

```bash
git add src/config/ config/example.json.example
git commit -m "feat: add per-product classification config loading"
```

---

### Task 5: LLM Classification Core (RAG-Grounded Structured Output)

**Files:**

- Create: `~/dev/doc-classifier/src/classification/classify.ts`
- Test: `~/dev/doc-classifier/src/classification/classify.test.ts`

**Interfaces:**

- Consumes: `retrieveContext` (Task 3), `ProductClassificationConfig` (Task 4), `DocumentClassSchema` (Task 1).
- Produces: `classifyDocument(documentText: string, config: ProductClassificationConfig): Promise<Omit<ClassificationResult, "handlingRules" | "needsReview">>` — used by Task 7.

- [ ] **Step 1: Write the failing test**

`src/classification/classify.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { classifyDocument } from "./classify.js";
import * as ragClient from "../retrieval/rag-client.js";
import * as ai from "ai";

vi.mock("../retrieval/rag-client.js");
vi.mock("ai");

const config = {
  productId: "veteran-claims-app",
  referenceSourceId: "va-corpus",
  classificationPrompt:
    "Classify VA-disability-related documents by sensitivity.",
  model: "openai/gpt-4.1-mini",
  conservativeTier: "D" as const,
  confidenceThreshold: 0.6,
};

describe("classifyDocument", () => {
  it("grounds classification in retrieved context and returns structured output", async () => {
    vi.mocked(ragClient.retrieveContext).mockResolvedValue([
      {
        id: "chunk-1",
        text: "PTSD involves hypervigilance and avoidance.",
        sourceTitle: "PTSD Guide",
      },
    ]);
    vi.mocked(ai.generateObject).mockResolvedValue({
      object: {
        tier: "D",
        confidence: 0.92,
        rationale:
          "Mentions hypervigilance, matching the PTSD reference material.",
      },
    } as any);

    const result = await classifyDocument(
      "Patient reports hypervigilance and sleep disturbance.",
      config,
    );

    expect(result.class).toBe("D");
    expect(result.confidence).toBe(0.92);
    expect(result.retrievedContextIds).toEqual(["chunk-1"]);
    expect(ragClient.retrieveContext).toHaveBeenCalledWith(expect.any(String), [
      "va-corpus",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/classification/classify.test.ts
```

Expected: FAIL — `classify.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/classification/classify.ts`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";
import { retrieveContext } from "../retrieval/rag-client.js";
import { DocumentClassSchema, type ClassificationResult } from "../types.js";
import type { ProductClassificationConfig } from "../config/product-config.js";

const LlmClassificationSchema = z.object({
  tier: DocumentClassSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

export async function classifyDocument(
  documentText: string,
  config: ProductClassificationConfig,
): Promise<Omit<ClassificationResult, "handlingRules" | "needsReview">> {
  const context = await retrieveContext(documentText.slice(0, 500), [
    config.referenceSourceId,
  ]);

  const contextBlock = context
    .map((c, i) => `[${i + 1}] (${c.sourceTitle}): ${c.text}`)
    .join("\n\n");

  const { object } = await generateObject({
    model: config.model,
    schema: LlmClassificationSchema,
    system: config.classificationPrompt,
    prompt: `Reference material:\n${contextBlock}\n\nDocument to classify:\n${documentText}`,
  });

  return {
    class: object.tier,
    confidence: object.confidence,
    rationale: object.rationale,
    retrievedContextIds: context.map((c) => c.id),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/classification/classify.test.ts
```

Expected: PASS (1/1).

- [ ] **Step 5: Commit**

```bash
git add src/classification/classify.ts src/classification/classify.test.ts
git commit -m "feat: add RAG-grounded LLM classification core"
```

---

### Task 6: Confidence-Driven Fallback Gate

**Files:**

- Create: `~/dev/doc-classifier/src/classification/confidence-gate.ts`
- Test: `~/dev/doc-classifier/src/classification/confidence-gate.test.ts`

**Interfaces:**

- Consumes: output shape of `classifyDocument` (Task 5), `ProductClassificationConfig` (Task 4).
- Produces: `applyConfidenceGate(llmResult, config): { class: DocumentClass; needsReview: boolean }` — used by Task 7.

- [ ] **Step 1: Write the failing test**

`src/classification/confidence-gate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyConfidenceGate } from "./confidence-gate.js";

const config = {
  productId: "test",
  referenceSourceId: "test-source",
  classificationPrompt: "test",
  model: "openai/gpt-4.1-mini",
  conservativeTier: "D" as const,
  confidenceThreshold: 0.6,
};

describe("applyConfidenceGate", () => {
  it("overrides to the conservative tier and flags for review below the confidence threshold", () => {
    const result = applyConfidenceGate(
      {
        class: "B",
        confidence: 0.4,
        rationale: "unsure",
        retrievedContextIds: [],
      },
      config,
    );
    expect(result).toEqual({ class: "D", needsReview: true });
  });

  it("passes through the LLM's tier unchanged at or above the confidence threshold", () => {
    const result = applyConfidenceGate(
      {
        class: "B",
        confidence: 0.75,
        rationale: "clear",
        retrievedContextIds: [],
      },
      config,
    );
    expect(result).toEqual({ class: "B", needsReview: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/classification/confidence-gate.test.ts
```

Expected: FAIL — `confidence-gate.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/classification/confidence-gate.ts`:

```typescript
import type { ClassificationResult } from "../types.js";
import type { ProductClassificationConfig } from "../config/product-config.js";

export function applyConfidenceGate(
  llmResult: Omit<ClassificationResult, "handlingRules" | "needsReview">,
  config: ProductClassificationConfig,
): { class: ClassificationResult["class"]; needsReview: boolean } {
  if (llmResult.confidence < config.confidenceThreshold) {
    return { class: config.conservativeTier, needsReview: true };
  }
  return { class: llmResult.class, needsReview: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/classification/confidence-gate.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/classification/confidence-gate.ts src/classification/confidence-gate.test.ts
git commit -m "feat: add confidence-driven conservative fallback gate"
```

---

### Task 7: Classification Orchestrator

**Files:**

- Create: `~/dev/doc-classifier/src/classification/orchestrator.ts`
- Test: `~/dev/doc-classifier/src/classification/orchestrator.test.ts`

**Interfaces:**

- Consumes: `detectPii` (Task 2), `classifyDocument` (Task 5), `applyConfidenceGate` (Task 6).
- Produces: `classify(documentText: string, config: ProductClassificationConfig): Promise<ClassificationResult>` — used by Task 8 and Task 10.

- [ ] **Step 1: Write the failing test**

`src/classification/orchestrator.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { classify } from "./orchestrator.js";
import * as presidio from "../pii/presidio-client.js";
import * as classifyModule from "./classify.js";

vi.mock("../pii/presidio-client.js");
vi.mock("./classify.js");

const config = {
  productId: "test",
  referenceSourceId: "test-source",
  classificationPrompt: "test",
  model: "openai/gpt-4.1-mini",
  conservativeTier: "D" as const,
  confidenceThreshold: 0.6,
};

describe("classify (orchestrator)", () => {
  it("forces the conservative tier when direct PII is found, even if the LLM classified it lower", async () => {
    vi.mocked(presidio.detectPii).mockResolvedValue([
      { entityType: "US_SSN", start: 0, end: 11, score: 0.9 },
    ]);
    vi.mocked(classifyModule.classifyDocument).mockResolvedValue({
      class: "B",
      confidence: 0.95,
      rationale: "General correspondence.",
      retrievedContextIds: [],
    });

    const result = await classify("123-45-6789 is my number", config);

    expect(result.class).toBe("D");
    expect(result.needsReview).toBe(true);
    expect(result.handlingRules.allowedAccessScope).toBe("single-source-only");
  });

  it("uses the LLM's tier when no PII is found and confidence is high", async () => {
    vi.mocked(presidio.detectPii).mockResolvedValue([]);
    vi.mocked(classifyModule.classifyDocument).mockResolvedValue({
      class: "B",
      confidence: 0.85,
      rationale: "General correspondence.",
      retrievedContextIds: ["chunk-1"],
    });

    const result = await classify("A routine status update.", config);

    expect(result.class).toBe("B");
    expect(result.needsReview).toBe(false);
    expect(result.handlingRules.allowedAccessScope).toBe("shared");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/classification/orchestrator.test.ts
```

Expected: FAIL — `orchestrator.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/classification/orchestrator.ts`:

```typescript
import { detectPii } from "../pii/presidio-client.js";
import { classifyDocument } from "./classify.js";
import { applyConfidenceGate } from "./confidence-gate.js";
import type { ClassificationResult, HandlingRules } from "../types.js";
import type { ProductClassificationConfig } from "../config/product-config.js";

const SHARED_ACCESS_HANDLING: HandlingRules = {
  allowedAccessScope: "shared",
  requiresContentScanning: false,
  permittedForIngestion: true,
};

const RESTRICTED_ACCESS_HANDLING: HandlingRules = {
  allowedAccessScope: "single-source-only",
  requiresContentScanning: true,
  permittedForIngestion: true,
};

export async function classify(
  documentText: string,
  config: ProductClassificationConfig,
): Promise<ClassificationResult> {
  const [piiFindings, llmResult] = await Promise.all([
    detectPii(documentText),
    classifyDocument(documentText, config),
  ]);

  const gated = applyConfidenceGate(llmResult, config);

  const finalClass =
    piiFindings.length > 0 ? config.conservativeTier : gated.class;
  const handlingRules =
    finalClass === config.conservativeTier
      ? RESTRICTED_ACCESS_HANDLING
      : SHARED_ACCESS_HANDLING;

  return {
    class: finalClass,
    handlingRules,
    rationale:
      piiFindings.length > 0
        ? `${llmResult.rationale} Additionally, direct identifiers were detected (${piiFindings
            .map((f) => f.entityType)
            .join(", ")}), forcing the most restrictive tier.`
        : llmResult.rationale,
    confidence: llmResult.confidence,
    retrievedContextIds: llmResult.retrievedContextIds,
    needsReview: gated.needsReview || piiFindings.length > 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/classification/orchestrator.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/classification/orchestrator.ts src/classification/orchestrator.test.ts
git commit -m "feat: add classification orchestrator combining PII and RAG layers"
```

---

### Task 8: REST API Endpoint

**Files:**

- Create: `~/dev/doc-classifier/src/server.ts`
- Test: `~/dev/doc-classifier/src/server.test.ts`

**Interfaces:**

- Consumes: `classify` (Task 7), `loadProductConfig` (Task 4).
- Produces: `buildServer(): FastifyInstance` — a `POST /classify` endpoint.

- [ ] **Step 1: Write the failing test**

`src/server.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "./server.js";
import * as orchestrator from "./classification/orchestrator.js";
import * as configModule from "./config/product-config.js";

vi.mock("./classification/orchestrator.js");
vi.mock("./config/product-config.js");

describe("POST /classify", () => {
  beforeEach(() => {
    vi.mocked(configModule.loadProductConfig).mockReturnValue({
      productId: "test",
      referenceSourceId: "test-source",
      classificationPrompt: "test",
      model: "openai/gpt-4.1-mini",
      conservativeTier: "D",
      confidenceThreshold: 0.6,
    });
  });

  it("returns a classification result for a valid request", async () => {
    vi.mocked(orchestrator.classify).mockResolvedValue({
      class: "B",
      handlingRules: {
        allowedAccessScope: "shared",
        requiresContentScanning: false,
        permittedForIngestion: true,
      },
      rationale: "General document.",
      confidence: 0.9,
      retrievedContextIds: [],
      needsReview: false,
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/classify",
      payload: { documentText: "A routine memo.", productId: "test" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().class).toBe("B");
  });

  it("returns 400 for an invalid request body", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/classify",
      payload: { productId: "test" },
    });

    expect(response.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/server.test.ts
```

Expected: FAIL — `server.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/server.ts`:

```typescript
import Fastify from "fastify";
import { z } from "zod";
import { classify } from "./classification/orchestrator.js";
import { loadProductConfig } from "./config/product-config.js";

const ClassifyRequestSchema = z.object({
  documentText: z.string().min(1),
  productId: z.string(),
});

export function buildServer() {
  const app = Fastify();
  const apiToken = process.env.CLASSIFIER_API_TOKEN;
  const configDir = process.env.PRODUCT_CONFIG_DIR ?? "./config";

  app.addHook("onRequest", async (request, reply) => {
    if (!apiToken) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${apiToken}`) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.post("/classify", async (request, reply) => {
    const parsed = ClassifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.message });
      return;
    }

    const config = loadProductConfig(
      `${configDir}/${parsed.data.productId}.json`,
    );
    const result = await classify(parsed.data.documentText, config);
    reply.send(result);
  });

  return app;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/server.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 5: Wire up the entrypoint**

Add to `package.json`'s existing scripts (already present from Task 1: `"dev": "tsx watch src/server.ts"`, `"start": "node dist/server.js"`) — no changes needed, but add the actual listen call at the bottom of `src/server.ts`:

```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  app.listen(
    { port: Number(process.env.PORT ?? 3100), host: "0.0.0.0" },
    (err, address) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      app.log.info(`doc-classifier listening at ${address}`);
    },
  );
}
```

(Append this block to the end of `src/server.ts` after `buildServer`'s definition — guards against auto-starting the server when the file is imported by tests.)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add POST /classify REST endpoint"
```

---

### Task 9: Evaluation Harness

**Files:**

- Create: `~/dev/doc-classifier/eval/eval-stats.ts`
- Test: `~/dev/doc-classifier/eval/eval-stats.test.ts`
- Create: `~/dev/doc-classifier/eval/golden-set.json`
- Create: `~/dev/doc-classifier/eval/run-eval.ts`

**Interfaces:**

- Consumes: `classify` (Task 7), `loadProductConfig` (Task 4).
- Produces: `computeEvalStats(outcomes: EvalOutcome[]): EvalStats` — pure, independently testable; `run-eval.ts` is the thin script wrapper.

- [ ] **Step 1: Write the failing test for the pure stats logic**

`eval/eval-stats.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeEvalStats } from "./eval-stats.js";

describe("computeEvalStats", () => {
  it("counts a lower-than-expected tier as a false negative", () => {
    const stats = computeEvalStats([{ expectedClass: "D", actualClass: "B" }]);
    expect(stats.falseNegatives).toBe(1);
    expect(stats.accuracy).toBe(0);
  });

  it("does not count an over-classification as a false negative", () => {
    const stats = computeEvalStats([{ expectedClass: "B", actualClass: "D" }]);
    expect(stats.falseNegatives).toBe(0);
    expect(stats.accuracy).toBe(0);
  });

  it("computes 100% accuracy when every case matches", () => {
    const stats = computeEvalStats([
      { expectedClass: "B", actualClass: "B" },
      { expectedClass: "D", actualClass: "D" },
    ]);
    expect(stats.accuracy).toBe(1);
    expect(stats.falseNegatives).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run eval/eval-stats.test.ts
```

Expected: FAIL — `eval-stats.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`eval/eval-stats.ts`:

```typescript
const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

export interface EvalOutcome {
  expectedClass: "A" | "B" | "C" | "D";
  actualClass: "A" | "B" | "C" | "D";
}

export interface EvalStats {
  accuracy: number;
  correct: number;
  total: number;
  falseNegatives: number;
}

export function computeEvalStats(outcomes: EvalOutcome[]): EvalStats {
  let correct = 0;
  let falseNegatives = 0;

  for (const outcome of outcomes) {
    const isMatch = outcome.actualClass === outcome.expectedClass;
    if (isMatch) correct++;
    if (
      !isMatch &&
      TIER_ORDER[outcome.actualClass] < TIER_ORDER[outcome.expectedClass]
    ) {
      falseNegatives++;
    }
  }

  return {
    accuracy: correct / outcomes.length,
    correct,
    total: outcomes.length,
    falseNegatives,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run eval/eval-stats.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Add a synthetic starter golden set**

`eval/golden-set.json` — deliberately generic/synthetic, not real CPA or veteran-claims content (each product's real labeled golden set is that product's own task when it adopts this service, per README.md's "what's deliberately not in this repo" section):

```json
[
  {
    "documentText": "The patient reports recurring nightmares, hypervigilance, and avoidance of crowds since returning from deployment.",
    "expectedClass": "D",
    "productId": "test"
  },
  {
    "documentText": "This memo confirms receipt of your intent to file, dated last week.",
    "expectedClass": "B",
    "productId": "test"
  },
  {
    "documentText": "SSN: 123-45-6789, DOB: 01/01/1980.",
    "expectedClass": "D",
    "productId": "test"
  }
]
```

- [ ] **Step 6: Write the eval script**

`eval/run-eval.ts`:

```typescript
import { readFileSync } from "node:fs";
import { classify } from "../src/classification/orchestrator.js";
import { loadProductConfig } from "../src/config/product-config.js";
import { computeEvalStats, type EvalOutcome } from "./eval-stats.js";

interface GoldenCase {
  documentText: string;
  expectedClass: "A" | "B" | "C" | "D";
  productId: string;
}

async function runEval() {
  const goldenSet: GoldenCase[] = JSON.parse(
    readFileSync(new URL("./golden-set.json", import.meta.url), "utf-8"),
  );

  const outcomes: EvalOutcome[] = [];

  for (const testCase of goldenSet) {
    const config = loadProductConfig(
      `${process.env.PRODUCT_CONFIG_DIR ?? "./config"}/${testCase.productId}.json`,
    );
    const result = await classify(testCase.documentText, config);
    outcomes.push({
      expectedClass: testCase.expectedClass,
      actualClass: result.class,
    });
    console.log(
      `${result.class === testCase.expectedClass ? "PASS" : "FAIL"} expected=${testCase.expectedClass} actual=${result.class} confidence=${result.confidence.toFixed(2)} "${testCase.documentText.slice(0, 50)}..."`,
    );
  }

  const stats = computeEvalStats(outcomes);
  console.log(
    `\nAccuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correct}/${stats.total})`,
  );
  console.log(
    `False negatives (under-classified — the worst error type): ${stats.falseNegatives}`,
  );

  if (stats.falseNegatives > 0) {
    console.error(
      "\nEval failed: false negatives are not acceptable for a fail-conservative classifier.",
    );
    process.exit(1);
  }
}

runEval();
```

- [ ] **Step 7: Commit**

```bash
git add eval/
git commit -m "feat: add evaluation harness with synthetic starter golden set"
```

---

### Task 10: MCP Server Exposure

**Files:**

- Create: `~/dev/doc-classifier/src/mcp/server.ts`
- Test: `~/dev/doc-classifier/src/mcp/server.test.ts`
- Create: `~/dev/doc-classifier/src/mcp/index.ts`

**Interfaces:**

- Consumes: `classify` (Task 7), `loadProductConfig` (Task 4).
- Produces: `handleClassifyDocument`, `buildMcpServer()`, `startMcpServer()`.

- [ ] **Step 1: Write the failing test**

`src/mcp/server.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleClassifyDocument } from "./server.js";
import * as orchestrator from "../classification/orchestrator.js";
import * as configModule from "../config/product-config.js";

vi.mock("../classification/orchestrator.js");
vi.mock("../config/product-config.js");

describe("handleClassifyDocument", () => {
  it("loads the product config and delegates to the classify orchestrator", async () => {
    vi.mocked(configModule.loadProductConfig).mockReturnValue({
      productId: "test",
      referenceSourceId: "test-source",
      classificationPrompt: "test",
      model: "openai/gpt-4.1-mini",
      conservativeTier: "D",
      confidenceThreshold: 0.6,
    });
    vi.mocked(orchestrator.classify).mockResolvedValue({
      class: "B",
      handlingRules: {
        allowedAccessScope: "shared",
        requiresContentScanning: false,
        permittedForIngestion: true,
      },
      rationale: "General document.",
      confidence: 0.9,
      retrievedContextIds: [],
      needsReview: false,
    });

    const result = await handleClassifyDocument({
      documentText: "test doc",
      productId: "test",
    });

    expect(orchestrator.classify).toHaveBeenCalledWith(
      "test doc",
      expect.objectContaining({ productId: "test" }),
    );
    expect(result.structuredContent.class).toBe("B");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/mcp/server.test.ts
```

Expected: FAIL — `mcp/server.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/mcp/server.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { classify } from "../classification/orchestrator.js";
import { loadProductConfig } from "../config/product-config.js";

const ClassifyDocumentInputSchema = {
  documentText: z.string().min(1).describe("The document content to classify."),
  productId: z
    .string()
    .describe(
      "Which product's classification config to use (e.g. 'veteran-claims-app').",
    ),
};

export async function handleClassifyDocument({
  documentText,
  productId,
}: {
  documentText: string;
  productId: string;
}) {
  const configDir = process.env.PRODUCT_CONFIG_DIR ?? "./config";
  const config = loadProductConfig(`${configDir}/${productId}.json`);
  const result = await classify(documentText, config);
  return {
    content: [
      {
        type: "text" as const,
        text: `Classified as tier ${result.class}: ${result.rationale}`,
      },
    ],
    structuredContent: result,
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "doc-classifier", version: "0.1.0" });
  server.tool(
    "classify_document",
    "Classify a document's sensitivity tier using retrieval-grounded LLM classification plus direct-identifier detection.",
    ClassifyDocumentInputSchema,
    handleClassifyDocument,
  );
  return server;
}
```

`src/mcp/index.ts`:

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";

const server = buildMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/mcp/server.test.ts
```

Expected: PASS (1/1).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/
git commit -m "feat: expose classify_document as an MCP tool"
```

---

## Final Verification

- [ ] **Step 1: Run the full test suite**

```bash
cd ~/dev/doc-classifier
pnpm test
```

Expected: all tests pass (Tasks 1-10, no eval harness — that's a separate suite per AGENTS.md).

- [ ] **Step 2: Typecheck and build**

```bash
pnpm exec tsc --noEmit
pnpm build
```

Expected: no errors.

- [ ] **Step 3: Placeholder scan**

```bash
grep -rn "TODO\|TBD\|FIXME" src/ eval/ --include="*.ts"
```

Expected: no output.

- [ ] **Step 4: Spec coverage check (self-review, not a subagent dispatch)**

Confirm each piece of the vision spec (`rag-system/docs/superpowers/specs/2026-07-11-future-generic-classification-service-vision.md`) maps to a task:

- §2.1 (RAG classification) → Tasks 3, 5
- §2.2 (confidence-driven behavior) → Task 6
- §2.3 (per-product config as data) → Task 4
- §2.5 (eval harness) → Task 9
- Goal's "API and MCP" → Tasks 8, 10
- §1.1's Presidio adoption decision → Task 2

§2.4 (bootstrapping new domains via a generalized eCFR connector) is intentionally not covered by this plan — it's a separate, smaller subsystem to build once this core service has a real second consumer needing a cold-start knowledge base; building it now would be speculative (no consumer needs it yet). Note this explicitly rather than silently dropping it.

- [ ] **Step 5: Commit the final state if any fixes were made during self-review**

```bash
git status
# If clean, nothing to commit — self-review found no issues requiring fixes.
```
