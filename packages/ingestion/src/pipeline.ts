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
  done: boolean;
}

export async function runIngestion(
  sourceId: string,
  connector: Connector,
  startCursor: string | null,
  opts: PipelineOptions,
  deps: PipelineDeps,
): Promise<PipelineRunResult> {
  const log = deps.logger.child({ sourceId, connector: connector.kind });
  log.info({ startCursor }, "starting ingestion run");

  let cursor = startCursor;
  let documentsProcessed = 0;
  let documentsFailed = 0;
  let chunksCreated = 0;
  let pageDone = false;

  // We loop pages here so a single job picks up everything available. For
  // very large sources, the worker can split this by having the connector
  // return `done=false` and the job re-enqueue itself with the new cursor.
  while (!pageDone) {
    const page = await connector.list({ cursor, maxItems: opts.pageSize });
    pageDone = page.done;
    log.info(
      { count: page.documents.length, nextCursor: page.nextCursor },
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

    // Persist cursor BEFORE returning so we don't re-process this page on retry.
    cursor = page.nextCursor;
    await updateSourceCursor(deps.db, sourceId, cursor);

    // Loop continuation is driven by `pageDone` (the connector's `done` flag).
    // Do NOT break on `page.documents.length === 0` — a page that yielded
    // zero documents (e.g. all drafts/removals filtered out) is NOT the same
    // as end-of-feed. The connector signals end-of-feed via `done: true`;
    // breaking on empty documents here would silently stall the sync.
  }

  log.info(
    { documentsProcessed, documentsFailed, chunksCreated },
    "ingestion run complete",
  );
  // `done: pageDone` so the caller knows whether to re-enqueue. With the
  // while-loop above, this is normally `true` when we exit cleanly, but a
  // future early-exit (e.g. on signal) could leave it `false`.
  return {
    documentsProcessed,
    documentsFailed,
    chunksCreated,
    done: pageDone,
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
    log.debug("content unchanged, skipping chunk/embed");
    return { chunksCreated: 0 };
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
