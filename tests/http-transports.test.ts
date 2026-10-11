import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TTL_MS,
  SessionRegistry,
  resolveHttpOptions,
  startSseServer,
  startStreamableHttpServer,
  type HttpServerOptions,
  type ServerHandle,
} from "../src/server.js";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionRegistry", () => {
  function registry(maxSessions = 3, ttlMs = 1_000) {
    let now = 0;
    const closed: Array<[string, string]> = [];
    const reg = new SessionRegistry<string>({
      ttlMs,
      maxSessions,
      close: (_value, id, reason) => closed.push([id, reason]),
      now: () => now,
    });
    return { reg, closed, advance: (ms: number) => (now += ms) };
  }

  it("closes sessions idle for the TTL and keeps sessions with an open stream", async () => {
    const { reg, closed, advance } = registry();
    reg.add("a", "A");
    reg.add("b", "B");
    reg.acquire("b"); // open stream, never released
    advance(999);
    expect(reg.sweep()).toBe(0);
    advance(1);
    expect(reg.sweep()).toBe(1);
    await wait(0);
    expect(closed).toEqual([["a", "idle"]]);
    expect(reg.has("a")).toBe(false);
    expect(reg.has("b")).toBe(true);
  });

  it("measures idle time from the end of the last request", () => {
    const { reg, advance } = registry();
    reg.add("a", "A");
    const release = reg.acquire("a");
    advance(5_000);
    release();
    advance(999);
    expect(reg.sweep()).toBe(0);
    advance(1);
    expect(reg.sweep()).toBe(1);
  });

  it("evicts the least recently used idle session when the cap is reached", async () => {
    const { reg, closed } = registry(2);
    reg.add("a", "A");
    reg.add("b", "B");
    reg.acquire("a")(); // a is now more recently used than b
    reg.add("c", "C");
    await wait(0);
    expect(closed).toEqual([["b", "capacity"]]);
    expect([reg.has("a"), reg.has("b"), reg.has("c"), reg.size]).toEqual([true, false, true, 2]);
  });

  it("prefers idle sessions over active ones, but still holds the cap when all are active", async () => {
    const { reg, closed } = registry(2);
    reg.add("a", "A");
    reg.acquire("a");
    reg.add("b", "B");
    reg.add("c", "C");
    reg.acquire("c");
    expect(reg.has("a")).toBe(true);
    reg.add("d", "D");
    await wait(0);
    expect(closed).toEqual([
      ["b", "capacity"],
      ["a", "capacity"],
    ]);
    expect(reg.size).toBe(2);
  });

  it("swallows errors thrown by the close callback", async () => {
    const reg = new SessionRegistry<string>({
      ttlMs: 1,
      maxSessions: 1,
      close: () => {
        throw new Error("boom");
      },
    });
    reg.add("a", "A");
    expect(() => reg.add("b", "B")).not.toThrow();
    await wait(0);
    expect(reg.size).toBe(1);
  });
});

describe("resolveHttpOptions", () => {
  const ENV = ["NL_GOV_HTTP_HOST", "NL_GOV_ALLOWED_ORIGINS", "NL_GOV_SESSION_TTL_MS", "NL_GOV_MAX_SESSIONS"];
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps Node's all-interfaces bind and no Origin check by default", () => {
    for (const name of ENV) vi.stubEnv(name, "");
    const options = resolveHttpOptions({ port: 1 });
    expect(options).toMatchObject({
      allowedOrigins: [],
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      maxSessions: DEFAULT_MAX_SESSIONS,
    });
    expect(options.host).toBeUndefined();
  });

  it("reads host, origins, TTL and cap from the environment", () => {
    vi.stubEnv("NL_GOV_HTTP_HOST", "127.0.0.1");
    vi.stubEnv("NL_GOV_ALLOWED_ORIGINS", " http://localhost:8080/ , HTTPS://Chat.Example.org,");
    vi.stubEnv("NL_GOV_SESSION_TTL_MS", "60000");
    vi.stubEnv("NL_GOV_MAX_SESSIONS", "5");
    expect(resolveHttpOptions({ port: 1 })).toMatchObject({
      host: "127.0.0.1",
      allowedOrigins: ["http://localhost:8080", "https://chat.example.org"],
      sessionTtlMs: 60_000,
      maxSessions: 5,
    });
  });

  it("rejects a TTL or cap that is not a positive integer", () => {
    vi.stubEnv("NL_GOV_SESSION_TTL_MS", "30m");
    expect(() => resolveHttpOptions({ port: 1 })).toThrow(/NL_GOV_SESSION_TTL_MS/);
    vi.stubEnv("NL_GOV_SESSION_TTL_MS", "");
    vi.stubEnv("NL_GOV_MAX_SESSIONS", "0");
    expect(() => resolveHttpOptions({ port: 1 })).toThrow(/NL_GOV_MAX_SESSIONS/);
  });
});

describe("HTTP transports", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    await handle?.closeConnections();
    handle?.httpServer?.closeAllConnections();
    handle?.httpServer?.close();
    handle = undefined;
  });

  async function start(
    kind: "streamable-http" | "sse",
    overrides: Partial<HttpServerOptions> = {},
  ): Promise<string> {
    const options = { port: 0, host: "127.0.0.1", allowedOrigins: [], ...overrides };
    handle = kind === "sse" ? await startSseServer(options) : await startStreamableHttpServer(options);
    const server = handle.httpServer!;
    if (!server.listening) await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function initialize(base: string): Promise<string> {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INIT) });
    await res.text();
    expect(res.status).toBe(200);
    return res.headers.get("mcp-session-id")!;
  }

  it("caps streamable-http sessions and closes the least recently used one", async () => {
    const base = await start("streamable-http", { maxSessions: 2 });
    const first = await initialize(base);
    await initialize(base);
    await initialize(base);
    await wait(20);
    expect(handle!.sessionCount!()).toBe(2);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": first, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("closes streamable-http sessions that stay idle past the TTL", async () => {
    const base = await start("streamable-http", { sessionTtlMs: 100, sweepIntervalMs: 25 });
    await initialize(base);
    await initialize(base);
    expect(handle!.sessionCount!()).toBe(2);
    await wait(250);
    expect(handle!.sessionCount!()).toBe(0);
  });

  it("keeps no session for a POST that is not an initialize request", async () => {
    const base = await start("streamable-http");
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await res.text();
    expect(res.status).toBe(400);
    expect(handle!.sessionCount!()).toBe(0);
  });

  it.each(["streamable-http", "sse"] as const)(
    "%s answers malformed and oversized bodies with JSON-RPC errors, no stack or paths",
    async (kind) => {
      const base = await start(kind);
      const path = kind === "sse" ? "/messages?sessionId=x" : "/mcp";

      const bad = await fetch(`${base}${path}`, { method: "POST", headers: MCP_HEADERS, body: "{not json" });
      const badText = await bad.text();
      expect(bad.status).toBe(400);
      expect(bad.headers.get("content-type")).toMatch(/application\/json/);
      expect(JSON.parse(badText)).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });

      const big = await fetch(`${base}${path}`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: { pad: "a".repeat(1_100_000) } }),
      });
      const bigText = await big.text();
      expect(big.status).toBe(413);
      expect(JSON.parse(bigText)).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });

      for (const text of [badText, bigText]) {
        expect(text).not.toMatch(/node_modules|at \w+ \(|<html|\\\\|[A-Z]:\//i);
      }
    },
  );

  it("rejects a non-matching Origin with 403 and lets matching or absent Origins through", async () => {
    const base = await start("streamable-http", { allowedOrigins: ["http://localhost:8080/"] });
    const evil = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "http://evil.example" },
      body: JSON.stringify(INIT),
    });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: { code: -32000 } });
    expect(handle!.sessionCount!()).toBe(0);

    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "http://LOCALHOST:8080" },
      body: JSON.stringify(INIT),
    });
    await ok.text();
    expect(ok.status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("closes an SSE session once when the client disconnects (no close recursion)", async () => {
    const base = await start("sse");
    const closeSpy = vi.spyOn(SSEServerTransport.prototype, "close");
    try {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new SSEClientTransport(new URL(`${base}/mcp`)));
      await client.listTools();
      expect(handle!.sessionCount!()).toBe(1);
      await client.close();
      await wait(100);
      expect(handle!.sessionCount!()).toBe(0);
      // Without the guard close() recursed until "Maximum call stack size exceeded".
      expect(closeSpy.mock.calls.length).toBeLessThanOrEqual(2);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("caps SSE sessions and closes the oldest stream", async () => {
    const base = await start("sse", { maxSessions: 1 });
    const a = new Client({ name: "a", version: "0" });
    await a.connect(new SSEClientTransport(new URL(`${base}/mcp`)));
    const b = new Client({ name: "b", version: "0" });
    await b.connect(new SSEClientTransport(new URL(`${base}/mcp`)));
    expect(handle!.sessionCount!()).toBe(1);
    await expect(b.listTools()).resolves.toBeDefined();
    // The first session was closed to make room, so its messages are refused.
    await expect(a.listTools()).rejects.toThrow(/404|Unknown sessionId/);
    await b.close();
    await a.close();
  });
});
