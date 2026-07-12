# Generic Document Classification Engine Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to turn this design into a phased implementation plan, then superpowers:subagent-driven-development or superpowers:executing-plans to implement it task-by-task.

**Goal:** Give `rag-system` a genuinely domain-agnostic document classification capability — a `DocumentClassifier` interface plus a data-driven rule engine that any consuming product configures with its own sensitivity rules, instead of shipping product-specific classification code inside this repo.

**Architecture:** Add a small `DocumentClassifier` interface to `packages/core`, and a `createRuleBasedClassifier(ruleSet)` factory in `packages/ingestion` that builds a classifier from a declarative `ClassificationRuleSet` (pattern/keyword matchers tagged with sensitivity tiers, content-type rules, handling-rule declarations). Generalize the existing TRI/§7216 scanner into a configurable sensitive-content scanner the rule engine can invoke, rather than a hardcoded tax-specific check. Rule sets themselves — the actual domain knowledge of what's sensitive for a given product — are supplied as external configuration at deployment time, loaded from each consuming product's own repo/environment, and are never committed into this repo.

**Tech Stack:** TypeScript, the existing `packages/core`/`packages/ingestion` structure, Drizzle/Postgres for the existing `DocumentClass` A-D model this extends.

## Global Constraints

- `rag-system`'s own repository must contain zero product-specific classification rules, keyword lists, or business logic — only the generic interface, the rule-engine factory, and the generalized scanner. This is the reason this refactor exists; violating it defeats the purpose.
- The existing `DocumentClass` A-D type and its current consumers are not replaced — the new `DocumentClassifier` interface sits alongside it and produces a compatible `class` value plus new `handlingRules`.
- The ingestion gate (which tiers may proceed past `ClassBlockedError`) becomes a property of each rule set's declared handling rules, not a hardcoded "Phase 1 only allows A/B" check in the pipeline.
- Any change to `packages/core`/`packages/ingestion` must keep every existing consumer's test suite green — this repo currently serves at least one production consumer (the CPA/TWK product via `apps/web`) whose classification behavior must not regress during this refactor.

---

## 1. Problem Statement

Two products need document classification for sensitive-content handling: an existing CPA-firm compliance product (§7216/GLBA rules, already implemented as hardcoded logic in `packages/ingestion/src/classify-source.ts`) and a new veteran-claims-app feature (health/PII-content rules, not yet built). The straightforward path — add a second hardcoded classifier implementation to this repo — would embed product-specific business logic (CPA tax-compliance rules, veteran health-content rules) inside a platform repo meant to stay domain-agnostic and reusable across arbitrary future products. This design instead makes classification itself a generic, configurable capability of the platform.

## 2. Current State

- `packages/core`: defines `DocumentClass` (`"A"|"B"|"C"|"D"`) and the security-guard trio (egress allowlist, PII metadata allowlist, TRI/§7216 scanner). The TRI scanner is functionally generic (pattern-matching against content) but currently parameterized only for §7216 taxpayer-info detection.
- `packages/ingestion/src/classify-source.ts`: hardcodes the CPA product's §7216/GLBA classification logic, mapping a source's `dataClass` to a `DocumentClass`. This is the product-specific code this design moves off the platform's own classification path (not necessarily deleted immediately — see cpa-consulting's companion spec for the migration plan).
- `runIngestion()` (`packages/ingestion/src/pipeline.ts`) throws `ClassBlockedError` for `DocumentClass` C/D via a single hardcoded "Phase 1 only permits A/B" rule, regardless of which product or isolation guarantees apply.

## 3. Design

### 3.1 `DocumentClassifier` Interface (`packages/core`)

```ts
interface ClassificationResult {
  class: DocumentClass;
  handlingRules: {
    allowedAccessScope: "shared" | "single-source-only";
    retentionRequirements?: string;
    requiresContentScanning: boolean;
    permittedForIngestion: boolean;
  };
}

interface DocumentClassifier {
  classify(
    doc: SourceDocument,
    context: ClassificationContext,
  ): Promise<ClassificationResult>;
}
```

`handlingRules.permittedForIngestion` is what replaces the pipeline's hardcoded gate — each classifier (via its configured rule set) declares per-tier whether ingestion may proceed, given the isolation guarantees the calling product provides.

### 3.2 Rule-Based Classifier Factory (`packages/ingestion`)

```ts
interface ClassificationRule {
  tier: DocumentClass;
  matchers: Array<
    | { type: "keyword"; values: string[] }
    | { type: "pattern"; regex: string }
    | { type: "contentType"; mimeTypes: string[] }
  >;
  handlingRules: ClassificationResult["handlingRules"];
}

interface ClassificationRuleSet {
  productId: string; // e.g. "cpa-twk", "veteran-claims-app" — for audit/logging only, not branching logic
  rules: ClassificationRule[];
  defaultTier: DocumentClass;
}

function createRuleBasedClassifier(
  ruleSet: ClassificationRuleSet,
): DocumentClassifier;
```

This factory is the only classification _code_ this repo ships. It contains no knowledge of what CPA or veteran-claims-app consider sensitive — that knowledge lives entirely in the `ClassificationRuleSet` data each product supplies.

### 3.3 Generalized Sensitive-Content Scanner

Refactor the existing TRI/§7216 scanner into a scanner parameterized by a pattern set (reusing its existing detection mechanism, not rewriting it), invocable by any `ClassificationRule` matcher via `{ type: "pattern", regex, useContentScanner: true }`. §7216-specific patterns become one product's configured pattern set, not the scanner's hardcoded behavior.

### 3.4 Rule-Set Loading (external configuration, not repo content)

Each consuming product's deployment supplies its `ClassificationRuleSet` via an environment-configured path (e.g., `CLASSIFICATION_RULESET_PATH`) or an injected config object at `buildCoreDeps()` composition time (`packages/runtime`). The rule set's _source_ lives in the consuming product's own repository — `rag-system` only ever receives it as runtime configuration, never as committed code. See the companion specs in `cpa-consulting` and `veteran-claims-app` for each product's actual rule-set content.

### 3.5 Ingestion Gate Becomes Per-Classifier

`runIngestion()`'s `ClassBlockedError` check changes from a hardcoded tier comparison to consulting the classification result's `handlingRules.permittedForIngestion` — set per-tier by each product's rule set, given the isolation guarantees that product's deployment provides.

## 4. Testing & Verification

- Unit tests for `createRuleBasedClassifier` against synthetic rule sets (keyword match, pattern match, content-type match, default-tier fallback) — no product-specific content in these tests, only generic fixtures.
- Unit tests for the generalized scanner, verifying it produces the same detection behavior as the current TRI scanner when configured with §7216-equivalent patterns (regression check against existing scanner tests, migrated to the new parameterized form).
- Integration test: `runIngestion()` respects `permittedForIngestion` from an injected test classifier, replacing the current hardcoded-gate test.
- **Existing CPA-product test suite must stay green throughout** — run before and after this refactor lands, not assumed.

## 5. Open Questions Carried Forward

- Exact mechanism for injecting a product's `ClassificationRuleSet` into a running deployment (env-configured file path vs. a small adapter package each product publishes) — pick the simpler of the two once the CPA migration spec's actual constraints are known.
- Whether `classify-source.ts`'s existing logic is deleted once CPA migrates to the new engine, or kept temporarily as a fallback during rollout — see `cpa-consulting`'s companion spec.
