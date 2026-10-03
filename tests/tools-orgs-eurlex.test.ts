import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse } from "./helpers/config.js";

/** Call one tool on an in-process server and return its parsed JSON payload. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "orgs-eurlex-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
    };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

const TOOI = "https://identifier.overheid.nl/tooi/id/";
const ONT = "https://identifier.overheid.nl/tooi/def/ont/";
const WATERSCHAPPEN = [
  { label: "waterschap Aa en Maas", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0654` },
  { label: "waterschap Reest en Wieden", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0648` },
];
const TOOI_META = {
  results: {
    bindings: [{ org: { value: `${TOOI}waterschap/ws0648` }, end: { value: "2015-12-31" } }],
  },
};

type Rec = { title: string; canonical_url: string; snippet?: string; data: Record<string, unknown> };

describe("overheidsorganisaties_search tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("browses without a query and links to a register page instead of the bare TOOI URI", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return jsonResponse(url.includes("standaarden.overheid.nl/tooi/sparql") ? TOOI_META : WATERSCHAPPEN);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await callTool("overheidsorganisaties_search", {
      type: `${ONT}Waterschap`,
      top: 50,
      enrich: false,
    });

    expect(out.error).toBeUndefined();
    const records = out.records as Rec[];
    expect(records.map((r) => r.title)).toEqual(["waterschap Aa en Maas", "waterschap Reest en Wieden"]);
    expect(records[0].canonical_url).toBe(
      "https://standaarden.overheid.nl/tooi/waardelijsten/item?id=https%3A%2F%2Fidentifier.overheid.nl%2Ftooi%2Fid%2Fwaterschap%2Fws0654",
    );
    expect(records[0].data.tooi_uri).toBe(`${TOOI}waterschap/ws0654`);
    expect(records[1].snippet).toBe("Waterschap — opgeheven (einddatum 2015-12-31)");
    expect(String(out.access_note)).toContain("1 van de 2 treffers is opgeheven");
  });

  it("passes active_only through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return jsonResponse(url.includes("standaarden.overheid.nl/tooi/sparql") ? TOOI_META : WATERSCHAPPEN);
      }),
    );

    const out = await callTool("overheidsorganisaties_search", { active_only: true, enrich: false });

    expect((out.records as Rec[]).map((r) => r.title)).toEqual(["waterschap Aa en Maas"]);
    expect((out.provenance as { query_params: Record<string, string> }).query_params.active_only).toBe("true");
  });

  it("enriches the first 15 hits of the shown page when a query has more (review: 'GGD' went from 5 enriched hits to none)", async () => {
    const ggd = Array.from({ length: 17 }, (_, i) => ({
      label: `Gemeentelijke Gezondheidsdienst Regio ${i + 1}`,
      type: `${ONT}Samenwerkingsorganisatie`,
      uri: `${TOOI}so/so${9000 + i}`,
    }));
    const route = (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("standaarden.overheid.nl/tooi/sparql")) return jsonResponse(TOOI_META);
      if (url.includes("/contact")) return jsonResponse({ internetadressen: [{ url: "www.ggd.example.nl" }] });
      if (url.includes("/adressen")) return jsonResponse([]);
      return jsonResponse(ggd);
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => route(input)));

    const out = await callTool("overheidsorganisaties_search", { query: "GGD" });
    const records = out.records as Rec[];
    expect(records).toHaveLength(17);
    expect(records.slice(0, 15).every((r) => r.canonical_url === "https://www.ggd.example.nl")).toBe(true);
    expect(records.slice(15).every((r) => r.canonical_url.startsWith("https://standaarden.overheid.nl/tooi/"))).toBe(true);
    expect(String(out.access_note)).toContain("2 treffers zijn niet verrijkt");

    // A later page is enriched itself.
    clearHttpCache();
    const page2 = await callTool("overheidsorganisaties_search", { query: "GGD", offset: 15, limit: 5 });
    expect((page2.records as Rec[]).map((r) => r.canonical_url)).toEqual(["https://www.ggd.example.nl", "https://www.ggd.example.nl"]);
  });

  it("names the TOOI request and, with enrich, the per-hit register calls in dryRun (review)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const out = await callTool("overheidsorganisaties_search", { query: "afvalinzameling", dryRun: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.dry_run).toBe(true);
    expect(out.estimated_sources).toEqual(["overheidsorganisaties", "tooi_sparql"]);
    const planned = out.planned_requests as Array<{ connector: string; url: string; params: Record<string, unknown> }>;
    expect(planned.map((p) => p.connector)).toEqual(["overheidsorganisaties", "tooi_sparql", "overheidsorganisaties"]);
    expect(planned[0]).toMatchObject({ url: "https://api-organisaties.overheid.nl/v1/overheidsorganisaties", params: { query: "afvalinzameling" } });
    expect(planned[1].url).toBe("https://standaarden.overheid.nl/tooi/sparql");
    expect(planned[2].url).toContain("/overheidsorganisaties/{tooi_uri}/");
    expect((out.cache_status as Array<{ connector: string }>).map((c) => c.connector)).toEqual(["overheidsorganisaties", "tooi_sparql"]);

    const bare = await callTool("overheidsorganisaties_search", { query: "afvalinzameling", enrich: false, dryRun: true });
    expect((bare.planned_requests as Array<{ connector: string }>).map((p) => p.connector)).toEqual(["overheidsorganisaties", "tooi_sparql"]);
  });
});

describe("eurlex tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("accepts 'VK' in eurlex_search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: { bindings: [] } })));
    const out = await callTool("eurlex_search", { query: "VK" });
    expect(out.error).toBeUndefined();
    expect((out.provenance as { query_params: Record<string, string> }).query_params.freetext).toBe('"VK"');
  });

  it("returns titles without the two-letter word as match 'title_partial' (review: 'Brexit VK' gave 0)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const q = url.searchParams.get("query") ?? "";
        if (!q.includes(`bif:contains '"Brexit"'`)) return jsonResponse({ results: { bindings: [] } });
        return jsonResponse({
          results: {
            bindings: [
              {
                celex: { value: "32026R0211" },
                date: { value: "2026-02-01" },
                type: { value: "http://publications.europa.eu/resource/authority/resource-type/REG" },
                title: { value: "Verordening (EU) 2026/211 ... brexit ..." },
              },
            ],
          },
        });
      }),
    );

    const out = await callTool("eurlex_search", { query: "Brexit VK" });
    expect((out.records as Rec[]).map((r) => [r.data.celex, r.data.match])).toEqual([["32026R0211", "title_partial"]]);
    const params = (out.provenance as { query_params: Record<string, string> }).query_params;
    expect(params).toMatchObject({ freetext: '"Brexit" AND "VK"', freetext_partial: '"Brexit"' });
    expect(String(out.access_note)).toContain("zonder 'VK'");
  });

  it("looks up 'Verordening (EU) 10/2011' as 32011R0010 in eurlex_document (review: read as 2010/2011)", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        queries.push(url.searchParams.get("query") ?? "");
        return jsonResponse({ results: { bindings: [] } });
      }),
    );
    const out = await callTool("eurlex_document", { id: "Verordening (EU) 10/2011", dryRun: true });
    expect(JSON.stringify(out)).toContain("32011R0010");
    expect(queries).toEqual([]);
  });

  it("looks up 'Verordening (EG) 1998/2006' as 32006R1998 in eurlex_document (re-review: read as 2006/98)", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        queries.push(url.searchParams.get("query") ?? "");
        return jsonResponse({ results: { bindings: [] } });
      }),
    );
    const out = await callTool("eurlex_document", { id: "Verordening (EG) 1998/2006", dryRun: true });
    expect(JSON.stringify(out)).toContain("32006R1998");
    expect(JSON.stringify(out)).not.toContain("31998R2006");
    expect(queries).toEqual([]);
  });

  it("looks an act up by its own full title in eurlex_document (re-review 3: the (EG) acts it amends gave 31999R2018)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: { bindings: [] } })));
    const id =
      "Verordening (EU) 2018/1999 van het Europees Parlement en de Raad van 11 december 2018 inzake de governance van de " +
      "energie-unie en van de klimaatactie, tot wijziging van Verordeningen (EG) nr. 663/2009 en (EG) nr. 715/2009";

    const out = await callTool("eurlex_document", { id, dryRun: true });

    expect((out.planned_requests as Array<{ params: Record<string, unknown> }>)[0].params).toEqual({ celex: "32018R1999" });
    expect(JSON.stringify(out)).not.toContain("31999R2018");
  });

  it("shows amending acts in eurlex_document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const q = url.searchParams.get("query") ?? "";
        if (q.includes("COUNT(DISTINCT ?act)")) return jsonResponse({ results: { bindings: [{ rel: { value: "amended_by" }, n: { value: "1" } }] } });
        if (q.includes("resource_legal_amends_resource_legal")) {
          return jsonResponse({
            results: {
              bindings: [
                { rel: { value: "amended_by" }, celex: { value: "32026R1302" }, date: { value: "2026-05-20" }, force: { value: "1" } },
              ],
            },
          });
        }
        if (q.includes("COUNT(DISTINCT ?case)")) return jsonResponse({ results: { bindings: [{ n: { value: "0" } }] } });
        if (q.includes("case-law_interpretes_resource_legal")) return jsonResponse({ results: { bindings: [] } });
        return jsonResponse({
          results: {
            bindings: [
              {
                type: { value: "http://publications.europa.eu/resource/authority/resource-type/REG" },
                force: { value: "1" },
                titleNl: { value: "Verordening (EU) 2016/679" },
              },
            ],
          },
        });
      }),
    );

    const out = await callTool("eurlex_document", { id: "32016R0679" });

    const data = (out.records as Rec[])[0].data;
    expect(data.in_force).toBe(true);
    expect(data.amended_by_total).toBe(1);
    expect(data.amended_by).toEqual([
      {
        celex: "32026R1302",
        title: null,
        date: "2026-05-20",
        in_force: true,
        eurlex_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:32026R1302",
      },
    ]);
    expect(String(out.access_note)).toContain("32026R1302");
  });
});
