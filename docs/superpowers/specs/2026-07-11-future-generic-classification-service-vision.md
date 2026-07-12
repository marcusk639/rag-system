# Generic Document Classification Service — Design

> **Status: ACTIVE — being scoped into an implementation plan (2026-07-11).** Still does not block any work in `rag-system`, `cpa-consulting`, `veteran-claims-app`, or the TWK KB launch — this is a new, independent repo/project, adopted by existing consumers later, not a prerequisite for their current plans.

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

## 1.1 Build vs. Adopt Research Findings (2026-07-11)

Before committing to a custom build, a deep-research pass (105 agents, 22 sources fetched, 25 claims adversarially verified — 15 confirmed, 10 explicitly refuted and excluded) evaluated existing open-source and commercial document-classification/sensitive-content-detection systems. Conclusion: **no end-to-end product satisfies this spec, and no product should be adopted wholesale — but two concrete adoption decisions and one validated architectural precedent change what gets built custom.**

- **Adopt Microsoft Presidio (MIT license) or Philter (Apache 2.0) as the direct-identifier/PII detection layer**, replacing "hand-rolled regex" — both are mature (Presidio ~8 years, Philter actively maintained through 2026), and Presidio's custom-recognizer registration pattern (subclass `EntityRecognizer`/`PatternRecognizer`, register with a `RecognizerRegistry`) is a proven, additive extensibility mechanism directly reusable for this service's own per-domain configuration requirement (§2.3). Caveat, confirmed on verification: raw accuracy of open-source PII detectors lags commercial marketing claims substantially (best benchmarked F1 ~0.542 vs. commercial claims of 0.92-0.99) — adopt Presidio for its infrastructure and extensibility, not an assumption of high out-of-the-box accuracy; this layer still needs its own eval coverage (§2.5), not a free pass because it's a mature library.
- **The retrieve→ground→structured-output architecture (§2.1) is a validated pattern, not a novel risk** — the closest precedent found, Contextual AI's "Contextual Policy Engine" (arXiv 2508.06204), demonstrates exactly this shape (embedding search + reranker → grounded LLM generator → structured label/category/rationale) achieving F1=0.988 on a hate-speech classification benchmark, competitive with the best commercial classifier tested (0.996) and beating other LLM-guardrail baselines. Real caveats: it's a non-peer-reviewed preprint from a vendor benchmarking its own commercial stack (conflict of interest on the "beats commercial baselines" framing), and it's evaluated on a single narrow domain — **it has not been validated across genuinely disjoint domains** (e.g., PTSD-adjacent veteran-health content vs. tax-return-adjacent CPA content, the actual two domains this service must handle). Treat as a design pattern to borrow, not proof this specific multi-domain use case will hit similar accuracy — the eval harness (§2.5) is what actually answers that question for this service, not the paper.
- **Enterprise DLP/GRC platforms (Microsoft Purview, representative of the category) do not do RAG-grounded classification at all** — confirmed directly against current Microsoft documentation: Purview's three classification mechanisms are manual tagging, pattern-matching, and trainable classifiers (train-once on labeled samples), with no per-query LLM grounding against a reference corpus anywhere in the pipeline. Not a fit despite being the closest commercial analog to "compliance-grade multi-domain classification."
- **LLM "guardrail" frameworks (NeMo Guardrails, Guardrails AI) are commonly mistaken for this kind of system but are architecturally different** — policy-enforcement/validator layers sitting between application code and an LLM, not purpose-built classifiers producing a sensitivity tier with confidence and cited rationale. Confirmed directly against both projects' primary documentation.
- **Confirmed gap, applies to every product/paper surveyed**: nothing bundles a labeled-golden-set evaluation harness (§2.5) with the rest of a classification pipeline, and nothing exposes RAG-grounded classification with confidence+rationale via both an API and an MCP server as first-class delivery (§3 of the minimal-interface spec's integration goal). This remains fully custom engineering regardless of which building blocks are adopted — the research specifically looked for and did not find a shortcut here.
- **Residual open question, not fully closed by this research pass**: vertical-specific compliance SaaS products (healthcare de-identification services, legal e-discovery platforms) were not directly investigated and could plausibly bundle something closer to this spec. Worth a narrower, targeted check before finalizing the build if time allows, but not treated as blocking — the hybrid-build path below is sound regardless of what such a product might offer, since self-hosting/data-control requirements (this service handles MST/mental-health and tax-return-adjacent content) would likely rule out a third-party SaaS dependency for the core classification path anyway.

## 2. Design

### 2.1 Classification as Retrieval-Augmented Generation

For each document to classify:

1. Retrieve relevant reference context from the product's classification knowledge-base source via `rag-system`'s existing `search_documents` (the same retrieval infrastructure already built and running — no new infra).
2. Pass `{document content, retrieved context}` to an LLM with a classification-specific prompt (product-supplied, not generic — see §2.3).
3. LLM returns structured output: `{ tier, confidence: 0.0-1.0, rationale, retrievedContextIds }`.

Direct-identifier detection (SSN/DOB/etc.) runs as a separate layer via **Microsoft Presidio** (MIT license — see §1.1 for the adoption rationale), not hand-rolled regex — genuinely domain-agnostic, no LLM needed for that narrow signal type, and its recognizer-registry pattern doubles as the extensibility mechanism for §2.3's per-domain configuration.

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

## 4. Explicitly Not Scoped

- No requirement that CPA or veteran-claims-app adopt this once built — the minimal-interface pattern means adoption is optional and incremental, not a forced migration.
- The literal per-domain classification prompts/knowledge-base content for CPA and veteran-claims-app are not authored here — this spec defines the mechanism; each product's actual rule content is that product's own task (per §2.3), same as the interim classifiers.
- A deeper investigation of vertical-specific compliance SaaS products (§1.1's residual open question) is optional follow-up, not a blocker to starting implementation.

## 5. Repo Setup

No repo exists yet. Creating one — with enough README/AGENTS.md context that a fresh engineer or agent can pick up this spec cold — is the first task of the implementation plan, not a precondition for writing it.
