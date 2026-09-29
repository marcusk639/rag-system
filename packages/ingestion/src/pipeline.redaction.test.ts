import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClassBlockedError, type LoadedPack } from "@rag/core";
import { runIngestion, type PipelineDeps } from "./pipeline.js";
import {
  makeConnector,
  makeDeps,
  makeObjectStore,
  OPTS,
} from "./pipeline.test-harness.js";

// Mock the @rag/db sinks so the pipeline's control flow (page loop, cursor
// persistence, done reporting) can be tested without a live Postgres.
const {
  updateSourceCursorMock,
  upsertDocumentMock,
  replaceChunksMock,
  documentHasChunksMock,
  documentHasStorageMock,
  deleteDocumentByExternalIdMock,
  setDocumentStorageMock,
  logIngestEventMock,
  clearDocumentStorageMock,
  listRetryableIngestFailuresMock,
} = vi.hoisted(() => ({
  updateSourceCursorMock: vi.fn(),
  upsertDocumentMock: vi.fn(),
  replaceChunksMock: vi.fn(),
  documentHasChunksMock: vi.fn(),
  documentHasStorageMock: vi.fn(),
  deleteDocumentByExternalIdMock: vi.fn(),
  setDocumentStorageMock: vi.fn(),
  logIngestEventMock: vi.fn(),
  clearDocumentStorageMock: vi.fn(),
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
  clearDocumentStorage: clearDocumentStorageMock,
  listRetryableIngestFailures: listRetryableIngestFailuresMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  upsertDocumentMock.mockResolvedValue({ id: "doc-1", contentChanged: true });
  replaceChunksMock.mockResolvedValue(undefined);
  updateSourceCursorMock.mockResolvedValue(undefined);
  documentHasChunksMock.mockResolvedValue(true);
  documentHasStorageMock.mockResolvedValue(true);
  deleteDocumentByExternalIdMock.mockResolvedValue({
    deleted: true,
    storageKey: null,
  });
  setDocumentStorageMock.mockResolvedValue(undefined);
  logIngestEventMock.mockResolvedValue(undefined);
  clearDocumentStorageMock.mockResolvedValue({ storageKey: null });
  listRetryableIngestFailuresMock.mockResolvedValue([]);
});

describe("document classification enforcement", () => {
  it("Class A documents are ingested normally", async () => {
    const deps = { ...makeDeps(), sourceDocClass: "A" as const };
    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: null, done: true },
    ]);
    const result = await runIngestion("src", connector, null, OPTS, deps);
    expect(result.documentsProcessed).toBe(1);
    expect(result.documentsFailed).toBe(0);
  });

  it("Class B documents are ingested normally", async () => {
    const deps = { ...makeDeps(), sourceDocClass: "B" as const };
    const { connector } = makeConnector([
      { documents: ["b"], nextCursor: null, done: true },
    ]);
    const result = await runIngestion("src", connector, null, OPTS, deps);
    expect(result.documentsProcessed).toBe(1);
    expect(result.documentsFailed).toBe(0);
  });

  it("Class C documents throw ClassBlockedError — zero documents ingested", async () => {
    const deps = { ...makeDeps(), sourceDocClass: "C" as const };
    const { connector } = makeConnector([
      { documents: ["c1", "c2"], nextCursor: null, done: true },
    ]);
    const result = await runIngestion("src", connector, null, OPTS, deps);
    // Both docs fail; none processed
    expect(result.documentsProcessed).toBe(0);
    expect(result.documentsFailed).toBe(2);
    expect(upsertDocumentMock).not.toHaveBeenCalled();
  });

  it("Class D documents throw ClassBlockedError — zero documents ingested", async () => {
    const deps = { ...makeDeps(), sourceDocClass: "D" as const };
    const { connector } = makeConnector([
      { documents: ["d1"], nextCursor: null, done: true },
    ]);
    const result = await runIngestion("src", connector, null, OPTS, deps);
    expect(result.documentsProcessed).toBe(0);
    expect(result.documentsFailed).toBe(1);
    expect(upsertDocumentMock).not.toHaveBeenCalled();
  });

  it("ClassBlockedError carries the correct docClass and is instanceof ClassBlockedError", async () => {
    // Capture the error thrown by the pipeline for a Class C document
    let captured: unknown;
    const deps = { ...makeDeps(), sourceDocClass: "C" as const };
    const originalLog = deps.logger.error.bind(deps.logger);
    (deps.logger as unknown as Record<string, unknown>).error = (
      obj: unknown,
    ) => {
      captured = (obj as { err: unknown }).err;
      originalLog(obj as Parameters<typeof originalLog>[0], "");
    };
    const { connector } = makeConnector([
      { documents: ["x"], nextCursor: null, done: true },
    ]);
    await runIngestion("src", connector, null, OPTS, deps);
    expect(captured).toBeInstanceOf(ClassBlockedError);
    expect((captured as ClassBlockedError).docClass).toBe("C");
  });

  it("logIngestEvent is called with action=ingested for Class A documents", async () => {
    const deps = { ...makeDeps(), sourceDocClass: "A" as const };
    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: null, done: true },
    ]);
    await runIngestion("src-id", connector, null, OPTS, deps);
    expect(logIngestEventMock).toHaveBeenCalledOnce();
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sourceId: "src-id",
        docId: "doc-1",
        docClass: "A",
        action: "ingested",
      }),
    );
  });

  it("logIngestEvent is called with action=blocked for Class C documents", async () => {
    const deps = { ...makeDeps(), sourceDocClass: "C" as const };
    const { connector } = makeConnector([
      { documents: ["c1"], nextCursor: null, done: true },
    ]);
    await runIngestion("src-id", connector, null, OPTS, deps);
    expect(logIngestEventMock).toHaveBeenCalledOnce();
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sourceId: "src-id",
        docId: null,
        docClass: "C",
        action: "blocked",
        rejectionReason: expect.stringContaining(
          "cannot be indexed in Phase 1",
        ),
      }),
    );
    // The doc must NOT have been upserted into the DB
    expect(upsertDocumentMock).not.toHaveBeenCalled();
  });
});

describe("redaction covers tables and title, not only markdown", () => {
  // `account` is masked but is NOT a Class-D identifier, so the document is
  // indexed — the case where unredacted table cells would reach the chunks.
  const ACCOUNT_PACK: LoadedPack = {
    id: "acct",
    version: "1.0.0",
    scanners: [
      {
        id: "account",
        kind: "identifying",
        disposition: "redact",
        re: /\bACCT-\d{6}\b/g,
        contextWindow: 60,
      },
    ],
  };

  it("hands the chunker redacted table cells and stores a redacted title", async () => {
    const deps = { ...makeDeps(), pack: ACCOUNT_PACK };
    const md = "| Client | Account |\n| --- | --- |\n| A | ACCT-123456 |";
    (deps.parser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: "Ledger ACCT-999999",
      markdown: md,
      tables: [
        {
          markdown: md,
          sheetName: "Sheet1",
          sheetType: "tabular",
          headers: ["Client", "Account"],
          rows: [["A", "ACCT-123456"]],
          rowCount: 1,
          columnCount: 2,
        },
      ],
      metadata: {},
    });
    const { connector } = makeConnector([
      { documents: ["ledger"], nextCursor: null, done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    const chunkerInput = (deps.chunker.chunk as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(JSON.stringify(chunkerInput)).not.toMatch(/ACCT-\d{6}/);
    expect(upsertDocumentMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ title: "Ledger [REDACTED-ACCT]" }),
    );
  });
});

describe("a redacted document never keeps a downloadable original", () => {
  const ACCOUNT_PACK: LoadedPack = {
    id: "acct",
    version: "1.0.0",
    scanners: [
      {
        id: "account",
        kind: "identifying",
        disposition: "redact",
        re: /\bACCT-\d{6}\b/g,
        contextWindow: 60,
      },
    ],
  };

  function redactingDeps() {
    const objectStore = makeObjectStore();
    const deps = {
      ...makeDeps(),
      pack: ACCOUNT_PACK,
      objectStore,
    } as PipelineDeps;
    (deps.parser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: "Ledger",
      markdown: "Account ACCT-123456 notes",
      tables: [],
      metadata: {},
    });
    return { deps, objectStore };
  }

  it("does not upload the raw bytes and records the redaction count in metadata", async () => {
    const { deps, objectStore } = redactingDeps();
    const { connector } = makeConnector([
      { documents: ["ledger"], nextCursor: null, done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(objectStore.put).not.toHaveBeenCalled();
    expect(setDocumentStorageMock).not.toHaveBeenCalled();
    expect(upsertDocumentMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        metadata: expect.objectContaining({ redactedIdentifierCount: 1 }),
      }),
    );
  });

  it("removes an original stored by an earlier, pre-redaction run", async () => {
    clearDocumentStorageMock.mockResolvedValue({
      storageKey: "sources/src/ledger",
    });
    const { deps, objectStore } = redactingDeps();
    const { connector } = makeConnector([
      { documents: ["ledger"], nextCursor: null, done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(clearDocumentStorageMock).toHaveBeenCalledWith(deps.db, "doc-1");
    expect(objectStore.delete).toHaveBeenCalledWith("sources/src/ledger");
  });
});

describe("TRI compliance scanning at ingest", () => {
  it("BLOCKS a document containing an SSN rather than ingesting and flagging it", async () => {
    // ⚠ Behaviour changed 2026-08-03 (Layer 3). This test previously asserted
    // that SSN-bearing content was INGESTED and then flagged for review. That
    // is exactly what allowed 858 documents — including a spreadsheet with 522
    // SSN-shaped values — to be chunked, embedded, and sent to a third-party
    // API. Flagging after the fact does not undo a disclosure.
    //
    // The document is now quarantined before any of that, AND a durable audit
    // event is written: preventing the disclosure without recording that the
    // pipeline saw sensitive content would destroy the compliance evidence.
    const deps = makeDeps();
    (deps.parser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: "client-return",
      markdown: "Client SSN: 123-45-6789. Total income: $150,000.",
      tables: [],
      metadata: {},
    });
    const { connector } = makeConnector([
      { documents: ["tax-return"], nextCursor: null, done: true },
    ]);
    const result = await runIngestion("src-id", connector, null, OPTS, deps);

    // Nothing was indexed.
    expect(result.chunksCreated).toBe(0);
    expect(logIngestEventMock).not.toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ action: "ingested" }),
    );

    // But the event is recorded, escalated to Class D by the identifier.
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sourceId: "src-id",
        action: "blocked",
        docClass: "D",
        rejectionReason: expect.stringContaining("identifier-found"),
      }),
    );
  });

  it("does NOT log tri-flagged for clean documents", async () => {
    // makeDeps returns "# filename\n\nbody" — no TRI patterns.
    const deps = makeDeps();
    const { connector } = makeConnector([
      { documents: ["clean-doc"], nextCursor: null, done: true },
    ]);
    await runIngestion("src-id", connector, null, OPTS, deps);

    // Only the "ingested" event — no tri-flagged.
    expect(logIngestEventMock).toHaveBeenCalledOnce();
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ action: "ingested" }),
    );
  });
});
