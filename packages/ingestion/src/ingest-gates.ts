import type { Logger } from "pino";
import type { ParsedDocument } from "@rag/core";
import {
  ContentSafetyError,
  scanForClientContextOrThrow,
  type ContentScanner,
  type ContentScanResult,
  type DocumentClass,
} from "@rag/core";
import { type Db, deleteDocumentByExternalId, logIngestEvent } from "@rag/db";

/**
 * Ingestion content-safety gate helpers, split out of `pipeline.ts` to keep
 * it under this repo's 800-line cap (`.claude/rules/quality-gates.md`).
 * These are the pieces the Layer 1 / Layer 1.5 / Layer 3 quarantine path
 * needs; the sequencing stays in `ingestOne`, where the ORDER is the thing
 * worth reading.
 */

export type IngestOutcome =
  /** Chunks were written (or the document legitimately produced none). */
  | { outcome: "indexed"; chunksCreated: number }
  /** A safety gate refused it; nothing of it remains in the index. */
  | { outcome: "quarantined"; chunksCreated: 0 }
  /** Content hash matched the stored row -- already indexed, no work needed. */
  | { outcome: "unchanged"; chunksCreated: 0 }
  /** Deliberately not ingested (excluded path), not a safety refusal. */
  | { outcome: "skipped"; chunksCreated: 0 };

/**
 * The text Layer 1.5 examines: every field that can reach the index, joined.
 * Mirrors the input shape of redactParsedDocument for the same reason --
 * chunks are built from tables as well as markdown, and the title is stored,
 * cited, and sent to the model.
 *
 * Called AFTER redaction is written back onto the parsed document, so the
 * scanner sees redacted text and a structured identifier Layer 1 already
 * masked is never re-sent to it.
 */
export function scanTargetOf(parsed: ParsedDocument): string {
  const tableText = (parsed.tables ?? []).flatMap((table) => [
    // `sheetName` and the per-table `markdown` are as index-reachable as the
    // cells: a tab named for a client identifies it just as well.
    table.sheetName ?? "",
    table.markdown ?? "",
    ...(table.headers ?? []),
    ...(table.rows ?? []).flat(),
  ]);
  return [parsed.title, parsed.markdown, ...tableText]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

/**
 * Remove any previously indexed copy of a document being quarantined.
 *
 * A quarantine decision reached here returns before `upsertDocument`, so on
 * its own it only gates the CURRENT write. A document indexed before this
 * layer was enabled, and flagged on a later sync, would keep its existing
 * chunks and stay retrievable -- the gate would announce it caught something
 * while the thing it caught remained searchable. The `chunks` FK is
 * ON DELETE CASCADE, so deleting the document row removes its chunks too.
 *
 * Any stored original becomes unreachable (the download route resolves by
 * document id), though the object itself is left in the bucket.
 */
export async function purgeQuarantined(
  db: Db,
  sourceId: string,
  externalId: string,
  log: Logger,
): Promise<void> {
  const { deleted, storageKey } = await deleteDocumentByExternalId(
    db,
    sourceId,
    externalId,
  );
  if (deleted) {
    log.warn(
      {
        marker: "ingest.quarantine_purged",
        hadStoredOriginal: storageKey !== null,
      },
      "removed a previously indexed copy of this document and its chunks",
    );
  }
}

/**
 * Disposition for a Layer 1.5 scan that FAILED (as opposed to one that
 * flagged): write the audit row, drop any already-indexed copy, and tell the
 * caller to stop.
 *
 * Why an ABSENT scanner is not this case: CONTENT_SCAN_PROVIDER defaults to
 * `none`, which turns Layer 1.5 off, and ingestion then behaves exactly as it
 * did before the layer existed. Treating "off" as a reason to quarantine is
 * not defence in depth -- it quarantines every document in every deployment
 * that has not opted in, which reads as a successful run that indexed nothing.
 *
 * "Off" and "configured but broken" are kept apart upstream, where they can
 * actually be told apart: a provider that is set but unbuildable (missing base
 * URL or model, a non-self-hosted URL under client-data, a host outside the
 * egress allow-list) throws in `createContentScanner` during `buildDeps`, so
 * the worker never boots; and `loadConfig` refuses `none` outright under
 * COMPLIANCE_MODE=client-data, so "off" cannot be chosen where real client
 * data is in scope. Fail-closed therefore applies to the case that remains: a
 * scanner that is present and throws, which is this one.
 */
export async function quarantineForScanFailure(opts: {
  db: Db;
  sourceId: string;
  externalId: string;
  docClass: DocumentClass;
  err: unknown;
  log: Logger;
}): Promise<IngestOutcome> {
  const { db, sourceId, externalId, docClass, err, log } = opts;
  log.error(
    { err, marker: "ingest.semantic_scan_failed" },
    "semantic content scan failed; quarantining document rather than indexing it",
  );
  // Unwrap `cause`: ContentSafetyError always carries the same fixed message
  // and stashes the real reason underneath, so recording `err.message` alone
  // makes "scanner unreachable", "model returned prose" and "egress blocked"
  // indistinguishable in the durable record. The redaction path unwraps for
  // the same reason.
  const detail =
    err instanceof ContentSafetyError && err.cause instanceof Error
      ? err.cause.message
      : err instanceof Error
        ? err.message
        : String(err);
  await logIngestEvent(db, {
    sourceId,
    docId: null,
    externalId,
    docClass,
    action: "blocked",
    rejectionReason: `semantic scan failed: ${detail}`,
  });
  await purgeQuarantined(db, sourceId, externalId, log);
  return { outcome: "quarantined", chunksCreated: 0 };
}

/**
 * Layer 1.5 as one stage: scan the document's index-reachable text for
 * client-identifying context that Layer 1's pattern redaction structurally
 * cannot see (a name in running prose has no fixed shape a regex matches).
 *
 * MUST be called after Layer 1's redaction has been written back onto
 * `parsed`, so the scanner only ever sees redacted text and an identifier
 * Layer 1 already masked is never re-sent to it.
 *
 * This DETECTS rather than redacts: a flagged verdict is handed to the Layer 3
 * classification gate, which quarantines for human review. Masking a name out
 * of prose risks both under-redaction (a nickname, a second mention) and
 * over-redaction (destroying the surrounding sentence) in a way a fixed-width
 * `[REDACTED-SSN]` substitution does not.
 *
 * Returns the verdict, or the caller's terminal outcome when the scan failed.
 */
export async function runSemanticScan(opts: {
  parsed: ParsedDocument;
  scanner: ContentScanner | undefined;
  db: Db;
  sourceId: string;
  externalId: string;
  docClass: DocumentClass;
  log: Logger;
}): Promise<
  { ok: true; scan: ContentScanResult } | { ok: false; outcome: IngestOutcome }
> {
  const { parsed, scanner, db, sourceId, externalId, docClass, log } = opts;
  // No scanner means the layer is OFF -- see `quarantineForScanFailure` above
  // for why that is not the same as "configured but broken", and where each of
  // those is actually caught.
  if (!scanner) return { ok: true, scan: { flagged: false, findings: [] } };

  let scan: ContentScanResult;
  try {
    scan = await scanForClientContextOrThrow(scanTargetOf(parsed), scanner);
  } catch (err) {
    return {
      ok: false,
      outcome: await quarantineForScanFailure({
        db,
        sourceId,
        externalId,
        docClass,
        err,
        log,
      }),
    };
  }
  if (scan.flagged) {
    // Categories only -- the scanner's prompt forbids lifting values into
    // findings precisely so this log and the audit row are safe to write.
    log.warn(
      { findings: scan.findings, marker: "ingest.semantic_flagged" },
      "semantic scan flagged client-identifying context",
    );
  }
  return { ok: true, scan };
}
