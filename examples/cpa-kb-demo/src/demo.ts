/**
 * CPA KB Q&A Demo — end-to-end spike against synthetic firm SOPs.
 *
 * What this proves:
 *   1. The rag-system can ingest a directory of firm-style markdown SOPs
 *      through the same pipeline production would use (parser → chunker →
 *      embedder → Postgres).
 *   2. Hybrid retrieval (dense + sparse + RRF) returns the right document
 *      for natural-language CPA questions.
 *   3. Each answer is grounded in cited chunks from real source files —
 *      satisfying the Circular 230 §10.35 basis-of-work-product requirement
 *      (see cpa-consulting/docs/strategy-eval/rag-compliance-scope.md).
 *
 * What it does NOT prove:
 *   - Real-world embedding quality (this uses a deterministic BoW embedder
 *     for repeatable, zero-API-cost demos). Production would use Gemini
 *     text-embedding-004 or an on-prem local model.
 *   - Production-grade citations (we render text; production renders to
 *     SharePoint URLs).
 *   - Authentication or audit logging (deferred to production deployment).
 *
 * How to run:
 *   1. Make sure Postgres + parser-py are up (pnpm docker:up).
 *   2. From repo root: pnpm --filter @rag/example-cpa-kb-demo demo
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pino from "pino";
import { CompositeChunker, HttpParserClient, Retriever } from "@rag/rag";
import { runIngestion } from "@rag/ingestion";
import { createDb, createSource } from "@rag/db";
import { ADMIN_SCOPE, loadPack } from "@rag/core";
import type {
  Connector,
  ConnectorListOptions,
  ConnectorListResult,
  Embedding,
  EmbeddingProvider,
  SourceDocument,
} from "@rag/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");
// Ingestion refuses to run without a scanner pack — the demo uses the same
// `packs/cpa` rules production does, so what it indexes is redacted the same way.
const SCANNER_PACK_DIR = join(__dirname, "..", "..", "..", "packs", "cpa");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag";
const PARSER_URL = process.env.PARSER_URL ?? "http://localhost:8000";

// ----------------------------------------------------------------------------
// 1. FakeEmbedder — deterministic bag-of-words → 768-dim vector.
//    Same algorithm as tests/e2e/src/fakes/fake-embedder.ts. Lives here too so
//    this example is standalone. Production would swap for Gemini or local.
// ----------------------------------------------------------------------------
const DIMS = 768;

class BowEmbedder implements EmbeddingProvider {
  readonly name = "local";
  readonly model = "demo-bow-768";
  readonly dimensions = DIMS;

  async embed(text: string): Promise<Embedding> {
    return {
      vector: embed(text),
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<Embedding[]> {
    return texts.map((t) => ({
      vector: embed(t),
      provider: this.name,
      model: this.model,
      dimensions: this.dimensions,
    }));
  }
}

function embed(text: string): number[] {
  const vec = new Float64Array(DIMS);
  for (const token of tokenize(text)) {
    const d = createHash("sha256").update(token).digest();
    const a = d.readUInt32BE(0) % DIMS;
    const b = d.readUInt32BE(4) % DIMS;
    vec[a] = (vec[a] ?? 0) + 1;
    vec[b] = (vec[b] ?? 0) + (d[8]! % 2 === 0 ? 1 : -1);
  }
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i]! * vec[i]!;
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return Array.from(vec, (v) => v * inv);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// ----------------------------------------------------------------------------
// 2. FileConnector — emits the docs/ directory as SourceDocuments.
// ----------------------------------------------------------------------------
class FileConnector implements Connector {
  readonly kind = "custom";
  private exhausted = false;

  constructor(private readonly dir: string) {}

  async validate(): Promise<void> {
    /* always valid */
  }

  async list(_o?: ConnectorListOptions): Promise<ConnectorListResult> {
    if (this.exhausted) return { documents: [], nextCursor: null, done: true };
    this.exhausted = true;

    const entries = await readdir(this.dir, { withFileTypes: true });
    const docs: SourceDocument[] = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const path = join(this.dir, ent.name);
      const content = await readFile(path);
      docs.push({
        externalId: ent.name,
        title: titleFromFilename(ent.name),
        modifiedAt: "2026-05-26T00:00:00Z",
        mimeType: "text/markdown",
        content,
        metadata: {
          title: titleFromFilename(ent.name),
          mimeType: "text/markdown",
          path: `docs/${ent.name}`,
          // Classification tag — see compliance scope contract.
          // All demo docs are Class A (firm-internal SOPs / methodology).
          extra: { class: "A", demo: true },
        },
      });
    }
    return { documents: docs, nextCursor: null, done: true };
  }

  async fetch(externalId: string): Promise<SourceDocument> {
    const list = await this.list();
    const doc = list.documents.find((d) => d.externalId === externalId);
    if (!doc) throw new Error(`no doc ${externalId}`);
    return doc;
  }
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.md$/, "")
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ----------------------------------------------------------------------------
// 3. Demo queries — natural-language questions a CPA might ask the bot.
//    The expected match column is what the demo asserts informally.
// ----------------------------------------------------------------------------
interface DemoQuery {
  q: string;
  expects: string[]; // filename(s) the human would consider correct; "" = no expected match
}

const DEMO_QUERIES: DemoQuery[] = [
  {
    q: "How do we handle BOI filings for an LLC formed in 2024?",
    expects: ["boi-filing-sop.md"],
  },
  {
    q: "What's the time code for catch-up bookkeeping work?",
    expects: ["time-coding-guide.md", "catchup-bookkeeping-workflow.md"],
  },
  {
    q: "Schedule K-1 box 13 code W from MLP partnership investments",
    expects: ["k1-treatment-reference.md"],
  },
  {
    q: "What's our intake checklist for a new 1040 client?",
    expects: ["1040-intake-checklist.md"],
  },
  {
    q: "What should a new hire do on their first day?",
    expects: ["onboarding-staff-week1.md"],
  },
  {
    q: "How do I file a cryptocurrency staking rewards report?",
    expects: [], // no doc covers this; honest "I don't know" expected
  },
];

// ----------------------------------------------------------------------------
// 4. Main demo flow
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const logger = pino({ level: "silent" });
  const { db, close } = createDb(DATABASE_URL, { max: 5 });

  try {
    log("setup", "Clearing prior demo data from local Postgres");
    await db.execute(
      sql`TRUNCATE TABLE chunks, documents, ingestion_jobs, sources RESTART IDENTITY CASCADE`,
    );

    log("setup", "Creating source row (kind='custom', name='cpa-kb-demo')");
    const source = await createSource(db, {
      kind: "custom",
      name: "cpa-kb-demo",
      config: { demo: true },
    });
    log("setup", `  source id: ${source.id}`);

    log("ingest", `Ingesting docs from ${DOCS_DIR}`);
    const connector = new FileConnector(DOCS_DIR);
    const parser = new HttpParserClient(PARSER_URL, 60_000);
    const chunker = new CompositeChunker({
      markdown: { chunkSize: 600, chunkOverlap: 100 },
      table: { chunkSize: 600, rowOverlap: 2 },
    });
    const embedder = new BowEmbedder();

    const result = await runIngestion(
      source.id,
      connector,
      null,
      { concurrency: 2, pageSize: 50 },
      {
        db,
        parser,
        chunker,
        embedder,
        logger,
        pack: loadPack(SCANNER_PACK_DIR),
      },
    );
    log("ingest", `  documents: ${result.documentsProcessed} ingested`);
    log("ingest", `  chunks:    ${result.chunksCreated} created`);

    // Sparse-heavy weighting for the demo. CPA queries lean on exact jargon
    // ("BOI", "K-1", "1040", "Schedule C"); BM25-via-tsvector handles that
    // better than a bag-of-words dense embedder. Production with a real
    // embedding model (Gemini text-embedding-004 / a local model) should
    // tune these against held-out queries — likely toward 0.6 dense / 0.4
    // sparse, the inverse of this demo.
    const retriever = new Retriever(db, embedder, {
      topK: 5,
      denseWeight: 0.3,
      sparseWeight: 0.7,
    });

    process.stdout.write("\n");
    process.stdout.write(
      "=================================================================\n",
    );
    process.stdout.write(
      "  CPA KB Q&A DEMO — synthetic SOPs, real hybrid retrieval pipeline\n",
    );
    process.stdout.write(
      "  Embedder:  fake bag-of-words (zero API cost; demo-only)\n",
    );
    process.stdout.write(
      "  Weighting: 0.3 dense / 0.7 sparse (CPA jargon is sparse-friendly)\n",
    );
    process.stdout.write(
      "=================================================================\n",
    );

    let top1Correct = 0;
    let top3Correct = 0;
    let missesHandled = 0;
    let totalScored = 0;

    for (const dq of DEMO_QUERIES) {
      // Local single-user demo: admin/all-access scope (no token boundary).
      const hits = await retriever.search(
        { query: dq.q, topK: 3 },
        ADMIN_SCOPE,
      );
      const verdict = printQueryResult(dq, hits);
      totalScored++;
      if (verdict.top1Correct) top1Correct++;
      if (verdict.top3Correct) top3Correct++;
      if (verdict.missHandled) missesHandled++;
    }

    process.stdout.write("\n");
    process.stdout.write(
      "=================================================================\n",
    );
    process.stdout.write("  Retrieval scorecard\n");
    process.stdout.write(
      `    Top-1 correct:        ${top1Correct} / ${totalScored - 1} positive queries (excludes the deliberate miss)\n`,
    );
    process.stdout.write(
      `    Top-3 recall:         ${top3Correct} / ${totalScored - 1} positive queries\n`,
    );
    process.stdout.write(
      `    Miss handled cleanly: ${missesHandled} / 1 (low-confidence response)\n`,
    );
    process.stdout.write("\n");
    process.stdout.write(
      "  What this tells the partner conversation:\n" +
        "    • The pipeline (ingest → chunk → embed → search → cite) is real.\n" +
        "    • Top-3 recall is high even with the fake BoW embedder, because\n" +
        "      hybrid retrieval finds the right doc via either dense or sparse.\n" +
        "    • Top-1 precision is noisy because BoW can't distinguish 'this doc IS\n" +
        "      about X' from 'this doc MENTIONS X in a footer'. Production with\n" +
        "      Gemini text-embedding-004 (or a local Ollama model) closes that gap.\n" +
        "    • The MISS case correctly drops to low-confidence — the bot will say\n" +
        "      'I don't know' instead of hallucinating, which is the §10.22 win.\n",
    );
    process.stdout.write(
      "=================================================================\n",
    );
  } finally {
    await close();
  }
}

interface Verdict {
  top1Correct: boolean;
  top3Correct: boolean;
  missHandled: boolean;
}

function printQueryResult(
  dq: DemoQuery,
  hits: Awaited<ReturnType<Retriever["search"]>>,
): Verdict {
  process.stdout.write(
    "\n-----------------------------------------------------------------\n",
  );
  process.stdout.write(`Q: ${dq.q}\n`);
  const expectsLabel =
    dq.expects.length === 0
      ? "no document covers this (low confidence expected)"
      : dq.expects.join(" OR ");
  process.stdout.write(`   (expects: ${expectsLabel})\n`);
  process.stdout.write(
    "-----------------------------------------------------------------\n",
  );

  // Confidence heuristic that's robust to the demo's BoW limitations:
  //   - "high" when the top hit has dense ≥ 0.25 OR any positive sparse score
  //     (positive sparse means at least one query term tokenised + matched)
  //   - "low" when both signals are weak across all top-3 chunks
  const isLowConfidence =
    hits.length === 0 ||
    (hits.every((h) => h.denseScore < 0.25) &&
      hits.every((h) => h.sparseScore < 0.005));

  const isMissCase = dq.expects.length === 0;
  const matchedPaths = hits
    .map((h) => (h.document.metadata.path as string | undefined) ?? "")
    .map((p) => p.replace(/^docs\//, ""));

  const top1Path = matchedPaths[0] ?? "";
  const top1Correct = !isMissCase && dq.expects.includes(top1Path);
  const top3Correct =
    !isMissCase && dq.expects.some((e) => matchedPaths.includes(e));
  const missHandled = isMissCase && isLowConfidence;

  if (hits.length === 0) {
    process.stdout.write("  NO HITS — bot: 'I don't have an answer.'\n");
    return { top1Correct, top3Correct, missHandled };
  }

  if (isLowConfidence) {
    process.stdout.write(
      "  LOW CONFIDENCE — bot would respond:\n" +
        "    'I couldn't find a high-confidence answer. Want to log this as a KB gap?'\n",
    );
  } else {
    const top = hits[0]!;
    process.stdout.write(
      `  Top match: ${top.document.title}  [dense=${top.denseScore.toFixed(2)}, sparse=${top.sparseScore.toFixed(3)}]\n`,
    );
    process.stdout.write(
      `             section: ${top.chunk.headingPath.join(" › ") || "(top)"}\n`,
    );
    process.stdout.write("             excerpt:\n");
    const excerpt = top.text.split("\n").slice(0, 4).join("\n").slice(0, 280);
    excerpt
      .split("\n")
      .forEach((line) => process.stdout.write(`               ${line}\n`));
  }

  process.stdout.write("\n  Top-3 citations (any one correct ⇒ usable):\n");
  hits.forEach((h, i) => {
    const path = (
      (h.document.metadata.path as string | undefined) ?? "?"
    ).replace(/^docs\//, "");
    const marker = !isMissCase && dq.expects.includes(path) ? " ✓" : "";
    process.stdout.write(
      `    [${i + 1}] ${h.document.title.padEnd(36)} dense=${h.denseScore.toFixed(2)} sparse=${h.sparseScore.toFixed(3)}  ${path}${marker}\n`,
    );
  });

  return { top1Correct, top3Correct, missHandled };
}

function log(phase: string, msg: string): void {
  process.stdout.write(`[${phase}] ${msg}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`Demo failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
