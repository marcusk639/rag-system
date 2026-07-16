import type { Db } from "@rag/db";
import {
  resolveSharedSourceIdsForUsers,
  resolveSourceIdsForUser,
} from "@rag/db";
import {
  signInternalScopeToken,
  type InternalScopeTokenPayload,
} from "@rag/core";
import type { BotConfig } from "./config.js";
import { getBotDb } from "./db.js";

/**
 * Which flavor of Teams conversation the asker is in. Drives which resolver
 * computes `allowedSourceIds` — see `mintScope` below.
 */
export interface MintScopeTokenInput {
  /** The verified Entra `oid` of the user asking the question. */
  askerOid: string;
  conversationKind: "dm" | "channel";
  /**
   * The `oid`s of every member of the conversation. For a DM this is
   * typically just `[askerOid]`; for a channel it's the full member roster.
   * Only consulted in the `"channel"` branch — see `resolveShared` below.
   */
  memberOids: string[];
}

/**
 * Injectable dependencies for `mintScope`. Production wiring is
 * `createProductionScopeDeps` below; tests supply fakes/spies directly so the
 * DM/channel branching and the isolation guarantee can be verified without a
 * live DB or a real signed JWT.
 */
export interface MintScopeTokenDeps {
  db: Db;
  secret: string;
  /** Resolves the source-ids a single user has a direct/client-routed grant
   * to. Used ONLY for `"dm"` conversations. */
  resolveForUser: (db: Db, userId: string) => Promise<string[]>;
  /** Resolves the source-ids EVERY listed member has a grant to (minus
   * client-confidential sources). Used ONLY for `"channel"` conversations. */
  resolveShared: (db: Db, userIds: string[]) => Promise<string[]>;
  sign: (payload: InternalScopeTokenPayload) => Promise<string>;
}

/** Result of `mintScope`: the signed token PLUS the source-ids it grants.
 * Callers that only need the opaque token for the RAG API can ignore
 * `allowedSourceIds`; callers that also need to short-circuit an
 * empty-scope case (see `bot.ts`'s `resolveScope`) get it from the same
 * single resolution, instead of re-deriving it with a second branch. */
export interface MintScopeResult {
  token: string;
  allowedSourceIds: string[];
}

/**
 * Mints a short-lived scope-assertion token for the RAG API, choosing the
 * asker's full personal scope (DM) or the channel members' shared scope
 * (channel) as the token's `allowedSourceIds`. Returns both the signed
 * token and the resolved `allowedSourceIds`.
 *
 * COMPLIANCE-CRITICAL: in a `"channel"` conversation, the asker's private
 * grants (`resolveForUser`) are NEVER consulted — only the shared/intersection
 * scope (`resolveShared`) goes into the signed token. A channel answer must
 * never expose content a fellow channel member lacks access to, so the
 * asker's own broader grants would be a confidentiality leak if used here.
 *
 * This is the ONLY place in the app that branches on `conversationKind` to
 * pick a resolver. Every other caller (e.g. `bot.ts`'s production
 * `resolveScope`) MUST delegate here rather than re-implementing the
 * branch — a second copy is how the channel-leak regression happens: an
 * edit to this branch that isn't mirrored elsewhere silently reintroduces
 * the asker's personal grants into a channel answer.
 *
 * Fails closed: if either resolver or `sign` throws, this throws too — there
 * is no fallback scope. A DB error must never be swallowed into an
 * unrestricted (or arbitrarily restricted) token.
 */
export async function mintScope(
  input: MintScopeTokenInput,
  deps: MintScopeTokenDeps,
): Promise<MintScopeResult> {
  const allowedSourceIds =
    input.conversationKind === "dm"
      ? await deps.resolveForUser(deps.db, input.askerOid)
      : await deps.resolveShared(deps.db, input.memberOids);

  const token = await deps.sign({ sub: input.askerOid, allowedSourceIds });

  return { token, allowedSourceIds };
}

/**
 * Builds the production `MintScopeTokenDeps`, wired to the real DB
 * connection (`getBotDb`), the real grant-resolution queries from `@rag/db`,
 * and the real HS256 signer (`signInternalScopeToken`) using the bot's
 * validated `internalScopeJwtSecret`.
 */
export function createProductionScopeDeps(
  config: BotConfig,
): MintScopeTokenDeps {
  return {
    db: getBotDb(),
    secret: config.internalScopeJwtSecret,
    resolveForUser: resolveSourceIdsForUser,
    resolveShared: resolveSharedSourceIdsForUsers,
    sign: (payload) =>
      signInternalScopeToken(payload, config.internalScopeJwtSecret),
  };
}
