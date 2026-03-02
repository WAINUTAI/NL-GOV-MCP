import { describe, it, expect } from "vitest";
import { createServer } from "../src/server.js";

describe("server smoke", () => {
  it("creates MCP server", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });
});
