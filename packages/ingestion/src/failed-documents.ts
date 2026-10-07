import type { Connector, DocumentClass, SourceDocument } from "@rag/core";
import { ClassBlockedError } from "@rag/core";
import type { IngestOutcome } from "./ingest-gates.js";
import { listRetryableIngestFailures, logIngestEvent, type Db } from "@rag/db";
import type { Logger } from "pino";

/** Give up on a document after this many consecutive failed attempts. */
export const MAX_INGEST_ATTEMPTS = 5;
/** Failures retried per sync run, so a large outage backlog stays bounded. */
export const MAX_RETRIES_PER_RUN = 50;

/**
 * Record a document that could not be ingested. The reason is the error's
 * name and code only — messages from parsers and SDKs can carry file content
 * or connection detail, and ingest_log is an audit table.
 *
 * Class blocks are not failures (they are already logged as "blocked"), and a
 * logging error never masks the original failure.
 */
export async function recordIngestFailure(
  db: Db,
  log: Logger,
  row: { sourceId: string; externalId: string; docClass: DocumentClass },
  err: unknown,
): Promise<void> {
  if (err instanceof ClassBlockedError) return;
  const name = err instanceof Error ? err.name : typeof err;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  try {
    await logIngestEvent(db, {
      sourceId: row.sourceId,
      docId: null,
      externalId: row.externalId,
      docClass: row.docClass,
      action: "failed",
      rejectionReason: code ? `${name} (${code})` : name,
    });
  } catch (logErr) {
    log.error(
      {
        err: logErr,
        externalId: row.externalId,
        marker: "ingest.failure_log_failed",
      },
      "could not record ingest failure",
    );
  }
}

export interface RetryPassResult {
  /** Retried documents that did not throw. */
  retried: number;
  /**
   * Documents this pass handled, counted the same way the page loop counts
   * them. The pass calls the same `ingestOne`, so omitting it understated the
   * run: with an empty first page the operator message read "a gate FAILED on
   * 1 of 0 documents".
   */
  processed: number;
  /** Retries that threw, counted like a page-loop failure. */
  failed: number;
  /**
   * Retries a safety gate quarantined, either cause. The caller folds this
   * into the run's total so `quarantinedGateFailure <= quarantined` holds for
   * retry-path quarantines too -- it derives the policy count by subtracting
   * the two, and counting a retry in only one of them printed a NEGATIVE
   * policy count into the operator-facing error.
   */
  quarantined: number;
  /**
   * The subset a BROKEN gate quarantined. Reported separately because the
   * caller's "is the gate working?" test must see these: the retry pass calls
   * the same `ingestOne` as the page loop, so it can hit the same broken
   * scanner, and discarding its outcomes made such a failure invisible to any
   * count taken from the page loop alone.
   */
  quarantinedGateFailure: number;
}

/**
 * Re-fetch and re-ingest documents whose earlier attempts failed. Each failure
 * is recorded again, so a permanently broken document stops being retried
 * after MAX_INGEST_ATTEMPTS.
 */
export async function retryFailedDocuments(
  args: {
    db: Db;
    log: Logger;
    sourceId: string;
    connector: Connector;
    docClass: DocumentClass;
  },
  ingest: (doc: SourceDocument) => Promise<IngestOutcome>,
): Promise<RetryPassResult> {
  const { db, log, sourceId, connector, docClass } = args;
  const externalIds = await listRetryableIngestFailures(db, sourceId, {
    maxAttempts: MAX_INGEST_ATTEMPTS,
    limit: MAX_RETRIES_PER_RUN,
  });
  let retried = 0;
  let processed = 0;
  let failed = 0;
  let quarantined = 0;
  let quarantinedGateFailure = 0;
  for (const externalId of externalIds) {
    try {
      const outcome = await ingest(await connector.fetch(externalId));
      // `retried` keeps counting "attempted without throwing" -- a quarantined
      // retry is reported through `quarantinedGateFailure`, not by quietly
      // shrinking a number other callers already read.
      retried++;
      processed++;
      if (outcome.outcome === "quarantined") {
        quarantined++;
        if (outcome.cause === "gate-failure") quarantinedGateFailure++;
      }
    } catch (err) {
      failed++;
      log.warn(
        { err, externalId, marker: "ingest.retry_failed" },
        "retry of a previously failed document failed again",
      );
      await recordIngestFailure(
        db,
        log,
        { sourceId, externalId, docClass },
        err,
      );
    }
  }
  if (externalIds.length > 0) {
    log.info(
      {
        attempted: externalIds.length,
        retried,
        processed,
        failed,
        quarantined,
        quarantinedGateFailure,
        marker: "ingest.retry_pass",
      },
      "retried previously failed documents",
    );
  }
  return { retried, processed, failed, quarantined, quarantinedGateFailure };
}
