import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClassBlockedError } from "@rag/core";
import type { Db } from "@rag/db";
import type { Logger } from "pino";

const { logIngestEventMock, invalidateMock } = vi.hoisted(() => ({
  logIngestEventMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  logIngestEvent: logIngestEventMock,
  invalidateDocumentContentHash: invalidateMock,
  listRetryableIngestFailures: vi.fn(),
}));

const { recordIngestFailure } = await import("./failed-documents.js");

const db = {} as Db;
const log = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
const row = {
  sourceId: "00000000-0000-0000-0000-000000000001",
  externalId: "doc-1",
  docClass: "A" as const,
};

describe("recordIngestFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logIngestEventMock.mockResolvedValue(undefined);
    invalidateMock.mockResolvedValue(undefined);
  });

  it("invalidates the stored content hash so the next run re-embeds instead of serving the previous version's chunks", async () => {
    await recordIngestFailure(db, log, row, new Error("503 UNAVAILABLE"));
    expect(invalidateMock).toHaveBeenCalledWith(
      db,
      row.sourceId,
      row.externalId,
    );
    expect(logIngestEventMock).toHaveBeenCalled();
  });

  it("still records the failure when invalidation itself fails", async () => {
    invalidateMock.mockRejectedValue(new Error("db down"));
    await recordIngestFailure(db, log, row, new Error("boom"));
    expect(logIngestEventMock).toHaveBeenCalled();
  });

  it("leaves class blocks alone", async () => {
    await recordIngestFailure(
      db,
      log,
      row,
      new ClassBlockedError("C", row.sourceId),
    );
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
