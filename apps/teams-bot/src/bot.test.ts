import { describe, expect, it, vi } from "vitest";
import { TestAdapter } from "botbuilder";
import { KbBot } from "./bot.js";

/**
 * `Partial<any>` mirrors the shape used across this app's other test files
 * (e.g. auth.test.ts) — the override object only needs to supply the keys a
 * given test wants to change, and vitest's `vi.fn()` results are structurally
 * compatible with `BotDeps` without a cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture accepts partial overrides of any injectable dep
function makeDeps(over: Partial<any> = {}) {
  return {
    resolveUserOid: vi.fn(async () => "oid-A"),
    getMemberOids: vi.fn(async () => ["oid-A", "oid-B"]),
    // Returns BOTH the signed token AND the resolved allowedSourceIds — see
    // bot.ts's `BotDeps.resolveScope` doc comment for why the handler needs
    // allowedSourceIds (from scope.ts's `mintScope`) to decide "empty scope"
    // without calling the API.
    resolveScope: vi.fn(async () => ({
      token: "scope-tok",
      allowedSourceIds: ["src-1"],
    })),
    askKb: vi.fn(async () => ({
      answer: "Per SOP",
      citations: [],
      disclaimer: "AI draft",
    })),
    ...over,
  };
}

describe("KbBot", () => {
  it("DM: resolves personal scope and replies with an answer card containing the disclaimer", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("what is the intake SOP?").assertReply((activity) => {
      expect(JSON.stringify(activity.attachments)).toContain("AI draft");
    });

    expect(deps.resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKind: "dm",
        askerOid: "oid-A",
        memberOids: ["oid-A"],
      }),
    );
    expect(deps.askKb).toHaveBeenCalledWith(
      expect.objectContaining({ scopeToken: "scope-tok" }),
    );
    // A DM's memberOids is derived from the asker alone — the channel
    // member-roster lookup is never needed (and never billed against Graph).
    expect(deps.getMemberOids).not.toHaveBeenCalled();
  });

  it("fail-closed: a SsoRequiredError yields a sign-in/error card, never an answer", async () => {
    const deps = makeDeps({
      resolveUserOid: vi.fn(async () => {
        throw new (await import("./auth.js")).SsoRequiredError("sso");
      }),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("q?").assertReply((activity) => {
      expect(deps.askKb).not.toHaveBeenCalled();
      expect(activity.attachments?.length ?? 0).toBeGreaterThan(0);
    });
    expect(deps.resolveScope).not.toHaveBeenCalled();
  });

  it("channel: fetches member oids and mints scope for the whole roster, not just the asker", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    const channelActivity = {
      type: "message",
      text: "<at>bot</at> q",
      conversation: { conversationType: "channel", id: "c1" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity override; TestAdapter fills in the rest (from/recipient/etc.)
    } as any;

    await adapter.send(channelActivity).assertReply((activity) => {
      expect(JSON.stringify(activity.attachments)).toContain("AI draft");
    });

    expect(deps.getMemberOids).toHaveBeenCalledTimes(1);
    expect(deps.resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKind: "channel",
        memberOids: ["oid-A", "oid-B"],
      }),
    );
  });

  it("empty scope: replies with the empty-scope card and never calls askKb", async () => {
    const deps = makeDeps({
      resolveScope: vi.fn(async () => ({
        token: "scope-tok",
        allowedSourceIds: [],
      })),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("what is the intake SOP?").assertReply((activity) => {
      expect(deps.askKb).not.toHaveBeenCalled();
      expect(activity.attachments?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("KbUnavailableError from askKb yields an error card, not a crash", async () => {
    const deps = makeDeps({
      askKb: vi.fn(async () => {
        throw new (await import("./rag-client.js")).KbUnavailableError();
      }),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("q?").assertReply((activity) => {
      expect(activity.attachments?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("an unexpected error is swallowed into a generic error card, never leaked", async () => {
    const deps = makeDeps({
      askKb: vi.fn(async () => {
        throw new Error("db connection reset by peer at 10.0.0.5:5432");
      }),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("q?").assertReply((activity) => {
      const rendered = JSON.stringify(activity.attachments);
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered).not.toContain("10.0.0.5");
      expect(rendered).not.toContain("db connection reset");
    });
  });
});
