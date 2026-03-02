import "dotenv/config";
import { startSseServer, startStdioServer } from "./server.js";

const useSse = process.argv.includes("--sse") || process.env.MCP_TRANSPORT === "sse";

if (useSse) {
  startSseServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  startStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
