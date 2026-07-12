# Generic Document Classification Service — Future Vision

> **Status: DEFERRED. No current timeline. Does not block any work in `rag-system`, `cpa-consulting`, `veteran-claims-app`, or the TWK KB launch.** This is a design captured for when there's bandwidth to build it, not a scheduled initiative. Do not invoke `writing-plans` on this document until someone explicitly decides to prioritize it.

**Goal:** A standalone document classification service, in its own repo, integrated with by other applications via API and MCP — genuinely reusable across arbitrary products, not just the two known today (CPA, veteran-claims-app), using retrieval-augmented, LLM-driven classification against a domain-specific knowledge base, with confidence scoring, explainable rationale, and a continuous evaluation loop.

**Architecture:** A new repo hosting a lean orchestration service — no new vector DB or retrieval stack of its own. It calls back into `rag-system`'s existing `search_documents` capability to retrieve grounding context from whichever knowledge-base source represents a given product's classification reference material, passes `{document, retrieved context}` to an LLM with a classification prompt, and returns a structured, explainable result. A regex-based direct-identifier layer (SSNs, DOB patterns) runs alongside the semantic layer for the narrower class of signals that pattern matching genuinely handles well. An eval harness, modeled on the golden-question pattern already used in `veteran-claims-app` (`golden-questions.eval.ts`, `pnpm eval`), validates and improves accuracy over time.

**Tech Stack:** New repo (language TBD — likely TypeScript to match the ecosystem), consumes `rag-system`'s existing MCP/API surface, LLM access via the AI Gateway pattern already used elsewhere in this ecosystem.

## Global Constraints

- This service does not duplicate `rag-system`'s retrieval infrastructure (vector DB, embeddings, hybrid search) — it is a client of it, not a reimplementation.
- Every classification result must include a machine- and human-readable rationale citing which retrieved context drove the decision — not just a bare tier label.
- Low-confidence results default to the most conservative tier and are flagged for human review, never silently trusted.
- Every product's classification knowledge base and prompt configuration is versioned and must pass a labeled eval set before deployment and on every change — this is a first-class requirement, not a one-time migration check.
- Nothing in this design requires `rag-system`, `cpa-consulting`, or `veteran-claims-app` to change their current near-term plans. When this service exists, existing consumers adopt it by implementing the minimal `DocumentClassifier` interface (`rag-system/docs/superpowers/specs/2026-07-11-generic-document-classification-engine-design.md`) against this service instead of an interim implementation — a swap, not a rewrite of calling code.

---

## 1. Problem Statement

Rule-based/keyword classification (the interim approach used by early adopters of the minimal interface) is brittle against paraphrased, narrative content — a document describing "trouble sleeping, hypervigilance, and avoiding crowds" is clearly PTSD-adjacent without containing the word "PTSD." Accurately classifying sensitive content at the semantic level, across genuinely different domains (CPA tax-compliance content vs. veteran health-adjacent content), needs a mechanism smarter than pattern matching, grounded in real domain authority, and continuously validated — not a bigger keyword list.

## 2. Design

### 2.1 Classification as Retrieval-Augmented Generation

For each document to classify:

1. Retrieve relevant reference context from the product's classification knowledge-base source via `rag-system`'s existing `search_documents` (the same retrieval infrastructure already built and running — no new infra).
2. Pass `{document content, retrieved context}` to an LLM with a classification-specific prompt (product-supplied, not generic — see §2.3).
3. LLM returns structured output: `{ tier, confidence: 0.0-1.0, rationale, retrievedContextIds }`.

Regex-based direct-identifier detection (SSN/DOB/etc.) runs as a separate, cheap, high-precision layer — genuinely domain-agnostic, no LLM needed for that narrow signal type.

### 2.2 Confidence-Driven Behavior

Below a configured confidence threshold, the result defaults to the most conservative tier available _and_ is flagged for human review — ambiguity becomes visible and actionable rather than silently absorbed into a default.

### 2.3 Per-Product Knowledge Base and Prompt (data, not code)

Each product supplies:

- A classification-reference source in `rag-system` (could be an existing corpus already ingested for other purposes — e.g., `veteran-claims-app` can reuse the already-ingested `veteran-disability-ai-resources` corpus with zero new ingestion work).
- A classification prompt/instruction set describing what to look for and how to reason about it, informed by real domain authority (regulatory text, existing validated logic, curated expert-reviewed examples) — not invented ad hoc.

`rag-system`'s own repository never contains this product-specific content — it lives in each consuming product's own repo/configuration, exactly as the minimal-interface spec establishes.

### 2.4 Bootstrapping New Domains (Cold Start)

A brand-new domain adopting this service starts with an empty classification knowledge base. Three seeding paths, in order of preference:

1. **Reuse an existing corpus** already ingested for other purposes, if one exists (the `veteran-claims-app` case — no bootstrapping work needed at all).
2. **Auto-ingest authoritative regulatory text** via a generalized version of the existing `ecfr-part4` connector (already proven for VA's 38 CFR Part 4) — point it at whatever CFR title/part governs the new domain and it ingests real regulatory definitions with no manual authoring.
3. **Curated few-shot examples**, authored and reviewed by whoever has domain authority, for domains with no accessible regulatory text — few-shot examples as the retrieval corpus instead of regulatory prose.

Seed content is not assumed correct. As real documents are classified and reviewed (§2.5), corrections feed back into the golden eval set, and the seed corpus/prompt improves over successive iterations — seeding and evaluation are the same feedback loop, not separate mechanisms.

### 2.5 Evaluation Harness

Modeled directly on `veteran-claims-app`'s existing `golden-questions.eval.ts` / `pnpm eval` pattern: a labeled set of known-sensitive and known-safe documents runs through the classifier, measuring accuracy with false negatives (under-classification) weighted as the worst error type, consistent with the fail-conservative philosophy established throughout the platform-focus design. Runs as a pre-deployment gate for any new domain or prompt/corpus change, not a one-time check.

## 3. Migration Path for Existing Consumers (when/if this is ever built)

- **`veteran-claims-app`**: swaps its interim rule-based `DocumentClassifier` implementation for one backed by this service, satisfying the same minimal interface — no changes to the Document Workspace's calling code.
- **CPA/TWK**: migrates `classify-source.ts`'s existing logic into this service's rule/prompt format, with a side-by-side verification pass against real TWK data before cutover (the same diligence any change to TWK's live classification behavior would require, regardless of mechanism).

## 4. Explicitly Not Scoped Now

- No repo exists yet for this service — creating one is itself a future decision, not implied by writing this spec.
- No implementation, no task breakdown, no `writing-plans` invocation until this is explicitly prioritized.
- No requirement that CPA or veteran-claims-app adopt this once built — the minimal-interface pattern means adoption is optional and incremental, not a forced migration.
