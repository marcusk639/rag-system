import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthorizationScope, isSourceAllowed } from "@rag/core";
import { getDocument } from "@rag/db";
import type { Logger } from "pino";
import type { Deps } from "./deps.js";
import { registerSearchDocuments } from "./tools/search-documents.js";
import { registerGetDocument } from "./tools/get-document.js";
import { registerListSources } from "./tools/list-sources.js";
import { registerTriggerSync } from "./tools/trigger-sync.js";
import { registerPurgeSource } from "./tools/purge-source.js";
import { registerAsk } from "./tools/ask.js";

/**
 * Build a fully configured McpServer instance. The same builder is used by
 * both transports (stdio and Streamable HTTP). The HTTP transport calls this
 * once per session so each session gets an isolated server, mirroring the
 * pattern in the SDK's official Streamable HTTP example.
 *
 * `scope` is the MANDATORY retrieval authorization scope for THIS server
 * instance, derived from the caller's token (HTTP) or the explicit trusted
 * decision for stdio. It is threaded into the search/ask tools so they enforce
 * the principal's allowed sources. HTTP builds one server per session so the
 * scope is per-token; stdio passes ADMIN_SCOPE (see startStdio / main.ts).
 */
export function buildServer(opts: {
  deps: Deps;
  logger: Logger;
  scope: AuthorizationScope;
}): McpServer {
  const { deps, logger, scope } = opts;

  const server = new McpServer({
    name: "rag",
    version: "0.1.0",
  });

  // Tools — search/ask receive the enforced authorization scope.
  registerSearchDocuments(server, deps, scope);
  registerGetDocument(server, deps, scope);
  registerListSources(server, deps);
  registerTriggerSync(server, deps, scope);
  registerPurgeSource(server, deps, scope);
  registerAsk(server, deps, scope);

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
      // Confidentiality boundary (P1b): a scoped session must not read — or even
      // confirm the existence of — a document outside its enforced source set.
      // Mirror the missing-id path EXACTLY (same thrown "not found") so the
      // forbidden case is indistinguishable and the markdown body is not
      // returned.
      if (!doc || !isSourceAllowed(scope, doc.sourceId)) {
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
        "purge_source",
        "ask",
      ],
      resources: ["documents://{id}"],
    },
    "MCP server built",
  );

  return server;
}
