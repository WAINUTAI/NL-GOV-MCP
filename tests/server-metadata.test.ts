import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

// Claude Code cuts tool descriptions and server instructions at 2048 characters.
const CLIENT_DESCRIPTION_LIMIT = 2048;

describe("server metadata in initialize and tools/list", () => {
  const client = new Client({ name: "metadata-test", version: "1.0.0" });
  let tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools;
  });

  afterAll(async () => {
    await client.close();
  });

  it("sends server instructions that point to nl_gov_ask and fit the client limit", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("nl_gov_ask");
    expect(instructions).toContain("DSO_API_KEY");
    // The honesty contract: error, partial failure and empty are told apart.
    expect(instructions).toMatch(/'error' field is a failure/);
    expect(instructions).toMatch(/'failures' lists sources that failed/);
    expect(instructions.length).toBeLessThanOrEqual(CLIENT_DESCRIPTION_LIMIT);
  });

  it("keeps every tool description within the client limit", () => {
    const tooLong = tools.filter((t) => (t.description ?? "").length > CLIENT_DESCRIPTION_LIMIT).map((t) => t.name);
    expect(tooLong).toEqual([]);
  });

  it("marks only nl_gov_ask to load upfront", () => {
    const alwaysLoad = tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name);
    expect(alwaysLoad).toEqual(["nl_gov_ask"]);
  });

  it("keeps the key requirement and the when-to-use line in the shortened descriptions", () => {
    const desc = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    expect(desc("nl_gov_ask")).toMatch(/^Use this when the best source is unclear/);
    expect(desc("dso_omgevingsdocumenten_search")).toContain("Requires DSO_API_KEY");
    expect(desc("dso_omgevingsdocument_tekst")).toContain("Requires DSO_API_KEY");
  });
});
