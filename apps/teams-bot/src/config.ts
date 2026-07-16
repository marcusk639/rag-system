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
  INTERNAL_SCOPE_JWT_SECRET: z
    .string()
    .min(64, "INTERNAL_SCOPE_JWT_SECRET must be at least 64 characters"),
  RAG_API_URL: z.string().url("RAG_API_URL must be a valid URL"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3978),
});

export interface BotConfig {
  microsoftAppId: string;
  microsoftAppPassword: string;
  microsoftAppTenantId: string;
  botSsoScope: string;
  internalScopeJwtSecret: string;
  ragApiUrl: string;
  databaseUrl: string;
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
    INTERNAL_SCOPE_JWT_SECRET: env.INTERNAL_SCOPE_JWT_SECRET,
    RAG_API_URL: env.RAG_API_URL,
    DATABASE_URL: env.DATABASE_URL,
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
    internalScopeJwtSecret: parsed.INTERNAL_SCOPE_JWT_SECRET,
    ragApiUrl: parsed.RAG_API_URL.replace(/\/+$/, ""),
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
  };
}
