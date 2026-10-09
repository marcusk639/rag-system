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
 * ⚠ Refusal is detected by REGEX over the answer text (see `looksLikeRefusal`).
 * That is a heuristic, not ground truth: a model can decline in wording the
 * pattern misses, which scores as a false "answered". Treat the refusal column
 * as a floor and read `--verbose` output before trusting a regression.
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
 * Heuristic refusal detector. Covers the service-level short-circuit
 * (`EMPTY_ANSWER`, "do not contain enough information") plus the phrasings
 * instruct-tuned models actually use. Deliberately broad: a false POSITIVE
 * here flatters the model under test, so the reported refusal rate is a
 * ceiling on refusal and the "confabulated" count is a FLOOR.
 */
function looksLikeRefusal(answer: string): boolean {
  return [
    /do not contain enough information/i,
    /does not contain enough information/i,
    /(cannot|can't|unable to) (be )?(answer|determine|find|locate)/i,
    /(not|no) (enough|sufficient) (information|context|detail)/i,
    /(don't|do not) have (enough |sufficient )?(information|context)/i,
    /(is |are )?not (covered|addressed|mentioned|available) in/i,
    /no (relevant |supporting )?(information|documents?|context) (was |were )?found/i,
    /the (provided )?(context|documents?|corpus) does not/i,
    // The prompt's own refusal scaffolding (generator.ts:71). Small models
    // frequently echo the RUBRIC LABEL ("The documents do not bear on the
    // question at all") instead of the prescribed sentence, and append the
    // "Closest related material:" line. Both are refusals. Omitting these
    // scored 5 of llama3.2:3b's 6 "confabulations" as answers when they were
    // declines — the detector penalised the model rather than flattering it.
    /do not bear on the question/i,
    /Closest related material:/i,
    /not explicitly (covered|stated|mentioned|addressed)/i,
  ].some((re) => re.test(answer));
}

interface ModelScore {
  model: string;
  positives: number;
  answered: number;
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
      selfRetrieved: 0,
      invalidCitations: 0,
      citationsTotal: 0,
      negatives: EVAL_NEGATIVES_CPA.length,
      refused: 0,
      confabulated: [],
    };

    const ask = (question: string) =>
      askQuestion(
        deps,
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
        const refused = looksLikeRefusal(r.answer);
        if (!refused) score.answered += 1;

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
            `\n  [${q.id}] refused=${refused} cited=[${citedExternalIds.join(",")}] want=[${q.relevant.join(",")}]\n    ${r.answer.slice(0, 220).replace(/\n/g, " ")}`,
          );
        }
        process.stdout.write(".");
      }

      process.stdout.write(" negatives ");
      for (const q of EVAL_NEGATIVES_CPA) {
        const r = await ask(q.query);
        if (looksLikeRefusal(r.answer)) {
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
    "| model | answered | self-retrieval | invalid citations | refused (of neg) |",
  );
  console.log(
    "| ----- | -------- | -------------- | ----------------- | ---------------- |",
  );
  for (const s of scores) {
    console.log(
      `| ${s.model} | ${s.answered}/${s.positives} | ${s.selfRetrieved}/${s.positives} | ${s.invalidCitations}/${s.citationsTotal} | ${s.refused}/${s.negatives} |`,
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
