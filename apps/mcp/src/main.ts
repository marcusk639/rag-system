import { ADMIN_SCOPE, loadConfig } from "@rag/core";
import { buildAuthProvider, initMonitoring } from "@rag/runtime";
import {
  assertEmbeddingDimensions,
  assertRequiredIndexes,
  createIndexExistenceRunner,
} from "@rag/db";
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
  initMonitoring(config.monitoring?.sentryDsn);
  // Fail fast before building deps / embedding any retrieval query: the
  // configured provider's vector size must match the chunks.embedding column.
  assertEmbeddingDimensions(config.embedding.dimensions);

  const logger: Logger =
    config.mcp.transport === "stdio"
      ? pino(
          { level: process.env.LOG_LEVEL ?? "info" },
          pino.destination({ dest: 2, sync: false }),
        )
      : pino({ level: process.env.LOG_LEVEL ?? "info" });

  const deps = await buildDeps(config, logger);

  // Fail fast before serving any tool calls: the HNSW + GIN search indexes
  // (owned by 0000_init.sql, invisible to Drizzle's model) must exist. The
  // search/ask tools query the corpus, and a stray regenerate that dropped
  // these indexes would silently degrade retrieval to sequential scans with no
  // error — so refuse to start instead.
  await assertRequiredIndexes(createIndexExistenceRunner(deps.db));

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
    // EXPLICIT ADMIN DECISION: the stdio transport is a local, single-user,
    // trusted channel — the client SPAWNS this process over stdin/stdout and
    // there is no token to scope against. We therefore grant the stdio session
    // an ADMIN / all-access retrieval scope (unrestricted). This is the only
    // sanctioned unscoped path; the network-facing HTTP transport always
    // resolves a per-token scope. If stdio ever becomes multi-tenant or
    // network-exposed, this MUST be replaced with a real principal.
    const server = buildServer({ deps, logger, scope: ADMIN_SCOPE });
    await startStdio(server);
    logger.info(
      "MCP stdio server ready (admin/all-access scope — trusted local channel)",
    );
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
    // Per-session: the transport resolves the session credential to a scope and
    // hands it in here, confining that session's search/ask tools to the
    // credential's allowed sources. Same AuthProvider the HTTP API uses
    // (static tokens, OIDC JWTs, or both — selected by AUTH_PROVIDER).
    buildServer: (scope) => buildServer({ deps, logger, scope }),
    port: config.mcp.httpPort,
    logger,
    authProvider: buildAuthProvider(config, logger),
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
