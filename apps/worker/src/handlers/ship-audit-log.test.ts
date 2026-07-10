import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLog } from "@rag/db";
import { handleShipAuditLog } from "./ship-audit-log.js";
import type { WorkerDeps } from "../deps.js";

const {
  getAuditLogShipperWatermarkMock,
  getAuditLogRowsSinceMock,
  advanceAuditLogShipperWatermarkMock,
} = vi.hoisted(() => ({
  getAuditLogShipperWatermarkMock: vi.fn(),
  getAuditLogRowsSinceMock: vi.fn(),
  advanceAuditLogShipperWatermarkMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  getAuditLogShipperWatermark: getAuditLogShipperWatermarkMock,
  getAuditLogRowsSince: getAuditLogRowsSinceMock,
  advanceAuditLogShipperWatermark: advanceAuditLogShipperWatermarkMock,
}));

function makeRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "row-1",
    principalKind: "admin",
    principalSources: null,
    principalSubject: null,
    questionHash: "hash-1",
    channel: "api",
    model: null,
    sourceIds: ["source-a"],
    chunkIds: ["chunk-1"],
    docIds: ["doc-1"],
    retrievedCount: 1,
    endpoint: "ask",
    topScore: 0.9,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  } as AuditLog;
}

function fakeLogger() {
  const l: Record<string, unknown> = {};
  l.child = () => l;
  l.info = vi.fn();
  l.warn = vi.fn();
  l.error = vi.fn();
  l.debug = vi.fn();
  return l;
}

function makeDeps(auditLogSink: WorkerDeps["auditLogSink"]): WorkerDeps {
  return {
    db: {},
    logger: fakeLogger(),
    auditLogSink,
  } as unknown as WorkerDeps;
}

function fakeJob(id: string) {
  return { id } as unknown as Parameters<typeof handleShipAuditLog>[0];
}

describe("handleShipAuditLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops (never queries the watermark) when auditLogSink is null (AUDIT_SINK_PROVIDER=none)", async () => {
    const deps = makeDeps(null);

    await handleShipAuditLog(fakeJob("job-1"), deps);

    expect(getAuditLogShipperWatermarkMock).not.toHaveBeenCalled();
    expect(getAuditLogRowsSinceMock).not.toHaveBeenCalled();
  });

  it("ships rows created since the watermark and advances the watermark to the last row's createdAt", async () => {
    const ship = vi.fn().mockResolvedValue(undefined);
    const rows = [
      makeRow({ id: "1", createdAt: new Date("2026-07-01T00:00:00Z") }),
      makeRow({ id: "2", createdAt: new Date("2026-07-02T00:00:00Z") }),
    ];
    const watermark = new Date("2026-06-30T00:00:00Z");
    getAuditLogShipperWatermarkMock.mockResolvedValue(watermark);
    getAuditLogRowsSinceMock.mockResolvedValue(rows);
    const deps = makeDeps({ ship });

    await handleShipAuditLog(fakeJob("job-2"), deps);

    expect(getAuditLogRowsSinceMock).toHaveBeenCalledWith(deps.db, watermark);
    expect(ship).toHaveBeenCalledTimes(1);
    expect(ship).toHaveBeenCalledWith(rows);
    expect(advanceAuditLogShipperWatermarkMock).toHaveBeenCalledWith(
      deps.db,
      new Date("2026-07-02T00:00:00Z"),
    );
  });

  it("does not ship or advance the watermark when there are no new rows", async () => {
    getAuditLogShipperWatermarkMock.mockResolvedValue(null);
    getAuditLogRowsSinceMock.mockResolvedValue([]);
    const ship = vi.fn();
    const deps = makeDeps({ ship });

    await handleShipAuditLog(fakeJob("job-3"), deps);

    expect(ship).not.toHaveBeenCalled();
    expect(advanceAuditLogShipperWatermarkMock).not.toHaveBeenCalled();
  });

  it("does NOT advance the watermark when ship() throws (egress rejection or network failure) -- the batch must be retried on the next tick, not silently marked complete", async () => {
    const rows = [makeRow()];
    getAuditLogShipperWatermarkMock.mockResolvedValue(null);
    getAuditLogRowsSinceMock.mockResolvedValue(rows);
    const ship = vi.fn().mockRejectedValue(new Error("egress blocked"));
    const deps = makeDeps({ ship });

    await expect(handleShipAuditLog(fakeJob("job-4"), deps)).rejects.toThrow(
      "egress blocked",
    );

    expect(advanceAuditLogShipperWatermarkMock).not.toHaveBeenCalled();
  });
});
