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

**Decision:** bulk-xml

**Rationale:** The slowest single request (40164ms) exceeded the 10-second threshold.
The API returned 503 Service Unavailable errors for most title-fetch requests (likely
transient issues), but the decisive factor is response latency: some requests took 40+ 
seconds, which violates the performance baseline needed for a reliable sync strategy. 
The bulk-xml fallback avoids per-request overhead and provides a stable, static source.

**Known API quirk (true regardless of decision):** the `full` endpoint's `part` query
parameter does not actually filter server-side — it always returns the complete title
XML. Both paths therefore fetch the whole title once per sync and filter to Part 4
locally in the connector (Task 3), rather than relying on the API to scope the
response.
