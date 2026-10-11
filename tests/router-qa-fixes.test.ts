import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { detectEcliIntent, detectEuIntent, detectResearchOrgIntent, detectWetArtikelIntent, extractPopulationPlace, extractPopulationYear } from "../src/router/intents.js";
import { parseTemporalRange } from "../src/utils/temporal.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { appCache } from "../src/cache.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  The QA round on the round-three routes: a Kamerbrief of a named    */
/*  minister, research bodies and ECLIs next to another source, the    */
/*  population words and years, law articles in other spellings, the   */
/*  KNMI route with its key, and CBS tables that are CBS's.            */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get(name)!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}
const REFERENCE_NOW = "2026-10-06T10:00:00+02:00";
const ask = (args: Record<string, unknown>) => call("nl_gov_ask", { reference_now: REFERENCE_NOW, ...args });

let requests: URL[] = [];
const sentTo = (host: string, path = "") => requests.filter((u) => u.hostname === host && u.pathname.startsWith(path));

/** fetch answered per request by `route`; anything it does not answer is a 404. */
function mockFetch(route: (url: URL) => Response | undefined) {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url);
    return route(url) ?? new Response("not found", { status: 404 });
  }));
}

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

describe("nl_gov_ask: a Tweede Kamer paper of a named office holder", () => {
  it("searches the Tweede Kamer alone, with the document type and without the office holder", async () => {
    const letter = await ask({ question: "Kamerbrief over stikstof van de minister", dryRun: true });
    expect(letter.estimated_sources).toEqual(["tk"]);
    expect(letter.planned_requests[0].params).toMatchObject({ query: "stikstof", type: "Brief regering" });
    const cabinet = await ask({ question: "Kamerbrieven van het kabinet over asiel", dryRun: true });
    expect(cabinet.planned_requests[0].params).toMatchObject({ query: "asiel", type: "Brief regering" });
    const questions = await ask({ question: "Kamervragen aan de staatssecretaris over toeslagen", dryRun: true });
    expect(questions.estimated_sources).toEqual(["tk"]);
    expect(questions.planned_requests[0].params).toMatchObject({ query: "toeslagen", type: "Schriftelijke vragen" });
  });

  it("reads a staatssecretaris the paper is about, or a letter to the Kamer without the word Kamerbrief, the same way", async () => {
    const motion = await ask({ question: "Motie over de staatssecretaris van Financiën", dryRun: true });
    expect(motion.estimated_sources).toEqual(["tk"]);
    expect(motion.planned_requests[0].params).toMatchObject({ type: "Motie" });
    const letter = await ask({ question: "Brief van de staatssecretaris aan de Tweede Kamer over toeslagen", dryRun: true });
    expect(letter.estimated_sources).toEqual(["tk"]);
    // Without a Kamer it is sent to, a brief of the staatssecretaris is Rijksoverheid's too.
    const plain = await ask({ question: "Brief van de staatssecretaris over toeslagen", dryRun: true });
    expect(plain.estimated_sources).toContain("rijk");
  });

  it("filters the Tweede Kamer on the letter type when it executes", async () => {
    mockFetch((url) => (url.hostname === "gegevensmagazijn.tweedekamer.nl" ? jsonResponse({ value: [] }) : url.hostname === "data.overheid.nl" ? jsonResponse(EMPTY_CKAN) : undefined));
    await ask({ question: "Kamerbrief over stikstof van de minister" });
    const tk = sentTo("gegevensmagazijn.tweedekamer.nl");
    expect(tk.length).toBeGreaterThan(0);
    expect(decodeURIComponent(tk[0].href).replace(/\+/g, " ")).toContain("contains(Soort,'Brief regering')");
    // Not side by side with Rijksoverheid: the Tweede Kamer first, Rijksoverheid only after it found nothing.
    expect(requests[0].hostname).toBe("gegevensmagazijn.tweedekamer.nl");
  });

  it("still asks Rijksoverheid when the minister is the one speaking, and keeps the type in the multi-source search", async () => {
    const res = await ask({ question: "Welke moties zijn er over stikstof aangenomen en wat zegt de minister?", dryRun: true });
    expect(res.estimated_sources).toEqual(["tk", "rijk"]);
    expect(res.planned_requests[0].params).toMatchObject({ query: "stikstof", type: "Motie" });
  });
});

describe("research bodies and ECLIs named next to another source", () => {
  it("leaves the research routes when another source is named", () => {
    for (const question of [
      "Wat zegt de Rekenkamer en wat besliste de Tweede Kamer over Defensie?",
      "Aanbesteding van het SCP voor onderzoek",
      "Welke API heeft het WODC?",
      "Algoritmeregister van het WODC",
      "SCP-bestand downloaden",
    ]) expect(detectResearchOrgIntent(question), question).toBeUndefined();
    expect(detectResearchOrgIntent("Wat zegt het SCP over eenzaamheid?")?.org).toBe("scp");
  });

  it("does not read the ruling for Kamervragen about it, nor take the ECLI's numbers for a period", async () => {
    expect(detectEcliIntent("Kamervragen over ECLI:NL:HR:2019:2006")).toBeUndefined();
    expect(parseTemporalRange("Kamervragen over ECLI:NL:HR:2019:2006", { now: REFERENCE_NOW, timeZone: "Europe/Amsterdam" })).toBeUndefined();
    expect(parseTemporalRange("Wat is Verordening (EU) 2016/679?", { now: REFERENCE_NOW, timeZone: "Europe/Amsterdam" })).toBeUndefined();
    expect(parseTemporalRange("Kamervragen in 2019", { now: REFERENCE_NOW, timeZone: "Europe/Amsterdam" })?.from).toBe("2019-01-01");
    const res = await ask({ question: "Kamervragen over ECLI:NL:HR:2019:2006", dryRun: true });
    expect(res.estimated_sources).toEqual(["tk"]);
    // The ECLI whole, not its parts: "ecli" alone found Kamervragen about other rulings.
    expect(res.planned_requests[0].params).toMatchObject({ query: "ECLI:NL:HR:2019:2006", type: "Schriftelijke vragen" });
    expect(res.planned_requests[0].params.date_from).toBeUndefined();
  });

  it("reads the ruling a citation question names and points to LiDO for what cites it", async () => {
    expect(detectEcliIntent("Uitspraken die verwijzen naar ECLI:NL:HR:2019:2006")).toMatchObject({ eclis: ["ECLI:NL:HR:2019:2006"], citations: true });
    mockFetch(() => new Response("Not found", { status: 404 }));
    const xml = `<?xml version="1.0" encoding="utf-8"?><open-rechtspraak><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:Description><dcterms:identifier>ECLI:NL:HR:2019:2006</dcterms:identifier><dcterms:date>2019-12-20</dcterms:date></rdf:Description></rdf:RDF><uitspraak xmlns="http://www.rechtspraak.nl/schema/rechtspraak-1.0"><section role="beslissing"><para>De Hoge Raad verwerpt het beroep.</para></section></uitspraak></open-rechtspraak>`;
    mockFetch((url) => (url.pathname === "/uitspraken/content" ? xmlResponse(xml) : undefined));
    const res = await ask({ question: "Uitspraken die verwijzen naar ECLI:NL:HR:2019:2006" });
    expect(res.summary).toMatch(/^Router: Rechtspraak uitspraak/);
    expect(res.access_note).toContain("lido_verwijzingen_lijst (id ECLI:NL:HR:2019:2006");
  });
});

/* ------------------------------------------------------------------ */
/*  The population route                                               */
/* ------------------------------------------------------------------ */

const REGIOS = [
  { Key: "NL01  ", Title: "Nederland" },
  { Key: "PV21  ", Title: "Fryslân (PV)" },
  { Key: "PV26  ", Title: "Utrecht (PV)" },
  { Key: "GM0268", Title: "Nijmegen" },
  { Key: "GM0344", Title: "Utrecht (gemeente)" },
  { Key: "GM0457", Title: "Weesp" },
];
const row = (code: string, periode: string, op1jan: number, gem: number | null = null) => ({ RegioS: code, Perioden: periode, BevolkingOp1Januari_1: op1jan, GemiddeldeBevolking_2: gem });
const DATA = [
  row("NL01  ", "2025JJ00", 18044027, 18100000), row("NL01  ", "2026JJ00", 18150000),
  row("PV21  ", "2026JJ00", 660000),
  row("PV26  ", "2026JJ00", 1400000),
  row("GM0268", "1988JJ00", 145000, 145200), row("GM0268", "2025JJ00", 189007, 189439), row("GM0268", "2026JJ00", 189871),
  row("GM0344", "2026JJ00", 374000),
  // Part of Amsterdam since 2022: no figure after its last 1 January.
  row("GM0457", "2021JJ00", 20500, 20600), row("GM0457", "2022JJ00", 20766, 20800),
];

function mockPopulation(tables: Array<Record<string, unknown>> = []) {
  mockFetch((url) => {
    if (url.hostname === "data.overheid.nl") return jsonResponse(EMPTY_CKAN);
    if (!url.hostname.endsWith("cbs.nl")) return undefined;
    if (url.pathname.endsWith("/03759ned/RegioS")) return jsonResponse({ value: REGIOS });
    if (url.pathname.endsWith("/03759ned/TypedDataSet")) {
      const filter = url.searchParams.get("$filter") ?? "";
      return jsonResponse({ value: DATA.filter((r) => filter.includes(`'${r.RegioS}'`)) });
    }
    if (url.pathname.endsWith("/Datasets")) return jsonResponse({ value: tables });
    return undefined;
  });
}

describe("extractPopulationPlace and extractPopulationYear", () => {
  it("reads the place from the population words without a question word", () => {
    expect(extractPopulationPlace("inwonertal van Nijmegen")).toBe("Nijmegen");
    expect(extractPopulationPlace("inwoneraantal Utrecht")).toBe("Utrecht");
    expect(extractPopulationPlace("Bevolking van Zwolle in 2023")).toBe("Zwolle");
    expect(extractPopulationPlace("inwoners Amsterdam")).toBe("Amsterdam");
    expect(extractPopulationPlace("Aantal inwoners Delft 2015")).toBe("Delft");
    expect(extractPopulationPlace("Inwoners van Utrecht over de nieuwe wijk")).toBeUndefined();
    expect(extractPopulationPlace(`Hoeveel inwoners heeft ${"Nijmegen ".repeat(60)}?`)).toBeUndefined();
  });

  it("reads a year also outside the parser's range", () => {
    expect(extractPopulationYear("Hoeveel inwoners had Nijmegen in 1800?")).toBe(1800);
    expect(extractPopulationYear("Aantal inwoners Delft 2015")).toBe(2015);
    expect(extractPopulationYear("Hoeveel inwoners heeft Nijmegen?")).toBeUndefined();
  });
});

describe("nl_gov_ask: the population of a place", () => {
  it("routes the population words to the table", async () => {
    for (const [question, gemeente] of [["inwonertal van Nijmegen", "Nijmegen"], ["Bevolking van Zwolle in 2023", "Zwolle"], ["inwoners Amsterdam", "Amsterdam"]]) {
      const res = await ask({ question, dryRun: true });
      expect(res.estimated_sources, question).toEqual(["cbs"]);
      expect(res.planned_requests[0].params, question).toMatchObject({ gemeente });
    }
    const year = await ask({ question: "Aantal inwoners Delft 2015", dryRun: true });
    expect(year.planned_requests[0].params).toMatchObject({ gemeente: "Delft", jaar: 2015 });
  });

  it("says a year the table does not have, instead of answering the newest as if it were that year", async () => {
    mockPopulation();
    const res = await ask({ question: "Hoeveel inwoners had Nijmegen in 1800?" });
    expect(res.summary).toBe("Router: CBS bevolking — Nijmegen: geen cijfer voor 1800 (tabel 1988–2026); recentste: 189.871 inwoners op 1 januari 2026");
    expect(res.access_note).toContain("Voor 1800 heeft de tabel geen cijfer voor Nijmegen");
  });

  it("says that a former municipality is no municipality anymore", async () => {
    mockPopulation();
    const res = await ask({ question: "Hoeveel inwoners heeft Weesp?" });
    expect(res.summary).toBe("Router: CBS bevolking — Weesp (opgeheven gemeente): 20.766 inwoners op 1 januari 2022 (laatste cijfer)");
    expect(res.access_note).toContain("Weesp is geen gemeente meer: de tabel heeft cijfers t/m 1 januari 2022 en loopt tot 2026");
  });

  it("answers the country and a province from the same table, and a municipality before a province", async () => {
    mockPopulation();
    const nl = await ask({ question: "Hoeveel inwoners heeft Nederland?" });
    expect(nl.summary).toBe("Router: CBS bevolking — Nederland: 18.150.000 inwoners op 1 januari 2026");
    expect(nl.records[0].data).toMatchObject({ regiocode: "NL01", niveau: "land" });
    appCache.clear();
    const friesland = await ask({ question: "Hoeveel inwoners heeft Friesland?" });
    expect(friesland.summary).toBe("Router: CBS bevolking — Fryslân: 660.000 inwoners op 1 januari 2026");
    expect(friesland.access_note).toContain("provincie Fryslân");
    appCache.clear();
    const utrecht = await ask({ question: "Hoeveel inwoners heeft Utrecht?" });
    expect(utrecht.summary).toBe("Router: CBS bevolking — Utrecht: 374.000 inwoners op 1 januari 2026");
    expect(utrecht.records[0].data.gemeentecode).toBe("GM0344");
  });

  it("says so when no municipality has the name, before the tables the other words found", async () => {
    mockPopulation([{ Identifier: "85618NED", Title: "Bevolking; kerncijfers" }]);
    const res = await ask({ question: "Hoeveel inwoners heeft Amsterdam-Noord?" });
    expect(res.summary).toBe("Router: CBS (1 resultaten; geen aantal inwoners voor 'Amsterdam-Noord')");
    expect(res.access_note).toContain("Geen aantal inwoners gegeven: 'Amsterdam-Noord' is geen gemeente, provincie of 'Nederland'");
  });
});

/* ------------------------------------------------------------------ */
/*  Law articles                                                       */
/* ------------------------------------------------------------------ */

describe("detectWetArtikelIntent: other spellings, counts, days and topics", () => {
  it("reads an artikel in capitals, in English and after a lowercase 'wet'", () => {
    expect(detectWetArtikelIntent("ARTIKEL 3:4 AWB")).toEqual({ wet: "AWB", artikel: "3:4" });
    expect(detectWetArtikelIntent("article 3:4 Awb")).toEqual({ wet: "Awb", artikel: "3:4" });
    expect(detectWetArtikelIntent("artikel 3 van de wet Bibob")).toEqual({ wet: "wet Bibob", artikel: "3" });
    expect(detectWetArtikelIntent("artikel 2 van de wet op de jeugdzorg")).toEqual({ wet: "wet op de jeugdzorg", artikel: "2" });
    expect(detectWetArtikelIntent("In artikel 12 van de wet staat iets")).toBeUndefined();
  });

  it("leaves a count of cases under an artikel to the statistics, not the law's text", () => {
    expect(detectWetArtikelIntent("Hoeveel boetes zijn er uitgedeeld op grond van artikel 5 WVW?")).toBeUndefined();
    expect(detectWetArtikelIntent("Hoeveel dagen is de bezwaartermijn volgens artikel 6:7 Awb?")).toEqual({ wet: "Awb", artikel: "6:7" });
  });

  it("names a day that does not exist instead of dropping it", () => {
    expect(detectWetArtikelIntent("artikel 3:4 Awb op 31 februari 2020")).toEqual({ wet: "Awb", artikel: "3:4", peildatumOngeldig: "op 31 februari 2020" });
  });

  it("reads a law and a topic, without a relative clause or its year", () => {
    expect(detectWetArtikelIntent("Welke artikelen van de Participatiewet gaan over de kostendelersnorm die in 2015 werd ingevoerd?")).toEqual({ wet: "Participatiewet", zoekterm: "kostendelersnorm" });
    expect(detectWetArtikelIntent("Welke artikelen van de Participatiewet gaan over de kostendelersnorm in 2015?")).toMatchObject({ zoekterm: "kostendelersnorm", peildatum: "2015-01-01" });
    expect(detectWetArtikelIntent("Wat staat er in de Gemeentewet over de burgemeester?")).toEqual({ wet: "Gemeentewet", zoekterm: "burgemeester" });
    expect(detectWetArtikelIntent("Wat zegt de Woningwet over woningcorporaties?")).toEqual({ wet: "Woningwet", zoekterm: "woningcorporaties" });
    expect(detectWetArtikelIntent("Wat zegt de Omgevingswet over de regels in Rotterdam?")).toBeUndefined();
  });
});

describe("nl_gov_ask: the day of a law's text", () => {
  it("takes the first day of a relative period, and names it", async () => {
    const res = await ask({ question: "Wat zei artikel 3:4 Awb vorig jaar?", dryRun: true });
    expect(res.estimated_sources).toEqual(["wetten_bwb"]);
    expect(res.planned_requests[0].params).toMatchObject({ wet: "Awb", artikel: "3:4", peildatum: "2025-01-01" });
    expect((await ask({ question: "Artikel 2.1 Wmo 2015", dryRun: true })).planned_requests[0].params.peildatum).toBeUndefined();
  });

  it("says a day that does not exist was not applied", async () => {
    mockFetch((url) => (url.hostname === "zoekservice.overheid.nl" ? xmlResponse('<?xml version="1.0"?><searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><numberOfRecords>0</numberOfRecords></searchRetrieveResponse>') : url.hostname === "data.overheid.nl" ? jsonResponse(EMPTY_CKAN) : undefined));
    const res = await ask({ question: "artikel 3 van de Fantasiewet op 31 februari 2020" });
    expect(res.access_note).toContain("geen peildatum: 'op 31 februari 2020' bestaat niet");
  });
});

/* ------------------------------------------------------------------ */
/*  Named EU acts, the ORI content words and the question's length     */
/* ------------------------------------------------------------------ */

describe("detectEuIntent: an EU act by its name", () => {
  it("knows the AVG and the nature and water directives by name", () => {
    expect(detectEuIntent("Wat zegt de AVG over het verwerkingsregister?")).toEqual({ kind: "document", celex: "32016R0679" });
    expect(detectEuIntent("Hoe is de Kaderrichtlijn Water in Nederland omgezet?")).toEqual({ kind: "transposition", celex: "32000L0060" });
    expect(detectEuIntent("Wat is de Europese Habitatrichtlijn?")).toEqual({ kind: "document", celex: "31992L0043" });
  });

  it("leaves documents about the act to their own routes", () => {
    for (const question of ["Uitspraken over de AVG", "Wat zegt de minister over de AVG?", "Kamervragen over de Habitatrichtlijn", "Boetes van de Autoriteit Persoonsgegevens op grond van de AVG"]) {
      expect(detectEuIntent(question), question).toBeUndefined();
    }
  });
});

describe("nl_gov_ask: the words that ask for a council document's content", () => {
  it("are no search words", async () => {
    const res = await ask({ question: "Wat heeft de gemeenteraad van Utrecht besloten over parkeren? Vat samen wat erin staat", dryRun: true });
    expect(res.estimated_sources).toEqual(["ori"]);
    expect(res.planned_requests[0].params.query).toBe("besloten parkeren");
  });
});

describe("nl_gov_ask: the question itself", () => {
  it("rejects an empty question and one longer than 2000 characters", () => {
    const schema = tools.get("nl_gov_ask")!.schema.question;
    expect(() => schema.parse("")).toThrow(/leeg/);
    expect(() => schema.parse("a".repeat(2001))).toThrow(/te lang: maximaal 2000 tekens/);
    expect(schema.parse("a".repeat(2000))).toHaveLength(2000);
  });
});

/* ------------------------------------------------------------------ */
/*  KNMI with its key                                                   */
/* ------------------------------------------------------------------ */

describe("nl_gov_ask: the KNMI route", () => {
  const FILES = { files: [{ filename: "KMDS__OPER_P___10M_OBS_L2_202610061000.nc", size: 100, lastModified: "2026-10-06T10:05:00Z" }, { filename: "KMDS__OPER_P___10M_OBS_L2_202610060950.nc", size: 100, lastModified: "2026-10-06T09:55:00Z" }] };

  it("answers that it needs its key without one, and plans no request", async () => {
    const plan = await ask({ question: "Wat was de temperatuur in De Bilt gisteren?", dryRun: true });
    expect(plan.estimated_sources).toEqual(["knmi"]);
    expect(plan.planned_requests).toEqual([]);
    mockFetch(() => undefined);
    const res = await ask({ question: "Wat was de temperatuur in De Bilt gisteren?" });
    expect(res.error).toBe("not_configured");
    expect(requests).toEqual([]);
  });

  it("reads the newest observation files with the key, as planned", async () => {
    vi.stubEnv("KNMI_API_KEY", "test-key");
    const plan = await ask({ question: "Wat was de temperatuur in De Bilt gisteren?", dryRun: true });
    expect(plan.planned_requests[0].url).toBe("https://api.dataplatform.knmi.nl/open-data/v1/datasets/10-minute-in-situ-meteorological-observations/versions/1.0/files");
    mockFetch((url) => (url.hostname === "api.dataplatform.knmi.nl" ? jsonResponse(FILES) : undefined));
    const res = await ask({ question: "Wat was de temperatuur in De Bilt gisteren?" });
    expect(res.summary).toBe("Router: KNMI waarnemingen (2 bestanden)");
    expect(res.access_note).toContain("geen uitgelezen meetwaarden");
    expect(sentTo("api.dataplatform.knmi.nl")[0].pathname).toBe("/open-data/v1/datasets/10-minute-in-situ-meteorological-observations/versions/1.0/files");
  });

  it("reads the warnings for a warning question", async () => {
    vi.stubEnv("KNMI_API_KEY", "test-key");
    const plan = await ask({ question: "Code oranje van het KNMI", dryRun: true });
    expect(plan.planned_requests[0].url).toContain("/datasets/waarschuwingen_nederland_48h/versions/1.0/files");
    mockFetch((url) => (url.hostname === "api.dataplatform.knmi.nl" ? jsonResponse({ files: [{ filename: "waarschuwingen_202610061000.xml" }] }) : undefined));
    const res = await ask({ question: "Code oranje van het KNMI" });
    expect(res.summary).toBe("Router: KNMI waarschuwingen (1 bestanden)");
    expect(sentTo("api.dataplatform.knmi.nl")[0].pathname).toContain("/waarschuwingen_nederland_48h/");
  });

  it("reports a KNMI rate limit as a failure, not as 0 earthquakes", async () => {
    vi.stubEnv("KNMI_API_KEY", "test-key");
    const plan = await ask({ question: "Aardbevingen Groningen recent", dryRun: true });
    expect(plan.planned_requests[0].params).toMatchObject({ orderBy: "created", sorting: "desc" });
    mockFetch((url) =>
      url.hostname === "api.dataplatform.knmi.nl"
        ? new Response(JSON.stringify({ error: "Rate Limit Exceeded" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
        : url.hostname === "data.overheid.nl"
          ? jsonResponse({ success: true, result: { count: 0, results: [] } })
          : undefined);
    const res = await ask({ question: "Aardbevingen Groningen recent" });
    expect(res.summary ?? "").not.toContain("KNMI aardbevingen (0");
    expect((res.failures ?? []).map((f: { connector: string }) => f.connector)).toContain("knmi");
    expect(new Set(sentTo("api.dataplatform.knmi.nl").map((u: URL) => u.pathname.split("/")[4]))).toEqual(new Set(["aardbevingen_nederland"]));
    expect(sentTo("api.dataplatform.knmi.nl")[0].searchParams.get("sorting")).toBe("desc");
  });
});

/* ------------------------------------------------------------------ */
/*  cbs_tables_search                                                   */
/* ------------------------------------------------------------------ */

describe("cbs_tables_search", () => {
  it("links each table to its own StatLine page", async () => {
    mockFetch((url) => (url.hostname.endsWith("cbs.nl") && url.pathname.endsWith("/Datasets") ? jsonResponse({ value: [{ Identifier: "03759ned", Title: "Bevolking op 1 januari en gemiddeld" }] }) : undefined));
    const res = await call("cbs_tables_search", { query: "bevolking" });
    expect(res.records[0].canonical_url).toBe("https://opendata.cbs.nl/#/CBS/nl/dataset/03759ned");
  });

  it("returns only datasets CBS published from the data.overheid.nl fallback", async () => {
    mockFetch((url) => {
      if (url.hostname.endsWith("cbs.nl")) return jsonResponse({ value: [] });
      if (url.hostname !== "data.overheid.nl") return undefined;
      if (url.searchParams.get("fq")) return jsonResponse(EMPTY_CKAN);
      return jsonResponse({ success: true, result: { count: 2, results: [
        { id: "afval-1", title: "De afvalkalender", organization: { name: "afvalbedrijf", title: "Afvalbedrijf" } },
        { id: "cbs-1", title: "Bevolking; kerncijfers", organization: { name: "centraal-bureau-voor-de-statistiek", title: "CBS OpenData" } },
      ] } });
    });
    const res = await call("cbs_tables_search", { query: "afvalkalender bevolking" });
    expect(res.records.map((r: any) => r.title)).toEqual(["Bevolking; kerncijfers"]);
    expect(res.records[0].canonical_url).toBe("https://data.overheid.nl/dataset/cbs-1");
    expect(sentTo("data.overheid.nl")[0].searchParams.get("fq")).toBe("organization:centraal-bureau-voor-de-statistiek");
  });

  it("searches the v3 table catalogue when v4 fails", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/Datasets")) return new Response("kapot", { status: 500 });
      if (url.pathname === "/ODataCatalog/Tables") return jsonResponse({ value: [{ Identifier: "37296ned", Title: "Bevolking; kerncijfers" }] });
      return undefined;
    });
    const res = await call("cbs_tables_search", { query: "bevolking" });
    expect(res.records[0].canonical_url).toBe("https://opendata.cbs.nl/#/CBS/nl/dataset/37296ned");
  }, 20_000);
});
