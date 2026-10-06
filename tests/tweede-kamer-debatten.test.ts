import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../src/server.js";
import { detectDebatIntent, registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { foldText } from "../src/sources/dso-regeltekst.js";
import {
  fractieMatches,
  parseVerslag,
  pickVerslag,
  snippetAt,
  sprekerMatches,
  sprekerNaam,
  textMatcher,
} from "../src/sources/tweede-kamer-debatten.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";

type Payload = Record<string, any>;

const API = "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0";

function spreker(soort: string, voornaam: string, verslagnaam: string, fractie: string | null, functie: string): string {
  return `<spreker soort="${soort}" objectid="s-${verslagnaam}">${fractie ? `<fractie>${fractie}</fractie>` : ""}<aanhef>De heer</aanhef><verslagnaam>${verslagnaam}</verslagnaam><voornaam>${voornaam}</voornaam><functie>${functie}</functie></spreker>`;
}

/** A committee debate: the chair opens, a member speaks and is interrupted, the minister answers. */
const COMMISSIE_XML = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<vlosCoreDocument soort="Tussenpublicatie" status="Ongecorrigeerd" xmlns="http://www.tweedekamer.nl/ggm/vergaderverslag/v1.0">
<vergadering soort="Commissie" objectid="v-1"><titel>Mensenrechtenbeleid</titel><zaal>Troelstrazaal</zaal><vergaderjaar>2026-2027</vergaderjaar><vergaderingnummer>10</vergaderingnummer><datum>2026-10-05T00:00:00</datum><aanvangstijd>2026-10-05T15:00:00</aanvangstijd>
<activiteit soort="Notaoverleg" objectid="a-1"><titel>Mensenrechtenbeleid</titel><onderwerp>Mensenrechtenbeleid</onderwerp>
<activiteithoofd soort="Algemeen"><draadboekfragment soort="Wisseling voorzitter"><isdraad>true</isdraad><sprekers>${spreker("Tweede Kamerlid", "Fatimazhra", "Belhirch", "D66", "lid Tweede Kamer")}</sprekers></draadboekfragment>
<activiteitdeel soort="Spreekbeurt"><activiteititem soort="Woordvoerder">
<woordvoerder>${spreker("Tweede Kamerlid", "Fatimazhra", "Belhirch", "D66", "lid Tweede Kamer")}<markeertijdbegin>2026-10-05T15:00:10</markeertijdbegin><markeertijdeind>2026-10-05T15:01:00</markeertijdeind><isvoorzitter>true</isvoorzitter>
<tekst><alinea><alineaitem>De <nadruk type="Vet">voorzitter</nadruk>:</alineaitem><alineaitem>Welkom. Het woord is aan de heer Van Dijk van de VVD.</alineaitem></alinea></tekst></woordvoerder></activiteititem></activiteitdeel>
<activiteitdeel soort="Spreekbeurt"><activiteititem soort="Woordvoerder">
<woordvoerder>${spreker("Tweede Kamerlid", "Tony", "Tony van Dijck", "VVD", "lid Tweede Kamer")}<markeertijdbegin>2026-10-05T15:01:00</markeertijdbegin><markeertijdeind>2026-10-05T15:06:00</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>De heer <nadruk type="Vet">Tony van Dijck</nadruk> (VVD):</alineaitem><alineaitem>Voorzitter. De <nadruk type="Cursief">persvrijheid</nadruk> staat onder druk in Iran.</alineaitem></alinea>
<alineagroep><alinea><alineaitem>De Kamer, gehoord de beraadslaging, verzoekt de regering sancties te overwegen.</alineaitem></alinea></alineagroep></tekst>
<interrumpant>${spreker("Tweede Kamerlid", "Songül", "Mutluer", "PRO", "lid Tweede Kamer")}<markeertijdbegin>2026-10-05T15:04:00</markeertijdbegin><markeertijdeind>2026-10-05T15:04:30</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>Mevrouw <nadruk type="Vet">Mutluer</nadruk> (PRO):</alineaitem><alineaitem>Geldt dat ook voor de Golfstaten, en voor het café om de hoek?</alineaitem></alinea></tekst></interrumpant>
</woordvoerder></activiteititem></activiteitdeel>
<activiteitdeel soort="Spreekbeurt"><activiteititem soort="Woordvoerder">
<woordvoerder>${spreker("Minister", "Tom", "Berendsen", null, "minister van Buitenlandse Zaken")}<markeertijdbegin>2026-10-05T16:00:00</markeertijdbegin><markeertijdeind>2026-10-05T16:10:00</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>Minister <nadruk type="Vet">Berendsen</nadruk>:</alineaitem><alineaitem>Nederland blijft kijken naar het sanctie-instrument tegen Iran.</alineaitem></alinea></tekst></woordvoerder></activiteititem></activiteitdeel>
<activiteitdeel soort="Stemming item"><stemmingen><stemming><fractie>VVD</fractie><stem>Voor</stem></stemming></stemmingen></activiteitdeel>
</activiteithoofd></activiteit></vergadering></vlosCoreDocument>`;

const PLENAIR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<vlosCoreDocument soort="Eindpublicatie" status="Gecorrigeerd">
<vergadering soort="Plenair"><titel>90e vergadering, donderdag 2 juli 2026</titel><vergaderjaar>2025-2026</vergaderjaar><vergaderingnummer>90</vergaderingnummer><datum>2026-07-02T00:00:00</datum>
<activiteit soort="Plenair debat"><titel>(groot project) PALLAS</titel><onderwerp>(groot project) PALLAS (CD d.d. 24/06)</onderwerp>
<activiteitdeel><activiteititem><woordvoerder>${spreker("Tweede Kamerlid", "Marc", "Vervuurt", "D66", "lid Tweede Kamer")}<markeertijdbegin>2026-07-02T17:44:51</markeertijdbegin><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>De heer <nadruk type="Vet">Vervuurt</nadruk> (D66):</alineaitem><alineaitem>Voorzitter. PALLAS is een kans voor medische isotopen.</alineaitem></alinea></tekst></woordvoerder></activiteititem></activiteitdeel>
</activiteit></vergadering></vlosCoreDocument>`;

const VERGADERING_COMMISSIE = {
  Id: "ce93da1e-df49-4798-a8c0-b9735b714cf5",
  Soort: "Commissie",
  Titel: "Mensenrechtenbeleid",
  Zaal: "Groen van Prinstererzaal",
  Vergaderjaar: "2026-2027",
  VergaderingNummer: 10,
  Datum: "2026-10-05T00:00:00+02:00",
  Aanvangstijd: "2026-10-05T15:00:00+02:00",
  Verslag: [
    { Id: "11111111-1111-4111-8111-111111111111", Soort: "Voorpublicatie", Status: "Casco", GewijzigdOp: "2026-10-05T21:00:00+02:00", Verwijderd: false },
    { Id: "14d3f145-37a6-49c8-bb70-18c4b9c57186", Soort: "Tussenpublicatie", Status: "Ongecorrigeerd", GewijzigdOp: "2026-10-05T20:31:18+02:00", Verwijderd: false },
  ],
};
const VERGADERING_PLENAIR = {
  Id: "65fe4eec-8e2e-455b-b17b-78d37cc111f8",
  Soort: "Plenair",
  Titel: "90e vergadering, donderdag 2 juli 2026",
  Zaal: "Plenaire zaal",
  Vergaderjaar: "2025-2026",
  VergaderingNummer: 90,
  Datum: "2026-07-02T00:00:00+02:00",
  Aanvangstijd: "2026-07-02T10:15:00+02:00",
  Verslag: [{ Id: "8cb67de1-169d-4c00-a9e8-1c610c32e617", Soort: "Eindpublicatie", Status: "Gecorrigeerd", GewijzigdOp: "2026-10-01T12:51:34+02:00", Verwijderd: false }],
};

function mockApi(vergaderingen: unknown[], count = vergaderingen.length) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Vergadering")) return jsonResponse({ "@odata.count": count, value: vergaderingen });
    if (url.pathname.includes("/Verslag(14d3f145")) return xmlResponse(COMMISSIE_XML);
    if (url.pathname.includes("/Verslag(8cb67de1")) return xmlResponse(PLENAIR_XML);
    if (url.pathname.endsWith("/Activiteit")) return jsonResponse({ value: [{ Nummer: "2026A05426", Onderwerp: "Mensenrechtenbeleid" }] });
    return jsonResponse({ error: "unexpected" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "debat-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("parseVerslag", () => {
  const verslag = parseVerslag(COMMISSIE_XML.replace(/^\uFEFF/, ""), "v");

  it("reads the vergadering and every woordvoerder and interrumpant in spoken order, with its debat", () => {
    expect(verslag).toMatchObject({ soort: "Commissie", titel: "Mensenrechtenbeleid", datum: "2026-10-05", status: "Ongecorrigeerd", publicatie: "Tussenpublicatie" });
    expect(verslag.fragments.map((f) => [f.volgnummer, f.spreker, f.rol, f.voorzitter])).toEqual([
      [1, "Fatimazhra Belhirch", "woordvoerder", true],
      [2, "Tony van Dijck", "woordvoerder", false],
      [3, "Songül Mutluer", "interrumpant", false],
      [4, "Tom Berendsen", "woordvoerder", false],
    ]);
    expect(verslag.fragments.every((f) => f.debat === "Mensenrechtenbeleid" && f.debat_soort === "Notaoverleg")).toBe(true);
  });

  it("drops the speaker label, keeps inline text in order and a motion in an alineagroep, and leaves the interruption out of the speech", () => {
    const speech = verslag.fragments[1];
    expect(speech.tekst).toBe("Voorzitter. De persvrijheid staat onder druk in Iran.\nDe Kamer, gehoord de beraadslaging, verzoekt de regering sancties te overwegen.");
    expect(speech).toMatchObject({ fractie: "VVD", begin: "2026-10-05T15:01:00", eind: "2026-10-05T15:06:00" });
    expect(verslag.fragments[2].tekst).toBe("Geldt dat ook voor de Golfstaten, en voor het café om de hoek?");
    expect(verslag.fragments[3]).toMatchObject({ fractie: undefined, functie: "minister van Buitenlandse Zaken", spreker_soort: "Minister" });
  });

  it("takes the debat of each activiteit on a plenaire dag", () => {
    const plenair = parseVerslag(PLENAIR_XML, "p");
    expect(plenair).toMatchObject({ soort: "Plenair", vergaderjaar: "2025-2026", vergaderingnummer: "90", status: "Gecorrigeerd" });
    expect(plenair.fragments[0]).toMatchObject({ debat: "(groot project) PALLAS (CD d.d. 24/06)", spreker: "Marc Vervuurt", fractie: "D66" });
  });
});

describe("matching", () => {
  it("names a speaker as the Kamer writes it after a first name", () => {
    expect(sprekerNaam("Thom", "Van Campen")).toBe("Thom van Campen");
    expect(sprekerNaam("Tony", "Tony van Dijck")).toBe("Tony van Dijck");
    expect(sprekerNaam("Ismail", "El Abassi")).toBe("Ismail El Abassi");
    expect(sprekerNaam("", "Lammers")).toBe("Lammers");
  });

  it("matches long words inside words, short words and phrases whole, all of them, ignoring accents", () => {
    const m = textMatcher("isotopen cafe")!;
    expect(m.match(foldText("Medische isotopen in het Café"))).toBeGreaterThanOrEqual(0);
    expect(m.match("medische isotopen")).toBe(-1);
    expect(textMatcher("stikstof")!.match("de stikstofuitstoot daalt")).toBe(3);
    expect(textMatcher("EU")!.match("de eurozone")).toBe(-1);
    expect(textMatcher("EU")!.match("de eu en nederland")).toBe(3);
    expect(textMatcher('"gehoord de beraadslaging"')!.match("de kamer, gehoord  de beraadslaging, verzoekt")).toBe(10);
    expect(textMatcher("   ")).toBeUndefined();
  });

  it("matches a fractie as written or by a part of four letters or more, and a speaker by name or function", () => {
    expect(fractieMatches("VVD", "vvd")).toBe(true);
    expect(fractieMatches("Groep Markuszower", "Markuszower")).toBe(true);
    expect(fractieMatches("SGP", "SP")).toBe(false);
    const [, speech, , minister] = parseVerslag(COMMISSIE_XML.replace(/^\uFEFF/, ""), "v").fragments;
    expect(sprekerMatches(speech, "van Dijck")).toBe(true);
    expect(sprekerMatches(minister, "minister")).toBe(true);
    expect(sprekerMatches(minister, "staatssecretaris")).toBe(false);
  });

  it("cuts a snippet on word boundaries around the match", () => {
    const text = `${"aaa ".repeat(100)}stikstof ${"bbb ".repeat(100)}`;
    const snippet = snippetAt(text, text.indexOf("stikstof"), 20);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("stikstof");
  });

  it("reads the most corrected verslag and never a casco", () => {
    expect(pickVerslag(VERGADERING_COMMISSIE.Verslag)?.Id).toBe("14d3f145-37a6-49c8-bb70-18c4b9c57186");
    expect(pickVerslag([{ Id: "c", Status: "Casco" }])).toBeUndefined();
    expect(pickVerslag([
      { Id: "t", Soort: "Tussenpublicatie", Status: "Ongecorrigeerd", GewijzigdOp: "2026-10-02" },
      { Id: "e", Soort: "Eindpublicatie", Status: "Gecorrigeerd", GewijzigdOp: "2026-10-01" },
    ])?.Id).toBe("e");
  });
});

describe("tweede_kamer_debatten", () => {
  it("searches the verslagen of the period and links each fragment to its debate", async () => {
    const fetchMock = mockApi([VERGADERING_COMMISSIE, VERGADERING_PLENAIR]);
    const payload = await callTool("tweede_kamer_debatten", { query: "Iran", date_from: "2026-07-01", date_to: "2026-10-05" });

    const list = new URL(String(fetchMock.mock.calls[0][0]));
    expect(list.searchParams.get("$filter")).toBe(
      "Verwijderd eq false and Verslag/any(v:v/Verwijderd eq false and v/Status ne 'Casco') and Datum ge 2026-07-01T00:00:00+02:00 and Datum lt 2026-10-06T00:00:00+02:00",
    );
    expect(list.searchParams.get("$orderby")).toBe("Datum desc,Aanvangstijd desc");
    expect(list.searchParams.get("$top")).toBe("20");

    expect(payload.records.map((r: Payload) => r.title)).toEqual([
      "Tony van Dijck (VVD): Mensenrechtenbeleid",
      "Tom Berendsen (minister van Buitenlandse Zaken): Mensenrechtenbeleid",
    ]);
    expect(payload.records[0].canonical_url).toBe("https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=2026A05426");
    expect(payload.records[0].data).toMatchObject({ verslag_status: "Ongecorrigeerd", rol: "woordvoerder", begin: "2026-10-05T15:01:00", datum: "2026-10-05" });
    expect(payload.records[0].snippet).toContain("Iran");
    expect(payload.summary).toBe("2 fragmenten in 1 debat (2 vergaderingen doorzocht); meest aan het woord: Tony van Dijck (VVD) 1, Tom Berendsen (minister van Buitenlandse Zaken) 1");
    expect(payload.access_note).toContain("Ongecorrigeerde verslagen zijn de voorlopige tekst");
  });

  it("filters on fractie without the chair, and links a plenaire dag to its verslag on tweedekamer.nl", async () => {
    mockApi([VERGADERING_COMMISSIE, VERGADERING_PLENAIR]);
    const d66 = await callTool("tweede_kamer_debatten", { fractie: "D66", date: "2026-07-02" });
    expect(d66.records.map((r: Payload) => r.data.spreker)).toEqual(["Marc Vervuurt"]);
    expect(d66.records[0].canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/plenaire_verslagen/detail/2025-2026/90");

    const pallas = await callTool("tweede_kamer_debatten", { debat: "pallas", soort: "plenair", max_chars: 13 });
    expect(pallas.records).toHaveLength(1);
    expect(pallas.records[0].data).toMatchObject({ tekst: "Voorzitter. …", tekst_ingekort: true });
  });

  it("says how to continue when the period holds more vergaderingen than one call reads", async () => {
    const fetchMock = mockApi([VERGADERING_COMMISSIE], 45);
    const payload = await callTool("tweede_kamer_debatten", { spreker: "minister", date_from: "2026-09-01", vergadering_offset: 20 });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("$skip")).toBe("20");
    expect(payload.access_note).toContain("Doorzocht: vergadering 21 t/m 21 van 45 in deze periode");
    expect(payload.access_note).toContain("vergadering_offset=21");
  });

  it("reports a verslag it could not read instead of hiding it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      // A newer version of the verslag than the other tests read, so none of them is kept parsed.
      const newer = { ...VERGADERING_PLENAIR, Verslag: [{ ...VERGADERING_PLENAIR.Verslag[0], GewijzigdOp: "2026-10-06T08:00:00+02:00" }] };
      if (url.pathname.endsWith("/Vergadering")) return jsonResponse({ "@odata.count": 1, value: [newer] });
      return jsonResponse({ error: "down" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const payload = await callTool("tweede_kamer_debatten", { query: "pallas", date: "2026-07-02" });
    expect(payload.records).toEqual([]);
    expect(payload.access_note).toContain("kon niet worden gelezen");
  });

  it("rejects a malformed date and vergadering_id", async () => {
    mockApi([]);
    expect((await callTool("tweede_kamer_debatten", { date: "2 juli" })).error).toBeDefined();
    expect((await callTool("tweede_kamer_debatten", { vergadering_id: "90" })).error).toBeDefined();
  });
});

describe("nl_gov_ask: debate questions", () => {
  it("recognises what was said in a debate, and nothing else", () => {
    expect(detectDebatIntent("Wat zei de VVD in het debat over stikstof?")).toEqual({ fractie: "VVD", query: "stikstof" });
    expect(detectDebatIntent("Wat heeft de minister in de Tweede Kamer gezegd over Pallas?")).toEqual({ spreker: "minister", query: "Pallas" });
    expect(detectDebatIntent("Wat werd er gezegd in het stikstofdebat?")).toEqual({ debat: "stikstof" });
    expect(detectDebatIntent("Wat zei Klaver in het debat over de begroting?")).toEqual({ spreker: "Klaver", query: "begroting" });
    for (const q of [
      "Welke debatten waren er over stikstof in september?",
      "Wanneer is het debat over stikstof?",
      "Hoe stemde de VVD over de motie over stikstof?",
      "Wat zei de gemeenteraad van Utrecht over parkeren?",
      "Wat zegt de wet over huurbescherming?",
      "Welke moties zijn ingediend in het debat over Pallas?",
      "Kamerdebat over het omgevingsplan",
    ]) {
      expect(detectDebatIntent(q), q).toBeUndefined();
    }
  });

  it("plans the verslagen search with the period of the question", async () => {
    type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
    registerTools({
      registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
        tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
      },
    } as unknown as McpServer);
    const tool = tools.get("nl_gov_ask")!;
    const args: Record<string, unknown> = { question: "Wat zei de VVD vorige week in het debat over stikstof?", dryRun: true, reference_now: "2026-10-06T10:00:00+02:00" };
    const parsed: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
    const plan = JSON.parse((await tool.handler(parsed)).content[0].text);
    expect(plan.estimated_sources).toEqual(["tweede_kamer_debatten"]);
    expect(plan.planned_requests[0]).toMatchObject({ connector: "tweede_kamer", params: { fractie: "VVD", query: "stikstof", date_from: plan.temporal.from, date_to: plan.temporal.to } });
  });
});
