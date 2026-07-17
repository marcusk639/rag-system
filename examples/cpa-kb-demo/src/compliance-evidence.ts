/**
 * Compliance-path evidence script — proves the ALREADY-BUILT compliance
 * features work end to end against the real pipeline (no mocks):
 *
 *   (A) Class A (data_class='sop') ingests normally.
 *   (B) Class D (data_class='client_confidential') is refused at the
 *       ingestion gate — zero documents processed, and the refusal is
 *       durably recorded in `ingest_log` (action='blocked').
 *   (C) A retrieval query against the Class-A index writes an `audit_log`
 *       row (mirrors the apps/api /ask and /search routes).
 *   (D) The top citation resolves to the correct source document.
 *
 * Uses the demo's inline BowEmbedder (deterministic, no network/model
 * download) so this runs fast and offline against the local Docker stack.
 *
 * IMPORTANT — verified against the real pipeline behavior (packages/ingestion
 * /src/pipeline.ts): `runIngestion` does NOT throw `ClassBlockedError` to its
 * caller. `ingestOne` throws it per-document, but `runIngestion` awaits all
 * documents via `Promise.allSettled` and only increments `documentsFailed`
 * for each rejection — see the "document classification enforcement" test
 * suite in pipeline.test.ts ("Class D documents throw ClassBlockedError —
 * zero documents ingested" asserts on `documentsProcessed`/`documentsFailed`,
 * not a thrown error). So the gate-refusal evidence here is: (1) the
 * `runIngestion` result shows documentsProcessed=0 for every submitted doc,
 * and (2) the `ingest_log` row it wrote before throwing internally carries
 * `action='blocked'` and a `rejection_reason` containing the CLASS_BLOCKED
 * message ("Class D documents cannot be indexed in Phase 1 ..."). That
 * `rejection_reason` text is the durable proof that `ClassBlockedError`
 * specifically fired, not just Promise.allSettled swallowing an early return.
 */
import { sql } from "drizzle-orm";
import pino from "pino";
import { ADMIN_SCOPE, ClassBlockedError } from "@rag/core";
import { createDb, createSource, logAskEvent } from "@rag/db";
import { runIngestion, mapDataClassToDocumentClass } from "@rag/ingestion";
import { CompositeChunker, HttpParserClient, Retriever } from "@rag/rag";
import { FileConnector, BowEmbedder } from "./demo.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag";
const PARSER_URL = process.env.PARSER_URL ?? "http://localhost:8000";
const ev = (m: string) => console.log(`EVIDENCE: ${m}`);

async function main(): Promise<void> {
  const logger = pino({ level: "silent" });
  const { db, close } = createDb(DATABASE_URL, { max: 5 });
  const parser = new HttpParserClient(PARSER_URL, 60_000);
  const chunker = new CompositeChunker({
    markdown: { chunkSize: 600, chunkOverlap: 100 },
    table: { chunkSize: 600, rowOverlap: 2 },
  });
  const embedder = new BowEmbedder();

  try {
    await db.execute(
      sql`TRUNCATE TABLE chunks, documents, ingestion_jobs, sources, ingest_log, audit_log RESTART IDENTITY CASCADE`,
    );

    // (A) Class A (data_class='sop' -> DocumentClass 'A') ingests successfully.
    const sopClass = mapDataClassToDocumentClass("sop");
    ev(`data_class 'sop' maps to DocumentClass '${sopClass}' (expected A)`);
    if (sopClass !== "A") throw new Error("EXPECTED sop -> A mapping");

    const okSource = await createSource(db, {
      kind: "custom",
      name: "evidence-sop",
      dataClass: "sop",
      config: {},
    });
    const okResult = await runIngestion(
      okSource.id,
      new FileConnector(DOCS_DIR),
      null,
      { concurrency: 2, pageSize: 50 },
      { db, parser, chunker, embedder, logger, sourceDocClass: sopClass },
    );
    ev(
      `Class-A ingest succeeded: ${okResult.documentsProcessed} docs, ${okResult.chunksCreated} chunks (documentsFailed=${okResult.documentsFailed})`,
    );
    if (okResult.documentsProcessed === 0 || okResult.documentsFailed > 0) {
      throw new Error(
        `EXPECTED Class-A ingest to succeed fully — got documentsProcessed=${okResult.documentsProcessed}, documentsFailed=${okResult.documentsFailed}`,
      );
    }

    // (B) Class D (data_class='client_confidential' -> 'D') is REFUSED at the gate.
    const ccClass = mapDataClassToDocumentClass("client_confidential");
    ev(
      `data_class 'client_confidential' maps to DocumentClass '${ccClass}' (expected D)`,
    );
    if (ccClass !== "D")
      throw new Error("EXPECTED client_confidential -> D mapping");

    const badSource = await createSource(db, {
      kind: "custom",
      name: "evidence-cc",
      dataClass: "client_confidential",
      config: {},
    });
    // NOTE (verified against pipeline.ts + pipeline.test.ts): runIngestion
    // does NOT throw ClassBlockedError to the caller — Promise.allSettled
    // inside runIngestion catches the per-document rejection and reports it
    // via documentsFailed. The gate still fires; it just surfaces as a
    // result shape, not an exception, at this call boundary.
    const blockedResult = await runIngestion(
      badSource.id,
      new FileConnector(DOCS_DIR),
      null,
      { concurrency: 2, pageSize: 50 },
      { db, parser, chunker, embedder, logger, sourceDocClass: ccClass },
    );
    const refusedAtGate =
      blockedResult.documentsProcessed === 0 &&
      blockedResult.documentsFailed > 0;
    ev(
      `Class-D ingest REFUSED at the gate: documentsProcessed=${blockedResult.documentsProcessed}, documentsFailed=${blockedResult.documentsFailed} ` +
        `(runIngestion resolves rather than throws — ClassBlockedError is caught per-document via Promise.allSettled; see ingest_log check below for the actual error class/message)`,
    );
    if (!refusedAtGate) {
      throw new Error(
        "EXPECTED zero documents processed for client_confidential ingest — gate did not fire",
      );
    }

    // (B2) The ingest_log recorded the block, with a rejection_reason that
    // proves ClassBlockedError (not some other failure) is what fired.
    const blocked = await db.execute<{
      action: string;
      rejection_reason: string;
    }>(
      sql`SELECT action, rejection_reason FROM ingest_log WHERE source_id = ${badSource.id} AND action = 'blocked' LIMIT 1`,
    );
    const blockedRow = blocked.rows[0];
    ev(
      `ingest_log block row: action=${blockedRow?.action} reason="${blockedRow?.rejection_reason}"`,
    );
    const expectedMessage = new ClassBlockedError("D", badSource.id).message;
    if (!blockedRow || blockedRow.action !== "blocked") {
      throw new Error("EXPECTED an ingest_log row with action='blocked'");
    }
    if (blockedRow.rejection_reason !== expectedMessage) {
      throw new Error(
        `ingest_log rejection_reason did not match ClassBlockedError's message.\n  expected: ${expectedMessage}\n  actual:   ${blockedRow.rejection_reason}`,
      );
    }
    ev(
      'ingest_log rejection_reason matches ClassBlockedError("D", sourceId).message exactly',
    );

    // (C) Run a query against the Class-A index and write an audit_log row
    // (mirrors apps/api ask route).
    const retriever = new Retriever(db, embedder, {
      topK: 5,
      denseWeight: 0.3,
      sparseWeight: 0.7,
    });
    const question =
      "What is our process for filing a BOI for an LLC formed in 2024?";
    const results = await retriever.search(
      { query: question, topK: 3 },
      ADMIN_SCOPE,
    );
    if (results.length === 0) {
      throw new Error(
        "EXPECTED at least one retrieval result for the BOI query",
      );
    }
    await logAskEvent(db, {
      principalKind: "admin",
      principalSources: null,
      principalSubject: null,
      questionHash: createHash("sha256").update(question).digest("hex"),
      channel: "api",
      model: null,
      embeddingProvider: embedder.name,
      embeddingModel: embedder.model,
      sourceIds: [okSource.id],
      chunkIds: results.map((r) => r.chunk.id),
      docIds: results.map((r) => r.document.id),
      retrievedCount: results.length,
      endpoint: "search",
      topScore: results[0]?.score ?? null,
      answerId: null,
    });
    const audit = await db.execute<{
      question_hash: string;
      retrieved_count: number;
      endpoint: string;
      top_score: number;
    }>(
      sql`SELECT question_hash, retrieved_count, endpoint, top_score FROM audit_log ORDER BY created_at DESC LIMIT 1`,
    );
    const auditRow = audit.rows[0];
    ev(
      `audit_log row: endpoint=${auditRow?.endpoint} retrieved=${auditRow?.retrieved_count} top_score=${auditRow?.top_score} hash=${auditRow?.question_hash.slice(0, 12)}...`,
    );
    if (
      !auditRow ||
      auditRow.endpoint !== "search" ||
      auditRow.retrieved_count !== results.length
    ) {
      throw new Error("EXPECTED audit_log row to reflect the search just run");
    }

    // (D) Citations resolve to the correct source doc.
    const top = results[0]!;
    const topPath = (
      (top.document.metadata as { path?: string }).path ?? ""
    ).replace(/^docs\//, "");
    ev(
      `citation resolves: top chunk -> document ${top.document.id} (path=${topPath}) [dense=${top.denseScore.toFixed(3)} sparse=${top.sparseScore.toFixed(3)} score=${top.score.toFixed(3)}]`,
    );
    if (topPath !== "boi-filing-sop.md") {
      throw new Error(
        `EXPECTED top citation to resolve to boi-filing-sop.md, got '${topPath}' — citation retrieval did not behave as expected`,
      );
    }
    ev("ALL COMPLIANCE CHECKS PASSED");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
