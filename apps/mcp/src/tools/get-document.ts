import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthorizationScope, NotFoundError } from "@rag/core";
import { getDocumentById } from "@rag/services";
import type { Deps } from "../deps.js";
import { guardToolHandler } from "../tool-error.js";

const inputSchema = {
  documentId: z
    .string()
    .uuid()
    .describe(
      "Document id (UUID) — usually obtained from a search_documents result's `document.id` field.",
    ),
};

export function registerGetDocument(
  server: McpServer,
  deps: Deps,
  scope: AuthorizationScope,
): void {
  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Fetch the full normalized markdown and metadata for a single document by id. Use this after `search_documents` when a top-ranked chunk looks promising and you need surrounding context (the chunk is typically just ~800 tokens). The structured payload includes id, title, sourceId, mimeType, sizeBytes, sourceModifiedAt, metadata, and the full markdown body. Returns isError when the id does not exist.",
      inputSchema,
    },
    guardToolHandler("get_document", deps.logger, async ({ documentId }) => {
      // Confidentiality boundary (P1b): `getDocumentById` enforces the session
      // scope and throws NotFoundError for a forbidden source EXACTLY as it does
      // for a missing id, so the two cases are indistinguishable and the summary
      // below (which embeds sourceId + the full markdown body) is never built
      // for an out-of-scope document. It also applies the PII metadata allowlist.
      let doc;
      try {
        doc = await getDocumentById(deps, documentId, scope);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return {
            content: [
              {
                type: "text",
                text: `Document ${documentId} not found.`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
      const summary = `# ${doc.title}\n\n_id_: ${doc.id}\n_sourceId_: ${doc.sourceId}\n_mimeType_: ${doc.mimeType}\n_modified_: ${doc.sourceModifiedAt?.toISOString() ?? "unknown"}\n\n---\n\n${doc.markdown}`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          document: {
            id: doc.id,
            sourceId: doc.sourceId,
            externalId: doc.externalId,
            title: doc.title,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            sourceModifiedAt: doc.sourceModifiedAt?.toISOString() ?? null,
            // `doc.metadata` is already PII-allowlisted by `getDocumentById`.
            metadata: doc.metadata,
            markdown: doc.markdown,
          },
        },
      };
    }),
  );
}
