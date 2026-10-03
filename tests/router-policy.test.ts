import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asksForRulings, detectPolicyIntent, oriPlacePhrase, registerTools, toOriQuery, toPhraseQuery } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { appCache } from "../src/cache.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";
import { SRU_DIAGNOSTIC } from "./helpers/bekendmakingen-fixtures.js";

/* ------------------------------------------------------------------ */
/*  Harness: call the nl_gov_ask handler without an MCP transport      */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function ask(args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get("nl_gov_ask")!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

/* ------------------------------------------------------------------ */
/*  Upstream fixtures                                                  */
/* ------------------------------------------------------------------ */

type Upstream = "ob" | "tk" | "rijk" | "ori" | "dov" | "tenderned" | "rechtspraak" | "begroting" | "apireg";
type Route = (url: URL, body?: string) => Response;

let requests: Array<{ upstream: Upstream | "other"; text: string; url: URL; body?: string }> = [];

/** Requests to one upstream, as decoded text (URL plus any body). */
const sent = (upstream: Upstream) => requests.filter((r) => r.upstream === upstream).map((r) => r.text);

/** One ORI search as OriSource sends it: the index path it runs on and its query string. */
type OriSearch = { path: string; query: string };

/** The query_string (or simple_query_string) of an ORI request body, wherever it sits in the query. */
function oriQueryString(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  for (const key of ["query_string", "simple_query_string"]) {
    const query = (obj[key] as { query?: unknown } | undefined)?.query;
    if (typeof query === "string") return query;
  }
  for (const value of Object.values(obj)) {
    const found = oriQueryString(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The ORI searches sent, without the index list, name and aggregation requests around them. */
const oriSearches = (): OriSearch[] =>
  requests.flatMap((r) => {
    if (r.upstream !== "ori" || !r.body) return [];
    const query = oriQueryString((JSON.parse(r.body) as { query?: unknown }).query);
    return query === undefined ? [] : [{ path: r.url.pathname, query }];
  });

/** Tweede Kamer topic terms of an OData request: each term's plain contains() on Onderwerp, not its word-boundary spellings. */
const tkTopicTerms = (text: string): string[] =>
  [...text.matchAll(/contains\(Onderwerp,'([^']*)'\)/g)].map((m) => m[1]).filter((t) => !/^[\s(]/.test(t));

/** Tweede Kamer searches sent, without the row counts and link lookups around them. */
const tkSearches = () => sent("tk").filter((t) => t.includes("$orderby=Datum desc"));

/** The topic terms of each Tweede Kamer search, sorted: the filter does not keep the question's order. */
const tkTermSets = () => tkSearches().map((search) => tkTopicTerms(search).sort());

/** The CQL query of an SRU request. */
const sruQuery = (text: string): string => /[?&]query=([^&]*)/.exec(text)?.[1] ?? "";

/** The lowercase words of a CQL query, without its operators. */
const cqlWords = (cql: string): string[] =>
  cql
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((w) => w && !["and", "or", "not"].includes(w));

/** The lowercase words of an SRU request's CQL query, without its operators. */
const sruTerms = (text: string): string[] => cqlWords(sruQuery(text));

/** The free-text words of an SRU request: its CQL without the index clauses (w.publicatienaam="...", dt.date>=...) and sort clause. */
const sruTextTerms = (text: string): string[] =>
  cqlWords(sruQuery(text).replace(/\s+sortBy\s+\S+/g, " ").replace(/[\w.-]+\s*(?:==|<=|>=|=|<|>)\s*(?:"[^"]*"|[\w-]+)/g, " "));

function mockUpstreams(routes: Partial<Record<Upstream, Route>>) {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const host = url.hostname;
    const upstream: Upstream | "other" = host.includes("repository.overheid.nl")
      ? "ob"
      : host.includes("tweedekamer.nl")
        ? "tk"
        : host.includes("rijksoverheid.nl")
          ? "rijk"
          : host.includes("openraadsinformatie.nl")
            ? "ori"
            : host.includes("data.overheid.nl")
              ? "dov"
              : host.includes("tenderned.nl")
                ? "tenderned"
                : host.includes("rechtspraak.nl")
                  ? "rechtspraak"
                  : host.includes("rijksbegroting.nl")
                    ? "begroting"
                    : host.includes("developer.overheid.nl")
                      ? "apireg"
                      : "other";
    const body = init?.body ? String(init.body) : undefined;
    const text = `${decodeURIComponent(url.href.replace(/\+/g, " "))} ${body ?? ""}`;
    requests.push({ upstream, text, url, body });
    const route = upstream === "other" ? undefined : routes[upstream];
    return route ? route(url, body) : new Response("not found", { status: 404 });
  }));
}

function sruXml(titles: string[]): string {
  const records = titles
    .map((title, i) => `
<sru:record><sru:recordData><gzd:gzd>
  <gzd:originalData><overheidwetgeving:meta>
    <overheidwetgeving:owmskern>
      <dcterms:identifier>kst-${i + 1}</dcterms:identifier>
      <dcterms:title>${title}</dcterms:title>
      <dcterms:type>Kamerstuk</dcterms:type>
      <dcterms:creator>Tweede Kamer der Staten-Generaal</dcterms:creator>
    </overheidwetgeving:owmskern>
    <overheidwetgeving:owmsmantel><dcterms:date>2026-09-0${i + 1}</dcterms:date></overheidwetgeving:owmsmantel>
    <overheidwetgeving:tpmeta><c:product-area>officielepublicaties</c:product-area></overheidwetgeving:tpmeta>
  </overheidwetgeving:meta></gzd:originalData>
  <gzd:enrichedData><gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/kst-${i + 1}.html</gzd:preferredUrl></gzd:enrichedData>
</gzd:gzd></sru:recordData></sru:record>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse"
  xmlns:gzd="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:overheidwetgeving="http://standaarden.overheid.nl/wetgeving/" xmlns:c="http://standaarden.overheid.nl/collectie/">
  <sru:version>2.0</sru:version>
  <sru:numberOfRecords>${titles.length}</sru:numberOfRecords>
  <sru:records>${records}</sru:records>
</sru:searchRetrieveResponse>`;
}

function rssXml(titles: string[]): string {
  const items = titles
    .map((title, i) => `<item><title>${title}</title><link>https://www.rijksoverheid.nl/actueel/nieuws/2026/09/0${i + 1}/item-${i + 1}</link><description>${title}</description><pubDate>Wed, 0${i + 1} Sep 2026 10:00:00 GMT</pubDate><guid isPermaLink="false">doc-${i + 1}</guid></item>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Nieuws</title>${items}</channel></rss>`;
}

/** ORI's indices: concrete index, its stable alias, and the name and kind in its Organization record. */
const ORI_INDICES = [
  { index: "ori_utrecht_20250401000000", alias: "ori_utrecht", name: "Gemeente Utrecht", classification: "Municipality" },
  { index: "ori_den_haag_20250401000000", alias: "ori_den_haag", name: "Gemeente Den Haag", classification: "Municipality" },
  { index: "osi_provincie-utrecht_20250401000000", alias: "osi_provincie-utrecht", name: "Provincie Utrecht", classification: "Province" },
];
const UTRECHT_INDEX = ORI_INDICES[0].index;
const DEN_HAAG_INDEX = ORI_INDICES[1].index;

/**
 * Open Raadsinformatie as OriSource talks to it: the index list (GET
 * /_aliases) and the Organization records that name the indices, which a
 * municipality is resolved against; aggregations (the newest meeting); and
 * searches, answered by `hits`. Every search reports the shards it ran on, as
 * Elasticsearch does: none would mean the index does not exist. `total` is
 * the hit count ORI reports, by default the hits returned.
 */
function oriUpstream(hits: (search: OriSearch) => Array<{ index: string; title: string }> = () => [], total?: number): Route {
  const shards = { total: 1, successful: 1, skipped: 0, failed: 0 };
  return (url, body) => {
    if (url.pathname.endsWith("/_aliases")) {
      return jsonResponse(Object.fromEntries(ORI_INDICES.map((o) => [o.index, { aliases: { [o.alias]: {} } }])));
    }
    if (body?.includes('"Organization"')) {
      return jsonResponse({
        _shards: shards,
        hits: {
          total: { value: ORI_INDICES.length, relation: "eq" },
          hits: ORI_INDICES.map((o) => ({ _id: `org-${o.alias}`, _index: o.index, _source: { name: o.name, classification: o.classification } })),
        },
      });
    }
    const query = oriQueryString(body ? (JSON.parse(body) as { query?: unknown }).query : undefined);
    const found = query === undefined ? [] : hits({ path: url.pathname, query });
    return jsonResponse({
      _shards: shards,
      hits: {
        total: { value: total ?? found.length, relation: "eq" },
        hits: found.map((hit, i) => ({
          _id: `ori-${i + 1}`,
          _index: hit.index,
          _source: {
            "@type": "MediaObject",
            name: hit.title,
            last_discussed_at: `2026-09-0${i + 1}T10:00:00+02:00`,
            url: `https://api.openraadsinformatie.nl/v1/resolve/ori-${i + 1}`,
          },
          highlight: { text: [`Passage uit ${hit.title}`] },
        })),
      },
      ...(query === undefined ? { aggregations: {} } : {}),
    });
  };
}

const tkJson = (rows: Array<Record<string, unknown>>) => ({ "@odata.count": rows.length, value: rows });

const ckanJson = (titles: string[]) => ({
  success: true,
  result: { count: titles.length, results: titles.map((title, i) => ({ id: `ds-${i + 1}`, title, notes: title, metadata_modified: "2026-09-01" })) },
});

const tenderJson = (titles: string[]) => ({
  content: titles.map((title, i) => ({
    publicatieId: String(1000 + i),
    publicatieDatum: "2026-09-01",
    typePublicatie: { code: "AAO", omschrijving: "Aankondiging van een opdracht" },
    aanbestedingNaam: title,
    opdrachtgeverNaam: "Regio Gooi en Vechtstreek",
    sluitingsDatum: "2026-10-12T16:00:00",
    procedure: { code: "OPE", omschrijving: "Openbaar" },
    typeOpdracht: { code: "D", omschrijving: "Diensten" },
    europees: true,
    opdrachtBeschrijving: title,
    kenmerk: 590000 + i,
    link: { href: `https://www.tenderned.nl/aankondigingen/overzicht/${1000 + i}`, title: "self" },
  })),
  totalElements: titles.length,
});

beforeEach(() => {
  clearHttpCache();
  appCache.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  Intent detection                                                   */
/* ------------------------------------------------------------------ */

describe("detectPolicyIntent", () => {
  it("recognises an organisation-activity question", () => {
    const intent = detectPolicyIntent("Wat doet de Belastingdienst met de BTW?");
    expect(intent).toBeDefined();
    expect(intent!.gemeente).toBeUndefined();
    expect(intent!.municipal).toBe(false);
    expect(intent!.signals).toContain("activiteit");
    expect(detectPolicyIntent("Hoe gebruikt het UWV het re-integratiebudget?")?.signals).toContain("activiteit");
    expect(detectPolicyIntent("Hoe gaat Rijkswaterstaat om met droogte?")?.signals).toContain("activiteit");
  });

  it("recognises policy vocabulary, compounds included", () => {
    expect(detectPolicyIntent("Wat is het kabinetsbeleid over stikstof?")?.signals).toContain("beleid");
    expect(detectPolicyIntent("woonstrategie ministerie van BZK")?.signals).toContain("beleid");
    expect(detectPolicyIntent("Welke maatregelen tegen ondermijning?")?.signals).toContain("beleid");
  });

  it("scopes to a named municipality", () => {
    expect(detectPolicyIntent("GGZ-beleid gemeente Utrecht")).toMatchObject({ gemeente: "Utrecht", municipal: true });
    expect(detectPolicyIntent("GGZ-beleid Gemeente Utrecht")?.gemeente).toBe("Utrecht");
    expect(detectPolicyIntent("Wat is het GGZ-beleid in Tilburg?")?.gemeente).toBe("Tilburg");
    expect(detectPolicyIntent("Wat zegt de gemeenteraad van Den Haag over het OV?")?.gemeente).toBe("Den Haag");
    expect(detectPolicyIntent("Wat doet de gemeente Amsterdam met zwerfafval?")?.gemeente).toBe("Amsterdam");
  });

  it("marks municipal questions without a named municipality", () => {
    const intent = detectPolicyIntent("Welke gemeenten hebben een Open Data Portaal?");
    expect(intent).toMatchObject({ municipal: true });
    expect(intent!.gemeente).toBeUndefined();
  });

  it("does not take a country or province for a municipality", () => {
    expect(detectPolicyIntent("Wat doet de Belastingdienst met de BTW in Nederland?")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Wat is het beleid in Limburg?")?.gemeente).toBeUndefined();
  });

  it("leaves data and plain topic questions to the other routes", () => {
    expect(detectPolicyIntent("subsidie cultuur")).toBeUndefined();
    expect(detectPolicyIntent("Welke data is er over verkeersongevallen?")).toBeUndefined();
    expect(detectPolicyIntent("Welke gegevens heeft de gemeente Utrecht over parkeren?")).toBeUndefined();
    expect(detectPolicyIntent("Parkeren in Delft")).toBeUndefined();
    expect(detectPolicyIntent("Wat kost een televisie?")).toBeUndefined();
    expect(detectPolicyIntent("")).toBeUndefined();
  });

  it("lets a policy signal win over data words", () => {
    expect(detectPolicyIntent("Wat doet de Belastingdienst met data?")).toBeDefined();
    // A capitalised "Data" mid-sentence is a name, not a data request.
    expect(detectPolicyIntent("Welke gemeenten hebben een Open Data Portaal?")).toBeDefined();
  });
});

describe("toOriQuery", () => {
  it("quotes multi-word terms as phrases", () => {
    expect(toOriQuery(["open data portaal", "ov"])).toBe('"open data portaal" ov');
    expect(toOriQuery(["ggz-beleid"])).toBe("ggz-beleid");
  });
});

/* ------------------------------------------------------------------ */
/*  nl_gov_ask routing, offline                                        */
/* ------------------------------------------------------------------ */

describe("nl_gov_ask organisation/policy routing", () => {
  it("searches documents with keywords instead of the catalogue with the sentence", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml(["Handreiking btw-aangifte door de Belastingdienst", "Jaarplan Belastingdienst 2026-2030"])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml(["Kabinet past btw-tarieven aan"])),
    });

    const res = await ask({ question: "Wat doet de Belastingdienst met de BTW?", top: 10 });

    expect(res.summary).toMatch(/^Router: organisatie\/beleid \(3 resultaten uit 2 bronnen\)/);
    // The sources are interleaved, not concatenated.
    expect(res.records.map((r: { source_name: string }) => r.source_name)).toEqual(["officielebekendmakingen", "rijksoverheid", "officielebekendmakingen"]);
    expect(res.records[0].data._provenance.connector).toBe("officiele_bekendmakingen");

    for (const upstream of ["ob", "tk", "rijk"] as const) {
      expect(sent(upstream).length).toBeGreaterThan(0);
      for (const text of sent(upstream)) {
        expect(text.toLowerCase()).toContain("belastingdienst");
        expect(text.toLowerCase()).not.toContain("doet");
      }
    }
    // Tweede Kamer requires every term, as the other sources do, so it is
    // searched for both terms rather than skipped.
    expect(tkTopicTerms(tkSearches()[0])).toEqual(["belastingdienst", "btw"]);
    expect(sent("dov")).toHaveLength(0);
    expect(sent("ori")).toHaveLength(0);

    expect(res.access_note).toContain('Zoekterm herschreven: "Wat doet de Belastingdienst met de BTW?" → "belastingdienst btw".');
    expect(res.access_note).toContain("Officiële Bekendmakingen 2, Tweede Kamer 0, Rijksoverheid 1.");
    expect(res.access_note).not.toContain("niet doorzocht");
    expect(res.provenance.query_params).toMatchObject({ query: "belastingdienst btw" });
  });

  it("routes a municipal policy question to that municipality's council records", async () => {
    mockUpstreams({
      ori: oriUpstream(({ path }) =>
        path.includes("ori_utrecht")
          ? [
              { index: UTRECHT_INDEX, title: "Raadsbrief visie wijkgerichte zorg" },
              { index: UTRECHT_INDEX, title: "Rekenkamerrapport jeugdzorg" },
            ]
          : [],
      ),
    });

    const res = await ask({ question: "GGZ-beleid gemeente Utrecht", top: 5 });

    expect(res.summary).toBe("Router: Open Raadsinformatie Utrecht (2 resultaten)");
    expect(res.records[0].source_name).toBe("ori");
    // The passage around the hit, as ori_search shows it, not the record type.
    expect(res.records[0].snippet).toBe("Passage uit Raadsbrief visie wijkgerichte zorg");
    const searches = oriSearches();
    expect(searches).toHaveLength(1);
    // Utrecht's own council index, found in ORI's index list.
    expect(searches[0].path).toContain("ori_utrecht");
    expect(searches[0].query).toContain("ggz-beleid");
    expect(searches[0].query.toLowerCase()).not.toContain("gemeente utrecht");
    // Not the national news the Rijksoverheid route used to return for "beleid".
    expect(sent("rijk")).toHaveLength(0);
    expect(res.access_note).toContain("gemeente Utrecht");
  });

  it("falls through to the document search when the municipality has no hits", async () => {
    mockUpstreams({
      ori: oriUpstream(),
      ob: () => xmlResponse(sruXml(["Kamerbrief over GGZ-beleid van gemeenten"])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
    });

    const res = await ask({ question: "GGZ-beleid gemeente Utrecht", top: 5, verbose: true });

    expect(res.summary).toMatch(/^Router: organisatie\/beleid/);
    expect(res.verbose.fallbacks_used).toContain("ori:Utrecht:no_results");
    expect(res.access_note).toContain("Open Raadsinformatie 0");
  });

  it("says that ORI has no index for a municipality instead of reporting no results", async () => {
    mockUpstreams({
      ori: oriUpstream(() => [{ index: DEN_HAAG_INDEX, title: "Motie GGZ-beleid" }]),
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
    });

    const res = await ask({ question: "GGZ-beleid gemeente Wijdemeren", top: 5, verbose: true });

    expect(res.verbose.fallbacks_used).toContain("ori:Wijdemeren:no_index");
    expect(res.verbose.fallbacks_used).not.toContain("ori:Wijdemeren:no_results");
    // No council index was searched; the document search ran across all councils.
    expect(oriSearches().length).toBeGreaterThan(0);
    for (const search of oriSearches()) expect(search.path).toBe("/v1/elastic/_search");
    expect(res.summary).toMatch(/^Router: organisatie\/beleid/);
    expect(res.access_note).toContain("ORI heeft geen index voor 'Wijdemeren', dus er is niet gezocht.");
  });

  it("searches ORI nationally, with names as phrases, for a question about municipalities", async () => {
    mockUpstreams({
      ori: oriUpstream(() => [{ index: DEN_HAAG_INDEX, title: "Werkbespreking Open Data Portaal" }]),
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
    });

    const res = await ask({ question: "Welke gemeenten hebben een Open Data Portaal?", top: 5 });

    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ source_name: "ori", title: "Werkbespreking Open Data Portaal" });
    const searches = oriSearches();
    expect(searches).toHaveLength(1);
    expect(searches[0].query).toContain('"open data portaal"');
    // Across all councils, not scoped to one index.
    expect(searches[0].path).toBe("/v1/elastic/_search");
    expect(sent("dov")).toHaveLength(0);
  });

  it("reports a failing source and still returns the others", async () => {
    mockUpstreams({
      tk: () => jsonResponse(tkJson([{ Id: "tk-1", Titel: "Inzet van jobcoaches door het UWV", Onderwerp: "Brief over inzet van jobcoaches", Soort: "Brief regering", Datum: "2026-09-01T00:00:00" }])),
      rijk: () => xmlResponse(rssXml([])),
      // ob is not routed: the SRU request gets a 404.
    });

    const res = await ask({ question: "Wat doet het UWV?", top: 5 });

    expect(sent("tk")[0]).toContain("'uwv'");
    expect(res.records.map((r: { source_name: string }) => r.source_name)).toEqual(["tweedekamer"]);
    expect(res.failures).toEqual([expect.objectContaining({ connector: "officiele_bekendmakingen", error_type: "http_error" })]);
    expect(res.access_note).toContain("Officiële Bekendmakingen mislukt (http_error)");
  });

  it("falls back to the catalogue with keywords when the documents have nothing, and says so", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
      dov: () => jsonResponse(ckanJson([])),
    });

    const res = await ask({ question: "Wat doet de Belastingdienst met de BTW?", top: 5 });

    expect(res.summary).toBe("Router fallback: data.overheid (0 resultaten)");
    expect(res.records).toEqual([]);
    expect(sent("dov")[0]).toContain("q=belastingdienst btw");
    expect(res.access_note).toContain("Ook als organisatie- of beleidsvraag niets gevonden");
    expect(res.access_note).toContain("geen datasets gevonden");
  });

  it("plans the document sources in a dry run", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Wat doet de Belastingdienst met de BTW?", dryRun: true });
    expect(res.estimated_sources).toEqual(["ob", "tk", "rijk"]);
    expect(res.planned_requests[0].params).toMatchObject({ query: "belastingdienst btw", question: "Wat doet de Belastingdienst met de BTW?" });
    expect(requests).toHaveLength(0);

    const municipal = await ask({ question: "GGZ-beleid gemeente Utrecht", dryRun: true });
    expect(municipal.estimated_sources).toEqual(["ori"]);
    expect(municipal.planned_requests[0].params).toMatchObject({ query: "ggz-beleid", gemeente: "Utrecht" });
  });

  it("leaves a question that names a national publication to that source", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml(["Parkeerverordening Utrecht"])),
      ori: oriUpstream(() => [{ index: UTRECHT_INDEX, title: "Raadsvoorstel parkeren" }]),
    });

    const res = await ask({ question: "Wat staat er in het gemeenteblad van gemeente Utrecht over parkeren?", top: 5 });

    expect(res.summary).toBe("Router: Bekendmakingen (1 resultaten)");
    expect(sent("ori")).toHaveLength(0);
    // Keywords, not "Wat AND staat AND er AND in ...". Only the terms are
    // checked: how they are joined into CQL is up to the SRU query builder.
    // The journal is a filter, not a word every publication must contain.
    expect(sent("ob")[0]).toContain('w.publicatienaam="Gemeenteblad"');
    const terms = sruTextTerms(sent("ob")[0]);
    for (const term of ["utrecht", "parkeren"]) expect(terms).toContain(term);
    for (const word of ["wat", "staat", "er", "gemeenteblad"]) expect(terms).not.toContain(word);
  });
});

describe("nl_gov_ask keyword queries for the existing routes", () => {
  it("sends the catalogue fallback topic words, not the sentence", async () => {
    mockUpstreams({ dov: () => jsonResponse(ckanJson(["Verkeersongevallen - Bestand geRegistreerde Ongevallen Nederland"])) });

    const res = await ask({ question: "Welke data is er over verkeersongevallen?", top: 5 });

    expect(res.summary).toBe("Router fallback: data.overheid (1 resultaten)");
    expect(sent("dov")[0]).toContain("q=verkeersongevallen&");
    expect(sent("ob")).toHaveLength(0);
    expect(res.access_note).toContain('→ "verkeersongevallen"');
    expect(res.access_note).toContain("Geen specifieke bron herkend");
  });

  it("keeps a plain keyword question as it was", async () => {
    mockUpstreams({ dov: () => jsonResponse(ckanJson(["Subsidieregister 2026"])) });

    const res = await ask({ question: "subsidie cultuur", top: 5 });

    expect(sent("dov")[0]).toContain("q=subsidie cultuur&");
    expect(res.access_note).not.toContain("Zoekterm herschreven");
  });

  it("searches Tweede Kamer motions on the topic instead of any motion", async () => {
    mockUpstreams({
      tk: () => jsonResponse(tkJson([{ Id: "tk-9", Titel: "Stikstof en natuur", Onderwerp: "Motie van het lid X over stikstof", Soort: "Motie", Datum: "2026-09-29T00:00:00" }])),
    });

    const res = await ask({ question: "Welke moties zijn ingediend over stikstof", top: 5 });

    expect(res.summary).toBe("Router: Tweede Kamer (1 resultaten)");
    const first = sent("tk")[0];
    expect(first).toContain("'stikstof'");
    expect(first).toContain("'Motie'");
    expect(first.toLowerCase()).not.toContain("welke");
    expect(res.access_note).toContain("Motie");
  });

  it("sends TenderNed the topic only", async () => {
    mockUpstreams({ tenderned: () => jsonResponse(tenderJson(["JeugdzorgPlus regio"])) });

    const res = await ask({ question: "Welke aanbestedingen zijn er voor jeugdzorg?", top: 5 });

    expect(res.summary).toBe("Router: TenderNed (1 publicaties)");
    expect(sent("tenderned")[0]).toContain("search=jeugdzorg");
    expect(sent("tenderned")[0]).not.toContain("welke");
    expect(res.access_note).toContain('→ "jeugdzorg"');
  });
});

/* ------------------------------------------------------------------ */
/*  Route guards: specific routes keep their questions                 */
/* ------------------------------------------------------------------ */

const rechtspraakJson = (eclis: string[]) => ({
  Results: eclis.map((ecli) => ({
    TitelEmphasis: ecli,
    Titel: "Raad van State, 01-01-2026",
    Tekstfragment: "Uitspraak",
    InterneUrl: `https://uitspraken.rechtspraak.nl/details?id=${ecli}`,
    Publicatiedatum: "2026-01-02",
  })),
  ResultCount: eclis.length,
});

const begrotingIndex = () =>
  new Response('<a href="/open-data/defensie-uitgaven-2026">Defensie</a> <a href="/open-data/uitgaven-onderwijs-2026">OCW</a>', {
    status: 200,
    headers: { "content-type": "text/html" },
  });

/** Every upstream answers, so a test sees which route the router picked. */
const allUpstreams: Partial<Record<Upstream, Route>> = {
  ob: () => xmlResponse(sruXml(["Bekendmaking"])),
  tk: () => jsonResponse(tkJson([{ Id: "tk-1", Titel: "Kamerstuk", Onderwerp: "Kamerstuk", Soort: "Brief regering", Datum: "2026-09-01T00:00:00" }])),
  rijk: () => xmlResponse(rssXml(["Nieuwsbericht"])),
  ori: oriUpstream(() => [{ index: UTRECHT_INDEX, title: "Raadsvoorstel" }]),
  dov: () => jsonResponse(ckanJson(["Dataset"])),
  rechtspraak: () => jsonResponse(rechtspraakJson(["ECLI:NL:RVS:2026:1", "ECLI:NL:RBROT:2026:2"])),
  begroting: () => begrotingIndex(),
  apireg: () => jsonResponse({ items: [{ name: "Basisregistratie Adressen en Gebouwen (BAG)", url: "https://apis.developer.overheid.nl/apis/bag" }] }),
};

const documentUpstreams = ["ori", "ob", "tk", "rijk"] as const;

describe("detectPolicyIntent: courts, bodies and over-captured places", () => {
  it("does not read the name of a court or body as a municipality", () => {
    expect(detectPolicyIntent("Uitspraken van de Raad van State over stikstof")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Uitspraken van de Centrale Raad van Beroep over de WIA")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Uitspraak van het College van Beroep voor het bedrijfsleven")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Besluiten van het college van B en W over parkeren")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Wat zegt de raad van State over jeugdzorg?")?.gemeente).toBeUndefined();
  });

  it("ends a place name at an acronym", () => {
    expect(detectPolicyIntent("Wat vindt de raad van Amsterdam van het OV?")).toMatchObject({ gemeente: "Amsterdam", municipal: true, strength: "strong" });
    expect(detectPolicyIntent("Wat zegt de burgemeester van Den Haag over het OV?")?.gemeente).toBe("Den Haag");
  });

  it("does not take a place for the municipality when a national actor is the subject", () => {
    expect(detectPolicyIntent("Wat doet het kabinet aan woningnood in Amsterdam?")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Wat doet de gemeente aan woningnood in Amsterdam?")?.gemeente).toBe("Amsterdam");
  });

  it("does not scope to a named municipality when a national actor is the subject", () => {
    // Searching Groningen's council records for "kabinet" or "minister" was
    // the answer to what the cabinet or minister does or says.
    expect(detectPolicyIntent("Wat doet het kabinet voor de gemeente Groningen?")).toMatchObject({ municipal: false, strength: "strong" });
    expect(detectPolicyIntent("Wat doet het kabinet voor de gemeente Groningen?")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Wat zegt de minister over de gemeente Groningen?")?.gemeente).toBeUndefined();
    expect(detectPolicyIntent("Wat zegt de minister over de wethouder van Utrecht?")?.gemeente).toBeUndefined();
    // A municipal subject keeps its council, also when it mentions the cabinet.
    expect(detectPolicyIntent("Wat vindt de gemeenteraad van Utrecht van de plannen van het kabinet?")).toMatchObject({ gemeente: "Utrecht", municipal: true });
    expect(detectPolicyIntent("Wat doet de gemeente Groningen met het geld van het kabinet?")?.gemeente).toBe("Groningen");
    expect(detectPolicyIntent("Wat doen gemeenten met de plannen van de minister?")?.municipal).toBe(true);
  });

  it("calls a bare organisation noun a weak signal", () => {
    expect(detectPolicyIntent("Wat zijn de uitgaven van de overheid aan defensie?")?.strength).toBe("weak");
    expect(detectPolicyIntent("Rechtspraak over gemeentelijke belastingen")?.strength).toBe("weak");
    expect(detectPolicyIntent("Welke gemeenten hebben een Open Data Portaal?")?.strength).toBe("weak");
    expect(detectPolicyIntent("Wat doet de Belastingdienst met de BTW?")?.strength).toBe("strong");
    expect(detectPolicyIntent("GGZ-beleid gemeente Utrecht")?.strength).toBe("strong");
  });

  it("does not take a lowercase term with 'data' for a data request", () => {
    expect(detectPolicyIntent("welke gemeenten hebben een open data portaal?")).toMatchObject({ municipal: true });
    expect(detectPolicyIntent("Welke data is er over verkeersongevallen?")).toBeUndefined();
    expect(detectPolicyIntent("data-uitwisseling gemeente Utrecht")?.gemeente).toBe("Utrecht");
  });
});

describe("nl_gov_ask route guards", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const caseLawQuestions = [
    "Uitspraken van de Raad van State over stikstof",
    "Rechtspraak over gemeentelijke belastingen",
    "Beroep tegen besluit van de gemeente Arnhem",
    "Jurisprudentie over aansprakelijkheid van de gemeente bij wegonderhoud",
    "Uitspraken van de rechtbank over boetes van de gemeente Rotterdam",
    "Uitspraken van de Raad van State over handhaving door de gemeente Amsterdam",
    "Rechtspraak over boetes van de provincie voor stikstof",
    "Welke uitspraken zijn er over handhaving door gemeenten?",
  ];

  for (const question of caseLawQuestions) {
    it(`sends a case-law question to Rechtspraak: ${question}`, async () => {
      mockUpstreams(allUpstreams);
      const res = await ask({ question, top: 3 });
      expect(res.summary).toMatch(/^Router: Rechtspraak/);
      expect(res.records[0].source_name).toBe("rechtspraak");
      for (const upstream of documentUpstreams) expect(sent(upstream)).toHaveLength(0);
    });
  }

  it("does not plan the document sources for a case-law question in a dry run", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Jurisprudentie over aansprakelijkheid van de gemeente bij wegonderhoud", dryRun: true });
    expect(res.estimated_sources).toEqual(["rechtspraak"]);
  });

  it("keeps a policy question that mentions enforcement on the policy route", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Wat doet de gemeente Utrecht aan handhaving van vakantieverhuur?", top: 3 });
    expect(res.summary).toBe("Router: Open Raadsinformatie Utrecht (1 resultaten)");
    expect(sent("rechtspraak")).toHaveLength(0);
  });

  it("sends a spending question about 'de overheid' to the Rijksbegroting", async () => {
    // A bare organisation noun is a weak signal: the budget route answers
    // first, and the document search only runs when it finds nothing.
    for (const question of ["Wat zijn de uitgaven van de overheid aan defensie?", "Hoeveel geeft de overheid uit aan zorg?"]) {
      mockUpstreams(allUpstreams);
      const res = await ask({ question, top: 3 });
      expect(res.summary, question).toMatch(/^Router: Rijksbegroting/);
      for (const upstream of documentUpstreams) expect(sent(upstream), question).toHaveLength(0);
    }
  });

  it("sends an API question to the API register", async () => {
    vi.stubEnv("OVERHEID_API_KEY", "test-key");
    for (const question of ["Is er een api van de overheid voor adressen?", "Welke API heeft de overheid voor adressen?", "Welke API heeft de gemeente Amsterdam?"]) {
      mockUpstreams(allUpstreams);
      const res = await ask({ question, top: 3 });
      expect(res.summary, question).toBe("Router: API Register (1 resultaten)");
      for (const upstream of documentUpstreams) expect(sent(upstream), question).toHaveLength(0);
    }
  });

  it("sends a bylaw question about a municipality to the official publications", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Verordening parkeren gemeente Utrecht", top: 3 });
    expect(res.summary).toBe("Router: Bekendmakingen (1 resultaten)");
    expect(sent("ori")).toHaveLength(0);
  });

  it("still searches documents, after the specific routes, for a weak organisation question", async () => {
    mockUpstreams({
      ori: oriUpstream(() => [{ index: DEN_HAAG_INDEX, title: "Werkbespreking Open Data Portaal" }]),
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
      dov: () => jsonResponse(ckanJson([])),
    });

    // Lowercase: "data" sits inside a term here, not a data request.
    const res = await ask({ question: "welke gemeenten hebben een open data portaal?", top: 5 });

    expect(res.summary).toMatch(/^Router: organisatie\/beleid/);
    expect(oriSearches()[0].query).toContain('"open data portaal"');
    expect(sent("dov")).toHaveLength(0);
    expect(res.access_note).not.toContain("open portaal");
  });

  it("keeps an acronym that spells a stopword in the search", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml(["Jaarverslag Openbaar Ministerie"])),
      rijk: () => xmlResponse(rssXml([])),
    });
    const res = await ask({ question: "Wat doet het OM met ondermijning?", top: 3 });
    expect(res.provenance.query_params).toMatchObject({ query: "om ondermijning" });
    const terms = sruTerms(sent("ob")[0]);
    expect(terms).toContain("om");
    expect(terms).toContain("ondermijning");
  });
});

describe("asksForRulings", () => {
  it("reads 'uitspraken' as rulings without a speaker or with a court named", () => {
    expect(asksForRulings("Welke uitspraken zijn er over huurrecht?")).toBe(true);
    expect(asksForRulings("Uitspraken van de Raad van State over stikstof")).toBe(true);
    expect(asksForRulings("Uitspraken van de rechtbank over boetes van de gemeente Rotterdam")).toBe(true);
    expect(asksForRulings("Uitspraken van de rechter over de minister")).toBe(true);
    expect(asksForRulings("uitspraak kantonrechter huurverhoging")).toBe(true);
  });

  it("reads 'uitspraken' of an office holder or body as statements", () => {
    expect(asksForRulings("Uitspraken van de minister over jeugdzorg")).toBe(false);
    expect(asksForRulings("Welke uitspraken heeft het kabinet gedaan over stikstof?")).toBe(false);
    expect(asksForRulings("Welke uitspraken deed de premier over migratie?")).toBe(false);
    expect(asksForRulings("Uitspraken van de wethouder van Utrecht over jeugdzorg")).toBe(false);
    expect(asksForRulings("De uitspraak van de burgemeester over vuurwerk")).toBe(false);
    // "Hof van Twente" is a municipality, not the court of appeal.
    expect(asksForRulings("Uitspraken van de burgemeester van Hof van Twente over windmolens")).toBe(false);
    expect(asksForRulings("Uitspraak van het hof over het besluit van het college")).toBe(true);
    expect(asksForRulings("Wat doet de Belastingdienst met de BTW?")).toBe(false);
  });

  it("reads statements only from a speaker tied to 'uitspraken'", () => {
    expect(asksForRulings("Welke uitspraken heeft minister Keijzer gedaan over woningbouw?")).toBe(false);
    expect(asksForRulings("Uitspraken van de demissionaire minister over woningbouw")).toBe(false);
    expect(asksForRulings("Het kabinet heeft uitspraken gedaan over afvalinzameling")).toBe(false);
    expect(asksForRulings("Welke uitspraken zijn gedaan door de staatssecretaris over afvalinzameling?")).toBe(false);
    expect(asksForRulings("uitspraken die de wethouder deed over parkeerbeleid")).toBe(false);
    expect(asksForRulings("Uitspraken van Kamerleden over woningbouw")).toBe(false);
    expect(asksForRulings("Uitspraken van politieke partijen over woningbouw")).toBe(false);
  });

  it("reads 'uitspraak' with an office holder as a party to the case as rulings", () => {
    // The office holder is the defendant here, not the speaker.
    expect(asksForRulings("Uitspraak over verblijfsvergunning tegen de staatssecretaris")).toBe(true);
    expect(asksForRulings("Uitspraak ontslag ambtenaar tegen de burgemeester")).toBe(true);
    expect(asksForRulings("Uitspraak in de zaak tegen de minister van Justitie")).toBe(true);
    expect(asksForRulings("Uitspraak bezwaar tegen besluit van het college van Utrecht")).toBe(true);
    expect(asksForRulings("Uitspraak over het bestemmingsplan van de gemeenteraad van Utrecht")).toBe(true);
    // "partijen" are the parties to a case, not political parties.
    expect(asksForRulings("Uitspraak huurgeschil tussen partijen")).toBe(true);
    // Words of court proceedings outweigh a speaker tied to the word.
    expect(asksForRulings("Welke uitspraken heeft de staatssecretaris in hoger beroep verloren?")).toBe(true);
    // A chamber of a court is no parliament.
    expect(asksForRulings("Uitspraak van de meervoudige kamer over parkeerboetes")).toBe(true);
  });

  it("does not take the subject of 'heeft' or 'doet' for a speaker without a statement", () => {
    // An auxiliary needs a statement participle ("gedaan", "gezegd").
    expect(asksForRulings("Heeft de staatssecretaris de uitspraak aangevochten?")).toBe(true);
    expect(asksForRulings("Welke uitspraak heeft de minister verloren?")).toBe(true);
    expect(asksForRulings("Welke uitspraken heeft de gemeenteraad gewonnen?")).toBe(true);
    expect(asksForRulings("Welke uitspraak heeft het college gekregen over de parkeervergunning?")).toBe(true);
    expect(asksForRulings("Hebben de ministers de uitspraak over de toeslagen uitgevoerd?")).toBe(true);
    expect(asksForRulings("Uitspraken die de staatssecretaris heeft verloren")).toBe(true);
    // "doen" ties the speaker to "uitspraak" only when that is its object.
    expect(asksForRulings("Wat doet het college met de uitspraak over de parkeervergunning?")).toBe(true);
    expect(asksForRulings("Wat deed de minister met de uitspraak over de parkeervergunning?")).toBe(true);
    expect(asksForRulings("Het college doet niets met de uitspraak over de parkeervergunning")).toBe(true);
    expect(asksForRulings("Na de uitspraak over de parkeervergunning wat doet het college")).toBe(true);
    expect(asksForRulings("Uitspraak over de parkeervergunning wat doet het college ermee")).toBe(true);
  });

  it("reads contesting a ruling and its outcome as court proceedings", () => {
    expect(asksForRulings("De minister heeft de uitspraak aangevochten")).toBe(true);
    expect(asksForRulings("Vecht de minister de uitspraak aan?")).toBe(true);
    expect(asksForRulings("Heeft de staatssecretaris gelijk gekregen in de uitspraak over de verblijfsvergunning?")).toBe(true);
    expect(asksForRulings("Is het besluit van de staatssecretaris vernietigd in de uitspraak?")).toBe(true);
  });

  it("keeps statements with 'doen' or an auxiliary and a statement participle", () => {
    expect(asksForRulings("Welke uitspraken doet de minister over woningbouw?")).toBe(false);
    expect(asksForRulings("Welke uitspraken over woningbouw deed de premier?")).toBe(false);
    expect(asksForRulings("Deed de premier uitspraken over afvalinzameling?")).toBe(false);
    expect(asksForRulings("De premier deed een opvallende uitspraak over afvalinzameling")).toBe(false);
    expect(asksForRulings("Het kabinet doet uitspraken over afvalinzameling")).toBe(false);
    expect(asksForRulings("Heeft de minister uitspraken gedaan over woningbouw?")).toBe(false);
    expect(asksForRulings("Welke uitspraken heeft de minister over woningbouw gedaan?")).toBe(false);
    expect(asksForRulings("Welke uitspraken heeft de minister teruggenomen?")).toBe(false);
    expect(asksForRulings("Uitspraken die het kabinet heeft gedaan over afvalinzameling")).toBe(false);
    expect(asksForRulings("uitspraken die de minister uitte over parkeerbeleid")).toBe(false);
    // A speech verb keeps the speaker, also for a ruling talked about.
    expect(asksForRulings("Wat zei de minister in zijn uitspraak over woningbouw?")).toBe(false);
    expect(asksForRulings("Wat heeft de wethouder gezegd over de uitspraak over de parkeervergunning?")).toBe(false);
    // Bare "gewonnen"/"verloren" are no court words.
    expect(asksForRulings("Uitspraken van de premier over de gewonnen verkiezingen")).toBe(false);
  });
});

describe("nl_gov_ask rulings that name an office holder as a party", () => {
  const rulingsQuestions = [
    "Uitspraak over verblijfsvergunning tegen de staatssecretaris",
    "Uitspraak huurgeschil tussen partijen",
    "Uitspraak ontslag ambtenaar tegen de burgemeester",
    "Uitspraak over het bestemmingsplan van de gemeenteraad van Utrecht",
    "Uitspraak bezwaar tegen besluit van het college van Utrecht",
  ];

  for (const question of rulingsQuestions) {
    it(`answers from Rechtspraak: ${question}`, async () => {
      mockUpstreams(allUpstreams);
      const res = await ask({ question, top: 3 });
      expect(res.summary).toMatch(/^Router: Rechtspraak/);
      expect(res.records[0].source_name).toBe("rechtspraak");
      for (const upstream of documentUpstreams) expect(sent(upstream)).toHaveLength(0);
      expect(sent("dov")).toHaveLength(0);
    });
  }

  it("keeps 'uitspraak' and the parties' words in the Rechtspraak query", async () => {
    mockUpstreams(allUpstreams);
    await ask({ question: "Uitspraak over verblijfsvergunning tegen de staatssecretaris", top: 3 });
    expect(sent("rechtspraak")[0]).toContain("verblijfsvergunning tegen staatssecretaris");
  });

  it("plans Rechtspraak in a dry run", async () => {
    mockUpstreams({});
    for (const question of rulingsQuestions) {
      const res = await ask({ question, dryRun: true });
      expect(res.estimated_sources, question).toEqual(["rechtspraak"]);
    }
  });

  it("answers from Rechtspraak when the staatssecretaris contested the ruling", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Heeft de staatssecretaris de uitspraak aangevochten?", top: 3 });
    expect(res.summary).toMatch(/^Router: Rechtspraak/);
    expect(res.records[0].source_name).toBe("rechtspraak");
    for (const upstream of documentUpstreams) expect(sent(upstream)).toHaveLength(0);
    expect(sent("dov")).toHaveLength(0);
  });

  it("adds Rechtspraak to Rijksoverheid for a ruling the minister lost", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Welke uitspraak heeft de minister verloren?", top: 3 });
    expect(sent("rechtspraak").length).toBeGreaterThan(0);
    expect(res.records.some((r: { source_name: string }) => r.source_name === "rechtspraak")).toBe(true);
    expect(sent("dov")).toHaveLength(0);
  });

  it("answers from Rechtspraak when the college acts on a ruling", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Wat doet het college met de uitspraak over de parkeervergunning?", top: 3 });
    expect(res.summary).toMatch(/^Router: Rechtspraak/);
    for (const upstream of documentUpstreams) expect(sent(upstream)).toHaveLength(0);

    mockUpstreams({});
    const plan = await ask({ question: "Wat doet het college met de uitspraak over de parkeervergunning?", dryRun: true });
    expect(plan.estimated_sources).toEqual(["rechtspraak"]);
  });

  it("adds Rechtspraak to Rijksoverheid for a case against the minister", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Uitspraak in de zaak tegen de minister van Justitie", top: 3 });
    expect(sent("rechtspraak").length).toBeGreaterThan(0);
    expect(res.records.some((r: { source_name: string }) => r.source_name === "rechtspraak")).toBe(true);
    // The multi-source answer names the terms each source got.
    expect(res.access_note).toContain('Zoektermen afgeleid uit de vraag: ');
    expect(res.access_note).toContain('Rechtspraak "tegen minister justitie"');
    expect(res.access_note).toContain('Rijksoverheid "uitspraak zaak minister justitie"');
  });
});

describe("nl_gov_ask dry run: the query each route sends", () => {
  it("plans the strict rewrite for Rechtspraak", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Welke uitspraken zijn er over huurrecht?", dryRun: true });
    expect(res.estimated_sources).toEqual(["rechtspraak"]);
    expect(res.planned_requests[0].params.query).toBe("huurrecht");
  });

  it("plans the moderate rewrite for CBS", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Hoeveel inwoners heeft Nederland?", dryRun: true });
    expect(res.estimated_sources).toEqual(["cbs"]);
    expect(res.planned_requests[0].params.query).toBe("hoeveel inwoners heeft nederland");
  });

  it("plans the Tweede Kamer topic and document type that the route sends", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Welke moties zijn ingediend over afvalinzameling", dryRun: true });
    expect(res.estimated_sources).toEqual(["tk"]);
    expect(res.planned_requests[0].params).toMatchObject({ query: "afvalinzameling", type: "Motie" });

    mockUpstreams({ tk: () => jsonResponse(tkJson([])) });
    await ask({ question: "Welke moties zijn ingediend over afvalinzameling", top: 3 });
    expect(sent("tk")[0]).toContain("'afvalinzameling'");
    expect(sent("tk")[0]).toContain("'Motie'");
  });
});

describe("nl_gov_ask Tweede Kamer with a short topic", () => {
  const motion = (onderwerp: string) => ({ Id: `tk-${onderwerp.length}`, Titel: onderwerp, Onderwerp: onderwerp, Soort: "Motie", Datum: "2026-09-01T00:00:00" });

  it("says that a topic of three letters or fewer is matched as a whole word", async () => {
    mockUpstreams({ tk: () => jsonResponse(tkJson([motion("Motie over de WOZ-waarde")])) });
    const res = await ask({ question: "Welke moties zijn ingediend over de WOZ?", top: 3 });
    expect(res.summary).toMatch(/^Router: Tweede Kamer/);
    // Tweede Kamer checks the word boundaries itself ("WOZ-waarde", not
    // "bewoze"); the note says so instead of warning about word fragments.
    expect(tkSearches()[0]).toContain("' woz '");
    expect(res.access_note).toContain('"woz" (los woord)');
    expect(res.access_note).not.toContain("tekstfragment");
  });

  it("says that a longer topic also matches inside longer words", async () => {
    mockUpstreams({ tk: () => jsonResponse(tkJson([motion("Motie over afvalinzameling")])) });
    const res = await ask({ question: "Welke moties zijn ingediend over afvalinzameling?", top: 3 });
    expect(res.access_note).toContain('"afvalinzameling" (ook als deel van een woord)');
    expect(res.access_note).not.toContain("los woord");
    // Quotes in a question do not reach the search, so no advice to add them.
    expect(res.access_note).not.toContain("aanhalingstekens");
  });
});

describe("nl_gov_ask statements are no case law", () => {
  const statementQuestions: Array<[string, RegExp]> = [
    ["Uitspraken van de minister over jeugdzorg", /^Router: Rijksoverheid/],
    ["Welke uitspraken heeft het kabinet gedaan over stikstof?", /^Router: Rijksoverheid/],
    ["Welke uitspraken deed de premier over migratie?", /^Router: Tweede Kamer/],
    ["Uitspraken van de wethouder van Utrecht over jeugdzorg", /^Router: Open Raadsinformatie Utrecht/],
  ];

  for (const [question, route] of statementQuestions) {
    it(`does not answer with court rulings: ${question}`, async () => {
      mockUpstreams(allUpstreams);
      const res = await ask({ question, top: 3 });
      expect(res.summary).toMatch(route);
      expect(sent("rechtspraak")).toHaveLength(0);
      // "uitspraken" names the kind of answer here, not its topic.
      for (const text of [...sent("rijk"), ...sent("tk"), ...sent("ori")]) expect(text.toLowerCase()).not.toContain("uitspraken");
    });
  }

  it("does not plan Rechtspraak for a minister's statements in a dry run", async () => {
    mockUpstreams({});
    const minister = await ask({ question: "Uitspraken van de minister over jeugdzorg", dryRun: true });
    expect(minister.estimated_sources).toEqual(["rijk"]);
    expect(minister.planned_requests[0].params.query).toBe("minister jeugdzorg");
    expect((await ask({ question: "Uitspraken van de wethouder van Utrecht over jeugdzorg", dryRun: true })).estimated_sources).toEqual(["ori"]);
  });

  it("searches Tweede Kamer for the topic of the premier's statements, not for 'uitspraken'", async () => {
    mockUpstreams({
      tk: (url) => {
        const query = /contains\(Onderwerp,'([^']*)'\)/.exec(url.searchParams.get("$filter") ?? "")?.[1] ?? "";
        const rows = [
          { Id: "tk-1", Titel: "Uitspraken over de pensioenleeftijd", Onderwerp: "Uitspraken over de pensioenleeftijd", Soort: "Brief regering", Datum: "2026-09-02T00:00:00" },
          { Id: "tk-2", Titel: "Kabinetsaanpak migratie", Onderwerp: "Kabinetsaanpak migratie", Soort: "Brief regering", Datum: "2026-09-01T00:00:00" },
        ].filter((r) => r.Titel.toLowerCase().includes(query));
        return jsonResponse(tkJson(rows));
      },
    });
    const res = await ask({ question: "Welke uitspraken deed de premier over migratie?", top: 3 });
    expect(res.summary).toBe("Router: Tweede Kamer (1 resultaten)");
    expect(res.records[0].title).toBe("Kabinetsaanpak migratie");
  });

  it("still sends rulings questions to Rechtspraak", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Welke uitspraken zijn er over huurrecht?", top: 3 });
    expect(res.summary).toMatch(/^Router: Rechtspraak/);

    mockUpstreams(allUpstreams);
    await ask({ question: "Uitspraken van de rechter over de minister", top: 3 });
    expect(sent("rechtspraak").length).toBeGreaterThan(0);
  });
});

describe("nl_gov_ask national actor and a named municipality", () => {
  it("does not search the council records for what the cabinet does for a municipality", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Wat doet het kabinet voor de gemeente Groningen?", top: 3 });
    expect(res.summary).toMatch(/^Router: organisatie\/beleid/);
    expect(sent("ori")).toHaveLength(0);
    expect(sent("rijk").length).toBeGreaterThan(0);
  });

  it("answers what a minister says about a municipality from Rijksoverheid", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Wat zegt de minister over de gemeente Groningen?", top: 3 });
    expect(res.summary).toMatch(/^Router: Rijksoverheid/);
    expect(sent("ori")).toHaveLength(0);
  });

  it("does not plan the council records in a dry run", async () => {
    mockUpstreams({});
    for (const question of ["Wat doet het kabinet voor de gemeente Groningen?", "Wat zegt de minister over de gemeente Groningen?"]) {
      const res = await ask({ question, dryRun: true });
      expect(res.estimated_sources, question).not.toContain("ori");
      expect(res.planned_requests.map((r: { params: { query: string } }) => r.params.query), question).not.toContain("kabinet");
    }
  });

  it("leaves a municipality with an apostrophe out of its own council search", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Wat is het beleid van de gemeente 's-Hertogenbosch over parkeren?", dryRun: true });
    expect(res.estimated_sources).toEqual(["ori"]);
    expect(res.planned_requests[0].params).toMatchObject({ query: "beleid parkeren", gemeente: "'s-Hertogenbosch" });
  });

  it("keeps a council question that mentions the cabinet on the council records", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Wat vindt de gemeenteraad van Utrecht van de plannen van het kabinet?", top: 3 });
    expect(res.summary).toBe("Router: Open Raadsinformatie Utrecht (1 resultaten)");
  });
});

describe("nl_gov_ask catalogue fallback note", () => {
  it("names a route that failed instead of claiming no source was recognised", async () => {
    mockUpstreams({ dov: () => jsonResponse(ckanJson([])) });

    const res = await ask({ question: "jurisprudentie over huurrecht", top: 3, verbose: true });

    expect(res.summary).toBe("Router fallback: data.overheid (0 resultaten)");
    expect(res.verbose.fallbacks_used).toContain("rechtspraak:search_failed");
    expect(res.access_note).toContain("Eerst geprobeerd, zonder resultaat: Rechtspraak (mislukt: http_error)");
    expect(res.access_note).not.toContain("Geen specifieke bron herkend");
    expect(res.failures).toEqual([expect.objectContaining({ connector: "rechtspraak", error_type: "http_error" })]);
  });

  it("names a route that found nothing", async () => {
    mockUpstreams({ tk: () => jsonResponse(tkJson([])), dov: () => jsonResponse(ckanJson(["Dataset stikstof"])) });

    const res = await ask({ question: "Welke moties zijn ingediend over stikstof", top: 3 });

    expect(res.summary).toBe("Router fallback: data.overheid (1 resultaten)");
    expect(res.access_note).toContain("Tweede Kamer (0 resultaten)");
    expect(res.access_note).toContain("Daarom teruggevallen op de datasetcatalogus");
    expect(res.access_note).not.toContain("Geen specifieke bron herkend");
  });

  it("still says so when no route ran", async () => {
    mockUpstreams({ dov: () => jsonResponse(ckanJson(["Subsidieregister 2026"])) });
    const res = await ask({ question: "subsidie cultuur", top: 3 });
    expect(res.access_note).toContain("Geen specifieke bron herkend");
  });
});

describe("nl_gov_ask Tweede Kamer route on a multi-word topic", () => {
  /** Tweede Kamer OData semantics: every topic term must occur in the title (AND), the type in Soort. */
  const andTk = (titles: Array<{ Titel: string; Soort: string }>): Route => (url) => {
    const filter = url.searchParams.get("$filter") ?? "";
    const terms = tkTopicTerms(filter);
    const type = /contains\(Soort,'([^']*)'\)/.exec(filter)?.[1];
    const rows = titles
      .map((t, i) => ({ Id: `tk-${i}`, Titel: t.Titel, Onderwerp: t.Titel, Soort: t.Soort, Datum: "2026-09-01T00:00:00" }))
      .filter((t) => terms.every((term) => t.Titel.toLowerCase().includes(term.toLowerCase())) && (type === undefined || t.Soort.includes(type)));
    // The count is of every match, a search page holds $top of them.
    const pageSize = filter.includes("Id in (") ? rows.length : Number(url.searchParams.get("$top") ?? rows.length);
    return jsonResponse({ ...tkJson(rows), value: rows.slice(0, pageSize) });
  };
  const motions = [
    { Titel: "Motie van het lid Y over de pensioenleeftijd", Soort: "Motie" },
    { Titel: "Motie van het lid X over stikstof", Soort: "Motie" },
  ];

  it("tries each topic term with the document type, not the bare type", async () => {
    mockUpstreams({ tk: andTk(motions) });

    const res = await ask({ question: "Welke moties zijn ingediend over stikstof en landbouw", top: 5 });

    expect(res.summary).toBe("Router: Tweede Kamer (1 resultaten)");
    expect(res.records[0].title).toBe("Motie van het lid X over stikstof");
    const searches = tkSearches();
    // First every topic term together, with the type; no motion has both.
    expect(tkTopicTerms(searches[0])).toEqual(["stikstof", "landbouw"]);
    expect(searches[0]).toContain("contains(Soort,'Motie')");
    // Then a single term with the type. Never the type alone, nor "motie" as a topic.
    for (const search of searches) expect(tkTopicTerms(search).length).toBeGreaterThan(0);
    expect(searches.flatMap(tkTopicTerms)).not.toContain("motie");
    expect(searches.some((s) => tkTopicTerms(s).join(" ") === "stikstof" && s.includes("contains(Soort,'Motie')"))).toBe(true);
  });

  it("returns an honest 0 rather than motions on another subject", async () => {
    mockUpstreams({ tk: andTk(motions), dov: () => jsonResponse(ckanJson([])) });

    const res = await ask({ question: "Welke moties zijn ingediend over windenergie en zonneparken", top: 5 });

    expect(res.summary).toBe("Router fallback: data.overheid (0 resultaten)");
    for (const search of tkSearches()) expect(tkTopicTerms(search).length).toBeGreaterThan(0);
    expect(tkSearches().flatMap(tkTopicTerms)).not.toContain("motie");
    expect(res.access_note).toContain("Tweede Kamer (0 resultaten)");
  });

  it("searches what a comparison compares, not the word 'vergelijk'", async () => {
    mockUpstreams({
      tk: andTk([
        ...motions,
        { Titel: "Motie van het lid Z over het kabinetsbeleid in Brussel", Soort: "Motie" },
        { Titel: "Motie van het lid W over kabinetsbeleid voor stikstof in natuurgebieden", Soort: "Motie" },
      ]),
    });

    const res = await ask({ question: "Vergelijk de moties van de Tweede Kamer met het kabinetsbeleid over stikstof", top: 5 });

    // Before, "vergelijk" was a required term: nothing matched, and the single
    // term "kabinetsbeleid" returned motions on any other subject.
    expect(tkTopicTerms(tkSearches()[0])).toEqual(["kabinetsbeleid", "stikstof"]);
    expect(tkSearches().flatMap(tkTopicTerms)).not.toContain("vergelijk");
    expect(res.records.map((r: { title: string }) => r.title)).toEqual(["Motie van het lid W over kabinetsbeleid voor stikstof in natuurgebieden"]);
    expect(res.access_note).toContain('→ "kabinetsbeleid stikstof"');
  });

  it("searches a run of capitalised words as loose words when no paper holds it as a phrase", async () => {
    mockUpstreams({
      tk: andTk([
        ...motions,
        { Titel: "Motie van het lid Z over geluidsoverlast rond Schiphol", Soort: "Motie" },
        { Titel: "Brief over geluidsoverlast rond Schiphol", Soort: "Brief regering" },
      ]),
    });

    const res = await ask({ question: "Welke moties gaan over Schiphol Geluidsoverlast?", top: 5 });

    // Sent only as a phrase, the name found nothing and the answer fell back
    // to the dataset catalogue.
    expect(res.summary).toBe("Router: Tweede Kamer (1 resultaten)");
    expect(res.records.map((r: { title: string }) => r.title)).toEqual(["Motie van het lid Z over geluidsoverlast rond Schiphol"]);
    const searches = tkSearches();
    expect(tkTermSets()).toEqual([["schiphol geluidsoverlast"], ["geluidsoverlast", "schiphol"]]);
    for (const search of searches) expect(search).toContain("contains(Soort,'Motie')");
    expect(res.access_note).toContain('→ "schiphol geluidsoverlast"');
  });

  it("keeps the document type when only the loose words find motions", async () => {
    mockUpstreams({
      tk: andTk([
        { Titel: "Motie van het lid Z over het klimaatakkoord van Parijs", Soort: "Motie" },
        { Titel: "Brief over de bijdrage aan het Klimaatakkoord Parijs", Soort: "Brief regering" },
      ]),
    });

    const res = await ask({ question: "Welke moties over het Klimaatakkoord Parijs zijn aangenomen?", top: 5 });

    // Before, the phrase without the type came next and returned the letter.
    expect(res.records.map((r: { title: string }) => r.title)).toEqual(["Motie van het lid Z over het klimaatakkoord van Parijs"]);
    expect(tkTermSets()).toEqual([["klimaatakkoord parijs"], ["klimaatakkoord", "parijs"]]);
  });

  it("finds the papers on a name the question words differently when it names no document type", async () => {
    mockUpstreams({ tk: andTk([{ Titel: "Wijziging van de Wet kwaliteitsborging voor het bouwen", Soort: "Brief regering" }]) });

    const res = await ask({ question: "Welke kamerstukken gaan over de Wet Kwaliteitsborging Bouwen?", top: 5 });

    expect(res.summary).toBe("Router: Tweede Kamer (1 resultaten)");
    expect(tkTermSets()).toEqual([["wet kwaliteitsborging bouwen"], ["bouwen", "kwaliteitsborging", "wet"]]);
  });

  it("keeps a name as a phrase when the papers hold it as one, with one search when the phrase fills the page", async () => {
    mockUpstreams({
      tk: andTk([
        { Titel: "Brief over de Ring Utrecht", Soort: "Brief regering" },
        { Titel: "Motie over de planning van de Ring Utrecht", Soort: "Motie" },
        // The loose words also match "ring" inside another word.
        { Titel: "Invoeringstoets regio Utrecht", Soort: "Bijlage" },
      ]),
    });

    const res = await ask({ question: "Welke kamerstukken gaan over de Ring Utrecht?", top: 2 });

    expect(res.records.map((r: { title: string }) => r.title)).toEqual(["Brief over de Ring Utrecht", "Motie over de planning van de Ring Utrecht"]);
    expect(tkTermSets()).toEqual([["ring utrecht"]]);
    // The route reports the records it holds, so it asks for no count: with
    // one, every search took about twice as long.
    for (const search of tkSearches()) expect(search).not.toContain("$count");
    // The phrase is shown once quoted, not in quotes of its own again.
    expect(res.access_note).toContain('→ "ring utrecht".');
    expect(res.access_note).not.toContain('""');
  });

  const transportMotions = [
    { Titel: "Motie over het Openbaar Vervoer Twente", Soort: "Motie" },
    { Titel: "Motie over openbaar vervoer in Twente", Soort: "Motie" },
    { Titel: "Brief over openbaar vervoer in Twente", Soort: "Brief regering" },
    { Titel: "Motie over de bussen in Twente en het openbaar vervoer", Soort: "Motie" },
    { Titel: "Motie over het openbaar vervoer in Drenthe", Soort: "Motie" },
  ];

  it("fills a short phrase result with the papers that hold its words apart, of the same type", async () => {
    mockUpstreams({ tk: andTk(transportMotions) });

    const res = await ask({ question: "Welke moties gaan over het Openbaar Vervoer Twente?", top: 5, verbose: true });

    // The phrase alone found one motion and reported it as the whole answer.
    expect(res.summary).toBe("Router: Tweede Kamer (3 resultaten)");
    expect(res.records.map((r: { title: string }) => r.title)).toEqual([
      "Motie over het Openbaar Vervoer Twente",
      "Motie over openbaar vervoer in Twente",
      "Motie over de bussen in Twente en het openbaar vervoer",
    ]);
    expect(tkTermSets()).toEqual([["openbaar vervoer twente"], ["openbaar", "twente", "vervoer"]]);
    for (const search of tkSearches()) expect(search).toContain("contains(Soort,'Motie')");
    expect(res.access_note).toContain('→ "openbaar vervoer twente".');
    expect(res.access_note).toContain(
      `1 document bevat "openbaar vervoer twente" als woordgroep; aangevuld met 2 documenten met dezelfde woorden afzonderlijk (openbaar vervoer twente), gemarkeerd met data.match 'woorden afzonderlijk'.`,
    );
    // "Los" stays the term notes' word for a whole word.
    expect(res.access_note).not.toContain("woorden los");
    expect(res.records.map((r: { data: Record<string, unknown> }) => r.data.match)).toEqual([undefined, "woorden afzonderlijk", "woorden afzonderlijk"]);
    expect(res.verbose.fallbacks_used).toContain("tweede_kamer:loose_supplement:openbaar vervoer twente (type Motie)");
  });

  it("fills only the rest of the page, after the phrase hits", async () => {
    mockUpstreams({ tk: andTk(transportMotions) });

    const res = await ask({ question: "Welke moties gaan over het Openbaar Vervoer Twente?", top: 2 });

    expect(res.records.map((r: { title: string }) => r.title)).toEqual(["Motie over het Openbaar Vervoer Twente", "Motie over openbaar vervoer in Twente"]);
    expect(res.access_note).toContain("aangevuld met 1 document met dezelfde woorden afzonderlijk");
  });

  it("does not loosen a phrase the question quotes", async () => {
    mockUpstreams({ tk: andTk(transportMotions) });

    const res = await ask({ question: 'Welke moties gaan over "openbaar vervoer twente"?', top: 5 });

    expect(res.records.map((r: { title: string }) => r.title)).toEqual(["Motie over het Openbaar Vervoer Twente"]);
    expect(tkTermSets()).toEqual([["openbaar vervoer twente"]]);
    expect(res.access_note ?? "").not.toContain("aangevuld");
  });

  const dataMotions = [
    { Titel: "Motie over open data bij het Kadaster Zeeland", Soort: "Motie" },
    { Titel: "Motie over open data van het Kadaster in Zeeland", Soort: "Motie" },
    // Its words apart: "open" inside "openbaar".
    { Titel: "Motie over openbaar vervoer en data van het Kadaster in Zeeland", Soort: "Motie" },
  ];

  it("does not take a fixed word group apart to fill a short phrase result", async () => {
    mockUpstreams({ tk: andTk(dataMotions) });

    const res = await ask({ question: "Welke moties gaan over open data?", top: 5, verbose: true });

    // Before, "open data" was taken apart as a name is, and "openbaar" filled the page.
    expect(res.summary).toBe("Router: Tweede Kamer (2 resultaten)");
    expect(res.records.map((r: { title: string }) => r.title)).toEqual([
      "Motie over open data bij het Kadaster Zeeland",
      "Motie over open data van het Kadaster in Zeeland",
    ]);
    expect(tkTermSets()).toEqual([["open data"]]);
    expect(res.access_note ?? "").not.toContain("aangevuld");
    expect(res.verbose.fallbacks_used.some((step: string) => step.startsWith("tweede_kamer:loose_supplement"))).toBe(false);
  });

  it("takes only the name apart, not a fixed word group next to it", async () => {
    mockUpstreams({ tk: andTk(dataMotions) });

    const res = await ask({ question: "Welke moties gaan over open data bij het Kadaster Zeeland?", top: 5 });

    expect(res.records.map((r: { title: string }) => r.title)).toEqual([
      "Motie over open data bij het Kadaster Zeeland",
      "Motie over open data van het Kadaster in Zeeland",
    ]);
    expect(tkTermSets()).toEqual([["kadaster zeeland", "open data"], ["kadaster", "open data", "zeeland"]]);
    expect(res.access_note).toContain('1 document bevat "kadaster zeeland" als woordgroep; aangevuld met 1 document met dezelfde woorden afzonderlijk ("open data" kadaster zeeland)');
  });

  it("keeps the phrase hits, and says so, when the search on the loose words fails", async () => {
    const phraseOnly = andTk(transportMotions);
    mockUpstreams({
      tk: (url) => (tkTopicTerms(url.searchParams.get("$filter") ?? "").length > 1 ? new Response("bad request", { status: 400 }) : phraseOnly(url)),
    });

    const res = await ask({ question: "Welke moties gaan over het Openbaar Vervoer Twente?", top: 5, verbose: true });

    expect(res.summary).toBe("Router: Tweede Kamer (1 resultaten)");
    expect(res.access_note).toContain('1 document bevat "openbaar vervoer twente" als woordgroep; aanvullen met documenten met dezelfde woorden afzonderlijk (openbaar vervoer twente) is mislukt.');
    expect(res.verbose.fallbacks_used).toContain("tweede_kamer:loose_supplement_failed");
  });

  it("still lists the latest motions when the question has no topic", async () => {
    mockUpstreams({ tk: andTk(motions) });
    const res = await ask({ question: "Welke moties zijn er?", top: 5 });
    expect(res.summary).toBe("Router: Tweede Kamer (2 resultaten)");
  });

  it("lists the latest papers of the type asked for when a time phrase is the only other word", async () => {
    const amendments = [{ Titel: "Amendement van het lid Z over de huurtoeslag", Soort: "Amendement" }];
    for (const [question, expected] of [
      ["Welke moties zijn er deze week ingediend?", "'deze week'"],
      ["Welke moties zijn deze maand ingediend?", "'deze maand'"],
      ["Welke amendementen zijn er onlangs ingediend?", "'onlangs'"],
      ["Welke moties zijn er de laatste weken ingediend?", "'laatste weken'"],
    ] as const) {
      // Two questions send the same type-only request; each must reach the mock.
      clearHttpCache();
      appCache.clear();
      mockUpstreams({ tk: andTk([...motions, ...amendments]) });
      const res = await ask({ question, top: 5 });
      expect(res.summary, question).toMatch(/^Router: Tweede Kamer \([12] resultaten\)$/);
      // The type alone, not "week" / "maand" / "onlangs" as a title word.
      expect(sent("tk")[0], question).not.toContain("contains(Onderwerp");
      expect(res.access_note, question).toContain(`Tijdsaanduiding ${expected} is niet als datumfilter toegepast`);
    }
  });
});

describe("nl_gov_ask document search deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers without a source that does not respond in time, and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mockUpstreams({
      ob: () => xmlResponse(sruXml(["Jaarverslag UWV"])),
      rijk: () => xmlResponse(rssXml([])),
    });
    // Tweede Kamer hangs.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const answer = fetchMock.getMockImplementation() as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("tweedekamer.nl")) return new Promise<Response>(() => {});
      return answer(input, init);
    });

    const pending = ask({ question: "Wat doet het UWV?", top: 5 });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.summary).toBe("Router: organisatie/beleid (1 resultaten uit 1 bronnen)");
    expect(res.failures).toEqual([expect.objectContaining({ connector: "tweede_kamer", error_type: "timeout" })]);
    expect(res.access_note).toContain("Tweede Kamer niet afgewacht (geen antwoord binnen 10 s)");
  });
});

describe("nl_gov_ask Officiële Bekendmakingen journals", () => {
  it("filters on the journal the question names instead of requiring its name as a word", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml(["Regeling stikstofbank"])) });

    const res = await ask({ question: "Bekendmakingen in de Staatscourant over stikstof", top: 5 });

    expect(res.summary).toBe("Router: Bekendmakingen (1 resultaten)");
    const query = sruQuery(sent("ob")[0]);
    expect(query).toContain('w.publicatienaam="Staatscourant"');
    expect(sruTextTerms(sent("ob")[0])).toEqual(["stikstof"]);
    expect(res.access_note).toContain("Gefilterd op publicatieblad 'Staatscourant'.");
  });

  it("reads an abbreviation as the journal too", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml(["Afvalstoffenverordening"])) });

    await ask({ question: "gmb afvalinzameling", top: 5 });

    expect(sruQuery(sent("ob")[0])).toContain('w.publicatienaam="Gemeenteblad"');
    expect(sruTextTerms(sent("ob")[0])).toEqual(["afvalinzameling"]);
  });

  it("lists the journal's newest publications when the question names no topic", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml(["Regeling A", "Regeling B"])) });

    const res = await ask({ question: "Wat staat er in de Staatscourant?", top: 5 });

    expect(res.summary).toBe("Router: Bekendmakingen (2 resultaten)");
    const query = sruQuery(sent("ob")[0]);
    expect(query).toContain('w.publicatienaam="Staatscourant"');
    expect(query).toContain("sortBy dt.date/sort.descending");
    expect(sruTextTerms(sent("ob")[0])).toEqual([]);
    expect(res.access_note).toContain("Gefilterd op publicatieblad 'Staatscourant', nieuwste eerst.");
  });

  it("leaves 'bekendmakingen' out of the search terms without a journal", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml(["Omgevingsvergunning woningbouw"])) });

    await ask({ question: "Welke bekendmakingen zijn er over woningbouw?", top: 5 });

    expect(sruQuery(sent("ob")[0])).not.toContain("w.publicatienaam");
    expect(sruTextTerms(sent("ob")[0])).toEqual(["woningbouw"]);
  });

  it("plans the journal filter in a dry run", async () => {
    mockUpstreams({});
    const res = await ask({ question: "Bekendmakingen in het Gemeenteblad over afvalinzameling", dryRun: true });
    expect(res.estimated_sources).toEqual(["ob"]);
    expect(res.planned_requests[0].params).toMatchObject({ query: "afvalinzameling", publicatieblad: "Gemeenteblad" });
  });

  it("applies the journal filter to the official publications in a multi-source answer", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml(["Regeling woningbouwimpuls"])) });

    const res = await ask({ question: "Hoeveel woningen zijn er gebouwd en wat staat er in de Staatscourant over woningbouw?", top: 5 });

    expect(res.summary).toMatch(/^Router: multi-source/);
    const query = sruQuery(sent("ob")[0]);
    expect(query).toContain('w.publicatienaam="Staatscourant"');
    expect(sruTextTerms(sent("ob")[0])).not.toContain("staatscourant");
    expect(res.access_note).toContain("Officiële Bekendmakingen gefilterd op publicatieblad 'Staatscourant'.");
  });
});

describe("nl_gov_ask EUR-Lex document numbers", () => {
  it("passes a document number to EUR-Lex whole, so it is looked up as that act", async () => {
    mockUpstreams({});
    const plan = await ask({ question: "Europese verordening 2016/679", dryRun: true });
    expect(plan.estimated_sources).toEqual(["eu_cellar"]);
    expect(plan.planned_requests[0].params.query).toBe("2016/679");

    // EUR-Lex itself is not mocked: only the request matters here.
    await ask({ question: "Europese verordening 2016/679", top: 3 });
    expect(requests.some((r) => r.text.includes('"32016R0679"'))).toBe(true);
  });

  it("keeps a slashed number whole next to topic words", async () => {
    mockUpstreams({});
    const plan = await ask({ question: "EUR-Lex 1049/2001 openbaarheid", dryRun: true });
    expect(plan.planned_requests[0].params.query).toBe("1049/2001 openbaarheid");

    const searchWords = await ask({ question: "Zoek in EUR-Lex naar 2016/679", dryRun: true });
    expect(searchWords.planned_requests[0].params.query).toBe("2016/679");
  });
});

describe("nl_gov_ask with several sources named in one question", () => {
  const parkingPaper = { Id: "tk-1", Titel: "Brief over parkeerbeleid en woon-werkverkeer", Onderwerp: "Brief over parkeerbeleid en woon-werkverkeer", Soort: "Brief regering", Datum: "2026-09-01T00:00:00" };

  it("does not make one source require the route words of another", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml(["Verkeersbesluit parkeerregulering centrum"])),
      tk: () => jsonResponse(tkJson([parkingPaper])),
    });

    const res = await ask({ question: "Welke kamerstukken en publicaties in de Staatscourant gaan over parkeerbeleid?", top: 5 });

    expect(res.summary).toMatch(/^Router: multi-source \(2 resultaten uit 2 bronnen\)/);
    // Officiële Bekendmakingen required "kamerstukken", Tweede Kamer "staatscourant" and "publicaties".
    expect(sruTextTerms(sent("ob")[0])).toEqual(["parkeerbeleid"]);
    expect(sruQuery(sent("ob")[0])).toContain('w.publicatienaam="Staatscourant"');
    expect(tkTopicTerms(tkSearches()[0])).toEqual(["parkeerbeleid"]);
    expect(res.access_note).toContain('Tweede Kamer "parkeerbeleid"; Officiële Bekendmakingen "parkeerbeleid"');
  });

  it("keeps the other routes' words out of the single-source routes too", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
      dov: () => jsonResponse(ckanJson([])),
    });

    await ask({ question: "Welke moties en bekendmakingen gaan over afvalinzameling?", top: 5 });

    for (const search of tkSearches()) expect(tkTopicTerms(search)).not.toContain("bekendmakingen");
    for (const text of sent("ob")) expect(sruTextTerms(text)).not.toContain("moties");
    expect(sent("ob").length).toBeGreaterThan(0);
    expect(sent("dov")[0]).toContain("q=afvalinzameling&");
  });

  it("leaves 'uitspraken' out of Tweede Kamer and 'kamervragen' out of Rechtspraak when a question names both", async () => {
    mockUpstreams({
      rechtspraak: () => jsonResponse(rechtspraakJson(["ECLI:NL:RBMNE:2026:1"])),
      tk: () => jsonResponse(tkJson([{ ...parkingPaper, Titel: "Brief over huurbescherming", Onderwerp: "Brief over huurbescherming" }])),
    });

    const res = await ask({ question: "Welke uitspraken en kamervragen zijn er over huurbescherming?", top: 3 });

    expect(res.summary).toMatch(/^Router: multi-source/);
    // Tweede Kamer required "uitspraken" and found nothing; Rechtspraak required "kamervragen".
    expect(tkTopicTerms(tkSearches()[0])).toEqual(["huurbescherming"]);
    const term = (JSON.parse(requests.find((r) => r.upstream === "rechtspraak")!.body!) as { SearchTerms: Array<{ Term: string }> }).SearchTerms[0].Term;
    expect(term).toBe("huurbescherming");
  });

  it("plans the same queries in a dry run, and keeps a name that holds a route word", async () => {
    mockUpstreams({});
    const plan = async (question: string) =>
      Object.fromEntries((await ask({ question, dryRun: true })).planned_requests.map((r: { connector: string; params: { query: string } }) => [r.connector, r.params.query]));

    expect(await plan("Welke kamerstukken en publicaties in de Staatscourant gaan over parkeerbeleid?")).toEqual({ tk: "parkeerbeleid", ob: "parkeerbeleid" });
    expect(await plan("Welke uitspraken en kamervragen zijn er over huurbescherming?")).toEqual({ tk: "huurbescherming", rechtspraak: "huurbescherming" });
    // "parlement" picks Tweede Kamer, but in "Europees Parlement" it is part
    // of the topic. A run of capitalised words goes to Tweede Kamer as its
    // words in a multi-source answer: one search, and such a name is often no
    // phrase in the papers.
    expect(await plan("Welke uitspraken en kamervragen gaan over het Europees Parlement?")).toEqual({ tk: "europees parlement", rechtspraak: "europees parlement" });
  });

  it("keeps 'uitspraak' for the other sources when it is the only kind of paper named", async () => {
    mockUpstreams(allUpstreams);
    const res = await ask({ question: "Uitspraak in de zaak tegen de minister van Justitie", top: 3 });
    expect(res.access_note).toContain('Rijksoverheid "uitspraak zaak minister justitie"');
  });

  it("keeps a route word that is the only topic left", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml([])), tk: () => jsonResponse(tkJson([])) });

    await ask({ question: "Welke kamerstukken gaan over de Staatscourant?", top: 5 });

    expect(tkTopicTerms(tkSearches()[0])).toEqual(["staatscourant"]);
  });

  it("keeps council document words in a municipality's council records", async () => {
    mockUpstreams({ ori: oriUpstream(({ path }) => (path.includes("ori_utrecht") ? [{ index: UTRECHT_INDEX, title: "Motie parkeerbeleid binnenstad" }] : [])) });

    const res = await ask({ question: "Welke moties over parkeerbeleid heeft de gemeenteraad van Utrecht aangenomen?", top: 5 });

    expect(res.summary).toBe("Router: Open Raadsinformatie Utrecht (1 resultaten)");
    expect(oriSearches()[0].query).toContain("moties");
    expect(oriSearches()[0].query).toContain("parkeerbeleid");
  });
});

describe("nl_gov_ask pagination within the records it fetched", () => {
  const manyHits = (titles: string[], total: number) => xmlResponse(sruXml(titles).replace(/<sru:numberOfRecords>\d+</, `<sru:numberOfRecords>${total}<`));
  const titles = ["Parkeerverordening centrum", "Parkeerbeleid wijk Oost", "Verkeersbesluit parkeren"];

  it("does not promise a next page when it holds no more records than it showed", async () => {
    mockUpstreams({ ob: () => manyHits(titles, 3509) });

    const res = await ask({ question: "Welke bekendmakingen gaan over parkeerbeleid?", top: 3 });

    expect(res.summary).toBe("Router: Bekendmakingen (3 resultaten)");
    expect(res.pagination).toEqual({ offset: 0, limit: 3, total: 3, has_more: false });
    // The source's own count stays available, and is explained.
    expect(res.provenance.total_results).toBe(3509);
    expect(res.access_note).toContain("De bron meldt 3.509 treffers; nl_gov_ask haalt er 3 op");
    expect(res.access_note).toContain("verhoog 'top'");
  });

  it("pages within the fetched records", async () => {
    mockUpstreams({ ob: () => manyHits(titles, 3509) });
    const first = await ask({ question: "Welke bekendmakingen gaan over parkeerbeleid?", top: 3, limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.pagination).toEqual({ offset: 0, limit: 2, total: 3, has_more: true });

    const last = await ask({ question: "Welke bekendmakingen gaan over parkeerbeleid?", top: 3, limit: 2, offset: 2 });
    expect(last.records).toHaveLength(1);
    expect(last.pagination).toEqual({ offset: 2, limit: 2, total: 3, has_more: false });
  });

  it("does the same for a municipality's council records", async () => {
    mockUpstreams({
      ori: oriUpstream(
        ({ path }) => (path.includes("ori_utrecht") ? [{ index: UTRECHT_INDEX, title: "Parkeervisie" }, { index: UTRECHT_INDEX, title: "Raadsbrief parkeren" }] : []),
        2203,
      ),
    });

    const res = await ask({ question: "Wat is het parkeerbeleid van de gemeente Utrecht?", top: 2, offset: 2 });

    expect(res.records).toEqual([]);
    expect(res.pagination).toMatchObject({ offset: 2, total: 2, has_more: false });
    expect(res.provenance.total_results).toBe(2203);
    expect(res.access_note).toContain("De bron meldt 2.203 treffers");
  });

  it("adds no note when it holds every record the source found", async () => {
    mockUpstreams({ ob: () => manyHits(titles, 3) });
    const res = await ask({ question: "Welke bekendmakingen gaan over parkeerbeleid?", top: 5 });
    expect(res.pagination).toEqual({ offset: 0, limit: 5, total: 3, has_more: false });
    expect(res.access_note ?? "").not.toContain("De bron meldt");
  });
});

describe("nl_gov_ask national council search for a named municipality", () => {
  it("binds a one-word town name to 'gemeente' and keeps a longer name a phrase", () => {
    expect(oriPlacePhrase("Kampen")).toBe('"gemeente kampen"');
    expect(oriPlacePhrase("Bergen op Zoom")).toBe('"bergen op zoom"');
  });

  it("searches all councils for the municipality as a phrase, not as a loose word", async () => {
    mockUpstreams({
      ori: oriUpstream(() => [{ index: DEN_HAAG_INDEX, title: "Raadsvoorstel samenwerking afvalinzameling" }]),
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
    });

    // Kampen has no ORI index in this fixture. As a loose word, "kampen" also
    // matched "kampen met" in other councils' papers.
    const res = await ask({ question: "Wat is het beleid voor afvalinzameling van de gemeente Kampen?", top: 5, verbose: true });

    expect(res.verbose.fallbacks_used).toContain("ori:Kampen:no_index");
    const searches = oriSearches();
    expect(searches).toHaveLength(1);
    expect(searches[0].path).toBe("/v1/elastic/_search");
    expect(searches[0].query).toBe('beleid afvalinzameling "gemeente kampen"');
    expect(res.access_note).toContain('met de gemeente als woordgroep ("gemeente kampen")');
  });

  it("keeps a multi-word municipality a phrase of its own", async () => {
    mockUpstreams({
      ori: oriUpstream(() => [{ index: DEN_HAAG_INDEX, title: "Raadsvoorstel fietspaden" }]),
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
    });

    await ask({ question: "Wat is het beleid voor fietspaden van de gemeente Bergen op Zoom?", top: 5 });

    expect(oriSearches()[0].query).toBe('beleid fietspaden "bergen op zoom"');
  });
});

describe("nl_gov_ask phrases for the sources that read them", () => {
  it("sends Tweede Kamer and Officiële Bekendmakingen a multi-word term as a phrase, as ORI gets it", async () => {
    mockUpstreams({
      ori: oriUpstream(() => []),
      ob: () => xmlResponse(sruXml([])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
      dov: () => jsonResponse(ckanJson([])),
    });

    await ask({ question: "Welke gemeenten hebben een Open Data Portaal?", top: 5 });

    expect(oriSearches()[0].query).toBe('"open data portaal"');
    // Before, Tweede Kamer required "open", "data" and "portaal" one by one.
    expect(tkTopicTerms(tkSearches()[0])).toEqual(["open data portaal"]);
    expect(sruQuery(sent("ob")[0])).toContain('"open data portaal"');
    // Rijksoverheid's search has no phrase syntax: words.
    expect(sent("rijk")[0]).toContain('"resultSearchTerm":"open data portaal"');
  });

  it("sends a quoted phrase from the question to the Tweede Kamer route as a phrase", async () => {
    mockUpstreams({ tk: () => jsonResponse(tkJson([])), dov: () => jsonResponse(ckanJson([])) });

    await ask({ question: 'Welke moties gaan over "omgekeerd inzamelen"?', top: 5 });

    expect(tkTopicTerms(tkSearches()[0])).toEqual(["omgekeerd inzamelen"]);
  });

  it("quotes only multi-word terms, and not the ones it is told to keep loose", () => {
    expect(toPhraseQuery(["afvalinzameling", "den haag"])).toBe('afvalinzameling "den haag"');
    expect(toOriQuery(["afvalinzameling", "den haag"])).toBe(toPhraseQuery(["afvalinzameling", "den haag"]));
    expect(toPhraseQuery(["open data portaal", "den haag"], new Set(["den haag"]))).toBe('"open data portaal" den haag');
  });

  it("sends Officiële Bekendmakingen a run of capitalised words as its words", async () => {
    mockUpstreams({ ob: () => xmlResponse(sruXml(["Kamerbrief over klimaatafspraken van Parijs"])) });

    const res = await ask({ question: "Welke bekendmakingen gaan over het Klimaatakkoord Parijs?", top: 5 });

    // As a phrase, the search ranked unrelated full texts that hold it first.
    expect(res.summary).toBe("Router: Bekendmakingen (1 resultaten)");
    expect(sent("ob")).toHaveLength(1);
    expect(sruTextTerms(sent("ob")[0])).toEqual(["klimaatakkoord", "parijs"]);
    expect(sruQuery(sent("ob")[0])).not.toContain('"klimaatakkoord parijs"');
  });

  it("searches Officiële Bekendmakingen for the loose words when no publication holds a phrase", async () => {
    mockUpstreams({
      ob: (url) => xmlResponse(sruXml((url.searchParams.get("query") ?? "").includes('"omgekeerd inzamelen"') ? [] : ["Afvalbeleidsplan: omgekeerd en gescheiden inzamelen"])),
    });

    const res = await ask({ question: 'Welke bekendmakingen gaan over "omgekeerd inzamelen"?', top: 5, verbose: true });

    expect(res.summary).toBe("Router: Bekendmakingen (1 resultaten)");
    expect(sent("ob").map(sruQuery).map((cql) => cql.includes('"omgekeerd inzamelen"'))).toEqual([true, false]);
    expect(sruTextTerms(sent("ob")[1])).toEqual(["omgekeerd", "inzamelen"]);
    expect(res.access_note).toContain('Met woordgroep niets gevonden voor "omgekeerd inzamelen"; daarom gezocht op de losse woorden.');
    expect(res.verbose.fallbacks_used).toContain("officiele_bekendmakingen:loose_words:omgekeerd inzamelen");
  });

  it("sends the document search a run of capitalised words as its words", async () => {
    mockUpstreams({
      ob: () => xmlResponse(sruXml(["Luchthavenverkeerbesluit Schiphol"])),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
    });

    const res = await ask({ question: "Wat doet het kabinet aan Schiphol Geluidsoverlast?", top: 5 });

    expect(res.summary).toMatch(/^Router: organisatie\/beleid/);
    expect(sruTextTerms(sent("ob")[0]).sort()).toEqual(["geluidsoverlast", "kabinet", "schiphol"]);
    expect(sruQuery(sent("ob")[0])).not.toContain('"schiphol geluidsoverlast"');
    expect(tkTermSets()[0]).toEqual(["geluidsoverlast", "kabinet", "schiphol"]);
  });
});

describe("nl_gov_ask when Officiële Bekendmakingen refuses or fails", () => {
  it("reports a refused query as not searched instead of 0 results", async () => {
    mockUpstreams({ ob: () => xmlResponse(SRU_DIAGNOSTIC), dov: () => jsonResponse(ckanJson([])) });

    const res = await ask({ question: "Welke bekendmakingen gaan over afvalinzameling?", top: 5, verbose: true });

    expect(res.summary).toBe("Router fallback: data.overheid (0 resultaten)");
    expect(res.access_note).toContain("Officiële Bekendmakingen (zoekvraag geweigerd, niet gezocht)");
    expect(res.access_note).not.toContain("Officiële Bekendmakingen (0 resultaten)");
    expect(res.failures).toEqual([expect.objectContaining({ connector: "officiele_bekendmakingen", message: expect.stringContaining("weigerde de zoekvraag") })]);
    expect(res.verbose.fallbacks_used).toContain("officiele_bekendmakingen:query_refused");
  });

  it("falls through to the next route when the source fails, as the other routes do", async () => {
    mockUpstreams({ ob: () => new Response("bad gateway", { status: 502 }), dov: () => jsonResponse(ckanJson(["Afvalinzameling per gemeente"])) });

    const res = await ask({ question: "Welke bekendmakingen gaan over afvalinzameling?", top: 5 });

    // Before, the whole question failed with the source's HTTP error.
    expect(res.error).toBeUndefined();
    expect(res.summary).toBe("Router fallback: data.overheid (1 resultaten)");
    expect(res.access_note).toContain("Officiële Bekendmakingen (mislukt: http_error)");
    expect(res.failures).toEqual([expect.objectContaining({ connector: "officiele_bekendmakingen", error_type: "http_error" })]);
  });

  it("names a refusal in the document search", async () => {
    mockUpstreams({
      ob: () => xmlResponse(SRU_DIAGNOSTIC),
      tk: () => jsonResponse(tkJson([{ Id: "tk-1", Titel: "Brief over btw-tarieven", Onderwerp: "Brief over btw-tarieven", Soort: "Brief regering", Datum: "2026-09-01T00:00:00" }])),
      rijk: () => xmlResponse(rssXml([])),
    });

    const res = await ask({ question: "Wat doet de Belastingdienst met de BTW?", top: 5 });

    expect(res.summary).toMatch(/^Router: organisatie\/beleid/);
    expect(res.access_note).toContain("Officiële Bekendmakingen weigerde de zoekvraag (niet gezocht)");
    expect(res.access_note).not.toContain("Officiële Bekendmakingen 0");
    expect(res.failures).toEqual([expect.objectContaining({ connector: "officiele_bekendmakingen", message: expect.stringContaining("SRU-diagnose") })]);
  });

  it("counts a refusal as a failed source in a multi-source answer", async () => {
    mockUpstreams({
      ob: () => xmlResponse(SRU_DIAGNOSTIC),
      tk: () => jsonResponse(tkJson([{ Id: "tk-1", Titel: "Brief over parkeerbeleid", Onderwerp: "Brief over parkeerbeleid", Soort: "Brief regering", Datum: "2026-09-01T00:00:00" }])),
    });

    const res = await ask({ question: "Welke kamerstukken en publicaties in de Staatscourant gaan over parkeerbeleid?", top: 5 });

    expect(res.summary).toBe("Router: multi-source (1 resultaten uit 1 bronnen)");
    expect(res.failures).toEqual([expect.objectContaining({ connector: "ob", message: expect.stringContaining("weigerde de zoekvraag") })]);
  });

  it("goes on to the next routes when one source refused and the others found nothing", async () => {
    mockUpstreams({
      ob: () => xmlResponse(SRU_DIAGNOSTIC),
      tk: () => jsonResponse(tkJson([])),
      rijk: () => xmlResponse(rssXml([])),
      dov: () => jsonResponse(ckanJson([])),
    });

    const res = await ask({ question: "Welke kamerstukken en publicaties in de Staatscourant gaan over parkeerbeleid?", top: 5 });

    // Not "Alle geselecteerde bronnen faalden": Tweede Kamer answered, with nothing.
    expect(res.error).toBeUndefined();
    expect(res.access_note).toContain("zoekvraag geweigerd, niet gezocht");
    // Refused in the multi-source step, on its own route and in the document
    // search: reported once.
    expect(res.failures.filter((f: { message: string }) => f.message.includes("weigerde de zoekvraag"))).toHaveLength(1);
  });
});
