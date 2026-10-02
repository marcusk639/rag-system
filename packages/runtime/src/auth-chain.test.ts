import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { Config } from "@rag/core";
import { buildAuthProvider } from "./index.js";

/**
 * `composite` drops the verifiers it has no configuration for. That is
 * deliberate — it is what lets the same provider serve a static-token-only
 * deployment and a full Entra one — but it means a deployment can believe it
 * enforces per-user scoping while running static-token-only.
 *
 * This happened in production: the API reads `INTERNAL_SCOPE_JWT_SECRETS`
 * (plural) and the environment set `INTERNAL_SCOPE_JWT_SECRET` (singular, the
 * name only `apps/web` reads). The scope verifier was silently absent, so the
 * BFF's per-user assertions were rejected and nothing in the log said why. The
 * warning asserted here is the thing that was missing.
 */
function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

function config(overrides: {
  oidc?: unknown;
  internalScopeSecrets?: string[];
}): Config {
  return {
    api: { tokens: ["t"], principals: [], enforceScoping: false },
    auth: {
      provider: "composite",
      oidc: overrides.oidc,
      internalScopeSecrets: overrides.internalScopeSecrets ?? [],
    },
  } as unknown as Config;
}

describe("buildAuthProvider — composite chain reporting", () => {
  it("warns when composite resolves to static-token only", () => {
    const logger = fakeLogger();
    buildAuthProvider(config({}), logger);

    expect(logger.warn).toHaveBeenCalledOnce();
    const msg = String(logger.warn.mock.calls[0]?.[0]);
    // The plural/singular confusion is the actual trap — name it.
    expect(msg).toContain("INTERNAL_SCOPE_JWT_SECRETS");
    expect(msg).toContain("static-token ONLY");
  });

  it("reports the verifiers it actually built", () => {
    const logger = fakeLogger();
    buildAuthProvider(
      config({ internalScopeSecrets: ["a".repeat(64)] }),
      logger,
    );

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
      verifiers: ["static-token", "internal-scope"],
    });
  });

  it("does not warn once a scope verifier is present", () => {
    const logger = fakeLogger();
    buildAuthProvider(
      config({ internalScopeSecrets: ["a".repeat(64)] }),
      logger,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
