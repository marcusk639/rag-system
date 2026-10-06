import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  ContentSafetyError,
  ComplianceError,
  ContentScanFailure,
} from "@rag/core";
import { quarantineForScanFailure } from "./ingest-gates.js";

/**
 * What a FAILED Layer 1.5 scan is allowed to record.
 *
 * The durable record (`ingest_log.rejection_reason`) and the worker log both
 * need to say WHY the gate could not run — "scanner unreachable" and "model
 * returned prose" call for different fixes. But the scanner's own error
 * messages are derived from the model's reading of document text, so the
 * diagnosis has to be a fixed vocabulary, not a free-form message passed
 * through from underneath.
 */
const { logIngestEventMock, deleteDocumentByExternalIdMock } = vi.hoisted(
  () => ({
    logIngestEventMock: vi.fn(),
    deleteDocumentByExternalIdMock: vi.fn(),
  }),
);

vi.mock("@rag/db", () => ({
  logIngestEvent: logIngestEventMock,
  deleteDocumentByExternalId: deleteDocumentByExternalIdMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  logIngestEventMock.mockResolvedValue(undefined);
  deleteDocumentByExternalIdMock.mockResolvedValue({
    deleted: false,
    storageKey: null,
  });
});

/** Stands in for text lifted out of a document by a failing scanner. */
const LEAKED = "Brightwater Holdings";

function recordingLog() {
  const records: unknown[] = [];
  const capture = (obj: unknown, msg?: unknown) => {
    records.push({ obj, msg });
  };
  const log = {
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
    child: () => log,
  } as unknown as Logger;
  return { log, records };
}

async function quarantine(err: unknown) {
  const { log, records } = recordingLog();
  const outcome = await quarantineForScanFailure({
    db: {} as never,
    sourceId: "src-1",
    externalId: "doc-1",
    docClass: "B",
    err,
    log,
  });
  const reason = logIngestEventMock.mock.calls[0]?.[1]?.rejectionReason as
    string | undefined;
  return { outcome, reason, logged: JSON.stringify(records) };
}

describe("quarantineForScanFailure — cause taxonomy", () => {
  it("records a fixed cause, not the underlying message", async () => {
    // The scanner classifies its OWN failures and says so via the
    // discriminant; the gate never re-derives a category by reading a message.
    const err = new ContentSafetyError(
      "semantic content scan failed; document must be quarantined, not indexed",
      new ContentScanFailure(
        "malformed-reply",
        `content scanner reply was not JSON: Unexpected token 'B', "${LEAKED}"`,
      ),
    );
    const { reason } = await quarantine(err);
    expect(reason).toBe("semantic scan failed: malformed-reply");
    expect(reason).not.toContain(LEAKED);
  });

  it("keeps the underlying message out of the audit row", async () => {
    const err = new ContentSafetyError(
      "semantic content scan failed",
      new Error(`parse failed near ${LEAKED}`),
    );
    const { reason } = await quarantine(err);
    expect(reason).not.toContain(LEAKED);
  });

  it("keeps the underlying message out of the worker log", async () => {
    // pino serializes a bound `err` — message AND cause chain — so logging
    // the error object leaks exactly what the audit-row fix removed.
    const err = new ContentSafetyError(
      "semantic content scan failed",
      new Error(`parse failed near ${LEAKED}`),
    );
    const { logged } = await quarantine(err);
    expect(logged).not.toContain(LEAKED);
  });

  it.each([
    ["malformed-reply", new ContentScanFailure("malformed-reply", "x")],
    ["scanner-unreachable", new ContentScanFailure("scanner-unreachable", "x")],
    ["too-large", new ContentScanFailure("too-large", "x")],
  ])("maps a %s scanner failure", async (expected, inner) => {
    const err = new ContentSafetyError("semantic content scan failed", inner);
    const { reason } = await quarantine(err);
    expect(reason).toBe(`semantic scan failed: ${expected}`);
  });

  it("maps a compliance/egress refusal to egress-blocked", async () => {
    const err = new ContentSafetyError(
      "semantic content scan failed",
      new ComplianceError(`egress denied for ${LEAKED}`),
    );
    const { reason } = await quarantine(err);
    expect(reason).toBe("semantic scan failed: egress-blocked");
  });

  it("falls back to 'unknown' rather than inventing a diagnosis", async () => {
    const { reason } = await quarantine(new Error(`weird ${LEAKED}`));
    expect(reason).toBe("semantic scan failed: unknown");
  });

  it("still quarantines and still purges", async () => {
    // The taxonomy changes what is RECORDED, never the disposition.
    const { outcome } = await quarantine(new Error("boom"));
    expect(outcome).toEqual({ outcome: "quarantined", chunksCreated: 0 });
    expect(deleteDocumentByExternalIdMock).toHaveBeenCalledOnce();
  });
});
