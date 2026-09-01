import { createHash } from "node:crypto";
import pLimit from "p-limit";
import type { Logger } from "pino";
import {
  ClassBlockedError,
  EmbeddingError,
  scanForTRI,
  type Chunker,
  type Connector,
  type DocumentClass,
  type DocumentMetadata,
  type EmbeddingProvider,
  type ObjectStore,
  type Parser,
  type SourceDocument,
} from "@rag/core";
import { classifyDocument } from "./classify-document.js";
import { isExcludedPath, redactOrThrow, ContentSafetyError } from "@rag/core";
import {
  type Db,
  deleteDocumentByExternalId,
  documentHasChunks,
  documentHasStorage,
  logIngestEvent,
  replaceChunks,
  setDocumentStorage,
  updateSourceCursor,
  upsertDocument,
} from "@rag/db";
import { documentStorageKey } from "@rag/rag";

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
  /**
   * Data classification declared by the source being ingested.
   * Inherited from `sources.doc_class` and stamped onto every document.
   * Phase 1 accepts A and B; C and D throw ClassBlockedError.
   * Defaults to 'A' for backwards compatibility with tests that don't set it.
   */
  sourceDocClass?: DocumentClass;
  /**
   * Where original document bytes are persisted so cited documents can be
   * downloaded later. Null/undefined disables storage (the document is still
   * ingested and searchable; it just won't be downloadable).
   */
  objectStore?: ObjectStore | null;
}

export interface PipelineRunResult {
  documentsProcessed: number;
  documentsFailed: number;
  chunksCreated: number;
  /** Documents removed this run because the source reported them deleted (tombstones). */
  documentsDeleted: number;
  /** Items the connector skipped for exceeding its size cap (observability only). */
  documentsSkippedOversize: number;
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
  let documentsDeleted = 0;
  let documentsSkippedOversize = 0;
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
      {
        count: page.documents.length,
        deletions: page.deletions?.length ?? 0,
        skippedOversize: page.skippedOversize ?? 0,
        nextCursor: page.nextCursor,
        pagesProcessed,
      },
      "fetched page",
    );

    // Layer 3: no longer defaults to "A". An undeclared source class is the
    // strongest possible reason NOT to treat content as public — the previous
    // `?? "A"` answered "we don't know" with the most permissive class, which
    // is how 858 unclassified documents were treated as public.
    const docClass: DocumentClass = deps.sourceDocClass ?? "D";
    const limit = pLimit(opts.concurrency);
    const results = await Promise.allSettled(
      page.documents.map((doc) =>
        limit(() => ingestOne(sourceId, doc, deps, docClass)),
      ),
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

    // Reconcile deletions (delta tombstones): remove the document AND its
    // chunks (FK cascade) so files deleted in the source stop surfacing in
    // search. A single failed delete must not abort the whole sync.
    for (const externalId of page.deletions ?? []) {
      try {
        const del = await deleteDocumentByExternalId(
          deps.db,
          sourceId,
          externalId,
        );
        if (del.deleted) {
          documentsDeleted++;
          // Best-effort: also remove the stored original so deleted files don't
          // leave orphaned blobs. A failure here is logged, not fatal.
          if (del.storageKey && deps.objectStore) {
            try {
              await deps.objectStore.delete(del.storageKey);
            } catch (err) {
              log.error(
                { err, externalId, marker: "ingest.store.delete_failed" },
                "failed to delete stored original for tombstone",
              );
            }
          }
        }
      } catch (err) {
        log.error({ err, externalId }, "failed to reconcile deleted document");
      }
    }
    documentsSkippedOversize += page.skippedOversize ?? 0;

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
    {
      marker: "ingest.run.summary",
      documentsProcessed,
      documentsFailed,
      documentsDeleted,
      documentsSkippedOversize,
      chunksCreated,
      done: pageDone,
      pagesProcessed,
    },
    "ingestion run complete",
  );
  // `done: pageDone` tells the caller whether the source is fully enumerated.
  // `false` here means the page budget was hit before the feed ended → the
  // caller should re-enqueue a continuation resuming from `cursor`.
  return {
    documentsProcessed,
    documentsFailed,
    chunksCreated,
    documentsDeleted,
    documentsSkippedOversize,
    done: pageDone,
    nextCursor: cursor,
  };
}

/** Process a single source document: parse, chunk, embed, store. */
async function ingestOne(
  sourceId: string,
  source: SourceDocument,
  deps: PipelineDeps,
  docClass: DocumentClass,
): Promise<{ chunksCreated: number }> {
  // Phase 1 hard block — C and D require compliance workflows that do not yet
  // exist. This is a programming error if reached (the source should not have
  // been created with a C/D class in Phase 1), so we throw rather than skip.
  if (docClass === "C" || docClass === "D") {
    const blocked = new ClassBlockedError(docClass, sourceId);
    await logIngestEvent(deps.db, {
      sourceId,
      docId: null,
      externalId: source.externalId,
      docClass,
      action: "blocked",
      rejectionReason: blocked.message,
    });
    throw blocked;
  }

  const { db, parser, chunker, embedder, objectStore, logger } = deps;
  const log = logger.child({
    externalId: source.externalId,
    title: source.title,
  });

  // 0. Layer 2 — structural exclusion. Cheapest and most reliable guard:
  //    a document that is never parsed cannot be chunked, embedded, or stored.
  //    The 2026-08-03 screen's strongest signal was LOCATION, not content —
  //    per-client billing files sat under client-named folders.
  const exclusion = isExcludedPath(source.metadata?.path);
  if (exclusion.excluded) {
    log.warn(
      { reason: exclusion.reason, marker: "ingest.excluded_path" },
      "skipping document: path is on the client-content denylist",
    );
    return { chunksCreated: 0 };
  }

  // 1. Parse to clean markdown.
  const parsed = await parser.parse({
    content: source.content,
    mimeType: source.mimeType,
    filename: source.title,
  });

  // 1b. Layer 1 — redact structured identifiers BEFORE anything downstream.
  //     This must precede embedding, not merely storage: embeddings go to a
  //     third party, so redacting on the way into Postgres while embedding raw
  //     text protects the database and discloses the document. That ordering
  //     mistake is what put client data in front of an external provider on
  //     2026-08-01. Hashing the redacted text also means a document whose only
  //     change is a redaction does not silently reuse a stale embedding.
  let redacted;
  try {
    redacted = redactOrThrow(parsed.markdown);
  } catch (err) {
    // Fail CLOSED: quarantine by skipping, never index raw.
    log.error(
      { err, marker: "ingest.redaction_failed" },
      "redaction failed; quarantining document rather than indexing it",
    );
    if (err instanceof ContentSafetyError) return { chunksCreated: 0 };
    throw err;
  }
  if (redacted.totalRedacted > 0) {
    log.warn(
      { findings: redacted.findings, marker: "ingest.redacted" },
      "redacted identifiers before indexing",
    );
  }
  parsed.markdown = redacted.text;

  // 1c. Layer 3 — per-document classification gate. The source's declared class
  //     is a CEILING, not a verdict: evidence from this document can only make
  //     the classification stricter. A "general" source does not make a
  //     document containing an SSN general, which is precisely the failure that
  //     put 858 documents into a public-class index.
  const classification = classifyDocument({
    sourceClass: docClass,
    redactionFindings: redacted.findings,
    clientContextPath: isExcludedPath(source.metadata?.path).excluded,
  });
  if (classification.quarantine) {
    // Redaction is damage limitation, not absolution — a document that
    // CONTAINED an identifier is treated as client data even once masked,
    // because masking cannot prove every value was recognised.
    //
    // ⚠ The audit event is not optional. Quarantining without a durable record
    // would prevent the disclosure but destroy the evidence that the pipeline
    // saw sensitive content — which is the half that matters under §7216 /
    // Circular 230. A logger warning is not an audit trail.
    const reason = `per-document classification escalated to ${classification.docClass} (${classification.reasons.join(", ")})`;
    await logIngestEvent(deps.db, {
      sourceId,
      docId: null,
      externalId: source.externalId,
      docClass: classification.docClass,
      action: "blocked",
      rejectionReason: reason,
    });
    log.warn(
      {
        docClass: classification.docClass,
        reasons: classification.reasons,
        marker: "ingest.quarantined",
      },
      "quarantining document: " + reason,
    );
    return { chunksCreated: 0 };
  }

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
    metadata: {
      ...source.metadata,
      ...parsed.metadata,
      // Stamp the classification tag into the stored metadata so it is
      // available for retrieval filtering and citation display.
      docClass,
    } as DocumentMetadata & Record<string, unknown>,
    markdown: parsed.markdown,
  });

  // Audit: record a successful ingest event for compliance tracking.
  await logIngestEvent(db, {
    sourceId,
    docId: documentId,
    externalId: source.externalId,
    docClass,
    action: "ingested",
  });

  // Compliance: scan parsed content for TRI patterns (§7216). Ingestion is
  // NOT blocked — these are client tax documents and storing them is the
  // purpose of the system. The audit event provides the compliance trail.
  const triScan = scanForTRI(parsed.markdown);
  if (triScan.detected) {
    await logIngestEvent(db, {
      sourceId,
      docId: documentId,
      externalId: source.externalId,
      docClass,
      action: "tri-flagged",
      rejectionReason: `TRI patterns: ${triScan.patterns.join(", ")}`,
    });
    log.warn(
      { triPatterns: triScan.patterns, marker: "ingest.tri.flagged" },
      "TRI patterns detected in document content; compliance event logged",
    );
  }

  // Persist the ORIGINAL bytes so the cited document can be downloaded as-is.
  // Runs on content change, OR when the hash is unchanged but storage was
  // never recorded (a prior run's upload failed, or was interrupted between
  // writing the hash and writing the storage columns) — otherwise such a
  // document would never get a working download link again without forcing
  // its hash to look "changed". A storage failure must NOT fail text
  // ingestion: the document stays searchable; it just isn't downloadable
  // until the next successful sync.
  if (
    objectStore &&
    (contentChanged || !(await documentHasStorage(db, documentId)))
  ) {
    const storageKey = documentStorageKey(sourceId, source.externalId);
    try {
      await objectStore.put(storageKey, source.content, source.mimeType);
      await setDocumentStorage(db, documentId, {
        storageKey,
        storageBucket: objectStore.bucket,
        originalSizeBytes: source.content.byteLength,
      });
    } catch (err) {
      log.error(
        { err, marker: "ingest.store.put_failed" },
        "failed to store original document bytes",
      );
    }
  }

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
