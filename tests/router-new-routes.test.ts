import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { detectEcliIntent, detectForeignEcliIntent, detectResearchOrgIntent, detectWetArtikelIntent, extractPopulationPlace, wetPeildatum, ECLI_QUESTION_MAX } from "../src/router/intents.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { appCache } from "../src/cache.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";
import { NOT_THIS_ROUTE } from "./helpers/router-corpus.js";

/* ------------------------------------------------------------------ */
/*  The routes of round three: a ruling by ECLI, an artikel of a law,  */
/*  the Algemene Rekenkamer, the SCP and the WODC, the population of   */
/*  a municipality, the Kamerbrief and the text of the best ORI hit.   */
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

let requests: Array<{ url: URL; body?: string }> = [];
/** Requests to a host (and path prefix), as URLs. */
const sentTo = (host: string, path = "") => requests.filter((r) => r.url.hostname === host && r.url.pathname.startsWith(path)).map((r) => r.url);

/** fetch answered per request by `route`; anything it does not answer is a 404. */
function mockFetch(route: (url: URL, body?: string) => Response | undefined) {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? String(init.body) : undefined;
    requests.push({ url, body });
    return route(url, body) ?? new Response("not found", { status: 404 });
  }));
}

const EMPTY_SRU = '<?xml version="1.0" encoding="UTF-8"?><sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse"><sru:version>2.0</sru:version><sru:numberOfRecords>0</sru:numberOfRecords></sru:searchRetrieveResponse>';
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

/* ------------------------------------------------------------------ */
/*  What the routes read from a question                               */
/* ------------------------------------------------------------------ */

describe("detectEcliIntent", () => {
  it("reads the Dutch ECLIs of a question, in any case and in a Rechtspraak link", () => {
    expect(detectEcliIntent("Wat besliste de Hoge Raad in ECLI:NL:HR:2019:2006?")).toEqual({ eclis: ["ECLI:NL:HR:2019:2006"], skipped: [], foreign: [] });
    expect(detectEcliIntent("ecli:nl:hr:2019:2007 samenvatting")?.eclis).toEqual(["ECLI:NL:HR:2019:2007"]);
    expect(detectEcliIntent("Lees ECLI:NL:CRVB:2021:1234.")?.eclis).toEqual(["ECLI:NL:CRVB:2021:1234"]);
    expect(detectEcliIntent("Zie https://uitspraken.rechtspraak.nl/details?id=ECLI%3ANL%3ARBDHA%3A2015%3A7145")?.eclis).toEqual(["ECLI:NL:RBDHA:2015:7145"]);
  });

  it("reads several, once each, and names the ones past the maximum and the foreign ones", () => {
    expect(detectEcliIntent("ECLI:NL:HR:2019:2006 en ECLI:NL:HR:2019:2007 en weer ECLI:NL:HR:2019:2006")?.eclis).toEqual(["ECLI:NL:HR:2019:2006", "ECLI:NL:HR:2019:2007"]);
    const many = Array.from({ length: ECLI_QUESTION_MAX + 2 }, (_, i) => `ECLI:NL:RBAMS:2020:${100 + i}`);
    const intent = detectEcliIntent(`Vergelijk ${many.join(", ")} met ECLI:EU:C:2014:317`)!;
    expect(intent.eclis).toEqual(many.slice(0, ECLI_QUESTION_MAX));
    expect(intent.skipped).toEqual(many.slice(ECLI_QUESTION_MAX));
    expect(intent.foreign).toEqual(["ECLI:EU:C:2014:317"]);
  });

  it("is no intent without a Dutch ECLI", () => {
    for (const question of NOT_THIS_ROUTE.rechtspraak_uitspraak) expect(detectEcliIntent(question), question).toBeUndefined();
  });
});

describe("detectForeignEcliIntent", () => {
  it("reads a question that names only ECLIs of the EU or another country", () => {
    expect(detectForeignEcliIntent("ECLI:EU:C:2014:317")).toEqual(["ECLI:EU:C:2014:317"]);
    expect(detectForeignEcliIntent("Wat zegt ecli:de:bgh:2019:123 en ECLI:EU:T:2018:12?")).toEqual(["ECLI:DE:BGH:2019:123", "ECLI:EU:T:2018:12"]);
  });

  it("is no intent next to a Dutch ECLI, next to Kamerstukken, or without an ECLI", () => {
    expect(detectForeignEcliIntent("ECLI:EU:C:2014:317 en ECLI:NL:HR:2019:2006")).toBeUndefined();
    expect(detectForeignEcliIntent("Kamervragen over ECLI:EU:C:2014:317")).toBeUndefined();
    expect(detectForeignEcliIntent("Wat is een ECLI-nummer van een uitspraak?")).toBeUndefined();
  });
});

describe("detectWetArtikelIntent", () => {
  it("reads the law and the artikel next to each other", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["Wat staat er in artikel 3:4 van de Awb?", { wet: "Awb", artikel: "3:4" }],
      ["Wat zegt art. 5.1 Omgevingswet?", { wet: "Omgevingswet", artikel: "5.1" }],
      ["Artikel 1 van de Grondwet", { wet: "Grondwet", artikel: "1" }],
      ["Wat regelt artikel 5.1 van de Wet open overheid?", { wet: "Wet open overheid", artikel: "5.1" }],
      ["Wet open overheid artikel 3.3", { wet: "Wet open overheid", artikel: "3.3" }],
      ["artikel 300 Wetboek van Strafrecht", { wet: "Wetboek van Strafrecht", artikel: "300" }],
      ["Artikel 2.1 Besluit bouwwerken leefomgeving", { wet: "Besluit bouwwerken leefomgeving", artikel: "2.1" }],
      ["Wat staat in artikel 3:4, tweede lid, Awb?", { wet: "Awb", artikel: "3:4 lid 2" }],
      ["Artikel 8:69 lid 1 Awb", { wet: "Awb", artikel: "8:69 lid 1" }],
      // The BWB holds each book of the BW as a regeling of its own.
      ["Artikel 6:162 BW", { wet: "BW boek 6", artikel: "162" }],
      ["Wat zegt artikel 7:2 van het Burgerlijk Wetboek?", { wet: "BW boek 7", artikel: "2" }],
    ];
    for (const [question, expected] of cases) expect(detectWetArtikelIntent(question), question).toEqual(expected);
  });

  it("reads which artikelen of a law deal with a subject as a zoekterm", () => {
    expect(detectWetArtikelIntent("Welke artikelen van de Participatiewet gaan over de kostendelersnorm?")).toEqual({ wet: "Participatiewet", zoekterm: "kostendelersnorm" });
  });

  it("reads the day the text is asked for, never a year in the law's name", () => {
    expect(detectWetArtikelIntent("Hoe luidde artikel 3:4 Awb op 1 januari 2015?")).toMatchObject({ peildatum: "2015-01-01", peildatumBron: "op 1 januari 2015" });
    expect(detectWetArtikelIntent("Wat stond er in 2015 in artikel 2 van de Gemeentewet?")).toMatchObject({ wet: "Gemeentewet", artikel: "2", peildatum: "2015-01-01" });
    expect(detectWetArtikelIntent("Artikel 2.1 Wmo 2015")).toEqual({ wet: "Wmo 2015", artikel: "2.1" });
    expect(wetPeildatum("per 1-7-2020")?.peildatum).toBe("2020-07-01");
    expect(wetPeildatum("op 2020-07-01")?.peildatum).toBe("2020-07-01");
    expect(wetPeildatum("op 31 februari 2020")).toBeUndefined();
  });

  it("leaves local and EU instruments, rulings, parliamentary papers and policy questions alone", () => {
    for (const question of NOT_THIS_ROUTE.wetten_bwb) expect(detectWetArtikelIntent(question), question).toBeUndefined();
    expect(detectWetArtikelIntent("Wat zegt het artikel in de krant over de Omgevingswet?")).toBeUndefined();
  });
});

describe("detectResearchOrgIntent", () => {
  it("names the body and keeps the topic words", () => {
    const cases: Array<[string, string, string]> = [
      ["Wat heeft de Rekenkamer onderzocht over woningbouw?", "rekenkamer", "woningbouw"],
      ["Algemene Rekenkamer rapport over de asielprocedure", "rekenkamer", "asielprocedure"],
      ["Wat concludeerde de Rekenkamer over de begroting van Justitie?", "rekenkamer", "begroting justitie"],
      ["Nieuwste publicaties van de Algemene Rekenkamer", "rekenkamer", ""],
      ["SCP-rapport over mantelzorg", "scp", "mantelzorg"],
      ["Wat heeft het Sociaal en Cultureel Planbureau gepubliceerd over de participatiewet?", "scp", "participatiewet"],
      ["SCP onderzoek emancipatie 2024", "scp", "emancipatie"],
      ["WODC-rapport over cybercrime", "wodc", "cybercrime"],
      ["Rapport van het Wetenschappelijk Onderzoek- en Datacentrum over huiselijk geweld", "wodc", "huiselijk geweld"],
      ["Nieuwste WODC-rapporten", "wodc", ""],
    ];
    for (const [question, org, query] of cases) expect(detectResearchOrgIntent(question), question).toEqual({ org, query });
  });

  it("leaves other rekenkamers, other planbureaus, parliamentary papers and two bodies at once alone", () => {
    for (const org of ["rekenkamer", "scp", "wodc"] as const) {
      for (const question of NOT_THIS_ROUTE[org]) expect(detectResearchOrgIntent(question)?.org, question).not.toBe(org);
    }
  });
});

describe("extractPopulationPlace", () => {
  it("reads the municipality whose number of inhabitants is asked", () => {
    expect(extractPopulationPlace("Hoeveel inwoners heeft Nijmegen?")).toBe("Nijmegen");
    expect(extractPopulationPlace("Hoeveel inwoners heeft de gemeente Zwolle?")).toBe("Zwolle");
    expect(extractPopulationPlace("Aantal inwoners van Den Haag")).toBe("Den Haag");
    expect(extractPopulationPlace("Hoeveel inwoners had Zwolle op 1 januari 2025?")).toBe("Zwolle");
    expect(extractPopulationPlace("Wat is het inwonertal van Bergen op Zoom?")).toBe("Bergen op Zoom");
    // The country is in the population table too.
    expect(extractPopulationPlace("Hoeveel inwoners heeft Nederland?")).toBe("Nederland");
  });

  it("is no place for a region without a figure, a part of the population or another measure", () => {
    for (const question of [
      "Hoeveel inwoners heeft de Randstad?",
      "Hoeveel inwoners van Utrecht zijn ouder dan 65?",
      "Zorgkosten per inwoner in Utrecht",
      "Hoeveel mensen wonen er in de wijk Lunetten in Utrecht?",
      "Wat is het opleidingsniveau van inwoners van Heerlen?",
      "Hoeveel inwoners heeft de gemeente met het omgevingsplan van Utrecht?",
    ]) expect(extractPopulationPlace(question), question).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  A ruling named by its ECLI                                         */
/* ------------------------------------------------------------------ */

const RS = 'xmlns="http://www.rechtspraak.nl/schema/rechtspraak-1.0"';
function uitspraakXml(ecli: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:psi="http://psi.rechtspraak.nl/" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
    <rdf:Description>
      <dcterms:identifier>${ecli}</dcterms:identifier>
      <dcterms:creator rdfs:label="Instantie">Hoge Raad</dcterms:creator>
      <dcterms:date rdfs:label="Uitspraakdatum">2019-12-20</dcterms:date>
      <psi:zaaknummer rdfs:label="Zaaknr">19/00135</psi:zaaknummer>
      <dcterms:type rdf:language="nl">Uitspraak</dcterms:type>
    </rdf:Description>
  </rdf:RDF>
  <inhoudsindicatie ${RS}><parablock><para>Klimaatzaak. Bevel aan de Staat.</para></parablock></inhoudsindicatie>
  <uitspraak ${RS}>
    <section><title><nr>1</nr>Procesverloop</title><para>Het verloop van het geding.</para></section>
    <section role="beslissing"><title><nr>2</nr>Beslissing</title><para>De Hoge Raad verwerpt het beroep.</para></section>
  </uitspraak>
</open-rechtspraak>`;
}

describe("nl_gov_ask: a ruling named by its ECLI", () => {
  it("reads the ruling itself and never searches with the ECLI taken apart", async () => {
    mockFetch((url) => (url.pathname === "/uitspraken/content" && url.searchParams.get("id") === "ECLI:NL:HR:2019:2006" ? xmlResponse(uitspraakXml("ECLI:NL:HR:2019:2006")) : undefined));
    const res = await ask({ question: "Wat besliste de Hoge Raad in ECLI:NL:HR:2019:2006?" });
    expect(res.summary).toMatch(/^Router: Rechtspraak uitspraak — ECLI:NL:HR:2019:2006 .*: overzicht met beslissing/);
    expect(res.records[0].data.tekst).toContain("verwerpt het beroep");
    expect(res.access_note).toContain("die is zelf gelezen");
    expect(sentTo("data.rechtspraak.nl", "/uitspraken/zoeken")).toEqual([]);
    expect(requests.every((r) => r.url.hostname === "data.rechtspraak.nl")).toBe(true);
  });

  it("reads each of several and says which one Rechtspraak does not know", async () => {
    mockFetch((url) => (url.searchParams.get("id") === "ECLI:NL:HR:2019:2006" ? xmlResponse(uitspraakXml("ECLI:NL:HR:2019:2006")) : undefined));
    const res = await ask({ question: "Wat is het verschil tussen ECLI:NL:HR:2019:2006 en ECLI:NL:HR:2099:1?" });
    expect(res.summary).toBe("Router: Rechtspraak — 2 uitspraken op ECLI gelezen (1 gevonden)");
    expect(res.records).toHaveLength(1);
    expect(res.access_note).toContain("ECLI:NL:HR:2099:1: ECLI:NL:HR:2099:1 niet gevonden op Rechtspraak.nl");
    expect(sentTo("data.rechtspraak.nl", "/uitspraken/content")).toHaveLength(2);
  });

  it("answers with an explicit error when Rechtspraak fails, not with a search", async () => {
    mockFetch(() => new Response("kapot", { status: 500 }));
    const res = await ask({ question: "Wat besliste de Hoge Raad in ECLI:NL:HR:2019:2006?" });
    expect(res.error).toBe("http_error");
    expect(res.message).toContain("ECLI:NL:HR:2019:2006");
    expect(sentTo("data.rechtspraak.nl", "/uitspraken/zoeken")).toEqual([]);
  }, 20_000);

  it("searches Rechtspraak for no ECLI of the EU or another country, and says where the ruling is", async () => {
    const plan = await ask({ question: "ECLI:EU:C:2014:317", dryRun: true });
    expect(plan.estimated_sources).toEqual([]);
    expect(plan.planned_requests).toEqual([]);
    mockFetch(() => undefined);
    const res = await ask({ question: "ECLI:EU:C:2014:317" });
    expect(requests).toEqual([]);
    expect(res.error).toBeUndefined();
    expect(res.records).toEqual([]);
    expect(res.summary).toBe("Router: ECLI:EU:C:2014:317 is geen Nederlandse ECLI (0 resultaten)");
    expect(res.access_note).toContain("https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=ecli:ECLI%3AEU%3AC%3A2014%3A317");

    const german = await ask({ question: "Wat zegt ECLI:DE:BGH:2019:123?" });
    expect(requests).toEqual([]);
    expect(german.access_note).toContain("e-justice.europa.eu");
    expect(german.access_note).not.toContain("eur-lex");

    // Next to Kamervragen it is their topic, whole, and no rulings search.
    const kamervragen = await ask({ question: "Kamervragen over ECLI:EU:C:2014:317", dryRun: true });
    expect(kamervragen.estimated_sources).toEqual(["tk"]);
    expect(kamervragen.planned_requests[0].params.query).toBe("ECLI:EU:C:2014:317");
  });

  it("plans one request per ruling", async () => {
    const res = await ask({ question: "Vergelijk ECLI:NL:HR:2019:2006 met ECLI:NL:HR:2019:2007", dryRun: true });
    expect(res.estimated_sources).toEqual(["rechtspraak_uitspraak"]);
    expect(res.planned_requests.map((r: any) => r.params.id)).toEqual(["ECLI:NL:HR:2019:2006", "ECLI:NL:HR:2019:2007"]);
    expect(res.planned_requests[0].params.max_chars).toBe(6000);
  });
});

/* ------------------------------------------------------------------ */
/*  An artikel of a named law                                          */
/* ------------------------------------------------------------------ */

describe("nl_gov_ask: an artikel of a named law", () => {
  it("plans wetten_bwb_tekst with the law, the artikel and the day", async () => {
    const res = await ask({ question: "Hoe luidde artikel 3:4 Awb op 1 januari 2015?", dryRun: true });
    expect(res.estimated_sources).toEqual(["wetten_bwb"]);
    expect(res.planned_requests[0].params).toMatchObject({ wet: "Awb", artikel: "3:4", peildatum: "2015-01-01" });
  });

  it("hands a law the BWB does not know to the other routes, and says so", async () => {
    mockFetch((url) => (url.hostname === "zoekservice.overheid.nl" ? xmlResponse(EMPTY_SRU) : url.hostname === "data.overheid.nl" ? jsonResponse(EMPTY_CKAN) : undefined));
    const res = await ask({ question: "Wat staat er in artikel 3 van de Fantasiewet?" });
    expect(res.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(res.access_note).toContain("Eerst gezocht in de BWB (wet 'Fantasiewet', artikel '3'): Geen regeling gevonden met 'Fantasiewet' als titel of afkorting");
  });
});

/* ------------------------------------------------------------------ */
/*  The Algemene Rekenkamer, the SCP and the WODC                      */
/* ------------------------------------------------------------------ */

function rss(origin: string, titles: string[]): string {
  const items = titles.map((title, i) => `<item><title>${title}</title><link>${origin}/documenten/2026/05/0${i + 1}/rapport-${i + 1}</link><description>Teaser van ${title}</description><pubDate>Fri, 0${i + 1} May 2026 09:00:00 GMT</pubDate><guid isPermaLink="false">doc-${i + 1}</guid></item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Zoeken</title><link>${origin}/</link>${items}</channel></rss>`;
}

describe("nl_gov_ask: a research body named in the question", () => {
  it("searches the Algemene Rekenkamer's publications for the topic, without its name", async () => {
    mockFetch((url) => (url.hostname === "www.rekenkamer.nl" ? xmlResponse(rss("https://www.rekenkamer.nl", ["Woningbouw in Nederland", "Bouwen aan woningen"])) : undefined));
    const res = await ask({ question: "Wat heeft de Rekenkamer onderzocht over woningbouw?" });
    expect(res.summary).toBe("Router: Algemene Rekenkamer (2 publicaties)");
    expect(res.records[0].canonical_url).toBe("https://www.rekenkamer.nl/documenten/2026/05/01/rapport-1");
    const sentQuery = decodeURIComponent(sentTo("www.rekenkamer.nl")[0].href);
    expect(sentQuery).toContain("woningbouw");
    expect(sentQuery.toLowerCase()).not.toContain("rekenkamer\"");
    expect(res.access_note).toContain("zoekwoorden 'woningbouw'");
  });

  it("goes on to the other routes when the body has nothing, and names it", async () => {
    mockFetch((url) => (url.hostname === "www.scp.nl" ? xmlResponse(rss("https://www.scp.nl", [])) : url.hostname === "data.overheid.nl" ? jsonResponse(EMPTY_CKAN) : undefined));
    const res = await ask({ question: "Wat zegt het SCP over eenzaamheid?" });
    expect(res.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(res.access_note).toContain("Sociaal en Cultureel Planbureau (0 resultaten)");
  });

  it("searches the WODC repository with the topic words", async () => {
    const report = {
      uuid: "11111111-2222-3333-4444-555555555555",
      name: "Recidive onder justitiabelen",
      handle: "20.500.12832/1001",
      metadata: {
        "dc.title": [{ value: "Recidive onder justitiabelen" }],
        "dc.date.issued": [{ value: "2025-03-14" }],
        "dc.identifier.uri": [{ value: "https://repository.wodc.nl/handle/20.500.12832/1001" }],
        "dc.description.abstract": [{ value: "Dit onderzoek beschrijft de recidive van justitiabelen." }],
      },
    };
    mockFetch((url) => (url.hostname === "repository.wodc.nl"
      ? jsonResponse({ _embedded: { searchResult: { page: { number: 0, size: 1, totalElements: 1 }, _embedded: { objects: [{ _embedded: { indexableObject: report } }] } } } })
      : undefined));
    const res = await ask({ question: "WODC onderzoek naar recidive" });
    expect(res.summary).toBe("Router: WODC (1 publicaties)");
    expect(res.records[0].title).toBe("Recidive onder justitiabelen");
    expect(sentTo("repository.wodc.nl")[0].searchParams.get("query")).toBe("recidive");
  });
});

/* ------------------------------------------------------------------ */
/*  CBS: the population of a municipality and CBS's own answers       */
/* ------------------------------------------------------------------ */

const POPULATION_ROWS = (code: string, rows: Array<[string, number, number | null]>) =>
  rows.map(([periode, op1jan, gem]) => ({ RegioS: code, Perioden: periode, BevolkingOp1Januari_1: op1jan, GemiddeldeBevolking_2: gem }));

function mockPopulation(regios: Array<{ Key: string; Title: string }>, data: Array<Record<string, unknown>>) {
  mockFetch((url) => {
    if (url.hostname !== "opendata.cbs.nl") return undefined;
    if (url.pathname.endsWith("/03759ned/RegioS")) return jsonResponse({ value: regios });
    if (url.pathname.endsWith("/03759ned/TypedDataSet")) {
      const filter = url.searchParams.get("$filter") ?? "";
      return jsonResponse({ value: data.filter((row) => filter.includes(`'${String(row.RegioS)}'`)) });
    }
    return undefined;
  });
}

describe("nl_gov_ask: the population of a municipality", () => {
  const REGIOS = [
    { Key: "GM0268", Title: "Nijmegen" },
    { Key: "GM0518", Title: "'s-Gravenhage (gemeente)" },
    { Key: "GM0893", Title: "Bergen (L.)" },
    { Key: "GM0373", Title: "Bergen (NH.)" },
    { Key: "GM0164", Title: "Hengelo (O.)" },
    { Key: "GM0248", Title: "Hengelo (Gld.)" },
  ];
  const DATA = [
    ...POPULATION_ROWS("GM0268", [["2025JJ00", 189007, 189439], ["2026JJ00", 189871, null]]),
    ...POPULATION_ROWS("GM0518", [["2026JJ00", 569468, null]]),
    ...POPULATION_ROWS("GM0893", [["2026JJ00", 12900, null]]),
    ...POPULATION_ROWS("GM0373", [["2026JJ00", 29800, null]]),
    ...POPULATION_ROWS("GM0164", [["2026JJ00", 82000, null]]),
    // A former municipality: no figure after its merger.
    ...POPULATION_ROWS("GM0248", [["2004JJ00", 8800, 8790]]),
  ];

  it("answers the number from the CBS population table, newest year first", async () => {
    mockPopulation(REGIOS, DATA);
    const res = await ask({ question: "Hoeveel inwoners heeft Nijmegen?" });
    expect(res.summary).toBe("Router: CBS bevolking — Nijmegen: 189.871 inwoners op 1 januari 2026");
    expect(res.records[0].canonical_url).toBe("https://opendata.cbs.nl/#/CBS/nl/dataset/03759ned");
    expect(res.records[0].data).toMatchObject({ gemeentecode: "GM0268", bevolking_op_1_januari: 189871, peildatum: "2026-01-01" });
    expect(res.access_note).toContain("03759ned");
  });

  it("puts the year asked first, and knows Den Haag as 's-Gravenhage", async () => {
    mockPopulation(REGIOS, DATA);
    const year = await ask({ question: "Hoeveel inwoners had Nijmegen op 1 januari 2025?" });
    expect(year.summary).toBe("Router: CBS bevolking — Nijmegen: 189.007 inwoners op 1 januari 2025");
    appCache.clear();
    const haag = await ask({ question: "Aantal inwoners van Den Haag" });
    expect(haag.summary).toBe("Router: CBS bevolking — 's-Gravenhage: 569.468 inwoners op 1 januari 2026");
  });

  it("gives the candidates for a name of two municipalities, and a current one over a former one", async () => {
    mockPopulation(REGIOS, DATA);
    const bergen = await ask({ question: "Hoeveel inwoners heeft Bergen?" });
    expect(bergen.summary).toBe("Router: CBS bevolking — 'Bergen' is de naam van 2 gemeenten; kies er een");
    expect(bergen.records.map((r: any) => r.data.gemeentecode)).toEqual(["GM0893", "GM0373"]);
    appCache.clear();
    const hengelo = await ask({ question: "Hoeveel inwoners heeft Hengelo?" });
    expect(hengelo.summary).toBe("Router: CBS bevolking — Hengelo: 82.000 inwoners op 1 januari 2026");
  });

  it("plans the population table for the municipality", async () => {
    const res = await ask({ question: "Hoeveel inwoners heeft Nijmegen?", dryRun: true });
    expect(res.estimated_sources).toEqual(["cbs"]);
    expect(res.planned_requests[0]).toMatchObject({ url: "https://opendata.cbs.nl/ODataApi/OData/03759ned/TypedDataSet", params: { gemeente: "Nijmegen" } });
  });
});

describe("nl_gov_ask: CBS answers are CBS's", () => {
  it("does not answer with a dataset of another organisation from the data.overheid.nl fallback", async () => {
    mockFetch((url) => {
      if (url.hostname.endsWith("cbs.nl")) return jsonResponse({ value: [] });
      if (url.hostname === "data.overheid.nl") {
        // With the CBS filter nothing; without it a waste calendar of a waste company.
        return jsonResponse(url.searchParams.get("fq")
          ? EMPTY_CKAN
          : { success: true, result: { count: 1, results: [{ id: "afval-1", title: "De afvalkalender", notes: "Inzameldata", organization: { title: "Afvalbedrijf" } }] } });
      }
      return undefined;
    });
    const res = await ask({ question: "Hoeveel woningen zijn er in Nijmegen?" });
    expect(res.summary).not.toMatch(/^Router: CBS/);
    expect(res.access_note).toContain("CBS (0 resultaten)");
  });

  it("links a CBS table to its own page", async () => {
    mockFetch((url) => (url.hostname.endsWith("cbs.nl") && url.pathname.endsWith("/Datasets")
      ? jsonResponse({ value: [{ Identifier: "82550NED", Title: "Woningen; hoofdverwarmingssystemen, regio" }] })
      : undefined));
    const res = await ask({ question: "Hoeveel woningen zijn er in Nijmegen?" });
    expect(res.summary).toMatch(/^Router: CBS \(1 resultaten\)/);
    expect(res.records[0].canonical_url).toBe("https://opendata.cbs.nl/#/CBS/nl/dataset/82550NED");
  });
});

/* ------------------------------------------------------------------ */
/*  Kamerbrief and the text of the best ORI hit                        */
/* ------------------------------------------------------------------ */

describe("nl_gov_ask: a Kamerbrief", () => {
  it("goes to the Tweede Kamer as a letter from the government, without the words that ask for its content", async () => {
    const res = await ask({ question: "Samenvatting van de laatste Kamerbrief over stikstof", dryRun: true });
    expect(res.estimated_sources).toEqual(["tk"]);
    expect(res.planned_requests[0].params).toMatchObject({ query: "stikstof", type: "Brief regering" });
  });
});

describe("nl_gov_ask: the text of the best council document", () => {
  const ALIASES = { ori_delft_20250407054803: { aliases: { ori_delft: {} } } };
  const ORGS = { _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: 1, relation: "eq" }, hits: [{ _index: "ori_delft_20250407054803", _source: { name: "Gemeente Delft", classification: "Municipality" } }] } };
  const hit = (id: string, type: string, title: string) => ({
    _id: id,
    _index: "ori_delft_20250407054803",
    _source: { "@type": type, name: title, last_discussed_at: "2026-06-01T20:00:00+02:00", url: `https://api.openraadsinformatie.nl/v1/resolve/${id}` },
    highlight: { text: [`Passage uit ${title}`] },
  });

  function mockOri(hits: Array<ReturnType<typeof hit>>) {
    mockFetch((url, body) => {
      if (url.hostname !== "api.openraadsinformatie.nl") return undefined;
      if (url.pathname.endsWith("/_aliases")) return jsonResponse(ALIASES);
      if (url.pathname.includes("/_doc/")) {
        return jsonResponse({ _index: "ori_delft_20250407054803", _id: "1731608", found: true, _source: { "@type": "MediaObject", name: "Motie parkeren", md_text: ["De raad verzoekt het college de parkeernorm te verlagen."], text_pages: [{ page_number: 1 }] } });
      }
      if (body?.includes('"Organization"')) return jsonResponse(ORGS);
      return jsonResponse({ _shards: ORGS._shards, hits: { total: { value: hits.length, relation: "eq" }, hits }, aggregations: {} });
    });
  }

  it("adds the text of the best document when the question asks for the content", async () => {
    mockOri([hit("2000001", "AgendaItem", "Agendapunt parkeren"), hit("1731608", "MediaObject", "Motie parkeren")]);
    const res = await ask({ question: "Wat staat er in de motie over parkeren van de gemeente Delft?" });
    expect(res.summary).toBe("Router: Open Raadsinformatie Delft (2 resultaten, bovenste document verdiept)");
    expect(res.records[0].data.text).toContain("parkeernorm te verlagen");
    expect(res.access_note).toContain("ori_document_get (index 'ori_delft', id '1731608')");
  });

  it("says so when no hit is a document, and does not read one for a plain search", async () => {
    mockOri([hit("2000001", "AgendaItem", "Agendapunt parkeren")]);
    const content = await ask({ question: "Wat staat er in de motie over parkeren van de gemeente Delft?" });
    expect(content.access_note).toContain("Geen document onder de treffers");
    clearHttpCache();
    mockOri([hit("1731608", "MediaObject", "Motie parkeren")]);
    const plain = await ask({ question: "Moties over parkeren van de gemeente Delft" });
    expect(plain.summary).toBe("Router: Open Raadsinformatie Delft (1 resultaten)");
    expect(sentTo("api.openraadsinformatie.nl").filter((u) => u.pathname.includes("/_doc/"))).toEqual([]);
  });
});
