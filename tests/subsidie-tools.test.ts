import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { setCrawlDelaysEnabled } from "../src/utils/http.js";
import { jsonResponse } from "./helpers/config.js";
import { TOPIC_HIT, searchBody } from "./helpers/eu-funding-fixtures.js";

/* ------------------------------------------------------------------ */
/*  The subsidy tools as registered: eu_funding_*, rvo_subsidie(s)_*,  */
/*  nl_onderzoek_call(s)_*: dryRun plans, record shape and errors.     */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

beforeEach(() => {
  clearHttpCache();
  // The mocked sites answer at once; nwo.nl's and zonmw.nl's crawl delays would only slow the tests.
  setCrawlDelaysEnabled(false);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => setCrawlDelaysEnabled(true));

describe("subsidy tools", () => {
  it("are registered", () => {
    for (const name of ["eu_funding_search", "eu_funding_get", "rvo_subsidies_search", "rvo_subsidie_get", "nl_onderzoek_calls_search", "nl_onderzoek_call_get"]) {
      expect(tools.has(name), name).toBe(true);
    }
  });

  it("plan the portal's multipart POST, the RVO catalogue and one request per research funder", async () => {
    const eu = await call("eu_funding_search", { query: "hydrogen", dryRun: true });
    expect(eu.planned_requests[0]).toMatchObject({ connector: "eu_funding", method: "POST", url: "https://api.tech.ec.europa.eu/search-api/prod/rest/search" });
    expect(eu.planned_requests[0].params.query).toContain("hydrogen");

    const rvo = await call("rvo_subsidies_search", { query: "waterstof", status: ["open"], dryRun: true });
    expect(rvo.planned_requests[0]).toMatchObject({ connector: "rvo_subsidies", method: "GET", params: { query: "waterstof", status: "open" } });
    expect(rvo.planned_requests[0].params.status_pages).toContain("rvo_subsidies_pages");

    const both = await call("nl_onderzoek_calls_search", { query: "klimaat", dryRun: true });
    expect(both.estimated_sources).toEqual(["nwo_calls", "zonmw_subsidies"]);
    expect(both.planned_requests.map((r: { url: string }) => new URL(r.url).hostname)).toEqual(["www.nwo.nl", "www.zonmw.nl"]);

    const page = await call("nl_onderzoek_call_get", { url: "https://www.zonmw.nl/nl/subsidie/voorbeeld", dryRun: true });
    expect(page.planned_requests[0]).toMatchObject({ connector: "zonmw_subsidies", url: "https://www.zonmw.nl/nl/subsidie/voorbeeld" });
  });

  it("returns EU calls as records dated by their next deadline, with the portal's paging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(searchBody([TOPIC_HIT], 1))));
    const res = await call("eu_funding_search", { query: "process industries", top: 5 });
    expect(res.records[0]).toMatchObject({
      source_name: "eu_funding",
      canonical_url: expect.stringContaining("topic-details/HORIZON-CL4-2027-02-MAT-PROD-32-two-stage"),
      date: "2027-02-02",
    });
    expect(res.pagination).toMatchObject({ offset: 0, total: 1, has_more: false });
    expect(res.provenance.tool).toBe("eu_funding_search");
  });

  it("refuses bad input before any request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const programme = await call("eu_funding_search", { programme: "Geen Programma" });
    expect(programme).toMatchObject({ error: "unexpected" });
    expect(programme.message).toContain("Geen Programma");
    const host = await call("nl_onderzoek_call_get", { url: "https://www.example.org/calls/x" });
    expect(host).toMatchObject({ error: "unexpected" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
