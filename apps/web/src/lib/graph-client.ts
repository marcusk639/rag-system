/**
 * Microsoft Graph client-credentials helper, reusing the existing
 * MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET already configured for the
 * SharePoint/Outlook connectors (application permissions, no user present —
 * this is the correct reuse; contrast with Task 8's SEPARATE delegated app
 * registration for user sign-in). Used for the admin UI's email->oid lookup
 * and the Entra ID "groups overage" membership-check fallback.
 *
 * API contract verified against Microsoft's live v1.0 reference docs
 * (learn.microsoft.com) before implementing:
 *
 * - `GET /users/{id | userPrincipalName}` — confirmed current; returns
 *   `404 Not Found` when the user doesn't exist (see "Get user" reference).
 * - Group membership: the plan's draft placeholder (`GET
 *   /groups/{id}/members/{id}/$ref` returning a boolean-ish `{ value }`
 *   body) does NOT match a documented Graph operation — `$ref` on the
 *   `members` collection is documented only for POST (add a member) and
 *   DELETE (remove a specific member), not a targeted GET existence check.
 *   The correct, documented, purpose-built operation is `directoryObject:
 *   checkMemberGroups` — `POST /users/{id}/checkMemberGroups` with a
 *   `{ groupIds: string[] }` body (max 20 per call), returning `200 OK` with
 *   `{ value: string[] }`: the SUBSET of the input `groupIds` that the user
 *   is actually (transitively) a member of. `isUserInGroup` below uses that
 *   real shape — checking membership in a single group means passing a
 *   one-element `groupIds` array and testing whether it comes back in
 *   `value`.
 */

interface GraphTokenResponse {
  access_token: string;
  expires_in: number;
}

/** In-memory cache for Graph access token: { token, expiresAt } */
let tokenCache: { token: string; expiresAt: number } | null = null;

/** Safety margin (seconds) to treat token as expired before actual expiry.
 * Prevents a race where a cached token expires mid-request. */
const TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS = 60;

async function getGraphAccessToken(): Promise<string> {
  // Return cached token if valid
  if (tokenCache && tokenCache.expiresAt > Date.now() / 1000) {
    return tokenCache.token;
  }

  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "MS_TENANT_ID, MS_CLIENT_ID, and MS_CLIENT_SECRET must all be set for Graph API access.",
    );
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to acquire Graph access token: ${res.status}`);
  }
  const body = (await res.json()) as GraphTokenResponse;

  // Cache the token with expiry time, applying safety margin
  const expiresAt =
    Date.now() / 1000 + body.expires_in - TOKEN_EXPIRY_SAFETY_MARGIN_SECONDS;
  tokenCache = { token: body.access_token, expiresAt };

  return body.access_token;
}

/** Resolve a staff member's email to their AAD object id, or null if not found. */
export async function resolveOidByEmail(email: string): Promise<string | null> {
  const token = await getGraphAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Graph user lookup failed: ${res.status}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Shape of the `directoryObject: checkMemberGroups` response — see
 * https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups
 * `value` is the subset of the requested `groupIds` that the object is
 * actually a member of (transitively), NOT a boolean. */
interface CheckMemberGroupsResponse {
  value: string[];
}

/**
 * Check a user's membership in a specific group via Graph's documented
 * `checkMemberGroups` action (`POST /users/{id}/checkMemberGroups`), passing
 * a single-element `groupIds` array and testing whether `groupId` comes back
 * in the response's `value` array. Used as the "groups overage" fallback
 * (see admin-check.ts) when the ID token didn't carry inline group claims.
 */
export async function isUserInGroup(
  oid: string,
  groupId: string,
): Promise<boolean> {
  const token = await getGraphAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(oid)}/checkMemberGroups`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groupIds: [groupId] }),
    },
  );
  if (!res.ok) {
    throw new Error(`Graph group membership check failed: ${res.status}`);
  }
  const body = (await res.json()) as CheckMemberGroupsResponse;
  return body.value.includes(groupId);
}
