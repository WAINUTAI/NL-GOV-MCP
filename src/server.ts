import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { getAllConnectorHealth } from "./utils/connector-runtime.js";
import { logger } from "./utils/logger.js";

const BANNER = `
  _   _ _       ____  _____   __       __  __  ____ ____
 | \\ | | |     / ___||  _  | \\ \\     / / |  \\/  | / ___|  _ \\
 |  \\| | |    | |  _ | | | |  \\ \\   / /  | |\\/| || |   | |_) |
 | |\\  | |___ | |_| || |_| |   \\ \\_/ /   | |  | || |___|  __/
 |_| \\_|_____|\\____| |_____|    \\___/    |_|  |_| \\____|_|

 Built by WAINUT (https://wainut.ai) — Unleash Your Potential.
`;

function printBanner(): void {
  process.stderr.write(BANNER + "\n");
}

export function createServer(): McpServer {
  const config = loadConfig();
  const server = new McpServer({
    name: config.server.name,
    version: config.server.version,
  });
  registerTools(server);
  return server;
}

/* ------------------------------------------------------------------ */
/*  stdio                                                              */
/* ------------------------------------------------------------------ */

export async function startStdioServer(): Promise<void> {
  printBanner();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP stdio server started");
}

/* ------------------------------------------------------------------ */
/*  SSE (legacy)                                                       */
/* ------------------------------------------------------------------ */

export async function startSseServer(): Promise<void> {
  printBanner();
  const config = loadConfig();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const transports: Record<string, SSEServerTransport> = {};

  app.get("/mcp", async (_req, res) => {
    const server = createServer();
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    transport.onclose = () => {
      delete transports[transport.sessionId];
      server.close().catch(() => undefined);
    };
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).send("Missing sessionId");
      return;
    }
    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).send("Unknown sessionId");
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  addHealthRoutes(app, config);

  app.listen(config.server.httpPort, () => {
    logger.info({ port: config.server.httpPort }, "MCP SSE server started");
  });
}

/* ------------------------------------------------------------------ */
/*  Streamable HTTP (MCP spec 2025-03-26)                              */
/* ------------------------------------------------------------------ */

export async function startStreamableHttpServer(): Promise<void> {
  printBanner();
  const config = loadConfig();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  app.all("/mcp", async (req, res) => {
    // Handle DELETE for session termination
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.close();
        sessions.delete(sessionId);
        res.status(200).end();
      } else {
        res.status(404).end();
      }
      return;
    }

    // For GET and POST, check if there's an existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — route to its transport
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      // Invalid session ID
      res.status(404).json({ error: "Unknown session" });
      return;
    }

    // New session (no session ID header) — only POST allowed for initialization
    if (req.method !== "POST") {
      res.status(400).json({ error: "New sessions must be initialized via POST" });
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      server.close().catch(() => undefined);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Session ID is set after handleRequest processes the initialize message
    const sid = transport.sessionId;
    if (sid && !sessions.has(sid)) {
      sessions.set(sid, { server, transport });
    }
  });

  addHealthRoutes(app, config);

  app.listen(config.server.httpPort, () => {
    logger.info({ port: config.server.httpPort }, "MCP Streamable HTTP server started");
  });
}

/* ------------------------------------------------------------------ */
/*  Shared health routes                                               */
/* ------------------------------------------------------------------ */

interface HealthConfig {
  server: { name: string; version: string };
}

function addHealthRoutes(app: express.Express, config: HealthConfig): void {
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: config.server.name, version: config.server.version });
  });

  app.get("/health/sources", (_req, res) => {
    res.json({
      ok: true,
      name: config.server.name,
      version: config.server.version,
      connectors: getAllConnectorHealth(),
    });
  });
}
