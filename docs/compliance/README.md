---
title: Compliance directory
status: current
last_verified: 2026-10-21
verified_against: db0ceae
answers: What each file in docs/compliance/ is, which ones are immutable evidence, and what COMPLIANCE_MODE=client-data needs at boot.
read_when: Adding or superseding a compliance record, adding a vendor DPA file, or turning on COMPLIANCE_MODE=client-data.
supersedes: []
code:
  [
    packages/core/src/config.ts,
    packages/rag/src/embeddings/factory.ts,
    packages/rag/src/embeddings/local.ts,
    packages/rag/src/content-scanning/ollama-scanner.ts,
    packages/rag/src/retrieval/reranker.ts,
    packages/runtime/src/index.ts,
    .dockerignore,
  ]
---

# Compliance directory

This directory holds the compliance record for the CPA deployment: the requirements, a living control register, an
exceptions log, the content-safety design, and dated evidence records. Two of its properties are load-bearing at
runtime. The `COMPLIANCE_MODE=client-data` boot check looks here for a `vendor-dpa-*.md` file, and every service
image copies the directory in. So **don't move or rename `docs/compliance/`, and don't rename a `vendor-dpa-*.md`
file.** Production currently runs `COMPLIANCE_MODE=none` (see [CONTROL-STATUS.md](CONTROL-STATUS.md)).

Nothing here is legal advice. Items marked **[COUNSEL]** need review by the firm's counsel.

## Index

| File                                                                     | Status   | What it answers                                                                                        |
| ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| [REQUIREMENTS.md](REQUIREMENTS.md)                                       | current  | What the law and the firm require: CR-1..CR-20, FR/NFR, human-in-the-loop design, legal research.      |
| [CONTROL-STATUS.md](CONTROL-STATUS.md)                                   | living   | Where each CR stands today, the production values, open legal/process items, and gaps in the evidence. |
| [EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md)                                   | living   | Dated departures from a stated control or gate, and their current state.                               |
| [CONTENT-SAFETY-DESIGN.md](CONTENT-SAFETY-DESIGN.md)                     | current  | How client-identifying material is kept out of the index, and why it is built that way.                |
| [scope-conformance-2026-09-30.md](scope-conformance-2026-09-30.md)       | evidence | Live system checked against the firm's scope contract for P0 gate 2 (amended 2026-10-02).              |
| [GATE-1-CONTENT-AUDIT.md](GATE-1-CONTENT-AUDIT.md)                       | evidence | P0 gate 1 content-audit procedure, corpus measurements and the 2026-10-02 verbal sign-off.             |
| [vendor-dpa-google-gemini.md](vendor-dpa-google-gemini.md)               | evidence | Google Gemini DPA status (billing verified 2026-08-04; counsel review outstanding). Boot-load-bearing. |
| [records/PURGE-RECORD-2026-08-03.md](records/PURGE-RECORD-2026-08-03.md) | evidence | Why and how the 858-document index was purged on 2026-08-03.                                           |
| [records/CPA-READINESS-ASSESSMENT-2026-07-08.md][readiness]              | evidence | 2026-07-08 readiness audit against `main`.                                                             |
| [records/DECISION-CPA-KB-RAG-CONVERGENCE.md][convergence]                | evidence | 2026-06-23 decision to make rag-system the CPA knowledge-base product.                                 |
| [records/kb-incident-remediation-plan.md][incident]                      | evidence | The prompt written to plan remediation of the 2026-08 incident. Its copy inventory is unique.          |

[readiness]: records/CPA-READINESS-ASSESSMENT-2026-07-08.md
[convergence]: records/DECISION-CPA-KB-RAG-CONVERGENCE.md
[incident]: records/kb-incident-remediation-plan.md

People and IDs used here (Chris, Doug, P0 gates, CR-n, Class A–D) are defined in [GLOSSARY.md](../GLOSSARY.md).

## Naming and immutability

Evidence records are dated statements made to counsel, auditors or the firm. They stay **byte-identical** after they
are issued.

- **To change an evidence record, supersede it.** Add a new dated file, for example
  `scope-conformance-<YYYY-MM-DD>.md`, and leave the old one alone so a reader can see what moved. A clearly marked
  `## Amendment YYYY-MM-DD` block appended at the end is the only other permitted change.
- **Known errors in a record are listed, not fixed.** They go in
  [CONTROL-STATUS.md](CONTROL-STATUS.md#known-gaps-in-the-evidence-records).
- **Conformance records:** `scope-conformance-<YYYY-MM-DD>.md`. The newest one is the latest verified statement of
  the production posture.
- **Vendor DPA records:** `vendor-dpa-<vendor>.md`, one per external processor. The boot check matches this pattern
  (next section).
- **Living docs** (README, REQUIREMENTS, CONTROL-STATUS, EXCEPTIONS-LOG, CONTENT-SAFETY-DESIGN) are edited in place.
- **Never commit firm or client data here.** That includes client names, the staff roster and audit worksheets. The
  Gate 1 worksheet is gitignored as `gate1-audit-*.md`.

## The DPA boot check is file-existence only

Under `COMPLIANCE_MODE=client-data`, `loadConfig` in `packages/core/src/config.ts` calls `defaultCheckDpa`. That
function returns true when any file in `docs/compliance/` (relative to the process working directory) starts with
`vendor-dpa-` and ends with `.md`. If none exists, boot fails with an error that points back to this README.

It reads no file content. A file holding only a title passes. So:

- Recording the fields below is a process obligation, not something the code checks. Content validation was planned
  and is not built; see CR-2 in [CONTROL-STATUS.md](CONTROL-STATUS.md#control-register).
- **Never save the template below as `vendor-dpa-<anything>.md`** unless it records a real agreement. That would
  satisfy the gate for an agreement that doesn't exist.
- Conformance records and other files here don't satisfy the check, because only the `vendor-dpa-` prefix counts.

### What a DPA file must record

1. Vendor name and service, for example "Google LLC — Gemini API".
2. DPA reference: a link to, or the document ID of, the agreement.
3. Date signed (ISO 8601), or how the terms were accepted.
4. Whether a no-train clause is confirmed.
5. Whether a zero-retention clause is confirmed.
6. Data region.
7. §7216 and GLBA adequacy: the **[COUNSEL]** sign-off date and name.
8. Renewal or expiry date, if any.

```markdown
# Vendor DPA: <Vendor Name> — <Service>

| Field                 | Value               |
| --------------------- | ------------------- |
| Vendor                |                     |
| Service               |                     |
| DPA reference         |                     |
| Date signed           |                     |
| No-train clause       | ☐ confirmed         |
| Zero-retention clause | ☐ confirmed         |
| Data region           |                     |
| §7216 + GLBA adequacy | [COUNSEL] sign-off: |
| Renewal / expiry      |                     |

## Notes

<any additional conditions, restrictions, or relevant provisions>
```

## Everything COMPLIANCE_MODE=client-data requires at boot

Each row is a hard startup failure, not a degraded mode. The annotations in `env.example` are the operator-facing
version of this table.

| Requirement                                                                     | Enforced in                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A `docs/compliance/vendor-dpa-*.md` file exists                                 | `packages/core/src/config.ts` `loadConfig` → `defaultCheckDpa`                           |
| `CONTENT_SCAN_PROVIDER` is not `none` (Layer 1.5 semantic scan is on)           | `packages/core/src/config.ts` `loadConfig`                                               |
| `CONTENT_SCAN_BASE_URL` looks self-hosted (loopback, private, `*.internal` …)   | `packages/rag/src/content-scanning/ollama-scanner.ts` `createContentScanner`             |
| `EMBEDDING_PROVIDER=local`                                                      | `packages/rag/src/embeddings/factory.ts` `createEmbeddingProvider`                       |
| `HF_CACHE_DIR` names a durable, non-empty path                                  | `packages/rag/src/embeddings/local.ts` `LocalEmbeddingProvider` constructor              |
| Local model weights are already in that cache (runtime downloads are refused)   | `packages/rag/src/embeddings/local.ts`; pre-warm with `scripts/warm-model-verified.sh`   |
| `RERANK_PROVIDER=none` (a hosted reranker would send chunk text out)            | `packages/rag/src/retrieval/reranker.ts` `createReranker`                                |
| Generation TRI policy is forced to `block`, whatever `GENERATION_TRI_POLICY` is | `packages/runtime/src/index.ts` `resolveTriPolicy` (forces the value; doesn't fail boot) |

`env.example` also says to leave `EGRESS_ALLOWED_HOSTS` blank in this mode unless a signed DPA covers each listed
host. The code doesn't check that pairing; it is a process control.

A minimal client-data environment:

```env
COMPLIANCE_MODE=client-data
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=Xenova/bge-base-en-v1.5
HF_CACHE_DIR=/app/.hf-cache        # durable path the image pre-warms
CONTENT_SCAN_PROVIDER=ollama       # self-hosted; see env.example
RERANK_PROVIDER=none
EGRESS_ALLOWED_HOSTS=              # blank unless a DPA covers each host
```

Switching an existing deployment to local embeddings means re-embedding the whole corpus, because embeddings are
immutable per provider and model (root [`CLAUDE.md`](../../CLAUDE.md)).

## The directory is copied into every image

`.dockerignore` excludes `docs/` but carves out `docs/compliance` and `docs/compliance/*.md`. The `rag-api`,
`rag-mcp` and `rag-worker` Dockerfiles (`apps/{api,mcp,worker}/Dockerfile`) copy `docs/compliance` into the runtime
image, because `defaultCheckDpa` resolves the path against the working directory at runtime. Before this carve-out
existed, the check could never pass in a deployed image (fixed 2026-07-04; see
[EXCEPTIONS-LOG.md](EXCEPTIONS-LOG.md#2026-07-04-egress-enabled-before-dpa-verification-compliance_mode-left-at-none)).

Two consequences follow. Every file here ships inside the production images, so nothing confidential belongs here.
And renaming the directory or a `vendor-dpa-*.md` file breaks client-data boot.
