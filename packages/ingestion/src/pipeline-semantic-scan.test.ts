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
  deleteDocumentByExternalIdMock,
} = vi.hoisted(() => ({
  updateSourceCursorMock: vi.fn(),
  upsertDocumentMock: vi.fn(),
  replaceChunksMock: vi.fn(),
  documentHasChunksMock: vi.fn(),
  documentHasStorageMock: vi.fn(),
  setDocumentStorageMock: vi.fn(),
  logIngestEventMock: vi.fn(),
  deleteDocumentByExternalIdMock: vi.fn(),
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
  deleteDocumentByExternalIdMock.mockResolvedValue({
    deleted: false,
    storageKey: null,
  });
});

/** Captures what Layer 1.5 was actually handed. */
function recordingScanner(
  verdict = { flagged: false, findings: [] as string[] },
) {
  const seen: string[] = [];
  const scanner: ContentScanner = {
    name: "fake-recording",
    scan: async (text: string) => {
      seen.push(text);
      return verdict;
    },
  };
  return { scanner, seen };
}

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
    // The audit row is the half that matters under 7216 / Circular 230:
    // preventing the disclosure while destroying the evidence is not a pass.
    // It must also name the underlying cause -- ContentSafetyError carries a
    // fixed message and hides the real reason in `cause`, so recording
    // `err.message` alone makes every scanner failure look identical.
    expect(logIngestEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "blocked",
        rejectionReason: "gate-failure: semantic scan failed: unknown",
      }),
    );
  });

  it("purges an already-indexed copy when a scan failure quarantines the document", async () => {
    // Without this, enabling Layer 1.5 on a live index gates only future
    // writes: a document indexed earlier keeps its chunks and stays
    // retrievable while the gate reports that it caught something.
    const throwingScanner: ContentScanner = {
      name: "fake-throwing",
      scan: async () => {
        throw new Error("model unreachable");
      },
    };
    const deps = { ...makeDeps(), scanner: throwingScanner } as PipelineDeps;
    await runIngestion("src", testConnector(), null, OPTS, deps);

    expect(deleteDocumentByExternalIdMock).toHaveBeenCalledWith(
      expect.anything(),
      "src",
      "doc-a",
    );
  });

  it("scans the REDACTED text, never re-sending an identifier Layer 1 masked", async () => {
    // The redaction assignment and the scan call are adjacent and reorderable.
    // Without this assertion, moving the scan above the assignment would ship
    // every raw SSN in the corpus to the scanner endpoint -- an egress of the
    // exact values Layer 1 exists to mask -- and no test would fail.
    const { scanner, seen } = recordingScanner();
    const deps = makeDeps();
    deps.parser = {
      parse: vi.fn(async () => ({
        title: "Checklist",
        markdown: "Taxpayer SSN 123-45-6789 on file.",
        tables: [],
        metadata: {},
      })),
    } as unknown as PipelineDeps["parser"];
    await runIngestion("src", testConnector(), null, OPTS, {
      ...deps,
      scanner,
    } as PipelineDeps);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("123-45-6789");
  });

  it("scans the title and table cells, not markdown alone", async () => {
    // Layer 1 redacts all three text-bearing fields because chunks are built
    // from `tables` and the title is stored, cited, and sent to the model.
    // In this corpus a client is most often identified by exactly those two --
    // a filename-derived title, or a name in a spreadsheet cell.
    const { scanner, seen } = recordingScanner();
    const deps = makeDeps();
    deps.parser = {
      parse: vi.fn(async () => ({
        title: "Smith Family Trust 2024",
        markdown: "Generic body text.",
        tables: [
          {
            markdown: "| Client |\n| --- |\n| Jane Doe |",
            sheetName: "Trust Detail",
            sheetType: "tabular" as const,
            headers: ["Client"],
            rows: [["Jane Doe"]],
            rowCount: 1,
            columnCount: 1,
          },
        ],
        metadata: {},
      })),
    } as unknown as PipelineDeps["parser"];
    await runIngestion("src", testConnector(), null, OPTS, {
      ...deps,
      scanner,
    } as PipelineDeps);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("Smith Family Trust 2024");
    expect(seen[0]).toContain("Jane Doe");
    expect(seen[0]).toContain("Client");
    expect(seen[0]).toContain("Trust Detail");
  });

  it("quarantines a document the scanner flags as client-identifying", async () => {
    const flaggingScanner: ContentScanner = {
      name: "fake-flagging",
      // Category only, never a value: findings are persisted to the audit row
      // and logged, so a name quoted here is disclosed by the scan meant to
      // prevent its disclosure.
      scan: async () => ({
        flagged: true,
        findings: ["client name"],
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
        // The categories belong in the durable record, not only in a pino
        // warning -- the audit row is what a Gate 1 reviewer works from.
        rejectionReason: expect.stringContaining("client name"),
      }),
    );
    expect(deleteDocumentByExternalIdMock).toHaveBeenCalled();
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
