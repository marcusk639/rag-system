import { z } from "zod";

const envSchema = z.object({
  MICROSOFT_APP_ID: z.string().min(1, "MICROSOFT_APP_ID is required"),
  MICROSOFT_APP_PASSWORD: z
    .string()
    .min(1, "MICROSOFT_APP_PASSWORD is required"),
  MICROSOFT_APP_TENANT_ID: z
    .string()
    .min(1, "MICROSOFT_APP_TENANT_ID is required"),
  BOT_ENTRA_SSO_SCOPE: z.string().min(1, "BOT_ENTRA_SSO_SCOPE is required"),
  BOT_OAUTH_CONNECTION_NAME: z
    .string()
    .min(1, "BOT_OAUTH_CONNECTION_NAME is required"),
  INTERNAL_SCOPE_JWT_SECRET: z
    .string()
    .min(64, "INTERNAL_SCOPE_JWT_SECRET must be at least 64 characters"),
  RAG_API_URL: z.string().url("RAG_API_URL must be a valid URL"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z.enum(["disable", "require", "no-verify"]).optional(),
  PORT: z.coerce.number().int().positive().default(3978),
});

export interface BotConfig {
  microsoftAppId: string;
  microsoftAppPassword: string;
  microsoftAppTenantId: string;
  botSsoScope: string;
  /**
   * The Azure Bot resource's OAuth connection *setting name* (Azure Bot →
   * Settings → Configuration → OAuth Connection Settings). This is what the
   * Bot Framework token service keys `getUserToken`/`getSignInResource`/
   * `exchangeToken` calls on — it is NOT the SSO scope URI
   * (`BOT_ENTRA_SSO_SCOPE`), which is a property configured *inside* that
   * connection setting.
   */
  botOauthConnectionName: string;
  internalScopeJwtSecret: string;
  ragApiUrl: string;
  databaseUrl: string;
  databaseSsl: "disable" | "require" | "no-verify" | undefined;
  port: number;
}

/**
 * Validates the Teams bot's environment and returns a typed, normalized
 * `BotConfig`. Fails loud: throws a single error naming the first
 * missing/invalid variable rather than silently defaulting or continuing
 * with a partially-configured bot.
 */
export function loadBotConfig(env: NodeJS.ProcessEnv): BotConfig {
  const candidate = {
    MICROSOFT_APP_ID: env.MICROSOFT_APP_ID,
    MICROSOFT_APP_PASSWORD: env.MICROSOFT_APP_PASSWORD,
    MICROSOFT_APP_TENANT_ID: env.MICROSOFT_APP_TENANT_ID,
    BOT_ENTRA_SSO_SCOPE: env.BOT_ENTRA_SSO_SCOPE,
    BOT_OAUTH_CONNECTION_NAME: env.BOT_OAUTH_CONNECTION_NAME,
    INTERNAL_SCOPE_JWT_SECRET: env.INTERNAL_SCOPE_JWT_SECRET,
    RAG_API_URL: env.RAG_API_URL,
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_SSL: env.DATABASE_SSL,
    PORT: env.PORT ?? 3978,
  };

  const result = envSchema.safeParse(candidate);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") ?? "config";
    throw new Error(
      `Invalid teams-bot configuration: ${path}: ${first?.message}`,
    );
  }

  const parsed = result.data;

  return {
    microsoftAppId: parsed.MICROSOFT_APP_ID,
    microsoftAppPassword: parsed.MICROSOFT_APP_PASSWORD,
    microsoftAppTenantId: parsed.MICROSOFT_APP_TENANT_ID,
    botSsoScope: parsed.BOT_ENTRA_SSO_SCOPE,
    botOauthConnectionName: parsed.BOT_OAUTH_CONNECTION_NAME,
    internalScopeJwtSecret: parsed.INTERNAL_SCOPE_JWT_SECRET,
    ragApiUrl: parsed.RAG_API_URL.replace(/\/+$/, ""),
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL,
    port: parsed.PORT,
  };
}
