import { beforeEach, describe, expect, it, vi } from "vitest";

// `triggerSync` calls these as free functions imported from sibling packages,
// so we mock the modules rather than injecting the functions.
const getSource = vi.fn();
const createIngestionJob = vi.fn();
const deleteIngestionJob = vi.fn();
const enqueueSync = vi.fn();

vi.mock("@rag/db", () => ({
  getSource: (...args: unknown[]) => getSource(...args),
  createIngestionJob: (...args: unknown[]) => createIngestionJob(...args),
  deleteIngestionJob: (...args: unknown[]) => deleteIngestionJob(...args),
  // Referenced elsewhere in the module but not by triggerSync.
  listSources: vi.fn(),
  toPublicSource: vi.fn(),
}));

vi.mock("@rag/ingestion", () => ({
  enqueueSync: (...args: unknown[]) => enqueueSync(...args),
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
  });

  it("deletes the orphaned pending row and rethrows when enqueue is rejected", async () => {
    const rejection = new Error("A sync is already pending or running");
    enqueueSync.mockRejectedValue(rejection);

    await expect(triggerSync(deps, input)).rejects.toBe(rejection);

    // The row we optimistically created must not linger as orphaned `pending`.
    expect(deleteIngestionJob).toHaveBeenCalledWith(deps.db, "ing-1");
  });
});
