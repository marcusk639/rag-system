import { describe, expect, it, vi } from "vitest";
import { MemoryStorage, TestAdapter } from "botbuilder";
import { KbBot, createTeamsGetMemberOids } from "./bot.js";
import { SsoRequiredError } from "./auth.js";

const SIGN_IN_CARD = {
  contentType: "application/vnd.microsoft.card.oauth",
  content: { connectionName: "conn" },
};

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
    getSignInCard: vi.fn(async () => SIGN_IN_CARD),
    exchangeSsoTokenForOid: vi.fn(async () => "oid-A"),
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
    submitFeedback: vi.fn(async () => undefined),
    storage: new MemoryStorage(),
    ...over,
  };
}

describe("KbBot", () => {
  const ANSWER_ID = "11111111-1111-4111-8111-111111111111";
  const feedbackActivity = (value: unknown) =>
    ({
      type: "message",
      value,
      conversation: { conversationType: "channel", id: "c1" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity override
    }) as any;

  it("feedback submit: records the vote under a token minted for the VERIFIED clicking user", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter
      .send(feedbackActivity({ kind: "rag-feedback", answerId: ANSWER_ID, rating: "not_helpful" }))
      .assertReply((activity) => {
        expect(activity.text).toMatch(/thanks/i);
      });

    expect(deps.resolveScope).toHaveBeenCalledWith({
      askerOid: "oid-A",
      conversationKind: "dm",
      memberOids: ["oid-A"],
    });
    expect(deps.submitFeedback).toHaveBeenCalledWith({
      answerId: ANSWER_ID,
      rating: "not_helpful",
      scopeToken: "scope-tok",
    });
    expect(deps.askKb).not.toHaveBeenCalled();
  });

  it("feedback submit: a malformed payload records nothing", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));
    await adapter.send(
      feedbackActivity({ kind: "rag-feedback", answerId: "not-a-uuid", rating: "great" }),
    );
    expect(deps.submitFeedback).not.toHaveBeenCalled();
    expect(deps.askKb).not.toHaveBeenCalled();
  });

  it("feedback submit: SSO not complete → asks the user to sign in and records nothing", async () => {
    const deps = makeDeps({
      resolveUserOid: vi.fn(async () => {
        throw new SsoRequiredError("sso");
      }),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));
    await adapter
      .send(feedbackActivity({ kind: "rag-feedback", answerId: ANSWER_ID, rating: "helpful" }))
      .assertReply((activity) => {
        expect(JSON.stringify(activity)).toMatch(/sign in/i);
      });
    expect(deps.submitFeedback).not.toHaveBeenCalled();
  });

  it("DM: sends a typing indicator, resolves personal scope, and replies with an answer card containing the disclaimer", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    // Only an EXPLICIT "personal" conversation gets DM (personal-scope)
    // treatment — see the fail-safe inversion test below.
    const dmActivity = {
      type: "message",
      text: "what is the intake SOP?",
      conversation: { conversationType: "personal", id: "dm1" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity override; TestAdapter fills in the rest
    } as any;

    await adapter
      .send(dmActivity)
      // Spec §4 / finding #7: a typing activity precedes the API call.
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
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

  it("fail-closed: SSO not complete → an OAuthCard/sign-in attachment is sent and askKb is NEVER called", async () => {
    const deps = makeDeps({
      resolveUserOid: vi.fn(async () => {
        throw new SsoRequiredError("sso");
      }),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("q?").assertReply((activity) => {
      expect(deps.getSignInCard).toHaveBeenCalledTimes(1);
      expect(activity.attachments?.[0]?.contentType).toBe(
        "application/vnd.microsoft.card.oauth",
      );
    });
    expect(deps.askKb).not.toHaveBeenCalled();
    expect(deps.resolveScope).not.toHaveBeenCalled();
  });

  it("signin/tokenExchange invoke: completes the exchange and answers the pending question", async () => {
    const deps = makeDeps({
      resolveUserOid: vi.fn(async () => {
        throw new SsoRequiredError("sso");
      }),
    });
    const bot = new KbBot(deps);
    const adapter = new TestAdapter(async (ctx) => bot.run(ctx));

    // Turn 1: the question can't be answered yet — sign-in card + stash.
    await adapter.send("what is the intake SOP?").assertReply((activity) => {
      expect(activity.attachments?.[0]?.contentType).toBe(
        "application/vnd.microsoft.card.oauth",
      );
    });
    expect(deps.askKb).not.toHaveBeenCalled();

    // Turn 2: Teams posts the silent-SSO token-exchange invoke.
    const invoke = {
      type: "invoke",
      name: "signin/tokenExchange",
      value: { id: "exchange-1", token: "sso-token" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity; TestAdapter fills in conversation/from/recipient
    } as any;

    await adapter
      .send(invoke)
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
        expect(JSON.stringify(activity.attachments)).toContain("AI draft");
      });

    // The context argument is a revoked botbuilder proxy after the turn
    // ends (BotAdapter.runMiddleware), so assert on the token arg directly
    // rather than deep-comparing the whole call.
    expect(deps.exchangeSsoTokenForOid).toHaveBeenCalledTimes(1);
    expect((deps.exchangeSsoTokenForOid.mock.calls[0] as unknown[])[1]).toBe(
      "sso-token",
    );
    // The pending question — not something re-derived — is what gets asked.
    expect(deps.askKb).toHaveBeenCalledWith(
      expect.objectContaining({ question: "what is the intake SOP?" }),
    );
  });

  it("signin/tokenExchange invoke: a failed exchange re-sends the sign-in card and never answers", async () => {
    const deps = makeDeps({
      exchangeSsoTokenForOid: vi.fn(async () => null),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    const invoke = {
      type: "invoke",
      name: "signin/tokenExchange",
      value: { id: "exchange-1", token: "bad-token" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity
    } as any;

    await adapter.send(invoke).assertReply((activity) => {
      expect(activity.attachments?.[0]?.contentType).toBe(
        "application/vnd.microsoft.card.oauth",
      );
    });
    expect(deps.askKb).not.toHaveBeenCalled();
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

    await adapter
      .send(channelActivity)
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
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

  it("fail-safe (#3): an UNKNOWN conversationType is treated as channel (intersection scope), never dm", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    const oddActivity = {
      type: "message",
      text: "q",
      conversation: { conversationType: "someFutureSurface", id: "c9" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity override
    } as any;

    await adapter.send(oddActivity).assertReply(() => undefined);

    expect(deps.getMemberOids).toHaveBeenCalledTimes(1);
    expect(deps.resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKind: "channel" }),
    );
  });

  it("fail-closed (#2): an empty member roster yields the empty-scope card without minting any scope", async () => {
    const deps = makeDeps({ getMemberOids: vi.fn(async () => []) });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    const channelActivity = {
      type: "message",
      text: "q",
      conversation: { conversationType: "channel", id: "c1" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity override
    } as any;

    await adapter
      .send(channelActivity)
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
        expect(activity.attachments?.length ?? 0).toBeGreaterThan(0);
      });

    expect(deps.resolveScope).not.toHaveBeenCalled();
    expect(deps.askKb).not.toHaveBeenCalled();
  });

  it("empty question (#6): a bare/whitespace message gets the usage card before any auth/scope/API work", async () => {
    const deps = makeDeps();
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter.send("   ").assertReply((activity) => {
      expect(JSON.stringify(activity.attachments)).toContain("Ask me");
    });

    // A message with NO text at all (attachment-only) must not crash on
    // .trim() and must get the same usage card.
    const noTextActivity = {
      type: "message",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial Activity with undefined text
    } as any;
    await adapter.send(noTextActivity).assertReply((activity) => {
      expect(JSON.stringify(activity.attachments)).toContain("Ask me");
    });

    expect(deps.resolveUserOid).not.toHaveBeenCalled();
    expect(deps.resolveScope).not.toHaveBeenCalled();
    expect(deps.askKb).not.toHaveBeenCalled();
  });

  it("empty scope: replies with the empty-scope card and never calls askKb", async () => {
    const deps = makeDeps({
      resolveScope: vi.fn(async () => ({
        token: "scope-tok",
        allowedSourceIds: [],
      })),
    });
    const adapter = new TestAdapter(async (ctx) => new KbBot(deps).run(ctx));

    await adapter
      .send("what is the intake SOP?")
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
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

    await adapter
      .send("q?")
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
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

    await adapter
      .send("q?")
      .assertReply((activity) => {
        expect(activity.type).toBe("typing");
      })
      .assertReply((activity) => {
        const rendered = JSON.stringify(activity.attachments);
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered).not.toContain("10.0.0.5");
        expect(rendered).not.toContain("db connection reset");
      });
  });
});

describe("createTeamsGetMemberOids", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal context; only recipient.id is consulted
  const ctx = { activity: { recipient: { id: "bot-id" } } } as any;

  it("accumulates ALL pages before returning (never a partial roster)", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        continuationToken: "next",
        members: [{ id: "m1", aadObjectId: "oid-1" }],
      })
      .mockResolvedValueOnce({
        continuationToken: "",
        members: [{ id: "m2", aadObjectId: "oid-2" }],
      });

    const oids = await createTeamsGetMemberOids(fetchPage)(ctx);
    expect(oids).toEqual(["oid-1", "oid-2"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(2, ctx, "next");
  });

  it("fail-closed (#2): ANY member without an aadObjectId collapses the result to [] (on any page)", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        continuationToken: "next",
        members: [{ id: "m1", aadObjectId: "oid-1" }],
      })
      .mockResolvedValueOnce({
        continuationToken: "",
        members: [{ id: "guest-1", aadObjectId: undefined }],
      });

    expect(await createTeamsGetMemberOids(fetchPage)(ctx)).toEqual([]);
  });

  it("excludes the bot itself from the roster without failing closed", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({
      continuationToken: "",
      members: [
        { id: "bot-id", aadObjectId: undefined },
        { id: "m1", aadObjectId: "oid-1" },
      ],
    });

    expect(await createTeamsGetMemberOids(fetchPage)(ctx)).toEqual(["oid-1"]);
  });
});
