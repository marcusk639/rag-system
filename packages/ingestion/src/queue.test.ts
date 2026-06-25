import { describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import {
  enqueueContinuation,
  enqueueSync,
  SYNC_EXPIRE_SECONDS,
} from "./queue.js";
import { SyncAlreadyRunningError } from "./errors.js";

function fakeBoss(sendReturn: string | null) {
  const send = vi.fn(
    (
      _name: string,
      _data: Record<string, unknown>,
      _opts: { singletonKey?: string; expireInSeconds?: number },
    ): Promise<string | null> => Promise.resolve(sendReturn),
  );
  return { boss: { send } as unknown as PgBoss, send };
}

const PAYLOAD = {
  sourceId: "s1",
  mode: "incremental" as const,
  ingestionId: "ing-1",
};

describe("enqueueSync", () => {
  it("sends with the per-source singletonKey and bounded expiry", async () => {
    const { boss, send } = fakeBoss("job-1");
    const id = await enqueueSync(boss, PAYLOAD);
    expect(id).toBe("job-1");
    const [, , opts] = send.mock.calls[0]!;
    expect(opts.singletonKey).toBe("sync:s1");
    expect(opts.expireInSeconds).toBe(SYNC_EXPIRE_SECONDS);
  });

  it("throws SyncAlreadyRunningError when pg-boss drops the insert (null)", async () => {
    const { boss } = fakeBoss(null);
    await expect(enqueueSync(boss, PAYLOAD)).rejects.toBeInstanceOf(
      SyncAlreadyRunningError,
    );
  });
});

describe("enqueueContinuation", () => {
  it("marks the job a continuation and increments the continuation count", async () => {
    const { boss, send } = fakeBoss("job-2");
    const id = await enqueueContinuation(boss, {
      ...PAYLOAD,
      continuationCount: 4,
    });
    expect(id).toBe("job-2");
    const [, data, opts] = send.mock.calls[0]!;
    expect(data).toMatchObject({
      sourceId: "s1",
      ingestionId: "ing-1",
      continuation: true,
      continuationCount: 5,
    });
    // Same singletonKey → serialized behind the active job under singleton policy.
    expect(opts.singletonKey).toBe("sync:s1");
  });

  it("treats an absent prior count as 0 (first continuation = 1)", async () => {
    const { boss, send } = fakeBoss("job-3");
    await enqueueContinuation(boss, PAYLOAD);
    const [, data] = send.mock.calls[0]!;
    expect(data).toMatchObject({ continuationCount: 1 });
  });

  it("propagates a null return (caller treats it as an error)", async () => {
    const { boss } = fakeBoss(null);
    await expect(enqueueContinuation(boss, PAYLOAD)).resolves.toBeNull();
  });
});
