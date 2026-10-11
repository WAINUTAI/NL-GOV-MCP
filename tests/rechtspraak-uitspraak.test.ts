import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import {
  findBeslissing,
  findOverwegingen,
  normalizeEcli,
  readEcliInput,
  sectieIsReadable,
  parseUitspraakXml,
  selectUitspraakText,
  uitspraakInhoudsopgave,
} from "../src/sources/rechtspraak.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";

type Payload = Record<string, any>;

const CONTENT = "https://data.rechtspraak.nl/uitspraken/content";

const RS = 'xmlns="http://www.rechtspraak.nl/schema/rechtspraak-1.0"';

function rdf(ecli: string, extra = "", page = true): string {
  return `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ecli="https://e-justice.europa.eu/ecli" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:psi="http://psi.rechtspraak.nl/" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
    <rdf:Description>
      <dcterms:identifier>${ecli}</dcterms:identifier>
      <dcterms:modified>2025-11-20T12:21:14</dcterms:modified>
      <dcterms:issued rdfs:label="Publicatiedatum">2019-12-20</dcterms:issued>
      <dcterms:creator rdfs:label="Instantie" resourceIdentifier="http://standaarden.overheid.nl/owms/terms/Hoge_Raad_der_Nederlanden">Hoge Raad</dcterms:creator>
      <dcterms:date rdfs:label="Uitspraakdatum">2019-12-20</dcterms:date>
      <psi:zaaknummer rdfs:label="Zaaknr">19/00135</psi:zaaknummer>
      <dcterms:type rdf:language="nl" resourceIdentifier="http://psi.rechtspraak.nl/uitspraak">Uitspraak</dcterms:type>
      <psi:procedure rdfs:label="Procedure" resourceIdentifier="http://psi.rechtspraak.nl/procedure#cassatie">Cassatie</psi:procedure>
      <dcterms:subject rdfs:label="Rechtsgebied" resourceIdentifier="http://psi.rechtspraak.nl/rechtsgebied#civielRecht">Civiel recht</dcterms:subject>
      ${extra}
    </rdf:Description>
    ${page ? `<rdf:Description rdf:about="http://deeplink.rechtspraak.nl/uitspraak?id=${ecli}">
      <dcterms:identifier>http://deeplink.rechtspraak.nl/uitspraak?id=${ecli}</dcterms:identifier>
      <dcterms:title rdf:language="nl">${ecli} Hoge Raad , 20-12-2019 / 19/00135</dcterms:title>
    </rdf:Description>` : ""}
  </rdf:RDF>`;
}

const RELATIONS = `
      <dcterms:relation rdfs:label="Formele relatie" ecli:resourceIdentifier="ECLI:NL:GHDHA:2018:2591" psi:type="http://psi.rechtspraak.nl/cassatie" psi:aanleg="http://psi.rechtspraak.nl/eerdereAanleg" psi:gevolg="http://psi.rechtspraak.nl/gevolg#bekrachtiging/bevestiging">In cassatie op : ECLI:NL:GHDHA:2018:2591, Bekrachtiging/bevestiging</dcterms:relation>
      <dcterms:relation rdfs:label="Formele relatie" ecli:resourceIdentifier="ECLI:NL:PHR:2019:887" psi:type="http://psi.rechtspraak.nl/conclusie" psi:aanleg="http://psi.rechtspraak.nl/eerdereAanleg" psi:gevolg="http://psi.rechtspraak.nl/gevolg#gevolgd">Conclusie: ECLI:NL:PHR:2019:887, Gevolgd</dcterms:relation>
      <dcterms:references rdfs:label="Wetsverwijzing">Algemene wet bestuursrecht 8:1</dcterms:references>
      <dcterms:hasVersion rdfs:label="Vindplaatsen"><rdf:list><rdf:li>Rechtspraak.nl</rdf:li><rdf:li>AB 2020/24</rdf:li></rdf:list></dcterms:hasVersion>`;

/** A cassation ruling as the HR publishes it: sections with numbered titles, paragroups, a footnote, role="beslissing". */
const ARREST = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:HR:2019:2006", RELATIONS)}
  <inhoudsindicatie id="ECLI:NL:HR:2019:2006:INH" ${RS}>
    <parablock><para>Klimaatzaak Urgenda. Bevel aan Staat om maatregelen te nemen tegen klimaatverandering.</para></parablock>
  </inhoudsindicatie>
  <uitspraak id="ECLI:NL:HR:2019:2006:DOC" ${RS}>
    <uitspraak.info>
      <parablock><para>HOGE RAAD DER NEDERLANDEN</para></parablock>
      <parablock><para>In de zaak van</para><para>DE STAAT DER NEDERLANDEN,</para><para>tegen</para><para>[verweerster],</para></parablock>
    </uitspraak.info>
    <section>
      <title><nr>1</nr>Procesverloop </title>
      <para>Voor het verloop van het geding verwijst de Hoge Raad naar het arrest van het hof.</para>
    </section>
    <section>
      <title><nr>2</nr>Uitgangspunten en feiten</title>
      <paragroup>
        <nr>2.1</nr>
        <para>In cassatie kan worden uitgegaan van de feiten die de rechtbank heeft vastgesteld.<footnote-ref linkend="_fn1" /></para>
        <para>De uitstoot van broeikasgassen draagt bij aan klimaatverandering.</para>
      </paragroup>
    </section>
    <section>
      <title><nr>3</nr>De cassatieklachten</title>
      <paragroup>
        <nr>3.1</nr>
        <para>De Staat klaagt dat het hof een te ruime zorgplicht heeft aangenomen.</para>
      </paragroup>
    </section>
    <section>
      <title><nr>4</nr>Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen?</title>
      <paragroup>
        <nr>4.1</nr>
        <para>Het EVRM verplicht de verdragsstaten om de daarin omschreven rechten te verzekeren.</para>
      </paragroup>
      <paragroup>
        <nr>4.2</nr>
        <para>Op de Staat rust een zorgplicht om <emphasis role="italic">passende</emphasis> maatregelen te nemen,<?linebreak?>ook als het risico pas over enkele decennia intreedt.</para>
        <para>Dat volgt uit art. 2 en 8 EVRM.</para>
      </paragroup>
    </section>
    <section role="beslissing">
      <title><nr>5</nr>Beslissing</title>
      <para>De Hoge Raad:</para>
      <para>- verwerpt het beroep;</para>
      <para>- veroordeelt de Staat in de kosten van het geding in cassatie.</para>
      <parablock><para>Dit arrest is gewezen door de vicepresident als voorzitter.</para></parablock>
      <parablock><para><emphasis role="bold">Bijlage</emphasis></para></parablock>
      <table><tgroup cols="2"><tbody><row><entry><para>EVRM</para></entry><entry><para>Europees Verdrag voor de Rechten van de Mens</para></entry></row></tbody></tgroup></table>
    </section>
    <footnote id="_fn1" label="1"><para>Rechtbank Den Haag 24 juni 2015, ECLI:NL:RBDHA:2015:7145.</para></footnote>
  </uitspraak>
</open-rechtspraak>`;

/** A ruling without section markup: numbered heading lines, as older rulings have. */
const OUD_ARREST = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:HR:2005:AU4019", '<dcterms:replaces rdfs:label="Vervangt">AU4019</dcterms:replaces>')}
  <inhoudsindicatie ${RS}><para>-</para></inhoudsindicatie>
  <uitspraak ${RS}>
    <para>Hoge Raad der Nederlanden</para>
    <para>Arrest</para>
    <para>1. Het geding in feitelijke instanties</para>
    <para>[eiseres] heeft bij exploot gevorderd dat de rechtbank haar vordering toewijst.</para>
    <para>2. Beoordeling van het middel</para>
    <para>2.1 Het middel faalt.</para>
    <para>Het hof heeft de belangen op juiste wijze afgewogen.</para>
    <para>2.2 Ook de overige klachten falen.</para>
    <para>3. Beslissing</para>
    <parablock>
      <para>De Hoge Raad:</para>
      <para>verwerpt het beroep;</para>
    </parablock>
  </uitspraak>
</open-rechtspraak>`;

/** A ruling whose sections carry titles but no roles. */
const TITLED = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:RBOVE:2026:6034")}
  <uitspraak ${RS}>
    <section><title><nr>1</nr>De procedure</title><para>Het verloop van de procedure blijkt uit de dagvaarding.</para></section>
    <section><title><nr>2</nr>De feiten</title><paragroup><nr>2.1.</nr><para>[eiser] en [gedaagde] zijn erfgenamen.</para></paragroup></section>
    <section><title><nr>3</nr>Het geschil</title><paragroup><nr>3.1.</nr><para>[eiser] vordert inzage in stukken.</para></paragroup></section>
    <section><title><nr>4</nr>De beoordeling</title><paragroup><nr>4.1.</nr><para>Op grond van artikel 4:78 BW heeft [eiser] recht op inzage.</para></paragroup></section>
    <section><title><nr>5</nr>De beslissing</title><paragroup><nr>5.1.</nr><para>veroordeelt [gedaagde] de stukken te verstrekken.</para></paragroup></section>
  </uitspraak>
</open-rechtspraak>`;

/** A conclusie of an Advocaat-Generaal: <conclusie> instead of <uitspraak>, ending in "Conclusie". */
const CONCLUSIE = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:PHR:2019:887", '<dcterms:relation rdfs:label="Formele relatie" ecli:resourceIdentifier="ECLI:NL:HR:2019:2006" psi:type="http://psi.rechtspraak.nl/conclusie" psi:aanleg="http://psi.rechtspraak.nl/latereAanleg" psi:gevolg="http://psi.rechtspraak.nl/gevolg#gevolgd">Arrest Hoge Raad: ECLI:NL:HR:2019:2006, Gevolgd</dcterms:relation>').replace(">Uitspraak<", ">Conclusie<")}
  <conclusie ${RS}>
    <section role="procesverloop"><title><nr>1</nr>Feiten en procesverloop</title><para>Urgenda heeft de Staat gedagvaard.</para></section>
    <section><title><nr>2</nr>Inleidende beschouwingen</title><paragroup><nr>2.1</nr><para>De zaak gaat over de reductie van broeikasgassen.</para></paragroup></section>
    <section><title><nr>3</nr>Conclusie</title><para>De conclusie strekt tot verwerping van het cassatieberoep.</para><para>Lijst van gebruikte afkortingen</para><para>AR4 Fourth Assessment Report</para></section>
  </conclusie>
</open-rechtspraak>`;

/** Registered but not (yet) published: metadata only. */
const ALLEEN_METADATA = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:RBOVE:2026:6000", "", false)}
</open-rechtspraak>`;

/** A CRvB ruling: a section role="overwegingen" that is only a heading, the reasoning in the unmarked sections after it. */
const KOP_OVERWEGINGEN = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:CRVB:2026:1271")}
  <uitspraak ${RS}>
    <section role="procesverloop"><title>PROCESVERLOOP</title><para>Het college heeft een verweerschrift ingediend.</para></section>
    <section role="overwegingen"><title>OVERWEGINGEN</title></section>
    <section><title>Inleiding</title><para>Appellant ontving bijstand op grond van de Participatiewet.</para></section>
    <section><title>Het oordeel van de Raad</title><para>Het college heeft de bijstand terecht teruggevorderd.</para></section>
    <section role="beslissing"><title>BESLISSING</title><para>De Raad bevestigt de aangevallen uitspraak.</para></section>
    <section><title>Bijlage: wettelijke regels</title><para>Artikel 58 Participatiewet.</para></section>
  </uitspraak>
</open-rechtspraak>`;

/** A tuchtrecht ruling: registered at Rechtspraak with metadata only, published on tuchtrecht.overheid.nl. */
const TUCHTRECHT = `<?xml version="1.0" encoding="utf-8"?>
<open-rechtspraak>
  ${rdf("ECLI:NL:TGZRAMS:2024:1", "", false).replace("</rdf:RDF>", `<rdf:Description rdf:about="http://tuchtrecht.overheid.nl/ECLI_NL_TGZRAMS_2024_1">
      <dcterms:identifier>http://tuchtrecht.overheid.nl/ECLI_NL_TGZRAMS_2024_1</dcterms:identifier>
      <dcterms:publisher resourceIdentifier="http://tuchtrecht.overheid.nl/">tuchtrecht.overheid.nl</dcterms:publisher>
    </rdf:Description>
  </rdf:RDF>`)}
</open-rechtspraak>`;

const NOT_FOUND = { type: "https://tools.ietf.org/html/rfc9110#section-15.5.5", title: "Not Found", status: 404 };

function mockContent(byEcli: Record<string, Response | (() => Response)>) {
  const urls: string[] = [];
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const id = new URL(url).searchParams.get("id") ?? "";
    const r = byEcli[id];
    if (!r) return jsonResponse(NOT_FOUND, 404);
    return typeof r === "function" ? r() : r.clone();
  });
  vi.stubGlobal("fetch", fn);
  return urls;
}

async function callTool(args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rechtspraak-uitspraak-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "rechtspraak_uitspraak_get", arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("normalizeEcli", () => {
  it("reads an ECLI in any case, in a link, %-encoded or at the end of a sentence", () => {
    expect(normalizeEcli("ecli:nl:hr:2019:2006")).toBe("ECLI:NL:HR:2019:2006");
    expect(normalizeEcli("https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:RBOVE:2026:6034")).toBe("ECLI:NL:RBOVE:2026:6034");
    expect(normalizeEcli("ECLI%3ANL%3APHR%3A2019%3A887")).toBe("ECLI:NL:PHR:2019:887");
    expect(normalizeEcli("Zie ECLI:NL:HR:2005:AU4019.")).toBe("ECLI:NL:HR:2005:AU4019");
    expect(normalizeEcli("ECLI:NL:XX")).toBeUndefined();
    expect(normalizeEcli("19/00135")).toBeUndefined();
  });
});

describe("parseUitspraakXml", () => {
  it("reads metadata, relations and the text in document order", () => {
    const doc = parseUitspraakXml(ARREST, "ECLI:NL:HR:2019:2006");
    expect(doc.soort).toBe("uitspraak");
    expect(doc.meta).toMatchObject({
      ecli: "ECLI:NL:HR:2019:2006",
      titel: "ECLI:NL:HR:2019:2006 Hoge Raad, 20-12-2019 / 19/00135",
      instantie: "Hoge Raad",
      uitspraakdatum: "2019-12-20",
      zaaknummer: "19/00135",
      procedures: ["Cassatie"],
      wetsverwijzingen: ["Algemene wet bestuursrecht 8:1"],
      vindplaatsen: ["Rechtspraak.nl", "AB 2020/24"],
      deeplink: "http://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:HR:2019:2006",
    });
    expect(doc.meta.relaties).toEqual([
      { ecli: "ECLI:NL:GHDHA:2018:2591", omschrijving: "In cassatie op: ECLI:NL:GHDHA:2018:2591, Bekrachtiging/bevestiging", soort: "cassatie", aanleg: "eerdere aanleg", gevolg: "bekrachtiging/bevestiging" },
      { ecli: "ECLI:NL:PHR:2019:887", omschrijving: "Conclusie: ECLI:NL:PHR:2019:887, Gevolgd", soort: "conclusie", aanleg: "eerdere aanleg", gevolg: "gevolgd" },
    ]);
    expect(doc.inhoudsindicatie).toContain("Klimaatzaak Urgenda");
    // Paragraph numbers, footnote references and line breaks survive; anonymisation stays as published.
    const texts = doc.blocks.map((b) => b.text);
    expect(texts).toContain("[verweerster],");
    expect(texts).toContain("2.1 In cassatie kan worden uitgegaan van de feiten die de rechtbank heeft vastgesteld.[noot 1]");
    expect(texts).toContain("4.2 Op de Staat rust een zorgplicht om passende maatregelen te nemen,\nook als het risico pas over enkele decennia intreedt.");
    expect(doc.blocks.find((b) => b.text === "Dat volgt uit art. 2 en 8 EVRM.")?.nr).toBe("4.2");
    expect(doc.footnotes).toEqual([{ label: "1", text: "Rechtbank Den Haag 24 juni 2015, ECLI:NL:RBDHA:2015:7145." }]);
    expect(uitspraakInhoudsopgave(doc).map((e) => `${e.sectie} ${e.titel}${e.rol ? ` (${e.rol})` : ""}`)).toEqual([
      "kop Kop (gerecht, partijen, zaaknummer)",
      "1 Procesverloop",
      "2 Uitgangspunten en feiten",
      "3 De cassatieklachten",
      "4 Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen?",
      "5 Beslissing (beslissing)",
    ]);
  });

  it("finds the beslissing by role, by section title, by heading line, and the conclusie of an A-G", () => {
    const byRole = findBeslissing(parseUitspraakXml(ARREST, "x"));
    expect(byRole?.methode).toMatch(/^rol: sectie gemarkeerd als role="beslissing"; de bijlage erna is niet meegenomen/);

    const byTitle = findBeslissing(parseUitspraakXml(TITLED, "x"));
    expect(byTitle).toMatchObject({ label: "5 De beslissing", methode: "sectietitel '5 De beslissing'" });

    const oud = parseUitspraakXml(OUD_ARREST, "x");
    expect(oud.inhoudsindicatie).toBeUndefined();
    expect(oud.meta.vervangt).toBe("AU4019");
    expect(oud.sections.map((s) => `${s.nr} ${s.title}`)).toEqual(["1 Het geding in feitelijke instanties", "2 Beoordeling van het middel", "3 Beslissing"]);
    expect(findBeslissing(oud)?.methode).toBe("kopregel '3. Beslissing' in de tekst (geen sectie-opmaak)");

    const conclusie = parseUitspraakXml(CONCLUSIE, "x");
    expect(conclusie.soort).toBe("conclusie");
    const advies = findBeslissing(conclusie);
    expect(advies?.methode).toMatch(/^conclusie van de Advocaat-Generaal: sectie '3 Conclusie'/);
    expect(selectUitspraakText(conclusie, { onderdeel: "beslissing" }).tekst).toBe("## 3 Conclusie\nDe conclusie strekt tot verwerping van het cassatieberoep.");
  });

  it("finds the overwegingen by title, or between the opening sections and the beslissing", () => {
    expect(findOverwegingen(parseUitspraakXml(TITLED, "x"))).toMatchObject({ label: "4 De beoordeling", methode: "sectietitel '4 De beoordeling'" });
    const arrest = findOverwegingen(parseUitspraakXml(ARREST, "x"));
    expect(arrest?.label).toBe("3 De cassatieklachten; 4 Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen?");
    expect(arrest?.methode).toMatch(/^positie: de secties tussen '2 Uitgangspunten en feiten' en de beslissing/);
  });

  it("a marked overwegingen section of only a heading runs on through the unmarked sections up to the beslissing", () => {
    const doc = parseUitspraakXml(KOP_OVERWEGINGEN, "x");
    const found = findOverwegingen(doc);
    expect(found?.label).toBe("OVERWEGINGEN; Inleiding; Het oordeel van de Raad");
    expect(found?.methode).toContain("alleen een kop");
    expect(selectUitspraakText(doc, { onderdeel: "overwegingen" }).tekst).toBe(
      "## OVERWEGINGEN\n\n## Inleiding\nAppellant ontving bijstand op grond van de Participatiewet.\n\n## Het oordeel van de Raad\nHet college heeft de bijstand terecht teruggevorderd.",
    );
  });
});

describe("rechtspraak_uitspraak_get", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearHttpCache();
  });

  it("overzicht: metadata, relations, inhoudsopgave and the beslissing without the bijlage", async () => {
    const urls = mockContent({ "ECLI:NL:HR:2019:2006": xmlResponse(ARREST) });
    const out = await callTool({ ecli: "ecli:nl:hr:2019:2006" });
    expect(urls).toEqual([`${CONTENT}?id=ECLI%3ANL%3AHR%3A2019%3A2006`]);
    expect(out.summary).toBe("ECLI:NL:HR:2019:2006 Hoge Raad, 20-12-2019 / 19/00135: overzicht met beslissing (5 Beslissing)");
    const rec = out.records[0];
    expect(rec.canonical_url).toBe("https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:HR:2019:2006");
    expect(rec.date).toBe("2019-12-20");
    expect(rec.data).toMatchObject({
      ecli: "ECLI:NL:HR:2019:2006",
      documenttype: "Uitspraak",
      data_url: `${CONTENT}?id=ECLI:NL:HR:2019:2006`,
      tekst_gepubliceerd: true,
      onderdeel: "overzicht",
      ingekort: false,
    });
    expect(rec.data.relaties).toHaveLength(2);
    expect(rec.data.inhoudsopgave).toHaveLength(6);
    expect(rec.data.tekst).toBe("## 5 Beslissing\nDe Hoge Raad:\n- verwerpt het beroep;\n- veroordeelt de Staat in de kosten van het geding in cassatie.\nDit arrest is gewezen door de vicepresident als voorzitter.");
    expect(out.access_note).toContain('Beslissing gevonden via rol: sectie gemarkeerd als role="beslissing"');
    expect(out.provenance).toMatchObject({ tool: "rechtspraak_uitspraak_get", returned_results: 1, total_results: 1 });
  });

  it("volledig: the whole text with headings and footnotes, cut at max_chars and saying so", async () => {
    mockContent({ "ECLI:NL:HR:2019:2006": xmlResponse(ARREST) });
    const full = await callTool({ ecli: "ECLI:NL:HR:2019:2006", onderdeel: "volledig", max_chars: 50000 });
    const tekst: string = full.records[0].data.tekst;
    expect(tekst).toContain("## 4 Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen?");
    expect(tekst).toContain("EVRM | Europees Verdrag voor de Rechten van de Mens");
    expect(tekst.endsWith("Voetnoten:\n[noot 1] Rechtbank Den Haag 24 juni 2015, ECLI:NL:RBDHA:2015:7145.")).toBe(true);
    expect(full.records[0].data.ingekort).toBe(false);

    const cut = await callTool({ ecli: "ECLI:NL:HR:2019:2006", onderdeel: "volledig", max_chars: 500 });
    const data = cut.records[0].data;
    expect(data.ingekort).toBe(true);
    expect(data.tekst.length).toBeLessThanOrEqual(500);
    expect(data.tekst.endsWith("[…]")).toBe(true);
    expect(data.tekens_onderdeel).toBe(tekst.length);
    expect(cut.access_note).toContain(`Tekst ingekort: ${data.tekst.length} van ${tekst.length} tekens getoond`);
  });

  it("sectie: by number, by paragraph number and by title words; an unknown one lists the sections", async () => {
    mockContent({ "ECLI:NL:HR:2019:2006": xmlResponse(ARREST) });
    const bySection = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: "3" });
    expect(bySection.records[0].data.tekst).toBe("## 3 De cassatieklachten\n3.1 De Staat klaagt dat het hof een te ruime zorgplicht heeft aangenomen.");
    const byParagraph = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: "r.o. 2.1" });
    expect(byParagraph.records[0].data.tekst).toBe(
      "2.1 In cassatie kan worden uitgegaan van de feiten die de rechtbank heeft vastgesteld.[noot 1]\nDe uitstoot van broeikasgassen draagt bij aan klimaatverandering.\n\nVoetnoten:\n[noot 1] Rechtbank Den Haag 24 juni 2015, ECLI:NL:RBDHA:2015:7145.",
    );
    const byTitle = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: "procesverloop" });
    expect(byTitle.records[0].data.onderdeel_label).toBe("1 Procesverloop");
    const missing = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: "bijlage II" });
    expect(missing.summary).toContain("sectie 'bijlage II' niet gevonden");
    expect(missing.records[0].data.tekst).toBe("");
    expect(missing.access_note).toContain("Bestaande secties: kop Kop (gerecht, partijen, zaaknummer), 1 Procesverloop");
  });

  it("zoekterm: the paragraphs holding every word, with section and number, footnotes included", async () => {
    mockContent({ "ECLI:NL:HR:2019:2006": xmlResponse(ARREST) });
    const out = await callTool({ ecli: "ECLI:NL:HR:2019:2006", zoekterm: "Zorgplicht" });
    expect(out.summary).toBe("ECLI:NL:HR:2019:2006 Hoge Raad, 20-12-2019 / 19/00135: 2 alinea's met 'Zorgplicht'");
    expect(out.records[0].data.treffers).toEqual([
      { sectie: "3 De cassatieklachten", nr: "3.1" },
      { sectie: "4 Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen?", nr: "4.2" },
    ]);
    expect(out.records[0].data.tekst).toContain("[4 Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen? › 4.2]\n4.2 Op de Staat rust een zorgplicht");
    expect(out.records[0].data.tekst).toContain("Dat volgt uit art. 2 en 8 EVRM.");

    const footnote = await callTool({ ecli: "ECLI:NL:HR:2019:2006", zoekterm: "RBDHA:2015:7145" });
    expect(footnote.records[0].data.treffers).toEqual([{ sectie: "Voetnoot 1" }]);

    // Within the beslissing only; nothing there is said, not passed off as a hit.
    const none = await callTool({ ecli: "ECLI:NL:HR:2019:2006", onderdeel: "beslissing", zoekterm: "zorgplicht" });
    expect(none.records[0].data.treffers_totaal).toBe(0);
    expect(none.access_note).toContain("Geen alinea in de beslissing (5 Beslissing) bevat alle woorden van 'zorgplicht'");
  });

  it("an older ruling without section markup: sections from its heading lines, beslissing by heading line", async () => {
    mockContent({ "ECLI:NL:HR:2005:AU4019": xmlResponse(OUD_ARREST) });
    const out = await callTool({ ecli: "ECLI:NL:HR:2005:AU4019", onderdeel: "beslissing" });
    expect(out.records[0].data.tekst).toBe("## 3. Beslissing\nDe Hoge Raad:\nverwerpt het beroep;");
    expect(out.access_note).toContain("Beslissing gevonden via kopregel '3. Beslissing' in de tekst (geen sectie-opmaak).");
    expect(out.records[0].data.vervangt).toBe("AU4019");
    const paragraph = await callTool({ ecli: "ECLI:NL:HR:2005:AU4019", sectie: "2.1" });
    expect(paragraph.records[0].data.tekst).toBe("2.1 Het middel faalt.\nHet hof heeft de belangen op juiste wijze afgewogen.");
  });

  it("a conclusie of an Advocaat-Generaal is presented as advice, not as a ruling", async () => {
    mockContent({ "ECLI:NL:PHR:2019:887": xmlResponse(CONCLUSIE) });
    const out = await callTool({ ecli: "ECLI:NL:PHR:2019:887" });
    expect(out.summary).toContain("overzicht met conclusie (3 Conclusie)");
    expect(out.records[0].data).toMatchObject({ soort: "conclusie", documenttype: "Conclusie", tekst: "## 3 Conclusie\nDe conclusie strekt tot verwerping van het cassatieberoep." });
    expect(out.records[0].data.relaties[0]).toMatchObject({ ecli: "ECLI:NL:HR:2019:2006", aanleg: "latere aanleg", gevolg: "gevolgd" });
    expect(out.access_note).toContain("een advies aan de rechter, geen uitspraak");
  });

  it("metadata without published text is reported as such, not as an empty success", async () => {
    mockContent({ "ECLI:NL:RBOVE:2026:6000": xmlResponse(ALLEEN_METADATA) });
    const out = await callTool({ ecli: "ECLI:NL:RBOVE:2026:6000", onderdeel: "beslissing" });
    expect(out.summary).toBe("ECLI:NL:RBOVE:2026:6000: alleen metadata, geen tekst gepubliceerd");
    expect(out.records).toHaveLength(1);
    expect(out.records[0].title).toBe("ECLI:NL:RBOVE:2026:6000 Hoge Raad, 2019-12-20");
    expect(out.records[0].data.tekst_gepubliceerd).toBe(false);
    expect(out.records[0].data.tekst).toBeUndefined();
    expect(out.access_note).toContain("alleen metadata gepubliceerd, geen tekst en geen inhoudsindicatie, dus het gevraagde onderdeel");
  });

  it("a tuchtrecht ruling links to tuchtrecht.overheid.nl, where its text is", async () => {
    mockContent({ "ECLI:NL:TGZRAMS:2024:1": xmlResponse(TUCHTRECHT) });
    const out = await callTool({ ecli: "ECLI:NL:TGZRAMS:2024:1" });
    expect(out.summary).toBe("ECLI:NL:TGZRAMS:2024:1: tuchtrechtuitspraak, tekst op tuchtrecht.overheid.nl");
    expect(out.records[0].canonical_url).toBe("https://tuchtrecht.overheid.nl/ECLI:NL:TGZRAMS:2024:1");
    expect(out.records[0].data.tekst_gepubliceerd).toBe(false);
    expect(out.access_note).toContain("de tekst staat op https://tuchtrecht.overheid.nl/ECLI:NL:TGZRAMS:2024:1");
    expect(out.access_note).not.toContain("kan later alsnog verschijnen");
  });

  it("an unknown ECLI (404) returns no record and says so", async () => {
    mockContent({});
    const out = await callTool({ ecli: "ECLI:NL:HR:2019:999999" });
    expect(out.error).toBeUndefined();
    expect(out.records).toEqual([]);
    expect(out.summary).toBe("ECLI:NL:HR:2019:999999 niet gevonden op Rechtspraak.nl");
    expect(out.provenance).toMatchObject({ returned_results: 0, total_results: 0 });
    expect(out.access_note).toContain("(HTTP 404)");
  });

  it("an invalid or non-Dutch ECLI is refused before any request", async () => {
    const urls = mockContent({});
    const invalid = await callTool({ ecli: "19/00135" });
    expect(invalid.error).toBe("unexpected");
    expect(invalid.message).toContain("Geen geldige ECLI");
    const eu = await callTool({ ecli: "ECLI:EU:C:2014:317" });
    expect(eu.message).toContain("geen Nederlandse ECLI");
    expect(urls).toEqual([]);
  });

  it("two ECLIs, or a link from another site, are refused before any request", async () => {
    const urls = mockContent({});
    const two = await callTool({ ecli: "ECLI:NL:HR:2019:2006 ECLI:NL:HR:2020:1" });
    expect(two.error).toBe("unexpected");
    expect(two.message).toContain("Meer dan één ECLI opgegeven (ECLI:NL:HR:2019:2006, ECLI:NL:HR:2020:1)");
    const foreign = await callTool({ ecli: "https://evil.example.com/?id=ECLI:NL:HR:2019:2006" });
    expect(foreign.error).toBe("unexpected");
    expect(foreign.message).toContain("geen link van Rechtspraak.nl (host evil.example.com)");
    expect(urls).toEqual([]);
    expect(readEcliInput("https://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:HR:2019:2006")).toEqual({ ecli: "ECLI:NL:HR:2019:2006" });
    expect(readEcliInput("uitspraken.rechtspraak.nl/details?id=ecli:nl:hr:2019:2006")).toEqual({ ecli: "ECLI:NL:HR:2019:2006" });
  });

  it("sectie matches whole title words, never a fragment, and refuses one with nothing to look for", async () => {
    const urls = mockContent({ "ECLI:NL:HR:2019:2006": xmlResponse(ARREST) });
    const byPrefix = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: "maatregelen EVRM" });
    expect(byPrefix.records[0].data.onderdeel_label).toBe("4 Verplichten de art. 2 en 8 EVRM de Staat tot maatregelen?");
    // 'klachten' is inside 'cassatieklachten', not a word of the title.
    const fragment = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: "klachten" });
    expect(fragment.summary).toContain("sectie 'klachten' niet gevonden");
    const count = urls.length;
    const nothing = await callTool({ ecli: "ECLI:NL:HR:2019:2006", sectie: '") OR ("' });
    expect(nothing.error).toBe("unexpected");
    expect(nothing.message).toContain("bevat geen nummer, sectie-id of woord");
    expect(urls).toHaveLength(count);
    expect(sectieIsReadable("4.3")).toBe(true);
    expect(sectieIsReadable("#2")).toBe(true);
    expect(sectieIsReadable("de en of")).toBe(false);
  });

  it("a failing service is an error, not an empty result", async () => {
    mockContent({ "ECLI:NL:HR:2019:2006": () => new Response("upstream down", { status: 502 }) });
    const out = await callTool({ ecli: "ECLI:NL:HR:2019:2006" });
    expect(out.error).toBe("http_error");
    expect(out.message).toContain("Rechtspraak (data.rechtspraak.nl)");
    expect(out.suggestion).toContain("https://uitspraken.rechtspraak.nl/details?id=ECLI:NL:HR:2019:2006");
  });
});
