import { createHash } from "node:crypto";
import pLimit from "p-limit";
import type { Logger } from "pino";
import {
  EmbeddingError,
  type Chunker,
  type Connector,
  type DocumentMetadata,
  type EmbeddingProvider,
  type Parser,
  type SourceDocument,
} from "@rag/core";
import {
  type Db,
  documentHasChunks,
  replaceChunks,
  updateSourceCursor,
  upsertDocument,
} from "@rag/db";

/**
 * The full ingestion pipeline for a single source.
 *
 *   connector.list() → (for each doc) parser.parse() → chunker.chunk()
 *                    → embedder.embedBatch() → db upsert + replaceChunks()
 *
 * Guarantees:
 *   - Idempotent: re-running with the same source state is a no-op for unchanged docs.
 *   - Resumable: cursor is persisted after each page, so crashes resume cleanly.
 *   - Bounded concurrency: documents are processed in parallel up to `concurrency`,
 *     embedding is batched.
 *   - At-least-once: handlers must be safe to call twice (they are — upsert by hash).
 */
export interface PipelineOptions {
  /** Max documents processed in parallel within a single page */
  concurrency: number;
  /** Max documents to enumerate per list() call (lets us bound memory) */
  pageSize: number;
  /**
   * Max number of connector pages this single `runIngestion` call will process
   * before returning (with `done` reflecting whether the feed is exhausted).
   * Bounds a single job's wall-clock so a huge source can be drained as a chain
   * of smaller continuation jobs (see worker self-re-enqueue) instead of one
   * long-running job.
   *
   * Defaults to unbounded (drain every page in one call) — the historical
   * behavior — so existing callers are unaffected. The worker passes a small
   * value (e.g. 1) to opt into per-page continuation.
   */
  maxPagesPerRun?: number;
}

export interface PipelineDeps {
  db: Db;
  parser: Parser;
  chunker: Chunker;
  embedder: EmbeddingProvider;
  logger: Logger;
}

export interface PipelineRunResult {
  documentsProcessed: number;
  documentsFailed: number;
  chunksCreated: number;
  /**
   * The connector's authoritative end-of-feed flag for the LAST page processed.
   * `true` => the source is fully enumerated (nothing left to re-enqueue).
   * `false` => more pages remain (the page budget was hit first); the caller
   * should re-enqueue a continuation that resumes from the persisted cursor.
   */
  done: boolean;
  /**
   * The cursor persisted after the last processed page (also written to
   * `sources.cursor`). Continuations normally read it from `sources.cursor`, but
   * it's surfaced here too for callers/tests that want it directly.
   */
  nextCursor: string | null;
}

export async function runIngestion(
  sourceId: string,
  connector: Connector,
  startCursor: string | null,
  opts: PipelineOptions,
  deps: PipelineDeps,
): Promise<PipelineRunResult> {
  const log = deps.logger.child({ sourceId, connector: connector.kind });
  const maxPages = opts.maxPagesPerRun ?? Number.POSITIVE_INFINITY;
  log.info({ startCursor, maxPages }, "starting ingestion run");

  let cursor = startCursor;
  let documentsProcessed = 0;
  let documentsFailed = 0;
  let chunksCreated = 0;
  let pageDone = false;
  let pagesProcessed = 0;

  // Process up to `maxPages` connector pages, persisting the cursor after each
  // so a crash/retry resumes mid-source. We stop when EITHER the connector
  // signals end-of-feed (`page.done`) OR the page budget is exhausted. When we
  // stop on the budget with the feed not yet drained, `done` stays `false` and
  // the caller (the worker) re-enqueues a continuation that resumes from the
  // persisted cursor. With the default unbounded budget this drains the whole
  // source in one call (the historical behavior).
  do {
    const page = await connector.list({ cursor, maxItems: opts.pageSize });
    pageDone = page.done;
    pagesProcessed++;
    log.info(
      { count: page.documents.length, nextCursor: page.nextCursor, pagesProcessed },
      "fetched page",
    );

    const limit = pLimit(opts.concurrency);
    const results = await Promise.allSettled(
      page.documents.map((doc) => limit(() => ingestOne(sourceId, doc, deps))),
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        documentsProcessed++;
        chunksCreated += r.value.chunksCreated;
      } else {
        documentsFailed++;
        log.error({ err: r.reason }, "document failed");
      }
    }

    // Persist cursor (CURSOR ONLY — `lastSyncedAt` is stamped once on
    // completion by the worker) so we don't re-process this page on retry.
    cursor = page.nextCursor;
    await updateSourceCursor(deps.db, sourceId, cursor);

    // Loop continuation is driven by `pageDone` (the connector's `done` flag),
    // NOT by `page.documents.length === 0`. A page that yielded zero documents
    // (e.g. all drafts/removals filtered out) is NOT end-of-feed; breaking on
    // empty documents would silently stall the sync. End-of-feed is `done:true`.
  } while (!pageDone && pagesProcessed < maxPages);

  log.info(
    { documentsProcessed, documentsFailed, chunksCreated, done: pageDone, pagesProcessed },
    "ingestion run complete",
  );
  // `done: pageDone` tells the caller whether the source is fully enumerated.
  // `false` here means the page budget was hit before the feed ended → the
  // caller should re-enqueue a continuation resuming from `cursor`.
  return {
    documentsProcessed,
    documentsFailed,
    chunksCreated,
    done: pageDone,
    nextCursor: cursor,
  };
}

/** Process a single source document: parse, chunk, embed, store. */
async function ingestOne(
  sourceId: string,
  source: SourceDocument,
  deps: PipelineDeps,
): Promise<{ chunksCreated: number }> {
  const { db, parser, chunker, embedder, logger } = deps;
  const log = logger.child({
    externalId: source.externalId,
    title: source.title,
  });

  // 1. Parse to clean markdown.
  const parsed = await parser.parse({
    content: source.content,
    mimeType: source.mimeType,
    filename: source.title,
  });

  // 2. Compute content hash on parsed markdown so unchanged-but-touched
  //    documents (source updated metadata only) skip embedding work.
  const contentHash = sha256(parsed.markdown);

  // 3. Upsert document row; if hash unchanged, we can short-circuit.
  const { id: documentId, contentChanged } = await upsertDocument(db, {
    sourceId,
    externalId: source.externalId,
    title: parsed.title || source.title,
    mimeType: source.mimeType,
    sourceModifiedAt: new Date(source.modifiedAt),
    contentHash,
    sizeBytes: source.content.byteLength,
    // The connector's typed DocumentMetadata plus the parser's free-form bag
    // (validated to a plain object at the parser-client boundary). Typed as the
    // union so the stored shape is honest about both halves.
    metadata: { ...source.metadata, ...parsed.metadata } as DocumentMetadata &
      Record<string, unknown>,
    markdown: parsed.markdown,
  });

  if (!contentChanged) {
    // Normally an unchanged hash means the document is already fully ingested,
    // so we skip the expensive chunk/embed work. But a document can have its
    // hash recorded while having NO chunks: a prior run that upserted the row
    // and then embed-failed (e.g. Gemini 429 / credit exhaustion) leaves the
    // hash set but the chunks table empty. Skipping such a document forever
    // would make it permanently un-retrievable, so we re-embed when chunks are
    // absent despite a matching hash.
    if (await documentHasChunks(db, documentId)) {
      log.debug("content unchanged, skipping chunk/embed");
      return { chunksCreated: 0 };
    }
    log.warn("content hash unchanged but document has no chunks; re-embedding");
  }

  // 4. Chunk the markdown.
  const chunks = await chunker.chunk(parsed);
  if (chunks.length === 0) {
    log.warn("parsed document produced zero chunks");
    return { chunksCreated: 0 };
  }

  // 5. Embed all chunks in one batched call.
  const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

  // Defensive: a provider that returns the wrong number of embeddings would
  // silently corrupt the chunks table (chunk N gets embedding M's vector, or
  // an undefined vector violates the NOT NULL column). Fail loud instead.
  if (embeddings.length !== chunks.length) {
    throw new EmbeddingError(
      `embedder.embedBatch returned ${embeddings.length} embeddings for ${chunks.length} chunks`,
    );
  }

  // 6. Replace existing chunks atomically.
  await replaceChunks(
    db,
    documentId,
    chunks.map((c, i) => {
      const embedding = embeddings[i];
      if (!embedding) {
        // Unreachable given the length check above, but keeps the type
        // checker happy without a non-null assertion.
        throw new EmbeddingError(
          `missing embedding for chunk ordinal ${c.ordinal}`,
        );
      }
      return {
        documentId,
        ordinal: c.ordinal,
        hash: c.hash,
        text: c.text,
        tokenCount: c.tokenCount,
        headingPath: c.headingPath,
        page: c.page ?? null,
        embedding: embedding.vector,
        embeddingProvider: embedder.name,
        embeddingModel: embedder.model,
      };
    }),
  );

  log.info({ chunkCount: chunks.length }, "document ingested");
  return { chunksCreated: chunks.length };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
