import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDocument } from "@rag/db";
import type { Logger } from "pino";
import type { Deps } from "./deps.js";
import { registerSearchDocuments } from "./tools/search-documents.js";
import { registerGetDocument } from "./tools/get-document.js";
import { registerListSources } from "./tools/list-sources.js";
import { registerTriggerSync } from "./tools/trigger-sync.js";
import { registerAsk } from "./tools/ask.js";

/**
 * Build a fully configured McpServer instance. The same builder is used by
 * both transports (stdio and Streamable HTTP). The HTTP transport calls this
 * once per session so each session gets an isolated server, mirroring the
 * pattern in the SDK's official Streamable HTTP example.
 */
export function buildServer(opts: { deps: Deps; logger: Logger }): McpServer {
  const { deps, logger } = opts;

  const server = new McpServer({
    name: "rag",
    version: "0.1.0",
  });

  // Tools
  registerSearchDocuments(server, deps);
  registerGetDocument(server, deps);
  registerListSources(server, deps);
  registerTriggerSync(server, deps);
  registerAsk(server, deps);

  // Resource: documents://{id} — agents can read a single document by id
  // without going through the get_document tool. Useful for embedding in
  // prompts via resource references.
  server.registerResource(
    "document",
    new ResourceTemplate("documents://{id}", { list: undefined }),
    {
      title: "Document",
      description:
        "A single indexed document, addressed by its UUID. Returns the parsed markdown body. Pair with search_documents results to fetch full context for top hits.",
      mimeType: "text/markdown",
    },
    async (uri, { id }) => {
      const docId = Array.isArray(id) ? id[0] : id;
      if (!docId) {
        throw new Error("documents:// resource requires an id");
      }
      const doc = await getDocument(deps.db, docId);
      if (!doc) {
        throw new Error(`document ${docId} not found`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: doc.markdown,
          },
        ],
      };
    },
  );

  logger.info(
    {
      tools: [
        "search_documents",
        "get_document",
        "list_sources",
        "trigger_sync",
        "ask",
      ],
      resources: ["documents://{id}"],
    },
    "MCP server built",
  );

  return server;
}
