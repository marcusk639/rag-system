import type { Logger } from "pino";
import type {
  LoadedPack,
  ParsedDocument,
  RedactedParsedDocument,
} from "@rag/core";
import {
  ContentSafetyError,
  redactParsedDocument,
  classifyScanFailure,
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

/**
 * WHY a document was quarantined. Three structurally different outcomes used
 * to share one `{ outcome: "quarantined" }` shape, so no caller could tell
 * "the safety net is down" from "the safety net caught something":
 *
 *  - `gate-failure` — the gate could not reach a verdict. The scanner threw or
 *    was unreachable, redaction threw, or the identifier pack was missing or
 *    empty. This says NOTHING about the document; it says the pipeline is
 *    broken, and the document was dropped from the index with no retry path
 *    (the cursor advances past it and its audit row resolves it), so it is
 *    the one quarantine a caller must escalate.
 *  - `policy` — the gate worked and refused the document. Layer 3 escalated it
 *    to class C/D. This is ordinary and common: `classifyDocument` escalates on
 *    ANY Layer 1 identifier finding, so one EIN-shaped number is enough. A
 *    source where most documents escalate is a legitimately sensitive source,
 *    not a fault, and must never fail a run.
 */
export type QuarantineCause = "gate-failure" | "policy";

/**
 * Prefix on `ingest_log.rejection_reason` for every `gate-failure` quarantine.
 *
 * The action stays `"blocked"` for both causes, deliberately: a compliance
 * query for refused documents must keep seeing gate failures too. So the
 * reason prefix is the only durable discriminator, and it is what makes a
 * document that reliably breaks the gate findable in `ingest_log` instead of
 * something an operator has to guess at.
 */
export const GATE_FAILURE_REASON_PREFIX = "gate-failure: ";

export type IngestOutcome =
  /** Chunks were written (or the document legitimately produced none). */
  | { outcome: "indexed"; chunksCreated: number }
  /** A safety gate refused it; nothing of it remains in the index. */
  | { outcome: "quarantined"; cause: QuarantineCause; chunksCreated: 0 }
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
  // Classify to a fixed vocabulary. The previous version unwrapped `cause` and
  // recorded its MESSAGE, which preserved the diagnosis but also carried the
  // scanner's reply -- the model's reading of document text -- into
  // `ingest_log.rejection_reason`. The diagnosis is the part worth keeping.
  const cause = classifyScanFailure(err);
  // ⚠ `cause`, never `err`: pino serializes a bound Error's message AND its
  // cause chain, so logging the object would leak through the worker log
  // exactly what the audit row no longer records.
  log.error(
    { cause, marker: "ingest.semantic_scan_failed" },
    "semantic content scan failed; quarantining document rather than indexing it",
  );
  await logIngestEvent(db, {
    sourceId,
    docId: null,
    externalId,
    docClass,
    action: "blocked",
    rejectionReason: `${GATE_FAILURE_REASON_PREFIX}semantic scan failed: ${cause}`,
  });
  await purgeQuarantined(db, sourceId, externalId, log);
  return { outcome: "quarantined", cause: "gate-failure", chunksCreated: 0 };
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

/**
 * Layer 1 as one stage: redact structured identifiers before ANYTHING
 * downstream sees the document.
 *
 * This must precede embedding, not merely storage: embeddings go to a third
 * party, so redacting on the way into Postgres while embedding raw text
 * protects the database and discloses the document. That ordering mistake is
 * what put client data in front of an external provider on 2026-08-01.
 * Hashing the redacted text also means a document whose only change is a
 * redaction does not silently reuse a stale embedding.
 *
 * Returns the redaction result, or the caller's terminal outcome when the gate
 * could not run. Both failure modes here are `gate-failure`, never `policy`:
 * neither says anything about this document's content.
 */
export async function runRedactionGate(opts: {
  parsed: ParsedDocument;
  pack: LoadedPack | undefined;
  db: Db;
  sourceId: string;
  externalId: string;
  docClass: DocumentClass;
  log: Logger;
}): Promise<
  | { ok: true; redacted: RedactedParsedDocument }
  | { ok: false; outcome: IngestOutcome }
> {
  const { parsed, pack, db, sourceId, externalId, docClass, log } = opts;
  let redacted: RedactedParsedDocument;
  try {
    if (!pack || pack.scanners.length === 0) {
      // Fail CLOSED, loudly: no pack (or a pack with no scanners — just as
      // unusable, since `scanText` would loop zero times) means we cannot
      // tell an SSN from a form number, so every document must be
      // quarantined until this is fixed — not silently skipped, and not
      // indexed unredacted. Thrown as ContentSafetyError (not a bare Error)
      // so it flows through the SAME catch below as a genuine redaction
      // failure: quarantine, don't crash the run.
      throw new ContentSafetyError(
        "PipelineDeps.pack is not configured — no identifier-scanner pack " +
          "was wired into WorkerDeps (or it declares no scanners), so " +
          "redaction cannot run. Ingestion cannot proceed until a " +
          "LoadedPack with at least one scanner (see @rag/core loadPack) " +
          "is supplied to PipelineDeps.pack; every document will be " +
          "quarantined until then.",
      );
    }
    // Every text-bearing field, not only markdown: spreadsheet chunks are
    // built from `tables`, and the title is stored, cited, and sent to the
    // model. Redacting markdown alone left those fields raw.
    redacted = redactParsedDocument(
      {
        title: parsed.title,
        markdown: parsed.markdown,
        tables: parsed.tables,
      },
      pack,
    );
  } catch (err) {
    // Fail CLOSED: quarantine by skipping, never index raw.
    log.error(
      { err, marker: "ingest.redaction_failed" },
      "redaction failed; quarantining document rather than indexing it",
    );
    if (err instanceof ContentSafetyError) {
      // ⚠ The audit event is not optional here either (Ruling R8) — same
      // standard as the Layer 3 quarantine: "Quarantining without a durable
      // record would prevent the disclosure but destroy the evidence that the
      // pipeline saw sensitive content... A logger warning is not an audit
      // trail." Two distinct causes reach this branch — an unusable pack (a
      // config gap, nothing about THIS document — missing OR declaring zero
      // scanners) and a genuine redactOrThrow failure (something about this
      // document's content) — so the reason string names which one, rather
      // than reusing one generic phrase for both. Both are gate FAILURES, so
      // the reason also carries the machine-readable prefix that makes the
      // document findable in `ingest_log`.
      const packUsable = !!pack && pack.scanners.length > 0;
      const rejectionReason =
        GATE_FAILURE_REASON_PREFIX +
        (packUsable
          ? `redaction threw while processing this document: ${
              err.cause instanceof Error ? err.cause.message : err.message
            }`
          : "no identifier-scanner pack was configured on PipelineDeps.pack " +
            "(or it declares no scanners); redaction cannot run until a " +
            "usable one is wired in");
      await logIngestEvent(db, {
        sourceId,
        docId: null,
        externalId,
        docClass,
        action: "blocked",
        rejectionReason,
      });
      await purgeQuarantined(db, sourceId, externalId, log);
      return {
        ok: false,
        outcome: {
          outcome: "quarantined",
          cause: "gate-failure",
          chunksCreated: 0,
        },
      };
    }
    throw err;
  }
  return { ok: true, redacted };
}
