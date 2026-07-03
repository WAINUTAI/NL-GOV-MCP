import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CvdrSource } from "../src/sources/cvdr.js";

const config = loadConfig();

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <sru:numberOfRecords>6743</sru:numberOfRecords>
  <sru:records>
    <sru:record>
      <sru:recordData>
        <gzd xmlns="http://standaarden.overheid.nl/sru">
          <originalData>
            <overheidrg:meta xmlns:overheidrg="http://standaarden.overheid.nl/cvdr/">
              <owmskern xmlns:dcterms="http://purl.org/dc/terms/">
                <dcterms:identifier>CVDR357364_1</dcterms:identifier>
                <dcterms:title>Verordening op de heffing en invordering van hondenbelasting 2015</dcterms:title>
                <dcterms:type>regeling</dcterms:type>
                <dcterms:creator>Leerdam</dcterms:creator>
                <dcterms:modified>2015-01-01</dcterms:modified>
              </owmskern>
              <owmsmantel xmlns:dcterms="http://purl.org/dc/terms/">
                <dcterms:issued>2014-12-11</dcterms:issued>
              </owmsmantel>
            </overheidrg:meta>
          </originalData>
          <enrichedData>
            <preferredUrl>https://lokaleregelgeving.overheid.nl/CVDR357364/1</preferredUrl>
          </enrichedData>
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

describe("CvdrSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes a CVDR record with municipality and preferred url", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CvdrSource(config);
    const out = await src.search({ query: "hondenbelasting", maximumRecords: 2 });

    expect(out.total).toBe(6743);
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.identifier).toBe("CVDR357364_1");
    expect(item.title).toBe(
      "Verordening op de heffing en invordering van hondenbelasting 2015",
    );
    expect(item.gemeente).toBe("Leerdam");
    expect(item.date).toBe("2014-12-11");
    expect(item.canonical_url).toBe("https://lokaleregelgeving.overheid.nl/CVDR357364/1");
  });

  it("falls back to a constructed canonical url when enrichedData is absent", async () => {
    const noEnriched = SAMPLE_XML.replace(
      /<enrichedData>[\s\S]*?<\/enrichedData>/,
      "",
    );
    const fetchMock = vi.fn(async () => xmlResponse(noEnriched));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CvdrSource(config);
    const out = await src.search({ query: "hondenbelasting", maximumRecords: 2 });

    expect(out.items[0].canonical_url).toBe(
      "https://lokaleregelgeving.overheid.nl/CVDR357364/1",
    );
  });

  it("sends the cvdr connection and the keyword index", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CvdrSource(config);
    await src.search({ query: "hondenbelasting", maximumRecords: 1 });

    const calledUrl = decodeURIComponent(
      String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]),
    );
    expect(calledUrl).toContain("x-connection=cvdr");
    expect(calledUrl).toContain("version=1.2");
    expect(calledUrl).toContain("keyword=hondenbelasting");
  });

  it("returns an empty result set without throwing", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(EMPTY_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CvdrSource(config);
    const out = await src.search({ query: "nietbestaandeterm", maximumRecords: 2 });

    expect(out.total).toBe(0);
    expect(out.items).toHaveLength(0);
  });
});
