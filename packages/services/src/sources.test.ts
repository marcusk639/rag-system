import { beforeEach, describe, expect, it, vi } from "vitest";

// `triggerSync` calls these as free functions imported from sibling packages,
// so we mock the modules rather than injecting the functions.
const getSource = vi.fn();
const createIngestionJob = vi.fn();
const deleteIngestionJob = vi.fn();
const updateIngestionJob = vi.fn();
const enqueueSync = vi.fn();

// Real subclass so `triggerSync`'s `instanceof` check behaves like production.
class SyncAlreadyRunningError extends Error {
  readonly code = "SYNC_ALREADY_RUNNING";
}

vi.mock("@rag/db", () => ({
  getSource: (...args: unknown[]) => getSource(...args),
  createIngestionJob: (...args: unknown[]) => createIngestionJob(...args),
  deleteIngestionJob: (...args: unknown[]) => deleteIngestionJob(...args),
  updateIngestionJob: (...args: unknown[]) => updateIngestionJob(...args),
  // Referenced elsewhere in the module but not by triggerSync.
  listSources: vi.fn(),
  toPublicSource: vi.fn(),
}));

vi.mock("@rag/ingestion", () => ({
  enqueueSync: (...args: unknown[]) => enqueueSync(...args),
  SyncAlreadyRunningError,
}));

const { triggerSync } = await import("./sources.js");
import type { ServiceDeps } from "./deps.js";

const deps = { db: {}, queue: {} } as unknown as ServiceDeps;
const input = { sourceId: "src-1", mode: "full" as const };

beforeEach(() => {
  vi.clearAllMocks();
  getSource.mockResolvedValue({ id: "src-1" });
  createIngestionJob.mockResolvedValue({ id: "ing-1" });
});

describe("triggerSync", () => {
  it("returns the queued job and keeps the history row on success", async () => {
    enqueueSync.mockResolvedValue("job-1");

    const result = await triggerSync(deps, input);

    expect(result).toEqual({
      jobId: "job-1",
      ingestionId: "ing-1",
      mode: "full",
    });
    expect(createIngestionJob).toHaveBeenCalledOnce();
    expect(deleteIngestionJob).not.toHaveBeenCalled();
    expect(updateIngestionJob).not.toHaveBeenCalled();
  });

  it("deletes the orphaned pending row and rethrows when a duplicate is rejected", async () => {
    const rejection = new SyncAlreadyRunningError("already running");
    enqueueSync.mockRejectedValue(rejection);

    await expect(triggerSync(deps, input)).rejects.toBe(rejection);

    // A rejected duplicate leaves no trace; the in-flight sync owns its row.
    expect(deleteIngestionJob).toHaveBeenCalledWith(deps.db, "ing-1");
    expect(updateIngestionJob).not.toHaveBeenCalled();
  });

  it("marks the row failed (not deleted) and rethrows on a genuine enqueue error", async () => {
    const rejection = new Error("pg-boss connection lost");
    enqueueSync.mockRejectedValue(rejection);

    await expect(triggerSync(deps, input)).rejects.toBe(rejection);

    // A real failed attempt stays auditable rather than stuck `pending`.
    expect(updateIngestionJob).toHaveBeenCalledWith(deps.db, "ing-1", {
      status: "failed",
    });
    expect(deleteIngestionJob).not.toHaveBeenCalled();
  });

  it("rethrows the original error even if cleanup fails", async () => {
    const rejection = new SyncAlreadyRunningError("already running");
    enqueueSync.mockRejectedValue(rejection);
    deleteIngestionJob.mockRejectedValue(new Error("db down during cleanup"));

    // The enqueue error must surface, not the cleanup error.
    await expect(triggerSync(deps, input)).rejects.toBe(rejection);
  });

  it("never touches the history table when the source is unknown", async () => {
    getSource.mockResolvedValue(null);

    await expect(triggerSync(deps, input)).rejects.toThrow(/not found/i);

    expect(createIngestionJob).not.toHaveBeenCalled();
    expect(enqueueSync).not.toHaveBeenCalled();
  });
});
