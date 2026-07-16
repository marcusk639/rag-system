import { TeamsActivityHandler, TeamsInfo, TurnContext } from "botbuilder";
import type { TeamsChannelAccount } from "botbuilder";
import {
  SsoRequiredError,
  createProductionAuthDeps,
  resolveUserOid,
} from "./auth.js";
import { KbUnavailableError, askKb } from "./rag-client.js";
import type { AskAnswer } from "./rag-client.js";
import { answerCard, emptyScopeCard, errorCard } from "./cards.js";
import { createProductionScopeDeps } from "./scope.js";
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
 * The signed scope token PLUS the source-ids it grants. `scope.ts`'s tested
 * `mintScopeToken` only returns the opaque signed token (by design — the bot
 * has no business decoding a token it didn't verify to make authorization
 * decisions). But the handler below has a separate, non-authorization need:
 * deciding "empty scope" purely to avoid an API call, before any token
 * leaves the process. `resolveScope` is that thin BotDeps-level wrapper —
 * production wiring composes it from `mintScopeToken`'s own resolver
 * functions (`resolveForUser`/`resolveShared`) and signer, so scope.ts's
 * contract is untouched. See `createProductionBotDeps` below.
 */
export interface ResolvedScope {
  token: string;
  allowedSourceIds: string[];
}

/**
 * Collaborators the `onMessage` orchestration needs, all injected so the
 * handler is testable with botbuilder's `TestAdapter` (no live Teams, no
 * network, no DB). `createProductionBotDeps` below wires the real
 * implementations for `apps/teams-bot/src/index.ts`.
 */
export interface BotDeps {
  /** Resolves the verified Entra `oid` of the user driving this turn.
   * Fail-closed: throws `SsoRequiredError` (from `auth.ts`) when SSO can't
   * produce one — the handler must never fall through to an answer. */
  resolveUserOid(context: TurnContext): Promise<string>;
  /** Member `oid`s of the current channel/groupChat. Only called for
   * `conversationKind === "channel"` — a DM's scope is just the asker. */
  getMemberOids(context: TurnContext): Promise<string[]>;
  /** Mints the scope token AND surfaces the source-ids it grants, so the
   * handler can short-circuit an empty scope without calling the API. */
  resolveScope(input: ResolveScopeInput): Promise<ResolvedScope>;
  /** Asks the RAG API the user's question under the minted scope. Throws
   * `KbUnavailableError` (from `rag-client.ts`) on any failure. */
  askKb(input: { question: string; scopeToken: string }): Promise<AskAnswer>;
}

const SIGN_IN_MESSAGE =
  "Please sign in to Microsoft Teams to use the knowledge base bot.";
const GENERIC_ERROR_MESSAGE =
  "Something went wrong answering your question. Please try again in a moment.";

/**
 * `TeamsActivityHandler` orchestrating auth → scope → ask → card for every
 * incoming message, routing DM vs channel conversations differently (a
 * channel answer is restricted to what every member shares access to; see
 * `scope.ts`'s compliance-critical doc comment on `mintScopeToken`).
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
    const conversationType = context.activity.conversation?.conversationType;
    const conversationKind: ConversationKind =
      conversationType === "channel" || conversationType === "groupChat"
        ? "channel"
        : "dm";

    // Teams prefixes channel/groupChat messages with an @mention of the
    // bot (e.g. "<at>Kb Bot</at> what is the intake SOP?"). Strip it before
    // treating the remainder as the question.
    const question = TurnContext.removeRecipientMention(
      context.activity,
    ).trim();

    try {
      const askerOid = await this.deps.resolveUserOid(context);

      const memberOids =
        conversationKind === "channel"
          ? await this.deps.getMemberOids(context)
          : [askerOid];

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
      if (error instanceof SsoRequiredError) {
        await context.sendActivity({
          attachments: [errorCard(SIGN_IN_MESSAGE)],
        });
        return;
      }

      if (error instanceof KbUnavailableError) {
        await context.sendActivity({
          attachments: [errorCard(error.message)],
        });
        return;
      }

      // Any other error (DB failure, unexpected exception, etc.): log full
      // detail server-side only. The user-facing card is always the
      // generic message — never the raw error, which could leak internal
      // details (connection strings, stack traces, etc.). `no-console` is
      // only a warn in this repo's eslint config; this app has no pino
      // logger wired yet (tracked separately from this task).
      console.error("KbBot: unexpected error handling message", error);
      await context.sendActivity({
        attachments: [errorCard(GENERIC_ERROR_MESSAGE)],
      });
    }
  }
}

/** Production `getMemberOids`: the full member roster of the current
 * channel/groupChat via the real Teams/Graph-backed SDK call, mapped to
 * `aadObjectId` and excluding any falsy (guest/unresolved) entries. */
export function createTeamsGetMemberOids(): (
  context: TurnContext,
) => Promise<string[]> {
  return async (context: TurnContext): Promise<string[]> => {
    const members: TeamsChannelAccount[] = await TeamsInfo.getMembers(context);
    return members
      .map((member) => member.aadObjectId)
      .filter((id): id is string => Boolean(id));
  };
}

/**
 * Builds the production `BotDeps`, wired to the real SSO exchange
 * (`auth.ts`), the real DB-backed scope resolvers + signer (`scope.ts`),
 * the real RAG API client (`rag-client.ts`), and the real Teams member
 * roster lookup above.
 *
 * `resolveScope` intentionally does NOT call `scope.ts`'s `mintScopeToken`
 * itself — that would resolve the source-ids twice (once here to check for
 * "empty", once again inside `mintScopeToken`). Instead it reuses the same
 * `resolveForUser`/`resolveShared`/`sign` primitives `mintScopeToken` calls
 * internally, producing an identical token with a single DB round trip.
 * `scope.ts`'s own `mintScopeToken` export is untouched.
 */
export function createProductionBotDeps(config: BotConfig): BotDeps {
  const authDeps = createProductionAuthDeps(config.botSsoScope);
  const scopeDeps = createProductionScopeDeps(config);

  return {
    resolveUserOid: (context) => resolveUserOid(context, authDeps),
    getMemberOids: createTeamsGetMemberOids(),
    resolveScope: async (input) => {
      const allowedSourceIds =
        input.conversationKind === "dm"
          ? await scopeDeps.resolveForUser(scopeDeps.db, input.askerOid)
          : await scopeDeps.resolveShared(scopeDeps.db, input.memberOids);

      const token = await scopeDeps.sign({
        sub: input.askerOid,
        allowedSourceIds,
      });

      return { token, allowedSourceIds };
    },
    askKb: (input) => askKb(input, { ragApiUrl: config.ragApiUrl, fetch }),
  };
}
