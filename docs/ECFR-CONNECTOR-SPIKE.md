# eCFR Connector Spike

Ran `scripts/spike-ecfr-rate-limits.ts` on 2026-07-07.

**Decision rule:** if any request returned 429, or a `retry-after` header appeared, or
the slowest single request exceeded 10s, use the **bulk-xml** fallback
(`https://www.govinfo.gov/bulkdata/ECFR/title-38/ECFR-title38.xml`, a static file, no
per-request rate limit to manage). Otherwise use **rest**
(`https://www.ecfr.gov/api/versioner/v1/full/{date}/title-38.xml`).

**Observed result:**

| label | status | ms | retryAfter |
|-------|--------|-----|-----------|
| titles.json | 200 | 253 | null |
| full-title-38-req-0 | 503 | 6197 | null |
| full-title-38-req-1 | 503 | 13158 | null |
| full-title-38-req-2 | 503 | 19584 | null |
| full-title-38-req-3 | 503 | 3160 | null |
| full-title-38-req-4 | 503 | 30044 | null |
| full-title-38-req-5 | 503 | 14492 | null |
| full-title-38-req-6 | 503 | 3272 | null |
| full-title-38-req-7 | 503 | 11408 | null |
| full-title-38-req-8 | 503 | 11240 | null |
| full-title-38-req-9 | 503 | 40164 | null |

Summary: any 429: false, any retry-after header: false, slowest request: 40164ms

**Follow-up verification** (after discovering script's hardcoded date was stale):
- Date: 2026-06-15 (actual eCFR latest_issue_date)
- Single request to full-title-38 endpoint: status 503, 3381ms
- No retry-after header observed

**Decision:** bulk-xml

**Rationale:** The slowest single request (40164ms) exceeded the 10-second threshold,
meeting the decision rule regardless of root cause.

The observed 503 pattern (all requests returning 503, no `retry-after` header, uniform
pattern on both the original hardcoded date and the corrected date 2026-06-15) is
consistent with **either** transient server capacity issues **or** bot-protection/WAF
blocking triggered by the rapid, sequential, header-less request pattern used in this
spike (no `User-Agent`, no delay between requests). This spike did not distinguish
between these two explanations; the performance threshold was exceeded in either case.

The decisive factor is response latency: some requests took 40+ seconds, violating the
performance baseline needed for a reliable sync strategy. The bulk-xml fallback avoids
per-request overhead and provides a stable, static source.

**Known API quirk (true regardless of decision):** the `full` endpoint's `part` query
parameter does not actually filter server-side — it always returns the complete title
XML. Both paths therefore fetch the whole title once per sync and filter to Part 4
locally in the connector (Task 3), rather than relying on the API to scope the
response.

**Guidance for Task 3 (ecfr-part4 connector implementation):** Before concluding that
the REST API's 503 pattern indicates the endpoint is unreliable and requires retry/backoff
logic, first test a single request with realistic browser-like headers (e.g., a real
`User-Agent` string) to rule out bot-protection/WAF blocking as the root cause. Also
apply the same defensive headers to the bulk-xml govinfo.gov fetch, since it too is an
unauthenticated .gov endpoint that could see similar WAF treatment if requested without
proper client fingerprinting.
