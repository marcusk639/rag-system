import {
  ActivityTypes,
  TeamsActivityHandler,
  TeamsInfo,
  TurnContext,
} from "botbuilder";
import type {
  Attachment,
  SigninStateVerificationQuery,
  Storage,
  TeamsChannelAccount,
} from "botbuilder";
import {
  SsoRequiredError,
  createProductionAuthDeps,
  createSignInCardFactory,
  createSsoTokenExchanger,
  decodeOidFromJwt,
  resolveUserOid,
} from "./auth.js";
import { KbUnavailableError, askKb } from "./rag-client.js";
import type { AskAnswer } from "./rag-client.js";
import { answerCard, emptyScopeCard, errorCard, usageCard } from "./cards.js";
import { createProductionScopeDeps, mintScope } from "./scope.js";
import type { BotConfig } from "./config.js";

/** Which flavor of Teams conversation the asker is in. Drives both the
 * member-roster lookup and which scope the answer is restricted to. */
export type ConversationKind = "dm" | "channel";

/** Input to `BotDeps.resolveScope` — mirrors `MintScopeTokenInput`
 * (`scope.ts`) so the production wiring is a thin pass-through. */
export interface ResolveScopeInput {
  askerOid: string;
  conversationKind: ConversationKind;
  memberOids: string[];
}

/**
 * The signed scope token PLUS the source-ids it grants — exactly what
 * `scope.ts`'s `mintScope` returns. The handler needs `allowedSourceIds`
 * (not just the opaque token) so it can decide "empty scope" purely to
 * avoid an API call, before any token leaves the process. Production
 * wiring (`createProductionBotDeps` below) delegates straight to
 * `mintScope` — there is no separate resolution logic here.
 */
export interface ResolvedScope {
  token: string;
  allowedSourceIds: string[];
}

/**
 * Collaborators the message/invoke orchestration needs, all injected so the
 * handler is testable with botbuilder's `TestAdapter` (no live Teams, no
 * network, no DB). `createProductionBotDeps` below wires the real
 * implementations for `apps/teams-bot/src/index.ts`.
 */
export interface BotDeps {
  /** Resolves the verified Entra `oid` of the user driving this message
   * turn (production: `UserTokenClient.getUserToken` → decode `oid`).
   * Fail-closed: throws `SsoRequiredError` (from `auth.ts`) when SSO hasn't
   * completed yet — the handler must then send the sign-in card and stop,
   * never fall through to an answer. */
  resolveUserOid(context: TurnContext): Promise<string>;
  /** Builds the OAuthCard that starts the Teams SSO handshake (production:
   * `UserTokenClient.getSignInResource` + `CardFactory.oauthCard`). */
  getSignInCard(context: TurnContext): Promise<Attachment>;
  /** Redeems the SSO token from a `signin/tokenExchange` invoke for the
   * user's verified `oid` (production: `UserTokenClient.exchangeToken`,
   * falling back to `getUserToken`, then decode `oid`). Returns `null` when
   * the exchange can't complete — the handler must fail closed. */
  exchangeSsoTokenForOid(
    context: TurnContext,
    ssoToken: string,
  ): Promise<string | null>;
  /** Member `oid`s of the current channel/groupChat. Only called for
   * `conversationKind === "channel"` — a DM's scope is just the asker.
   * Fail-closed contract: MUST return `[]` (never a partial roster) when
   * any member's `oid` can't be established — see
   * `createTeamsGetMemberOids`. */
  getMemberOids(context: TurnContext): Promise<string[]>;
  /** Mints the scope token AND surfaces the source-ids it grants, so the
   * handler can short-circuit an empty scope without calling the API. */
  resolveScope(input: ResolveScopeInput): Promise<ResolvedScope>;
  /** Asks the RAG API the user's question under the minted scope. Throws
   * `KbUnavailableError` (from `rag-client.ts`) on any failure. */
  askKb(input: { question: string; scopeToken: string }): Promise<AskAnswer>;
  /** Holds the asker's question across the SSO handshake: stored when the
   * sign-in card is sent, answered when the `signin/tokenExchange` invoke
   * completes. Production: the same `MemoryStorage` instance the
   * `TeamsSSOTokenExchangeMiddleware` deduplicates against. */
  storage: Storage;
}

const SIGN_IN_FALLBACK_MESSAGE =
  "Please sign in to Microsoft Teams to use the knowledge base bot.";
const SIGNED_IN_ASK_AGAIN_MESSAGE =
  "You're signed in now — please send your question again.";
const GENERIC_ERROR_MESSAGE =
  "Something went wrong answering your question. Please try again in a moment.";

/** Shape of the per-user pending-question record persisted across the SSO
 * handshake (message turn → sign-in card → token-exchange invoke). */
interface PendingQuestion {
  question: string;
  conversationKind: ConversationKind;
}

/** Storage key scoping a pending question to (channel, conversation, user) —
 * the same triple the token-exchange invoke arrives under. Returns `null`
 * when the activity lacks any component (fail closed: no key → nothing
 * stored → nothing answered later). */
function pendingQuestionKey(context: TurnContext): string | null {
  const channelId = context.activity.channelId;
  const conversationId = context.activity.conversation?.id;
  const userId = context.activity.from?.id;
  if (!channelId || !conversationId || !userId) {
    return null;
  }
  return `teams-bot/pending-question/${channelId}/${conversationId}/${userId}`;
}

/**
 * Classifies the conversation. Fail-safe inversion: ONLY an explicit
 * `"personal"` conversationType gets the asker's full personal scope (DM);
 * `"channel"`, `"groupChat"`, and anything unknown/missing gets the
 * member-intersection channel scope. An unrecognized surface must default
 * to the NARROWER scope, never the broader personal one — a new/renamed
 * Teams conversationType silently mapping to personal scope would leak the
 * asker's private grants to everyone who can read the conversation.
 */
function classifyConversation(context: TurnContext): ConversationKind {
  return context.activity.conversation?.conversationType === "personal"
    ? "dm"
    : "channel";
}

/**
 * `TeamsActivityHandler` orchestrating auth → scope → ask → card for every
 * incoming message, routing DM vs channel conversations differently (a
 * channel answer is restricted to what every member shares access to; see
 * `scope.ts`'s compliance-critical doc comment on `mintScope`), and
 * completing the Teams SSO handshake via the `signin/tokenExchange` invoke.
 */
export class KbBot extends TeamsActivityHandler {
  private readonly deps: BotDeps;

  constructor(deps: BotDeps) {
    super();
    this.deps = deps;

    this.onMessage(async (context, next) => {
      await this.handleMessage(context);
      await next();
    });
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    const conversationKind = classifyConversation(context);

    // Guard BEFORE any auth/scope/API work: a message can arrive with no
    // usable text at all (attachment-only, bare @mention). Teams prefixes
    // channel/groupChat messages with an @mention of the bot (e.g.
    // "<at>Kb Bot</at> what is the intake SOP?"); strip it before treating
    // the remainder as the question.
    const rawText = context.activity.text;
    const question =
      typeof rawText === "string" && rawText.trim().length > 0
        ? (TurnContext.removeRecipientMention(context.activity) ?? "").trim()
        : "";

    if (question.length === 0) {
      await context.sendActivity({ attachments: [usageCard()] });
      return;
    }

    try {
      const askerOid = await this.deps.resolveUserOid(context);
      await this.answer(context, askerOid, question, conversationKind);
    } catch (error) {
      if (error instanceof SsoRequiredError) {
        await this.startSignIn(context, question, conversationKind);
        return;
      }
      await this.sendErrorCard(context, error);
    }
  }

  /**
   * The shared answer flow (typing → member roster → scope → ask → card),
   * used by both the message path and the token-exchange invoke path. The
   * caller must already hold a VERIFIED `askerOid` — this method never
   * establishes identity itself.
   */
  private async answer(
    context: TurnContext,
    askerOid: string,
    question: string,
    conversationKind: ConversationKind,
  ): Promise<void> {
    try {
      // Spec §4: show responsiveness during LLM latency.
      await context.sendActivity({ type: ActivityTypes.Typing });

      const memberOids =
        conversationKind === "channel"
          ? await this.deps.getMemberOids(context)
          : [askerOid];

      // Fail-closed (#2): an empty roster means membership could not be
      // fully established (e.g. a member without a resolvable oid). Never
      // mint a scope from a partial member set — the intersection over a
      // SHRUNKEN set is BROADER, which is the leak direction.
      if (memberOids.length === 0) {
        await context.sendActivity({
          attachments: [emptyScopeCard(conversationKind)],
        });
        return;
      }

      const { token, allowedSourceIds } = await this.deps.resolveScope({
        askerOid,
        conversationKind,
        memberOids,
      });

      if (allowedSourceIds.length === 0) {
        await context.sendActivity({
          attachments: [emptyScopeCard(conversationKind)],
        });
        return;
      }

      const answer = await this.deps.askKb({
        question,
        scopeToken: token,
      });

      await context.sendActivity({ attachments: [answerCard(answer)] });
    } catch (error) {
      await this.sendErrorCard(context, error);
    }
  }

  /**
   * SSO couldn't complete silently on a message turn: stash the question so
   * the upcoming `signin/tokenExchange` invoke can answer it, then send the
   * OAuthCard that starts the handshake. Fail-closed: every branch here ends
   * in a card, never an answer.
   */
  private async startSignIn(
    context: TurnContext,
    question: string,
    conversationKind: ConversationKind,
  ): Promise<void> {
    const key = pendingQuestionKey(context);
    if (key) {
      try {
        const pending: PendingQuestion = { question, conversationKind };
        await this.deps.storage.write({ [key]: pending });
      } catch (error) {
        // Losing the pending question only costs the user a re-ask after
        // sign-in — still send the sign-in card.
        console.error("KbBot: failed to store pending question", error);
      }
    }

    try {
      const card = await this.deps.getSignInCard(context);
      await context.sendActivity({ attachments: [card] });
    } catch (error) {
      console.error("KbBot: failed to build sign-in card", error);
      await context.sendActivity({
        attachments: [errorCard(SIGN_IN_FALLBACK_MESSAGE)],
      });
    }
  }

  /**
   * The silent-SSO completion: Teams posts a `signin/tokenExchange` invoke
   * (in response to the OAuthCard's `tokenExchangeResource`) carrying the
   * SSO token in `activity.value.token`. Base-class routing confirmed
   * against the installed botbuilder@4.23.3:
   * `TeamsActivityHandler.onSignInInvoke` dispatches
   * `tokenExchangeOperationName` here (teamsActivityHandler.js:266-267), and
   * `ActivityHandler.onInvokeActivity` turns a normal return into a 200
   * invoke response / a thrown error into a 501/500 — so this method must
   * handle every failure itself (fail closed to a card) rather than throw.
   *
   * Note: in production, `TeamsSSOTokenExchangeMiddleware` (index.ts) has
   * already deduplicated concurrent exchanges and performed the exchange
   * once before this runs; `exchangeSsoTokenForOid` therefore falls back to
   * `getUserToken` when the direct exchange reports the token as already
   * redeemed.
   */
  protected override async handleTeamsSigninTokenExchange(
    context: TurnContext,
    _query: SigninStateVerificationQuery,
  ): Promise<void> {
    // The runtime payload of a signin/tokenExchange invoke is a
    // TokenExchangeInvokeRequest ({ id, connectionName, token }) even though
    // the base class types the parameter as SigninStateVerificationQuery.
    const value = context.activity.value as { token?: string } | undefined;
    const ssoToken = typeof value?.token === "string" ? value.token : "";

    let oid: string | null = null;
    if (ssoToken.length > 0) {
      try {
        oid = await this.deps.exchangeSsoTokenForOid(context, ssoToken);
      } catch (error) {
        console.error("KbBot: token exchange failed", error);
        oid = null;
      }
    }

    if (!oid) {
      // Exchange could not produce a verified identity — fail closed:
      // restart the sign-in flow, never answer, never fall back.
      await this.startSignInFallback(context);
      return;
    }

    const key = pendingQuestionKey(context);
    let pending: PendingQuestion | null = null;
    if (key) {
      try {
        const items = await this.deps.storage.read([key]);
        const record = items[key] as Partial<PendingQuestion> | undefined;
        if (
          typeof record?.question === "string" &&
          record.question.length > 0
        ) {
          pending = {
            question: record.question,
            // Fail-safe: an unrecognized stored kind is treated as channel
            // (the narrower scope), mirroring classifyConversation.
            conversationKind:
              record.conversationKind === "dm" ? "dm" : "channel",
          };
        }
        await this.deps.storage.delete([key]);
      } catch (error) {
        console.error("KbBot: failed to read pending question", error);
      }
    }

    if (!pending) {
      // Signed in, but the original question is gone (restart, expired
      // storage). Ask the user to re-send rather than guessing.
      await context.sendActivity({
        attachments: [errorCard(SIGNED_IN_ASK_AGAIN_MESSAGE)],
      });
      return;
    }

    await this.answer(context, oid, pending.question, pending.conversationKind);
  }

  /** Sign-in restart used from the invoke path (no question to stash — one
   * is already pending or was never stored). */
  private async startSignInFallback(context: TurnContext): Promise<void> {
    try {
      const card = await this.deps.getSignInCard(context);
      await context.sendActivity({ attachments: [card] });
    } catch (error) {
      console.error("KbBot: failed to build sign-in card", error);
      await context.sendActivity({
        attachments: [errorCard(SIGN_IN_FALLBACK_MESSAGE)],
      });
    }
  }

  private async sendErrorCard(
    context: TurnContext,
    error: unknown,
  ): Promise<void> {
    if (error instanceof KbUnavailableError) {
      await context.sendActivity({
        attachments: [errorCard(error.message)],
      });
      return;
    }

    // Any other error (DB failure, unexpected exception, etc.): log full
    // detail server-side only. The user-facing card is always the generic
    // message — never the raw error, which could leak internal details
    // (connection strings, stack traces, etc.). `no-console` is only a warn
    // in this repo's eslint config; this app has no pino logger wired yet
    // (tracked separately from this task).
    console.error("KbBot: unexpected error handling message", error);
    await context.sendActivity({
      attachments: [errorCard(GENERIC_ERROR_MESSAGE)],
    });
  }
}

/** One page of conversation members, as returned by
 * `TeamsInfo.getPagedMembers` (`TeamsPagedMembersResult`,
 * botframework-schema/lib/teams/index.d.ts: `{ continuationToken, members }`). */
export interface MemberPage {
  continuationToken?: string;
  members: Pick<TeamsChannelAccount, "id" | "aadObjectId">[];
}

/** Fetches one page of the current conversation's roster. Injectable so the
 * pagination + fail-closed logic below is unit-testable without TeamsInfo's
 * static, Graph-backed call. */
export type FetchMemberPage = (
  context: TurnContext,
  continuationToken?: string,
) => Promise<MemberPage>;

const defaultFetchMemberPage: FetchMemberPage = (context, continuationToken) =>
  // Paged (non-deprecated) roster API — signature confirmed against the
  // installed botbuilder@4.23.3 (teamsInfo.d.ts:75):
  //   getPagedMembers(context, pageSize?, continuationToken?)
  //     → Promise<TeamsPagedMembersResult>
  TeamsInfo.getPagedMembers(context, undefined, continuationToken);

/**
 * Production `getMemberOids`: the FULL member roster of the current
 * channel/groupChat, accumulated across every page of
 * `TeamsInfo.getPagedMembers` before any scope is computed — answering from
 * a partial page would shrink the member set and therefore BROADEN the
 * intersection scope (the leak direction).
 *
 * Fail-closed (#2): if ANY member (other than the bot itself) lacks a
 * usable `aadObjectId`, this returns `[]` — the empty-scope card fires.
 * Dropping such a member instead would remove their grants from the
 * intersection constraint, leaking content they can't access into a
 * conversation they can read.
 */
export function createTeamsGetMemberOids(
  fetchPage: FetchMemberPage = defaultFetchMemberPage,
): (context: TurnContext) => Promise<string[]> {
  return async (context: TurnContext): Promise<string[]> => {
    const botId = context.activity.recipient?.id;
    const oids: string[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await fetchPage(context, continuationToken);
      for (const member of page.members) {
        // Spec §3: the bot itself is excluded from the member set.
        if (botId && member.id === botId) {
          continue;
        }
        if (!member.aadObjectId) {
          return [];
        }
        oids.push(member.aadObjectId);
      }
      continuationToken = page.continuationToken || undefined;
    } while (continuationToken);

    return oids;
  };
}

/**
 * Builds the production `BotDeps`, wired to the real SSO token service
 * (`auth.ts`), the real DB-backed scope resolvers + signer (`scope.ts`),
 * the real RAG API client (`rag-client.ts`), and the real paged Teams
 * member-roster lookup above.
 *
 * `resolveScope` delegates directly to `scope.ts`'s `mintScope` — the
 * dm/channel resolver-selection branch lives ONLY there. This file must
 * never re-implement that branch: a copy here that isn't kept in sync with
 * `scope.ts` is exactly how a channel answer could leak the asker's
 * personal grants.
 *
 * @param storage The same `Storage` instance the
 * `TeamsSSOTokenExchangeMiddleware` is constructed with (index.ts), reused
 * for the pending-question stash.
 */
export function createProductionBotDeps(
  config: BotConfig,
  storage: Storage,
): BotDeps {
  const connectionName = config.botOauthConnectionName;
  const authDeps = createProductionAuthDeps(connectionName);
  const scopeDeps = createProductionScopeDeps(config);
  const exchangeSsoToken = createSsoTokenExchanger(connectionName);

  return {
    resolveUserOid: (context) => resolveUserOid(context, authDeps),
    getSignInCard: createSignInCardFactory(connectionName),
    exchangeSsoTokenForOid: async (context, ssoToken) => {
      const jwt = await exchangeSsoToken(context, ssoToken);
      return jwt ? decodeOidFromJwt(jwt) : null;
    },
    getMemberOids: createTeamsGetMemberOids(),
    resolveScope: (input) => mintScope(input, scopeDeps),
    askKb: (input) => askKb(input, { ragApiUrl: config.ragApiUrl, fetch }),
    storage,
  };
}
