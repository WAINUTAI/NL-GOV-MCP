import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { logger } from "./utils/logger.js";

export function createServer(): McpServer {
  const config = loadConfig();
  const server = new McpServer({
    name: config.server.name,
    version: config.server.version,
  });
  registerTools(server);
  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP stdio server started");
}

export async function startSseServer(): Promise<void> {
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

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: config.server.name, version: config.server.version });
  });

  app.listen(config.server.httpPort, () => {
    logger.info({ port: config.server.httpPort }, "MCP SSE server started");
  });
}
