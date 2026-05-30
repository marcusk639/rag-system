import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSources } from "@rag/db";
import type { Deps } from "../deps.js";

export function registerListSources(server: McpServer, deps: Deps): void {
  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "List every registered ingestion source (the systems documents were pulled from: SharePoint sites, Google Drives, mailboxes, etc.). Use this to discover which sources exist and obtain their ids — those ids can be passed to `search_documents`/`ask` as `sourceIds` to restrict the search, or to `trigger_sync` to refresh a source. Returns id, kind (sharepoint|gdrive|gmail|outlook|custom), human-friendly name, and the last successful sync timestamp (null if never synced).",
      inputSchema: {},
    },
    async () => {
      const rows = await listSources(deps.db);
      const sources = rows.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
      }));
      const text =
        sources.length === 0
          ? "No sources registered yet. Use the API to register a source before running searches."
          : sources
              .map(
                (s) =>
                  `- ${s.name} [${s.kind}] id=${s.id} lastSynced=${s.lastSyncedAt ?? "never"}`,
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { sources },
      };
    },
  );
}
