import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaleDocument } from "@rag/db";
import {
  aggregateStaleDocuments,
  handleStalenessSweep,
} from "./staleness-sweep.js";
import type { WorkerDeps } from "../deps.js";

const { getStaleDocumentsMock } = vi.hoisted(() => ({
  getStaleDocumentsMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  getStaleDocuments: getStaleDocumentsMock,
}));

const MAX_AGE_DAYS = 180;

function makeRow(overrides: Partial<StaleDocument> = {}): StaleDocument {
  return {
    id: "doc-1",
    sourceId: "source-a",
    title: "Some Doc",
    lastReviewedAt: null,
    ...overrides,
  };
}

describe("aggregateStaleDocuments", () => {
  it("returns zero totals for an empty input", () => {
    const summary = aggregateStaleDocuments([], MAX_AGE_DAYS);
    expect(summary).toEqual({
      maxAgeDays: MAX_AGE_DAYS,
      totalStale: 0,
      bySource: [],
    });
  });

  it("groups stale documents by sourceId", () => {
    const rows = [
      makeRow({ id: "d1", sourceId: "source-a" }),
      makeRow({ id: "d2", sourceId: "source-a" }),
      makeRow({ id: "d3", sourceId: "source-b" }),
    ];
    const summary = aggregateStaleDocuments(rows, MAX_AGE_DAYS);
    expect(summary.totalStale).toBe(3);
    expect(summary.bySource).toHaveLength(2);
    const a = summary.bySource.find((g) => g.sourceId === "source-a");
    const b = summary.bySource.find((g) => g.sourceId === "source-b");
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it("counts never-reviewed (lastReviewedAt === null) separately from merely overdue", () => {
    const rows = [
      makeRow({ id: "d1", sourceId: "source-a", lastReviewedAt: null }),
      makeRow({
        id: "d2",
        sourceId: "source-a",
        lastReviewedAt: new Date("2020-01-01T00:00:00Z"),
      }),
    ];
    const summary = aggregateStaleDocuments(rows, MAX_AGE_DAYS);
    const a = summary.bySource.find((g) => g.sourceId === "source-a");
    expect(a?.count).toBe(2);
    expect(a?.neverReviewedCount).toBe(1);
  });

  it("stamps the configured maxAgeDays onto the summary", () => {
    const summary = aggregateStaleDocuments([], 42);
    expect(summary.maxAgeDays).toBe(42);
  });
});

describe("handleStalenessSweep", () => {
  function fakeLogger() {
    const infoMock = vi.fn();
    const l: Record<string, unknown> = {};
    l.child = () => l;
    l.info = infoMock;
    l.warn = () => undefined;
    l.error = () => undefined;
    l.debug = () => undefined;
    return { logger: l, infoMock };
  }

  function makeDeps() {
    const { logger, infoMock } = fakeLogger();
    const deps = {
      db: {},
      logger,
      config: {
        stalenessSweep: {
          maxAgeDays: MAX_AGE_DAYS,
          cron: "0 3 * * *",
          tz: "UTC",
        },
      },
    } as unknown as WorkerDeps;
    return { deps, infoMock };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries stale documents, aggregates them, and logs exactly one summary line", async () => {
    getStaleDocumentsMock.mockResolvedValue([
      makeRow({ id: "d1", sourceId: "source-a", lastReviewedAt: null }),
      makeRow({ id: "d2", sourceId: "source-b", lastReviewedAt: null }),
    ]);
    const { deps, infoMock } = makeDeps();

    await handleStalenessSweep(
      { id: "job-1" } as unknown as Parameters<typeof handleStalenessSweep>[0],
      deps,
    );

    expect(getStaleDocumentsMock).toHaveBeenCalledWith(
      {},
      { maxAgeDays: MAX_AGE_DAYS },
    );
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [payload, message] = infoMock.mock.calls[0]!;
    expect(message).toMatch(/staleness sweep/i);
    expect(payload).toMatchObject({
      marker: "docs.staleness_sweep.summary",
      totalStale: 2,
    });
  });

  it("logs a zero-count summary when nothing is stale", async () => {
    getStaleDocumentsMock.mockResolvedValue([]);
    const { deps, infoMock } = makeDeps();

    await handleStalenessSweep(
      { id: "job-2" } as unknown as Parameters<typeof handleStalenessSweep>[0],
      deps,
    );

    const [payload] = infoMock.mock.calls[0]!;
    expect(payload).toMatchObject({ totalStale: 0, bySource: [] });
  });
});
