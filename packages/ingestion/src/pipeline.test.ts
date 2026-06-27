import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { Chunk, Connector, ConnectorListResult, Parser } from "@rag/core";
import { ClassBlockedError } from "@rag/core";
import { FakeEmbedder, FakeObjectStore } from "@rag/test-fixtures";
import { runIngestion, type PipelineDeps } from "./pipeline.js";

// Mock the @rag/db sinks so the pipeline's control flow (page loop, cursor
// persistence, done reporting) can be tested without a live Postgres.
const {
  updateSourceCursorMock,
  upsertDocumentMock,
  replaceChunksMock,
  documentHasChunksMock,
  deleteDocumentByExternalIdMock,
  setDocumentStorageMock,
} = vi.hoisted(() => ({
  updateSourceCursorMock: vi.fn(),
  upsertDocumentMock: vi.fn(),
  replaceChunksMock: vi.fn(),
  documentHasChunksMock: vi.fn(),
  deleteDocumentByExternalIdMock: vi.fn(),
  setDocumentStorageMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  updateSourceCursor: updateSourceCursorMock,
  upsertDocument: upsertDocumentMock,
  replaceChunks: replaceChunksMock,
  documentHasChunks: documentHasChunksMock,
  deleteDocumentByExternalId: deleteDocumentByExternalIdMock,
  setDocumentStorage: setDocumentStorageMock,
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

  return { db: {} as PipelineDeps["db"], parser, chunker, embedder, logger };
}

const OPTS = { concurrency: 2, pageSize: 50 };

beforeEach(() => {
  vi.clearAllMocks();
  upsertDocumentMock.mockResolvedValue({ id: "doc-1", contentChanged: true });
  replaceChunksMock.mockResolvedValue(undefined);
  updateSourceCursorMock.mockResolvedValue(undefined);
  documentHasChunksMock.mockResolvedValue(true);
  deleteDocumentByExternalIdMock.mockResolvedValue({
    deleted: true,
    storageKey: null,
  });
  setDocumentStorageMock.mockResolvedValue(undefined);
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

  it("a failed deletion is logged and does not abort the sync", async () => {
    deleteDocumentByExternalIdMock.mockRejectedValueOnce(new Error("db down"));

    const { connector } = makeConnector([
      {
        documents: ["a"],
        deletions: ["drive1:gone1"],
        nextCursor: "c1",
        done: true,
      },
    ]);

    const result = await runIngestion("src", connector, null, OPTS, makeDeps());

    // The document on the same page still ingests; the run completes.
    expect(result.documentsProcessed).toBe(1);
    expect(result.documentsDeleted).toBe(0);
    expect(result.done).toBe(true);
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

  it("does NOT re-upload when content is unchanged", async () => {
    upsertDocumentMock.mockResolvedValue({
      id: "doc-1",
      contentChanged: false,
    });
    documentHasChunksMock.mockResolvedValue(true);
    const objectStore = makeObjectStore();
    const deps = { ...makeDeps(), objectStore } as PipelineDeps;

    const { connector } = makeConnector([
      { documents: ["a"], nextCursor: "c1", done: true },
    ]);

    await runIngestion("src", connector, null, OPTS, deps);

    expect(objectStore.put).not.toHaveBeenCalled();
    expect(setDocumentStorageMock).not.toHaveBeenCalled();
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
});
