import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthorizationScope } from "@rag/core";
import type { Deps } from "../deps.js";
import { filterSchema } from "./filter.js";

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
  }>,
): string {
  if (citations.length === 0) return answer;
  const block = citations
    .map((c) => {
      const link = c.url ? ` — ${c.url}` : ` — id=${c.documentId}`;
      return `[${c.index}] ${c.title}${link}`;
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
      if (!deps.generator) {
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

      // MANDATORY confidentiality boundary — same enforced scope as search.
      const results = await deps.retriever.search(
        {
          query: question,
          topK: topK ?? deps.config.retrieval.defaultTopK,
          sourceIds,
          filter,
        },
        scope,
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "The available documents do not contain enough information to answer that. Try rephrasing, removing filters, or syncing a relevant source.",
            },
          ],
          structuredContent: {
            answer: "",
            citations: [],
            retrievedCount: 0,
          },
        };
      }

      const { answer, citations } = await deps.generator.answer(
        question,
        results,
      );

      return {
        content: [{ type: "text", text: renderAnswer(answer, citations) }],
        structuredContent: {
          answer,
          citations,
          retrievedCount: results.length,
        },
      };
    },
  );
}
