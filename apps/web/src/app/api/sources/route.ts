import { proxyJsonGet } from "@/lib/rag-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** BFF proxy for GET /sources (read-only source list). */
export async function GET(): Promise<Response> {
  return proxyJsonGet("/sources");
}
