import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_TTL_MS,
  SessionRegistry,
  exposureWarning,
  resolveHttpOptions,
  startSseServer,
  startStreamableHttpServer,
  type HttpServerOptions,
  type ServerHandle,
} from "../src/server.js";
import { logger } from "../src/utils/logger.js";

// Every McpServer also gets three test tools: records and an error in the repo's own result shape
// (so both HTTP modes can be compared) and a tool that waits until the test lets it finish.
const gate = vi.hoisted(() => ({ started: 0, waiting: [] as Array<() => void> }));
vi.mock("../src/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools.js")>();
  const { z } = await import("zod");
  const { buildFormattedResponse } = await import("../src/utils/tool-runner.js");
  const { errorResponse, toMcpToolPayload } = await import("../src/utils/response.js");
  return {
    ...actual,
    registerTools: (server: Parameters<typeof actual.registerTools>[0]) => {
      actual.registerTools(server);
      server.registerTool("test_records", { inputSchema: { tag: z.string() } }, async ({ tag }) =>
        toMcpToolPayload(
          buildFormattedResponse({
            summary: `1 record for ${tag}`,
            records: [{ title: `Record ${tag}`, source_name: "Test", canonical_url: `https://example.org/r/${tag}` }],
            provenance: {
              tool: "test_records",
              endpoint: "https://example.org/api",
              query_params: { tag },
              timestamp: "2026-01-01T00:00:00.000Z",
              returned_results: 1,
            },
            outputFormat: "json",
            offset: 0,
            limit: 10,
          }),
        ),
      );
      server.registerTool("test_error", {}, async () =>
        toMcpToolPayload(errorResponse({ error: "http_error", message: "Upstream returned 502", suggestion: "Try again later" })),
      );
      server.registerTool("test_slow", {}, async () => {
        gate.started++;
        await new Promise<void>((resolve) => gate.waiting.push(resolve));
        return { content: [{ type: "text" as const, text: "done" }] };
      });
    },
  };
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};
const INIT_WITH = (protocolVersion: string) => ({ ...INIT, params: { ...INIT.params, protocolVersion } });
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
    // A TTL of 1 s, not 100 ms: under a full parallel test run an initialize (which
    // registers every tool) can take longer than 100 ms, so the first session was
    // swept before the second existed. Poll for the sweep for the same reason.
    const base = await start("streamable-http", { sessionTtlMs: 1000, sweepIntervalMs: 25 });
    await initialize(base);
    await initialize(base);
    expect(handle!.sessionCount!()).toBe(2);
    await vi.waitFor(() => expect(handle!.sessionCount!()).toBe(0), { timeout: 5000, interval: 25 });
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

describe("HTTP options for stateless mode, JSON responses and source health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps sessions, SSE responses and /health/sources by default", () => {
    for (const name of ["NL_GOV_HTTP_STATELESS", "NL_GOV_HTTP_JSON_RESPONSE", "NL_GOV_HTTP_MAX_CONCURRENT", "NL_GOV_HTTP_SOURCE_HEALTH"]) {
      vi.stubEnv(name, "");
    }
    expect(resolveHttpOptions({ port: 1 })).toMatchObject({
      stateless: false,
      jsonResponse: false,
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      sourceHealth: true,
    });
  });

  it("reads the flags and the concurrency limit from the environment", () => {
    vi.stubEnv("NL_GOV_HTTP_STATELESS", "true");
    vi.stubEnv("NL_GOV_HTTP_JSON_RESPONSE", " TRUE ");
    vi.stubEnv("NL_GOV_HTTP_MAX_CONCURRENT", "8");
    vi.stubEnv("NL_GOV_HTTP_SOURCE_HEALTH", "false");
    expect(resolveHttpOptions({ port: 1 })).toMatchObject({
      stateless: true,
      jsonResponse: true,
      maxConcurrent: 8,
      sourceHealth: false,
    });
  });

  it("rejects a flag that is not true or false and a limit that is not a positive integer", () => {
    vi.stubEnv("NL_GOV_HTTP_STATELESS", "maybe");
    expect(() => resolveHttpOptions({ port: 1 })).toThrow(/NL_GOV_HTTP_STATELESS/);
    vi.stubEnv("NL_GOV_HTTP_STATELESS", "");
    vi.stubEnv("NL_GOV_HTTP_MAX_CONCURRENT", "0");
    expect(() => resolveHttpOptions({ port: 1 })).toThrow(/NL_GOV_HTTP_MAX_CONCURRENT/);
  });

  it("warns only for an all-interfaces bind without an Origin allowlist", () => {
    for (const host of [undefined, "", "0.0.0.0", "::"]) {
      expect(exposureWarning({ host, allowedOrigins: [] })).toMatch(/NL_GOV_HTTP_HOST.*NL_GOV_ALLOWED_ORIGINS/);
    }
    expect(exposureWarning({ host: undefined, allowedOrigins: ["https://chat.example.org"] })).toBeUndefined();
    expect(exposureWarning({ host: "127.0.0.1", allowedOrigins: [] })).toBeUndefined();
  });
});

describe("Streamable HTTP: stateless mode and JSON responses", () => {
  let handle: ServerHandle | undefined;
  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const V = { "mcp-protocol-version": "2025-06-18" };

  afterEach(async () => {
    // Let any test_slow call still waiting finish, so no handler outlives its test.
    for (const resolve of gate.waiting.splice(0)) resolve();
    gate.started = 0;
    await handle?.closeConnections();
    handle?.httpServer?.closeAllConnections();
    handle?.httpServer?.close();
    handle = undefined;
    vi.restoreAllMocks();
  });

  async function start(overrides: Partial<HttpServerOptions> = {}): Promise<string> {
    handle = await startStreamableHttpServer({ port: 0, host: "127.0.0.1", allowedOrigins: [], ...overrides });
    const server = handle.httpServer!;
    if (!server.listening) await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  interface Reply {
    status: number;
    type: string;
    sessionId: string | null;
    headers: Headers;
    message: any;
  }

  /** POST a JSON-RPC message and read the reply, whether it came as JSON or as an SSE stream. */
  async function post(base: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Reply> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    let message: any;
    if (type.includes("text/event-stream")) {
      const data = text.split("\n").find((line) => line.startsWith("data: "));
      message = data ? JSON.parse(data.slice(6)) : undefined;
    } else if (text) {
      message = JSON.parse(text);
    }
    return { status: res.status, type, sessionId: res.headers.get("mcp-session-id"), headers: res.headers, message };
  }

  const structured = (reply: Reply) => reply.message?.result?.structuredContent;

  it.each([true, false])("answers initialize without a session id (JSON responses: %s)", async (jsonResponse) => {
    const base = await start({ stateless: true, jsonResponse });
    const reply = await post(base, INIT);
    expect(reply.status).toBe(200);
    expect(reply.sessionId).toBeNull();
    expect(reply.type).toMatch(jsonResponse ? /application\/json/ : /text\/event-stream/);
    expect(reply.message).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "nl-gov-mcp" } } });
    expect(reply.message.result.instructions).toContain("nl_gov_ask");
    expect(handle!.sessionCount!()).toBe(0);
  });

  it("serves tools/list and tools/call without initialize and without a session header", async () => {
    const base = await start({ stateless: true, jsonResponse: true });
    const list = await post(base, LIST, V);
    expect(list.status).toBe(200);
    const names = list.message.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["nl_gov_ask", "cbs_tables_search", "test_records"]));

    // Without an MCP-Protocol-Version header the SDK assumes 2025-03-26 and still answers.
    const result = await post(base, call(3, "test_records", { tag: "a" }));
    expect(result.status).toBe(200);
    expect(result.message.id).toBe(3);
    expect(structured(result).records[0]).toMatchObject({ canonical_url: "https://example.org/r/a" });
    await vi.waitFor(() => expect(handle!.inFlightCount!()).toBe(0));
  });

  it("keeps working when a proxy drops Mcp-Session-Id, where the stateful mode fails", async () => {
    const stateful = await start();
    const init = await post(stateful, INIT);
    expect(init.sessionId).toBeTruthy();
    const failed = await post(stateful, LIST, V); // the session header did not survive the proxy
    expect(failed.status).toBe(400);
    expect(failed.message).toMatchObject({ error: { code: -32000, message: expect.stringMatching(/not initialized/) } });
    await handle!.closeConnections();
    handle!.httpServer!.closeAllConnections();
    handle!.httpServer!.close();

    const stateless = await start({ stateless: true });
    expect((await post(stateless, INIT)).status).toBe(200);
    const ok = await post(stateless, LIST, V);
    expect(ok.status).toBe(200);
    expect(ok.message.result.tools.length).toBeGreaterThan(90);
    const tool = await post(stateless, call(4, "test_records", { tag: "b" }), V);
    expect(structured(tool).records[0].canonical_url).toBe("https://example.org/r/b");
  });

  it("answers concurrent requests with the same JSON-RPC id without mixing them up", async () => {
    const base = await start({ stateless: true, jsonResponse: true });
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? post(base, { ...LIST, id: 7 }, V) : post(base, call(7, "test_records", { tag: `t${i}` }), V))),
    );
    replies.forEach((reply, i) => {
      expect(reply.status).toBe(200);
      expect(reply.message.id).toBe(7);
      if (i % 2) expect(reply.message.result.tools.length).toBeGreaterThan(90);
      else expect(structured(reply).records[0].canonical_url).toBe(`https://example.org/r/t${i}`);
    });
    await vi.waitFor(() => expect(handle!.inFlightCount!()).toBe(0));
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("stateless %s, JSON responses %s: a tool call answers with the matching content type", async (stateless, jsonResponse) => {
    const base = await start({ stateless, jsonResponse });
    const init = await post(base, INIT);
    expect(init.status).toBe(200);
    expect(init.sessionId === null).toBe(stateless);
    const headers = init.sessionId ? { ...V, "mcp-session-id": init.sessionId } : V;
    const reply = await post(base, call(5, "test_records", { tag: "c" }), headers);
    expect(reply.status).toBe(200);
    expect(reply.type).toMatch(jsonResponse ? /application\/json/ : /text\/event-stream/);
    expect(structured(reply).records[0].canonical_url).toBe("https://example.org/r/c");
  });

  it("returns the same tool results, records and errors, with and without sessions", async () => {
    const results = [];
    for (const stateless of [false, true]) {
      const base = await start({ stateless, jsonResponse: true });
      const init = await post(base, INIT);
      const headers = init.sessionId ? { ...V, "mcp-session-id": init.sessionId } : V;
      const records = await post(base, call(6, "test_records", { tag: "same" }), headers);
      const error = await post(base, call(7, "test_error"), headers);
      results.push({ records: records.message.result, error: error.message.result });
      await handle!.closeConnections();
      handle!.httpServer!.closeAllConnections();
      handle!.httpServer!.close();
      handle = undefined;
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0].records.structuredContent.records[0]).toMatchObject({ canonical_url: "https://example.org/r/same" });
    expect(results[0].error.structuredContent).toMatchObject({ error: "http_error", message: "Upstream returned 502" });
  });

  it.each(["GET", "DELETE"])("answers %s /mcp with 405, an Allow header and a JSON-RPC error", async (method) => {
    const base = await start({ stateless: true });
    const res = await fetch(`${base}/mcp`, { method, headers: { accept: "application/json, text/event-stream" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
  });

  it("answers 503 with Retry-After over the concurrency limit and frees the slot when a request ends", async () => {
    const base = await start({ stateless: true, jsonResponse: true, maxConcurrent: 1 });
    const slow = post(base, call(8, "test_slow"), V);
    await vi.waitFor(() => expect(gate.started).toBe(1));
    expect(handle!.inFlightCount!()).toBe(1);

    const busy = await post(base, LIST, V);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(busy.message).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });

    gate.waiting.shift()!();
    expect((await slow).message.result.content[0].text).toBe("done");
    await vi.waitFor(() => expect(handle!.inFlightCount!()).toBe(0));
    expect((await post(base, LIST, V)).status).toBe(200);
  });

  it("frees the slot when the client aborts a request", async () => {
    const base = await start({ stateless: true, maxConcurrent: 1 });
    const controller = new AbortController();
    const aborted = post(base, call(9, "test_slow"), V, controller.signal).catch((err: Error) => err);
    await vi.waitFor(() => expect(gate.started).toBe(1));
    controller.abort();
    expect(await aborted).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(handle!.inFlightCount!()).toBe(0));
    expect((await post(base, LIST, V)).status).toBe(200);
  });

  it("frees the slot when a request fails before it reaches the transport", async () => {
    const base = await start({ stateless: true, maxConcurrent: 1 });
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{not json" });
    expect(bad.status).toBe(400);
    const notJsonRpc = await post(base, { hello: "world" }, V);
    expect(notJsonRpc.status).toBe(400);
    await vi.waitFor(() => expect(handle!.inFlightCount!()).toBe(0));
    expect((await post(base, LIST, V)).status).toBe(200);
  });

  it("negotiates a supported version for an unknown one and rejects an unsupported version header", async () => {
    const base = await start({ stateless: true, jsonResponse: true });
    for (const requested of ["1999-01-01", "2026-07-28"]) {
      const init = await post(base, INIT_WITH(requested));
      expect(init.status).toBe(200);
      expect(init.message.result.protocolVersion).toBe("2025-11-25");
    }
    const old = await post(base, INIT_WITH("2024-11-05"));
    expect(old.message.result.protocolVersion).toBe("2024-11-05");

    const unsupported = await post(base, LIST, { "mcp-protocol-version": "2026-07-28" });
    expect(unsupported.status).toBe(400);
    expect(unsupported.message).toMatchObject({ error: { code: -32000, message: expect.stringMatching(/Unsupported protocol version/) } });
  });

  it("hides /health/sources with sourceHealth false and keeps /health", async () => {
    let base = await start({ stateless: true, sourceHealth: false });
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health/sources`)).status).toBe(404);
    await handle!.closeConnections();
    handle!.httpServer!.closeAllConnections();
    handle!.httpServer!.close();

    base = await start();
    const sources = await fetch(`${base}/health/sources`);
    expect(sources.status).toBe(200);
    expect(await sources.json()).toMatchObject({ ok: true, connectors: expect.anything() });
  });

  it("logs one startup warning when bound to all interfaces without an Origin allowlist", async () => {
    const warn = vi.spyOn(logger, "warn");
    await start({ host: "127.0.0.1" });
    expect(warn).not.toHaveBeenCalled();
    await handle!.closeConnections();
    handle!.httpServer!.closeAllConnections();
    handle!.httpServer!.close();

    await start({ host: "0.0.0.0", stateless: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/all interfaces.*NL_GOV_HTTP_HOST.*NL_GOV_ALLOWED_ORIGINS/);
  });
});
