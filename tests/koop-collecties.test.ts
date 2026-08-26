import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KoopCollectieSource,
  type SamenwerkendeCatalogiItem,
  type TuchtrechtItem,
} from "../src/sources/koop-collecties.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

function sruEnvelope(records: string, total: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse"
  xmlns:gzd="http://standaarden.overheid.nl/sru"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:overheidwetgeving="http://standaarden.overheid.nl/wetgeving/"
  xmlns:overheid="http://standaarden.overheid.nl/owms/terms/"
  xmlns:c="http://standaarden.overheid.nl/collectie/">
  <sru:version>2.0</sru:version>
  <sru:numberOfRecords>${total}</sru:numberOfRecords>
  <sru:records>${records}</sru:records>
</sru:searchRetrieveResponse>`;
}

const tuchtrechtRecord = `
<sru:record><sru:recordData><gzd:gzd>
  <gzd:originalData><overheidwetgeving:meta>
    <overheidwetgeving:owmskern>
      <dcterms:identifier>ECLI:NL:TGZCTG:2024:49</dcterms:identifier>
      <dcterms:title>ECLI:NL:TGZCTG:2024:49 Centraal Tuchtcollege 26-02-2024</dcterms:title>
      <dcterms:creator>Centraal Tuchtcollege voor de Gezondheidszorg</dcterms:creator>
      <dcterms:modified>2024-02-26</dcterms:modified>
    </overheidwetgeving:owmskern>
    <overheidwetgeving:owmsmantel>
      <dcterms:available>2024-02-26</dcterms:available>
      <dcterms:description>Klacht    tegen twee huisartsen.</dcterms:description>
      <dcterms:subject>Geen of onvoldoende zorg</dcterms:subject>
    </overheidwetgeving:owmsmantel>
    <overheidwetgeving:tpmeta>
      <c:product-area>tuchtrecht</c:product-area>
      <overheidwetgeving:instantieDomein>Gezondheidszorg</overheidwetgeving:instantieDomein>
      <overheidwetgeving:instantiePlaats>Den Haag</overheidwetgeving:instantiePlaats>
      <overheidwetgeving:zaaknummer>C2023/2052</overheidwetgeving:zaaknummer>
      <overheidwetgeving:beslissing>Ongegrond/afwijzing</overheidwetgeving:beslissing>
      <overheidwetgeving:uitspraakdatum>2024-02-26</overheidwetgeving:uitspraakdatum>
    </overheidwetgeving:tpmeta>
  </overheidwetgeving:meta></gzd:originalData>
  <gzd:enrichedData>
    <gzd:url>https://repository.overheid.nl/frbr/tuchtrecht/2024/x/1/xml/x.xml</gzd:url>
    <gzd:preferredUrl>https://tuchtrecht.overheid.nl/ECLI:NL:TGZCTG:2024:49</gzd:preferredUrl>
    <gzd:itemUrl manifestation="pdf">https://repository.overheid.nl/frbr/tuchtrecht/2024/x/1/pdf/x.pdf</gzd:itemUrl>
    <gzd:itemUrl manifestation="xml">https://repository.overheid.nl/frbr/tuchtrecht/2024/x/1/xml/x.xml</gzd:itemUrl>
  </gzd:enrichedData>
</gzd:gzd></sru:recordData></sru:record>`;

const catalogiRecord = `
<sru:record><sru:recordData><gzd:gzd>
  <gzd:originalData><overheidwetgeving:meta>
    <overheidwetgeving:owmskern>
      <dcterms:identifier>9221c4af6bc63c75cd30bdc34cb8bcb4</dcterms:identifier>
      <dcterms:title>Meldpunt Zorg en Veiligheid</dcterms:title>
      <dcterms:type scheme="overheid:Informatietype">productbeschrijving</dcterms:type>
      <dcterms:creator scheme="overheid:Gemeente">Pekela</dcterms:creator>
      <dcterms:modified>2024-11-18</dcterms:modified>
      <overheid:authority scheme="overheid:Gemeente">Pekela</overheid:authority>
      <dcterms:spatial scheme="overheid:Gemeente">Pekela</dcterms:spatial>
    </overheidwetgeving:owmskern>
    <overheidwetgeving:owmsmantel>
      <dcterms:audience scheme="overheid:Doelgroep">particulier</dcterms:audience>
      <dcterms:abstract>Maakt u zich zorgen
                    over een buurtbewoner?</dcterms:abstract>
    </overheidwetgeving:owmsmantel>
  </overheidwetgeving:meta></gzd:originalData>
  <gzd:enrichedData>
    <gzd:url>https://repository.overheid.nl/frbr/samenwerkendecatalogi/x/1/metadata/metadata.xml</gzd:url>
    <gzd:itemUrl manifestation="metadata">https://repository.overheid.nl/frbr/samenwerkendecatalogi/x/1/metadata/metadata.xml</gzd:itemUrl>
  </gzd:enrichedData>
</gzd:gzd></sru:recordData></sru:record>`;

function stubSru(body: string) {
  const fetchMock = vi.fn(async () => xmlResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calledQuery(fetchMock: ReturnType<typeof stubSru>): string {
  const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
  return url.searchParams.get("query") ?? "";
}

describe("KoopCollectieSource — tuchtrecht", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("scopes the query to the tuchtrecht product area and maps the ruling", async () => {
    const fetchMock = stubSru(sruEnvelope(tuchtrechtRecord, 27508));
    const source = new KoopCollectieSource(testConfig, "tuchtrecht");
    const out = await source.search({ query: "medicatiefout", maximumRecords: 10 });

    expect(calledQuery(fetchMock)).toBe("c.product-area==tuchtrecht AND medicatiefout");
    expect(out.total).toBe(27508);

    const item = out.items[0] as TuchtrechtItem;
    expect(item).toMatchObject({
      identifier: "ECLI:NL:TGZCTG:2024:49",
      college: "Centraal Tuchtcollege voor de Gezondheidszorg",
      domein: "Gezondheidszorg",
      zaaknummer: "C2023/2052",
      beslissing: "Ongegrond/afwijzing",
      uitspraakdatum: "2024-02-26",
      onderwerp: "Geen of onvoldoende zorg",
      canonical_url: "https://tuchtrecht.overheid.nl/ECLI:NL:TGZCTG:2024:49",
    });
    expect(item.pdf_url).toContain("/pdf/x.pdf");
    expect(item.samenvatting).toBe("Klacht tegen twee huisartsen.");
  });

  it("adds exact creator and ISO date filters to the CQL", async () => {
    const fetchMock = stubSru(sruEnvelope(tuchtrechtRecord, 1));
    const source = new KoopCollectieSource(testConfig, "tuchtrecht");
    await source.search({
      organisatie: 'Centraal "Tucht" College',
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      maximumRecords: 5,
    });

    expect(calledQuery(fetchMock)).toBe(
      'c.product-area==tuchtrecht AND dt.creator=="Centraal \\"Tucht\\" College" AND dt.modified>=2024-01-01 AND dt.modified<=2024-12-31',
    );
  });

  it("ignores a malformed date instead of sending it as CQL", async () => {
    const fetchMock = stubSru(sruEnvelope(tuchtrechtRecord, 1));
    const source = new KoopCollectieSource(testConfig, "tuchtrecht");
    const out = await source.search({ date_from: "vorig jaar", maximumRecords: 5 });

    expect(calledQuery(fetchMock)).toBe("c.product-area==tuchtrecht");
    expect(out.access_note).toContain("Datumfilter genegeerd");
  });
});

describe("KoopCollectieSource — samenwerkende catalogi", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("maps a product description with organisation and audience", async () => {
    const fetchMock = stubSru(sruEnvelope(catalogiRecord, 2128));
    const source = new KoopCollectieSource(testConfig, "samenwerkendecatalogi");
    const out = await source.search({ query: "paspoort", maximumRecords: 10 });

    expect(calledQuery(fetchMock)).toBe("c.product-area==samenwerkendecatalogi AND paspoort");

    const item = out.items[0] as SamenwerkendeCatalogiItem;
    expect(item).toMatchObject({
      identifier: "9221c4af6bc63c75cd30bdc34cb8bcb4",
      title: "Meldpunt Zorg en Veiligheid",
      organisatie: "Pekela",
      organisatietype: "Gemeente",
      gebied: "Pekela",
      informatietype: "productbeschrijving",
      doelgroep: "particulier",
      gewijzigd: "2024-11-18",
    });
    expect(item.samenvatting).toBe("Maakt u zich zorgen over een buurtbewoner?");
    expect(item.canonical_url).toContain("repository.overheid.nl");
  });

  it("reports zero hits with a usable hint", async () => {
    stubSru(sruEnvelope("", 0));
    const source = new KoopCollectieSource(testConfig, "samenwerkendecatalogi");
    const out = await source.search({ query: "bestaatniet", maximumRecords: 10 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Geen resultaten");
  });
});
