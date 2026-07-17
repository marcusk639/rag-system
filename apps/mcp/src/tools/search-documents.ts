import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthorizationScope, SanitizedRetrievalResult } from "@rag/core";
import { filterSchema } from "@rag/core";
import { logAskEvent } from "@rag/db";
import { searchDocuments } from "@rag/services";
import type { Deps } from "../deps.js";

const MAX_TOP_K = 50;
const EXCERPT_CHARS = 300;

const inputSchema = {
  query: z.string().min(1).describe("Natural-language search query."),
  topK: z
    .number()
    .int()
    .positive()
    .max(MAX_TOP_K)
    .optional()
    .describe(`Number of chunks to return (default 8, max ${MAX_TOP_K}).`),
  sourceIds: z
    .array(z.string().uuid())
    .optional()
    .describe(
      "Restrict the search to specific source ids (from list_sources). Omit to search all sources.",
    ),
  filter: filterSchema
    .optional()
    .describe(
      'Metadata filter applied to document.metadata. AND across keys, OR across values per key. Example: {"author":"alice","path":["Marketing/2024","Marketing/2025"]}.',
    ),
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function formatResults(results: SanitizedRetrievalResult[]): string {
  if (results.length === 0) {
    return "No matching chunks found. Try a broader query, remove filters, or check that the relevant source has been synced.";
  }
  return results
    .map((r, i) => {
      const heading = r.chunk.headingPath.length
        ? ` › ${r.chunk.headingPath.join(" › ")}`
        : "";
      const page = r.chunk.page ? ` (p. ${r.chunk.page})` : "";
      const score = r.score.toFixed(2);
      return `[${i + 1}] ${r.document.title}${heading}${page} — score ${score}\n   ${truncate(r.text, EXCERPT_CHARS)}`;
    })
    .join("\n\n");
}

/**
 * Fire-and-forget audit record for every `search_documents` call — mirrors
 * `auditSearch` in `apps/api/src/routes/search.ts` (same `audit_log` table,
 * `channel: "mcp"`). Previously MISSING entirely: MCP tools wrote no audit
 * row at all, not just an incomplete one — the agent-facing surface (per
 * root CLAUDE.md) had zero §7216/§10.22 disclosure recordkeeping.
 *
 * `AuthorizationScope` (unlike the HTTP route's `Principal`) doesn't carry
 * `subject` — only `enforcedSourceIds` — so `principalKind`/`principalSources`
 * are faithfully derived from it, but `principalSubject` is null here. Wiring
 * per-user subject through the MCP transport layer (http.ts's
 * `scopeForRequest` currently discards the resolved `Principal` down to just
 * an `AuthorizationScope` before it reaches tool handlers) is a separate,
 * larger change than adding the audit trail itself.
 */
function auditSearch(
  deps: Deps,
  scope: AuthorizationScope,
  query: string,
  results: SanitizedRetrievalResult[],
): void {
  void logAskEvent(deps.db, {
    principalKind: scope.enforcedSourceIds === null ? "admin" : "scoped",
    principalSources: scope.enforcedSourceIds,
    principalSubject: null,
    questionHash: createHash("sha256").update(query).digest("hex"),
    channel: "mcp",
    model: null,
    embeddingProvider: deps.embedder.name,
    embeddingModel: deps.embedder.model,
    sourceIds: [...new Set(results.map((r) => r.document.sourceId))],
    chunkIds: results.map((r) => r.chunk.id),
    docIds: [...new Set(results.map((r) => r.document.id))],
    retrievedCount: results.length,
    endpoint: "search",
    topScore: results[0]?.score ?? null,
    // /search has no generated answer — no answerId to record.
    answerId: null,
  }).catch((err: unknown) => deps.logger.error({ err }, "audit log failed"));
}

export function registerSearchDocuments(
  server: McpServer,
  deps: Deps,
  scope: AuthorizationScope,
): void {
  server.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Hybrid (dense vector + sparse BM25) retrieval over all ingested documents. Use this when you need the most relevant passages of source material to answer a factual question, ground a response in citations, or locate where a topic is discussed. Returns ranked chunks with document title, heading path, page number when known, source id, url (if any), and a normalized score in [0,1]. The text response is a numbered list; the structured payload contains the full RetrievalResult objects suitable for downstream synthesis or building UI citations. This tool only retrieves passages — call `ask` if you also want the model to write a grounded answer for you.",
      inputSchema,
    },
    async ({ query, topK, sourceIds, filter }) => {
      // The service enforces the MANDATORY confidentiality boundary (scope —
      // admin for stdio/admin-token, source-scoped for a scoped token; the
      // optional caller `sourceIds` narrows WITHIN it) and the PII metadata
      // allowlist, so the same leak via MCP is closed the same way as the HTTP
      // API. `results` is already sanitized.
      const results = await searchDocuments(
        deps,
        { query, topK, sourceIds, filter },
        deps.config.retrieval.defaultTopK,
        scope,
      );
      auditSearch(deps, scope, query, results);
      return {
        content: [{ type: "text", text: formatResults(results) }],
        structuredContent: { results },
      };
    },
  );
}
