import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type {
  Chunk,
  Connector,
  ConnectorListResult,
  LoadedPack,
  Parser,
} from "@rag/core";
import { ClassBlockedError } from "@rag/core";
import { FakeEmbedder, FakeObjectStore } from "@rag/test-fixtures";
import { runIngestion, ingestOne, type PipelineDeps } from "./pipeline.js";
import { DeletionReconciliationError } from "./errors.js";

/**
 * `packs/cpa/pack.yaml` exists (Task 6 authored it), but this suite builds
 * the equivalent pack in memory rather than loading it — same shape as the
 * scanners `redactText` used to hardcode. Only `ssn`/`ein` are needed: the
 * "BLOCKS a document containing an SSN" test below depends on this pack
 * actually finding the identifier, exactly as the pre-migration hardcoded
 * patterns did.
 */
const TEST_PACK: LoadedPack = {
  id: "test",
  version: "1.0.0",
  scanners: [
    {
      id: "ssn",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{3}-\d{2}-\d{4}\b/g,
      contextWindow: 60,
    },
    {
      id: "ein",
      kind: "identifying",
      disposition: "exclude",
      re: /\b\d{2}-\d{7}\b/g,
      contextWindow: 60,
    },
  ],
};

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
}));

interface FakePage {
  documents: string[]; // externalIds
  nextCursor: string | null;
  done: boolean;
  deletions?: string[];
  skippedOversize?: number;
}

/** A connector that hands back a fixed sequence of pages, one per list() call. */
function makeConnector(pages: FakePage[]) {
  const received: { cursor: string | null }[] = [];
  let i = 0;
  const connector = {
    kind: "custom",
    validate: vi.fn(),
    fetch: vi.fn(),
    list: vi.fn(
      async (opts: { cursor: string | null }): Promise<ConnectorListResult> => {
        received.push({ cursor: opts.cursor });
        const page = pages[Math.min(i, pages.length - 1)];
        if (!page) throw new Error("makeConnector: no page configured");
        i++;
        return {
          documents: page.documents.map((externalId) => ({
            externalId,
            title: externalId,
            modifiedAt: new Date().toISOString(),
            mimeType: "text/plain",
            content: Buffer.from(`content-${externalId}`),
            metadata: {},
          })),
          nextCursor: page.nextCursor,
          done: page.done,
          deletions: page.deletions,
          skippedOversize: page.skippedOversize,
        };
      },
    ),
  };
  return { connector: connector as unknown as Connector, received };
}

function makeDeps(): PipelineDeps {
  // Layer 3 (2026-08-03) made an undeclared source class fail CLOSED to "D",
  // so every document quarantines unless the caller declares a class. These
  // tests previously relied on the implicit `?? "A"` public default — the same
  // implicit default that let 858 unclassified documents into a public index.
  // Declaring it here keeps the tests' intent and makes the dependency visible.
  const parser: Parser = {
    parse: vi.fn(async ({ filename }) => ({
      title: String(filename),
      markdown: `# ${filename}\n\nbody`,
      tables: [],
      metadata: {},
    })),
  } as unknown as Parser;

  const chunk: Chunk = {
    hash: "h",
    text: "t",
    tokenCount: 1,
    ordinal: 0,
    headingPath: [],
  };
  const chunker = {
    chunk: vi.fn(async (): Promise<Chunk[]> => [chunk]),
  } as unknown as PipelineDeps["chunker"];

  const embedder = new FakeEmbedder();

  const noop = () => undefined;
  const logger = {
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    child: () => logger,
  } as unknown as Logger;

  return {
    sourceDocClass: "A",
    db: {} as PipelineDeps["db"],
    parser,
    chunker,
    embedder,
    logger,
    pack: TEST_PACK,
  };
}

const OPTS = { concurrency: 2, pageSize: 50 };

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
      runIngestion("src", makeConnector([page]).connector, "c0", OPTS, makeDeps()),
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

function makeObjectStore() {
  const store = new FakeObjectStore(new Map());
  vi.spyOn(store, "put");
  vi.spyOn(store, "delete");
  return store as FakeObjectStore & {
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

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
