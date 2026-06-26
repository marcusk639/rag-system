import type { AuthorizationScope } from "@rag/core";
import { getSource } from "@rag/db";
import { purgeSource } from "@rag/services";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Deps } from "../deps.js";

const inputSchema = z.object({
  sourceId: z
    .string()
    .uuid()
    .describe(
      "UUID of the source to permanently delete. All documents, chunks, ingestion history, and pending uploads for this source are removed. This action is irreversible.",
    ),
});

/**
 * Register the `purge_source` tool, which permanently deletes a source and all
 * of its associated data (documents, chunks, ingestion jobs, pending uploads).
 *
 * The tool is scope-aware: a scoped session may only purge sources within its
 * enforced allow-list. An admin session (stdio or an admin-scoped token) may
 * purge any source.
 */
export function registerPurgeSource(
  server: McpServer,
  deps: Deps,
  scope: AuthorizationScope,
): void {
  server.registerTool(
    "purge_source",
    {
      title: "Purge source",
      description:
        "Permanently delete a source and all of its indexed content (documents, chunks, ingestion history, pending uploads). This is irreversible. Use `list_sources` first to confirm the correct source id before calling this tool.",
      inputSchema,
    },
    async ({ sourceId }) => {
      // Scope check: a scoped session cannot purge sources outside its allow-list.
      const permitted =
        scope.enforcedSourceIds === null ||
        scope.enforcedSourceIds.includes(sourceId);
      if (!permitted) {
        return {
          content: [{ type: "text", text: `Source ${sourceId} not found.` }],
          isError: true,
        };
      }

      // Resolve the name up front for a friendly confirmation message.
      const source = await getSource(deps.db, sourceId);
      if (!source) {
        return {
          content: [{ type: "text", text: `Source ${sourceId} not found.` }],
          isError: true,
        };
      }

      try {
        await purgeSource(deps, sourceId);
        return {
          content: [
            {
              type: "text",
              text: `Source "${source.name}" (${sourceId}) and all its data have been permanently deleted.`,
            },
          ],
          structuredContent: { sourceId, name: source.name, purged: true },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Failed to purge source: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
