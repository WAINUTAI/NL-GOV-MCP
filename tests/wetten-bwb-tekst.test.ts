import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { artikelKey, parseBwbToestand, selectBwbText, splitOnderdeel, WettenBwbSource } from "../src/sources/wetten-bwb.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { xmlResponse } from "./helpers/config.js";

/** Bookkeeping as the BWB has it on every element: must never end up in the text. */
const META = (jci: string, pub = "") =>
  `<meta-data><brondata><oorspronkelijk><publicatie effect="wijziging" soort="Stb" urlidentifier="${pub}"><publicatiejaar>2002</publicatiejaar><publicatienr>54</publicatienr></publicatie></oorspronkelijk></brondata><jcis><jci versie="1.3" verwijzing="${jci}&amp;z=2026-08-15&amp;g=2026-08-15" korte-verwijzing="${jci}"/></jcis></meta-data>`;

/** A small toestand in the shape of the Awb's (KOOP BWB toestand XML), with its real text. */
const AWB_XML = `<?xml version="1.0" encoding="UTF-8"?><toestand bwb-ng-vast-deel="http://wetten.overheid.nl/id/BWBR0005537/2026-08-15/0" bwb-id="BWBR0005537" inwerkingtreding="2026-08-15"><bwb-inputbestand>BWBR0005537_2026-08-01_0</bwb-inputbestand><bwb-wijzigingen/><wetgeving soort="wet">
  <intitule bwb-ng-variabel-deel="/Intitule" status="goed">Wet van 4 juni 1992, houdende algemene regels van bestuursrecht (Algemene wet bestuursrecht) ${META("jci1.3:c:BWBR0005537")}</intitule>
  <citeertitel bwb-ng-variabel-deel="/Citeertitel" status="officieel">Algemene wet bestuursrecht${META("jci1.3:c:BWBR0005537")}</citeertitel>
  <wet-besluit><wettekst>
  <hoofdstuk bwb-ng-variabel-deel="/Hoofdstuk1" label="Hoofdstuk 1" status="goed">
    <kop><label>Hoofdstuk</label><nr>1</nr><titel>Inleidende bepalingen</titel></kop>
    <titeldeel bwb-ng-variabel-deel="/Hoofdstuk1/Titeldeel1.1" label="Titel 1.1" status="goed">
      <kop><label>Titel</label><nr>1.1</nr><titel>Definities en reikwijdte</titel></kop>
      <artikel bwb-ng-variabel-deel="/Hoofdstuk1/Titeldeel1.1/Artikel1:1" label="Artikel 1:1" inwerking="1994-01-01" bron="Stb.1994-1" status="goed">
        <kop><label>Artikel</label><nr status="officieel">1:1</nr></kop>
        <lid bwb-ng-variabel-deel="/Hoofdstuk1/Titeldeel1.1/Artikel1:1/Lid1">
          <lidnr status="officieel">1</lidnr>
          <al>Onder bestuursorgaan wordt verstaan:</al>
          <lijst type="expliciet">
            <li><li.nr>a.</li.nr><al>een orgaan van een rechtspersoon die krachtens publiekrecht is ingesteld, of</al>${META("jci1.3:c:BWBR0005537&amp;artikel=1:1&amp;lid=1")}</li>
            <li><li.nr>b.</li.nr><al>een ander persoon of college, met enig openbaar gezag bekleed.</al></li>
          </lijst>
        ${META("jci1.3:c:BWBR0005537&amp;artikel=1:1&amp;lid=1")}</lid>
      ${META("jci1.3:c:BWBR0005537&amp;artikel=1:1")}</artikel>
    ${META("jci1.3:c:BWBR0005537&amp;titeldeel=1.1")}</titeldeel>
  ${META("jci1.3:c:BWBR0005537&amp;hoofdstuk=1")}</hoofdstuk>
  <hoofdstuk bwb-ng-variabel-deel="/Hoofdstuk3" label="Hoofdstuk 3" status="goed">
    <kop><label>Hoofdstuk</label><nr>3</nr><titel>Algemene bepalingen over besluiten</titel></kop>
    <afdeling bwb-ng-variabel-deel="/Hoofdstuk3/Afdeling3.2" label="Afdeling 3.2" status="goed">
      <kop><label>Afdeling</label><nr>3.2</nr><titel status="officieel">Zorgvuldigheid en belangenafweging </titel></kop>
      <artikel bwb-ng-variabel-deel="/Hoofdstuk3/Afdeling3.2/Artikel3:4" label="Artikel 3:4" inwerking="1994-01-01" bron="Stb.1994-1" status="goed">
        <kop><label>Artikel</label><nr status="officieel">3:4</nr></kop>
        <lid bwb-ng-variabel-deel="/Hoofdstuk3/Afdeling3.2/Artikel3:4/Lid1"><lidnr status="officieel">1</lidnr><al>Het bestuursorgaan weegt de rechtstreeks bij het besluit betrokken belangen af, voor zover niet uit een wettelijk voorschrift of uit de aard van de uit te oefenen bevoegdheid een beperking voortvloeit. </al>${META("jci1.3:c:BWBR0005537&amp;artikel=3:4&amp;lid=1")}</lid>
        <lid bwb-ng-variabel-deel="/Hoofdstuk3/Afdeling3.2/Artikel3:4/Lid2"><lidnr status="officieel">2</lidnr><al>De voor een of meer belanghebbenden nadelige gevolgen van een besluit mogen niet onevenredig zijn in verhouding tot de met het besluit te dienen doelen. </al>${META("jci1.3:c:BWBR0005537&amp;artikel=3:4&amp;lid=2")}</lid>
      ${META("jci1.3:c:BWBR0005537&amp;artikel=3:4")}</artikel>
    ${META("jci1.3:c:BWBR0005537&amp;afdeling=3.2")}</afdeling>
    <afdeling bwb-ng-variabel-deel="/Hoofdstuk3/Afdeling3.5" label="Afdeling 3.5" status="goed">
      <kop><label>Afdeling</label><nr>3.5</nr><titel>Coördinatie van samenhangende besluiten</titel></kop>
      <artikel bwb-ng-variabel-deel="/Hoofdstuk3/Afdeling3.5/Artikel3:30" label="Artikel 3:30" inwerking="2005-07-01" bron="Stb.2002-54" effect="vervallen" status="vervallen">
        <kop><label>Artikel</label><nr>3:30</nr></kop>
        <al><redactie type="vervanging">Vervallen</redactie></al>${META("jci1.3:c:BWBR0005537&amp;artikel=3:30", "stb-2002-54")}</artikel>
    </afdeling>
  </hoofdstuk>
  </wettekst></wet-besluit>
  <bijlage bwb-ng-variabel-deel="/Bijlage1" label="Bijlage 1" status="goed">
    <kop><label>Bijlage</label><nr>1</nr><titel>Regeling rechtstreeks beroep</titel></kop>
    <table><title>Voorbeeld</title><tgroup cols="2"><thead><row><entry><al>Wet</al></entry><entry><al>Artikel</al></entry></row></thead>
      <tbody><row><entry><al><extref doc="jci1.3:c:BWBR0007376">Archiefwet 1995</extref></al></entry><entry><al>artikel 38</al></entry></row></tbody></tgroup></table>
  </bijlage>
</wetgeving></toestand>`;

const XML_URL = "https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0005537/2026-08-15_0/xml/BWBR0005537_2026-08-15_0.xml";

function sruRecord(opts: { id: string; title: string; start: string; end?: string }): string {
  return `<record><recordData><gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/"><originalData><overheidbwb:meta>
    <owmskern><dcterms:identifier>${opts.id}</dcterms:identifier><dcterms:title>${opts.title}</dcterms:title><dcterms:type>wet</dcterms:type></owmskern>
    <bwbipm><overheidbwb:toestand>http://wetten.overheid.nl/id/${opts.id}/${opts.start}/0</overheidbwb:toestand><overheidbwb:geldigheidsperiode_startdatum>${opts.start}</overheidbwb:geldigheidsperiode_startdatum><overheidbwb:geldigheidsperiode_einddatum>${opts.end ?? "9999-12-31"}</overheidbwb:geldigheidsperiode_einddatum></bwbipm>
  </overheidbwb:meta></originalData><enrichedData><overheidbwb:locatie_toestand>https://repository.officiele-overheidspublicaties.nl/bwb/${opts.id}/${opts.start}_0/xml/${opts.id}_${opts.start}_0.xml</overheidbwb:locatie_toestand></enrichedData></gzd></recordData></record>`;
}

function sru(total: number, records: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><numberOfRecords>${total}</numberOfRecords><records>${records.join("")}</records></searchRetrieveResponse>`;
}

const AWB = { id: "BWBR0005537", title: "Algemene wet bestuursrecht", start: "2026-08-15" };

/** A book of the BW: its artikelen are numbered without the book ("Artikel 162"), cited as "6:162". */
const BW6_XML = `<?xml version="1.0" encoding="UTF-8"?><toestand bwb-id="BWBR0005289" inwerkingtreding="2026-01-01"><wetgeving soort="wet">
  <citeertitel status="officieel">Burgerlijk Wetboek Boek 6</citeertitel>
  <wet-besluit><wettekst><boek label="Boek 6"><kop><label>Boek</label><nr>6</nr><titel>Algemeen gedeelte van het verbintenissenrecht</titel></kop>
    <artikel label="Artikel 162" inwerking="1992-01-01" status="goed">
      <kop><label>Artikel</label><nr>162</nr></kop>
      <lid><lidnr>1</lidnr><al>Hij die jegens een ander een onrechtmatige daad pleegt, welke hem kan worden toegerekend, is verplicht de schade die de ander dientengevolge lijdt, te vergoeden.</al></lid>
      <lid><lidnr>2</lidnr><al>Als onrechtmatige daad worden aangemerkt:</al>
        <lijst><li><li.nr>a.</li.nr><al>een inbreuk op een recht;</al></li>
        <li><li.nr>b.</li.nr><al>een doen of nalaten in strijd met een wettelijke plicht;</al></li>
        <li><li.nr>c.</li.nr><al>een doen of nalaten in strijd met hetgeen volgens ongeschreven recht in het maatschappelijk verkeer betaamt.</al></li></lijst>
      </lid>
    </artikel>
  </boek></wettekst></wet-besluit></wetgeving></toestand>`;
const BW6 = { id: "BWBR0005289", title: "Burgerlijk Wetboek Boek 6", start: "2026-01-01" };
const BW6_XML_URL = "https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0005289/2026-01-01_0/xml/BWBR0005289_2026-01-01_0.xml";

describe("parseBwbToestand", () => {
  const doc = parseBwbToestand(AWB_XML);

  it("reads the artikelen with label, headings, status, source and JCI reference", () => {
    expect(doc.bwbId).toBe("BWBR0005537");
    expect(doc.toestandDatum).toBe("2026-08-15");
    expect(doc.citeertitel).toBe("Algemene wet bestuursrecht");
    expect(doc.artikelen.map((a) => a.label)).toEqual(["Artikel 1:1", "Artikel 3:4", "Artikel 3:30"]);
    const a = doc.artikelen[1];
    expect(a.pad).toEqual(["Hoofdstuk 3 Algemene bepalingen over besluiten", "Afdeling 3.2 Zorgvuldigheid en belangenafweging"]);
    expect(a.status).toBe("goed");
    expect(a.inwerking).toBe("1994-01-01");
    expect(a.jci).toBe("jci1.3:c:BWBR0005537&artikel=3:4");
    expect(a.leden.map((l) => l.nr)).toEqual(["1", "2"]);
    // An old publication has no urlidentifier: no link is made up for it.
    expect(a.bronUrl).toBeUndefined();
    const vervallen = doc.artikelen[2];
    expect(vervallen.status).toBe("vervallen");
    expect(vervallen.bronUrl).toBe("https://zoek.officielebekendmakingen.nl/stb-2002-54");
  });

  it("renders leden and list items with their numbering and leaves bookkeeping out", () => {
    const text = doc.lines.join("\n");
    expect(text).toContain("Artikel 1:1\n1. Onder bestuursorgaan wordt verstaan:\n  a. een orgaan van een rechtspersoon die krachtens publiekrecht is ingesteld, of\n  b. een ander persoon of college, met enig openbaar gezag bekleed.");
    expect(text).not.toContain("jci1.3");
    expect(text).not.toContain("BWBR0005537_2026-08-01_0");
    expect(text).not.toMatch(/\b2002\b/);
    // Table rows as cells separated by |.
    expect(text).toContain("Wet | Artikel\nArchiefwet 1995 | artikel 38");
  });
});

describe("selectBwbText", () => {
  const doc = parseBwbToestand(AWB_XML);

  it("finds an artikel however its label is written", () => {
    for (const label of ["3:4", "art. 3:4", "Art 3:4", "Artikel 3:4", " ARTIKEL 3 : 4 "]) {
      const sel = selectBwbText(doc, { artikel: label, maxChars: 5000 });
      expect(sel.parts.map((p) => p.artikel?.label), label).toEqual(["Artikel 3:4"]);
    }
    expect(artikelKey("Artikel 3:4.")).toBe("3:4");
  });

  it("never reads 3.4 as 3:4, but names the artikel meant", () => {
    const sel = selectBwbText(doc, { artikel: "3.4", maxChars: 5000 });
    expect(sel.parts).toHaveLength(0);
    expect(sel.notFound?.reason).toContain("wel Artikel 3:4");
    expect(sel.notFound?.suggestions).toEqual(["Artikel 3:4"]);
  });

  it("suggests nearby labels for an artikel that does not exist", () => {
    const sel = selectBwbText(doc, { artikel: "3:5", maxChars: 5000 });
    expect(sel.notFound?.suggestions).toEqual(expect.arrayContaining(["Artikel 3:4", "Artikel 3:30"]));
  });

  it("returns one lid with the kop of its artikel, and names the leden there are", () => {
    const sel = selectBwbText(doc, { artikel: "artikel 3:4, tweede lid", maxChars: 5000 });
    expect(sel.parts[0].lid).toBe("2");
    expect(sel.parts[0].tekst).toBe("Artikel 3:4\n2. De voor een of meer belanghebbenden nadelige gevolgen van een besluit mogen niet onevenredig zijn in verhouding tot de met het besluit te dienen doelen.");
    const missing = selectBwbText(doc, { artikel: "3:4 lid 3", maxChars: 5000 });
    expect(missing.notFound?.reason).toBe("Artikel 3:4 heeft geen lid 3; wel de leden 1, 2.");
  });

  it("marks an artikel cut to max_chars", () => {
    const sel = selectBwbText(doc, { artikel: "3:4", maxChars: 50 });
    expect(sel.truncated).toBe(true);
    expect(sel.parts[0].ingekort).toBe(true);
    expect(sel.parts[0].tekst).toHaveLength(50);
    expect(sel.parts[0].tekensVolledig).toBeGreaterThan(50);
  });

  it("returns the artikelen with all words of a zoekterm, accents and case ignored", () => {
    const sel = selectBwbText(doc, { zoekterm: "Onevenredig BELANGHEBBENDEN", maxChars: 5000 });
    expect(sel.mode).toBe("zoekterm");
    expect(sel.matches).toBe(1);
    expect(sel.parts[0].artikel?.label).toBe("Artikel 3:4");
    expect(selectBwbText(doc, { zoekterm: "coordinatie", maxChars: 5000 }).matches).toBe(0);
  });

  it("reads '6:162' in a book of the BW as its artikel 162, and only there", () => {
    const bw6 = parseBwbToestand(BW6_XML);
    for (const label of ["6:162", "art. 6:162", "Artikel 162", "162"]) {
      expect(selectBwbText(bw6, { artikel: label, maxChars: 5000 }).parts.map((p) => p.artikel?.label), label).toEqual(["Artikel 162"]);
    }
    const otherBook = selectBwbText(bw6, { artikel: "3:40", maxChars: 5000 });
    expect(otherBook.notFound?.reason).toBe("'3:40' is een artikel van Boek 3 BW; deze regeling is Boek 6 BW.");
    // The Awb is no book of the BW: '6:162' stays '6:162' there.
    expect(selectBwbText(doc, { artikel: "6:162", maxChars: 5000 }).notFound?.reason).toContain("geen artikel '6:162'");
  });

  it("returns one onderdeel ('sub b', 'onder b') with the aanhef, or the whole lid when there is none", () => {
    const bw6 = parseBwbToestand(BW6_XML);
    const sub = selectBwbText(bw6, { artikel: "art. 6:162 lid 2 sub b", maxChars: 5000 });
    expect(sub.parts[0]).toMatchObject({ lid: "2", onderdeel: "b" });
    expect(sub.parts[0].tekst).toBe("Artikel 162\n2. Als onrechtmatige daad worden aangemerkt:\n  b. een doen of nalaten in strijd met een wettelijke plicht;");
    const onder = selectBwbText(doc, { artikel: "artikel 1:1, eerste lid, onder a", maxChars: 5000 });
    expect(onder.parts[0].tekst).toBe("Artikel 1:1\n1. Onder bestuursorgaan wordt verstaan:\n  a. een orgaan van een rechtspersoon die krachtens publiekrecht is ingesteld, of");
    const missing = selectBwbText(doc, { artikel: "1:1 lid 1 sub z", maxChars: 5000 });
    expect(missing.parts[0].onderdeelNietGevonden).toBe(true);
    expect(missing.parts[0].tekst).toContain("  b. een ander persoon of college");
    expect(splitOnderdeel("art. 3:4, aanhef en onder a")).toEqual({ label: "art. 3:4", onderdeel: "a" });
    expect(splitOnderdeel("Artikel 2.1")).toEqual({ label: "Artikel 2.1" });
  });

  it("returns a small regeling whole, a large one as table of contents plus its beginning", () => {
    expect(selectBwbText(doc, { maxChars: 50_000 }).mode).toBe("volledig");
    const sel = selectBwbText(doc, { maxChars: 600 });
    expect(sel.mode).toBe("begin_met_inhoudsopgave");
    expect(sel.truncated).toBe(true);
    expect(sel.inhoudsopgave).toContain("Hoofdstuk 3 Algemene bepalingen over besluiten (art. 3:4–3:30)");
    expect(sel.inhoudsopgave).toContain("  Afdeling 3.2 Zorgvuldigheid en belangenafweging (art. 3:4)");
    expect((sel.inhoudsopgave ?? "").length + sel.parts[0].tekst.length).toBeLessThanOrEqual(600);
  });
});

describe("wetten_bwb_tekst tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function callTool(args: Record<string, unknown>): Promise<Record<string, any>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bwb-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "wetten_bwb_tekst", arguments: args })) as { content: Array<{ type: string; text: string }> };
      return JSON.parse(result.content[0].text) as Record<string, any>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  /** SRU answers per CQL query; the toestand XML for its repository URL. */
  function mockBwb(answers: Record<string, string>) {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.href === XML_URL) return xmlResponse(AWB_XML);
      const query = url.searchParams.get("query") ?? "";
      const key = Object.keys(answers).find((k) => query.startsWith(k));
      return xmlResponse(key ? answers[key] : sru(0, []));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns an artikel with its version, status, deep link and provenance", async () => {
    mockBwb({ "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]) });
    const out = await callTool({ bwb_id: "BWBR0005537", artikel: "art. 3:4" });

    expect(out.summary).toContain("Artikel 3:4 Algemene wet bestuursrecht (versie geldig vanaf 2026-08-15)");
    const rec = out.records[0];
    expect(rec.canonical_url).toBe("https://wetten.overheid.nl/jci1.3:c:BWBR0005537&artikel=3:4");
    expect(rec.data.status).toBe("geldend");
    expect(rec.data.in_werking_sinds).toBe("1994-01-01");
    expect(rec.data.versie_url).toBe("https://wetten.overheid.nl/BWBR0005537/2026-08-15");
    expect(rec.data.tekst).toMatch(/^Artikel 3:4\n1\. Het bestuursorgaan weegt/);
    expect(out.provenance.endpoint).toBe(XML_URL);
    expect(out.access_note).toContain("geldig vanaf 2026-08-15, zonder bekende einddatum");
  });

  it("adds the peildatum to the deep link for an earlier version", async () => {
    const fetchMock = mockBwb({ "dcterms.identifier=BWBR0005537 and overheidbwb.geldigheidsdatum=2015-01-01": sru(1, [sruRecord(AWB)]) });
    const out = await callTool({ bwb_id: "BWBR0005537", artikel: "3:4", peildatum: "2015-01-01" });

    expect(out.records[0].canonical_url).toBe("https://wetten.overheid.nl/jci1.3:c:BWBR0005537&artikel=3:4&g=2015-01-01");
    expect(out.records[0].data.peildatum).toBe("2015-01-01");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("query")).toBe("dcterms.identifier=BWBR0005537 and overheidbwb.geldigheidsdatum=2015-01-01");
  });

  it("says a vervallen artikel is vervallen and since when", async () => {
    mockBwb({ "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]) });
    const out = await callTool({ bwb_id: "BWBR0005537", artikel: "3:30" });

    expect(out.summary).toContain("— vervallen");
    expect(out.records[0].data.status).toBe("vervallen");
    expect(out.access_note).toContain("Artikel 3:30 is vervallen sinds 2005-07-01 (Stb.2002-54)");
  });

  it("resolves wet by its official afkorting", async () => {
    mockBwb({
      "overheidbwb.afkorting=Awb and": sru(1, [sruRecord(AWB)]),
      "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]),
    });
    const out = await callTool({ wet: "Awb", artikel: "3:4" });

    expect(out.records[0].data.bwb_id).toBe("BWBR0005537");
    expect(out.access_note).toContain("afkorting 'Awb' = Algemene wet bestuursrecht");
  });

  it("returns the candidates for an ambiguous wet instead of guessing", async () => {
    mockBwb({
      "overheidbwb.afkorting=Ow and": sru(2, [
        sruRecord({ id: "BWBR0001842", title: "Onteigeningswet", start: "2024-01-01" }),
        sruRecord({ id: "BWBR0037885", title: "Omgevingswet", start: "2026-07-01" }),
      ]),
    });
    const out = await callTool({ wet: "Ow", artikel: "2.1" });

    expect(out.summary).toContain("niet eenduidig");
    expect(out.records.map((r: { data: { bwb_id: string } }) => r.data.bwb_id)).toEqual(["BWBR0001842", "BWBR0037885"]);
    expect(out.records[0].data.tekst).toBeUndefined();
  });

  it("never reads a regeling that only has the words of wet in its title as the one meant", async () => {
    const fetchMock = mockBwb({
      "overheidbwb.titel=Wro and": sru(1, [sruRecord({ id: "BWBR0023913", title: "Invoeringswet Wet ruimtelijke ordening", start: "2018-07-01" })]),
    });
    const out = await callTool({ wet: "Wro" });

    expect(out.summary).toContain("'Wro' is geen titel of afkorting");
    expect(out.records.map((r: { data: { bwb_id: string } }) => r.data.bwb_id)).toEqual(["BWBR0023913"]);
    expect(out.records[0].data.tekst).toBeUndefined();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("repository.officiele-overheidspublicaties.nl"))).toBe(false);
  });

  it("finds a repealed regeling by its afkorting and says it has no version on the peildatum", async () => {
    const WOB = { id: "BWBR0005252", title: "Wet openbaarheid van bestuur", start: "2018-07-28", end: "2022-04-30" };
    mockBwb({
      "overheidbwb.afkorting=Wob and": sru(0, []),
      "overheidbwb.afkorting=Wob": sru(12, [sruRecord({ ...WOB, start: "2001-09-01", end: "2003-06-29" }), sruRecord(WOB)]),
      "dcterms.identifier=BWBR0005252 and": sru(0, []),
      "dcterms.identifier=BWBR0005252": sru(2, [sruRecord({ ...WOB, start: "2001-09-01", end: "2003-06-29" }), sruRecord(WOB)]),
    });
    const out = await callTool({ wet: "Wob" });

    // An answer without records, as in rechtspraak_uitspraak_get: not an error.
    expect(out.error).toBeUndefined();
    expect(out.records).toEqual([]);
    expect(out.provenance.query_params).toMatchObject({ wet: "Wob", bwb_id: "BWBR0005252", niet_gevonden: "versie" });
    expect(out.summary).toContain("Wet openbaarheid van bestuur (BWBR0005252) heeft geen versie die geldig is op");
    expect(out.access_note).toContain("2001-09-01 t/m 2022-04-30");
  });

  it("lists the regelingen sharing an afkorting when none is geldig on the peildatum", async () => {
    mockBwb({
      "overheidbwb.afkorting=Wro and": sru(0, []),
      "overheidbwb.afkorting=Wro": sru(37, [
        sruRecord({ id: "BWBR0002375", title: "Wet op de Ruimtelijke Ordening", start: "2006-01-01", end: "2008-06-30" }),
        sruRecord({ id: "BWBR0020449", title: "Wet ruimtelijke ordening", start: "2023-01-01", end: "2023-12-31" }),
      ]),
    });
    const out = await callTool({ wet: "Wro" });

    expect(out.summary).toContain("geen geldt op");
    expect(out.records.map((r: { data: { bwb_id: string } }) => r.data.bwb_id)).toEqual(["BWBR0002375", "BWBR0020449"]);
    expect(out.access_note).toContain("geen daarvan geldt op");
  });

  it("names a missing artikel, without records, with the labels there are", async () => {
    mockBwb({ "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]) });
    const out = await callTool({ bwb_id: "BWBR0005537", artikel: "3.4" });

    expect(out.error).toBeUndefined();
    expect(out.records).toEqual([]);
    expect(out.provenance.query_params).toMatchObject({ bwb_id: "BWBR0005537", artikel: "3.4", niet_gevonden: "artikel" });
    expect(out.summary).toContain("Artikel '3.4' niet gevonden");
    expect(out.access_note).toContain("wel Artikel 3:4");
  });

  it("says when a regeling has no version on the peildatum, with the period it has", async () => {
    mockBwb({
      "dcterms.identifier=BWBR0005537 and": sru(0, []),
      "dcterms.identifier=BWBR0005537": sru(2, [sruRecord({ ...AWB, start: "1994-01-01", end: "1994-12-31" }), sruRecord(AWB)]),
    });
    const out = await callTool({ bwb_id: "BWBR0005537", peildatum: "1990-01-01" });

    expect(out.records).toEqual([]);
    expect(out.provenance.query_params.niet_gevonden).toBe("versie");
    expect(out.summary).toContain("heeft geen versie die geldig is op 1990-01-01");
    expect(out.access_note).toContain("1994-01-01 t/m heden");
  });

  it("calls an unknown id unknown", async () => {
    mockBwb({});
    const out = await callTool({ bwb_id: "BWBR9999999" });

    expect(out.records).toEqual([]);
    expect(out.provenance.query_params).toMatchObject({ bwb_id: "BWBR9999999", niet_gevonden: "bwb_id" });
    expect(out.summary).toContain("Onbekend BWB-id BWBR9999999");
  });

  it("refuses something that is not a BWB id without a request", async () => {
    const fetchMock = mockBwb({});
    const out = await callTool({ bwb_id: "Awb" });

    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("geen BWB-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("states that the table of contents and text are cut", async () => {
    mockBwb({ "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]) });
    const out = await callTool({ bwb_id: "BWBR0005537", max_chars: 500 });

    expect(out.summary).toContain("Begin van Algemene wet bestuursrecht met inhoudsopgave");
    expect(out.records[0].data.afgekapt).toBe(true);
    expect(out.records[0].data.inhoudsopgave).toContain("Hoofdstuk 1 Inleidende bepalingen");
    expect(out.access_note).toContain("getoond: de inhoudsopgave");
  });

  it("reads a BW artikel as '6:162' and an onderdeel as 'lid 2 sub b', also with wet 'BW'", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.href === BW6_XML_URL) return xmlResponse(BW6_XML);
      return xmlResponse((url.searchParams.get("query") ?? "").startsWith("dcterms.identifier=BWBR0005289 and") ? sru(1, [sruRecord(BW6)]) : sru(0, []));
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await callTool({ wet: "BW boek 6", artikel: "art. 6:162 lid 2 sub b" });
    expect(out.summary).toContain("Artikel 162 lid 2 onder b");
    expect(out.records[0].data).toMatchObject({ bwb_id: "BWBR0005289", lid: "2", onderdeel: "b" });
    expect(out.records[0].data.tekst).toContain("b. een doen of nalaten in strijd met een wettelijke plicht");
    expect(out.records[0].data.tekst).not.toContain("a. een inbreuk");

    const bw = await callTool({ wet: "BW", artikel: "6:162" });
    expect(bw.records[0].data.artikel).toBe("Artikel 162");
    expect(bw.access_note).toContain("Burgerlijk Wetboek Boek 6");
    // 'BW' with a book read from the artikel: no afkorting lookup for 'BW'.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("afkorting"))).toBe(false);
  });

  it("resolves a wet with zero-width and bidi characters in it", async () => {
    const fetchMock = mockBwb({
      "overheidbwb.afkorting=Awb and": sru(1, [sruRecord(AWB)]),
      "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]),
    });
    const out = await callTool({ wet: "Awb​‮‏", artikel: "3:4​" });

    expect(out.records[0].data.artikel).toBe("Artikel 3:4");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("query")).toMatch(/^overheidbwb\.afkorting=Awb and /);
  });

  it("calls a law the BWB does not know not found, without records", async () => {
    mockBwb({});
    const out = await callTool({ wet: "Fantasiewet", artikel: "3" });

    expect(out.error).toBeUndefined();
    expect(out.records).toEqual([]);
    expect(out.provenance.query_params).toMatchObject({ wet: "Fantasiewet", niet_gevonden: "wet" });
    expect(out.summary).toContain("Geen regeling gevonden met 'Fantasiewet'");
  });

  it("reports a BWB that answers without an SRU response as a failure, not as an unknown law", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>Onderhoud</body></html>", { status: 200, headers: { "content-type": "text/html" } })));
    const out = await callTool({ wet: "Awb", artikel: "3:4" });

    expect(out.error).toBe("malformed_response");
  });

  it("keeps zoekterm hits to the artikel's own fields, the regeling once in access_note", async () => {
    mockBwb({ "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]) });
    const out = await callTool({ bwb_id: "BWBR0005537", zoekterm: "bestuursorgaan" });

    expect(out.records.length).toBeGreaterThan(0);
    for (const r of out.records) {
      expect(Object.keys(r.data).sort()).toEqual(expect.arrayContaining(["artikel", "bwb_id", "tekst"]));
      expect(r.data.versie_url).toBeUndefined();
      expect(r.data.xml_url).toBeUndefined();
      expect(r.snippet).toBeUndefined();
    }
    expect(out.access_note).toContain("Versie (toestand) van Algemene wet bestuursrecht (BWBR0005537)");
  });

  it("downloads and parses a toestand once for two calls at the same time", async () => {
    const fetchMock = mockBwb({ "dcterms.identifier=BWBR0005537 and": sru(1, [sruRecord(AWB)]) });
    const source = new WettenBwbSource(loadConfig());
    const [a, b] = await Promise.all([source.tekst({ bwb_id: "BWBR0005537", artikel: "3:4" }), source.tekst({ bwb_id: "BWBR0005537", artikel: "1:1" })]);

    expect(a.kind === "tekst" && a.selection.parts[0].artikel?.label).toBe("Artikel 3:4");
    expect(b.kind === "tekst" && b.selection.parts[0].artikel?.label).toBe("Artikel 1:1");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === XML_URL)).toHaveLength(1);
  });

  it("reports a maintenance page, a cut-off or an empty toestand as a failure and does not keep it", async () => {
    for (const bad of ["<html><body><h1>Onderhoud</h1></body></html>", AWB_XML.slice(0, AWB_XML.indexOf("Artikel 3:4")), ""]) {
      clearHttpCache();
      let poisoned = true;
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        if (url.href === XML_URL) return poisoned ? new Response(bad, { status: 200, headers: { "content-type": bad.startsWith("<html") ? "text/html" : "application/xml" } }) : xmlResponse(AWB_XML);
        return xmlResponse((url.searchParams.get("query") ?? "").startsWith("dcterms.identifier=BWBR0005537 and") ? sru(1, [sruRecord(AWB)]) : sru(0, []));
      });
      vi.stubGlobal("fetch", fetchMock);
      const source = new WettenBwbSource(loadConfig());

      await expect(source.tekst({ bwb_id: "BWBR0005537", artikel: "3:4" })).rejects.toMatchObject({ name: "BwbTekstError", kind: "upstream" });
      poisoned = false;
      const ok = await source.tekst({ bwb_id: "BWBR0005537", artikel: "3:4" });
      expect(ok.kind === "tekst" && ok.selection.parts[0].artikel?.label).toBe("Artikel 3:4");
      expect(fetchMock.mock.calls.filter((c) => String(c[0]) === XML_URL)).toHaveLength(2);
    }
  });

  it("answers malformed_response for a maintenance page instead of an artikel not found", async () => {
    // A version of its own: the tool's source may still hold the toestand of AWB from an earlier test.
    const version = { ...AWB, start: "2026-09-01" };
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.hostname === "repository.officiele-overheidspublicaties.nl") return new Response("<html><body>Onderhoud</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      return xmlResponse((url.searchParams.get("query") ?? "").startsWith("dcterms.identifier=BWBR0005537 and") ? sru(1, [sruRecord(version)]) : sru(0, []));
    }));
    const out = await callTool({ bwb_id: "BWBR0005537", artikel: "3:4" });

    expect(out.error).toBe("malformed_response");
    expect(out.message).toContain("een HTML-pagina in plaats van XML");
  });
});

describe("wetten_bwb_search tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("says a page past the last regeling is empty instead of counting the regelingen not on it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(sru(1, [sruRecord(AWB)]))));
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bwb-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "wetten_bwb_search", arguments: { query: "Algemene wet bestuursrecht", offset: 50 } })) as { content: Array<{ text: string }> };
      const out = JSON.parse(result.content[0].text);
      expect(out.records).toEqual([]);
      expect(out.summary).toBe("Geen BWB wetten op deze pagina: offset 50 ligt voorbij de 1 opgehaalde");

      const long = (await client.callTool({ name: "wetten_bwb_search", arguments: { query: "w".repeat(501) } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(long.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
