import { describe, expect, it, vi } from "vitest";
import {
  createSignInCardFactory,
  createSsoTokenExchanger,
  createSsoTokenGetter,
  resolveUserOid,
  SsoRequiredError,
} from "./auth.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TurnContext not exercised directly; deps are injected
const ctx = {} as any;
const decodeOid = (jwt: string) => (jwt === "tok-with-oid" ? "oid-123" : null);

describe("resolveUserOid", () => {
  it("returns the oid from the token-service token", async () => {
    const deps = { getUserToken: async () => "tok-with-oid", decodeOid };
    expect(await resolveUserOid(ctx, deps)).toBe("oid-123");
  });
  it("fails closed (throws SsoRequiredError) when no token is returned", async () => {
    const deps = { getUserToken: async () => null, decodeOid };
    await expect(resolveUserOid(ctx, deps)).rejects.toBeInstanceOf(
      SsoRequiredError,
    );
  });
  it("fails closed when the token has no oid claim", async () => {
    const deps = { getUserToken: async () => "tok-no-oid", decodeOid };
    await expect(resolveUserOid(ctx, deps)).rejects.toBeInstanceOf(
      SsoRequiredError,
    );
  });
});

// ---------------------------------------------------------------------------
// Production wiring against a fake UserTokenClient in turnState — the same
// lookup path (adapter.UserTokenClientKey → turnState) the real CloudAdapter
// uses, without a live Bot Framework token service.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake of the turn context
function contextWithClient(client: unknown): any {
  const key = Symbol("UserTokenClientKey");
  return {
    activity: {
      channelId: "msteams",
      from: { id: "user-1" },
      value: undefined,
    },
    adapter: { UserTokenClientKey: key },
    turnState: new Map([[key, client]]),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake of a turn context whose adapter has no UserTokenClientKey (e.g. TestAdapter)
function contextWithoutClient(): any {
  return {
    activity: { channelId: "msteams", from: { id: "u" } },
    adapter: {},
    turnState: new Map(),
  };
}

describe("createSsoTokenGetter", () => {
  it("returns the token from getUserToken(userId, connectionName, channelId, '')", async () => {
    const getUserToken = vi.fn(async () => ({ token: "aad-jwt" }));
    const context = contextWithClient({ getUserToken });
    expect(await createSsoTokenGetter("conn")(context)).toBe("aad-jwt");
    expect(getUserToken).toHaveBeenCalledWith("user-1", "conn", "msteams", "");
  });
  it("returns null (fail closed) when the token service throws", async () => {
    const context = contextWithClient({
      getUserToken: vi.fn(async () => {
        throw new Error("no token for user");
      }),
    });
    expect(await createSsoTokenGetter("conn")(context)).toBeNull();
  });
  it("returns null when no UserTokenClient is available (e.g. TestAdapter)", async () => {
    expect(
      await createSsoTokenGetter("conn")(contextWithoutClient()),
    ).toBeNull();
  });
});

describe("createSsoTokenExchanger", () => {
  it("exchanges the invoke's SSO token via exchangeToken(userId, connectionName, channelId, { token })", async () => {
    const exchangeToken = vi.fn(async () => ({ token: "exchanged-jwt" }));
    const context = contextWithClient({ exchangeToken });
    expect(await createSsoTokenExchanger("conn")(context, "sso-tok")).toBe(
      "exchanged-jwt",
    );
    expect(exchangeToken).toHaveBeenCalledWith("user-1", "conn", "msteams", {
      token: "sso-tok",
    });
  });
  it("falls back to getUserToken when the exchange was already redeemed (middleware)", async () => {
    const context = contextWithClient({
      exchangeToken: vi.fn(async () => {
        throw new Error("token already redeemed");
      }),
      getUserToken: vi.fn(async () => ({ token: "cached-jwt" })),
    });
    expect(await createSsoTokenExchanger("conn")(context, "sso-tok")).toBe(
      "cached-jwt",
    );
  });
  it("returns null (fail closed) when both exchange and lookup fail", async () => {
    const context = contextWithClient({
      exchangeToken: vi.fn(async () => {
        throw new Error("consent required");
      }),
      getUserToken: vi.fn(async () => undefined),
    });
    expect(
      await createSsoTokenExchanger("conn")(context, "sso-tok"),
    ).toBeNull();
  });
});

describe("createSignInCardFactory", () => {
  it("builds an OAuthCard from getSignInResource(connectionName, activity, '')", async () => {
    const getSignInResource = vi.fn(async () => ({
      signInLink: "https://token.botframework.com/signin",
      tokenExchangeResource: { id: "res-1", uri: "api://botid-x/scope" },
    }));
    const context = contextWithClient({ getSignInResource });
    const card = await createSignInCardFactory("conn")(context);
    expect(getSignInResource).toHaveBeenCalledWith(
      "conn",
      context.activity,
      "",
    );
    expect(card.contentType).toContain("card.oauth");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OAuthCard content shape
    const content = card.content as any;
    expect(content.connectionName).toBe("conn");
    expect(content.tokenExchangeResource?.id).toBe("res-1");
  });
  it("throws (fail closed) when no UserTokenClient is available", async () => {
    await expect(
      createSignInCardFactory("conn")(contextWithoutClient()),
    ).rejects.toThrow();
  });
});
