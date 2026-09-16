import type { Connector, DocumentClass, SourceDocument } from "@rag/core";
import { ClassBlockedError } from "@rag/core";
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
      { err: logErr, externalId: row.externalId, marker: "ingest.failure_log_failed" },
      "could not record ingest failure",
    );
  }
}

/**
 * Re-fetch and re-ingest documents whose earlier attempts failed. Returns how
 * many succeeded; each failure is recorded again, so a permanently broken
 * document stops being retried after MAX_INGEST_ATTEMPTS.
 */
export async function retryFailedDocuments(
  args: {
    db: Db;
    log: Logger;
    sourceId: string;
    connector: Connector;
    docClass: DocumentClass;
  },
  ingest: (doc: SourceDocument) => Promise<unknown>,
): Promise<number> {
  const { db, log, sourceId, connector, docClass } = args;
  const externalIds = await listRetryableIngestFailures(db, sourceId, {
    maxAttempts: MAX_INGEST_ATTEMPTS,
    limit: MAX_RETRIES_PER_RUN,
  });
  let retried = 0;
  for (const externalId of externalIds) {
    try {
      await ingest(await connector.fetch(externalId));
      retried++;
    } catch (err) {
      log.warn(
        { err, externalId, marker: "ingest.retry_failed" },
        "retry of a previously failed document failed again",
      );
      await recordIngestFailure(db, log, { sourceId, externalId, docClass }, err);
    }
  }
  if (externalIds.length > 0) {
    log.info(
      { attempted: externalIds.length, retried, marker: "ingest.retry_pass" },
      "retried previously failed documents",
    );
  }
  return retried;
}
