import { loadConfig } from "@rag/core";
import pino, { type Logger } from "pino";
import { buildServer } from "./server.js";
import { buildDeps } from "./deps.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";

/**
 * Entry point.
 *
 * - Reads config from env via loadConfig() (no direct process.env elsewhere).
 * - For stdio: pino MUST write to stderr because stdout is the MCP protocol
 *   channel. Anything on stdout that isn't a valid JSON-RPC frame will break
 *   the client.
 * - For HTTP: standard stdout logging is fine.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const logger: Logger =
    config.mcp.transport === "stdio"
      ? pino(
          { level: process.env.LOG_LEVEL ?? "info" },
          pino.destination({ dest: 2, sync: false }),
        )
      : pino({ level: process.env.LOG_LEVEL ?? "info" });

  const deps = await buildDeps(config, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down MCP server");
    try {
      await deps.close();
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (config.mcp.transport === "stdio") {
    const server = buildServer({ deps, logger });
    await startStdio(server);
    logger.info("MCP stdio server ready");
    return;
  }

  // HTTP transport reuses the API's bearer tokens — same trust boundary.
  // `allowedOrigins` is read from MCP_ALLOWED_ORIGINS env (comma-separated).
  // Empty means "no browser callers" — non-browser clients (no Origin header)
  // still authenticate via Bearer and pass through.
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await startHttp({
    buildServer: () => buildServer({ deps, logger }),
    port: config.mcp.httpPort,
    logger,
    tokens: config.api.tokens,
    allowedOrigins,
  });
  logger.info(
    {
      port: config.mcp.httpPort,
      allowedOrigins: allowedOrigins.length || "none",
    },
    "MCP HTTP server ready",
  );
}

main().catch((err) => {
  // Last-resort logger — if pino isn't up yet, write a JSON line to stderr
  // so it doesn't pollute stdio transport's protocol channel.
  process.stderr.write(
    JSON.stringify({
      level: "fatal",
      msg: "MCP server failed to start",
      err:
        err instanceof Error ? { message: err.message, stack: err.stack } : err,
    }) + "\n",
  );
  process.exit(1);
});
