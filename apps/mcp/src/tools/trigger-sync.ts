import { z } from "zod";
import type { AuthorizationScope } from "@rag/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSource } from "@rag/db";
import { triggerSync } from "@rag/services";
import type { Deps } from "../deps.js";
import { guardToolHandler } from "../tool-error.js";

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

export function registerTriggerSync(
  server: McpServer,
  deps: Deps,
  scope: AuthorizationScope,
): void {
  server.registerTool(
    "trigger_sync",
    {
      title: "Trigger source sync",
      description:
        "Enqueue a background ingestion job that re-pulls documents from a source, parses them, chunks, embeds, and stores. Returns immediately with the pg-boss job id; sync runs asynchronously in the worker process. This is the correct way to refresh content — never block on sync inside a conversation. Use `list_sources` first to discover ids and check when each source was last synced. A scoped session may only sync sources within its allow-list.",
      inputSchema,
    },
    guardToolHandler(
      "trigger_sync",
      deps.logger,
      async ({ sourceId, mode }) => {
        // Scope check: a scoped session cannot force a sync (Graph-quota and
        // embedding-cost consuming) against a source outside its allow-list —
        // same enforcement as purge_source, and for the same reason: syncing a
        // source you can't read would let a walled-off caller confirm its
        // existence and burn its owner's shared quota/cost.
        const permitted =
          scope.enforcedSourceIds === null ||
          scope.enforcedSourceIds.includes(sourceId);
        if (!permitted) {
          return {
            content: [{ type: "text", text: `Source ${sourceId} not found.` }],
            isError: true,
          };
        }

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
        // Failures are left to `guardToolHandler`. SyncAlreadyRunningError still
        // surfaces as a tool error carrying its own message — its code
        // (SYNC_ALREADY_RUNNING) is a client fault there, so the duplicate-sync
        // behaviour this tool documented is unchanged. What is gone is the raw
        // `err.message` interpolation, which forwarded any other failure's
        // internals verbatim.
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
      },
    ),
  );
}
