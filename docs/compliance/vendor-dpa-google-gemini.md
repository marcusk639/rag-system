# Vendor DPA: Google LLC — Gemini API (generativelanguage.googleapis.com)

**STATUS: PROVISIONAL — NOT COUNSEL-CONFIRMED.** This file exists to satisfy the
`COMPLIANCE_MODE=client-data` boot gate so the system can demonstrate working
functionality to internal, access-authorized stakeholders. It is explicitly
**not** a substitute for the verification steps in Phase 1.2/1.3 of
`docs/PLAN-CPA-COMPLIANCE.md`, and does not resolve CR-2/CR-3/CR-4 from
`docs/CPA-COMPLIANCE-REQUIREMENTS.md`.

| Field                 | Value                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vendor                | Google LLC                                                                                                                                                                                             |
| Service               | Gemini API (`generativelanguage.googleapis.com`) — used for both generation and embeddings                                                                                                             |
| DPA reference         | [Google Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum) — standard terms, auto-incorporated into Cloud Terms of Service on projects with active Cloud Billing |
| Date signed           | N/A — not a separately executed agreement; auto-accepted by enabling Cloud Billing on the GCP project                                                                                                  |
| No-train clause       | ⚠️ UNCONFIRMED — applies only if the backing GCP project has Cloud Billing enabled; **billing status for the project behind the production `GEMINI_API_KEY` has not been verified**                    |
| Zero-retention clause | ⚠️ UNCONFIRMED — same caveat as above                                                                                                                                                                  |
| Data region           | ⚠️ UNCONFIRMED — not verified; assume default Gemini API region unless Vertex AI regional endpoints are explicitly configured                                                                          |
| §7216 + GLBA adequacy | **[COUNSEL] NOT YET REVIEWED.** No legal sign-off has occurred. Standard (non-negotiated) Cloud DPA adequacy for real taxpayer return information has not been assessed.                               |
| Renewal / expiry      | N/A (rolling, tied to Google Cloud Terms of Service)                                                                                                                                                   |

## Notes

Created 2026-07-04 under explicit, scoped user authorization to unblock
`/ask`/`/search` for an **internal demonstration to primary stakeholders who
are already authorized to view all data** — not for general production use
with unrestricted client access.

**High-priority follow-ups (must happen before this moves beyond internal
demo use):**

1. Confirm in the GCP Console (Billing) that the project backing the
   production `GEMINI_API_KEY` has active Cloud Billing. If it does not, the
   free-tier terms apply instead — no DPA, human review of prompts possible,
   explicit vendor warning against sensitive data.
2. If billing is not enabled, either enable it or switch to
   `EMBEDDING_PROVIDER=local` (self-hosted ONNX, see Phase 1.1 of the plan)
   plus a different generation vendor with a confirmed DPA.
3. Get counsel review (Phase 1.2/Final Phase of the plan) on whether the
   standard, non-negotiated Cloud DPA is legally adequate for this practice's
   §7216/GLBA risk profile, or whether a negotiated/enterprise agreement is
   required.
4. Once (1)–(3) are resolved, update this file's status from PROVISIONAL to
   CONFIRMED with the actual verification date and counsel sign-off name.
