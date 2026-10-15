import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { detectSubsidieIntent, narrowSubsidieIntent } from "../src/router/intents.js";
import { rvoStems } from "../src/router/nl-gov-ask.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { setCrawlDelaysEnabled } from "../src/utils/http.js";
import { appCache } from "../src/cache.js";
import { htmlResponse, jsonResponse } from "./helpers/config.js";
import { NOT_THIS_ROUTE, SUBSIDIE_QUESTIONS } from "./helpers/router-corpus.js";
import { RVO_LIST, RVO_ROWS, SWIM_ID, SWIM_NODE, rvoNodePage } from "./helpers/rvo-subsidies-fixtures.js";
import { TOPIC_HIT, searchBody } from "./helpers/eu-funding-fixtures.js";
import { nwoCallPageHtml, nwoListingHtml } from "./helpers/onderzoekscalls-fixtures.js";

/* ------------------------------------------------------------------ */
/*  nl_gov_ask: which subsidies or funding calls exist or are open     */
/*  (RVO, NWO and ZonMw, the EU Funding & Tenders Portal).            */
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
const ask = (args: Record<string, unknown>) => call("nl_gov_ask", args);

beforeEach(() => {
  clearHttpCache();
  // The mocked sites answer at once; nwo.nl's and zonmw.nl's crawl delays would only slow the tests.
  setCrawlDelaysEnabled(false);
  appCache.clear();
  vi.stubEnv("DSO_API_KEY", "");
  vi.stubEnv("OVERHEID_API_KEY", "");
  vi.stubEnv("KNMI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => setCrawlDelaysEnabled(true));

describe("detectSubsidieIntent", () => {
  it("asks RVO for a national subsidy question, with the topic words and the open filter", () => {
    expect(detectSubsidieIntent("Welke subsidies zijn er voor waterstof?")).toMatchObject({ sources: ["rvo_subsidies"], query: "waterstof", openOnly: false });
    expect(detectSubsidieIntent("Welke subsidies staan nu open voor cultureel erfgoed?")).toMatchObject({ sources: ["rvo_subsidies"], query: "cultureel erfgoed", openOnly: true });
    expect(detectSubsidieIntent("Is de DUMAVA-regeling nog open?")).toMatchObject({ sources: ["rvo_subsidies"], query: "dumava" });
    expect(detectSubsidieIntent("Financiering voor mkb-innovatie")).toMatchObject({ sources: ["rvo_subsidies"], query: "innovatie", doelgroep: "mkb" });
    expect(detectSubsidieIntent("Subsidies om zaken te doen in Ghana")).toMatchObject({ sources: ["rvo_subsidies"], query: "", land: "Ghana" });
  });

  it("adds NWO and ZonMw next to RVO for a care or research topic", () => {
    expect(detectSubsidieIntent("Welke subsidies zijn er voor zorginnovatie?")?.sources).toEqual(["rvo_subsidies", "nl_onderzoekscalls"]);
  });

  it("asks NWO or ZonMw when the question names them, and reads the deadline and 'binnenkort'", () => {
    expect(detectSubsidieIntent("NWO call kunstmatige intelligentie deadline")).toMatchObject({ sources: ["nl_onderzoekscalls"], organisatie: "nwo", query: "kunstmatige intelligentie", deadline: true });
    expect(detectSubsidieIntent("Welke ZonMw-subsidies voor dementie openen binnenkort?")).toMatchObject({ sources: ["nl_onderzoekscalls"], organisatie: "zonmw", query: "dementie", soonOnly: true });
    expect(detectSubsidieIntent("Welke Veni-beurzen zijn er?")).toMatchObject({ sources: ["nl_onderzoekscalls"], organisatie: "nwo" });
  });

  it("asks the EU portal in English for an EU question, with the programme and a named call", () => {
    expect(detectSubsidieIntent("open EU calls voor zorginnovatie")).toMatchObject({ sources: ["eu_funding"], euQuery: "healthcare innovation", translated: [["zorginnovatie", "healthcare innovation"]] });
    expect(detectSubsidieIntent("Welke EU-subsidies zijn er voor waterstof?")).toMatchObject({ sources: ["eu_funding"], euQuery: "hydrogen" });
    expect(detectSubsidieIntent("Zijn er Horizon Europe calls over batterijen?")).toMatchObject({ sources: ["eu_funding"], euProgramme: "HORIZON", euQuery: "batteries" });
    expect(detectSubsidieIntent("Europese subsidies voor cultureel erfgoed")).toMatchObject({ euQuery: '"cultural heritage"' });
    expect(detectSubsidieIntent("LIFE-subsidie natuurherstel")).toMatchObject({ euProgramme: "LIFE", euQuery: '"nature restoration"' });
    expect(detectSubsidieIntent("Wanneer sluit de EIC Accelerator?")).toMatchObject({ sources: ["eu_funding"], euQuery: "EIC Accelerator", untranslated: [] });
    expect(detectSubsidieIntent("Wat is het budget en de deadline van HORIZON-CL4-2027-02-MAT-PROD-32-two-stage?")).toMatchObject({ sources: ["eu_funding"], euId: "HORIZON-CL4-2027-02-MAT-PROD-32-two-stage" });
    // A word without a translation goes as it is, and is named.
    expect(detectSubsidieIntent("Europese subsidies voor maatschappelijk vastgoed")?.untranslated).toEqual(["maatschappelijk", "vastgoed"]);
  });

  it("asks the EU portal for a joint undertaking's calls by the words of their identifiers, not its name", () => {
    expect(detectSubsidieIntent("Welke Chips Joint Undertaking calls staan open?")).toMatchObject({
      sources: ["eu_funding"], query: "", euQuery: "chips JU", euJointUndertaking: "chips JU", untranslated: [], openOnly: true,
    });
    expect(detectSubsidieIntent("Welke calls van de Innovative Health Initiative staan open?")).toMatchObject({ sources: ["eu_funding"], euQuery: "IHI JU" });
    expect(detectSubsidieIntent("Wanneer opent de volgende EuroHPC oproep?")).toMatchObject({ sources: ["eu_funding"], euQuery: "EuroHPC JU" });
    expect(detectSubsidieIntent("Clean Hydrogen Partnership calls 2027")?.euQuery).toBe("CLEANH2");
    expect(detectSubsidieIntent("Welke joint undertaking calls staan open?")?.euQuery).toBe("JU");
    // A topic goes after it, in English, and stays when the topic is narrowed.
    expect(detectSubsidieIntent("IHI calls over kanker en dementie")?.euQuery).toBe("IHI JU cancer dementia");
    expect(narrowSubsidieIntent(detectSubsidieIntent("IHI calls over kanker en dementie")!)?.euQuery).toBe("IHI JU dementia");
    // A name that is also a topic or another body only with "JU", "joint undertaking" or "partnership".
    expect(detectSubsidieIntent("Welke EU-subsidies zijn er voor chips?")).toMatchObject({ euQuery: "semiconductors" });
    expect(detectSubsidieIntent("Welke EU-subsidies zijn er voor chips?")?.euJointUndertaking).toBeUndefined();
    expect(detectSubsidieIntent("SNS Bank subsidie")?.sources).toEqual(["rvo_subsidies"]);
    // A call named by its identifier is read.
    expect(detectSubsidieIntent("Wat is de deadline van DIGITAL-JU-CHIPS-2026-AI-GFP?")).toMatchObject({ euId: "DIGITAL-JU-CHIPS-2026-AI-GFP", euQuery: "" });
  });

  it("asks RVO for a regeling named with a step of applying for it, and leaves its legal text to the other routes", () => {
    expect(detectSubsidieIntent("Regeling mbo verduurzamen deadline")).toMatchObject({ sources: ["rvo_subsidies"], query: "mbo verduurzamen", deadline: true });
    expect(detectSubsidieIntent("Wanneer kan ik de Regeling mbo verduurzamen aanvragen?")?.query).toBe("mbo verduurzamen");
    expect(detectSubsidieIntent("Openstelling regeling mbo verduurzamen")?.query).toBe("mbo verduurzamen");
    expect(detectSubsidieIntent("Is de Flex-e subsidie nog open?")).toMatchObject({ sources: ["rvo_subsidies"], query: "flex-e", openOnly: true });
    for (const q of [
      "Tekst van de Regeling mbo verduurzamen", "Tekst van de regeling mbo verduurzamen over de aanvraagperiode", "Wijziging Regeling mbo verduurzamen Staatscourant",
      "Wijziging van de regeling mbo verduurzamen: nieuwe deadline", "Artikel 3 van de Regeling mbo verduurzamen", "Wanneer is de Regeling mbo verduurzamen in werking getreden?",
      "Gemeentelijke regeling verduurzaming aanvragen", "Gemeenschappelijke regeling afvalinzameling deadline", "Wanneer kan ik de regeling aanvragen?", "Regeling aanvragen",
    ]) {
      expect(detectSubsidieIntent(q), q).toBeUndefined();
    }
  });

  it("reads the month of a deadline question as its days, and leaves the month out of the topic", () => {
    const today = "2026-10-15";
    expect(detectSubsidieIntent("Welke Europese oproepen sluiten in november?", today)).toMatchObject({ euQuery: "", deadlineWindow: { from: "2026-11-01", to: "2026-11-30" } });
    expect(detectSubsidieIntent("Welke EU-calls sluiten in maart?", today)?.deadlineWindow).toMatchObject({ from: "2027-03-01", to: "2027-03-31" });
    expect(detectSubsidieIntent("Welke EU-calls sluiten in maart 2028?", today)?.deadlineWindow).toMatchObject({ from: "2028-03-01", to: "2028-03-31" });
    expect(detectSubsidieIntent("Welke EU-calls sluiten voor december?", today)?.deadlineWindow).toMatchObject({ from: today, to: "2026-11-30" });
    expect(detectSubsidieIntent("Welke subsidies sluiten deze maand?", today)?.deadlineWindow).toMatchObject({ from: today, to: "2026-10-31" });
    // Without a deadline word a month is no window.
    expect(detectSubsidieIntent("Europese subsidies voor cultureel erfgoed in november", today)?.deadlineWindow).toBeUndefined();
  });

  it("keeps the topic of a subsidie compound and of a named scheme", () => {
    expect(detectSubsidieIntent("Welke isolatiesubsidies zijn er?")).toMatchObject({ sources: ["rvo_subsidies"], query: "isolatie", euQuery: "insulation" });
    expect(detectSubsidieIntent("energiesubsidie")?.query).toBe("energie");
    expect(detectSubsidieIntent("onderzoekssubsidie dementie")).toMatchObject({ sources: ["nl_onderzoekscalls"], query: "onderzoek dementie" });
    expect(detectSubsidieIntent("Wanneer sluit het Innovatiekrediet?")).toMatchObject({ sources: ["rvo_subsidies"], query: "innovatiekrediet", deadline: true });
    expect(detectSubsidieIntent("Welke subsidies zijn er voor zonne-energie?")?.query).toBe("zonne-energie");
  });

  it("sends EU money for agriculture and farmers to RVO, which runs the GLB", () => {
    expect(detectSubsidieIntent("landbouwsubsidies EU")).toMatchObject({ sources: ["rvo_subsidies"], query: "landbouw" });
    // Without another topic EU money for farmers is the GLB.
    expect(detectSubsidieIntent("Europese subsidies voor boeren")).toMatchObject({ sources: ["rvo_subsidies"], query: "glb", doelgroep: "agrarisch", euSharedFund: true, glbAsTopic: true });
    // With a programme named the EU portal stays.
    expect(detectSubsidieIntent("Horizon Europe calls voor boeren")?.sources).toEqual(["eu_funding"]);
  });

  it("leaves the question-frame words out of the required search words", () => {
    expect(detectSubsidieIntent("Hoe zit het met de subsidie voor de warmtepomp?")?.query).toBe("warmtepomp");
    expect(detectSubsidieIntent("Hoe kom ik aan subsidie voor isolatie?")?.query).toBe("isolatie");
    expect(detectSubsidieIntent("Geeft het Rijk subsidie voor zonnepanelen?")?.query).toBe("zonnepanelen");
  });

  it("reads a programme name with a plus, and LIFE only in capitals or with 'programma'/'subsidie'", () => {
    expect(detectSubsidieIntent("Erasmus+ subsidie voor scholen")).toMatchObject({ sources: ["eu_funding"], euProgramme: "ERASMUS", euQuery: "schools" });
    expect(detectSubsidieIntent("DEI+ waterstof")).toMatchObject({ sources: ["rvo_subsidies"], query: "dei waterstof" });
    expect(detectSubsidieIntent("Wanneer sluit de DEI+?")).toMatchObject({ sources: ["rvo_subsidies"], query: "dei" });
    expect(detectSubsidieIntent("Wat is de SDE++?")?.query).toBe("sde");
    const sciences = detectSubsidieIntent("EU subsidie life sciences");
    expect(sciences?.euProgramme).toBeUndefined();
    expect(sciences?.euQuery).toBe("life sciences");
    expect(detectSubsidieIntent("LIFE programme calls 2027")?.euProgramme).toBe("LIFE");
  });

  it("is no subsidy question without a topic or anything else to select on, or for a register, a legal notion or recipients", () => {
    for (const q of [
      "Welke subsidies zijn er?", "Subsidie voor particulieren", "Wat is een subsidieplafond?", "Subsidieregister 2026", "subsidieregister",
      "subsidievaststelling", "SDE++ budget 2026", "Welke projecten kregen SDE++ subsidie?", "Hoeveel subsidie krijgt de publieke omroep?",
      "Hoeveel bedrijven gebruiken de WBSO?",
    ]) {
      expect(detectSubsidieIntent(q), q).toBeUndefined();
    }
    // A status, a target group or a scheme is enough without a topic; what one can get oneself stays.
    expect(detectSubsidieIntent("Subsidie aanvragen")).toMatchObject({ query: "", openOnly: true });
    expect(detectSubsidieIntent("Is het subsidieplafond van de DUMAVA bereikt?")?.query).toBe("dumava");
    expect(detectSubsidieIntent("Hoeveel subsidie krijg ik voor een warmtepomp?")?.query).toBe("warmtepomp");
    expect(detectSubsidieIntent("Welke subsidie krijgt het mkb voor innovatie?")).toMatchObject({ query: "innovatie", doelgroep: "mkb" });
  });

  it("narrows to a named scheme or the head of the phrase for a second try", () => {
    const narrow = (q: string) => narrowSubsidieIntent(detectSubsidieIntent(q)!);
    expect(narrow("Welke subsidies staan nu open voor cultureel erfgoed?")).toMatchObject({ query: "erfgoed", euQuery: "heritage" });
    expect(narrow("ISDE warmtepomp")?.query).toBe("isde");
    expect(narrow("Is er subsidie voor een elektrische auto?")?.query).toBe("auto");
    expect(narrow("Welke subsidies zijn er voor waterstof?")).toBeUndefined();
  });

  it("recognises every question of the subsidy corpus", () => {
    const missed = Object.values(SUBSIDIE_QUESTIONS).flat().filter((q) => !detectSubsidieIntent(q));
    expect(missed).toEqual([]);
  });

  it("leaves decentral funders, legal texts, parliament, policy, rulings, statistics and reports to the other routes", () => {
    for (const q of NOT_THIS_ROUTE.rvo_subsidies) expect(detectSubsidieIntent(q), q).toBeUndefined();
    for (const q of NOT_THIS_ROUTE.eu_funding) expect(detectSubsidieIntent(q)?.sources ?? [], q).not.toContain("eu_funding");
    for (const q of NOT_THIS_ROUTE.nl_onderzoekscalls) expect(detectSubsidieIntent(q)?.sources ?? [], q).not.toContain("nl_onderzoekscalls");
  });
});

describe("rvoStems", () => {
  it("cuts a long word to a stem RVO finds inside the other forms, and leaves phrases and operators alone", () => {
    expect(rvoStems("verduurzaming maatschappelijk vastgoed")).toBe("verduurzam maatschappelijk vastgoed");
    expect(rvoStems("batterijen")).toBe("batterij");
    expect(rvoStems("woningen isolatie")).toBe("woning isolatie");
    expect(rvoStems("waterstof")).toBe("waterstof");
    expect(rvoStems('"maatschappelijk vastgoed"')).toBe('"maatschappelijk vastgoed"');
    expect(rvoStems("batterijen OR opslag")).toBe("batterijen OR opslag");
  });
});

describe("nl_gov_ask subsidy route", () => {
  it("plans each funder's own request", async () => {
    const rvo = await ask({ question: "Welke subsidies zijn er voor waterstof?", dryRun: true });
    expect(rvo.estimated_sources).toEqual(["rvo_subsidies"]);
    expect(rvo.planned_requests[0]).toMatchObject({ connector: "rvo_subsidies", method: "GET", params: { query: "waterstof", include_status: true } });

    const eu = await ask({ question: "Welke EU-subsidies zijn er voor waterstof?", dryRun: true });
    expect(eu.estimated_sources).toEqual(["eu_funding"]);
    expect(eu.planned_requests[0]).toMatchObject({ connector: "eu_funding", method: "POST" });
    expect(eu.planned_requests[0].params.query).toContain("hydrogen");

    const nwo = await ask({ question: "NWO call kunstmatige intelligentie deadline", dryRun: true });
    expect(nwo.estimated_sources).toEqual(["nl_onderzoekscalls"]);
    expect(nwo.planned_requests.map((r: { connector: string }) => r.connector)).toEqual(["nwo_calls"]);
    expect(nwo.planned_requests[0].params).toMatchObject({ input: "kunstmatige intelligentie" });

    const both = await ask({ question: "Welke subsidies zijn er voor zorginnovatie?", dryRun: true });
    expect(both.estimated_sources).toEqual(["rvo_subsidies", "nl_onderzoekscalls"]);

    const ju = await ask({ question: "Welke Chips Joint Undertaking calls staan open?", dryRun: true });
    expect(ju.estimated_sources).toEqual(["eu_funding"]);
    expect(ju.planned_requests[0].params.query).toContain('"query":"chips JU"');

    const regeling = await ask({ question: "Regeling mbo verduurzamen deadline", dryRun: true });
    expect(regeling.planned_requests[0]).toMatchObject({ connector: "rvo_subsidies", params: { query: "mbo verduurzam" } });
  });

  it("answers from RVO with the status as rvo.nl shows it and names the coverage", async () => {
    const swim = RVO_ROWS.find((r) => r.id === SWIM_ID)!;
    const swimPath = String(swim.url);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (`${url.origin}${url.pathname}` === RVO_LIST) {
        const page = Number(url.searchParams.get("page"));
        return jsonResponse(RVO_ROWS.slice(page * 50, page * 50 + 50));
      }
      if (url.hostname === "www.rvo.nl" && url.pathname === swimPath) return htmlResponse(rvoNodePage(swimPath, SWIM_ID, SWIM_NODE));
      if (url.hostname === "www.rvo.nl") return htmlResponse("<html><body>Pagina niet gevonden</body></html>", 404);
      return new Response("not found", { status: 404 });
    }));
    const res = await ask({ question: "Welke subsidies zijn er voor waterstof?", top: 5 });
    expect(res.summary).toMatch(/^Router: subsidies — \d+ pagina's over subsidies en financiering van RVO voor 'waterstof'/);
    expect(res.records.length).toBeGreaterThan(0);
    expect(res.records.every((r: { source_name: string }) => r.source_name === "rvo")).toBe(true);
    const swimRecord = res.records.find((r: { data: { id: string } }) => r.data.id === SWIM_ID);
    expect(swimRecord.data.status_info.status_label).toBeTruthy();
    expect(res.access_note).toContain("gezocht bij RVO (trefwoorden 'waterstof')");
    expect(res.access_note).toContain("gemeentelijke, provinciale en waterschapsregelingen staan in CVDR");
  });

  it("reads a plus in the question as part of a programme name, not as a space", async () => {
    expect((await ask({ question: "Erasmus+ subsidie voor scholen", dryRun: true })).estimated_sources).toEqual(["eu_funding"]);
    expect((await ask({ question: "Wanneer sluit de DEI+?", dryRun: true })).planned_requests[0]).toMatchObject({ connector: "rvo_subsidies", params: { query: "dei" } });
    // Without spaces a plus is still a form-encoded space.
    expect((await ask({ question: "welke+subsidies+zijn+er+voor+waterstof", dryRun: true })).planned_requests[0]).toMatchObject({ connector: "rvo_subsidies", params: { query: "waterstof" } });
  });

  it("searches once more with only the most specific word when all words together find nothing", async () => {
    const swimPath = String(RVO_ROWS.find((r) => r.id === SWIM_ID)!.url);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (`${url.origin}${url.pathname}` === RVO_LIST) {
        const page = Number(url.searchParams.get("page"));
        return jsonResponse(RVO_ROWS.slice(page * 50, page * 50 + 50));
      }
      if (url.hostname === "www.rvo.nl" && url.pathname === swimPath) return htmlResponse(rvoNodePage(swimPath, SWIM_ID, SWIM_NODE));
      return new Response("not found", { status: 404 });
    }));
    const res = await ask({ question: "Welke subsidies zijn er voor oranje waterstof?", top: 5 });
    expect(res.summary).toMatch(/^Router: subsidies — \d+ pagina's over subsidies en financiering van RVO voor 'waterstof'/);
    expect(res.access_note).toContain("gezocht bij RVO (trefwoorden 'oranje waterstof', daarna alleen 'waterstof')");
    expect(res.access_note).toContain("Met alle trefwoorden samen ('oranje waterstof') niets gevonden; daarom gezocht op 'waterstof' alleen.");
  });

  it("gives an NWO call's first closing date still ahead, with the full application after it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "www.nwo.nl" && url.pathname === "/calls") {
        return htmlResponse(nwoListingHtml({ cards: [{ href: "/calls/vroegdiagnostiek", title: "Vroegdiagnostiek", status: "Open voor intentieverklaring", budget: "&euro;1.500.000" }] }));
      }
      if (url.hostname === "www.nwo.nl" && url.pathname === "/calls/vroegdiagnostiek") {
        return htmlResponse(nwoCallPageHtml({
          title: "Vroegdiagnostiek",
          statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "62163", label: "Open voor intentieverklaring" }],
          // Far ahead: the source compares against the real clock.
          dates: [
            { label: "Sluitingsdatum intentieverklaring", iso: "2098-11-17T13:00:00Z", text: "17 november 2098" },
            { label: "Sluitingsdatum volledige aanvraag", iso: "2099-03-30T12:00:00Z", text: "30 maart 2099" },
          ],
        }));
      }
      return new Response("not found", { status: 404 });
    }));
    const res = await ask({ question: "NWO call vroegdiagnostiek deadline", top: 5 });
    expect(res.records[0]).toMatchObject({ source_name: "nwo", date: "2098-11-17" });
    expect(res.records[0].data.deadline_text).toBe("17 november 2098 14:00 uur (Sluitingsdatum intentieverklaring; daarna Sluitingsdatum volledige aanvraag 30 maart 2099 14:00 uur)");
    expect(res.access_note).toContain("Bij één call sluit eerst een eerdere stap (intentieverklaring of vooraanmelding)");
  });

  it("answers from the EU portal with the English search words named", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "api.tech.ec.europa.eu") return jsonResponse(searchBody([TOPIC_HIT], 1));
      return new Response("not found", { status: 404 });
    }));
    const res = await ask({ question: "Welke EU-subsidies zijn er voor waterstof?", top: 5 });
    expect(res.summary).toMatch(/^Router: subsidies — .*EU-oproepen/);
    expect(res.records[0]).toMatchObject({ source_name: "eu_funding", data: { id: "HORIZON-CL4-2027-02-MAT-PROD-32-two-stage" } });
    expect(res.access_note).toContain("gezocht op 'hydrogen' (vertaald: waterstof → hydrogen)");
  });

  it("hands the question on when the funder fails, and says it was asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "api.tech.ec.europa.eu") return new Response("upstream down", { status: 500 });
      if (url.hostname === "data.overheid.nl") return jsonResponse({ success: true, result: { count: 0, results: [] } });
      return new Response("not found", { status: 404 });
    }));
    const res = await ask({ question: "Welke EU-subsidies zijn er voor waterstof?", top: 5 });
    expect(res.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(res.access_note).toContain("Eerst gezocht naar subsidies en calls bij het EU Funding & Tenders Portal");
    expect(res.access_note).toContain("mislukt");
    expect(res.failures?.map((f: { connector: string }) => f.connector)).toContain("eu_funding");
  });
});
