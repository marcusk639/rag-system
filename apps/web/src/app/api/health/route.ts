export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness check for Railway/compose healthchecks.
 * Deliberately excluded from the auth middleware's protected-route check
 * (see src/middleware.ts) — a healthcheck must succeed before a user has
 * ever signed in.
 */
export async function GET(): Promise<Response> {
  return Response.json({ status: "ok" });
}
