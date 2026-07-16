import type { TurnContext } from "botbuilder";
import { Channels, tokenExchangeOperationName } from "botbuilder";
import { decodeJwt } from "jose";

/**
 * Thrown whenever the bot cannot obtain a verified Entra `oid` for the
 * current Teams user via SSO. This is the fail-closed signal: callers must
 * treat it as "no identity available" and stop, never fall back to a
 * different identifier (email/UPN) or proceed unauthenticated.
 */
export class SsoRequiredError extends Error {
  constructor(message = "Teams SSO sign-in is required to continue.") {
    super(message);
    this.name = "SsoRequiredError";
  }
}

/**
 * SDK-agnostic dependencies for `resolveUserOid`. Both are injectable so the
 * resolution logic can be tested without touching the real Bot Framework SDK
 * or performing an actual JWT decode.
 */
export interface AuthDeps {
  /** Exchanges the current turn's SSO artifact for a raw AAD JWT, or `null`
   * if no token is available (e.g. this activity isn't a token-exchange
   * invoke, or the exchange failed/requires consent). */
  exchangeToken(context: TurnContext): Promise<string | null>;
  /** Extracts the `oid` claim from a JWT, or `null` if absent/unparseable. */
  decodeOid(jwt: string): string | null;
}

/**
 * Resolves the verified Entra `oid` for the Teams user driving the current
 * turn. Fails closed: any missing token or missing `oid` claim throws
 * `SsoRequiredError` rather than returning a fallback identifier (email/UPN
 * are never acceptable substitutes — see spec §2).
 */
export async function resolveUserOid(
  context: TurnContext,
  deps: AuthDeps,
): Promise<string> {
  const token = await deps.exchangeToken(context);
  if (!token) {
    throw new SsoRequiredError();
  }

  const oid = deps.decodeOid(token);
  if (!oid) {
    throw new SsoRequiredError();
  }

  return oid;
}

// ---------------------------------------------------------------------------
// Production AuthDeps
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of the CloudAdapter-era token-exchange client
 * (`UserTokenClient` from `botframework-connector`). That class lives in a
 * transitive dependency of `botbuilder` and is not re-exported by it, so we
 * duck-type the one method we call rather than adding a direct dependency on
 * `botframework-connector` — this mirrors what botbuilder's own
 * `TeamsSSOTokenExchangeMiddleware` does internally (see comment below).
 */
interface MinimalUserTokenClient {
  exchangeToken(
    userId: string,
    connectionName: string,
    channelId: string,
    exchangeRequest: { token: string },
  ): Promise<{ token?: string } | undefined>;
}

/**
 * Confirmed against the INSTALLED botbuilder@4.23.3 package (not just its
 * `.d.ts` — the actual shipped JS), specifically:
 *
 *   node_modules/botbuilder/lib/teams/teamsSSOTokenExchangeMiddleware.js
 *   (method `exchangedToken`)
 *
 * That is Microsoft's own SDK implementation of the Teams SSO token
 * exchange for CloudAdapter-based bots (the current, non-deprecated
 * adapter), so the call below mirrors the SDK's own code path rather than a
 * sample or a guess:
 *
 *   const userTokenClient = context.turnState.get(adapter.UserTokenClientKey);
 *   const response = await userTokenClient.exchangeToken(
 *     context.activity.from.id,
 *     connectionName,
 *     context.activity.channelId,
 *     { token: <ssoTokenFromInvokeActivity> },
 *   );
 *   // response.token is the exchanged AAD JWT, which carries the `oid` claim.
 *
 * This path is only reachable on a Teams `signin/tokenExchange` invoke
 * activity (`Channels.Msteams` + `tokenExchangeOperationName`), whose
 * `activity.value.token` is the raw SSO token the Teams client obtained
 * silently and is offering up for exchange.
 */
export function createTeamsSsoTokenExchanger(
  connectionName: string,
): (context: TurnContext) => Promise<string | null> {
  return async (context: TurnContext): Promise<string | null> => {
    if (
      context.activity.channelId !== Channels.Msteams ||
      context.activity.name !== tokenExchangeOperationName
    ) {
      return null;
    }

    const invokeValue = context.activity.value as
      { token?: string } | undefined;
    if (!invokeValue?.token) {
      return null;
    }

    const fromId = context.activity.from?.id;
    if (!fromId) {
      return null;
    }

    const adapterWithUserTokenClientKey = context.adapter as unknown as {
      UserTokenClientKey?: symbol;
    };
    const userTokenClientKey = adapterWithUserTokenClientKey.UserTokenClientKey;
    if (!userTokenClientKey) {
      return null;
    }

    const userTokenClient = context.turnState.get(userTokenClientKey) as
      MinimalUserTokenClient | undefined;
    if (!userTokenClient) {
      return null;
    }

    const tokenResponse = await userTokenClient.exchangeToken(
      fromId,
      connectionName,
      context.activity.channelId,
      { token: invokeValue.token },
    );

    return tokenResponse?.token ?? null;
  };
}

/**
 * Decodes (never verifies) the `oid` claim from a JWT. Signature
 * verification is intentionally skipped: this token came directly from the
 * trusted SDK token-exchange call above (`UserTokenClient.exchangeToken`),
 * not from an untrusted external source, so we only need to read a claim,
 * not re-authenticate the token.
 */
export function decodeOidFromJwt(jwt: string): string | null {
  try {
    const claims = decodeJwt(jwt);
    const oid = claims.oid;
    return typeof oid === "string" && oid.length > 0 ? oid : null;
  } catch {
    return null;
  }
}

/** Builds the production `AuthDeps` wired to the real Bot Framework SDK. */
export function createProductionAuthDeps(connectionName: string): AuthDeps {
  return {
    exchangeToken: createTeamsSsoTokenExchanger(connectionName),
    decodeOid: decodeOidFromJwt,
  };
}
