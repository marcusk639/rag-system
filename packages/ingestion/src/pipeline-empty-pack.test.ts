import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type {
  Chunk,
  Connector,
  ConnectorListResult,
  LoadedPack,
  Parser,
} from "@rag/core";
import { FakeEmbedder } from "@rag/test-fixtures";
import { runIngestion, ingestOne, type PipelineDeps } from "./pipeline.js";

/**
 * Fix (HIGH, whole-branch review): `LoadedPack` is an exported,
 * structurally-constructible interface, so a pack with `scanners: []`
 * passes `!deps.pack` (the pack IS truthy) at both existing missing-pack
 * guards in pipeline.ts. Before this fix such a pack made `scanText` loop
 * zero times, `applyRedaction` return the input verbatim, and `findings`
 * stay empty — raw SSNs would reach the embedding provider on a run every
 * guard reported as healthy. Both guards (the `runIngestion` entry check
 * and the `ingestOne` backstop) must treat an empty-scanner pack exactly
 * like a missing one.
 *
 * This is a separate file from `pipeline.test.ts` (rather than an added
 * describe block there) purely to stay under this repo's 800-line-per-file
 * hard cap (`.claude/rules/quality-gates.md`) — `pipeline.test.ts` was
 * already at 783 lines. The mocking setup below mirrors that file's.
 */
const EMPTY_PACK: LoadedPack = { id: "empty", version: "1.0.0", scanners: [] };

const {
  updateSourceCursorMock,
  upsertDocumentMock,
  replaceChunksMock,
  documentHasChunksMock,
  documentHasStorageMock,
  deleteDocumentByExternalIdMock,
  setDocumentStorageMock,
  logIngestEventMock,
} = vi.hoisted(() => ({
  updateSourceCursorMock: vi.fn(),
  upsertDocumentMock: vi.fn(),
  replaceChunksMock: vi.fn(),
  documentHasChunksMock: vi.fn(),
  documentHasStorageMock: vi.fn(),
  deleteDocumentByExternalIdMock: vi.fn(),
  setDocumentStorageMock: vi.fn(),
  logIngestEventMock: vi.fn(),
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
}));

function makeConnector() {
  const connector = {
    kind: "custom",
    validate: vi.fn(),
    fetch: vi.fn(),
    list: vi.fn(async (): Promise<ConnectorListResult> => ({
      documents: [
        {
          externalId: "doc-1",
          title: "doc-1",
          modifiedAt: new Date().toISOString(),
          mimeType: "text/plain",
          content: Buffer.from("content-doc-1"),
          metadata: {},
        },
      ],
      nextCursor: null,
      done: true,
    })),
  };
  return connector as unknown as Connector;
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
    embedder: new FakeEmbedder(),
    logger,
    pack: EMPTY_PACK,
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
  logIngestEventMock.mockResolvedValue(undefined);
});

describe("PipelineDeps.pack — an empty-scanner pack is treated as unconfigured", () => {
  it("runIngestion REJECTS when the pack declares no scanners, before touching the connector or the db", async () => {
    const deps = makeDeps();
    const connector = makeConnector();

    await expect(
      runIngestion("src-id", connector, null, OPTS, deps),
    ).rejects.toThrow(/PipelineDeps\.pack is not configured/);

    expect(connector.list).not.toHaveBeenCalled();
    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(replaceChunksMock).not.toHaveBeenCalled();
    expect(logIngestEventMock).not.toHaveBeenCalled();
  });

  it("ingestOne does NOT allow a document through when called directly with an empty-scanner pack — it quarantines with an audit row", async () => {
    const deps = makeDeps();
    const source = {
      externalId: "doc-1",
      title: "doc-1",
      modifiedAt: new Date().toISOString(),
      mimeType: "text/plain",
      content: Buffer.from("content-doc-1"),
      metadata: {},
    };

    const result = await ingestOne("src-id", source, deps, "A");

    // Nothing was indexed: no chunks, no upsert — same as the missing-pack case.
    expect(result.chunksCreated).toBe(0);
    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(replaceChunksMock).not.toHaveBeenCalled();
    expect(logIngestEventMock).not.toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({ action: "ingested" }),
    );
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
});
