# PII redaction before chunking, indexing, or storage

**Status:** design — not built. **Blocks:** re-ingestion of the firm corpus.
**Context:** the index was purged 2026-08-03 after a screen found client
identifiers in 355 of 858 documents. Nothing is re-ingested until this exists.

> **The design constraint that shapes everything below.** Redaction must happen
> **before the embedding call**, not before storage. Embeddings go to a third
> party — production uses `gemini-embedding-001`. A pipeline that redacts on the
> way into Postgres but embeds the raw text has protected the database and
> disclosed the document. That is precisely what happened here: the content was
> already sent to Google before anyone screened it.

---

## Where it has to sit

```
connector ──▶ parse ──▶ ❶ REDACT ──▶ chunk ──▶ ❷ embed (EGRESS) ──▶ store
                            ▲                        │
                            └── must be upstream of ─┘
```

❶ before ❷ is the whole requirement. Redacting after chunking is acceptable only
if no chunk has left the process — and since the embedder is the first thing that
touches a chunk, in practice redaction belongs immediately after parse.

**Corollary:** the redactor cannot depend on anything that requires a network
call, or it becomes an egress path itself.

---

## Three layers, because no single one is sufficient

### Layer 1 — deterministic pattern redaction (the floor)

Regex/checksum detection for structured identifiers, applied to parsed text:

| Identifier      | Detection                                                    | Note                                           |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| SSN / ITIN      | `\d{3}-\d{2}-\d{4}` and bare 9-digit runs in numeric context | ⚠ bare 9-digit is noisy — needs context gating |
| EIN             | `\d{2}-\d{7}`                                                |                                                |
| Bank routing    | 9-digit + ABA checksum                                       | Checksum kills most false positives            |
| Account numbers | Long digit runs near account vocabulary                      | Weakest signal; expect misses                  |
| Credit card     | Luhn check                                                   | Cheap and precise                              |

**Deterministic, offline, fast, auditable.** It is also the only layer that can
be _proven_ to run — which is why it is the floor rather than the whole answer.

⚠ **It will not catch a client's name.** Names are the most common identifier in
this corpus and are undetectable by pattern. Anyone who believes Layer 1 alone
solves the problem has misread what the screen found — per-client billing files
were identified by _folder_, not by content pattern.

### Layer 2 — structural exclusion (the highest-value layer)

**Do not ingest what should never be indexed.** The screen's most useful signal
was not a pattern at all — it was location: per-client billing and pricing files
sitting under client-named folders.

- Path-prefix denylist on the connector (client-package, pricing-sheet, billing
  and production analysis folders)
- Optional allowlist mode: index only paths explicitly approved

**This is cheaper and more reliable than any detector**, because it never reads
the file. A document not fetched cannot leak. Expect this layer to remove most of
the genuine risk in this corpus.

### Layer 3 — classification gate at ingest

Every document gets a data class before indexing; anything not confidently
Class A/B is quarantined for human review rather than indexed. `classify-source.ts`
and the `data_class` column already exist — today `general` is a **default**, not
a judgment, which is exactly how 355 flagged documents got in.

---

## What redaction must NOT be trusted to do

- **It is not a substitute for the content audit.** A redactor is a net, not a
  guarantee; P0 #1 still needs Chris or Doug on a document list.
- **It cannot un-disclose what was already sent.** Layers here protect future
  ingestion. The 2026-08-03 disclosure to Google is a counsel question, not an
  engineering one.
- **It must fail closed.** If the redactor errors on a document, that document is
  **quarantined, not indexed raw**. A redactor that silently passes text through
  on failure is worse than none, because it manufactures confidence.

---

## Verification — the part that makes it real

A redactor nobody has tested against real failures is a hypothesis.

1. **Replay the manifest.** `corpus-analysis/PRE-PURGE-MANIFEST-2026-08-03.jsonl`
   records all 858 documents with their pattern hits and a severity ranking
   (17 high / 338 review / 503 clean). **Re-running ingestion must reduce the
   flagged count to zero**, and that is a measurable pass/fail — the rare case
   where remediation has an objective test.
2. **Re-run the screen after re-ingestion**, not before, and compare against the
   manifest rather than against expectations.
3. **Golden redaction tests** — a fixture set with known identifiers, asserting
   both that they are removed and that surrounding text survives. Over-redaction
   destroys the SOPs the assistant exists to answer from.

⚠ **Watch for the failure that looks like success:** a redactor aggressive enough
to strip every number turns a tax SOP into unusable prose. The corpus is _mostly_
legitimate procedures — 316 of 355 hits were documents that merely name a form.
Precision matters as much as recall here.

---

## Sequencing

1. Layer 2 (path exclusion) — cheapest, removes most real risk, no detector needed
2. Layer 1 (pattern redaction) + fail-closed quarantine
3. Re-ingest into a **staging** source, screen it, compare to the manifest
4. Only then promote to the live index
5. Layer 3 (classification gate) before the corpus widens beyond SharePoint

**Do not re-ingest before step 3 passes.** The manifest exists precisely so that
"is it clean now?" is answerable with evidence rather than assertion.
