# Document Classification Interface — Design (Minimal, Non-Blocking)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to turn this design into a phased implementation plan, then superpowers:subagent-driven-development or superpowers:executing-plans to implement it task-by-task.

**Goal:** Give `rag-system` a minimal, generic `DocumentClassifier` interface and a per-classifier ingestion gate, so a new consumer (starting with `veteran-claims-app`) can supply its own classification logic without embedding product-specific rules in this repo — as a small, additive change that touches zero existing code and blocks nothing currently in flight.

**Architecture:** Add the interface to `packages/core` and the per-classifier gate to `packages/ingestion`, both purely additive. Existing consumers (CPA/TWK's `classify-source.ts`) are not touched, not migrated, and not required to change. The far more ambitious "generic classification engine" — RAG-based, LLM-driven, with eval/confidence/rationale/bootstrapping, most likely its own standalone service — is deliberately out of scope here. See the companion spec `2026-07-11-future-generic-classification-service-vision.md` for that design, which has no current timeline and no dependency on this one shipping first (or at all).

**Tech Stack:** TypeScript, existing `packages/core`/`packages/ingestion` structure.

## Global Constraints

- **Zero changes to CPA/TWK's existing `classify-source.ts` or its behavior.** This spec must not touch, risk, or delay the TWK KB launch in any way. If implementing this interface turns out to require touching CPA's code path, stop and reconsider — that's a sign the interface isn't minimal enough.
- The interface must stay genuinely minimal: just enough to (a) let a new consumer supply a classifier without embedding its rules in this repo, and (b) replace the hardcoded "Phase 1 only allows A/B" gate with a per-classifier declaration. Nothing else.
- Shaped for forward compatibility with the future engine (companion spec) — when that's eventually built, it should be able to implement this same interface without the interface itself needing to change.
- This work is not on any critical path. It should only proceed when it doesn't compete with `rag-system`, `cpa-consulting`, or TWK KB launch priorities for attention.

---

## 1. Problem Statement

`veteran-claims-app`'s planned Document Workspace feature (see `veteran-disability-ai-resources/docs/superpowers/specs/2026-07-10-veteran-claims-platform-focus-design.md`) needs a way to classify uploaded documents by sensitivity without hardcoding veteran-claims-specific rules inside this shared platform repo. The minimal fix is an interface any consumer can implement — not a new engine, not a migration of existing consumers, not a new service. Everything more ambitious is explicitly deferred (see the companion future-vision spec).

## 2. Current State

- `packages/ingestion/src/classify-source.ts` hardcodes CPA/TWK's §7216/GLBA classification logic. **Left entirely as-is by this spec.**
- `runIngestion()` throws `ClassBlockedError` for `DocumentClass` C/D via one hardcoded "Phase 1 only permits A/B" check, applied uniformly regardless of consumer or isolation guarantees.

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
  // Optional, forward-compatible with the future engine — an interim
  // classifier may omit these; nothing in this spec requires them.
  rationale?: string;
  confidence?: number;
}

interface DocumentClassifier {
  classify(
    doc: SourceDocument,
    context: ClassificationContext,
  ): Promise<ClassificationResult>;
}
```

### 3.2 Per-Classifier Ingestion Gate

`runIngestion()`'s `ClassBlockedError` check changes from a hardcoded tier comparison to consulting `handlingRules.permittedForIngestion` on the result — declared by whichever classifier is wired in for that source. CPA's ingestion path keeps using its current hardcoded gate unchanged (it never adopts this interface as part of this spec); only new consumers wiring in a `DocumentClassifier` use the new gate path.

### 3.3 Wiring for New Consumers

A new consumer (e.g., `veteran-claims-app`) supplies its own `DocumentClassifier` implementation at the point it wires up ingestion — via `buildCoreDeps()` (`packages/runtime`) or equivalent — living entirely in its own repo. `rag-system` never contains that implementation's code.

## 4. Testing & Verification

- Unit tests for the interface's gate-consultation logic against an injected test classifier (synthetic, no product-specific content).
- **Regression check: CPA/TWK's existing test suite and ingestion behavior are unaffected** — run before and after, not assumed, precisely because this spec's core promise is "zero impact on existing consumers."

## 5. Open Questions Carried Forward

- Whether CPA/TWK ever adopts this interface (wrapping `classify-source.ts` behind it, or migrating to the future engine) is a separate, optional, future decision — not scoped here.
- See `2026-07-11-future-generic-classification-service-vision.md` for the more ambitious design this interface is shaped to eventually support.
