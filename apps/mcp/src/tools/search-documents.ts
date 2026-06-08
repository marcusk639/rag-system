import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RetrievalResult } from "@rag/core";
import { filterSchema } from "@rag/core";
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

function formatResults(results: RetrievalResult[]): string {
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

export function registerSearchDocuments(server: McpServer, deps: Deps): void {
  server.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Hybrid (dense vector + sparse BM25) retrieval over all ingested documents. Use this when you need the most relevant passages of source material to answer a factual question, ground a response in citations, or locate where a topic is discussed. Returns ranked chunks with document title, heading path, page number when known, source id, url (if any), and a normalized score in [0,1]. The text response is a numbered list; the structured payload contains the full RetrievalResult objects suitable for downstream synthesis or building UI citations. This tool only retrieves passages — call `ask` if you also want the model to write a grounded answer for you.",
      inputSchema,
    },
    async ({ query, topK, sourceIds, filter }) => {
      const results = await searchDocuments(
        deps,
        { query, topK, sourceIds, filter },
        deps.config.retrieval.defaultTopK,
      );
      return {
        content: [{ type: "text", text: formatResults(results) }],
        structuredContent: { results },
      };
    },
  );
}
