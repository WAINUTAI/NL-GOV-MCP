import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectAlgoritmeIntent, registerTools } from "../src/tools.js";

describe("nl_gov_ask: algorithm questions", () => {
  it("sends the algorithms of a government body, a topic or high-risk AI to the Algoritmeregister", () => {
    expect(detectAlgoritmeIntent("Welke algoritmes gebruikt de gemeente Amsterdam?")).toEqual({ organisatie: "gemeente Amsterdam" });
    expect(detectAlgoritmeIntent("Welke hoog-risico AI-systemen gebruikt het UWV?")).toEqual({ organisatie: "UWV", publicatiecategorie: "Hoog-risico AI-systeem" });
    expect(detectAlgoritmeIntent("Welke algoritmes gebruikt de overheid voor fraudedetectie?")).toEqual({ query: "fraudedetectie" });
    expect(detectAlgoritmeIntent("Algoritmes van het Ministerie van Financiën")).toEqual({ organisatie: "Ministerie van Financiën" });
    expect(detectAlgoritmeIntent("Algoritmes voor vergunningverlening in Utrecht")).toEqual({ query: "vergunningverlening" });
  });

  it("leaves documents about algorithms and the law on them to the other routes", () => {
    for (const q of [
      "Raadsvoorstel over algoritmes in Utrecht",
      "Wat zegt de AI Act over algoritmes?",
      "Rekenkamerrapport over algoritmes gemeente Rotterdam",
      "Kamervragen over algoritmes bij de Belastingdienst",
      "Wat is een algoritme?",
    ]) {
      expect(detectAlgoritmeIntent(q), q).toBeUndefined();
    }
  });

  it("plans the register search", async () => {
    type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
    registerTools({
      registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
        tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
      },
    } as unknown as McpServer);
    const tool = tools.get("nl_gov_ask")!;
    const args: Record<string, unknown> = { question: "Welke algoritmes gebruikt de gemeente Amsterdam?", dryRun: true };
    const parsed: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
    const plan = JSON.parse((await tool.handler(parsed)).content[0].text);
    expect(plan.estimated_sources).toEqual(["algoritmeregister"]);
    expect(plan.planned_requests[0]).toMatchObject({ connector: "algoritmeregister", method: "POST", params: { organisatie: "gemeente Amsterdam" } });
  });
});
