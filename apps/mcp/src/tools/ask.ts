import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthorizationScope } from "@rag/core";
import { filterSchema } from "@rag/core";
import { askQuestion, GenerationNotConfiguredError } from "@rag/services";
import type { Deps } from "../deps.js";

const MAX_TOP_K = 50;

const inputSchema = {
  question: z
    .string()
    .min(1)
    .describe("The natural-language question to answer."),
  topK: z
    .number()
    .int()
    .positive()
    .max(MAX_TOP_K)
    .optional()
    .describe(
      `How many chunks to retrieve as context for the generator (default 8, max ${MAX_TOP_K}). Larger values give the model more context but slow generation and may dilute relevance.`,
    ),
  sourceIds: z
    .array(z.string().uuid())
    .optional()
    .describe(
      "Restrict retrieval to specific source ids (from list_sources). Omit to search all sources.",
    ),
  filter: filterSchema
    .optional()
    .describe(
      "Metadata filter applied to document.metadata. AND across keys, OR across values per key.",
    ),
};

function renderAnswer(
  answer: string,
  citations: Array<{
    index: number;
    title: string;
    url?: string;
    documentId: string;
    downloadable?: boolean;
  }>,
): string {
  if (citations.length === 0) return answer;
  const block = citations
    .map((c) => {
      const link = c.url ? ` — ${c.url}` : ` — id=${c.documentId}`;
      // When the original file is stored, point agents at the download route so
      // they can fetch the exact cited document, not just view it in-source.
      const dl = c.downloadable
        ? ` — download: /documents/${c.documentId}/download`
        : "";
      return `[${c.index}] ${c.title}${link}${dl}`;
    })
    .join("\n");
  return `${answer}\n\nSources:\n${block}`;
}

export function registerAsk(
  server: McpServer,
  deps: Deps,
  scope: AuthorizationScope,
): void {
  server.registerTool(
    "ask",
    {
      title: "Ask a grounded question",
      description:
        "Retrieve relevant passages from the indexed corpus and generate a cited answer using the configured generation model. Use this when the user wants a written answer rather than raw search results. The model is prompted to ground every claim in numbered [N] citations and to admit ignorance when context is insufficient — it should not hallucinate. The text response contains the answer with a Sources footer; the structured payload contains the raw answer, citation list (index, documentId, title, url, chunkId, score), and retrievedCount. Returns isError when no generation provider is configured on the server (set GENERATION_PROVIDER and GENERATION_MODEL); use `search_documents` instead in that case.",
      inputSchema,
    },
    async ({ question, topK, sourceIds, filter }) => {
      // Thin adapter: the generator-null guard and empty-results short-circuit
      // live in askQuestion (canonical behavior). We only translate the
      // not-configured case into an MCP isError with a tool-specific hint.
      let result;
      try {
        result = await askQuestion(
          deps,
          { question, topK, sourceIds, filter },
          deps.config.retrieval.defaultTopK,
          scope,
          deps.config.retrieval.maxChunksPerDocument,
        );
      } catch (err) {
        if (err instanceof GenerationNotConfiguredError) {
          return {
            content: [
              {
                type: "text",
                text: "No generation provider is configured on this MCP server. Set GENERATION_PROVIDER and GENERATION_MODEL (and the matching API key) to enable `ask`, or use `search_documents` to retrieve passages and synthesize the answer yourself.",
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      // `askQuestion` already enforced the confidentiality scope and short-
      // circuits empty retrieval to a fixed answer; `retrieved` is sanitized.
      const { answer, citations, retrieved, reviewStatus, disclaimer } = result;
      return {
        // Lead with the practitioner-review disclaimer so a consuming agent
        // cannot present the draft as a finished answer (Circular 230 §10.37).
        content: [
          {
            type: "text",
            text: `⚠ ${disclaimer}\n\n${renderAnswer(answer, citations)}`,
          },
        ],
        structuredContent: {
          answer,
          citations,
          retrievedCount: retrieved.length,
          reviewStatus,
          disclaimer,
        },
      };
    },
  );
}
