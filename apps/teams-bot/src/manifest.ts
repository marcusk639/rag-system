const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * `api://botid-<guid>/<scope>`, with the optional domain segment Teams allows
 * when the app also exposes a tab. The GUID is captured so it can be compared
 * to MICROSOFT_APP_ID directly — a substring check would accept it embedded in
 * a longer GUID or an entirely wrong host.
 */
const SSO_SCOPE =
  /^api:\/\/(?:[A-Za-z0-9.-]+\/)?botid-([0-9a-f-]+)\/[A-Za-z0-9_.-]+$/i;

/**
 * Fills the Teams app manifest template from a set of values.
 *
 * Every check here exists because the failure it prevents is silent: Teams
 * accepts a manifest whose ids are merely well-formed, and the bot then
 * authenticates nobody — the symptom (a sign-in card in reply to every
 * message) points at the OAuth connection, not at the id that is actually
 * wrong. See `manifest/README.md`.
 */
export function renderManifest(
  template: string,
  values: Record<string, string | undefined>,
): string {
  const required = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) required.add(match[1]!);

  const missing = [...required].filter((name) => !values[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Teams manifest is missing values for: ${missing.join(", ")}. ` +
        `Set them in the environment (see apps/teams-bot/manifest/README.md).`,
    );
  }

  const appId = values.MICROSOFT_APP_ID?.trim();
  if (required.has("MICROSOFT_APP_ID") && !GUID.test(appId!)) {
    throw new Error(
      `MICROSOFT_APP_ID must be a bare GUID, got "${appId}". ` +
        `Do not include the "botid-" prefix — that belongs only inside the SSO scope URI.`,
    );
  }

  const scope = values.BOT_ENTRA_SSO_SCOPE?.trim();
  if (required.has("BOT_ENTRA_SSO_SCOPE") && appId) {
    // GUIDs are case-insensitive, and the two values are pasted from different
    // Azure blades — comparing them raw rejects correct configurations.
    const scopeGuid = SSO_SCOPE.exec(scope!)?.[1];
    if (scopeGuid?.toLowerCase() !== appId.toLowerCase()) {
      throw new Error(
        `BOT_ENTRA_SSO_SCOPE ("${scope}") must be "api://botid-${appId}/access_as_user". ` +
          `Teams SSO silently fails when the exposed scope belongs to a different app registration.`,
      );
    }
  }

  return template.replace(PLACEHOLDER, (_match, name: string) =>
    jsonStringBody(values[name]!.trim()),
  );
}

/**
 * Escapes a value for substitution inside a JSON string literal.
 *
 * Every placeholder in the manifest template sits inside a JSON string, and a
 * raw substitution lets a value close that string and add its own keys. That is
 * not theoretical: a `DEVELOPER_NAME` of `ACME"},"id":"NOT-A-GUID","pad":{"z":"`
 * renders to *valid* JSON whose top-level `id` is `NOT-A-GUID` — the GUID check
 * above passes and the manifest ships wrong anyway, which is the exact silent
 * failure the rest of this file exists to prevent. A stray quote in a firm's
 * name reaches the same place by accident.
 */
function jsonStringBody(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
