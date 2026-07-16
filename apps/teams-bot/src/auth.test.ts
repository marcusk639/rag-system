import { describe, expect, it } from "vitest";
import { resolveUserOid, SsoRequiredError } from "./auth.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TurnContext not exercised directly; deps are injected
const ctx = {} as any;
const decodeOid = (jwt: string) => (jwt === "tok-with-oid" ? "oid-123" : null);

describe("resolveUserOid", () => {
  it("returns the oid from an exchanged token", async () => {
    const deps = { exchangeToken: async () => "tok-with-oid", decodeOid };
    expect(await resolveUserOid(ctx, deps)).toBe("oid-123");
  });
  it("fails closed (throws SsoRequiredError) when no token is returned", async () => {
    const deps = { exchangeToken: async () => null, decodeOid };
    await expect(resolveUserOid(ctx, deps)).rejects.toBeInstanceOf(
      SsoRequiredError,
    );
  });
  it("fails closed when the token has no oid claim", async () => {
    const deps = { exchangeToken: async () => "tok-no-oid", decodeOid };
    await expect(resolveUserOid(ctx, deps)).rejects.toBeInstanceOf(
      SsoRequiredError,
    );
  });
});
