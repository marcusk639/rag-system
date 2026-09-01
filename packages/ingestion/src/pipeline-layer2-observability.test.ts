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
import { runIngestion, type PipelineDeps } from "./pipeline.js";

/**
 * Layer 2 (structural path exclusion) is described as the cheapest and most
 * reliable guard, but it reads `source.metadata.path` — which only the
 * SharePoint connector populates. Everywhere else it evaluates undefined,
 * returns not-excluded, and the document proceeds, indistinguishable in the
 * logs from one that was checked and cleared. A guard that cannot run must say
 * so; silence reads as protection.
 *
 * This is a separate file from `pipeline.test.ts` (rather than an added
 * describe block there) purely to stay under this repo's 800-line-per-file
 * hard cap (`.claude/rules/quality-gates.md`) — the same reason
 * `pipeline-empty-pack.test.ts` is split out. The mocking setup below mirrors
 * that file's.
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
  ],
};

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

interface FakePage {
  documents: string[];
  nextCursor: string | null;
  done: boolean;
}

/** A connector that hands back a fixed sequence of pages, one per list() call. */
function makeConnector(pages: FakePage[]) {
  let i = 0;
  const connector = {
    kind: "custom",
    validate: vi.fn(),
    fetch: vi.fn(),
    list: vi.fn(async (): Promise<ConnectorListResult> => {
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
      };
    }),
  };
  return { connector: connector as unknown as Connector };
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
});

describe("Layer 2 observability when path metadata is absent", () => {
  // Structural exclusion is described as "the cheapest and most reliable
  // guard", but it reads `source.metadata.path`, and ONLY the SharePoint
  // connector sets that field. On gdrive, gmail, outlook, git-markdown, ecfr
  // and custom sources the guard evaluates undefined, returns not-excluded, and
  // the document proceeds — indistinguishable in the logs from a document that
  // was actually checked and cleared.
  //
  // A guard that cannot run must say so. Silence here reads as protection.
  function warnMarkers(deps: PipelineDeps, warn: ReturnType<typeof vi.fn>) {
    void deps;
    return warn.mock.calls.map(
      (c) => (c[0] as { marker?: string } | undefined)?.marker,
    );
  }

  it("warns that Layer 2 could not evaluate when path is missing", async () => {
    const deps = makeDeps();
    const warn = vi.fn();
    (deps.logger as unknown as Record<string, unknown>).warn = warn;
    (deps.logger as unknown as Record<string, unknown>).child = () =>
      deps.logger;

    const { connector } = makeConnector([
      { documents: ["doc-a"], nextCursor: null, done: true },
    ]);
    await runIngestion("src-id", connector, null, OPTS, deps);

    expect(warnMarkers(deps, warn)).toContain("ingest.path_unavailable");
  });

  it("does NOT warn when the connector supplied a path", async () => {
    const deps = makeDeps();
    const warn = vi.fn();
    (deps.logger as unknown as Record<string, unknown>).warn = warn;
    (deps.logger as unknown as Record<string, unknown>).child = () =>
      deps.logger;

    const { connector } = makeConnector([
      { documents: ["doc-a"], nextCursor: null, done: true },
    ]);
    // Give the emitted document a path, as the SharePoint connector does.
    const original = connector.list as ReturnType<typeof vi.fn>;
    (connector as unknown as Record<string, unknown>).list = vi.fn(
      async (opts: { cursor: string | null }) => {
        const page = await original(opts);
        return {
          ...page,
          documents: page.documents.map((d: { metadata: unknown }) => ({
            ...d,
            metadata: { path: "/Shared Documents/SOPs" },
          })),
        };
      },
    );
    await runIngestion("src-id", connector, null, OPTS, deps);

    expect(warnMarkers(deps, warn)).not.toContain("ingest.path_unavailable");
  });
});
