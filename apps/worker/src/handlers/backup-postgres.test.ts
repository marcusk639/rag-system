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

  it("passes the DB password via PGPASSWORD env, never in argv", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: { env?: NodeJS.ProcessEnv },
        cb: (
          err: Error | null,
          result: { stdout: Buffer; stderr: string },
        ) => void,
      ) => {
        cb(null, { stdout: Buffer.from("x"), stderr: "" });
      },
    );
    const deps = makeDeps();

    await handleBackupPostgres(makeJob(), deps);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
      unknown,
    ];
    expect(cmd).toBe("pg_dump");

    // The password must never appear as a positional argv element — argv is
    // visible to co-resident processes via `ps aux` / `/proc/<pid>/cmdline`.
    for (const arg of args) {
      expect(arg).not.toContain("pass");
      expect(arg).not.toContain("postgres://user:pass");
    }

    // It must instead be supplied via the subprocess env.
    expect(opts.env?.PGPASSWORD).toBe("pass");
  });

  it("wraps a pg_dump failure in a safe error that omits cmd/argv and any connection-string-shaped substring, while still propagating (so pg-boss retries)", async () => {
    class FakeExecFileError extends Error {
      cmd: string;
      stderr: string;
      code: number;
      constructor() {
        super(
          'Command failed: pg_dump --dbname postgres://user:pass@host:5432/db -F c\nFATAL: password authentication failed for user "user"',
        );
        this.name = "FakeExecFileError";
        // execFile's real error carries the full command line (including
        // any credential-bearing argv) as an own enumerable `cmd` property.
        // serialize-error would persist this into pgboss.job.output verbatim.
        this.cmd = "pg_dump --dbname postgres://user:pass@host:5432/db -F c";
        this.stderr = 'FATAL: password authentication failed for user "user"';
        this.code = 1;
      }
    }

    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error) => void,
      ) => {
        cb(new FakeExecFileError());
      },
    );
    const deps = makeDeps();

    const error: unknown = await handleBackupPostgres(makeJob(), deps).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    const err = error as Error;

    // Still propagates unswallowed — pg-boss must see a rejection to retry.
    expect(err.message).toMatch(/pg_dump failed/i);

    // No credential/connection-string leakage anywhere on the thrown error.
    expect("cmd" in err).toBe(false);
    expect(err.message).not.toContain("postgres://user:pass");
    expect(err.message).not.toContain("pass@host");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(
      "pass@host",
    );

    expect(insertBackupRunMock).not.toHaveBeenCalled();
  });
});
