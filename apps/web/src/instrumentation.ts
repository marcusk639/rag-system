/**
 * WEB_AUTH_MODE=static-fallback is a complete, unexpiring bypass of per-user
 * auth (docs/RAG-SYSTEM-EVALUATION-2026-07-13.md P2) — every request served
 * this way is already logged per-request via console.warn in
 * resolveRequestBearerToken (lib/rag-api.ts), but nothing previously warned
 * ONCE, loudly, at process start, where an operator watching deploy logs
 * would actually see it. This does not add an expiry (the per-request log is
 * the audit trail; a hard TTL would risk locking out the emergency rollback
 * it exists for) — it makes the condition impossible to miss on boot.
 */
export function checkStaticFallbackMode(
  env: Record<string, string | undefined>,
): void {
  if (env.WEB_AUTH_MODE === "static-fallback") {
    console.warn(
      "[rag-web] WEB_AUTH_MODE=static-fallback is ACTIVE — per-user Entra ID " +
        "auth is bypassed for every request; all traffic is authorized by one " +
        "shared static token. This is meant to be a TEMPORARY emergency " +
        "rollback. If this is not an active incident, unset WEB_AUTH_MODE now.",
    );
  }
}

/**
 * Next.js instrumentation hook — runs once per runtime context when the
 * server starts, before any request is served. See
 * https://nextjs.org/docs/app/guides/instrumentation.
 *
 * This app has an Edge-runtime `middleware.ts` (Task 3) with no `runtime`
 * override in its `config`, so Next.js instantiates both a Node.js and an
 * Edge runtime context at startup — `register()` fires once per context. Per
 * Next.js's own documented recommendation
 * (https://nextjs.org/docs/app/guides/instrumentation#importing-runtime-specific-code),
 * `process.env.NEXT_RUNTIME` identifies which context is currently running
 * ("nodejs" or "edge"). Gate the check to the Node.js runtime only, so the
 * startup warning fires exactly once per boot instead of twice.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "edge") {
    checkStaticFallbackMode(process.env);
  }
}
