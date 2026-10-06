import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectDsoIntent, registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { appCache } from "../src/cache.js";
import { clearDsoCaches, DsoInputError, DsoOmgevingsdocumentenSource, type DsoSearchItem, type DsoSearchResult } from "../src/sources/dso-omgevingsdocumenten.js";
import { SourceRequestError } from "../src/utils/http.js";
import { jsonResponse } from "./helpers/config.js";

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

const plan = (question: string) => ask({ question, dryRun: true });

const GEMEENTE = "Welke omgevingsdocumenten heeft de gemeente Utrecht?";
const ADRES = "Welke regels gelden er op Brennerbaan 150 in Utrecht onder de Omgevingswet?";
const VISIE = "Wat is de omgevingsvisie van de provincie Utrecht?";
const VERGUNNING = "Welke omgevingsvergunningen zijn er recent verleend in Utrecht?";
const BESTEMMINGSPLAN = "Welk bestemmingsplan geldt er voor Brennerbaan 150 in Utrecht?";
const INWONERS = "Hoeveel inwoners heeft Utrecht?";

const DSO = "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";

describe("detectDsoIntent", () => {
  it("reads the bevoegd gezag, the address and the kind of document", () => {
    expect(detectDsoIntent(GEMEENTE)).toEqual({ bevoegdGezag: "gemeente Utrecht" });
    expect(detectDsoIntent(ADRES)).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent(VISIE)).toEqual({ bevoegdGezag: "provincie Utrecht", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Wat staat er in de waterschapsverordening van Hoogheemraadschap De Stichtse Rijnlanden?")).toEqual({
      bevoegdGezag: "Hoogheemraadschap De Stichtse Rijnlanden",
      documentType: "waterschapsverordening",
    });
    expect(detectDsoIntent("Welk omgevingsplan geldt op 3524 BN 150?")).toEqual({ locatie: "3524 BN 150", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Is er een voorbereidingsbesluit in Utrecht?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "voorbereidingsbesluit" });
  });

  it("asks for ontwerpregelingen for 'ontwerp' and 'ter inzage'", () => {
    expect(detectDsoIntent("Welke ontwerp-omgevingsplannen liggen er nu ter inzage?")).toEqual({
      documentType: "omgevingsplan",
      soort: "ontwerpregelingen",
      alleenTerInzage: true,
    });
    expect(detectDsoIntent("Is er een ontwerp van de omgevingsverordening van de provincie Utrecht?")).toEqual({
      bevoegdGezag: "provincie Utrecht",
      documentType: "omgevingsverordening",
      soort: "ontwerpregelingen",
    });
  });

  it("takes a layer from a plural without a name, and no bevoegd gezag from 'in Nederland'", () => {
    expect(detectDsoIntent("Welke provincies hebben een omgevingsverordening?")).toEqual({ typeBevoegdGezag: "provincie", documentType: "omgevingsverordening" });
    expect(detectDsoIntent("Hoeveel omgevingsvisies zijn er in Nederland?")).toEqual({ documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Wat regelt de Omgevingswet in Nederland?")).toBeUndefined();
  });

  it("leaves permits, bestemmingsplannen, council and parliamentary questions alone", () => {
    for (const question of [
      VERGUNNING,
      "Welke vigerende bestemmingsplannen lopen er in Groningen?",
      BESTEMMINGSPLAN,
      INWONERS,
      "Wat heeft de gemeenteraad van Utrecht besloten over het omgevingsplan?",
      "Welke kamervragen zijn er gesteld over de Omgevingswet?",
      "Is er een uitspraak van de Raad van State over het omgevingsplan van Utrecht?",
      // The council by place, as the policy router reads it.
      "Wanneer besprak de raad van Utrecht het omgevingsplan?",
      "Welke besluiten nam het college van Utrecht over het omgevingsplan?",
      "Hoe heeft de raad in Delft het omgevingsplan besproken?",
      "Stemming over de omgevingsvisie in Provinciale Staten van Utrecht",
      // Other sources' words next to a document word.
      "Welke tenders zijn er voor het opstellen van een omgevingsplan?",
      "Wat heeft de Hoge Raad gezegd over het omgevingsplan?",
      "Welke API heeft de overheid voor omgevingsplannen?",
      "Hoeveel kost het omgevingsplan de gemeente?",
      "Nieuws over het omgevingsplan van Utrecht",
      // The Omgevingswet without a place, and a document word with nothing to search on.
      "Wat is de Omgevingswet?",
      "Wat is een omgevingsdocument?",
    ]) {
      expect(detectDsoIntent(question), question).toBeUndefined();
    }
  });

  it("reads the place after a document word: capitalised, after 'van', 'voor' or 'of', before it, or in a lowercase question", () => {
    expect(detectDsoIntent("Omgevingsplan Utrecht")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Omgevingsvisie Rotterdam")).toEqual({ bevoegdGezag: "Rotterdam", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Toon het Omgevingsplan van Den Haag")).toEqual({ bevoegdGezag: "Den Haag", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Voorbereidingsbesluit Utrecht dakkapellen")).toEqual({ bevoegdGezag: "Utrecht", documentType: "voorbereidingsbesluit" });
    expect(detectDsoIntent("Toon het voorbereidingsbesluit van Utrecht over dakkapellen")).toEqual({ bevoegdGezag: "Utrecht", documentType: "voorbereidingsbesluit" });
    expect(detectDsoIntent("Welke voorbereidingsbesluiten heeft Utrecht genomen?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "voorbereidingsbesluit" });
    expect(detectDsoIntent("Welke omgevingsdocumenten heeft Den Bosch?")).toEqual({ bevoegdGezag: "Den Bosch" });
    expect(detectDsoIntent("Wat is het omgevingsplan voor Utrecht?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Welke omgevingsvisie geldt voor Rotterdam?")).toEqual({ bevoegdGezag: "Rotterdam", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Is er een voorbereidingsbesluit voor Lunetten in Utrecht?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "voorbereidingsbesluit" });
    expect(detectDsoIntent("Utrecht omgevingsplan")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Omgevingsplan utrecht")).toEqual({ bevoegdGezag: "utrecht", documentType: "omgevingsplan" });
    expect(detectDsoIntent("omgevingsvisie gemeente amersfoort")).toEqual({ bevoegdGezag: "gemeente amersfoort", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Welke omgevingsplannen gelden er in het centrum van Utrecht?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
    // English.
    expect(detectDsoIntent("What does the omgevingsplan of Utrecht say about dormers?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
    expect(detectDsoIntent("What does the Utrecht omgevingsplan say about dormers?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
    expect(detectDsoIntent("What is the omgevingsvisie of the province of Utrecht?")).toEqual({ bevoegdGezag: "provincie Utrecht", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Which omgevingsverordening applies in North Holland?")).toEqual({ bevoegdGezag: "Noord-Holland", documentType: "omgevingsverordening" });
    // The Rijk's documents.
    expect(detectDsoIntent("Wat is de Nationale Omgevingsvisie?")).toEqual({ typeBevoegdGezag: "ministerie", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Wat staat er in de NOVI over woningbouw?")).toEqual({ typeBevoegdGezag: "ministerie", documentType: "omgevingsvisie" });
  });

  it("answers no document word nationwide unless the question asks for a list, the newest or ontwerpen", () => {
    expect(detectDsoIntent("Welke Omgevingsvisies zijn er recent vastgesteld?")).toEqual({ documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Hoeveel omgevingsplannen zijn er in Nederland?")).toEqual({ documentType: "omgevingsplan" });
    expect(detectDsoIntent("Welke projectbesluiten zijn er?")).toEqual({ documentType: "projectbesluit" });
    expect(detectDsoIntent("Welke ontwerpregelingen liggen er ter inzage?")).toEqual({ soort: "ontwerpregelingen", alleenTerInzage: true });
    for (const question of [
      // No place: the country, a topic, a capitalised word that names no place.
      "Omgevingsplan Nederland",
      "Omgevingsplan regels voor dakkapellen",
      "Wat zegt het omgevingsplan over dakkapellen?",
      "Omgevingsplan Artikel 22 bouwen",
      // A definition or how it works.
      "Wat is een omgevingsplan?",
      "Wat zijn omgevingsplannen?",
      "What is an omgevingsplan?",
    ]) {
      expect(detectDsoIntent(question), question).toBeUndefined();
    }
  });

  it("reads an address with the place or postcode behind it: after a comma, 'te', 'in', brackets or nothing", () => {
    for (const [question, locatie] of [
      ["Welke regels gelden op Oudegracht 245, Utrecht?", "Oudegracht 245, Utrecht"],
      ["Welke regels gelden op Oudegracht 245 te Utrecht?", "Oudegracht 245, Utrecht"],
      ["Welke regels gelden op Brennerbaan 150 Utrecht?", "Brennerbaan 150, Utrecht"],
      ["Welke regels gelden op Kerkstraat 10 (Haarlem)?", "Kerkstraat 10, Haarlem"],
      ["Welke regels gelden op het adres Kerkstraat 10 te Haarlem?", "Kerkstraat 10, Haarlem"],
      ["Welke regels gelden op Brennerbaan 150 in de gemeente Utrecht?", "Brennerbaan 150, Utrecht"],
      ["Welke regels gelden in Utrecht op Brennerbaan 150?", "Brennerbaan 150, Utrecht"],
      ["Welke regels gelden op Brennerbaan 150 3524 BN Utrecht?", "Brennerbaan 150, 3524 BN"],
      ["Welke regels gelden er op het adres Oudegracht 245, 3511 NV Utrecht?", "Oudegracht 245, 3511 NV"],
      ["Op Brennerbaan 150 in Utrecht: welke regels gelden er?", "Brennerbaan 150, Utrecht"],
      // Infixes, ordinals, a title and a street word in front.
      ["Welke regels gelden op 1e Hugo de Grootstraat 10 in Amsterdam?", "1e Hugo de Grootstraat 10, Amsterdam"],
      ["Welke regels gelden op Van Asch van Wijckstraat 5 in Utrecht?", "Van Asch van Wijckstraat 5, Utrecht"],
      ["Welke regels gelden op Laan van Meerdervoort 10 in Den Haag?", "Laan van Meerdervoort 10, Den Haag"],
      ["Welke regels gelden op Weg der Verenigde Naties 1 in Utrecht?", "Weg der Verenigde Naties 1, Utrecht"],
      ["Welke regels gelden er op de Grote Markt 1 in Groningen?", "Grote Markt 1, Groningen"],
      ["Welke regels gelden er op Burgemeester Reigerstraat 10 in Utrecht?", "Burgemeester Reigerstraat 10, Utrecht"],
      ["Welke regels gelden op 's-Gravendijkwal 10 in Rotterdam?", "'s-Gravendijkwal 10, Rotterdam"],
      // A postcode.
      ["Welke regels gelden op 3524 BN 150?", "3524 BN 150"],
      ["Welke regels gelden er op 2011 ZR 10?", "2011 ZR 10"],
    ] as const) {
      expect(detectDsoIntent(question), question).toEqual({ locatie });
    }
    // Next to a document word, a street without a street ending, with its place.
    expect(detectDsoIntent("Welke omgevingsdocumenten gelden voor Neude 11, Utrecht?")).toEqual({ locatie: "Neude 11, Utrecht" });
    expect(detectDsoIntent("Regels op de kaart voor Damrak 1 Amsterdam")).toEqual({ locatie: "Damrak 1, Amsterdam" });
    expect(detectDsoIntent("Welke omgevingsdocumenten gelden voor Damrak 1 te Amsterdam?")).toEqual({ locatie: "Damrak 1, Amsterdam" });
    expect(detectDsoIntent("Welke omgevingsdocumenten gelden voor de Neude 11 in Utrecht?")).toEqual({ locatie: "Neude 11, Utrecht" });
    expect(detectDsoIntent("Wat zegt het omgevingsplan van Utrecht over dakkapellen op Brennerbaan 150?")).toEqual({ locatie: "Brennerbaan 150, Utrecht", documentType: "omgevingsplan" });
    // A year is no house number, a place no street.
    expect(detectDsoIntent("Omgevingsvisie van Amsterdam 2050")).toEqual({ bevoegdGezag: "Amsterdam", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Omgevingsverordening provincie Utrecht voor Natuur 2024")).toEqual({ bevoegdGezag: "provincie Utrecht", documentType: "omgevingsverordening" });
  });

  it("takes the rules at an address, with nothing but rule, permission and building words besides", () => {
    expect(detectDsoIntent("Welke regels gelden op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent("Wat zijn de omgevingsregels voor Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent("Regels voor Oudegracht 245 Utrecht")).toEqual({ locatie: "Oudegracht 245, Utrecht" });
    expect(detectDsoIntent("Welke regels gelden er voor mijn perceel op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent("Mag ik een dakkapel plaatsen op Oudegracht 100, Utrecht?")).toEqual({ locatie: "Oudegracht 100, Utrecht" });
    expect(detectDsoIntent("Wat mag ik bouwen op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent("Is een dakkapel vergunningvrij op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent("Welke waterschapsregels gelden op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht", documentType: "waterschapsverordening" });
    expect(detectDsoIntent("Which rules apply at Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    for (const question of [
      // Another topic at the address.
      "Welke regels gelden voor energielabels op Oudegracht 245 in Utrecht?",
      "Welke regels gelden voor Airbnb op Kalverstraat 92 in Amsterdam?",
      "Welke regels gelden voor kamerverhuur op postcode 3511 AB?",
      "Mag ik mijn auto parkeren op Kerkstraat 10 in Ede?",
      "Wat is het bouwjaar van Brennerbaan 150 in Utrecht?",
      // No street ending, or a day, a unit or a duration after the number.
      "Welke regels gelden op Damrak 1 in Amsterdam?",
      "Welke regels gelden onder de Omgevingswet voor Damrak 1 in Amsterdam?",
      "Welke regels gelden voor Box 3 in Nederland?",
      "Welke regels gelden op Koningsdag 27 april in Amsterdam?",
      "Welke regels gelden voor herdenkingen op de Dam 4 mei?",
      "Welke regels gelden er voor de Ring 10 rond Amsterdam?",
      "Welke regels gelden voor vuurwerk in Amsterdam 31 december?",
      "Welke regels gelden voor parkeren in de straat 2 uur lang?",
      "Welke regels gelden voor een windpark van 1000 MW op zee?",
      "Welke regels gelden op Koningsdag 2026 in Amsterdam?",
    ]) {
      expect(detectDsoIntent(question), question).toBeUndefined();
    }
  });

  it("reads 'in Noord-Holland' as the provincie's area for omgevingsplannen, and a verordening 'in <gemeente>' at that place", () => {
    expect(detectDsoIntent("Welke omgevingsplannen liggen er in Noord-Holland?")).toEqual({ provincie: "Noord-Holland", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Welke omgevingsplannen hebben gemeenten in Friesland?")).toEqual({ provincie: "Friesland", documentType: "omgevingsplan" });
    expect(detectDsoIntent("Omgevingsvisie Fryslân")).toEqual({ bevoegdGezag: "Fryslân", documentType: "omgevingsvisie" });
    expect(detectDsoIntent("Welke waterschapsverordening geldt in Utrecht?")).toEqual({ locatie: "Utrecht", documentType: "waterschapsverordening" });
    expect(detectDsoIntent("Welke omgevingsverordening geldt in Amersfoort?")).toEqual({ locatie: "Amersfoort", documentType: "omgevingsverordening" });
    expect(detectDsoIntent("Welke omgevingsplannen gelden er op Schiphol?")).toEqual({ locatie: "Schiphol", documentType: "omgevingsplan" });
  });

  it("leaves the law, definitions, procedures, money, councils and other sources' documents alone", () => {
    for (const question of [
      "Hoe regelt de provincie Gelderland de Omgevingswet?",
      "Welke regels gelden onder de Omgevingswet in Utrecht?",
      "Sinds wanneer geldt de Omgevingswet in Amsterdam?",
      "Wat staat er in de Omgevingswet over het omgevingsplan?",
      "Wat zegt artikel 2.4 Omgevingswet over het omgevingsplan?",
      "Wie stelt het omgevingsplan vast?",
      "Hoe werkt een voorbereidingsbesluit?",
      "Is een omgevingsvisie bindend voor burgers?",
      "Hoeveel heeft het omgevingsplan van Utrecht gekost?",
      "Inspraakavond omgevingsvisie Zwolle",
      "Nota van zienswijzen ontwerp omgevingsvisie Amersfoort",
      "Wat besloot de Raad van Amersfoort over het omgevingsplan?",
      "PS van Utrecht over de omgevingsverordening",
      "Statenbrief omgevingsverordening Utrecht",
      "Kamerbrief over de voortgang van omgevingsplannen",
      "Wat zegt de VNG over het omgevingsplan?",
      "Parlementaire stukken over de nationale omgevingsvisie",
      "Ontwerp jaarrekening waterschap Rivierenland ter inzage",
      "Welk ontwerp ligt ter inzage voor de nieuwe sporthal in Zwolle?",
      "Welke ontwerpbesluiten liggen nu ter inzage in Amsterdam?",
    ]) {
      expect(detectDsoIntent(question), question).toBeUndefined();
    }
    // "beroep aan huis" is no appeal, "onder de Omgevingswet" no question about the law.
    expect(detectDsoIntent("Mag ik een beroep aan huis uitoefenen volgens het omgevingsplan van Utrecht?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan" });
  });

  it("asks for the ontwerpen ter inzage of a named body, and reads 'in de provincie' as an area", () => {
    expect(detectDsoIntent("Welke ontwerpen liggen ter inzage in de provincie Utrecht?")).toEqual({ provincie: "Utrecht", soort: "ontwerpregelingen", alleenTerInzage: true });
    expect(detectDsoIntent("Welke ontwerp-omgevingsplannen liggen ter inzage in de provincie Utrecht?")).toEqual({
      provincie: "Utrecht",
      documentType: "omgevingsplan",
      soort: "ontwerpregelingen",
      alleenTerInzage: true,
    });
    expect(detectDsoIntent("Welke omgevingsvisies zijn er in de provincie Utrecht?")).toEqual({ provincie: "Utrecht", documentType: "omgevingsvisie" });
    // The provincie's own documents.
    expect(detectDsoIntent("Welke ontwerpen van de provincie Utrecht liggen nu ter inzage?")).toEqual({ bevoegdGezag: "provincie Utrecht", soort: "ontwerpregelingen", alleenTerInzage: true });
    expect(detectDsoIntent("Welke omgevingsverordening geldt in de provincie Utrecht?")).toEqual({ bevoegdGezag: "provincie Utrecht", documentType: "omgevingsverordening" });
    expect(detectDsoIntent("Welke ontwerpen liggen ter inzage in de gemeente Rhenen?")).toEqual({ bevoegdGezag: "gemeente Rhenen", soort: "ontwerpregelingen", alleenTerInzage: true });
    // No body, or another kind of ontwerp.
    for (const question of [
      "Welke ontwerpen liggen ter inzage?",
      "Welke ontwerpbesluiten liggen ter inzage in de gemeente Utrecht?",
      "Ontwerpbegroting provincie Utrecht ter inzage",
      "Welke ontwerp-verkeersbesluiten liggen ter inzage in de gemeente Utrecht?",
    ]) {
      expect(detectDsoIntent(question), question).toBeUndefined();
    }
  });

  it("asks for the newest documents, and for the one day the rules applied", () => {
    expect(detectDsoIntent("Wat zijn de nieuwste omgevingsdocumenten?")).toEqual({});
    expect(detectDsoIntent("Welke omgevingsdocumenten golden er op 1 januari 2025 op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht", geldigOp: "2025-01-01" });
    expect(detectDsoIntent("Welke regels golden op 1-1-2025 op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht", geldigOp: "2025-01-01" });
    expect(detectDsoIntent("Welk omgevingsplan gold op 2025-07-01 in Utrecht?")).toEqual({ bevoegdGezag: "Utrecht", documentType: "omgevingsplan", geldigOp: "2025-07-01" });
    // A year or two days is no day; an ontwerp has no geldigOp.
    expect(detectDsoIntent("Welke omgevingsdocumenten golden in 2025 op Brennerbaan 150 in Utrecht?")).toEqual({ locatie: "Brennerbaan 150, Utrecht" });
    expect(detectDsoIntent("Welke omgevingsdocumenten golden tussen 1 januari 2025 en 1 juli 2025 in Utrecht?")).toEqual({ bevoegdGezag: "Utrecht" });
    expect(detectDsoIntent("Welke ontwerp-omgevingsplannen lagen op 1 januari 2025 ter inzage in Utrecht?")).not.toHaveProperty("geldigOp");
  });

  it("takes linear time on long adversarial input, and gives no intent beyond 500 characters", () => {
    const fastest = (input: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        detectDsoIntent(input, Number.POSITIVE_INFINITY);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const repeat = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    // Runs of name characters (the quadratic street pattern took 1.2-4.4 s on 100k
    // of these), address openings, infix chains and document words before them.
    for (const [opening, unit] of [
      ["", ".Straat"],
      ["", "-straat"],
      ["", "'straat"],
      ["", "op A van van "],
      ["", "in A de "],
      ["", "op de "],
      ["", "1e A "],
      ["Omgevingsplan ", "A de "],
      ["Welke regels gelden op ", "Kerkstraat "],
      ["Welke regels gelden op ", "3524 BN "],
      ["omgevingsplan van ", ".Straat"],
    ] as const) {
      const long = opening + repeat(unit, 10_000);
      expect(detectDsoIntent(long), unit).toBeUndefined();
      // 40,000 characters in well under 100 ms: a quadratic pattern needs seconds.
      const ms = fastest(opening + repeat(unit, 40_000));
      expect(ms, `${opening}${unit}: ${ms.toFixed(1)} ms`).toBeLessThan(100);
    }
    expect(detectDsoIntent(`Welke regels gelden op Brennerbaan 150 in Utrecht? ${"x".repeat(500)}`)).toBeUndefined();
  });
});

describe("nl_gov_ask: DSO route (dryRun)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("plans the DSO request for Omgevingswet questions when DSO_API_KEY is set", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");

    const gemeente = await plan(GEMEENTE);
    expect(gemeente.estimated_sources).toEqual(["dso_omgevingsdocumenten"]);
    expect(gemeente.planned_requests[0]).toMatchObject({
      connector: "dso_omgevingsdocumenten",
      method: "POST",
      url: `${DSO}/regelingen/_zoek`,
      params: { bevoegdGezag: "gemeente Utrecht", soort: "regelingen", top: 10 },
    });

    const adres = await plan(ADRES);
    expect(adres.planned_requests[0]).toMatchObject({ method: "POST", url: `${DSO}/regelingen/_zoek`, params: { locatie: "Brennerbaan 150, Utrecht" } });

    const visie = await plan(VISIE);
    expect(visie.planned_requests[0].params).toMatchObject({ bevoegdGezag: "provincie Utrecht", documentType: "omgevingsvisie" });

    const terInzage = await plan("Welke ontwerp-omgevingsplannen liggen er nu ter inzage?");
    expect(terInzage.planned_requests[0]).toMatchObject({ method: "GET", url: `${DSO}/ontwerpregelingen`, params: { soort: "ontwerpregelingen", alleen_ter_inzage: true } });
  });

  it("plans the area of a provincie, every layer at an address, a day, and one search for an omgevingsplan", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");

    const gebied = await plan("Welke ontwerpen liggen ter inzage in de provincie Utrecht?");
    expect(gebied.planned_requests).toEqual([
      expect.objectContaining({ method: "POST", url: `${DSO}/ontwerpregelingen/_zoek`, params: expect.objectContaining({ provincie: "Utrecht", soort: "ontwerpregelingen", alleen_ter_inzage: true }) }),
    ]);
    expect(gebied.planned_requests[0].params).not.toHaveProperty("bevoegdGezag");

    // Up to 50 documents at a point, so no bestuurslaag is cut off at `top`.
    expect((await plan(ADRES)).planned_requests[0].params).toMatchObject({ locatie: "Brennerbaan 150, Utrecht", top: 10, rows: 50 });
    expect((await plan(GEMEENTE)).planned_requests[0].params).not.toHaveProperty("rows");

    const dag = await plan("Welke omgevingsdocumenten golden er op 1 januari 2025 op Brennerbaan 150 in Utrecht?");
    expect(dag.planned_requests[0].params).toMatchObject({ locatie: "Brennerbaan 150, Utrecht", geldigOp: "2025-01-01" });

    // The search itself names a gemeente's voorbeschermingsregels for an omgevingsplan.
    const plan2 = await plan("Wat zegt het omgevingsplan van Utrecht over dakkapellen?");
    expect(plan2.estimated_sources).toEqual(["dso_omgevingsdocumenten"]);
    expect(plan2.planned_requests.map((r: { params: { documentType: string } }) => r.params.documentType)).toEqual(["omgevingsplan"]);
  });

  it("without DSO_API_KEY routes them as before", async () => {
    vi.stubEnv("DSO_API_KEY", "");
    expect((await plan(GEMEENTE)).estimated_sources).toEqual(["ori"]);
    expect((await plan(ADRES)).estimated_sources).toEqual(["data_overheid"]);
    expect((await plan(VISIE)).estimated_sources).toEqual(["ob", "tk", "rijk"]);
  });

  it("keeps the routes of permit, bestemmingsplan and CBS questions, key or not", async () => {
    const expected: Record<string, string[]> = { [VERGUNNING]: ["data_overheid"], [BESTEMMINGSPLAN]: ["data_overheid"], [INWONERS]: ["cbs"] };
    for (const [question, sources] of Object.entries(expected)) {
      vi.stubEnv("DSO_API_KEY", "");
      const without = await plan(question);
      vi.stubEnv("DSO_API_KEY", "test-key");
      const withKey = await plan(question);
      expect(withKey.estimated_sources, question).toEqual(sources);
      expect(withKey, question).toEqual(without);
    }
  });
});

describe("nl_gov_ask: DSO route (answers)", () => {
  const VISIE_PV26 = {
    identificatie: "/akn/nl/act/pv26/2023/omgevingsvisie",
    officieleTitel: "Omgevingsvisie provincie Utrecht",
    type: { code: "/join/id/stop/regelingtype_006", waarde: "Omgevingsvisie" },
    aangeleverdDoorEen: { naam: "provincie Utrecht", bestuurslaag: "provincie", code: "pv26" },
    geregistreerdMet: { beginGeldigheid: "2024-01-01", beginInwerking: "2024-01-01" },
  };
  const VERORDENING_PV26 = {
    ...VISIE_PV26,
    identificatie: "/akn/nl/act/pv26/2022/omgevingsverordening",
    officieleTitel: "Omgevingsverordening provincie Utrecht",
    type: { code: "/join/id/stop/regelingtype_004", waarde: "Omgevingsverordening" },
  };
  const PLAN_GM0344 = {
    identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan",
    officieleTitel: "Omgevingsplan gemeente Utrecht",
    type: { code: "/join/id/stop/regelingtype_003", waarde: "Omgevingsplan" },
    aangeleverdDoorEen: { naam: "gemeente Utrecht", bestuurslaag: "gemeente", code: "gm0344" },
    geregistreerdMet: { beginGeldigheid: "2026-09-18", beginInwerking: "2026-09-18" },
  };
  const page = (items: unknown[]) => ({ _embedded: { regelingen: items }, page: { number: 1, size: 200, totalElements: items.length, totalPages: 1 } });

  let requests: Array<{ url: URL; method: string; body?: string }> = [];
  function mockFetch(route: (url: URL, method: string, body?: string) => Response) {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = init?.body ? String(init.body) : undefined;
        requests.push({ url, method, body });
        return route(url, method, body);
      }),
    );
  }

  beforeEach(() => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    clearHttpCache();
    clearDsoCaches();
    appCache.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("answers 'Wat is de omgevingsvisie van de provincie Utrecht?' from the DSO", async () => {
    mockFetch((url, method) => {
      if (method === "GET" && url.pathname.endsWith("/regelingen")) return jsonResponse(page([PLAN_GM0344, VISIE_PV26, VERORDENING_PV26]));
      if (method === "POST" && url.pathname.endsWith("/regelingen/_zoek")) return jsonResponse(page([VERORDENING_PV26, VISIE_PV26]));
      return new Response("not found", { status: 404 });
    });
    const out = await ask({ question: VISIE });

    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — provincie Utrecht (1 document)");
    expect(out.records.map((r: { title: string; canonical_url: string; source_name: string }) => [r.title, r.canonical_url, r.source_name])).toEqual([
      ["Omgevingsvisie provincie Utrecht", "https://identifier.overheid.nl/akn/nl/act/pv26/2023/omgevingsvisie", "dso_omgevingsdocumenten"],
    ]);
    expect(JSON.parse(requests.find((r) => r.method === "POST")!.body!)).toEqual({ bevoegdGezag: ["pv26"] });
    expect(out.access_note).toContain("bevoegdGezag 'provincie Utrecht', documentType 'omgevingsvisie'");
    // No other source was asked.
    expect(requests.every((r) => r.url.hostname === "service.omgevingswet.overheid.nl")).toBe(true);
  });

  it("answers the address question with the documents at that point", async () => {
    mockFetch((url) => {
      if (url.hostname === "api.pdok.nl") return jsonResponse({ response: { docs: [{ weergavenaam: "Brennerbaan 150, 3524BN Utrecht", type: "adres", centroide_rd: "POINT(138180.745 453109.293)" }] } });
      if (url.pathname.endsWith("/regelingen/_zoek")) return jsonResponse(page([VISIE_PV26, PLAN_GM0344]));
      return new Response("not found", { status: 404 });
    });
    const out = await ask({ question: ADRES });

    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — Brennerbaan 150, 3524BN Utrecht (2 documenten)");
    expect(out.records.map((r: { data: { bevoegdGezagCode: string } }) => r.data.bevoegdGezagCode)).toEqual(["gm0344", "pv26"]);
    const zoek = requests.find((r) => r.method === "POST")!;
    expect(JSON.parse(zoek.body!)).toEqual({ geometrie: { type: "Point", coordinates: [138180.745, 453109.293] } });
  });

  it("falls through to the routes it had when the DSO fails, and says so", async () => {
    mockFetch((url) => {
      if (url.hostname === "api.pdok.nl") return jsonResponse({ response: { docs: [{ weergavenaam: "Brennerbaan 150, 3524BN Utrecht", type: "adres", centroide_rd: "POINT(138180.745 453109.293)" }] } });
      if (url.hostname === "service.omgevingswet.overheid.nl") return new Response("bad request", { status: 400 });
      if (url.hostname === "data.overheid.nl") return jsonResponse({ success: true, result: { count: 0, results: [] } });
      return new Response("not found", { status: 404 });
    });
    const out = await ask({ question: ADRES });

    expect(out.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(out.access_note).toMatch(/^DSO Omgevingsdocumenten eerst geprobeerd \(locatie 'Brennerbaan 150, Utrecht'\): mislukt \(http_error/);
    expect(out.access_note).toContain("Dit antwoord komt van de andere routes van nl_gov_ask.");
    expect(out.failures).toEqual([expect.objectContaining({ connector: "dso_omgevingsdocumenten", error_type: "http_error" })]);
  });
});

describe("nl_gov_ask: what the DSO route makes of the search", () => {
  const DSO_LIST = `${DSO}/regelingen`;
  function item(code: string, laag: string, title: string, extra: Partial<DsoSearchItem> = {}): DsoSearchItem {
    const id = `/akn/nl/act/${code}/2026/${title.replace(/\W+/g, "_")}`;
    return {
      id,
      identificatie: id,
      title,
      soort: "regeling",
      documentType: "Omgevingsplan",
      bevoegdGezag: `${laag} ${code}`,
      bestuurslaag: laag,
      bevoegdGezagCode: code,
      beginGeldigheid: "2026-01-01",
      documentUrl: `https://identifier.overheid.nl${id}`,
      documentUrlType: "lokale_regelgeving",
      viewerUrl: "https://omgevingswet.overheid.nl/regels-op-de-kaart",
      raw: {} as DsoSearchItem["raw"],
      ...extra,
    };
  }
  const result = (items: DsoSearchItem[], extra: Partial<DsoSearchResult> = {}): DsoSearchResult => ({
    items,
    total: items.length,
    endpoint: `${DSO_LIST}/_zoek`,
    query: {},
    access_note: "Bron: DSO Omgevingsdocumenten Presenteren API v8.",
    scope: "bevoegd_gezag",
    ...extra,
  });
  const GM0344 = { code: "gm0344", naam: "gemeente Utrecht" };
  const POINT = { invoer: "Brennerbaan 150, Utrecht", weergavenaam: "Brennerbaan 150, 3524BN Utrecht", type: "adres", rd: [138180.745, 453109.293] as [number, number] };

  let fetched: string[] = [];
  beforeEach(() => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    clearHttpCache();
    appCache.clear();
    fetched = [];
    // Only the routes after the DSO fetch; data.overheid answers with nothing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        fetched.push(url.hostname);
        if (url.hostname === "data.overheid.nl") return jsonResponse({ success: true, result: { count: 0, results: [] } });
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("answers an empty ter-inzage search from the DSO and says what that means, in nl_gov_ask's terms", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(
      result([], {
        bevoegdGezag: { code: "pv26", naam: "provincie Utrecht" },
        access_note:
          "bevoegdGezag provincie Utrecht: alleen de documenten die de provincie zelf vaststelt, niet die van de gemeenten en waterschappen in de provincie. Voor de provincie met al haar gemeenten: provincie 'pv26'. Bron: DSO Omgevingsdocumenten Presenteren API v8.",
      }),
    );
    const out = await ask({ question: "Welke omgevingsdocumenten van de provincie Utrecht liggen nu ter inzage?" });

    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — provincie Utrecht (0 ontwerpen ter inzage)");
    expect(out.records).toEqual([]);
    expect(out.access_note).toContain("Geen ontwerp waarvan de in het DSO geregistreerde inzagetermijn vandaag loopt.");
    // Said once, as a question to nl_gov_ask rather than the search's parameter.
    expect(out.access_note).toContain("Voor de provincie met al haar gemeenten: vraag naar 'in de provincie Utrecht'.");
    expect(out.access_note).not.toContain("provincie 'pv26'");
    expect(out.access_note.match(/alleen de documenten die de provincie zelf/g)).toHaveLength(1);
    expect(out.access_note).toContain("officiele_bekendmakingen_search");
    // No other route answered in its place.
    expect(fetched).toEqual([]);
  });

  it("passes the area of a provincie to the search and names it", async () => {
    const search = vi
      .spyOn(DsoOmgevingsdocumentenSource.prototype, "search")
      .mockResolvedValue(result([], { endpoint: `${DSO}/ontwerpregelingen/_zoek`, query: { provincie: "pv26", alleen_ter_inzage: "true" } }));
    const out = await ask({ question: "Welke ontwerpen liggen ter inzage in de provincie Utrecht?" });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ provincie: "Utrecht", soort: "ontwerpregelingen", alleenTerInzage: true, rows: 10 }));
    expect(search.mock.calls[0][0]).not.toHaveProperty("bevoegdGezag");
    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — gebied provincie Utrecht (provincie en gemeenten) (0 ontwerpen ter inzage)");
    expect(fetched).toEqual([]);
  });

  it("counts the ontwerpen that are only possibly ter inzage apart", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(
      result(
        [
          item("gm0321", "gemeente", "Omgevingsvisie Houten", { soort: "ontwerpregeling", terInzage: true }),
          item("gm0344", "gemeente", "Omgevingsplan gemeente Utrecht", { soort: "ontwerpregeling", terInzage: true }),
          item("pv26", "provincie", "Programma provincie Utrecht", { soort: "ontwerpregeling", terInzage: null, mogelijkTerInzage: true }),
        ],
        { endpoint: `${DSO}/ontwerpregelingen/_zoek`, query: { provincie: "pv26", alleen_ter_inzage: "true" }, scope: "provincie" },
      ),
    );
    const out = await ask({ question: "Welke ontwerpen liggen ter inzage in de provincie Utrecht?" });
    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — gebied provincie Utrecht (provincie en gemeenten) (2 ontwerpen ter inzage, 1 mogelijk ter inzage)");
  });

  it("passes the day the rules applied as geldigOp, and says so when a period is not applied", async () => {
    const search = vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(result([item("pv26", "provincie", "Omgevingsvisie provincie Utrecht")], { locatie: POINT, scope: "locatie" }));
    const dag = await ask({ question: "Welke omgevingsdocumenten golden er op 1 januari 2025 op Brennerbaan 150 in Utrecht?" });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ locatie: "Brennerbaan 150, Utrecht", geldigOp: "2025-01-01", rows: 50 }));
    expect(dag.access_note).toContain("geldigOp '2025-01-01'");
    expect(dag.access_note).not.toContain("niet toegepast");

    const jaar = await ask({ question: "Welke omgevingsdocumenten golden in 2025 op Brennerbaan 150 in Utrecht?" });
    expect(search.mock.lastCall?.[0]).not.toHaveProperty("geldigOp");
    expect(jaar.access_note).toContain("De periode uit de vraag (2025-01-01 t/m 2025-12-31) is niet toegepast: dit zijn de documenten die vandaag gelden.");

    // A year in a document's name asks for no period.
    const titel = await ask({ question: "Omgevingsvisie Amsterdam 2050" });
    expect(search.mock.lastCall?.[0]).toMatchObject({ bevoegdGezag: "Amsterdam", documentType: "omgevingsvisie" });
    expect(titel.access_note).not.toContain("niet toegepast");
  });

  it("shows every bestuurslaag at an address on the first page", async () => {
    const items = [
      ...["Omgevingsplan", "Actieplan", "Programma A", "Programma B", "Programma C", "Programma D"].map((t) => item("gm0344", "gemeente", t)),
      item("ws0636", "waterschap", "Waterschapsverordening"),
      ...["Omgevingsverordening", "Omgevingsvisie", "Programma E", "Programma F"].map((t) => item("pv26", "provincie", t)),
      ...["Omgevingswet", "Besluit activiteiten leefomgeving", "Nationale Omgevingsvisie"].map((t) => item("mnre1034", "ministerie", t)),
    ];
    const search = vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(result(items, { locatie: POINT, scope: "locatie" }));
    const out = await ask({ question: "Welke regels gelden op Brennerbaan 150 in Utrecht?", top: 5 });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ locatie: "Brennerbaan 150, Utrecht", rows: 50 }));
    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — Brennerbaan 150, 3524BN Utrecht (14 documenten)");
    expect(out.records.map((r: { title: string }) => r.title)).toEqual(["Omgevingsplan", "Actieplan", "Waterschapsverordening", "Omgevingsverordening", "Omgevingswet"]);
    expect(out.pagination).toMatchObject({ offset: 0, limit: 5, total: 14, has_more: true });
    expect(out.access_note).toContain("Op dit punt: 14 documenten (gemeente 6, waterschap 1, provincie 4, Rijk 3); de eerste 5 tonen elke bestuurslaag, de rest volgt met offset 5.");

    // The next page holds the rest, in order.
    const next = await ask({ question: "Welke regels gelden op Brennerbaan 150 in Utrecht?", top: 5, offset: 5 });
    expect(next.records.map((r: { title: string }) => r.title)).toEqual(["Programma A", "Programma B", "Programma C", "Programma D", "Omgevingsvisie"]);
  });

  it("falls through when the address is not found, and says so", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockRejectedValue(
      new DsoInputError("Adres 'Nergensstraat 99999, Utrecht' niet gevonden in Utrecht (PDOK Locatieserver).", "Geef een adres in Nederland ('Brennerbaan 150, Utrecht')."),
    );
    const out = await ask({ question: "Welke regels gelden op Nergensstraat 99999 in Utrecht?" });

    expect(out.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(out.access_note).toContain("DSO Omgevingsdocumenten eerst geprobeerd (locatie 'Nergensstraat 99999, Utrecht'): Adres 'Nergensstraat 99999, Utrecht' niet gevonden in Utrecht");
  });

  it("searches an omgevingsplan once, passes the search's notes on in nl_gov_ask's terms, and names the topic it did not search", async () => {
    const plans = Array.from({ length: 10 }, (_, i) => item("gm0344", "gemeente", `Omgevingsplan gemeente Utrecht ${i + 1}`));
    const search = vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(
      result(plans, {
        total: 13,
        bevoegdGezag: GM0344,
        access_note:
          "Ook van belang: 2 voorbereidingsbesluiten van gemeente Utrecht (documentType 'voorbereidingsbesluit'). Niet getoond (rows 10): 3 van de 13 documenten van de gemeente; verhoog rows naar 13 voor de volledige lijst. Bron: DSO Omgevingsdocumenten Presenteren API v8.",
      }),
    );
    const out = await ask({ question: "Wat zegt het omgevingsplan van Utrecht over dakkapellen?" });

    expect(search.mock.calls.map(([args]) => args.documentType)).toEqual(["omgevingsplan"]);
    expect(out.summary).toBe("Router: DSO Omgevingsdocumenten — gemeente Utrecht (10 documenten)");
    expect(out.provenance.total_results).toBe(13);
    expect(out.pagination).toMatchObject({ total: 10, has_more: false });
    expect(out.access_note).toContain("Ook van belang: 2 voorbereidingsbesluiten van gemeente Utrecht");
    expect(out.access_note).toContain("Niet getoond (nl_gov_ask haalt er 10 op): 3 van de 13 documenten van de gemeente.");
    expect(out.access_note).not.toMatch(/verhoog rows/);
    expect(out.access_note).toContain("verhoog 'top'");
    expect(out.access_note).toContain("Onderwerp 'dakkapellen' is niet in de documenten doorzocht");
    expect(out.access_note).toContain("dso_omgevingsdocument_tekst (identificatie, zoekterm 'dakkapellen'");
  });

  it("names no topic the search already used as a parameter", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(result([item("mnre1034", "ministerie", "Nationale Omgevingsvisie", { documentType: "Omgevingsvisie" })], { scope: "catalogus" }));
    const out = await ask({ question: "Wat zegt de Nationale Omgevingsvisie over woningbouw?" });
    expect(out.access_note).toContain("Onderwerp 'woningbouw' is niet in de documenten doorzocht");
    expect(out.access_note).not.toMatch(/Onderwerp '[^']*nationale/i);
  });

  it("scopes a bare document type to the whole country in its summary", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(result([item("gm0599", "gemeente", "Omgevingsplan gemeente Rotterdam")], { scope: "catalogus" }));
    expect((await ask({ question: "Wat zijn de nieuwste omgevingsplannen?" })).summary).toBe("Router: DSO Omgevingsdocumenten — heel Nederland (1 document)");
  });

  it("falls through on an empty search without a scope, and says the DSO was tried", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockResolvedValue(result([], { scope: "catalogus" }));
    const out = await ask({ question: "Wat zijn de nieuwste omgevingsplannen?" });

    expect(out.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(out.access_note).toMatch(/^DSO Omgevingsdocumenten eerst geprobeerd \(documentType 'omgevingsplan'\): 0 documenten\./);
  });

  it("falls through when the DSO does not know the place, and says why", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockRejectedValue(
      new DsoInputError("Bevoegd gezag 'Nergenshuizen' niet gevonden onder de bevoegde gezagen met regelingen in het DSO.", "Geef de naam of de TOOI-code op."),
    );
    const out = await ask({ question: "Omgevingsplan Nergenshuizen" });

    expect(out.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(out.access_note).toContain("DSO Omgevingsdocumenten eerst geprobeerd (bevoegdGezag 'Nergenshuizen', documentType 'omgevingsplan'): Bevoegd gezag 'Nergenshuizen' niet gevonden");
    expect(out.access_note).not.toContain("Geen specifieke bron herkend");
    expect(out.failures).toBeUndefined();
  });

  it("names a failure of the PDOK Locatieserver as PDOK's", async () => {
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockRejectedValue(
      new SourceRequestError({ message: "Source request failed with status 502", endpoint: "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free", code: "http_error", status: 502 }),
    );
    const out = await ask({ question: ADRES });

    expect(out.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(out.access_note).toMatch(/^DSO Omgevingsdocumenten eerst geprobeerd \(locatie 'Brennerbaan 150, Utrecht'\): mislukt \(http_error: PDOK Locatieserver \(locatie voor het DSO\)/);
    expect(out.failures).toEqual([expect.objectContaining({ connector: "dso_omgevingsdocumenten", message: expect.stringContaining("PDOK Locatieserver") })]);
  });

  it("stops waiting for the DSO after 20 s and answers from the other routes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockReturnValue(new Promise<never>(() => undefined));
    const pending = ask({ question: ADRES });
    await vi.advanceTimersByTimeAsync(20_000);
    const out = await pending;

    expect(out.summary).toMatch(/^Router fallback: data\.overheid/);
    expect(out.access_note).toContain("DSO Omgevingsdocumenten eerst geprobeerd (locatie 'Brennerbaan 150, Utrecht'): geen antwoord binnen 20 s, niet op gewacht.");
    expect(out.failures).toEqual([expect.objectContaining({ connector: "dso_omgevingsdocumenten", error_type: "timeout" })]);
  });
});
