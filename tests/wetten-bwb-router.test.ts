import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { appCache } from "../src/cache.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  nl_gov_ask's wet_artikel route reads wetten_bwb_tekst's answers:   */
/*  an unknown law goes on to the other routes, a BWB failure is a     */
/*  failure, a missing artikel of a known law is the answer.           */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function ask(question: string): Promise<Record<string, any>> {
  const tool = tools.get("nl_gov_ask")!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(key === "question" ? question : undefined);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

function mockFetch(route: (url: URL) => Response | undefined) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return route(url) ?? new Response("not found", { status: 404 });
  }));
}

const sru = (total: number, records = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><numberOfRecords>${total}</numberOfRecords><records>${records}</records></searchRetrieveResponse>`;
const AWB_RECORD = `<record><recordData><gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/"><originalData><overheidbwb:meta>
  <owmskern><dcterms:identifier>BWBR0005537</dcterms:identifier><dcterms:title>Algemene wet bestuursrecht</dcterms:title><dcterms:type>wet</dcterms:type></owmskern>
  <bwbipm><overheidbwb:toestand>http://wetten.overheid.nl/id/BWBR0005537/2026-08-15/0</overheidbwb:toestand><overheidbwb:geldigheidsperiode_startdatum>2026-08-15</overheidbwb:geldigheidsperiode_startdatum><overheidbwb:geldigheidsperiode_einddatum>9999-12-31</overheidbwb:geldigheidsperiode_einddatum></bwbipm>
</overheidbwb:meta></originalData><enrichedData><overheidbwb:locatie_toestand>https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0005537/2026-08-15_0/xml/BWBR0005537_2026-08-15_0.xml</overheidbwb:locatie_toestand></enrichedData></gzd></recordData></record>`;
const AWB_XML = `<?xml version="1.0" encoding="UTF-8"?><toestand bwb-id="BWBR0005537" inwerkingtreding="2026-08-15"><wetgeving><wet-besluit><wettekst>
  <artikel label="Artikel 3:4" status="goed"><kop><label>Artikel</label><nr>3:4</nr></kop><lid><lidnr>1</lidnr><al>Het bestuursorgaan weegt de belangen af.</al></lid></artikel>
</wettekst></wet-besluit></wetgeving></toestand>`;
const EMPTY_CKAN = { success: true, result: { count: 0, results: [] } };

beforeEach(() => {
  clearHttpCache();
  appCache.clear();
  vi.stubEnv("DSO_API_KEY", "");
  vi.stubEnv("OVERHEID_API_KEY", "");
  vi.stubEnv("KNMI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("nl_gov_ask: the answers of wetten_bwb_tekst", () => {
  it("reports a failing BWB as a failure, not as a law it does not know", async () => {
    mockFetch((url) => (url.hostname === "zoekservice.overheid.nl" ? new Response("unavailable", { status: 503 }) : url.hostname === "data.overheid.nl" ? jsonResponse(EMPTY_CKAN) : undefined));
    const res = await ask("Wat staat er in artikel 3:4 Awb?");

    expect(res.access_note).toContain("Eerst gezocht in de BWB (wet 'Awb', artikel '3:4')");
    expect((res.failures ?? []).map((f: { connector: string }) => f.connector)).toContain("wetten_bwb");
  });

  it("reports a maintenance page instead of the toestand as a failure, not as an artikel not found", async () => {
    mockFetch((url) => {
      if (url.hostname === "repository.officiele-overheidspublicaties.nl") return new Response("<html><body>Onderhoud</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      if (url.hostname === "data.overheid.nl") return jsonResponse(EMPTY_CKAN);
      if (url.hostname !== "zoekservice.overheid.nl") return undefined;
      const query = url.searchParams.get("query") ?? "";
      return xmlResponse(query.startsWith("overheidbwb.afkorting=Awb and") || query.startsWith("dcterms.identifier=BWBR0005537 and") ? sru(1, AWB_RECORD) : sru(0));
    });
    const res = await ask("Wat staat er in artikel 3:4 Awb?");

    expect(res.summary).not.toContain("niet gevonden in Algemene wet bestuursrecht");
    expect((res.failures ?? []).map((f: { connector: string }) => f.connector)).toContain("wetten_bwb");
  });

  it("answers with the BWB when the law is known but the artikel is not", async () => {
    mockFetch((url) => {
      if (url.hostname === "repository.officiele-overheidspublicaties.nl") return xmlResponse(AWB_XML);
      if (url.hostname !== "zoekservice.overheid.nl") return undefined;
      const query = url.searchParams.get("query") ?? "";
      return xmlResponse(query.startsWith("overheidbwb.afkorting=Awb and") || query.startsWith("dcterms.identifier=BWBR0005537 and") ? sru(1, AWB_RECORD) : sru(0));
    });
    const res = await ask("Wat staat er in artikel 3:99 Awb?");

    expect(res.summary).toContain("Router: Wetten (BWB) — Artikel '3:99' niet gevonden in Algemene wet bestuursrecht");
    expect(res.records).toEqual([]);
    expect(res.failures).toBeUndefined();
  });
});
