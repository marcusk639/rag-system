const PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (required.has("BOT_ENTRA_SSO_SCOPE") && appId && !scope!.includes(appId)) {
    throw new Error(
      `BOT_ENTRA_SSO_SCOPE ("${scope}") does not contain MICROSOFT_APP_ID ("${appId}"). ` +
        `Teams SSO silently fails when the exposed scope belongs to a different app registration.`,
    );
  }

  return template.replace(PLACEHOLDER, (_match, name: string) =>
    values[name]!.trim(),
  );
}
