import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSyncSource } from "./sync-source.js";
import type { WorkerDeps } from "../deps.js";

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("@rag/runtime", () => ({
  captureException: captureExceptionMock,
}));

const { getSourceMock, updateIngestionJobMock, incrementMock, markSyncedMock } =
  vi.hoisted(() => ({
    getSourceMock: vi.fn(),
    updateIngestionJobMock: vi.fn(),
    incrementMock: vi.fn(),
    markSyncedMock: vi.fn(),
  }));

// incrementIngestionJobCounters RETURNs the accumulated row (one statement, so
// the handler's ratio test and the durable row cannot disagree). The fake
// accumulates across calls for the same reason: a continuation test that reset
// to this run's delta would never exercise the across-pages case the ratio
// check exists for.
const accumulated = {
  documentsProcessed: 0,
  documentsFailed: 0,
  chunksCreated: 0,
  documentsQuarantined: 0,
};
function resetAccumulated() {
  for (const k of Object.keys(accumulated) as (keyof typeof accumulated)[]) {
    accumulated[k] = 0;
  }
}
function installIncrementFake() {
  incrementMock.mockImplementation(
    (_db: unknown, _id: string, delta: Partial<typeof accumulated>) => {
      accumulated.documentsProcessed += delta.documentsProcessed ?? 0;
      accumulated.documentsFailed += delta.documentsFailed ?? 0;
      accumulated.chunksCreated += delta.chunksCreated ?? 0;
      accumulated.documentsQuarantined += delta.documentsQuarantined ?? 0;
      return Promise.resolve({ ...accumulated });
    },
  );
}

vi.mock("@rag/db", () => ({
  getSource: getSourceMock,
  updateIngestionJob: updateIngestionJobMock,
  incrementIngestionJobCounters: incrementMock,
  markSourceSynced: markSyncedMock,
}));

const { runIngestionMock, enqueueContinuationMock, mapDataClassMock } =
  vi.hoisted(() => ({
    runIngestionMock: vi.fn(),
    enqueueContinuationMock: vi.fn(),
    mapDataClassMock: vi.fn(
      (dataClass: string) =>
        ({
          general: "A",
          sop: "A",
          research: "B",
          client_confidential: "D",
        })[dataClass],
    ),
  }));

vi.mock("@rag/ingestion", () => ({
  runIngestion: runIngestionMock,
  enqueueContinuation: enqueueContinuationMock,
  mapDataClassToDocumentClass: mapDataClassMock,
  MAX_SYNC_CONTINUATIONS: 100_000,
}));

function fakeLogger() {
  const l: Record<string, unknown> = {};
  l.child = () => l;
  l.info = () => undefined;
  l.warn = () => undefined;
  l.error = () => undefined;
  l.debug = () => undefined;
  return l;
}

function makeDeps() {
  const connector = {
    kind: "sharepoint",
    validate: vi.fn(async () => undefined),
    list: vi.fn(),
    fetch: vi.fn(),
  };
  const deps = {
    db: {},
    logger: fakeLogger(),
    parser: {},
    chunker: {},
    embedder: {},
    objectStore: null,
    queue: {},
    config: { worker: { concurrency: 2 } },
    makeConnector: vi.fn(() => connector),
    close: vi.fn(),
  } as unknown as WorkerDeps;
  return { deps, connector };
}

function runResult(
  done: boolean,
  nextCursor: string | null,
  extra: Record<string, number> = {},
) {
  return {
    documentsProcessed: 1,
    documentsFailed: 0,
    chunksCreated: 2,
    documentsDeleted: 0,
    documentsSkippedOversize: 0,
    documentsQuarantined: 0,
    done,
    nextCursor,
    ...extra,
  };
}

const SOURCE = {
  id: "s1",
  kind: "sharepoint",
  config: {},
  cursor: "cur0",
  dataClass: "general",
};

function job(
  data: Record<string, unknown>,
  meta: { retryCount?: number; retryLimit?: number } = {},
) {
  return {
    id: "job-1",
    name: "syncSource",
    priority: 0,
    state: "active" as const,
    retryCount: meta.retryCount ?? 0,
    retryLimit: meta.retryLimit ?? 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: new Date(),
    startedOn: new Date(),
    singletonKey: null,
    expireInSeconds: 60,
    createdOn: new Date(),
    completedOn: null,
    keepUntil: new Date(),
    on_complete: false,
    output: {},
    data: {
      sourceId: "s1",
      ingestionId: "ing-1",
      mode: "incremental",
      ...data,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  captureExceptionMock.mockReset();
  getSourceMock.mockResolvedValue({ ...SOURCE });
  updateIngestionJobMock.mockResolvedValue(undefined);
  resetAccumulated();
  installIncrementFake();
  markSyncedMock.mockResolvedValue(undefined);
  enqueueContinuationMock.mockResolvedValue("cont-1");
  runIngestionMock.mockResolvedValue(runResult(true, "cur1"));
});

describe("handleSyncSource per-page continuation", () => {
  it("completes and stamps lastSyncedAt when the run reports done", async () => {
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(runResult(true, "cur1"));

    await handleSyncSource(job({}), deps);

    expect(markSyncedMock).toHaveBeenCalledWith({}, "s1");
    expect(enqueueContinuationMock).not.toHaveBeenCalled();
    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "completed" }),
    );
    expect(incrementMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ documentsProcessed: 1, chunksCreated: 2 }),
    );
  });

  it("records a run that quarantined everything as FAILED, not completed", async () => {
    // A run that refused every document and indexed nothing is the signature
    // of a broken safety gate -- an unreachable scanner, an egress gap, a
    // missing pack -- not of a corpus that is entirely sensitive. Stamping it
    // "completed" is what let a whole-source quarantine surface as a green
    // sync with chunksCreated: 0, which is the exact shape of the earlier
    // index-nothing incident.
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(
      runResult(true, "cur1", {
        documentsProcessed: 47,
        chunksCreated: 0,
        documentsQuarantined: 47,
      }),
    );

    await handleSyncSource(job({}), deps);

    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("47 of 47 documents were quarantined"),
      }),
    );
    expect(updateIngestionJobMock).not.toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "completed" }),
    );
    // "last synced" must not advance for a run that indexed nothing.
    expect(markSyncedMock).not.toHaveBeenCalled();
  });

  it("fails a run that quarantined most of the source but indexed something", async () => {
    // The case the all-or-nothing test missed, and the likelier one: a local
    // model degrades rather than dies, so one document succeeds out of 858 and
    // `chunksCreated === 0` is false. 857/858 is a broken gate, not a sync.
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(
      runResult(true, "cur1", {
        documentsProcessed: 858,
        chunksCreated: 2,
        documentsQuarantined: 857,
      }),
    );

    await handleSyncSource(job({}), deps);

    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(markSyncedMock).not.toHaveBeenCalled();
  });

  it("completes an all-unchanged incremental sync with one quarantine", async () => {
    // The mirror false positive of the old guard: every document `unchanged`
    // means chunksCreated 0 legitimately, so `quarantined > 0 && chunks === 0`
    // marked a healthy sync as a total gate failure. 1/47 is under the ratio.
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(
      runResult(true, "cur1", {
        documentsProcessed: 47,
        chunksCreated: 0,
        documentsQuarantined: 1,
      }),
    );

    await handleSyncSource(job({}), deps);

    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "completed" }),
    );
    expect(markSyncedMock).toHaveBeenCalled();
  });

  it("stops a multi-page sync mid-run instead of re-enqueueing every page", async () => {
    // The guard used to be gated on `result.done`, so a scanner down for the
    // first nineteen continuations of a twenty-job sync never reached it and
    // each job queued the next. Checked per run now, against the accumulated
    // row, so the first refusing page ends the job.
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(
      runResult(false, "cur1", {
        documentsProcessed: 50,
        chunksCreated: 0,
        documentsQuarantined: 50,
      }),
    );

    await handleSyncSource(job({}), deps);

    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(enqueueContinuationMock).not.toHaveBeenCalled();
  });

  it("persists the quarantine count to the durable row", async () => {
    // Without the documents_quarantined column this number lived only in a pino
    // line, so the row an operator reads said documentsFailed: 0.
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(
      runResult(true, "cur1", {
        documentsProcessed: 47,
        chunksCreated: 120,
        documentsQuarantined: 3,
      }),
    );

    await handleSyncSource(job({}), deps);

    expect(incrementMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ documentsQuarantined: 3 }),
    );
  });

  it("passes the configured scanner into runIngestion", async () => {
    // Nothing asserted this, and after the absent-scanner contract was
    // relaxed, a dropped wire is indistinguishable from the intended default:
    // Layer 1.5 would be off in every deployment with a green suite.
    const { deps } = makeDeps();

    await handleSyncSource(job({}), deps);

    expect(runIngestionMock.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ scanner: deps.scanner }),
    );
  });

  it("still completes when some documents were quarantined but others indexed", async () => {
    // Quarantining is normal and expected; only quarantining EVERYTHING with
    // nothing indexed is the broken-gate signal.
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(
      runResult(true, "cur1", {
        documentsProcessed: 47,
        chunksCreated: 120,
        documentsQuarantined: 3,
      }),
    );

    await handleSyncSource(job({}), deps);

    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("re-enqueues a continuation (not completed) when more pages remain", async () => {
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(runResult(false, "cur1")); // advanced cur0 -> cur1

    await handleSyncSource(job({}), deps);

    expect(enqueueContinuationMock).toHaveBeenCalledWith(
      {},
      {
        sourceId: "s1",
        mode: "incremental",
        ingestionId: "ing-1",
        continuationCount: 0,
      },
    );
    expect(markSyncedMock).not.toHaveBeenCalled();
    expect(updateIngestionJobMock).not.toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("marks running + validates ONLY on the first job, not on continuations", async () => {
    const first = makeDeps();
    await handleSyncSource(job({}), first.deps);
    expect(first.connector.validate).toHaveBeenCalledTimes(1);
    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "running" }),
    );

    vi.clearAllMocks();
    getSourceMock.mockResolvedValue({ ...SOURCE });
    runIngestionMock.mockResolvedValue(runResult(true, "cur1"));
    const cont = makeDeps();
    await handleSyncSource(
      job({ continuation: true, continuationCount: 3 }),
      cont.deps,
    );
    expect(cont.connector.validate).not.toHaveBeenCalled();
    expect(updateIngestionJobMock).not.toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "running" }),
    );
  });

  it("a continuation resumes from the stored cursor even for a full sync", async () => {
    const { deps } = makeDeps();
    runIngestionMock.mockResolvedValue(runResult(true, "cur1"));

    await handleSyncSource(
      job({ mode: "full", continuation: true, continuationCount: 1 }),
      deps,
    );

    // 3rd positional arg to runIngestion is startCursor — must be source.cursor,
    // NOT null, despite mode === "full".
    expect(runIngestionMock.mock.calls[0]![2]).toBe("cur0");
  });

  it("retries previously failed documents on the first job only", async () => {
    await handleSyncSource(job({}), makeDeps().deps);
    await handleSyncSource(
      job({ continuation: true, continuationCount: 1 }),
      makeDeps().deps,
    );
    expect(runIngestionMock.mock.calls[0]?.[3]).toMatchObject({
      retryFailed: true,
    });
    expect(runIngestionMock.mock.calls[1]?.[3]).toMatchObject({
      retryFailed: false,
    });
  });

  it("a first full sync starts from a null cursor", async () => {
    const { deps } = makeDeps();
    await handleSyncSource(job({ mode: "full" }), deps);
    expect(runIngestionMock.mock.calls[0]![2]).toBeNull();
  });

  it("fails (no continuation) when the cursor did not advance", async () => {
    const { deps } = makeDeps();
    // not done, but nextCursor equals the start cursor -> no progress.
    runIngestionMock.mockResolvedValue(runResult(false, "cur0"));

    await expect(handleSyncSource(job({}), deps)).rejects.toThrow(
      /no progress|did not advance/i,
    );
    expect(enqueueContinuationMock).not.toHaveBeenCalled();
    expect(updateIngestionJobMock).toHaveBeenCalledWith(
      {},
      "ing-1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("captures to Sentry only on the terminal (final-retry) failure", async () => {
    const { deps } = makeDeps();
    runIngestionMock.mockRejectedValue(new Error("network error"));

    // Mid-flight retry (retryCount 1 of 3) — must NOT alert yet.
    await expect(
      handleSyncSource(job({}, { retryCount: 1, retryLimit: 3 }), deps),
    ).rejects.toThrow("network error");
    expect(captureExceptionMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    getSourceMock.mockResolvedValue({ ...SOURCE });
    runIngestionMock.mockRejectedValue(new Error("network error"));

    // Terminal attempt (retryCount === retryLimit) — MUST alert exactly once.
    await expect(
      handleSyncSource(job({}, { retryCount: 3, retryLimit: 3 }), deps),
    ).rejects.toThrow("network error");
    expect(captureExceptionMock).toHaveBeenCalledOnce();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ sourceId: "s1", jobId: "job-1" }),
    );
  });

  it("aborts when the continuation cap is exceeded", async () => {
    const { deps } = makeDeps();
    await expect(
      handleSyncSource(
        job({ continuation: true, continuationCount: 100_001 }),
        deps,
      ),
    ).rejects.toThrow(/continuations/i);
    expect(runIngestionMock).not.toHaveBeenCalled();
  });
});

describe("handleSyncSource classification wiring", () => {
  it("maps the source's data_class to sourceDocClass and passes it into runIngestion's deps", async () => {
    const { deps } = makeDeps();
    getSourceMock.mockResolvedValue({ ...SOURCE, dataClass: "research" });

    await handleSyncSource(job({}), deps);

    expect(mapDataClassMock).toHaveBeenCalledWith("research");
    expect(runIngestionMock.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ sourceDocClass: "B" }),
    );
  });

  it("passes 'A' through for a general-classified source (the DB default)", async () => {
    const { deps } = makeDeps();
    getSourceMock.mockResolvedValue({ ...SOURCE, dataClass: "general" });

    await handleSyncSource(job({}), deps);

    expect(runIngestionMock.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ sourceDocClass: "A" }),
    );
  });

  it("passes 'D' through for a client_confidential source, so the pipeline blocks it", async () => {
    const { deps } = makeDeps();
    getSourceMock.mockResolvedValue({
      ...SOURCE,
      dataClass: "client_confidential",
    });

    await handleSyncSource(job({}), deps);

    expect(runIngestionMock.mock.calls[0]![4]).toEqual(
      expect.objectContaining({ sourceDocClass: "D" }),
    );
  });
});
