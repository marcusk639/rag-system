import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { handleBackupPostgres } from "./backup-postgres.js";
import type { WorkerDeps } from "../deps.js";

const { insertBackupRunMock, execFileMock } = vi.hoisted(() => ({
  insertBackupRunMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("@rag/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rag/db")>();
  return { ...actual, insertBackupRun: insertBackupRunMock };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

function makeJob() {
  return { id: "job-1", data: {} } as never;
}

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: {} as WorkerDeps["db"],
    logger: pino({ level: "silent" }),
    config: {
      backup: { provider: "objectStore", keyPrefix: "backups/" },
      databaseUrl: "postgres://user:pass@host:5432/db",
    } as WorkerDeps["config"],
    objectStore: {
      bucket: "test-bucket",
      put: vi.fn(async () => {}),
      get: vi.fn(),
      delete: vi.fn(),
    },
    ...overrides,
  } as WorkerDeps;
}

describe("handleBackupPostgres", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when backup.provider is 'none'", async () => {
    const deps = makeDeps({
      config: { backup: { provider: "none" } } as WorkerDeps["config"],
    });
    await handleBackupPostgres(makeJob(), deps);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });

  it("no-ops when objectStore is null", async () => {
    const deps = makeDeps({ objectStore: null });
    await handleBackupPostgres(makeJob(), deps);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });

  it("runs pg_dump, uploads the result, and records the run", async () => {
    const dumpBytes = Buffer.from("fake-pg-dump-bytes");
    // Resolves the callback's SECOND arg as a single { stdout, stderr } object,
    // not two separate args — this matches real child_process.execFile's own
    // util.promisify.custom behavior (which is what makes `promisify(execFile)`
    // resolve to { stdout, stderr } in production). vi.mock("node:child_process")
    // replaces the whole module, so that custom-promisify wiring is gone —
    // this mock manually reproduces its resolved shape so execFileAsync's
    // `const { stdout } = await execFileAsync(...)` still destructures
    // correctly. Get this shape wrong and the test would pass for the wrong
    // reason (or fail in a confusing way unrelated to the handler's own logic).
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: { maxBuffer: number },
        cb: (
          err: Error | null,
          result: { stdout: Buffer; stderr: string },
        ) => void,
      ) => {
        cb(null, { stdout: dumpBytes, stderr: "" });
      },
    );
    const deps = makeDeps();

    await handleBackupPostgres(makeJob(), deps);

    expect(execFileMock).toHaveBeenCalledWith(
      "pg_dump",
      expect.arrayContaining(["-F", "c"]),
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function),
    );
    expect(deps.objectStore!.put).toHaveBeenCalledWith(
      expect.stringMatching(/^backups\/.*\.dump$/),
      dumpBytes,
      "application/octet-stream",
    );
    expect(insertBackupRunMock).toHaveBeenCalledWith(
      deps.db,
      expect.objectContaining({
        sizeBytes: dumpBytes.length,
        objectKey: expect.stringMatching(/^backups\/.*\.dump$/),
      }),
    );
  });

  it("propagates a pg_dump failure unswallowed (so pg-boss retries)", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("pg_dump: connection refused"));
      },
    );
    const deps = makeDeps();

    await expect(handleBackupPostgres(makeJob(), deps)).rejects.toThrow(
      "pg_dump: connection refused",
    );
    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });
});
