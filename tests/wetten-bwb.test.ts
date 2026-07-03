import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { WettenBwbSource } from "../src/sources/wetten-bwb.js";

const config = loadConfig();

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <sru:numberOfRecords>607</sru:numberOfRecords>
  <sru:records>
    <sru:record>
      <sru:recordData>
        <gzd xmlns="http://standaarden.overheid.nl/sru">
          <originalData>
            <overheidbwb:meta xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/">
              <owmskern xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheid="http://standaarden.overheid.nl/owms/terms/">
                <dcterms:identifier>BWBR0019942</dcterms:identifier>
                <dcterms:title>Beleidsregels boeteoplegging wet arbeid vreemdelingen 2006</dcterms:title>
                <dcterms:type>wet</dcterms:type>
                <overheid:authority>Sociale Zaken en Werkgelegenheid</overheid:authority>
                <dcterms:creator>Ministerie van Binnenlandse Zaken en Koninkrijksrelaties</dcterms:creator>
                <dcterms:modified>2016-01-15</dcterms:modified>
              </owmskern>
              <owmsmantel xmlns:dcterms="http://purl.org/dc/terms/">
                <dcterms:created>2015-07-02</dcterms:created>
              </owmsmantel>
            </overheidbwb:meta>
          </originalData>
        </gzd>
      </sru:recordData>
    </sru:record>
  </sru:records>
</sru:searchRetrieveResponse>`;

const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <sru:numberOfRecords>0</sru:numberOfRecords>
  <sru:records/>
</sru:searchRetrieveResponse>`;

describe("WettenBwbSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes a BWB record and builds a wetten.overheid.nl canonical url", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new WettenBwbSource(config);
    const out = await src.search({ query: "arbeid", maximumRecords: 2 });

    expect(out.total).toBe(607);
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.identifier).toBe("BWBR0019942");
    expect(item.title).toBe("Beleidsregels boeteoplegging wet arbeid vreemdelingen 2006");
    expect(item.authority).toBe("Sociale Zaken en Werkgelegenheid");
    expect(item.date).toBe("2016-01-15");
    expect(item.canonical_url).toBe("https://wetten.overheid.nl/BWBR0019942");
  });

  it("sends the BWB connection and the overheidbwb.titel index", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new WettenBwbSource(config);
    // Distinct maximumRecords from the other tests so the shared HTTP cache
    // does not short-circuit fetch on an identical request (cf. cvdr.test.ts).
    await src.search({ query: "arbeid", maximumRecords: 1 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("x-connection=BWB");
    expect(calledUrl).toContain("version=1.2");
    expect(calledUrl).toContain("operation=searchRetrieve");
    expect(decodeURIComponent(calledUrl)).toContain("overheidbwb.titel=arbeid");
  });

  it("quotes multi-word queries as a CQL phrase", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new WettenBwbSource(config);
    await src.search({ query: "arbeid vreemdelingen", maximumRecords: 3 });

    // Decode via URLSearchParams: the query string encodes spaces as "+"
    // (URLSearchParams form-encoding), which decodeURIComponent does NOT turn
    // back into a space. searchParams.get maps "+" → " " correctly.
    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    const cql = new URL(calledUrl).searchParams.get("query");
    expect(cql).toBe('overheidbwb.titel="arbeid vreemdelingen"');
  });

  it("returns an empty result set without throwing", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(EMPTY_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new WettenBwbSource(config);
    const out = await src.search({ query: "nietbestaandeterm", maximumRecords: 2 });

    expect(out.total).toBe(0);
    expect(out.items).toHaveLength(0);
  });
});
