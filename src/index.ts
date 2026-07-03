import "dotenv/config";
import {
  startSseServer,
  startStdioServer,
  startStreamableHttpServer,
  type ServerHandle,
} from "./server.js";
import { logger } from "./utils/logger.js";

const VALID_TRANSPORTS = ["stdio", "sse", "streamable-http"] as const;
type Transport = (typeof VALID_TRANSPORTS)[number];

/** Resolve the transport from CLI flags / env, validating against the allow-list. */
function resolveTransport(): Transport {
  const requested = process.argv.includes("--streamable-http") ? "streamable-http"
    : process.argv.includes("--sse") ? "sse"
    : (process.env.MCP_TRANSPORT ?? "stdio");

  if (!(VALID_TRANSPORTS as readonly string[]).includes(requested)) {
    logger.warn(
      { requested, valid: VALID_TRANSPORTS },
      `Unknown transport "${requested}"; falling back to stdio`,
    );
    return "stdio";
  }
  return requested as Transport;
}

async function startTransport(transport: Transport): Promise<ServerHandle> {
  switch (transport) {
    case "streamable-http":
      return startStreamableHttpServer();
    case "sse":
      return startSseServer();
    default:
      return startStdioServer();
  }
}

/** Wire up idempotent SIGINT/SIGTERM (and stdin-end for stdio) handlers. */
function installShutdownHandlers(transport: Transport, handle: ServerHandle): void {
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "Shutting down NL-GOV-MCP…");

    // Hard cap so a stuck connection can never hang the process.
    const drainTimer = setTimeout(() => {
      logger.warn("Drain timeout reached; forcing exit");
      process.exit(0);
    }, 5000);
    drainTimer.unref();

    // 1. Stop accepting new HTTP connections (no-op for stdio).
    handle.httpServer?.close();

    // 2. Close active MCP transports / McpServers, then exit.
    handle
      .closeConnections()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(drainTimer);
        process.exit(0);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // For stdio, a closed stdin means the client is gone — shut down cleanly.
  if (transport === "stdio") {
    process.stdin.on("end", () => shutdown("stdin-end"));
  }
}

async function main(): Promise<void> {
  const transport = resolveTransport();
  const handle = await startTransport(transport);
  installShutdownHandlers(transport, handle);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
