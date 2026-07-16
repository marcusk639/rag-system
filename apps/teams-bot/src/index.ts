import express from "express";
import type { Request, Response } from "express";
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
} from "botbuilder";
import { loadBotConfig } from "./config.js";
import { KbBot, createProductionBotDeps } from "./bot.js";
import { errorCard } from "./cards.js";

/**
 * Entry point for the Teams KB bot. Reads config from env, builds the
 * Bot Framework `CloudAdapter` + `KbBot`, and exposes the two HTTP surfaces
 * Teams/Azure need: `POST /api/messages` (the Bot Framework channel
 * endpoint) and `GET /health` (Railway/compose healthcheck).
 *
 * `CloudAdapter` + `ConfigurationBotFrameworkAuthentication` +
 * `ConfigurationServiceClientCredentialFactory` construction confirmed
 * against the INSTALLED botbuilder@4.23.3 package (not guessed from memory):
 * both `Configuration*` classes are defined in `botbuilder-core` and
 * re-exported through `botbuilder`'s `export * from 'botbuilder-core'`
 * (see node_modules/.pnpm/botbuilder-core@4.23.3/.../lib/index.d.ts lines
 * 22-23), so importing them from `"botbuilder"` is correct. `MicrosoftAppType`
 * is hardcoded to `"SingleTenant"` because `loadBotConfig` (config.ts)
 * requires `MICROSOFT_APP_TENANT_ID` unconditionally — this app is only ever
 * deployed against a single-tenant Entra app registration (see the Azure
 * deploy runbook), never a multi-tenant one.
 */

const config = loadBotConfig(process.env);

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: config.microsoftAppId,
  MicrosoftAppPassword: config.microsoftAppPassword,
  MicrosoftAppType: "SingleTenant",
  MicrosoftAppTenantId: config.microsoftAppTenantId,
});

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
  {},
  credentialsFactory,
);

const adapter = new CloudAdapter(botFrameworkAuthentication);

// Catches anything that escapes KbBot's own try/catch in bot.ts (e.g. an
// error thrown by botbuilder's own turn pipeline before/after the handler
// runs). Never leak the raw error to the user — always the generic card.
adapter.onTurnError = async (context, error) => {
  console.error("Teams bot: unhandled turn error", error);
  try {
    await context.sendActivity({
      attachments: [errorCard("Something went wrong.")],
    });
  } catch (sendError) {
    console.error("Teams bot: failed to send error card", sendError);
  }
};

const bot = new KbBot(createProductionBotDeps(config));

const app = express();
// Required by CloudAdapter.process: it expects `req.body` to already be a
// parsed object and returns 400 otherwise (confirmed against the installed
// botbuilder@4.23.3 source — node_modules/botbuilder/lib/cloudAdapter.js,
// the "Ensure we have a parsed request body already" check).
app.use(express.json());

app.post("/api/messages", async (req: Request, res: Response) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.listen(config.port, () => {
  console.log(`Teams bot listening on port ${config.port}`);
});
