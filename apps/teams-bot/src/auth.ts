import type { Activity, Attachment, TurnContext } from "botbuilder";
import { CardFactory } from "botbuilder";
import { decodeJwt } from "jose";

/**
 * Thrown whenever the bot cannot obtain a verified Entra `oid` for the
 * current Teams user via SSO. This is the fail-closed signal: callers must
 * treat it as "no identity available" and stop (send the sign-in card),
 * never fall back to a different identifier (email/UPN) or proceed
 * unauthenticated.
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
  /** Retrieves the user's SSO token from the Bot Framework token service for
   * the current turn (production: `UserTokenClient.getUserToken`), or `null`
   * if the user has no token yet (SSO handshake not completed / consent not
   * granted) — the caller must then send a sign-in card and stop. */
  getUserToken(context: TurnContext): Promise<string | null>;
  /** Extracts the `oid` claim from a JWT, or `null` if absent/unparseable. */
  decodeOid(jwt: string): string | null;
}

/**
 * Resolves the verified Entra `oid` for the Teams user driving the current
 * message turn. Fails closed: any missing token or missing `oid` claim throws
 * `SsoRequiredError` rather than returning a fallback identifier (email/UPN
 * are never acceptable substitutes — see spec §2).
 */
export async function resolveUserOid(
  context: TurnContext,
  deps: AuthDeps,
): Promise<string> {
  const token = await deps.getUserToken(context);
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
// Production AuthDeps — the standard botbuilder 4.23.3 Teams SSO flow
// ---------------------------------------------------------------------------

/**
 * Minimal structural shape of the CloudAdapter-era token client
 * (`UserTokenClient`, `botframework-connector`). That abstract class lives in
 * a transitive dependency of `botbuilder` and is not re-exported by it, so we
 * duck-type the three methods we call rather than adding a direct dependency
 * on `botframework-connector`.
 *
 * Every signature below is confirmed against the INSTALLED
 * botframework-connector@4.23.3 declarations:
 *   node_modules/botframework-connector/lib/auth/userTokenClient.d.ts
 *     - getUserToken(userId, connectionName, channelId, magicCode)
 *         → Promise<TokenResponse>            (TokenResponse.token: string)
 *     - getSignInResource(connectionName, activity, finalRedirect)
 *         → Promise<SignInUrlResponse>        ({ signInLink?, tokenExchangeResource?, tokenPostResource? })
 *     - exchangeToken(userId, connectionName, channelId, exchangeRequest)
 *         → Promise<TokenResponse>            (exchangeRequest: { token?: string; uri?: string })
 *
 * `connectionName` in all three is the Azure Bot resource's OAuth
 * *connection setting name* (`BOT_OAUTH_CONNECTION_NAME`) — NOT the SSO
 * scope URI (`BOT_ENTRA_SSO_SCOPE`).
 */
export interface MinimalUserTokenClient {
  getUserToken(
    userId: string,
    connectionName: string,
    channelId: string,
    magicCode: string,
  ): Promise<{ token?: string } | undefined>;
  getSignInResource(
    connectionName: string,
    activity: Activity,
    finalRedirect: string,
  ): Promise<
    | {
        signInLink?: string;
        tokenExchangeResource?: Record<string, unknown>;
        tokenPostResource?: Record<string, unknown>;
      }
    | undefined
  >;
  exchangeToken(
    userId: string,
    connectionName: string,
    channelId: string,
    exchangeRequest: { token: string },
  ): Promise<{ token?: string } | undefined>;
}

/**
 * Fetches the turn's `UserTokenClient` the same way botbuilder's own
 * `TeamsSSOTokenExchangeMiddleware.exchangedToken` does (confirmed against
 * the installed node_modules/botbuilder/lib/teams/teamsSSOTokenExchangeMiddleware.js):
 *
 *   context.turnState.get(context.adapter.UserTokenClientKey)
 *
 * `UserTokenClientKey` is declared on `CloudAdapterBase`
 * (node_modules/botbuilder-core/lib/cloudAdapterBase.d.ts) but not on the
 * `BotAdapter` base type `context.adapter` is typed as, hence the structural
 * cast. Returns `null` when the adapter isn't a CloudAdapter (e.g. the unit
 * tests' `TestAdapter`) — callers treat that as "no token available",
 * i.e. fail closed.
 */
export function getUserTokenClient(
  context: TurnContext,
): MinimalUserTokenClient | null {
  const adapter = context.adapter as unknown as {
    UserTokenClientKey?: symbol;
  };
  const key = adapter.UserTokenClientKey;
  if (!key) {
    return null;
  }
  const client = context.turnState.get(key) as
    MinimalUserTokenClient | undefined;
  return client ?? null;
}

/**
 * Production `AuthDeps.getUserToken`: asks the Bot Framework token service
 * whether it already holds a token for this user + OAuth connection
 * (`UserTokenClient.getUserToken(userId, connectionName, channelId, "")` —
 * empty magicCode, per the signature above). Returns `null` (never throws)
 * when no token exists yet, so `resolveUserOid` fails closed into the
 * sign-in-card path.
 */
export function createSsoTokenGetter(
  connectionName: string,
): (context: TurnContext) => Promise<string | null> {
  return async (context: TurnContext): Promise<string | null> => {
    const fromId = context.activity.from?.id;
    const channelId = context.activity.channelId;
    if (!fromId || !channelId) {
      return null;
    }
    const client = getUserTokenClient(context);
    if (!client) {
      return null;
    }
    try {
      const response = await client.getUserToken(
        fromId,
        connectionName,
        channelId,
        "",
      );
      return response?.token ?? null;
    } catch {
      // Token-service errors (including "no token for user") must land on
      // the sign-in path, never bubble into an answered turn.
      return null;
    }
  };
}

/**
 * Production token-exchange for the `signin/tokenExchange` invoke: redeems
 * the SSO token the Teams client posted (`activity.value.token`) via
 * `UserTokenClient.exchangeToken(userId, connectionName, channelId, { token })`.
 * If the exchange fails because `TeamsSSOTokenExchangeMiddleware` already
 * redeemed the same token earlier in this turn's pipeline, the exchanged
 * token is by then cached in the token service, so we fall back to
 * `getUserToken` before giving up. Returns `null` on any failure — the
 * caller must fail closed (sign-in card, no answer).
 */
export function createSsoTokenExchanger(
  connectionName: string,
): (context: TurnContext, ssoToken: string) => Promise<string | null> {
  const getToken = createSsoTokenGetter(connectionName);
  return async (
    context: TurnContext,
    ssoToken: string,
  ): Promise<string | null> => {
    const fromId = context.activity.from?.id;
    const channelId = context.activity.channelId;
    if (!fromId || !channelId || !ssoToken) {
      return null;
    }
    const client = getUserTokenClient(context);
    if (!client) {
      return null;
    }
    try {
      const response = await client.exchangeToken(
        fromId,
        connectionName,
        channelId,
        { token: ssoToken },
      );
      if (response?.token) {
        return response.token;
      }
    } catch {
      // Fall through to getUserToken below.
    }
    return getToken(context);
  };
}

const SIGN_IN_CARD_TITLE = "Sign in";
const SIGN_IN_CARD_TEXT =
  "Please sign in so the knowledge base bot can verify your access.";

/**
 * Builds the OAuthCard that starts the Teams SSO handshake, per the
 * standard flow: `UserTokenClient.getSignInResource(connectionName,
 * activity, "")` yields the sign-in link + `tokenExchangeResource`, and
 * `CardFactory.oauthCard(connectionName, title, text, link,
 * tokenExchangeResource, tokenPostResource)` (signature confirmed against
 * node_modules/botbuilder-core/lib/cardFactory.d.ts:152) wraps them in the
 * card Teams needs to silently post the `signin/tokenExchange` invoke back
 * (or show the sign-in button when silent SSO needs consent).
 *
 * Throws when no `UserTokenClient` is available — the caller maps that to
 * an error card; it must never answer.
 */
export function createSignInCardFactory(
  connectionName: string,
): (context: TurnContext) => Promise<Attachment> {
  return async (context: TurnContext): Promise<Attachment> => {
    const client = getUserTokenClient(context);
    if (!client) {
      throw new SsoRequiredError(
        "No UserTokenClient available to build a sign-in card.",
      );
    }
    const resource = await client.getSignInResource(
      connectionName,
      context.activity,
      "",
    );
    return CardFactory.oauthCard(
      connectionName,
      SIGN_IN_CARD_TITLE,
      SIGN_IN_CARD_TEXT,
      resource?.signInLink,
      // CardFactory.oauthCard types these as TokenExchangeResource /
      // TokenPostResource; the duck-typed client surfaces them opaquely.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque pass-through of SDK-sourced resources
      resource?.tokenExchangeResource as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque pass-through of SDK-sourced resources
      resource?.tokenPostResource as any,
    );
  };
}

/**
 * Decodes (never verifies) the `oid` claim from a JWT. Signature
 * verification is intentionally skipped: this token came directly from the
 * trusted SDK token-service calls above (`UserTokenClient.getUserToken` /
 * `exchangeToken`), not from an untrusted external source, so we only need
 * to read a claim, not re-authenticate the token.
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

/** Builds the production `AuthDeps` wired to the real Bot Framework SDK.
 * `connectionName` is the Azure Bot OAuth connection setting name
 * (`BOT_OAUTH_CONNECTION_NAME`). */
export function createProductionAuthDeps(connectionName: string): AuthDeps {
  return {
    getUserToken: createSsoTokenGetter(connectionName),
    decodeOid: decodeOidFromJwt,
  };
}
