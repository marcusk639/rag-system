import { randomUUID } from "node:crypto";
import { createTokenVerifier } from "@rag/core";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";

/**
 * Streamable HTTP transport per the MCP spec:
 *   - POST /mcp  — client → server JSON-RPC, optionally upgraded to SSE
 *   - GET  /mcp  — open standalone SSE stream for server → client notifications
 *   - DELETE /mcp — terminate the session
 *
 * Each MCP session gets its own McpServer instance because the SDK stores
 * per-connection request state on the server object. `buildServer` is called
 * lazily on the initialize request.
 */
export interface HttpTransportOptions {
  buildServer: () => McpServer;
  port: number;
  logger: Logger;
  /**
   * Bearer tokens authorized to call /mcp. REQUIRED — the MCP HTTP transport
   * exposes search, ask, list_sources, trigger_sync; running without auth
   * lets anyone on the network exfiltrate the entire indexed corpus.
   */
  tokens: readonly string[];
  /**
   * Allowed Origin values for CORS. If a browser-based caller sends an
   * Origin header, it must match one of these. Mitigates DNS rebinding
   * attacks against localhost MCP servers. Empty array = reject all Origin
   * headers (non-browser callers don't send one — they pass through).
   */
  allowedOrigins?: readonly string[];
}

export async function startHttp(opts: HttpTransportOptions): Promise<void> {
  const { buildServer, port, logger, tokens, allowedOrigins = [] } = opts;

  if (tokens.length === 0) {
    throw new Error(
      "MCP HTTP transport requires at least one bearer token — refusing to start without auth",
    );
  }

  // Shared constant-time verifier (@rag/core/auth) — same implementation the
  // HTTP API uses. Tokens are pre-hashed once inside the factory.
  const verifyToken = createTokenVerifier(tokens);

  const originSet = new Set(allowedOrigins);

  /**
   * Auth + Origin middleware. Applied only to /mcp routes; /health bypasses
   * so orchestrator probes don't need a token.
   */
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    // DNS rebinding mitigation: if the caller is a browser (Origin header
    // present), require an exact match against the configured allow-list.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0) {
      if (!originSet.has(origin)) {
        logger.warn({ origin }, "MCP request rejected: disallowed Origin");
        res.status(403).json({ error: "Forbidden: Origin not allowed" });
        return;
      }
    }

    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token || !verifyToken(token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };

  const app = express();
  app.use(express.json({ limit: "4mb" }));
  // Auth gate. Order matters — must register BEFORE the /mcp routes.
  app.use("/mcp", guard);

  // sessionId → live transport. The transport itself holds a reference to
  // the McpServer it was connected to, so we don't need to track servers
  // separately.
  //
  // Capacity-bounded: even an authenticated client can otherwise open many
  // sessions without DELETE'ing them, slowly growing this map. 1000 is a
  // generous ceiling for any realistic agent fleet; tune via MCP_MAX_SESSIONS.
  const MAX_SESSIONS = Math.max(
    1,
    Number(process.env.MCP_MAX_SESSIONS ?? 1000),
  );
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      let transport: StreamableHTTPServerTransport | undefined = sessionId
        ? transports.get(sessionId)
        : undefined;

      if (!transport) {
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Bad Request: missing mcp-session-id header and request is not an initialize",
            },
            id: null,
          });
          return;
        }

        if (transports.size >= MAX_SESSIONS) {
          logger.warn(
            { count: transports.size, max: MAX_SESSIONS },
            "MCP session pool full — rejecting new initialize",
          );
          res.status(503).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Server at session capacity; retry later",
            },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            logger.info({ sessionId: sid }, "MCP session initialized");
            transports.set(sid, transport!);
          },
        });

        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid && transports.has(sid)) {
            logger.info({ sessionId: sid }, "MCP session closed");
            transports.delete(sid);
          }
        };

        const server = buildServer();
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "Error handling MCP POST");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const requireSession = (
    req: Request,
    res: Response,
  ): StreamableHTTPServerTransport | null => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).send("Missing mcp-session-id header");
      return null;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send("Unknown session");
      return null;
    }
    return transport;
  };

  app.get("/mcp", async (req: Request, res: Response) => {
    const transport = requireSession(req, res);
    if (!transport) return;
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, "Error handling MCP GET");
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const transport = requireSession(req, res);
    if (!transport) return;
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, "Error handling MCP DELETE");
      if (!res.headersSent) res.status(500).end();
    }
  });

  // Tiny healthcheck for orchestrators
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => resolve());
    server.on("error", reject);
  });
}
