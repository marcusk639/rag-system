import { describe, expect, it, vi } from "vitest";
import { mintScope } from "./scope.js";

const secret = "a".repeat(64);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture accepts partial overrides of any injectable dep
function deps(over: Partial<any> = {}) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db is never touched by these fakes, only passed through
    db: {} as any,
    secret,
    resolveForUser: vi.fn(async () => ["src-personal", "src-client"]),
    resolveShared: vi.fn(async () => ["src-firm-sop"]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shape asserted via JSON.parse(token) below
    sign: vi.fn(async (payload: any) => JSON.stringify(payload)), // capture, not real JWT
    ...over,
  };
}

describe("mintScope", () => {
  it("DM: signs the asker's full personal scope", async () => {
    const d = deps();
    const result = await mintScope(
      { askerOid: "oid-A", conversationKind: "dm", memberOids: ["oid-A"] },
      d,
    );
    expect(d.resolveForUser).toHaveBeenCalledWith(d.db, "oid-A");
    expect(result.allowedSourceIds).toEqual(["src-personal", "src-client"]);
    expect(JSON.parse(result.token)).toEqual({
      sub: "oid-A",
      allowedSourceIds: ["src-personal", "src-client"],
    });
  });

  it("channel: signs the members' shared scope, NOT the asker's personal scope (isolation)", async () => {
    const d = deps({ resolveShared: vi.fn(async () => ["src-firm-sop"]) });
    const result = await mintScope(
      {
        askerOid: "oid-A",
        conversationKind: "channel",
        memberOids: ["oid-A", "oid-B"],
      },
      d,
    );
    expect(d.resolveShared).toHaveBeenCalledWith(d.db, ["oid-A", "oid-B"]);
    expect(d.resolveForUser).not.toHaveBeenCalled(); // asker's private grants never used in a channel
    expect(result.allowedSourceIds).toEqual(["src-firm-sop"]); // shared set, not the asker's personal set
    expect(JSON.parse(result.token)).toEqual({
      sub: "oid-A",
      allowedSourceIds: ["src-firm-sop"],
    });
  });

  it("fails closed: a throwing resolver propagates (no fallback scope)", async () => {
    const d = deps({
      resolveShared: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(
      mintScope(
        {
          askerOid: "oid-A",
          conversationKind: "channel",
          memberOids: ["oid-A"],
        },
        d,
      ),
    ).rejects.toThrow("db down");
  });
});
