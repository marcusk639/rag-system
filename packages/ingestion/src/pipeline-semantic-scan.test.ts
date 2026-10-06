import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentScanner } from "@rag/core";
import { runIngestion } from "./pipeline.js";
import { makeConnector, makeDeps, OPTS } from "./pipeline.test-harness.js";
import type { PipelineDeps } from "./pipeline.js";

/**
 * Layer 1.5 — separate file from `pipeline.test.ts` to stay under this
 * repo's 800-line-per-file cap (`.claude/rules/quality-gates.md`), same
 * reasoning as `pipeline-empty-pack.test.ts`. Mocking setup mirrors that
 * file's; deps construction reuses the shared harness so `CLEAN_SCANNER`'s
 * behavior stays the single source of truth for "nothing flagged".
 */
const {
  updateSourceCursorMock,
  upsertDocumentMock,
  replaceChunksMock,
  documentHasChunksMock,
  documentHasStorageMock,
  setDocumentStorageMock,
  logIngestEventMock,
} = vi.hoisted(() => ({
  updateSourceCursorMock: vi.fn(),
  upsertDocumentMock: vi.fn(),
  replaceChunksMock: vi.fn(),
  documentHasChunksMock: vi.fn(),
  documentHasStorageMock: vi.fn(),
  setDocumentStorageMock: vi.fn(),
  logIngestEventMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  updateSourceCursor: updateSourceCursorMock,
  upsertDocument: upsertDocumentMock,
  replaceChunks: replaceChunksMock,
  documentHasChunks: documentHasChunksMock,
  documentHasStorage: documentHasStorageMock,
  deleteDocumentByExternalId: vi.fn(),
  setDocumentStorage: setDocumentStorageMock,
  logIngestEvent: logIngestEventMock,
  clearDocumentStorage: vi.fn().mockResolvedValue({ storageKey: null }),
  listRetryableIngestFailures: vi.fn().mockResolvedValue([]),
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
});

function testConnector() {
  const { connector } = makeConnector([
    { documents: ["doc-a"], nextCursor: "c1", done: true },
  ]);
  return connector;
}

describe("PipelineDeps.scanner — Layer 1.5 gating", () => {
  // An absent scanner means Layer 1.5 was never turned on -- the default, and
  // the state of every deployment and test that predates it. It must index
  // normally. The original contract quarantined here instead, which made
  // ingestion silently index nothing everywhere: documentsProcessed: 1,
  // documentsFailed: 0, chunksCreated: 0.
  //
  // Fail-closed is preserved where it can actually tell misconfiguration from
  // "off" -- the throwing-scanner case below -- and a provider that is set but
  // cannot be built must fail loud at startup, never arrive here as undefined.
  it("indexes normally when Layer 1.5 was never enabled", async () => {
    const deps = { ...makeDeps(), scanner: undefined } as PipelineDeps;
    await runIngestion("src", testConnector(), null, OPTS, deps);

    expect(upsertDocumentMock).toHaveBeenCalled();
    expect(replaceChunksMock).toHaveBeenCalled();
    expect(logIngestEventMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "blocked" }),
    );
  });

  it("quarantines when the scanner throws, rather than indexing unchecked", async () => {
    const throwingScanner: ContentScanner = {
      name: "fake-throwing",
      scan: async () => {
        throw new Error("model unreachable");
      },
    };
    const deps = { ...makeDeps(), scanner: throwingScanner } as PipelineDeps;
    await runIngestion("src", testConnector(), null, OPTS, deps);

    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(replaceChunksMock).not.toHaveBeenCalled();
  });

  it("quarantines a document the scanner flags as client-identifying", async () => {
    const flaggingScanner: ContentScanner = {
      name: "fake-flagging",
      scan: async () => ({
        flagged: true,
        findings: ["possible client name: John Smith"],
      }),
    };
    const deps = { ...makeDeps(), scanner: flaggingScanner } as PipelineDeps;
    await runIngestion("src", testConnector(), null, OPTS, deps);

    expect(upsertDocumentMock).not.toHaveBeenCalled();
    expect(replaceChunksMock).not.toHaveBeenCalled();
    expect(logIngestEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "blocked",
        docClass: "C",
      }),
    );
  });

  it("proceeds to chunk and embed when the scanner reports clean", async () => {
    // makeDeps() already wires CLEAN_SCANNER — this is the control that
    // proves the three tests above fail for the scanner's verdict, not
    // because something else in the pipeline broke.
    const deps = makeDeps();
    await runIngestion("src", testConnector(), null, OPTS, deps);

    expect(upsertDocumentMock).toHaveBeenCalled();
    expect(replaceChunksMock).toHaveBeenCalled();
  });
});
