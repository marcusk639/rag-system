# Vendor DPA: Google LLC — Gemini API (generativelanguage.googleapis.com)

**STATUS: BILLING VERIFIED 2026-08-04 — COUNSEL REVIEW STILL OUTSTANDING.**

> **What changed (2026-08-04).** This file previously read _"PROVISIONAL — NOT
> COUNSEL-CONFIRMED"_ with **billing status unverified**, which left open whether
> free-tier terms applied. **Verified: the backing GCP project is on Cloud Billing
> Tier 1 (prepay) — i.e. an active Cloud Billing account.** For the Gemini
> Developer API (`generativelanguage.googleapis.com`), that is the condition that
> makes the Cloud DPA apply, so **no-train and zero-retention are in force** and
> the free-tier terms (which permit human review of prompts and warn against
> sensitive data) **do not**. This resolves follow-up #1 below.
>
> **What it does NOT resolve:** CR-3 data residency (still unverified) and
> **[COUNSEL] adequacy of the standard, non-negotiated Cloud DPA for this
> practice's §7216/GLBA risk profile** (never reviewed). CR-2 and CR-4 are
> satisfied only to the extent the standard DPA satisfies them. This file is
> still not a substitute for Phase 1.2/1.3 of `docs/PLAN-CPA-COMPLIANCE.md`.
>
> ### Why this was worth verifying retrospectively
>
> On **2026-07-04** the system ingested **844 documents** from the firm's
> SharePoint knowledge base (`ingest_log`: 844 `ingested`, 49 `tri-flagged`), plus
> three `/ask` calls on `gemini-2.5-flash` (`audit_log`, all three by the operator;
> no other user ever queried the system). Embedding text is sent to the vendor at
> ingest, so that was a disclosure event **independent of who later queried it**.
>
> A client-identifier screen on 2026-08-01 subsequently found client-identifying
> material inside that corpus, including one indexed spreadsheet with 522
> SSN-shaped and 518 EIN-shaped values. **So the tier question was not academic:
> it determined whether that content reached Google under DPA terms or under
> free-tier terms.** It reached them under DPA terms.
>
> ⚠ `audit_log.embedding_provider` / `embedding_model` are **NULL** for the three
> July rows — those columns were added 2026-07-09, after the ingest. There is
> therefore **no §10.22 record of which embedder touched the July corpus**; the
> conclusion above rests on the configured default (`gemini`) plus the ingest log,
> not on an audit row. Treat that as a recordkeeping gap, not a resolved fact.
>
> The corpus was purged from the production index on ~2026-08-03 (deliberately,
> for TRI content). That stops further exposure; it does not reach the July event.

| Field                 | Value                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor                | Google LLC                                                                                                                                                                                                     |
| Service               | Gemini API (`generativelanguage.googleapis.com`) — used for both generation and embeddings                                                                                                                     |
| DPA reference         | [Google Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum) — standard terms, auto-incorporated into Cloud Terms of Service on projects with active Cloud Billing         |
| Date signed           | N/A — not a separately executed agreement; auto-accepted by enabling Cloud Billing on the GCP project                                                                                                          |
| No-train clause       | ✅ **IN FORCE (verified 2026-08-04)** — the precondition (active Cloud Billing on the backing project) is met: **Tier 1, prepay**                                                                              |
| Zero-retention clause | ✅ **IN FORCE (verified 2026-08-04)** — same precondition, same verification                                                                                                                                   |
| Data region           | ⚠️ **STILL UNCONFIRMED** — billing status does not establish residency. Assume the default Gemini API region unless Vertex AI regional endpoints are explicitly configured. **This is CR-3 and remains open.** |
| §7216 + GLBA adequacy | **[COUNSEL] NOT YET REVIEWED.** No legal sign-off has occurred. Standard (non-negotiated) Cloud DPA adequacy for real taxpayer return information has not been assessed.                                       |
| Renewal / expiry      | N/A (rolling, tied to Google Cloud Terms of Service)                                                                                                                                                           |

## Notes

Created 2026-07-04 under explicit, scoped user authorization to unblock
`/ask`/`/search` for an **internal demonstration to primary stakeholders who
are already authorized to view all data** — not for general production use
with unrestricted client access.

**High-priority follow-ups (must happen before this moves beyond internal
demo use):**

1. ✅ **RESOLVED 2026-08-04.** Cloud Billing on the backing project is **active
   (Tier 1, prepay)**, so the Cloud DPA applies and free-tier terms do not.
2. ✅ **MOOT** — this was conditional on (1) failing. Billing is enabled, so no
   provider switch is forced. `EMBEDDING_PROVIDER=local` (self-hosted ONNX)
   remains available and is still the stronger posture for any future corpus
   containing real taxpayer data, since it removes the disclosure event entirely
   rather than covering it with an agreement.
3. Get counsel review (Phase 1.2/Final Phase of the plan) on whether the
   standard, non-negotiated Cloud DPA is legally adequate for this practice's
   §7216/GLBA risk profile, or whether a negotiated/enterprise agreement is
   required.
4. **Open — CR-3 data residency.** Billing status does not establish where
   processing happens. Verify the region, or configure a regional endpoint.
5. Once (3) and (4) are resolved, move this file's status from **BILLING
   VERIFIED** to **CONFIRMED**, with the counsel sign-off name and date. Do not
   mark it CONFIRMED on the strength of the billing check alone — that check
   answers who may train on the data, not whether the arrangement is adequate.
