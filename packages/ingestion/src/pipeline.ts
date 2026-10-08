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
  type LoadedPack,
  type ObjectStore,
  type Parser,
  type SourceDocument,
} from "@rag/core";
import { classifyDocument } from "./classify-document.js";
import { DeletionReconciliationError } from "./errors.js";
import {
  recordIngestFailure,
  retryFailedDocuments,
} from "./failed-documents.js";
import { isExcludedPath, type ContentScanner } from "@rag/core";
import {
  type IngestOutcome,
  runRedactionGate,
  runSemanticScan,
  purgeQuarantined,
} from "./ingest-gates.js";
// Re-exported: it is `ingestOne`'s return type, so it belongs to this
// module's public surface regardless of which file declares it.
export type { IngestOutcome, QuarantineCause } from "./ingest-gates.js";
import {
  type Db,
  clearDocumentStorage,
  deleteDocumentByExternalId,
  documentHasChunksForModel,
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
  /**
   * Before listing pages, re-fetch and re-ingest documents whose earlier
   * attempts failed (see failed-documents.ts). The worker enables this for the
   * first job of a sync only, not for its continuations.
   */
  retryFailed?: boolean;
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
   * Undeclared fails CLOSED to 'D' (every document quarantined), never to a
   * permissive class.
   */
  sourceDocClass?: DocumentClass;
  /**
   * Where original document bytes are persisted so cited documents can be
   * downloaded later. Null/undefined disables storage (the document is still
   * ingested and searchable; it just won't be downloadable).
   */
  objectStore?: ObjectStore | null;
  /**
   * The loaded identifier-scanner pack `redactParsedDocument` runs before anything
   * downstream (see 1b below). Every caller supplies one: the worker loads it
   * at startup from `config.worker.scannerPackDir` (default `packs/cpa`) and
   * hands it down through `WorkerDeps.pack`.
   *
   * Still typed optional so the omission is a *runtime* failure rather than a
   * compile-time one — the guards below are what protect JavaScript callers
   * and the `as any` deps objects tests build, neither of which the type
   * checker sees. `runIngestion` fails CLOSED, loudly, at the top of the run
   * when this is missing; `ingestOne` also fails CLOSED per-document as
   * defence-in-depth for direct callers.
   */
  pack?: LoadedPack;
  /**
   * Layer 1.5 semantic content scanner — detects client-identifying context
   * (a name in prose) that `pack`'s pattern redaction cannot see.
   *
   * ⚠ NOT the same contract as `pack`. `undefined` means Layer 1.5 is OFF
   * (`CONTENT_SCAN_PROVIDER=none`, the default) and ingestion behaves exactly
   * as it did before this layer existed. Fail-closed applies to a scanner
   * that is present and THROWS, which quarantines the document. The states
   * that must never be confused with "off" are rejected upstream instead: a
   * provider set but unbuildable throws in `createContentScanner` at
   * startup, and `loadConfig` refuses `none` under
   * `COMPLIANCE_MODE=client-data`.
   *
   * MUST be self-hosted — see the egress note on `scanForClientContextOrThrow`.
   */
  scanner?: ContentScanner;
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
   * Documents a safety gate refused this run (redaction, Layer 1.5, or the
   * classification gate). Counted in `documentsProcessed` too, because they
   * were processed — this says how many of those produced no index content on
   * purpose, which `chunksCreated` alone cannot distinguish from a broken
   * embedder or an unreachable scanner.
   */
  documentsQuarantined: number;
  /**
   * The subset of `documentsQuarantined` the gate refused because it could not
   * run — scanner threw/unreachable, redaction threw, pack missing or empty.
   *
   * Always `<= documentsQuarantined`. This is the one that means something is
   * broken: a `policy` quarantine is the gate working, and a source whose
   * documents mostly escalate to class C/D is a sensitive source, not a fault.
   * A gate failure also has no retry path — the cursor advances past the
   * document and its `blocked` audit row resolves it — so it is silent data
   * loss unless a caller escalates it.
   */
  documentsQuarantinedGateFailure: number;
  /** Previously failed documents successfully re-ingested this run. */
  documentsRetried: number;
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
  // A missing pack is a CONFIGURATION gap, not a property of any document —
  // it must be detected once, here, at the top of the run, not per-document
  // inside `ingestOne`. Checking it per-document meant a whole source
  // (e.g. 858 documents) would each be individually quarantined and counted
  // as `documentsProcessed++` with `chunksCreated: 0` — the job completed
  // GREEN reporting `documentsFailed: 0` while indexing nothing, and wrote
  // one misleading `ingest_log` "blocked" row per document, which a
  // compliance query would misread as "the pipeline saw sensitive content in
  // every one of these documents" rather than "nobody wired a pack in".
  // Fail loudly, exactly once, with no per-document audit rows at all.
  //
  // A pack with `scanners: []` is treated identically to a missing pack: it
  // is an exported, structurally-constructible `LoadedPack`, `loadPack`'s
  // `scanners.min(1)` zod check only guards the loader path, and nothing
  // downstream re-checked it — an empty-scanner pack passed `!deps.pack`,
  // made `scanText` loop zero times, and let raw identifiers reach the
  // embedding provider on a run every guard reported as healthy.
  if (!deps.pack || deps.pack.scanners.length === 0) {
    throw new Error(
      "PipelineDeps.pack is not configured — no identifier-scanner pack " +
        "was wired into WorkerDeps (or it declares no scanners, which is " +
        "just as unusable), so redaction cannot run. Ingestion cannot " +
        "proceed until a LoadedPack with at least one scanner (see " +
        "@rag/core loadPack) is supplied to PipelineDeps.pack.",
    );
  }

  const log = deps.logger.child({ sourceId, connector: connector.kind });
  const maxPages = opts.maxPagesPerRun ?? Number.POSITIVE_INFINITY;
  log.info({ startCursor, maxPages }, "starting ingestion run");

  let cursor = startCursor;
  let documentsProcessed = 0;
  let documentsFailed = 0;
  let chunksCreated = 0;
  let documentsDeleted = 0;
  let documentsSkippedOversize = 0;
  let documentsQuarantined = 0;
  let documentsQuarantinedGateFailure = 0;
  let pageDone = false;
  let pagesProcessed = 0;
  // Layer 3: no longer defaults to "A". An undeclared source class is the
  // strongest possible reason NOT to treat content as public — the previous
  // `?? "A"` answered "we don't know" with the most permissive class, which
  // is how 858 unclassified documents were treated as public.
  const docClass: DocumentClass = deps.sourceDocClass ?? "D";

  // The retry pass runs `ingestOne` too, so it can hit a broken gate just as
  // the page loop can. Its outcomes were discarded, which left a gate failure
  // reached only through a retry invisible to every count derived below.
  const retryPass = opts.retryFailed
    ? await retryFailedDocuments(
        { db: deps.db, log, sourceId, connector, docClass },
        (doc) => ingestOne(sourceId, doc, deps, docClass),
      )
    : {
        retried: 0,
        processed: 0,
        failed: 0,
        quarantined: 0,
        quarantinedGateFailure: 0,
      };
  const documentsRetried = retryPass.retried;
  // BOTH counters, not just the gate-failure one. `documentsQuarantined` is
  // documented as the total and the worker derives the policy count by
  // subtracting; feeding only one of them made that subtraction negative.
  documentsProcessed += retryPass.processed;
  documentsFailed += retryPass.failed;
  documentsQuarantined += retryPass.quarantined;
  documentsQuarantinedGateFailure += retryPass.quarantinedGateFailure;

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

    const limit = pLimit(opts.concurrency);
    const results = await Promise.allSettled(
      page.documents.map((doc) =>
        limit(() => ingestOne(sourceId, doc, deps, docClass)),
      ),
    );

    for (const [i, r] of results.entries()) {
      if (r.status === "fulfilled") {
        documentsProcessed++;
        chunksCreated += r.value.chunksCreated;
        // Counted separately from both success and failure. A quarantine is
        // neither: the document was handled correctly and deliberately not
        // indexed. Folding it into documentsProcessed alone is what let a
        // whole-source scanner outage report a green sync that indexed
        // nothing.
        if (r.value.outcome === "quarantined") {
          documentsQuarantined++;
          // Only a gate failure is evidence of a fault — see
          // `QuarantineCause`. Collapsing the two is what let a guard keyed on
          // the total fail every sync of a legitimately sensitive source.
          if (r.value.cause === "gate-failure") {
            documentsQuarantinedGateFailure++;
          }
        }
      } else {
        documentsFailed++;
        log.error({ err: r.reason }, "document failed");
        const failed = page.documents[i];
        if (failed) {
          await recordIngestFailure(
            deps.db,
            log,
            { sourceId, externalId: failed.externalId, docClass },
            r.reason,
          );
        }
      }
    }

    // Reconcile deletions (delta tombstones): remove the document AND its
    // chunks (FK cascade) so files deleted in the source stop surfacing in
    // search. Every tombstone is attempted; any failure fails the page AFTER
    // the loop and BEFORE the cursor is saved (see DeletionReconciliationError).
    const failedDeletions: string[] = [];
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
        failedDeletions.push(externalId);
        log.error(
          { err, externalId, marker: "ingest.delete_failed" },
          "failed to reconcile deleted document; cursor will not advance",
        );
      }
    }
    if (failedDeletions.length > 0) {
      throw new DeletionReconciliationError(sourceId, failedDeletions);
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
      documentsQuarantined,
      documentsQuarantinedGateFailure,
      chunksCreated,
      done: pageDone,
      pagesProcessed,
    },
    "ingestion run complete",
  );
  // ONE operator rule per marker. These two used to be the same line, which
  // claimed an all-quarantined run was "the signature of a broken safety gate
  // ... not of a corpus that is entirely sensitive". That is false: Layer 3
  // escalates on any single identifier finding, so a source whose documents
  // all escalate indexes nothing and is working correctly.
  if (documentsQuarantinedGateFailure > 0) {
    // The authoritative fault signal, and what the worker's guard keys on.
    log.error(
      {
        marker: "ingest.gate_failure_quarantine",
        documentsQuarantinedGateFailure,
        documentsQuarantined,
        documentsProcessed,
      },
      "a content-safety gate could not reach a verdict and documents were " +
        "neither indexed nor recorded as failures; check scanner " +
        "reachability, the egress allow-list, and the identifier-scanner pack",
    );
  } else if (documentsQuarantined > 0 && chunksCreated === 0) {
    // Marker kept (external alerting may key on it) but no longer an error:
    // with zero gate failures this is a legitimate all-policy run, and the
    // caller no longer fails it. Logging it at error level would train an
    // operator to ignore the level that means a gate is actually down.
    log.warn(
      {
        marker: "ingest.all_quarantined",
        documentsQuarantined,
        documentsProcessed,
      },
      "every document this run was quarantined by policy and nothing was " +
        "indexed; expected for a wholly sensitive source, but worth " +
        "confirming the source's declared class is right",
    );
  }
  // `done: pageDone` tells the caller whether the source is fully enumerated.
  // `false` here means the page budget was hit before the feed ended → the
  // caller should re-enqueue a continuation resuming from `cursor`.
  return {
    documentsProcessed,
    documentsFailed,
    chunksCreated,
    documentsDeleted,
    documentsSkippedOversize,
    documentsQuarantined,
    documentsQuarantinedGateFailure,
    documentsRetried,
    done: pageDone,
    nextCursor: cursor,
  };
}

/**
 * Version of everything between the parsed markdown and the stored chunks
 * (redaction scope, chunking, chunk text shape). It is folded into the
 * document content hash, so bumping it makes the next sync re-chunk and
 * re-embed every document even though its source bytes did not change.
 *
 * Bump it whenever that processing changes the chunks produced from the same
 * markdown. History:
 *   1 — implicit: hash of the markdown alone.
 *   2 — document title prefixed to every chunk; tables and titles redacted.
 */
export const CONTENT_PROCESSING_VERSION = 2;

/**
 * Process a single source document: parse, chunk, embed, store.
 *
 * @internal Exported so its missing-pack defence-in-depth guard (see the
 * `!deps.pack` check below) stays directly unit-testable and reachable even
 * though `runIngestion` now checks for a missing pack once at the top of the
 * run. Not part of `@rag/ingestion`'s intended public API — callers should go
 * through `runIngestion`.
 */
export async function ingestOne(
  sourceId: string,
  source: SourceDocument,
  deps: PipelineDeps,
  docClass: DocumentClass,
): Promise<IngestOutcome> {
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
  // ⚠ `externalId` ONLY: the title is the raw, unredacted filename, which in
  // this corpus is routinely the client's name. Child bindings are stamped on
  // every later record -- including the Layer 1.5 warning that this document
  // names a client -- so binding it makes that warning disclose WHO.
  const log = logger.child({ externalId: source.externalId });

  // 0. Layer 2 — structural exclusion. Cheapest and most reliable guard:
  //    a document that is never parsed cannot be chunked, embedded, or stored.
  //    The 2026-08-03 screen's strongest signal was LOCATION, not content —
  //    per-client billing files sat under client-named folders.
  //    Layer 2 reads `metadata.path`, which ONLY the SharePoint connector
  //    populates today. On every other connector the check evaluates undefined
  //    and returns not-excluded — a result indistinguishable in the logs from a
  //    document that was genuinely checked and cleared. A guard that cannot run
  //    has to say so, or its silence reads as protection it never provided.
  if (source.metadata?.path === undefined) {
    log.warn(
      { marker: "ingest.path_unavailable", connectorKind: source.mimeType },
      "structural exclusion (Layer 2) could not evaluate: this connector " +
        "supplies no metadata.path, so location-based client-content " +
        "filtering is NOT in effect for this document",
    );
  }
  const exclusion = isExcludedPath(source.metadata?.path);
  if (exclusion.excluded) {
    log.warn(
      { reason: exclusion.reason, marker: "ingest.excluded_path" },
      "skipping document: path is on the client-content denylist",
    );
    return { outcome: "skipped", chunksCreated: 0 };
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
  const redactionStage = await runRedactionGate({
    parsed,
    pack: deps.pack,
    db: deps.db,
    sourceId,
    externalId: source.externalId,
    docClass,
    log,
  });
  if (!redactionStage.ok) return redactionStage.outcome;
  const redacted = redactionStage.redacted;
  if (redacted.totalRedacted > 0) {
    log.warn(
      { findings: redacted.findings, marker: "ingest.redacted" },
      "redacted identifiers before indexing",
    );
  }
  parsed.markdown = redacted.markdown;
  parsed.tables = redacted.tables;
  parsed.title = redacted.title;

  // 1d. Layer 1.5 -- semantic scan for client-identifying context (a name in
  //     prose) that Layer 1 pattern redaction cannot see. Runs on the
  //     REDACTED text and covers the title and tables too, not markdown
  //     alone. See ./ingest-gates.ts for the scope and the off-vs-broken
  //     contract.
  const scanStage = await runSemanticScan({
    parsed,
    scanner: deps.scanner,
    db: deps.db,
    sourceId,
    externalId: source.externalId,
    docClass,
    log,
  });
  if (!scanStage.ok) return scanStage.outcome;
  const semanticScan = scanStage.scan;

  // 1e. Layer 3 — per-document classification gate. The source's declared class
  //     is a CEILING, not a verdict: evidence from this document can only make
  //     the classification stricter. A "general" source does not make a
  //     document containing an SSN general, which is precisely the failure that
  //     put 858 documents into a public-class index.
  const classification = classifyDocument({
    sourceClass: docClass,
    redactionFindings: redacted.findings,
    clientContextPath: isExcludedPath(source.metadata?.path).excluded,
    semanticContextDetected: semanticScan.flagged,
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
    // Carry the scanner CATEGORIES into the durable record. The reasons list
    // says "semantic-context-detected" but not of what kind, and the findings
    // only reached a pino warning -- so the audit row, which is the artefact
    // a Gate 1 reviewer actually works from, recorded less than the log did.
    // The prompt forbids values in findings precisely so the categories are
    // safe to persist here.
    const semanticDetail =
      semanticScan.findings.length > 0
        ? ` [${semanticScan.findings.join("; ")}]`
        : "";
    const reason = `per-document classification escalated to ${classification.docClass} (${classification.reasons.join(", ")})${semanticDetail}`;
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
    await purgeQuarantined(deps.db, sourceId, source.externalId, log);
    // POLICY, not a fault: the gate reached a verdict and refused this
    // document. Deliberately left unprefixed above so the gate-failure prefix
    // selects only genuine faults.
    return { outcome: "quarantined", cause: "policy", chunksCreated: 0 };
  }

  // 2. Compute content hash on parsed markdown so unchanged-but-touched
  //    documents (source updated metadata only) skip embedding work.
  const contentHash = sha256(
    `v${CONTENT_PROCESSING_VERSION}\n${parsed.markdown}`,
  );

  // 3. Upsert document row; if hash unchanged, we can short-circuit.
  const { id: documentId, contentChanged } = await upsertDocument(db, {
    sourceId,
    externalId: source.externalId,
    title: parsed.title,
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
      // Internal only (not in the exposable-metadata allowlist): lets the
      // download path refuse a redacted document even if a stale original
      // somehow survived.
      redactedIdentifierCount: redacted.totalRedacted,
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
  if (objectStore && redacted.totalRedacted > 0) {
    // The stored original is the RAW file. Serving it would undo redaction,
    // so a redacted document keeps no original — and any original stored by
    // an earlier run (before the identifier was recognised) is removed.
    const { storageKey } = await clearDocumentStorage(db, documentId);
    if (storageKey) {
      try {
        await objectStore.delete(storageKey);
      } catch (err) {
        log.error(
          { err, marker: "ingest.store.delete_failed" },
          "failed to delete stored original of a redacted document",
        );
      }
    }
  } else if (
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
    const embedded = await documentHasChunksForModel(
      db,
      documentId,
      embedder.name,
      embedder.model,
    );
    if (embedded) {
      log.debug("content unchanged, skipping chunk/embed");
      return { outcome: "unchanged", chunksCreated: 0 };
    }
    log.warn("content hash unchanged but document has no chunks; re-embedding");
  }

  // 4. Chunk the markdown.
  const chunks = await chunker.chunk(parsed);
  if (chunks.length === 0) {
    log.warn("parsed document produced zero chunks");
    return { outcome: "indexed", chunksCreated: 0 };
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
  return { outcome: "indexed", chunksCreated: chunks.length };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
