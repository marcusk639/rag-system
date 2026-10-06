import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { runIngestion } from "./pipeline.js";
import { makeDeps, OPTS } from "./pipeline.test-harness.js";
import type { Connector } from "@rag/core";

/**
 * What the ingestion logger is allowed to STAMP on every line.
 *
 * `logger.child(bindings)` bindings are repeated on every subsequent record,
 * including the Layer 1.5 "this document names a client" warning. The raw
 * document title is the unredacted source filename, and in this corpus a
 * filename is routinely the client name ("Smith Family Trust 2024.docx"), so
 * binding it means the log line announcing that a document identifies a
 * client also says WHO — in the one place the detection was supposed to keep
 * it out of. `externalId` is already the correlation key.
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

/** The document title under test: a filename that IS the client's name. */
const CLIENT_FILENAME = "Brightwater Holdings 2024 Engagement Letter.docx";

/** Correlation key, deliberately carrying none of the title's text so an
 * assertion that the title did not leak cannot be satisfied (or defeated) by
 * the externalId binding. The shared `makeConnector` sets `title: externalId`,
 * which would make exactly that confusion possible. */
const EXTERNAL_ID = "doc-1";

/** One-page connector whose single document has a title DISTINCT from its
 * externalId. */
function titledConnector(externalId: string, title: string): Connector {
  let served = false;
  return {
    kind: "custom",
    validate: vi.fn(),
    fetch: vi.fn(),
    list: vi.fn(async () => {
      const documents = served
        ? []
        : [
            {
              externalId,
              title,
              modifiedAt: new Date().toISOString(),
              mimeType: "text/plain",
              content: Buffer.from("A generic filing checklist."),
              metadata: {},
            },
          ];
      served = true;
      return { documents, nextCursor: "c1", done: true };
    }),
  } as unknown as Connector;
}

/** A logger that records every `child()` binding object it is handed. */
function recordingLogger() {
  const bindings: Record<string, unknown>[] = [];
  const noop = () => undefined;
  const make = (): Logger =>
    ({
      info: noop,
      error: noop,
      warn: noop,
      debug: noop,
      child: (b: Record<string, unknown>) => {
        bindings.push(b);
        return make();
      },
    }) as unknown as Logger;
  return { logger: make(), bindings };
}

describe("ingestion logger child bindings", () => {
  it("does not bind the raw document title", async () => {
    const { logger, bindings } = recordingLogger();
    const deps = { ...makeDeps(), logger };
    const connector = titledConnector(EXTERNAL_ID, CLIENT_FILENAME);

    await runIngestion("src-1", connector, null, OPTS, deps);

    expect(bindings.length).toBeGreaterThan(0);
    for (const b of bindings) {
      expect(b).not.toHaveProperty("title");
    }
    expect(JSON.stringify(bindings)).not.toContain("Brightwater");
  });

  it("still binds externalId as the correlation key", async () => {
    // Dropping the title must not leave the records uncorrelatable — that
    // would trade one defect for another.
    const { logger, bindings } = recordingLogger();
    const deps = { ...makeDeps(), logger };
    const connector = titledConnector("doc-42", CLIENT_FILENAME);

    await runIngestion("src-1", connector, null, OPTS, deps);

    expect(bindings.some((b) => b.externalId === "doc-42")).toBe(true);
  });
});
