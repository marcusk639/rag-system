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
 * llama3.2:3b measured 19/20 and 16/20 on identical inputs across two runs.
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
import { askQuestion } from "@rag/services";
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
 * ## Why this is three-way and not a single refusal predicate
 *
 * By construction, not by measurement. The prompt prescribes gap language --
 * `"Not covered by the documents:"` -- as the marker for case **B**, a correct
 * PARTIAL answer: substantive cited content plus an explicit statement of what
 * is missing. The prompt also says "Prefer B over C". Any predicate that treats
 * gap language as refusal therefore scores a success as a failure, and that is
 * wrong regardless of how often it fires.
 *
 * What the previous single predicate actually did, verified by running all
 * eleven of its patterns against the prescribed strings:
 *
 *   - the EXACT B marker "Not covered by the documents:"  -> NOT matched
 *   - "not covered in the documents"                      -> matched (refusal)
 *   - "...is not explicitly stated in the documents"      -> matched (refusal)
 *   - the exact C sentence                                -> matched (refusal)
 *
 * So a model reproducing the B marker verbatim escaped it; a model PARAPHRASING
 * the marker -- which small models do constantly -- was scored as refusing. The
 * defect was real but narrower than "punishes rubric compliance", and the fix
 * is to key C off the prescribed refusal sentence rather than off gap wording.
 *
 * ## What the numbers can and cannot tell you about this
 *
 * `selfRetrieved` is incremented independently of coverage, so a run with
 * 11 answered / 9 C / 17 self-retrieved does imply that >=6 of the nine C's
 * cited a labeled-relevant document. It is tempting to read that as proof those
 * nine were really B's. It is not: `generator.ts:71` instructs case C to append
 * `"Closest related material: <title> [N]"`, and `filterCitationsToAnswer`
 * (packages/services/src/ask.ts:447) keeps any citation whose index appears in
 * the text, so a textbook C emits exactly one citation -- very likely the
 * labeled-relevant document, since retrieval ranks it highly for an in-corpus
 * question. All nine could have been correct C's with that number unchanged.
 * The self-retrieval column carries NO information about the A/B/C split.
 *
 * Empirically the correction barely moved anything: qwen2.5:3b measured 11/20
 * answered both before and after, llama3.2:3b 16 -> 17. **The conservatism
 * these models show is real, not an artifact of this function.** Prompt density
 * is the cause -- a ~290-token lean prompt took qwen to 19/20 -- but it is not
 * adoptable, because it also collapsed llama3.2:3b from 24 citations and 17/20
 * self-retrieval to 2 and 2/20.
 *
 * So: C is detected by the PRESCRIBED REFUSAL SENTENCE (and the rubric-label
 * echo small models emit in its place), never by gap language. B is detected by
 * gap language and counts as ANSWERED. Anything else is A.
 */
type Coverage = "A" | "B" | "C";

/** The prescribed case-C sentence, plus the rubric label models echo instead. */
const REFUSAL_PATTERNS: RegExp[] = [
  /do(es)? not contain enough information/i,
  /do not bear on the question/i,
  /Closest related material:/i,
  /(cannot|can't|unable to) (be )?(answer|determine|find|locate)/i,
  /(not|no) (enough|sufficient) (information|context|detail)/i,
  /(don't|do not) have (enough |sufficient )?(information|context)/i,
  /no (relevant |supporting )?(information|documents?|context) (was |were )?found/i,
  /the (provided )?(context|documents?|corpus) does not/i,
];

/**
 * Case-B gap language. Deliberately NOT a refusal: these mark a partial answer,
 * which is a success -- the prompt itself says "Prefer B over C".
 */
const PARTIAL_PATTERNS: RegExp[] = [
  /not covered by the documents/i,
  /(is |are )?not (covered|addressed|mentioned|available) in/i,
  /not explicitly (covered|stated|mentioned|addressed)/i,
];

function classify(answer: string, citationCount: number): Coverage {
  const refused = REFUSAL_PATTERNS.some((re) => re.test(answer));
  const partial = PARTIAL_PATTERNS.some((re) => re.test(answer));

  // A refusal-shaped answer that also carries substantive cited content is a B
  // whose gap statement happened to use refusal wording -- score the citations,
  // not the phrasing. Case C legitimately carries at most the single
  // "Closest related material" citation, so >1 is the discriminator.
  if (refused && citationCount > 1) return "B";
  if (refused) return "C";
  return partial ? "B" : "A";
}

interface ModelScore {
  model: string;
  positives: number;
  answered: number;
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
        const coverage = classify(r.answer, r.citations.length);
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
        if (classify(r.answer, r.citations.length) === "C") {
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
