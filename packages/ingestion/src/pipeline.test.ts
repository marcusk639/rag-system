import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  runIngestion,
  CONTENT_PROCESSING_VERSION,
  type PipelineDeps,
} from "./pipeline.js";
import { DeletionReconciliationError } from "./errors.js";
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

describe("runIngestion page budgeting", () => {
  it("maxPagesPerRun:1 processes exactly one page and reports done:false when the feed continues", async () => {
    const { connector, received } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: false },
      { documents: ["b"], nextCursor: "c2", done: true },
    ]);

    const result = await runIngestion(
      "src",
      connector,
      null,
      {
        ...OPTS,
        maxPagesPerRun: 1,
      },
      makeDeps(),
    );

    expect(connector.list).toHaveBeenCalledTimes(1);
    expect(received[0]?.cursor).toBeNull();
    expect(result.documentsProcessed).toBe(1);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toBe("c1");
    // cursor persisted once, for the single page processed
    expect(updateSourceCursorMock).toHaveBeenCalledTimes(1);
    expect(updateSourceCursorMock).toHaveBeenCalledWith({}, "src", "c1");
  });

  it("a fake connector returning done:false then done:true completes the source across two runIngestion calls, cursor advancing each call", async () => {
    const { connector, received } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: false },
      { documents: ["b"], nextCursor: "c2", done: true },
    ]);
    const deps = makeDeps();

    const first = await runIngestion(
      "src",
      connector,
      null,
      {
        ...OPTS,
        maxPagesPerRun: 1,
      },
      deps,
    );
    expect(first.done).toBe(false);
    expect(first.nextCursor).toBe("c1");

    // The continuation resumes from the persisted cursor.
    const second = await runIngestion(
      "src",
      connector,
      first.nextCursor,
      {
        ...OPTS,
        maxPagesPerRun: 1,
      },
      deps,
    );
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBe("c2");

    expect(connector.list).toHaveBeenCalledTimes(2);
    expect(received[0]?.cursor).toBeNull();
    expect(received[1]?.cursor).toBe("c1"); // advanced
    expect(first.documentsProcessed + second.documentsProcessed).toBe(2);
  });

  it("a single-page source (done:true on first page) completes in one call — no behavior change", async () => {
    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    const result = await runIngestion(
      "src",
      connector,
      null,
      {
        ...OPTS,
        maxPagesPerRun: 1,
      },
      makeDeps(),
    );

    expect(connector.list).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(true);
    expect(result.documentsProcessed).toBe(1);
  });

  it("defaults to unbounded: drains every page in a single call (historical behavior)", async () => {
    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: false },
      { documents: ["b", "c"], nextCursor: "c2", done: true },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, makeDeps());

    expect(connector.list).toHaveBeenCalledTimes(2);
    expect(result.done).toBe(true);
    expect(result.documentsProcessed).toBe(3);
    expect(updateSourceCursorMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT terminate on an empty page when done is still false (only done ends the feed)", async () => {
    const { connector } = makeConnector([
      { documents: [], nextCursor: "c1", done: false },
      { documents: ["a"], nextCursor: "c2", done: true },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, makeDeps());

    expect(connector.list).toHaveBeenCalledTimes(2);
    expect(result.done).toBe(true);
    expect(result.documentsProcessed).toBe(1);
  });
});

describe("content hash carries the processing version", () => {
  it("hashes the markdown together with CONTENT_PROCESSING_VERSION so a chunking change re-embeds unchanged documents", async () => {
    const deps = makeDeps();
    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: null, done: true },
    ]);
    await runIngestion("src", connector, null, OPTS, deps);

    const markdown = "# a\n\nbody";
    const expected = createHash("sha256")
      .update(`v${CONTENT_PROCESSING_VERSION}\n${markdown}`)
      .digest("hex");
    expect(upsertDocumentMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ contentHash: expected }),
    );
    expect(CONTENT_PROCESSING_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("ingestOne unchanged-hash handling", () => {
  it("skips chunk/embed when the hash is unchanged AND the document already has chunks", async () => {
    upsertDocumentMock.mockResolvedValue({
      id: "doc-1",
      contentChanged: false,
    });
    documentHasChunksMock.mockResolvedValue(true);

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, makeDeps());

    expect(documentHasChunksMock).toHaveBeenCalledWith({}, "doc-1");
    expect(replaceChunksMock).not.toHaveBeenCalled();
  });

  it("re-embeds when the hash is unchanged but the document has NO chunks (prior embed-failure straggler)", async () => {
    upsertDocumentMock.mockResolvedValue({
      id: "doc-1",
      contentChanged: false,
    });
    documentHasChunksMock.mockResolvedValue(false);

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, makeDeps());

    expect(documentHasChunksMock).toHaveBeenCalledWith({}, "doc-1");
    // The straggler must be re-chunked + re-embedded rather than skipped forever.
    expect(replaceChunksMock).toHaveBeenCalledTimes(1);
  });
});

describe("runIngestion deletion reconciliation + skip observability", () => {
  it("reconciles tombstones: deletes each reported document and counts removals", async () => {
    const { connector } = makeConnector([
      {
        documents: ["a"],
        deletions: ["drive1:gone1", "drive1:gone2"],
        skippedOversize: 3,
        nextCursor: "c1",
        done: true,
      },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, makeDeps());

    expect(deleteDocumentByExternalIdMock).toHaveBeenCalledTimes(2);
    expect(deleteDocumentByExternalIdMock).toHaveBeenCalledWith(
      {},
      "src",
      "drive1:gone1",
    );
    expect(result.documentsDeleted).toBe(2);
    expect(result.documentsSkippedOversize).toBe(3);
    expect(result.documentsProcessed).toBe(1);
  });

  it("only counts deletions that actually removed a row", async () => {
    deleteDocumentByExternalIdMock.mockResolvedValueOnce({
      deleted: true,
      storageKey: null,
    });
    deleteDocumentByExternalIdMock.mockResolvedValueOnce({
      deleted: false,
      storageKey: null,
    }); // already absent

    const { connector } = makeConnector([
      {
        documents: [],
        deletions: ["drive1:gone1", "drive1:never-existed"],
        nextCursor: "c1",
        done: true,
      },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, makeDeps());

    expect(result.documentsDeleted).toBe(1);
  });

  it("a failed deletion still ingests the page's documents but does NOT persist the cursor, so the tombstone is retried", async () => {
    // Graph delta never re-sends a tombstone once the caller has advanced past
    // it. Persisting the cursor after a failed delete would leave the document
    // searchable forever with no further signal. Failing the page instead makes
    // pg-boss retry from the last good cursor, which re-delivers the tombstone.
    deleteDocumentByExternalIdMock.mockRejectedValueOnce(new Error("db down"));

    const { connector } = makeConnector([
      {
        documents: ["a"],
        deletions: ["drive1:gone1"],
        nextCursor: "c1",
        done: true,
      },
    ]);

    await expect(
      runIngestion("src", connector, "c0", OPTS, makeDeps()),
    ).rejects.toThrow(DeletionReconciliationError);

    // The page's documents were still processed (idempotent on retry)…
    expect(upsertDocumentMock).toHaveBeenCalled();
    // …but the cursor was never advanced past the failed tombstone.
    expect(updateSourceCursorMock).not.toHaveBeenCalled();
  });

  it("a retried run with the same cursor completes the deletion and then advances", async () => {
    deleteDocumentByExternalIdMock.mockRejectedValueOnce(new Error("db down"));
    const page = {
      documents: [],
      deletions: ["drive1:gone1"],
      nextCursor: "c1",
      done: true,
    };

    await expect(
      runIngestion(
        "src",
        makeConnector([page]).connector,
        "c0",
        OPTS,
        makeDeps(),
      ),
    ).rejects.toThrow(DeletionReconciliationError);

    const { connector, received } = makeConnector([page]);
    const result = await runIngestion("src", connector, "c0", OPTS, makeDeps());

    expect(received[0]?.cursor).toBe("c0");
    expect(result.documentsDeleted).toBe(1);
    expect(updateSourceCursorMock).toHaveBeenCalledWith(
      expect.anything(),
      "src",
      "c1",
    );
  });

  it("removes the stored original when a tombstone has a storage key", async () => {
    deleteDocumentByExternalIdMock.mockResolvedValueOnce({
      deleted: true,
      storageKey: "sources/src/abc",
    });
    const objectStore = makeObjectStore();
    const deps = { ...makeDeps(), objectStore } as PipelineDeps;

    const { connector } = makeConnector([
      {
        documents: [],
        deletions: ["drive1:gone1"],
        nextCursor: "c1",
        done: true,
      },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(objectStore.delete).toHaveBeenCalledWith("sources/src/abc");
  });
});

describe("runIngestion original-bytes storage", () => {
  it("uploads the original and records its location on content change", async () => {
    const objectStore = makeObjectStore();
    const deps = { ...makeDeps(), objectStore } as PipelineDeps;

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(objectStore.put).toHaveBeenCalledTimes(1);
    expect(setDocumentStorageMock).toHaveBeenCalledTimes(1);
    expect(setDocumentStorageMock.mock.calls[0]![2]).toMatchObject({
      storageBucket: "test-bucket",
    });
  });

  it("does NOT re-upload when content is unchanged and storage is already recorded", async () => {
    upsertDocumentMock.mockResolvedValue({
      id: "doc-1",
      contentChanged: false,
    });
    documentHasChunksMock.mockResolvedValue(true);
    documentHasStorageMock.mockResolvedValue(true);
    const objectStore = makeObjectStore();
    const deps = { ...makeDeps(), objectStore } as PipelineDeps;

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(objectStore.put).not.toHaveBeenCalled();
    expect(setDocumentStorageMock).not.toHaveBeenCalled();
  });

  it("re-uploads when content is unchanged but storage was never recorded (self-heals a prior interrupted/failed upload)", async () => {
    upsertDocumentMock.mockResolvedValue({
      id: "doc-1",
      contentChanged: false,
    });
    documentHasChunksMock.mockResolvedValue(true);
    documentHasStorageMock.mockResolvedValue(false);
    const objectStore = makeObjectStore();
    const deps = { ...makeDeps(), objectStore } as PipelineDeps;

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(objectStore.put).toHaveBeenCalledTimes(1);
    expect(setDocumentStorageMock).toHaveBeenCalledTimes(1);
  });

  it("a storage upload failure does not fail text ingestion", async () => {
    const objectStore = makeObjectStore();
    objectStore.put.mockRejectedValueOnce(new Error("s3 down"));
    const deps = { ...makeDeps(), objectStore } as PipelineDeps;

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, deps);

    // Document still processed (searchable); storage location not recorded.
    expect(result.documentsProcessed).toBe(1);
    expect(setDocumentStorageMock).not.toHaveBeenCalled();
  });
});

describe("failed documents are recorded and retried", () => {
  it("records a document that fails to ingest as action=failed", async () => {
    const deps = makeDeps();
    (deps.parser.parse as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("parser 503"), { name: "ParserError" }),
    );
    const { connector } = makeConnector([
      { documents: ["flaky"], nextCursor: "c1", done: true },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, deps);

    expect(result.documentsFailed).toBe(1);
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sourceId: "src",
        externalId: "flaky",
        action: "failed",
        rejectionReason: expect.stringContaining("ParserError"),
      }),
    );
  });

  it("with retryFailed, re-fetches and re-ingests earlier failures before listing new pages", async () => {
    listRetryableIngestFailuresMock.mockResolvedValue(["flaky"]);
    const deps = makeDeps();
    const { connector } = makeConnector([
      { documents: [], nextCursor: "c1", done: true },
    ]);
    (connector.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      externalId: "flaky",
      title: "flaky",
      modifiedAt: new Date().toISOString(),
      mimeType: "text/plain",
      content: Buffer.from("content"),
      metadata: {},
    });

    const result = await runIngestion(
      "src",
      connector,
      "c0",
      { ...OPTS, retryFailed: true },
      deps,
    );

    expect(connector.fetch).toHaveBeenCalledWith("flaky");
    expect(upsertDocumentMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ externalId: "flaky" }),
    );
    expect(result.documentsRetried).toBe(1);
  });

  it("records another failed attempt when the retry fails too", async () => {
    listRetryableIngestFailuresMock.mockResolvedValue(["gone"]);
    const deps = makeDeps();
    const { connector } = makeConnector([
      { documents: [], nextCursor: "c1", done: true },
    ]);
    (connector.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("404"),
    );

    const result = await runIngestion(
      "src",
      connector,
      "c0",
      { ...OPTS, retryFailed: true },
      deps,
    );

    expect(result.documentsRetried).toBe(0);
    expect(logIngestEventMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ externalId: "gone", action: "failed" }),
    );
  });

  it("does not retry unless asked (continuation jobs)", async () => {
    listRetryableIngestFailuresMock.mockResolvedValue(["flaky"]);
    const { connector } = makeConnector([
      { documents: [], nextCursor: "c1", done: true },
    ]);
    await runIngestion("src", connector, "c0", OPTS, makeDeps());
    expect(listRetryableIngestFailuresMock).not.toHaveBeenCalled();
    expect(connector.fetch).not.toHaveBeenCalled();
  });
});
