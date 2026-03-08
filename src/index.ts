import "dotenv/config";
import { startSseServer, startStdioServer, startStreamableHttpServer } from "./server.js";

const transport = process.argv.includes("--streamable-http") ? "streamable-http"
  : process.argv.includes("--sse") ? "sse"
  : (process.env.MCP_TRANSPORT ?? "stdio");

switch (transport) {
  case "streamable-http":
    startStreamableHttpServer().catch((error) => {
      console.error(error);
      process.exit(1);
    });
    break;
  case "sse":
    startSseServer().catch((error) => {
      console.error(error);
      process.exit(1);
    });
    break;
  default:
    startStdioServer().catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
