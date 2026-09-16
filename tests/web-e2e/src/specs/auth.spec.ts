import { test, expect } from "../fixtures/auth.js";

import { FIXTURE_SOURCE_NAME } from "../fixtures/corpus.js";

test("the minted cookie reaches a gated route and sees the fixture source", async ({
  page,
}) => {
  const res = await page.goto("/api/sources");
  expect(res?.status()).toBe(200);
  // Not just 200: listPublicSources is scope-filtered, so a missing access
  // grant would return 200 with an empty list. This is assertion 0.
  const body = await res?.text();
  expect(body).toContain(FIXTURE_SOURCE_NAME);
});
