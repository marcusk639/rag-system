import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/auth.js";
import { captureSse, readSse } from "../fixtures/sse.js";
import { NONCE_A, NONCE_B, NONCE_C, NONCE_D } from "../fixtures/corpus.js";
import { docIds } from "../fixtures/doc-ids.js";
import { PROVIDER } from "../env.js";

/**
 * Must equal EMPTY_ANSWER in packages/services/src/ask.ts. Not imported:
 * @rag/services pulls in onnxruntime-node, which SIGABRTs this runner process
 * on exit. Drift fails CLOSED — the refusal badge (which renders off the app's
 * own copy) and the strip in `substantiveRemainder` both stop matching, so the
 * refusal specs go red rather than silently green.
 */
const EMPTY_ANSWER =
  "The available documents do not contain enough information to answer that.";

const ONBOARDING_QUESTION = `What does the ${NONCE_A} checklist gate?`;

/**
 * Latency budgets, in ms. REPORT-ONLY unless set: timings are always recorded
 * as annotations, but only enforced when the env var is provided. A fixed
 * default failed correct answers — gemini-2.5-flash thinks by default before
 * its first visible chunk, so an uncalibrated 5s first-token bound goes red on
 * normal answers. Calibrate from the p95 of a measured pilot-config run, then
 * set these for the gate. Measured from a developer machine: necessary, not
 * sufficient — time the deployed pilot too.
 */
const FIRST_TOKEN_BUDGET_MS = readBudget("WEB_E2E_FIRST_TOKEN_BUDGET_MS");
const TOTAL_BUDGET_MS = readBudget("WEB_E2E_TOTAL_BUDGET_MS");

function readBudget(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      `[web-e2e] ${name} must be a positive number, got "${raw}"`,
    );
  }
  return ms;
}

interface Asked {
  answer: string;
  firstTokenMs: number;
  totalMs: number;
}

/**
 * Submits a question, waits for the full request/stream/response cycle, and
 * returns the answer text plus two timings.
 *
 * The assistant row renders a "…" placeholder the instant the question is
 * sent, so its visibility says nothing. First token = placeholder replaced by
 * real text (what a staff member perceives as "it started answering"). Total =
 * the input re-enabling: `disabled={streaming}` is driven by the same flag
 * that gates attaching citations/errors, so this waits past chip rendering.
 */
async function ask(page: Page, question: string): Promise<Asked> {
  await page.goto("/");
  const input = page.getByRole("textbox", {
    name: "Ask about your documents",
  });
  const message = page.getByTestId("assistant-message");
  await input.fill(question);

  const started = Date.now();
  await page.keyboard.press("Enter");
  await expect(input).toBeDisabled({ timeout: 5_000 });
  await expect(message).toBeVisible();
  await expect(message).not.toHaveText("…", { timeout: 90_000 });
  const firstTokenMs = Date.now() - started;
  await expect(input).toBeEnabled({ timeout: 90_000 });
  const totalMs = Date.now() - started;

  test.info().annotations.push({
    type: "latency",
    description: `${PROVIDER} first-token=${firstTokenMs}ms total=${totalMs}ms :: ${question}`,
  });
  // Soft: a slow answer is reported without hiding the content assertions
  // that follow. The test still fails.
  if (FIRST_TOKEN_BUDGET_MS !== undefined) {
    expect
      .soft(firstTokenMs, "time to first token over budget")
      .toBeLessThan(FIRST_TOKEN_BUDGET_MS);
  }
  if (TOTAL_BUDGET_MS !== undefined) {
    expect
      .soft(totalMs, "total answer time over budget")
      .toBeLessThan(TOTAL_BUDGET_MS);
  }

  return { answer: (await message.textContent()) ?? "", firstTokenMs, totalMs };
}

/** (index, documentId) pairs as rendered, in DOM order. */
async function renderedCitations(
  page: Page,
): Promise<{ index: number; documentId: string }[]> {
  const chips = page.getByTestId("citation-chip");
  const out: { index: number; documentId: string }[] = [];
  for (const chip of await chips.all()) {
    const match = /^\[(\d+)\]/.exec((await chip.textContent()) ?? "");
    const documentId = await chip.getAttribute("data-doc-id");
    if (!match?.[1] || documentId === null) {
      throw new Error("citation chip is missing its [N] index or data-doc-id");
    }
    out.push({ index: Number(match[1]), documentId });
  }
  return out;
}

/**
 * Citation indices referenced in answer text. Mirrors `citedIndices` in
 * packages/rag/src/generation/generator.ts, INCLUDING its en/em-dash range
 * separators (`[1–3]`, `[1—3]`) — models, Gemini especially, emit typographic
 * dashes, and missing them would drop real markers.
 *
 * Used only for a SUBSET check (markers ⊆ chips), never equality: if this ever
 * drifts behind production and under-collects, the check weakens rather than
 * failing a correct answer. Known limit, shared with production: a
 * non-citation bracketed number such as "[2024]" is collected as a marker.
 */
function markerIndices(answer: string): Set<number> {
  const found = new Set<number>();
  for (const [, body] of answer.matchAll(/\[([\d\s,–—-]+)\]/g)) {
    for (const part of (body ?? "").split(",")) {
      const range = /^\s*(\d+)\s*[–—-]\s*(\d+)\s*$/.exec(part);
      if (range?.[1] && range[2]) {
        const lo = Number(range[1]);
        const hi = Number(range[2]);
        if (hi >= lo && hi - lo <= 50) {
          for (let i = lo; i <= hi; i++) found.add(i);
        }
      } else if (/^\s*\d+\s*$/.test(part)) {
        found.add(Number(part));
      }
    }
  }
  return found;
}

/** Text is compared case-insensitively: a model may capitalize a code. */
const includesCi = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * One "<title> [N]" entry on a related-material line, where the title must be
 * one of the in-scope fixture document titles (optionally in its "Admin - …"
 * connector form, optionally wrapped in quotes or emphasis).
 *
 * Pinned to the ACTUAL titles, not a character class: invented prose made only
 * of letters and spaces ("…Office Equipment [1]; however partner approval is
 * required [1]") matched a title-like class as a second "title" and was erased
 * — the exact confabulation this strip exists to expose. Stored titles are the
 * parser-derived H1 headings (see corpus.ts), not the connector titles. If a
 * fixture heading changes, nothing is stripped and refusal specs go red: fails
 * closed.
 */
const RELATED_TITLES = [
  "New Client Onboarding",
  "Office Equipment",
  "Courier Shipments",
];
const RELATED_TITLE = String.raw`(?:Admin - (?:SOP|Note) - )?(?:${RELATED_TITLES.join("|")})`;
const RELATED_ENTRY = String.raw`["'“”*_]*${RELATED_TITLE}["'“”*_]*\s*\[\d+\]`;
const RELATED_LINE = new RegExp(
  String.raw`Closest related material:\s*${RELATED_ENTRY}(?:\s*[,;]\s*(?:and\s+)?${RELATED_ENTRY})*`,
  "i",
);

/** Courtesy wrappers a model may put around a refusal; not content. */
const REFUSAL_PREAMBLE =
  /^(?:i['’]?m sorry,?\s*(?:but\s*)?|i apologi[sz]e,?\s*(?:but\s*)?|unfortunately,?\s*)/i;

/**
 * The answer with the sanctioned refusal lines removed. A correct refusal
 * (coverage mode C in generator.ts) is EMPTY_ANSWER plus, optionally, a
 * "Closest related material: <title> [N]" line — so anything left over is
 * content the model added after claiming it had nothing.
 *
 * Tolerates presentation that is not content: the sentence kept in the
 * prompt's quotation marks or bolded (textContent drops the markup), a courtesy
 * preamble, several related titles, and stray punctuation. A refusal reworded
 * so far that EMPTY_ANSWER no longer appears still fails — correctly, because
 * the product's refusal badge is lost the same way.
 */
function substantiveRemainder(answer: string): string {
  return answer
    .replace(EMPTY_ANSWER, "")
    .replace(RELATED_LINE, "")
    .replace(/^[\s.;:,"'“”*_]+|[\s.;:,"'“”*_]+$/g, "")
    .replace(REFUSAL_PREAMBLE, "")
    .replace(/^[\s.;:,"'“”*_]+|[\s.;:,"'“”*_]+$/g, "");
}

test(
  "the onboarding answer is grounded in the onboarding SOP",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    const { answer } = await ask(page, ONBOARDING_QUESTION);
    const ids = docIds();

    // Doc A's actual fact. Soundness: nothing but the fixture could supply it
    // in answer to a question keyed on an invented nonce. (Verified on llama:
    // with doc A removed from context the model never says "engagement letter",
    // so the phrase does not leak from the prompt's similar worked example.)
    expect(answer).toMatch(/engagement letter|letter of engagement/i);
    // Content from the other fixture documents must not bleed in. Case-
    // insensitive: a capitalized leak is still a leak.
    expect(includesCi(answer, NONCE_B), "doc B content leaked").toBe(false);
    expect(includesCi(answer, NONCE_C), "doc C content leaked").toBe(false);

    const cited = await renderedCitations(page);
    expect(cited.length).toBeGreaterThan(0);
    // By document id, not chip position: chips are the cited subset in index
    // order, so "first chip is Onboarding" passes even with ranking inverted.
    expect(cited.map((c) => c.documentId)).toContain(ids.a);
  },
);

test(
  "the toner answer comes from the facilities note (retrieval reached the model)",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    // No nonce in the question: the model can only produce NONCE_B by having
    // retrieved doc B into its context. This is the end-to-end proof that
    // retrieval feeds generation, not just that citations render.
    const { answer } = await ask(
      page,
      "What purchase code is toner ordered against?",
    );

    expect(
      includesCi(answer, NONCE_B),
      `answer lacks ${NONCE_B}: ${answer}`,
    ).toBe(true);
    const cited = await renderedCitations(page);
    expect(cited.map((c) => c.documentId)).toContain(docIds().b);
  },
);

test(
  "a name-shaped fact is answered, not refused, alongside the onboarding SOP",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    // Doc D states its fact the way real SOPs do ("billed against the <X>
    // account code"), and doc A — which mirrors the prompt's worked example — is
    // in context. That combination is associated with llama refusing answerable
    // questions. In gemini mode this is the pilot-risk check: staff get "not in
    // the documents" for facts that ARE in the documents. Run it repeatedly
    // (the gate uses --repeat-each) — one sample cannot measure a refusal rate.
    const { answer } = await ask(
      page,
      "What account code are courier shipments billed against?",
    );

    expect(
      includesCi(answer, NONCE_D),
      `answer lacks ${NONCE_D}: ${answer}`,
    ).toBe(true);
    const cited = await renderedCitations(page);
    expect(cited.map((c) => c.documentId)).toContain(docIds().d);
  },
);

test(
  "citations resolve to real documents",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    await ask(page, ONBOARDING_QUESTION);

    const chips = page.getByTestId("citation-chip");
    // Non-empty precondition: without this the loop is `[].every(...)` —
    // vacuously true if the model emitted no markers and citations is [].
    await expect(chips).not.toHaveCount(0);

    for (const chip of await chips.all()) {
      const title = ((await chip.textContent()) ?? "").replace(
        /^\[\d+\]\s*/,
        "",
      );
      const docId = await chip.getAttribute("data-doc-id");
      if (docId === null)
        throw new Error("citation chip is missing data-doc-id");

      // page.request (not the standalone `request` fixture) shares the browser
      // context's cookies, so it carries the minted session the BFF requires.
      const res = await page.request.get(`/api/documents/${docId}`);
      expect(res.status()).toBe(200);
      expect((await res.json()).title).toBe(title);
    }
  },
);

test(
  "rendered chips match the BFF citations exactly, with no dangling markers",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    await captureSse(page);
    const { answer } = await ask(page, ONBOARDING_QUESTION);

    const cited = await renderedCitations(page);
    expect(cited.length).toBeGreaterThan(0);

    // Safe to read now: ask() returns only after the input re-enables, which
    // follows processing of the "done" frame.
    const payload = await donePayload(page);
    // Exact (index, documentId) pairs in order — a count match would pass with
    // chips reordered, duplicated, or pointing at the wrong documents.
    expect(cited).toEqual(
      payload.citations.map((c) => ({
        index: c.index,
        documentId: c.documentId,
      })),
    );

    // Every [N] the reader sees must have a chip. filterCitationsToAnswer
    // already guarantees chips ⊆ markers; the reverse — a marker citing a source
    // that does not exist — is a grounding defect nothing else catches.
    const chipIndices = new Set(cited.map((c) => c.index));
    const dangling = [...markerIndices(answer)].filter(
      (i) => !chipIndices.has(i),
    );
    expect(dangling, `markers with no chip in: ${answer}`).toEqual([]);
  },
);

test(
  "an out-of-corpus question is refused, not confabulated",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    const { answer } = await ask(
      page,
      "What is our policy on controlled foreign corporation transfer pricing?",
    );

    await expect(page.getByTestId("refusal")).toBeVisible();
    await expect(page.getByTestId("stream-error")).toHaveCount(0);
    // The badge is a substring match, so "<refusal>. However, our CFC policy
    // requires…" shows it too. Refused means NOTHING beyond the sanctioned
    // lines. (Citations are legitimately present via "Closest related material"
    // — do not assert zero.)
    expect(
      substantiveRemainder(answer),
      `unsanctioned content in: ${answer}`,
    ).toBe("");
  },
);

test(
  "a near-miss question does not get an invented specific",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    // The onboarding SOP mentions the engagement letter but gives no deadline.
    // This is where confabulation actually happens: related material exists, so
    // the model is tempted to fill the gap. Per generator.ts coverage rules the
    // correct response is mode B (answer the covered part, then "Not covered by
    // the documents:") or mode C (refusal).
    const { answer } = await ask(
      page,
      "How many days does a client have to countersign the engagement letter?",
    );

    // Acknowledging the gap in any of the ways a correct answer might phrase
    // it. Deliberately lenient — the load-bearing check is the invented-specific
    // ban below, which is what a staff member would actually be misled by.
    expect(answer).toMatch(
      /not covered by the documents|do not contain enough information|(?:do not|don['’]t|does not|doesn['’]t) (?:specify|state|say|mention|include|provide|give)|not (?:specified|stated|mentioned|provided|given)/i,
    );

    // Neither doc A nor the question contains any number or duration, so ANY
    // in the answer was invented. Citation markers are stripped first (they are
    // digits). "day"/"days" is allowed only because the question itself uses
    // it — a correct mode B names the gap ("the number of days…").
    const prose = answer.replace(/\[[^\]]*\]/g, "");
    expect(prose, "invented number").not.toMatch(/\d/);
    expect(prose, "invented duration").not.toMatch(
      /\b(weeks?|fortnights?|months?|hours?|years?|quarters?)\b/i,
    );
    expect(prose, "invented number word").not.toMatch(
      /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|few|several|couple)\b/i,
    );
  },
);

test(
  "a document in an ungranted source never reaches the model or the user",
  { tag: "@needs-8b-model" },
  async ({ page }) => {
    const ids = docIds();
    await captureSse(page);
    const { answer } = await ask(
      page,
      "What ledger are partner draws reconciled against?",
    );

    // LOAD-BEARING, and model-independent: `retrieved` is the exact array
    // askQuestion hands to the generator (ask.ts), streamed through the BFF
    // byte-for-byte. Doc C absent here means it never entered the model's
    // context — regardless of how the model phrases a refusal.
    const retrievedIds = (await donePayload(page)).retrieved.map(
      (r) => r.document.id,
    );
    // Positive control: both in-scope docs ARE present. Retrieval has no score
    // threshold and top-K exceeds the in-scope chunk count, so they always are.
    // This also proves `document.id` is the right path — a wrong path yields
    // undefined everywhere and the exclusion below would pass vacuously.
    expect(retrievedIds).toContain(ids.a);
    expect(retrievedIds).toContain(ids.b);
    expect(retrievedIds).not.toContain(ids.c);

    // Secondary, model-dependent: what the user sees.
    expect(includesCi(answer, NONCE_C), "doc C content leaked").toBe(false);
    const cited = await renderedCitations(page);
    expect(cited.map((c) => c.documentId)).not.toContain(ids.c);

    // The documents route: positive control first, so a route that 404s for
    // everything cannot pass. Out-of-scope must be indistinguishable from
    // nonexistent (P1b) — a 403 would confirm the document exists.
    const allowed = await page.request.get(`/api/documents/${ids.a}`);
    expect(allowed.status()).toBe(200);
    const denied = await page.request.get(`/api/documents/${ids.c}`);
    expect(denied.status()).toBe(404);
  },
);

interface DonePayload {
  citations: { index: number; documentId: string }[];
  retrieved: { document: { id: string } }[];
}

/** The parsed `done` frame from the captured stream; throws if absent. */
async function donePayload(page: Page): Promise<DonePayload> {
  const payload = findDoneEventPayload(await readSse(page));
  if (payload === undefined) {
    throw new Error(
      "no captured SSE frame carried a 'done' event with citations and retrieved arrays — was the 'done' event ever sent?",
    );
  }
  return payload;
}

/**
 * Parses raw SSE bytes into frames (blank-line delimited, per the
 * `event:`/`data:` contract in stream-chat.ts) and returns the parsed JSON
 * payload of the `done` event, if one arrived.
 *
 * Selection is structural (event type, then parsed arrays) — NOT a substring
 * match: a `token` frame can legitimately stream the word "citations" as part
 * of the answer.
 */
function findDoneEventPayload(raw: string): DonePayload | undefined {
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
      Array.isArray((parsed as { citations?: unknown }).citations) &&
      Array.isArray((parsed as { retrieved?: unknown }).retrieved)
    ) {
      return parsed as DonePayload;
    }
  }
  return undefined;
}
