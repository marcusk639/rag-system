#!/usr/bin/env node
/**
 * Tier-1 grounding check against a DEPLOYED knowledge base.
 *
 * Answers three questions that need no CPA review (see the `tier1-automatable`
 * tier in tests/e2e/src/eval/gold-set.ts):
 *
 *   1. CITATION VALIDITY — does every citation resolve to a document that
 *      actually exists? A confident answer citing an invented document is the
 *      failure users cannot detect themselves.
 *   2. SELF-RETRIEVAL — when a question is about a known document, is that
 *      document among the citations?
 *   3. REFUSAL — when the corpus cannot answer, does the system decline
 *      instead of confabulating?
 *
 * ⚠ What this does NOT measure: whether an answer is substantively correct.
 * That is a CPA judgment and needs the gold set (docs/EVAL-GOLD-SET-GUIDE.md).
 * A green run here means "grounded in real documents", not "right".
 *
 * ⚠ Self-retrieval questions derived from document titles share vocabulary
 * with their target, so scores here are a FLOOR, not a quality ceiling —
 * the same lexical-overlap inflation that made the starter corpus useless
 * (docs/EVAL-BASELINE.md). A failure is meaningful; a pass is weak evidence.
 *
 * Usage:
 *   RAG_API_URL=https://... RAG_API_TOKEN=... \
 *   node scripts/check-kb-grounding.mjs <questions.json> [--out report.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

const API = process.env.RAG_API_URL;
const TOKEN = process.env.RAG_API_TOKEN;
if (!API || !TOKEN) {
  console.error("RAG_API_URL and RAG_API_TOKEN are required");
  process.exit(2);
}
const questionsPath = process.argv[2];
if (!questionsPath) {
  console.error(
    "usage: check-kb-grounding.mjs <questions.json> [--out report.json]",
  );
  process.exit(2);
}
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx > -1 ? process.argv[outIdx + 1] : null;

let questions;
try {
  questions = JSON.parse(readFileSync(questionsPath, "utf8"));
} catch (err) {
  console.error(`${questionsPath}: ${err.message}`);
  process.exit(2);
}
if (!Array.isArray(questions) || questions.length === 0) {
  console.error(`${questionsPath}: expected a non-empty JSON array`);
  process.exit(2);
}
// `kind` drives the scorecard bucket and `expectRefusal` drives the scoring
// branch. They are separate fields, so a typo in either silently drops a
// question out of the reported population while still counting as answered.
const KINDS = new Set(["self-retrieval", "out-of-corpus"]);
for (const [i, q] of questions.entries()) {
  const bad = !q?.question
    ? "missing `question`"
    : !KINDS.has(q.kind)
      ? `kind must be one of ${[...KINDS].join(" | ")}, got ${JSON.stringify(q.kind)}`
      : (q.kind === "out-of-corpus") !== Boolean(q.expectRefusal)
        ? "`kind` and `expectRefusal` disagree"
        : q.kind === "self-retrieval" && typeof q.expectDocumentId !== "string"
          ? "self-retrieval needs a string `expectDocumentId`"
          : null;
  if (bad) {
    console.error(`${questionsPath} question[${i}]: ${bad}`);
    process.exit(2);
  }
}
const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

const REFUSAL =
  /\b(cannot|can't|could not|couldn't|unable|no (relevant )?(information|documents?|record)|not (found|available|covered|contain)|does not (appear|contain)|don't have|do not have)\b/i;

const docCache = new Map();
/**
 * → "exists" | "missing", or THROWS on anything else.
 *
 * Treating every non-200 as "missing" turns a expired token or a transient 502
 * into "the KB fabricated a citation" — the most alarming thing this script can
 * report, manufactured from an infrastructure blip. Only the two definitive
 * answers are cached; unknowns are raised so they surface as errors instead.
 */
async function documentExists(id) {
  if (docCache.has(id)) return docCache.get(id);
  const res = await fetch(`${API}/documents/${encodeURIComponent(id)}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 200) {
    const body = await res.json().catch(() => null);
    if (body?.id !== id) {
      throw new Error(
        `documents/${id} returned 200 for a different id (${body?.id}) — ` +
          `something upstream is not serving real documents`,
      );
    }
    docCache.set(id, "exists");
    return "exists";
  }
  if (res.status === 404) {
    docCache.set(id, "missing");
    return "missing";
  }
  throw new Error(
    `cannot verify document ${id}: HTTP ${res.status} — ` +
      `a checker failure, NOT evidence the document is missing`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The API rate-limits /ask per principal. Without pacing, most questions come
 * back 429 and the run reports a score computed from the handful that got
 * through — which looks like a quality measurement and is not one. Honour the
 * advertised retry delay instead of guessing.
 */
async function ask(question, attempt = 0) {
  const res = await fetch(`${API}/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });
  if (res.status === 429 && attempt < 5) {
    // The `retry-after` HEADER is an integer number of seconds. The response
    // BODY humanises it — @fastify/rate-limit renders a full window as
    // "retry in 1 minute", which a `(\d+)` scrape reads as 1 second, burning
    // every retry inside one window. Read the header; fall back to the window.
    const secs = Number(res.headers.get("retry-after")) || 60;
    await sleep((secs + 2) * 1000);
    return ask(question, attempt + 1);
  }
  // Read the body EXACTLY once: a second `res.text()` throws "Body is unusable"
  // and replaces the API's real error with a stream artefact.
  const raw = await res.text();
  if (res.status === 422 && raw.includes("COMPLIANCE_VIOLATION")) {
    // Not a harness error: the generation-time TRI guard refused to answer.
    // A distinct, reportable outcome — the user gets no answer at all.
    return { blockedByGuard: true, guardMessage: raw.slice(0, 200) };
  }
  if (!res.ok)
    throw new Error(`ask failed: ${res.status} ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

// Spacing between questions, on top of 429 backoff. Generation is the slow,
// rate-limited hop; a run that finishes fast because everything 429'd is worse
// than a slow run that actually measures something.
const REQUEST_SPACING_MS = Number(process.env.REQUEST_SPACING_MS ?? 3000);

const results = [];
for (const [i, q] of questions.entries()) {
  process.stdout.write(`[${i + 1}/${questions.length}] `);
  let row = { ...q, pass: false };
  try {
    const r = await ask(q.question);
    if (r.blockedByGuard) {
      row.blockedByGuard = true;
      row.guardMessage = r.guardMessage;
      results.push(row);
      console.log("BLOCKED (TRI guard)");
      await sleep(REQUEST_SPACING_MS);
      continue;
    }
    const citations = r.citations ?? [];
    const answer = r.answer ?? "";

    // Every cited document must resolve. Checked for BOTH question kinds:
    // a fabricated citation on a refusal is still a fabricated citation.
    const invalid = [];
    for (const c of citations) {
      if ((await documentExists(c.documentId)) === "missing") {
        invalid.push(c.documentId);
      }
    }
    row.citationCount = citations.length;
    row.invalidCitations = invalid;

    if (q.expectRefusal) {
      // Refusal is judged on the answer text, not on citation count: the
      // retriever always returns its top-k, so "cited something" is normal
      // even when the corpus has no answer. What matters is that the model
      // does not assert an answer it cannot support.
      // A substring match anywhere in the text scores "…do not contain a 2025
      // deadline, but the standard deadline is April 15" as a refusal — a
      // confabulation counted as the very thing this check exists to catch.
      // A real refusal is short and is nothing but a refusal.
      const trimmed = answer.trim();
      row.answerLength = trimmed.length;
      row.refused =
        REFUSAL.test(trimmed) &&
        trimmed.length <= 400 &&
        !/\b(however|but|that said|based on|according to)\b/i.test(trimmed);
      row.pass = row.refused && invalid.length === 0;
    } else {
      row.retrievedExpected = citations.some(
        (c) => c.documentId === q.expectDocumentId,
      );
      row.pass = row.retrievedExpected && invalid.length === 0;
    }
    row.answerPreview = answer.slice(0, 120);
  } catch (err) {
    row.error = String(err.message ?? err);
  }
  results.push(row);
  console.log(
    row.pass ? "pass" : `FAIL${row.error ? " (" + row.error + ")" : ""}`,
  );
  await sleep(REQUEST_SPACING_MS);
}

const self = results.filter((r) => r.kind === "self-retrieval");
const oob = results.filter((r) => r.kind === "out-of-corpus");
const blocked = results.filter((r) => r.blockedByGuard);
const errored = results.filter((r) => r.error);
const measured = results.filter((r) => !r.error && !r.blockedByGuard);
const invalidTotal = results.reduce(
  (n, r) => n + (r.invalidCitations?.length ?? 0),
  0,
);
const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

const selfMeasured = self.filter((r) => !r.error && !r.blockedByGuard);
const oobMeasured = oob.filter((r) => !r.error && !r.blockedByGuard);

console.log("\n─── grounding scorecard ───");
console.log(
  `answered          : ${measured.length}/${results.length} (blocked by TRI guard: ${blocked.length}, errors: ${errored.length})`,
);
console.log(
  `citation validity : ${invalidTotal} invalid citation(s) across ${measured.length} answers`,
);
console.log(
  `self-retrieval    : ${selfMeasured.filter((r) => r.retrievedExpected).length}/${selfMeasured.length} (${pct(selfMeasured.filter((r) => r.retrievedExpected).length, selfMeasured.length)}) — of questions that ANSWERED`,
);
console.log(
  `refusal           : ${oobMeasured.filter((r) => r.refused).length}/${oobMeasured.length}`,
);
if (errored.length > 0)
  console.log(
    `\n⚠ ${errored.length} question(s) errored — every rate above is computed only over questions that ran, so treat them as provisional until this is zero.`,
  );

if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), api: API, results },
      null,
      2,
    ),
  );
  console.log(`\nreport: ${outPath}`);
}
// What gates, and what deliberately does not.
//
// Self-retrieval is excluded on purpose: title-derived questions share
// vocabulary with their targets, so the rate is a ceiling and cannot support a
// threshold. EVERYTHING ELSE gates. The first version of this script gated on
// citation validity and errors alone, which meant the run that discovered a
// third of the corpus was unanswerable exited 0 — and a KB that confabulated
// every out-of-corpus answer would also have exited 0.
const refusalFailures = oobMeasured.filter((r) => !r.refused).length;
if (refusalFailures > 0) {
  console.log(
    `\n✗ ${refusalFailures} out-of-corpus question(s) were NOT refused — confabulation.`,
  );
}
if (blocked.length > 0) {
  console.log(
    `\n✗ ${blocked.length} question(s) were blocked by the TRI guard — the user gets no answer.`,
  );
}
if (measured.length === 0) {
  console.log(
    "\n✗ zero questions produced a measurable answer — this run measured nothing.",
  );
}
if (selfMeasured.filter((r) => !r.retrievedExpected).length > 0) {
  console.log(
    `\nNOTE: ${selfMeasured.filter((r) => !r.retrievedExpected).length} self-retrieval miss(es) do NOT affect the exit code — ` +
      `title-derived questions cannot support a threshold (docs/EVAL-BASELINE.md).`,
  );
}
process.exit(
  invalidTotal > 0 ||
    errored.length > 0 ||
    refusalFailures > 0 ||
    blocked.length > 0 ||
    measured.length === 0
    ? 1
    : 0,
);
