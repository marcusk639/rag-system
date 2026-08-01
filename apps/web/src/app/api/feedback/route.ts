import { auth } from "@/lib/auth";
import { getScopeAssertionToken } from "@/lib/scope-token";
import {
  getRagApiConfig,
  jsonError,
  resolveRequestBearerToken,
} from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BFF proxy for POST /feedback.
 *
 * The backend and its table have existed since migration 0018; this route and
 * the control that calls it were the missing link, which is why no in-product
 * quality signal has ever been captured.
 *
 * The body is forwarded rather than re-validated here — `apps/api` owns the
 * schema (`answerId` uuid, `rating` helpful|not_helpful, `comment` ≤1000) and
 * duplicating it in the BFF creates two places to drift. What this layer DOES
 * own is identity: the upstream attributes feedback to the caller's principal
 * from the bearer token, so a user cannot submit as someone else.
 */
export async function POST(request: Request): Promise<Response> {
  const resolved = await resolveRequestBearerToken(
    auth,
    getScopeAssertionToken,
  );
  if (resolved.errorResponse) return resolved.errorResponse;

  let config: { url: string };
  try {
    config = getRagApiConfig();
  } catch {
    return jsonError(500, "CONFIG_ERROR", "RAG API is not configured.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be JSON.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.url}/feedback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        "Content-Type": "application/json",
        // The API attributes the channel from this header; without it, web and
        // Teams feedback are indistinguishable in the data.
        "X-RAG-Channel": "web",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "UPSTREAM_UNREACHABLE", "RAG API is unreachable.");
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
