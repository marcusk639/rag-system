import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentScanner, SourceDocument } from "@rag/core";
import { runIngestion } from "./pipeline.js";
import { makeConnector, makeDeps, OPTS } from "./pipeline.test-harness.js";
import type { PipelineDeps } from "./pipeline.js";

/**
 * Why a quarantine's CAUSE has to travel with it.
 *
 * Three structurally different things used to return the same
 * `{ outcome: "quarantined" }`:
 *
 *   - the scanner threw or was unreachable       (the gate BROKE)
 *   - redaction threw / the pack was unusable    (the gate BROKE)
 *   - Layer 3 escalated this document to C/D     (the gate WORKED)
 *
 * The third is ordinary and common: `classify-document.ts` escalates on ANY
 * Layer 1 identifier finding, so an EIN-shaped number in a working-papers
 * folder quarantines that document by design. Counting all three together
 * means no caller can tell "the safety net is down" from "the safety net
 * caught something", which is how a quarantine-share guard came to fail every
 * sync of a legitimately sensitive source forever.
 */
const {
  updateSourceCursorMock,
  upsertDocumentMock,
  replaceChunksMock,
  documentHasChunksMock,
  documentHasStorageMock,
  setDocumentStorageMock,
  logIngestEventMock,
  deleteDocumentByExternalIdMock,
  listRetryableIngestFailuresMock,
} = vi.hoisted(() => ({
  updateSourceCursorMock: vi.fn(),
  upsertDocumentMock: vi.fn(),
  replaceChunksMock: vi.fn(),
  documentHasChunksMock: vi.fn(),
  documentHasStorageMock: vi.fn(),
  setDocumentStorageMock: vi.fn(),
  logIngestEventMock: vi.fn(),
  deleteDocumentByExternalIdMock: vi.fn(),
  listRetryableIngestFailuresMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  updateSourceCursor: updateSourceCursorMock,
  upsertDocument: upsertDocumentMock,
  replaceChunks: replaceChunksMock,
  documentHasChunks: documentHasChunksMock,
  documentHasStorage: documentHasStorageMock,
  deleteDocumentByExternalId: deleteDocumentByExternalIdMock,
  setDocumentStorage: setDocumentStorageMock,
  logIngestEvent: logIngestEventMock,
  clearDocumentStorage: vi.fn().mockResolvedValue({ storageKey: null }),
  listRetryableIngestFailures: listRetryableIngestFailuresMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  upsertDocumentMock.mockResolvedValue({ id: "doc-1", contentChanged: true });
  replaceChunksMock.mockResolvedValue(undefined);
  updateSourceCursorMock.mockResolvedValue(undefined);
  documentHasChunksMock.mockResolvedValue(true);
  documentHasStorageMock.mockResolvedValue(true);
  setDocumentStorageMock.mockResolvedValue(undefined);
  logIngestEventMock.mockResolvedValue(undefined);
  deleteDocumentByExternalIdMock.mockResolvedValue({
    deleted: false,
    storageKey: null,
  });
  listRetryableIngestFailuresMock.mockResolvedValue([]);
});

/** The gate BREAKING: a configured scanner that cannot answer. */
const THROWING_SCANNER: ContentScanner = {
  name: "fake-throwing",
  scan: async () => {
    throw new Error("model unreachable");
  },
};

/** The gate WORKING: a scanner that reaches a verdict, and it is "flagged". */
const FLAGGING_SCANNER: ContentScanner = {
  name: "fake-flagging",
  // Category only, never a value — findings reach the audit row.
  scan: async () => ({ flagged: true, findings: ["client name"] }),
};

function onePage() {
  const { connector } = makeConnector([
    { documents: ["doc-a"], nextCursor: "c1", done: true },
  ]);
  return connector;
}

/** Captures level + marker for every log line the run emits. */
function recordingLogger() {
  const lines: { level: string; marker: unknown; msg: unknown }[] = [];
  const at = (level: string) => (obj: unknown, msg?: unknown) => {
    lines.push({
      level,
      marker: (obj as { marker?: unknown } | undefined)?.marker,
      msg,
    });
  };
  const logger = {
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    debug: at("debug"),
    child: () => logger,
  };
  return { logger, lines };
}

function blockedReasons(): string[] {
  return logIngestEventMock.mock.calls
    .map((call) => call[1] as { action: string; rejectionReason?: string })
    .filter((row) => row.action === "blocked")
    .map((row) => row.rejectionReason ?? "");
}

describe("runIngestion — gate-failure vs policy quarantines", () => {
  it("counts a scan failure as a gate-failure quarantine", async () => {
    const deps = { ...makeDeps(), scanner: THROWING_SCANNER } as PipelineDeps;

    const result = await runIngestion("src", onePage(), null, OPTS, deps);

    expect(result.documentsQuarantined).toBe(1);
    expect(result.documentsQuarantinedGateFailure).toBe(1);
  });

  it("does NOT count a Layer 3 escalation as a gate-failure quarantine", async () => {
    // The whole point of the discriminator. This document was refused BY a
    // working gate; nothing is broken and no run may be failed over it.
    const deps = { ...makeDeps(), scanner: FLAGGING_SCANNER } as PipelineDeps;

    const result = await runIngestion("src", onePage(), null, OPTS, deps);

    expect(result.documentsQuarantined).toBe(1);
    expect(result.documentsQuarantinedGateFailure).toBe(0);
  });

  it("counts a clean run as neither", async () => {
    // The control: proves the two tests above turn on the scanner's verdict
    // and not on something else in the pipeline.
    const result = await runIngestion("src", onePage(), null, OPTS, makeDeps());

    expect(result.documentsQuarantined).toBe(0);
    expect(result.documentsQuarantinedGateFailure).toBe(0);
  });

  it("marks a gate failure's audit row so the document is findable later", async () => {
    // `ingest_log` is where a specific problematic document is persisted. A
    // document that reliably breaks the scanner has to be identifiable from
    // that table alone -- otherwise the only remedy for a repeatedly failing
    // sync is to guess which file causes it.
    const deps = { ...makeDeps(), scanner: THROWING_SCANNER } as PipelineDeps;

    await runIngestion("src", onePage(), null, OPTS, deps);

    expect(blockedReasons()).toEqual([
      "gate-failure: semantic scan failed: unknown",
    ]);
  });

  it("leaves a policy quarantine's audit row unprefixed", async () => {
    // Both are `action: "blocked"` -- deliberately, so a compliance query for
    // refused documents keeps seeing both -- so the reason prefix is the only
    // thing separating them. If policy rows carried it too, the prefix would
    // select everything and identify nothing.
    const deps = { ...makeDeps(), scanner: FLAGGING_SCANNER } as PipelineDeps;

    await runIngestion("src", onePage(), null, OPTS, deps);

    const reasons = blockedReasons();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).not.toContain("gate-failure:");
    expect(reasons[0]).toContain("client name");
  });

  it("counts a gate failure that happens on the RETRY path", async () => {
    // `retryFailedDocuments` re-ingests previously failed documents before the
    // page loop and discarded every outcome, counting a quarantined retry as a
    // successful one. A broken gate reached only through the retry pass was
    // therefore invisible to any count derived from the page loop.
    listRetryableIngestFailuresMock.mockResolvedValue(["doc-z"]);
    const { connector } = makeConnector([
      { documents: [], nextCursor: "c1", done: true },
    ]);
    (connector as unknown as { fetch: unknown }).fetch = vi.fn(
      async (externalId: string): Promise<SourceDocument> => ({
        externalId,
        title: externalId,
        modifiedAt: new Date().toISOString(),
        mimeType: "text/plain",
        content: Buffer.from("content"),
        metadata: {},
      }),
    );
    const deps = { ...makeDeps(), scanner: THROWING_SCANNER } as PipelineDeps;

    const result = await runIngestion(
      "src",
      connector,
      null,
      { ...OPTS, retryFailed: true },
      deps,
    );

    expect(result.documentsQuarantinedGateFailure).toBe(1);
    // The gate-failure count is documented as a SUBSET of the total, and the
    // worker derives `policy = total - gateFailure` for its operator message.
    // Counting a retry-path gate failure in only one of the two broke that
    // invariant and printed "-1 further documents were quarantined by policy".
    expect(result.documentsQuarantined).toBe(1);
    expect(result.documentsQuarantinedGateFailure).toBeLessThanOrEqual(
      result.documentsQuarantined,
    );
  });

  it("counts a POLICY quarantine on the retry path in the total", async () => {
    // The other half of the same hole: the retry pass reported only gate
    // failures, so a policy quarantine reached through it incremented neither
    // counter and vanished from the run's reported totals entirely.
    listRetryableIngestFailuresMock.mockResolvedValue(["doc-z"]);
    const { connector } = makeConnector([
      { documents: [], nextCursor: "c1", done: true },
    ]);
    (connector as unknown as { fetch: unknown }).fetch = vi.fn(
      async (externalId: string): Promise<SourceDocument> => ({
        externalId,
        title: externalId,
        modifiedAt: new Date().toISOString(),
        mimeType: "text/plain",
        content: Buffer.from("content"),
        metadata: {},
      }),
    );
    const deps = { ...makeDeps(), scanner: FLAGGING_SCANNER } as PipelineDeps;

    const result = await runIngestion(
      "src",
      connector,
      null,
      { ...OPTS, retryFailed: true },
      deps,
    );

    expect(result.documentsQuarantined).toBe(1);
    expect(result.documentsQuarantinedGateFailure).toBe(0);
  });

  it("reports a gate failure at error level under its own marker", async () => {
    // One operator rule, one marker. `ingest.all_quarantined` used to be the
    // only signal and fired on `quarantined > 0 && chunksCreated === 0`, which
    // a legitimate all-policy run satisfies.
    const { logger, lines } = recordingLogger();
    const deps = {
      ...makeDeps(),
      logger,
      scanner: THROWING_SCANNER,
    } as unknown as PipelineDeps;

    await runIngestion("src", onePage(), null, OPTS, deps);

    const errors = lines.filter((l) => l.level === "error");
    expect(errors.map((l) => l.marker)).toContain(
      "ingest.gate_failure_quarantine",
    );
  });

  it("does NOT report an all-policy run as an error", async () => {
    // Every document refused, nothing indexed, and nothing wrong: this is what
    // a source whose documents all escalate to class C/D looks like. Logging
    // it at error level -- and telling the operator to "treat this as a failed
    // run" -- trains them to ignore the level that means a gate is down.
    const { logger, lines } = recordingLogger();
    const deps = {
      ...makeDeps(),
      logger,
      scanner: FLAGGING_SCANNER,
    } as unknown as PipelineDeps;

    await runIngestion("src", onePage(), null, OPTS, deps);

    expect(lines.filter((l) => l.level === "error")).toEqual([]);
    expect(
      lines.filter(
        (l) => l.level === "warn" && l.marker === "ingest.all_quarantined",
      ),
    ).toHaveLength(1);
  });
});
