# Teams app manifest

`manifest.json` is a template, not a ready-to-upload package. It uses
`${...}` placeholders for values that only exist once the Azure Bot resource
and Entra app registration are provisioned:

| Placeholder                     | Filled with                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `${MICROSOFT_APP_ID}`           | The bot's Entra application (client) ID — same value as `MICROSOFT_APP_ID` in the bot's env.                             |
| `${BOT_ENTRA_SSO_SCOPE}`        | The bot's exposed API scope for Teams SSO, e.g. `api://botid-<id>/access_as_user` — same value as `BOT_ENTRA_SSO_SCOPE`. |
| `${DEVELOPER_NAME}`             | The firm/org name to show in the Teams app catalog entry.                                                                |
| `${DEVELOPER_WEBSITE_URL}`      | A real, reachable HTTPS URL (Teams validates this at upload time).                                                       |
| `${DEVELOPER_PRIVACY_URL}`      | A real, reachable HTTPS URL.                                                                                             |
| `${DEVELOPER_TERMS_OF_USE_URL}` | A real, reachable HTTPS URL.                                                                                             |

## Packaging (human/infra step)

This is intentionally **not automated** — it happens once per environment,
after the Azure Bot resource + Entra app registration exist, as part of the
companion Azure deploy runbook:

1. Substitute every `${...}` placeholder above with the real values (e.g.
   `envsubst < manifest.json > manifest.rendered.json`, or by hand).
2. Zip `manifest.rendered.json` (renamed to `manifest.json`) together with
   `color.png` and `outline.png` into a single `.zip` — no subfolders.
3. Upload the zip via Teams Admin Center ("Manage apps" → "Upload new app")
   or `teams app package` (Teams Toolkit CLI) for org-wide/tenant
   deployment, or sideload it directly for testing.

## Icons

`color.png` (192×192) and `outline.png` (32×32) checked in here are
**structural placeholders** — a solid brand-purple square and a plain white
circle-on-transparent-background, respectively. They satisfy Teams' schema
validation (correct dimensions, correct transparency convention for the
outline icon) but are not real branding. Replacing them with the firm's
actual logo assets is a human/design step, tracked in the Azure deploy
runbook alongside the placeholder substitution above.

## Scopes

The bot is registered for all three conversation scopes the design spec
requires: `personal` (DMs — full personal-grant scope), `team`/`groupChat`
(channel scope — the isolation-critical intersection of every member's
grants; see `src/scope.ts`'s `mintScope`). `supportsFiles` is `false` — file
upload/consumption is out of scope for v1.

`webApplicationInfo` wires Teams SSO: Teams silently exchanges its own token
for one scoped to `resource` (the bot's exposed API scope), which the bot
then exchanges again for a Graph-capable AAD token via
`UserTokenClient.exchangeToken` (see `src/auth.ts`).
