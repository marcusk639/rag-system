import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Wire the supplied MCP server to stdio. The client (Claude Desktop, an IDE
 * agent runner, etc.) spawns this process and exchanges JSON-RPC frames over
 * stdin/stdout. Because stdout is the protocol channel, ALL logging must go
 * to stderr — pino is configured for that in main.ts.
 */
export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
