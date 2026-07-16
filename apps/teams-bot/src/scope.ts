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
 * computes `allowedSourceIds` — see `mintScopeToken` below.
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
 * Injectable dependencies for `mintScopeToken`. Production wiring is
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

/**
 * Mints a short-lived scope-assertion token for the RAG API, choosing the
 * asker's full personal scope (DM) or the channel members' shared scope
 * (channel) as the token's `allowedSourceIds`.
 *
 * COMPLIANCE-CRITICAL: in a `"channel"` conversation, the asker's private
 * grants (`resolveForUser`) are NEVER consulted — only the shared/intersection
 * scope (`resolveShared`) goes into the signed token. A channel answer must
 * never expose content a fellow channel member lacks access to, so the
 * asker's own broader grants would be a confidentiality leak if used here.
 *
 * Fails closed: if either resolver or `sign` throws, this throws too — there
 * is no fallback scope. A DB error must never be swallowed into an
 * unrestricted (or arbitrarily restricted) token.
 */
export async function mintScopeToken(
  input: MintScopeTokenInput,
  deps: MintScopeTokenDeps,
): Promise<string> {
  const allowedSourceIds =
    input.conversationKind === "dm"
      ? await deps.resolveForUser(deps.db, input.askerOid)
      : await deps.resolveShared(deps.db, input.memberOids);

  return deps.sign({ sub: input.askerOid, allowedSourceIds });
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
