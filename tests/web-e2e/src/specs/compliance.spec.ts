import { test, expect } from "@playwright/test";
import { E2E_ENV, API_PORT } from "../env.js";

// Alphabetically first among the spec files (compliance < grant < seed < smoke
// < stack), and this suite runs with fullyParallel: false / workers: 1, so
// this is the first assertion Playwright executes against the running API.
// It exists to fail loudly and specifically if the configured generation
// model stops emitting [N] citation markers: `filterCitationsToAnswer` keeps
// only citations referenced by a marker in the answer text, so a model that
// emits none produces an empty citations array — and every later spec that
// loops over citations (`[].every(...)`) would pass vacuously instead of
// catching the regression.
test(
  "the API answers with at least one citation",
  { tag: "@needs-8b-model" },
  async ({ request }) => {
    const res = await request.post(`http://localhost:${API_PORT}/ask`, {
      headers: { authorization: `Bearer ${E2E_ENV.API_TOKENS}` },
      data: { question: "What is the first step to onboard a new client?" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.citations.length).toBeGreaterThan(0);
  },
);
