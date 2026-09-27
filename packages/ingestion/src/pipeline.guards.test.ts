import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIngestion, ingestOne } from "./pipeline.js";
import { makeConnector, makeDeps, OPTS } from "./pipeline.test-harness.js";

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

describe("runIngestion — fails closed at ENTRY when unconfigured", () => {
  // `pack` is typed optional on PipelineDeps so its omission fails at runtime
  // rather than compile time — which is what protects JS callers and the
  // `as any` deps objects tests build. A missing pack is a CONFIGURATION
  // gap, not a property of any one document, so `runIngestion` must detect
  // it ONCE, up front, and reject the whole run loudly — never silently
  // quarantine every document one-by-one as if each had its own problem.
  // Concretely: quarantining per-document meant an 858-document source
  // completed GREEN as `{documentsProcessed: 858, documentsFailed: 0,
  // chunksCreated: 0}` while writing 858 misleading "blocked" ingest_log
  // rows — exactly the shape a compliance query would misread as "the
  // pipeline saw sensitive content in 858 documents" rather than "nobody
  // wired a pack in".
  it("REJECTS when no pack is supplied, before touching the connector or the db", async () => {
    const deps = { ...makeDeps(), pack: undefined };
    const { connector } = makeConnector([
      { documents: ["doc-1"], nextCursor: null, done: true },
    ]);

    await expect(
      runIngestion("src-id", connector, null, OPTS, deps),
    ).rejects.toThrow(/PipelineDeps\.pack is not configured/);

    // No per-document work happened at all: the check runs before the
    // connector is ever asked to list a page.
    expect(connector.list).not.toHaveBeenCalled();
    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(replaceChunksMock).not.toHaveBeenCalled();
    // No ingest_log row of ANY kind — not even "blocked" — because a
    // configuration gap is not evidence about any document.
    expect(logIngestEventMock).not.toHaveBeenCalled();
  });
});

describe("ingestOne — missing-pack guard as defence-in-depth", () => {
  // `runIngestion` now catches a missing pack once at the top of the run
  // (see the describe block above), but `ingestOne` keeps its own guard so
  // it still fails CLOSED — quarantine, not raw index — if it is ever
  // invoked directly rather than through `runIngestion`. This test calls
  // `ingestOne` directly (exported for exactly this reason) to keep that
  // backstop covered now that `runIngestion` no longer reaches it via a
  // whole-run missing-pack path.
  it("quarantines the document AND writes a durable ingest_log audit row when called directly with no pack", async () => {
    const deps = { ...makeDeps(), pack: undefined };
    const source = {
      externalId: "doc-1",
      title: "doc-1",
      modifiedAt: new Date().toISOString(),
      mimeType: "text/plain",
      content: Buffer.from("content-doc-1"),
      metadata: {},
    };

    const result = await ingestOne("src-id", source, deps, "A");

    // Nothing was indexed: no chunks, no upsert.
    expect(result.chunksCreated).toBe(0);
    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(replaceChunksMock).not.toHaveBeenCalled();
    expect(logIngestEventMock).not.toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ action: "ingested" }),
    );
    // The durable audit row, naming the missing-pack cause specifically.
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sourceId: "src-id",
        docId: null,
        externalId: "doc-1",
        action: "blocked",
        rejectionReason: expect.stringContaining("no identifier-scanner pack"),
      }),
    );
  });

  it("distinguishes a genuine redaction failure from a missing pack in the audit row", async () => {
    // Same catch block, different cause: a reader of ingest_log must be able
    // to tell "no pack was configured" (a config gap) apart from "redaction
    // threw on this document" (something about this document's content).
    const deps = makeDeps();
    (deps.parser.parse as ReturnType<typeof vi.fn>).mockResolvedValue({
      title: "broken",
      markdown: null as unknown as string,
      tables: [],
      metadata: {},
    });
    const { connector } = makeConnector([
      { documents: ["doc-1"], nextCursor: null, done: true },
    ]);
    const result = await runIngestion("src-id", connector, null, OPTS, deps);

    expect(result.chunksCreated).toBe(0);
    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sourceId: "src-id",
        docId: null,
        action: "blocked",
        rejectionReason: expect.stringContaining(
          "redaction threw while processing this document",
        ),
      }),
    );
  });
});
