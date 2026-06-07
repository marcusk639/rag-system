import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AuthorizationScope,
  type DocumentMetadata,
  isSourceAllowed,
  sanitizeMetadata,
} from "@rag/core";
import { getDocument } from "@rag/db";
import type { Deps } from "../deps.js";

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
    async ({ documentId }) => {
      const doc = await getDocument(deps.db, documentId);
      // Confidentiality boundary (P1b): a scoped session must not read — or even
      // confirm the existence of — a document outside its enforced source set.
      // Return the SAME not-found result a missing id returns so the forbidden
      // case is indistinguishable, and NEVER build the summary below (which
      // would embed doc.sourceId and the full doc.markdown body).
      if (!doc || !isSourceAllowed(scope, doc.sourceId)) {
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
            // PII boundary: strip non-allowlisted metadata (author/from/to/
            // subject/extra) before returning. See @rag/core metadata-policy.
            metadata: sanitizeMetadata(doc.metadata as DocumentMetadata),
            markdown: doc.markdown,
          },
        },
      };
    },
  );
}
