/**
 * Compare GENERATION models over an identical, locally-seeded corpus.
 *
 * ## Why this exists
 *
 * `run-real-eval.ts` measures RETRIEVAL only — it varies `EMBEDDING_PROVIDER`
 * and never constructs a generator, so changing `GENERATION_MODEL` cannot move
 * its numbers. `eval:gold` is the answer-quality harness but is inert while
 * `GOLD_QUESTIONS` is empty. This fills the gap for one specific question:
 * if generation moves to a self-hosted model, does the system still CITE
 * correctly and REFUSE correctly?
 *
 * ## What it measures (and what it does not)
 *
 * Tier-1 grounding only, the same three properties as
 * `scripts/check-kb-grounding.mjs`:
 *   - CITATION VALIDITY — does every citation resolve to a seeded document?
 *   - SELF-RETRIEVAL     — is a labeled-relevant document among the citations?
 *   - REFUSAL            — on the 8 out-of-corpus negatives, does it decline?
 *
 * It does NOT measure substantive correctness — that needs the gold set and a
 * CPA. A green run means "grounded in real documents", not "right". Retrieval
 * is held constant across models (same seeded corpus, same embedder), so any
 * delta is attributable to generation.
 *
 * ⚠ Coverage is classified by REGEX over the answer text (see `classify`).
 * That is a heuristic, not ground truth. Read `--verbose` output before
 * trusting a regression, and treat single-run deltas under ~3 as noise --
 * llama3.2:3b measured 19/20, 16/20, 17/20 and 20/20 across four runs on
 * identical inputs.
 *
 * ⚠ KNOW WHICH WAY THE ERROR RUNS. `classify` requires the prescribed refusal
 * sentence (or the rubric label) on the OPENING line, so a model that declines
 * in gap language -- "X is not explicitly covered by the available documents"
 * -- scores as B, i.e. ANSWERED. Therefore:
 *   - `refused (of neg)` is a FLOOR. Real refusal is >= the number shown.
 *   - the `confabulated` list is an UPPER BOUND and will contain genuine
 *     refusals phrased in gap language. Read them before believing them; two
 *     of llama3.2:3b's appeared there and both were real declines.
 * This is deliberate. The predicate it replaced erred the other way, scoring
 * "<refusal sentence>. However, <fabricated answer> [1]" as a correct refusal
 * -- a confabulation counted as the thing the negatives exist to catch. Being
 * wrong toward "flag it for a human" is recoverable; being wrong toward
 * "scored green" is not.
 *
 * ⚠ `answered` counts coverage A + B. A B response -- a cited partial answer
 * naming its gap -- is a SUCCESS, not a refusal. An earlier single-predicate
 * version of this harness scored paraphrased B markers as refusals; see
 * `classify` for what it did and did not get wrong.
 *
 * ⚠ TRUNCATES the target database. Point `DATABASE_URL` at a local dev DB.
 *
 * ## Usage
 *
 *   DATABASE_URL=postgres://rag:rag@localhost:5432/rag \
 *   EMBEDDING_PROVIDER=local EMBEDDING_DIMENSIONS=768 \
 *   GENERATION_PROVIDER=openai GENERATION_BASE_URL=http://127.0.0.1:11434/v1 \
 *   EGRESS_ALLOWED_HOSTS=127.0.0.1 API_TOKENS=dev-token \
 *   LOCAL_EVAL_MODELS=qwen2.5:3b,llama3.1:8b \
 *   tsx src/eval/run-local-generation-eval.ts [--verbose]
 *
 * `LOCAL_EVAL_MODELS` is a comma-separated list; each is run in turn against
 * the SAME seeded corpus. `GENERATION_MODEL` is overridden per model.
 */
import { ADMIN_SCOPE, loadConfig } from "@rag/core";
import { buildCoreDeps } from "@rag/runtime";
import { EMPTY_ANSWER, askQuestion } from "@rag/services";
import pino from "pino";
import { createCustomSource, truncateAll } from "../helpers/db.js";
import { seedEvalCorpus } from "./run-eval.js";
import {
  EVAL_DOCS_CPA,
  EVAL_NEGATIVES_CPA,
  EVAL_QUESTIONS_CPA,
} from "./corpus-cpa.js";

const VERBOSE = process.argv.includes("--verbose");

/**
 * Classify an answer into the prompt's own three coverage cases
 * (generator.ts SYSTEM_PROMPT, "## Coverage — pick one of three").
 *
 * ## This is the third refusal predicate in the repo, and deliberately the
 * ## strictest. Read before changing it.
 *
 * Two already existed, and an earlier version of this file ignored both and
 * invented a looser one. PR review caught four misclassifications in it,
 * including a safety-critical inversion. The prior art:
 *
 *   - `gold-eval.ts:48-55` anchors on the OPENING LINE, because case C opens
 *     with the prescribed sentence. Matching anywhere misreads an answer that
 *     merely quotes it. Pinned by `specs/gold-eval.spec.ts:56,95`.
 *   - `scripts/check-kb-grounding.mjs:195-205` additionally caps length and
 *     rejects continuation words, with a comment naming the exact attack:
 *     "...do not contain a 2025 deadline, BUT the standard deadline is April
 *     15" is a confabulation, and counting it as a refusal scores the very
 *     failure the check exists to catch.
 *
 * This predicate applies all three guards. The loose version scored
 * `"<refusal sentence>. However, the standard IRS mileage rate for 2025 is 70
 * cents per mile [1]."` as a CORRECT REFUSAL on a negative. That is the worst
 * possible direction to be wrong in: the negatives column exists precisely to
 * catch a model answering an out-of-corpus question confidently.
 *
 * Citation count is deliberately NOT a signal. The retriever always returns
 * its top-k, so "cited something" is normal even when the corpus cannot answer
 * (`check-kb-grounding.mjs:195-197`). The previous `citationCount > 1`
 * discriminator also scored a one-citation case B as C, which deflated the
 * headline `answered` metric.
 *
 * These three predicates should be consolidated into `@rag/core` or
 * `@rag/services`; `EMPTY_ANSWER` is now importable here (this package gained
 * `@rag/services`), which removes the stated reason `gold-eval.ts:43` restates
 * the sentence by hand. Left as a follow-up rather than done here so this
 * change does not alter `eval:gold` behaviour.
 */
type Coverage = "A" | "B" | "C";

/**
 * The prescribed case-C sentence, taken from the single source of truth rather
 * than re-encoded: `@rag/services` EMPTY_ANSWER is byte-identical to the
 * sentence `generator.ts:71` prescribes.
 */
const REFUSAL_SENTENCE = EMPTY_ANSWER.replace(/\.$/, "");

/** The rubric LABEL, which small models echo in place of the sentence. */
const REFUSAL_LABEL = "do not bear on the question";

/**
 * A real case C is short and is nothing but a refusal, optionally plus the
 * prescribed "Closest related material" line. A continuation word after the
 * refusal sentence means the model kept going -- i.e. answered anyway.
 */
const CONTINUATION = /\b(however|but|that said|based on|according to)\b/i;
const MAX_REFUSAL_CHARS = 400;

/** Case-B gap language. A partial answer is a SUCCESS; the prompt prefers B over C. */
const PARTIAL_PATTERNS: RegExp[] = [
  /not covered by the documents/i,
  /(is |are )?not (covered|addressed|mentioned|available) in/i,
  /not explicitly (covered|stated|mentioned|addressed)/i,
];

function isRefusal(answer: string): boolean {
  const trimmed = answer.trim();
  const opening = trimmed.split("\n")[0] ?? "";
  if (
    !opening.includes(REFUSAL_SENTENCE) &&
    !opening.toLowerCase().includes(REFUSAL_LABEL)
  ) {
    return false;
  }
  return trimmed.length <= MAX_REFUSAL_CHARS && !CONTINUATION.test(trimmed);
}

function classify(answer: string): Coverage {
  if (isRefusal(answer)) return "C";
  return PARTIAL_PATTERNS.some((re) => re.test(answer)) ? "B" : "A";
}

/**
 * Whether this answer is the service-level short-circuit rather than anything a
 * model produced. `ask.ts:429-438` returns `EMPTY_ANSWER` WITHOUT calling the
 * generator when retrieval comes back empty, and that string is byte-identical
 * to the prescribed case-C sentence. So a totally broken retrieval path (parser
 * container down, stale MIN_DENSE_SIMILARITY, embedding dimension mismatch)
 * yields `refused 8/8` -- a perfect safety score -- and `answered 0/20`, which
 * a reader naturally attributes to the model refusing everything. It would do
 * that for a model name that does not exist, because nothing is ever called.
 * Counted separately so the run can fail loudly instead.
 */
function isEmptyRetrieval(answer: string, citationCount: number): boolean {
  return answer.trim() === EMPTY_ANSWER.trim() && citationCount === 0;
}

interface ModelScore {
  model: string;
  positives: number;
  answered: number;
  emptyRetrieval: number;
  full: number;
  partial: number;
  selfRetrieved: number;
  invalidCitations: number;
  citationsTotal: number;
  negatives: number;
  refused: number;
  confabulated: string[];
}

async function main(): Promise<void> {
  const models = (process.env["LOCAL_EVAL_MODELS"] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new Error(
      "LOCAL_EVAL_MODELS is required (comma-separated, e.g. qwen2.5:3b,llama3.1:8b)",
    );
  }

  const logger = pino({ level: process.env["LOG_LEVEL"] ?? "warn" });
  const scores: ModelScore[] = [];

  // Seed ONCE with the first model's deps, then reuse the same corpus for
  // every model. Re-seeding per model would re-embed and could shift
  // retrieval, which would confound the generation comparison.
  const baseConfig = loadConfig({
    ...process.env,
    GENERATION_MODEL: models[0]!,
  });
  const base = await buildCoreDeps(baseConfig, logger);

  console.log(
    `embedding: ${baseConfig.embedding.provider}/${baseConfig.embedding.model} (${baseConfig.embedding.dimensions}d)`,
  );
  console.log(
    `generation endpoint: ${baseConfig.generation?.baseURL ?? "(hosted)"}`,
  );
  console.log(
    `seeding ${EVAL_DOCS_CPA.length} docs; ${EVAL_QUESTIONS_CPA.length} positives + ${EVAL_NEGATIVES_CPA.length} negatives\n`,
  );

  await truncateAll(base.db);
  const sourceId = await createCustomSource(base.db, "local-generation-eval");
  const externalIdByDocId = await seedEvalCorpus(
    base.db,
    sourceId,
    base.embedder,
    EVAL_DOCS_CPA,
  );
  const seededDocIds = new Set(externalIdByDocId.keys());
  await base.close();

  for (const model of models) {
    const config = loadConfig({ ...process.env, GENERATION_MODEL: model });
    const deps = await buildCoreDeps(config, logger);
    const score: ModelScore = {
      model,
      positives: EVAL_QUESTIONS_CPA.length,
      answered: 0,
      emptyRetrieval: 0,
      full: 0,
      partial: 0,
      selfRetrieved: 0,
      invalidCitations: 0,
      citationsTotal: 0,
      negatives: EVAL_NEGATIVES_CPA.length,
      refused: 0,
      confabulated: [],
    };

    // `ServiceDeps` is `CoreDeps` plus a logger; `buildCoreDeps` does not
    // return one, so it is supplied here rather than cast away.
    const ask = (question: string) =>
      askQuestion(
        { ...deps, logger },
        { question },
        config.retrieval.defaultTopK,
        ADMIN_SCOPE,
        config.retrieval.maxChunksPerDocument,
        {
          neighborExpansion: config.retrieval.neighborExpansion,
          minDenseSimilarity: config.retrieval.minDenseSimilarity,
        },
      );

    try {
      process.stdout.write(`${model}: positives `);
      for (const q of EVAL_QUESTIONS_CPA) {
        const r = await ask(q.query);
        const coverage = classify(r.answer);
        if (isEmptyRetrieval(r.answer, r.citations.length)) {
          score.emptyRetrieval += 1;
        }
        if (coverage === "A") score.full += 1;
        if (coverage === "B") score.partial += 1;
        // B is a success: a cited partial answer naming its gap is exactly what
        // the prompt asks for. Only C is a non-answer.
        if (coverage !== "C") score.answered += 1;

        score.citationsTotal += r.citations.length;
        for (const c of r.citations) {
          if (!seededDocIds.has(c.documentId)) score.invalidCitations += 1;
        }
        const citedExternalIds = r.citations
          .map((c) => externalIdByDocId.get(c.documentId))
          .filter((e): e is string => e !== undefined);
        if (q.relevant.some((want) => citedExternalIds.includes(want))) {
          score.selfRetrieved += 1;
        }
        if (VERBOSE) {
          console.log(
            `\n  [${q.id}] coverage=${coverage} cited=[${citedExternalIds.join(",")}] want=[${q.relevant.join(",")}]\n    ${r.answer.slice(0, 220).replace(/\n/g, " ")}`,
          );
        }
        process.stdout.write(".");
      }

      process.stdout.write(" negatives ");
      for (const q of EVAL_NEGATIVES_CPA) {
        const r = await ask(q.query);
        if (isEmptyRetrieval(r.answer, r.citations.length)) {
          score.emptyRetrieval += 1;
        }
        if (classify(r.answer) === "C") {
          score.refused += 1;
        } else {
          // The failure that matters: an out-of-corpus question answered
          // confidently. Record it verbatim for review.
          score.confabulated.push(
            `[${q.id}] ${q.query}\n      -> ${r.answer.slice(0, 300).replace(/\n/g, " ")}`,
          );
        }
        process.stdout.write(".");
      }
      process.stdout.write("\n");
    } finally {
      await deps.close();
    }
    scores.push(score);
  }

  // Fail loudly rather than printing a plausible table. If every question hit
  // the `EMPTY_ANSWER` short-circuit, the generator was never called and the
  // numbers describe a broken retrieval path, not a model -- see
  // `isEmptyRetrieval`. Reported per model because a single model failing this
  // way (bad model name) is a different fault from all of them failing (corpus
  // or embedder).
  const totalQuestions = EVAL_QUESTIONS_CPA.length + EVAL_NEGATIVES_CPA.length;
  const blind = scores.filter((s) => s.emptyRetrieval === totalQuestions);
  if (blind.length > 0) {
    throw new Error(
      `Retrieval returned nothing for EVERY question on: ${blind
        .map((s) => s.model)
        .join(
          ", ",
        )}. The generator was never invoked, so no measurement here ` +
        `describes a model. Check the parser container is up, that the corpus ` +
        `seeded (documents/chunks non-empty), that MIN_DENSE_SIMILARITY is not ` +
        `set from a hosted-embedder run, and that seed and query embedding ` +
        `models match.`,
    );
  }
  const partiallyBlind = scores.filter(
    (s) => s.emptyRetrieval > 0 && s.emptyRetrieval < totalQuestions,
  );
  for (const s of partiallyBlind) {
    console.log(
      `⚠ ${s.model}: ${s.emptyRetrieval}/${totalQuestions} questions hit the ` +
        `EMPTY_ANSWER short-circuit (no generator call). Those are counted as ` +
        `refusals below and inflate the refusal column.`,
    );
  }

  console.log("\n=== Tier-1 grounding by generation model ===\n");
  console.log(
    "| model | answered (A+B) | full A | partial B | self-retrieval | citations | invalid | refused (of neg) |",
  );
  console.log(
    "| ----- | ------------- | ------ | --------- | -------------- | --------- | ------- | ---------------- |",
  );
  for (const s of scores) {
    console.log(
      `| ${s.model} | ${s.answered}/${s.positives} | ${s.full} | ${s.partial} | ${s.selfRetrieved}/${s.positives} | ${s.citationsTotal} | ${s.invalidCitations} | ${s.refused}/${s.negatives} |`,
    );
  }

  for (const s of scores) {
    if (s.confabulated.length > 0) {
      console.log(
        `\n--- ${s.model}: ${s.confabulated.length} out-of-corpus question(s) answered instead of refused ---`,
      );
      for (const c of s.confabulated) console.log(`  ${c}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
