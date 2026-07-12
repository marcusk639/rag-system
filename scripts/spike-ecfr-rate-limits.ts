// One-off spike: hit the eCFR versioner API and record whether it rate-limits us
// before committing the ecfr-part4 connector to depend on it. Run manually; not
// part of the build or test suite.

interface Timing {
  label: string;
  status: number;
  ms: number;
  retryAfter: string | null;
}

async function timedFetch(label: string, url: string): Promise<Timing> {
  const start = Date.now();
  const res = await fetch(url);
  // Drain the body so keep-alive connections are reused for the next request.
  await res.arrayBuffer();
  return {
    label,
    status: res.status,
    ms: Date.now() - start,
    retryAfter: res.headers.get("retry-after"),
  };
}

async function main() {
  const results: Timing[] = [];

  // 1. The titles index — this is the delta cursor source (latest_issue_date per title).
  results.push(
    await timedFetch(
      "titles.json",
      "https://www.ecfr.gov/api/versioner/v1/titles.json",
    ),
  );

  // 2. Ten sequential full-title fetches for Title 38 (worst case: every sync
  //    re-fetches the whole title, since the API's `part` query filter is
  //    known to be ignored for the `full` endpoint -- ecfr.gov returns the
  //    complete title XML regardless of filter params).
  for (let i = 0; i < 10; i++) {
    results.push(
      await timedFetch(
        `full-title-38-req-${i}`,
        "https://www.ecfr.gov/api/versioner/v1/full/2026-01-01/title-38.xml?chapter=I&part=4",
      ),
    );
  }

  console.table(results);
  const any429 = results.some((r) => r.status === 429);
  const anyRetryAfter = results.some((r) => r.retryAfter !== null);
  const maxMs = Math.max(...results.map((r) => r.ms));
  console.log(
    `\nany 429: ${any429}, any retry-after header: ${anyRetryAfter}, slowest request: ${maxMs}ms`,
  );
}

main();
