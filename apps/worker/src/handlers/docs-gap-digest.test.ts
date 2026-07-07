import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeakResultAuditEvent } from "@rag/db";
import {
  aggregateWeakResultEvents,
  handleDocsGapDigest,
  isWeakResultEvent,
} from "./docs-gap-digest.js";
import type { WorkerDeps } from "../deps.js";

const { getWeakResultAuditEventsMock } = vi.hoisted(() => ({
  getWeakResultAuditEventsMock: vi.fn(),
}));

vi.mock("@rag/db", () => ({
  getWeakResultAuditEvents: getWeakResultAuditEventsMock,
}));

const MIN_SCORE = 0.3;

// No `questionHash`/`id`/`principalKind`/etc. here on purpose — `makeRow`
// builds exactly the `WeakResultAuditEvent` shape `getWeakResultAuditEvents`
// now returns (a narrow column projection, not a full `AuditLog` row), which
// itself proves the digest path has no `questionHash` to misuse even if it
// wanted to.
function makeRow(
  overrides: Partial<WeakResultAuditEvent> = {},
): WeakResultAuditEvent {
  return {
    sourceIds: ["source-a"],
    chunkIds: ["chunk-1"],
    retrievedCount: 1,
    endpoint: "ask",
    topScore: 0.9,
    ...overrides,
  };
}

describe("isWeakResultEvent", () => {
  it("is weak when nothing was retrieved", () => {
    expect(
      isWeakResultEvent(
        makeRow({ retrievedCount: 0, chunkIds: [], topScore: null }),
        MIN_SCORE,
      ),
    ).toBe(true);
  });

  it("is weak when chunkIds is empty even if retrievedCount is nonzero", () => {
    expect(
      isWeakResultEvent(
        makeRow({ retrievedCount: 1, chunkIds: [], topScore: 0.9 }),
        MIN_SCORE,
      ),
    ).toBe(true);
  });

  it("is weak when topScore is below minScore", () => {
    expect(isWeakResultEvent(makeRow({ topScore: 0.1 }), MIN_SCORE)).toBe(true);
  });

  it("is NOT weak when topScore is at or above minScore and results exist", () => {
    expect(isWeakResultEvent(makeRow({ topScore: 0.3 }), MIN_SCORE)).toBe(
      false,
    );
    expect(isWeakResultEvent(makeRow({ topScore: 0.9 }), MIN_SCORE)).toBe(
      false,
    );
  });

  it("a null topScore with nonzero retrievedCount/chunkIds is NOT weak on the score arm alone", () => {
    // Defensive case: retrievedCount>0 and chunkIds nonempty but topScore is
    // somehow null. Should not crash and should not count as weak (the score
    // arm never fires for null).
    expect(isWeakResultEvent(makeRow({ topScore: null }), MIN_SCORE)).toBe(
      false,
    );
  });
});

describe("aggregateWeakResultEvents", () => {
  const window = {
    since: new Date("2026-06-24T00:00:00Z"),
    until: new Date("2026-07-01T00:00:00Z"),
  };

  it("excludes fine/strong-score rows entirely", () => {
    const rows = [
      makeRow({ topScore: 0.9 }), // fine
      makeRow({ topScore: 0.5 }), // fine
    ];
    const summary = aggregateWeakResultEvents(rows, MIN_SCORE, window);
    expect(summary.totalWeakEvents).toBe(0);
    expect(summary.bySourceGroup).toEqual([]);
    expect(summary.byEndpoint).toEqual({});
  });

  it("counts weak rows and groups them by endpoint", () => {
    const rows = [
      makeRow({
        endpoint: "ask",
        retrievedCount: 0,
        chunkIds: [],
        topScore: null,
      }),
      makeRow({
        endpoint: "search",
        retrievedCount: 0,
        chunkIds: [],
        topScore: null,
      }),
      makeRow({ endpoint: "search", topScore: 0.1 }),
      makeRow({ topScore: 0.9 }), // fine, excluded
    ];
    const summary = aggregateWeakResultEvents(rows, MIN_SCORE, window);
    expect(summary.totalWeakEvents).toBe(3);
    expect(summary.byEndpoint).toEqual({ ask: 1, search: 2 });
  });

  it("groups by sourceIds combination regardless of element order", () => {
    const rows = [
      makeRow({ sourceIds: ["b", "a"], retrievedCount: 0, chunkIds: [] }),
      makeRow({ sourceIds: ["a", "b"], retrievedCount: 0, chunkIds: [] }),
      makeRow({ sourceIds: ["c"], retrievedCount: 0, chunkIds: [] }),
    ];
    const summary = aggregateWeakResultEvents(rows, MIN_SCORE, window);
    expect(summary.bySourceGroup).toHaveLength(2);
    const abGroup = summary.bySourceGroup.find(
      (g) => JSON.stringify(g.sourceIds) === JSON.stringify(["a", "b"]),
    );
    expect(abGroup?.count).toBe(2);
    const cGroup = summary.bySourceGroup.find(
      (g) => JSON.stringify(g.sourceIds) === JSON.stringify(["c"]),
    );
    expect(cGroup?.count).toBe(1);
  });

  it("stamps the digest window bounds onto the summary", () => {
    const summary = aggregateWeakResultEvents([], MIN_SCORE, window);
    expect(summary.since).toBe(window.since.toISOString());
    expect(summary.until).toBe(window.until.toISOString());
  });
});

describe("handleDocsGapDigest", () => {
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
        docsGapDigest: { minScore: MIN_SCORE, cron: "0 6 * * 1", tz: "UTC" },
      },
    } as unknown as WorkerDeps;
    return { deps, infoMock };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries weak-result events, aggregates them, and logs exactly one summary line", async () => {
    getWeakResultAuditEventsMock.mockResolvedValue([
      makeRow({
        endpoint: "search",
        retrievedCount: 0,
        chunkIds: [],
        topScore: null,
      }),
    ]);
    const { deps, infoMock } = makeDeps();

    await handleDocsGapDigest(
      { id: "job-1" } as unknown as Parameters<typeof handleDocsGapDigest>[0],
      deps,
    );

    expect(getWeakResultAuditEventsMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ minScore: MIN_SCORE }),
    );
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [payload, message] = infoMock.mock.calls[0]!;
    expect(message).toMatch(/documentation gap digest/i);
    expect(payload).toMatchObject({
      marker: "docs.gap_digest.summary",
      totalWeakEvents: 1,
      byEndpoint: { search: 1 },
    });
  });

  it("logs a zero-count summary when there are no weak-result events", async () => {
    getWeakResultAuditEventsMock.mockResolvedValue([]);
    const { deps, infoMock } = makeDeps();

    await handleDocsGapDigest(
      { id: "job-2" } as unknown as Parameters<typeof handleDocsGapDigest>[0],
      deps,
    );

    const [payload] = infoMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      totalWeakEvents: 0,
      byEndpoint: {},
      bySourceGroup: [],
    });
  });
});
