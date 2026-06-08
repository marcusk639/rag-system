import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSource } from "@rag/db";
import { triggerSync } from "@rag/services";
import type { Deps } from "../deps.js";

const inputSchema = {
  sourceId: z
    .string()
    .uuid()
    .describe(
      "Id of the source to sync (from list_sources). Each source is dedup-guarded — calling this while a sync for the same source is pending or running returns an error rather than queueing a duplicate.",
    ),
  mode: z
    .enum(["full", "incremental"])
    .optional()
    .describe(
      'Sync strategy. "incremental" (default) uses the stored cursor and only pulls changes since the last successful sync — fast, cheap, the right default. "full" wipes the cursor and re-enumerates everything in the source — use only when you suspect drift or after schema/config changes.',
    ),
};

export function registerTriggerSync(server: McpServer, deps: Deps): void {
  server.registerTool(
    "trigger_sync",
    {
      title: "Trigger source sync",
      description:
        "Enqueue a background ingestion job that re-pulls documents from a source, parses them, chunks, embeds, and stores. Returns immediately with the pg-boss job id; sync runs asynchronously in the worker process. This is the correct way to refresh content — never block on sync inside a conversation. Use `list_sources` first to discover ids and check when each source was last synced.",
      inputSchema,
    },
    async ({ sourceId, mode }) => {
      // Resolve the source up front purely for a friendly name in the success
      // message (display concern). triggerSync re-checks existence and is the
      // sole writer of ingestion_jobs (C2a).
      const source = await getSource(deps.db, sourceId);
      if (!source) {
        return {
          content: [{ type: "text", text: `Source ${sourceId} not found.` }],
          isError: true,
        };
      }
      try {
        const {
          jobId,
          ingestionId,
          mode: resolvedMode,
        } = await triggerSync(deps, { sourceId, mode: mode ?? "incremental" });
        return {
          content: [
            {
              type: "text",
              text: `Enqueued ${resolvedMode} sync for "${source.name}" (jobId=${jobId}, ingestionId=${ingestionId}). The worker will process it shortly; poll list_sources to see when lastSyncedAt updates.`,
            },
          ],
          structuredContent: {
            jobId,
            ingestionId,
            sourceId,
            mode: resolvedMode,
          },
        };
      } catch (err) {
        // Includes SyncAlreadyRunningError (duplicate sync) — surfaced as a
        // tool error rather than a thrown 500.
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Failed to enqueue sync: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
