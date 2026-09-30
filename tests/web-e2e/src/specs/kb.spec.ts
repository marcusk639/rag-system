import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth.js";
import { captureSse, readSse } from "../fixtures/sse.js";
import { NONCE_A } from "../fixtures/corpus.js";

/**
 * Submits a question and waits for the full request/stream/response cycle to
 * finish.
 *
 * The assistant message row (`data-testid="assistant-message"`) is rendered
 * synchronously with a "…" placeholder the instant the question is sent —
 * long before any tokens arrive — so waiting on ITS visibility alone does
 * NOT wait for generation to complete. The chat input's disabled state does:
 * `disabled={streaming}` in chat-interface.tsx is driven by the same flag
 * that gates when citations/errors are attached to the message (they are set
 * before `streaming` flips back to false), so bracketing disabled → enabled
 * on the input reliably waits past citation rendering too.
 */
async function ask(page: Page, question: string): Promise<void> {
  await page.goto("/");
  const input = page.getByRole("textbox", {
    name: "Ask about your documents",
  });
  await input.fill(question);
  await page.keyboard.press("Enter");
  await expect(input).toBeDisabled({ timeout: 5_000 });
  await expect(page.getByTestId("assistant-message")).toBeVisible();
  await expect(input).toBeEnabled({ timeout: 90_000 });
}

test(
  "citations resolve to real documents",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    await ask(page, `What does the ${NONCE_A} checklist gate?`);

    const chips = page.getByTestId("citation-chip");
    // Non-empty precondition: without this, the loop below is `[].every(...)`
    // — vacuously true if the model emitted no [N] markers and citations is [].
    await expect(chips).not.toHaveCount(0);

    for (const chip of await chips.all()) {
      const text = await chip.textContent();
      const title = (text ?? "").replace(/^\[\d+\]\s*/, "");

      const docId = await chip.getAttribute("data-doc-id");
      if (docId === null) {
        throw new Error("citation chip is missing data-doc-id");
      }

      // page.request (not the standalone `request` fixture) shares the
      // browser context's cookies, so it carries the session the auth
      // fixture minted — the BFF route requires it.
      const res = await page.request.get(`/api/documents/${docId}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.title).toBe(title);
    }
  },
);

test(
  "self-retrieval: the nonce document is cited",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    await ask(page, `What does the ${NONCE_A} checklist gate?`);

    const chips = page.getByTestId("citation-chip");
    await expect(chips).not.toHaveCount(0);
    await expect(chips.first()).toContainText("New Client Onboarding");
  },
);

test(
  "an out-of-corpus question is refused, not confabulated",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    await ask(
      page,
      "What is our policy on controlled foreign corporation transfer pricing?",
    );

    await expect(page.getByTestId("refusal")).toBeVisible();
    // Citations ARE expected here — do not assert zero. The generation prompt
    // appends "Closest related material: <title> [N]" when a document is
    // plausibly adjacent, so a *correct* refusal on this fixture corpus
    // carries a citation. What must NOT happen is a stream error rendering
    // alongside the refusal text.
    await expect(page.getByTestId("stream-error")).toHaveCount(0);
  },
);

test(
  "rendered chips equal the citations the BFF returned",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    await captureSse(page);
    await ask(page, `What does the ${NONCE_A} checklist gate?`);

    const chips = page.getByTestId("citation-chip");
    // Non-empty precondition — see "citations resolve to real documents".
    await expect(chips).not.toHaveCount(0);
    const chipCount = await chips.count();

    // Safe to read now: `ask()` only returns once the input has re-enabled,
    // which happens after the "done" SSE frame has been processed and
    // rendered — readSse() below reflects the complete stream, not a partial
    // one.
    const payload = findDoneEventPayload(await readSse(page));
    if (payload === undefined) {
      throw new Error(
        "no captured SSE frame carried a 'done' event with a citations array — was the 'done' event ever sent?",
      );
    }
    expect(chipCount).toBe(payload.citations.length);
  },
);

/**
 * Parses raw SSE bytes into frames (blank-line delimited, per the
 * `event:`/`data:` contract in stream-chat.ts) and returns the parsed JSON
 * payload of the `done` event, if one arrived.
 *
 * Selection is structural (event type, then a parsed `citations` array) —
 * NOT a substring match on the raw text. A `token` frame can legitimately
 * stream the literal word "citations" as part of the model's answer; a
 * textual match on that word would pick the wrong frame and blow up with a
 * confusing TypeError instead of a clear assertion failure.
 */
function findDoneEventPayload(
  raw: string,
): { citations: unknown[] } | undefined {
  for (const frame of raw.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (event !== "done" || dataLines.length === 0) continue;

    const parsed: unknown = JSON.parse(dataLines.join("\n"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { citations?: unknown }).citations)
    ) {
      return parsed as { citations: unknown[] };
    }
  }
  return undefined;
}
