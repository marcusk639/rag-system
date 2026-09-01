import { beforeEach, describe, expect, it, vi } from "vitest";

// `triggerSync` calls these as free functions imported from sibling packages,
// so we mock the modules rather than injecting the functions.
const getSource = vi.fn();
const createIngestionJob = vi.fn();
const deleteIngestionJob = vi.fn();
const updateIngestionJob = vi.fn();
const enqueueSync = vi.fn();

const purgeSourceQuery = vi.fn();
const listSources = vi.fn();
const toPublicSource = vi.fn();

// Real subclass so `triggerSync`'s `instanceof` check behaves like production.
class SyncAlreadyRunningError extends Error {
  readonly code = "SYNC_ALREADY_RUNNING";
}

vi.mock("@rag/db", () => ({
  getSource: (...args: unknown[]) => getSource(...args),
  createIngestionJob: (...args: unknown[]) => createIngestionJob(...args),
  deleteIngestionJob: (...args: unknown[]) => deleteIngestionJob(...args),
  updateIngestionJob: (...args: unknown[]) => updateIngestionJob(...args),
  purgeSource: (...args: unknown[]) => purgeSourceQuery(...args),
  listSources: (...args: unknown[]) => listSources(...args),
  toPublicSource: (...args: unknown[]) => toPublicSource(...args),
}));

vi.mock("@rag/ingestion", () => ({
  enqueueSync: (...args: unknown[]) => enqueueSync(...args),
  SyncAlreadyRunningError,
}));

const { triggerSync, purgeSource, listPublicSources } =
  await import("./sources.js");
import type { AuthorizationScope } from "@rag/core";
import type { ServiceDeps } from "./deps.js";

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const deps = { db: {}, queue: {}, logger } as unknown as ServiceDeps;
const input = { sourceId: "src-1", mode: "full" as const };

beforeEach(() => {
  vi.clearAllMocks();
  getSource.mockResolvedValue({ id: "src-1" });
  createIngestionJob.mockResolvedValue({ id: "ing-1" });
  // toPublicSource is production-pure (strips `config`); the identity mock is
  // fine here since listPublicSources's OWN scope-filtering logic — not the
  // config-stripping projection — is what these tests exercise.
  toPublicSource.mockImplementation((row: unknown) => row);
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

  it("logs a genuine enqueue failure server-side with full context", async () => {
    const rejection = new Error("pg-boss connection lost");
    enqueueSync.mockRejectedValue(rejection);

    await expect(triggerSync(deps, input)).rejects.toBe(rejection);

    // The failure is captured here because a transport (e.g. the trigger_sync
    // MCP tool) may reduce the thrown error to a user-facing string.
    expect(logger.error).toHaveBeenCalledWith(
      { err: rejection, sourceId: "src-1", ingestionId: "ing-1", mode: "full" },
      "sync enqueue failed",
    );
  });

  it("does NOT log when the failure is just a deduped duplicate", async () => {
    enqueueSync.mockRejectedValue(
      new SyncAlreadyRunningError("already running"),
    );

    await expect(triggerSync(deps, input)).rejects.toBeInstanceOf(
      SyncAlreadyRunningError,
    );

    // A duplicate is expected/benign — it stays out of the error log.
    expect(logger.error).not.toHaveBeenCalled();
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

describe("purgeSource", () => {
  it("resolves when the db query reports the source existed", async () => {
    purgeSourceQuery.mockResolvedValue({ deleted: true, storageKeys: [] });

    await expect(purgeSource(deps, "src-1")).resolves.toBeUndefined();
    expect(purgeSourceQuery).toHaveBeenCalledWith(deps.db, "src-1");
  });

  it("throws NotFoundError when the db query reports no such source", async () => {
    purgeSourceQuery.mockResolvedValue({ deleted: false, storageKeys: [] });

    await expect(purgeSource(deps, "src-missing")).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("listPublicSources", () => {
  const ROW_A = { id: "src-a", name: "Source A" };
  const ROW_B = { id: "src-b", name: "Source B" };

  it("returns every row for the admin scope (enforcedSourceIds: null)", async () => {
    listSources.mockResolvedValue([ROW_A, ROW_B]);
    const scope: AuthorizationScope = { enforcedSourceIds: null };

    const result = await listPublicSources(deps, scope);

    expect(result.map((r) => r.id)).toEqual(["src-a", "src-b"]);
  });

  it("filters to only the rows within a scoped principal's allowedSourceIds", async () => {
    listSources.mockResolvedValue([ROW_A, ROW_B]);
    const scope: AuthorizationScope = { enforcedSourceIds: ["src-a"] };

    const result = await listPublicSources(deps, scope);

    expect(result.map((r) => r.id)).toEqual(["src-a"]);
  });

  it("returns [] for the deny-all scope (empty enforcedSourceIds), matching DENY_ALL_SCOPE semantics", async () => {
    listSources.mockResolvedValue([ROW_A, ROW_B]);
    const scope: AuthorizationScope = { enforcedSourceIds: [] };

    const result = await listPublicSources(deps, scope);

    expect(result).toEqual([]);
  });

  it("still strips config via toPublicSource before filtering", async () => {
    listSources.mockResolvedValue([ROW_A]);
    toPublicSource.mockImplementation((row: { id: string }) => ({
      id: row.id,
    }));
    const scope: AuthorizationScope = { enforcedSourceIds: null };

    const result = await listPublicSources(deps, scope);

    expect(toPublicSource).toHaveBeenCalledWith(
      ROW_A,
      expect.any(Number),
      expect.any(Array),
    );
    expect(result).toEqual([{ id: "src-a" }]);
  });
});

describe("purgeSource — object-store cleanup", () => {
  // Deleting a source cascaded in Postgres only. The original bytes in the
  // object store were never touched, so every deleted source left its files
  // behind — 1,747 orphaned objects (~499 MB) accumulated in production this
  // way, including the pre-purge corpus a §7216 purge was performed over. The
  // DB rows went; the documents themselves stayed in a third-party bucket.
  //
  // The keys come back from the DB layer because only it knows which documents
  // existed before the cascade removed them. @rag/db stays free of any
  // object-store dependency.

  it("deletes the stored originals for every purged document", async () => {
    purgeSourceQuery.mockResolvedValue({
      deleted: true,
      storageKeys: ["sources/src-1/aaa", "sources/src-1/bbb"],
    });
    const objectStore = { delete: vi.fn().mockResolvedValue(undefined) };
    const d = { ...deps, objectStore } as unknown as ServiceDeps;

    await purgeSource(d, "src-1");

    expect(objectStore.delete).toHaveBeenCalledTimes(2);
    expect(objectStore.delete).toHaveBeenCalledWith("sources/src-1/aaa");
    expect(objectStore.delete).toHaveBeenCalledWith("sources/src-1/bbb");
  });

  it("still purges when no object store is configured", async () => {
    purgeSourceQuery.mockResolvedValue({
      deleted: true,
      storageKeys: ["sources/src-1/aaa"],
    });
    const d = { ...deps, objectStore: null } as unknown as ServiceDeps;

    await expect(purgeSource(d, "src-1")).resolves.toBeUndefined();
  });

  it("does NOT fail the purge when an object delete fails", async () => {
    // The DB rows are already gone by this point — the cascade is committed.
    // Throwing here would surface a 500 for a purge that mostly succeeded and
    // invite a retry against a source that no longer exists. The orphan is
    // logged instead, so it can be swept up.
    purgeSourceQuery.mockResolvedValue({
      deleted: true,
      storageKeys: ["sources/src-1/aaa"],
    });
    const objectStore = {
      delete: vi.fn().mockRejectedValue(new Error("bucket unreachable")),
    };
    const d = { ...deps, objectStore } as unknown as ServiceDeps;

    await expect(purgeSource(d, "src-1")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it("throws NotFound when the source does not exist, and touches no objects", async () => {
    purgeSourceQuery.mockResolvedValue({ deleted: false, storageKeys: [] });
    const objectStore = { delete: vi.fn() };
    const d = { ...deps, objectStore } as unknown as ServiceDeps;

    await expect(purgeSource(d, "nope")).rejects.toThrow(/not found/i);
    expect(objectStore.delete).not.toHaveBeenCalled();
  });
});
