import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CvdrQueryError, CvdrSource } from "../src/sources/cvdr.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

function record(opts: {
  id: string;
  title: string;
  creator: string;
  scheme?: string;
  organisatietype?: string;
  issued?: string;
  modified?: string;
  position: number;
}): string {
  const scheme = opts.scheme ? ` scheme="${opts.scheme}"` : "";
  const issued = opts.issued === undefined ? "<dcterms:issued/>" : `<dcterms:issued>${opts.issued}</dcterms:issued>`;
  const enrichedType = opts.organisatietype ? `<organisatietype>${opts.organisatietype}</organisatietype>` : "";
  const [base, version] = opts.id.split("_");
  return `<record><recordData>
    <gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/">
      <originalData>
        <overheidrg:meta xmlns:overheidrg="http://standaarden.overheid.nl/cvdr/terms/">
          <owmskern>
            <dcterms:identifier>${opts.id}</dcterms:identifier>
            <dcterms:title>${opts.title}</dcterms:title>
            <dcterms:type scheme="overheid:Informatietype">regeling</dcterms:type>
            <dcterms:type scheme="overheidop:Rubriek">beleidsregel</dcterms:type>
            <dcterms:creator${scheme}>${opts.creator}</dcterms:creator>
            <dcterms:modified>${opts.modified ?? "2025-06-11"}</dcterms:modified>
          </owmskern>
          <owmsmantel>${issued}</owmsmantel>
        </overheidrg:meta>
      </originalData>
      <enrichedData>
        ${enrichedType}
        <preferred_url>https://lokaleregelgeving.overheid.nl/${base}/${version}</preferred_url>
      </enrichedData>
    </gzd>
  </recordData><recordPosition>${opts.position}</recordPosition></record>`;
}

function sru(total: number, records: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">
  <version>1.2</version>
  <numberOfRecords>${total}</numberOfRecords>
  ${records.length ? `<records>${records.join("")}</records>` : ""}
</searchRetrieveResponse>`;
}

const WATERSCHAP = record({
  id: "CVDR701234_1",
  title: "Beleidsregel &apos;Ruimte voor de rivier&apos; Waterschap Rivierenland",
  creator: "Waterschap Rivierenland",
  scheme: "overheid:Waterschap",
  organisatietype: "Waterschap",
  issued: "2025-06-03",
  position: 1,
});

const DIAGNOSTICS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<diagnostics>
  <diagnostic xmlns="http://www.loc.gov/zing/srw/diagnostic/">
    <uri>info:srw/diagnostic/1/16</uri>
    <details>cql.serverChoice</details>
    <message>Unsupported index</message>
  </diagnostic>
</diagnostics>`;

/** The CQL query and the other SRU parameters of the n-th fetch call. */
function sentParams(fetchMock: ReturnType<typeof vi.fn>, n = 0): URLSearchParams {
  return new URL(String((fetchMock.mock.calls[n] as unknown as Array<unknown>)[0])).searchParams;
}

function mockFetch(...bodies: string[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => xmlResponse(bodies[Math.min(call++, bodies.length - 1)]));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CvdrSource.search: query building", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("combines multi-word queries with AND per word instead of one quoted phrase", async () => {
    const fetchMock = mockFetch(sru(245, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "openbare  verlichting", maximumRecords: 5 });

    expect(sentParams(fetchMock).get("query")).toBe("keyword=openbare AND keyword=verlichting");
  });

  it("keeps a single plain word bare, as before", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "hondenbelasting", maximumRecords: 3 });

    expect(sentParams(fetchMock).get("query")).toBe("keyword=hondenbelasting");
  });

  it("quotes words with CQL-significant characters and CQL keywords, and drops stray quotes", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: `'s-Hertogenbosch "parkeren" and B.V. - e-mail afval*`, maximumRecords: 4 });

    expect(sentParams(fetchMock).get("query")).toBe(
      `keyword="'s-Hertogenbosch" AND keyword=parkeren AND keyword="and" AND keyword="B.V." AND keyword="-" AND keyword=e-mail AND keyword=afval*`,
    );
  });

  it.each([
    ["parkeren OR fietsen", "keyword=parkeren OR keyword=fietsen"],
    ["subsidie NOT sport", "keyword=subsidie NOT keyword=sport"],
    ["parkeren AND fietsen", "keyword=parkeren AND keyword=fietsen"],
    // AND binds tighter than OR; CQL itself has no precedence, so the group is bracketed.
    ["parkeren fietsen OR hondenbelasting", "(keyword=parkeren AND keyword=fietsen) OR keyword=hondenbelasting"],
    ["a OR b c OR d", "keyword=a OR (keyword=b AND keyword=c) OR keyword=d"],
    ["a NOT b c", "keyword=a NOT keyword=b AND keyword=c"],
    ["a AND NOT b", "keyword=a NOT keyword=b"],
    // A leading NOT subtracts from all regulations; stray operators at the edges are dropped.
    ["NOT parkeren", "keyword=* NOT keyword=parkeren"],
    ["OR parkeren AND", "keyword=parkeren"],
    ["parkeren OR OR fietsen", "keyword=parkeren OR keyword=fietsen"],
  ])("applies uppercase operators in %j", async (query, cql) => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query, maximumRecords: 26 });

    expect(sentParams(fetchMock).get("query")).toBe(cql);
  });

  it("never sends an uppercase AND/OR/NOT inside quotes, which KOOP fails on", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]), sru(1, [WATERSCHAP]));
    const src = new CvdrSource(testConfig);
    // A query of operator words only is a search for those words.
    await src.search({ query: "OR", maximumRecords: 27 });
    await src.search({ query: "AND NOT", maximumRecords: 28 });

    expect(sentParams(fetchMock, 0).get("query")).toBe('keyword="or"');
    expect(sentParams(fetchMock, 1).get("query")).toBe('keyword="and" AND keyword="not"');
  });

  it("keeps lowercase or mixed-case operator words as search words", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "parkeren or Not fietsen", maximumRecords: 29 });

    expect(sentParams(fetchMock).get("query")).toBe('keyword=parkeren AND keyword="or" AND keyword="not" AND keyword=fietsen');
  });

  it("brackets a keyword OR/NOT before the issuer filters", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]), sru(1, [WATERSCHAP]));
    const src = new CvdrSource(testConfig);
    await src.search({ query: "parkeren OR fietsen", organization: "Harderwijk", maximumRecords: 30 });
    await src.search({ query: "subsidie NOT sport", organization_type: "Gemeente", maximumRecords: 31 });

    expect(sentParams(fetchMock, 0).get("query")).toBe('(keyword=parkeren OR keyword=fietsen) AND creator="Harderwijk"');
    expect(sentParams(fetchMock, 1).get("query")).toBe("(keyword=subsidie NOT keyword=sport) AND organisatieType=Gemeente");
  });

  it("searches everything for an empty query without filters", async () => {
    const fetchMock = mockFetch(sru(343319, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "   ", maximumRecords: 6 });

    expect(sentParams(fetchMock).get("query")).toBe("keyword=*");
  });

  it("passes startRecord through so later pages are fetched upstream", async () => {
    const fetchMock = mockFetch(sru(245, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", maximumRecords: 200, startRecord: 201 });

    const params = sentParams(fetchMock);
    expect(params.get("startRecord")).toBe("201");
    expect(params.get("maximumRecords")).toBe("200");
  });

  it("filters on the issuing organisation via the creator index", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", organization: "Gooise Meren", maximumRecords: 7 });

    expect(sentParams(fetchMock).get("query")).toBe('keyword=afvalstoffenheffing AND (creator="Gooise Meren" OR creator="Gooise-Meren")');
  });

  it("ORs everyday and official names of the same place, in every spelling", async () => {
    const fetchMock = mockFetch(sru(256, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "parkeren", organization: "Den Haag", maximumRecords: 8 });

    expect(sentParams(fetchMock).get("query")).toBe(
      `keyword=parkeren AND (creator="Den Haag" OR creator="'s-Gravenhage" OR creator="s-Gravenhage" OR creator="'s Gravenhage" OR creator="s Gravenhage" OR creator="The Hague" OR creator="Den-Haag" OR creator="The-Hague")`,
    );
  });

  // Live: creator="Bergen op Zoom" 897 vs "Bergen-op-Zoom" 0; "Noord-Holland" 1604 vs
  // "Noord Holland" 0; "Hunze en Aa's" 120 vs "Hunze en Aas" 0. Punctuation is not
  // folded on this index, so no spelling may be dropped as a duplicate.
  it.each([
    ["Bergen-op-Zoom", '(creator="Bergen-op-Zoom" OR creator="Bergen op Zoom")'],
    ["Alphen-aan-den-Rijn", '(creator="Alphen-aan-den-Rijn" OR creator="Alphen aan den Rijn")'],
    ["Noord Holland", '(creator="Noord Holland" OR creator="Noord-Holland")'],
    ["Hendrik Ido Ambacht", '(creator="Hendrik Ido Ambacht" OR creator="Hendrik-Ido-Ambacht")'],
    [
      "Hunze en Aa's",
      `(creator="Hunze en Aa's" OR creator="Hunze en Aas" OR creator="Hunze-en-Aa's" OR creator="Hunze-en-Aas")`,
    ],
    ["Harderwijk", 'creator="Harderwijk"'],
  ])("keeps every distinct spelling of %s", async (organization, cql) => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]));
    await new CvdrSource(testConfig).search({ query: "", organization, maximumRecords: 32 });

    expect(sentParams(fetchMock).get("query")).toBe(cql);
  });

  it("turns a 'Gemeente'/'Provincie' prefix into an organisation-type filter", async () => {
    const fetchMock = mockFetch(sru(2884, [WATERSCHAP]), sru(1253, [WATERSCHAP]));
    const src = new CvdrSource(testConfig);
    await src.search({ query: "", organization: "Gemeente Utrecht", maximumRecords: 9 });
    await src.search({ query: "", organization: "provincie  Utrecht", maximumRecords: 10 });

    expect(sentParams(fetchMock, 0).get("query")).toBe('creator="Utrecht" AND organisatieType=Gemeente');
    expect(sentParams(fetchMock, 1).get("query")).toBe('creator="Utrecht" AND organisatieType=Provincie');
  });

  it("lets an explicit organization_type win over the prefix and works on its own", async () => {
    const fetchMock = mockFetch(sru(1, [WATERSCHAP]), sru(2, [WATERSCHAP]));
    const src = new CvdrSource(testConfig);
    await src.search({ query: "", organization: "Gemeente Utrecht", organization_type: "Provincie", maximumRecords: 11 });
    await src.search({ query: "afvalstoffenheffing", organization_type: "Waterschap", maximumRecords: 12 });

    expect(sentParams(fetchMock, 0).get("query")).toBe('creator="Utrecht" AND organisatieType=Provincie');
    expect(sentParams(fetchMock, 1).get("query")).toBe("keyword=afvalstoffenheffing AND organisatieType=Waterschap");
  });

  it("ignores an organisation without letters or digits instead of claiming a filter", async () => {
    const fetchMock = mockFetch(sru(80, [WATERSCHAP]));
    const out = await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", organization: " ' - ", maximumRecords: 13 });

    expect(sentParams(fetchMock).get("query")).toBe("keyword=afvalstoffenheffing");
    expect(out.access_note).not.toMatch(/Gefilterd op uitgever/);
  });

  it("escapes quotes and backslashes inside the organisation value", async () => {
    const fetchMock = mockFetch(sru(0, []), sru(0, []));
    await new CvdrSource(testConfig).search({ query: "", organization: 'Foo"Bar\\', maximumRecords: 14 });

    expect(sentParams(fetchMock).get("query")).toBe('creator="Foo\\"Bar\\\\"');
  });

  it("exposes the exact request parameters for dry runs", () => {
    const params = new CvdrSource(testConfig).requestParams({
      query: "afvalstoffenheffing",
      organization: "Harderwijk",
      maximumRecords: 20,
      startRecord: 41,
    });

    expect(params).toEqual({
      "x-connection": "cvdr",
      operation: "searchRetrieve",
      version: "1.2",
      query: 'keyword=afvalstoffenheffing AND creator="Harderwijk"',
      maximumRecords: "20",
      startRecord: "41",
    });
  });
});

describe("CvdrSource.search: records and errors", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("adds organization and organization_type and keeps the legacy gemeente field", async () => {
    mockFetch(sru(245, [WATERSCHAP]));
    const out = await new CvdrSource(testConfig).search({ query: "openbare verlichting", maximumRecords: 15 });

    expect(out.items[0]).toEqual({
      identifier: "CVDR701234_1",
      title: "Beleidsregel 'Ruimte voor de rivier' Waterschap Rivierenland",
      gemeente: "Waterschap Rivierenland",
      organization: "Waterschap Rivierenland",
      organization_type: "Waterschap",
      date: "2025-06-03",
      canonical_url: "https://lokaleregelgeving.overheid.nl/CVDR701234/1",
    });
    expect(out.access_note).toMatch(/AND gecombineerd/);
    expect(out.access_note).toMatch(/'gemeente' is de uitgevende organisatie/);
  });

  it("derives organization_type from the creator scheme when enrichedData lacks it", async () => {
    const province = record({
      id: "CVDR1_2",
      title: "Subsidieregeling",
      creator: "Limburg",
      scheme: "overheid:Provincie",
      issued: "2026-01-01",
      position: 1,
    });
    mockFetch(sru(1, [province]));
    const out = await new CvdrSource(testConfig).search({ query: "subsidie", maximumRecords: 16 });

    expect(out.items[0].organization).toBe("Limburg");
    expect(out.items[0].organization_type).toBe("Provincie");
  });

  it("falls back to dcterms:modified when dcterms:issued is empty, without the zone suffix", async () => {
    const omgevingsplan = record({
      id: "CVDR696162_5",
      title: "Omgevingsplan gemeente Groningen",
      creator: "Groningen",
      scheme: "overheid:Gemeente",
      organisatietype: "Gemeente",
      modified: "2026-07-21Z",
      position: 1,
    });
    mockFetch(sru(1, [omgevingsplan]));
    const out = await new CvdrSource(testConfig).search({ query: "omgevingsplan", maximumRecords: 17 });

    expect(out.items[0].date).toBe("2026-07-21");
  });

  it("raises SRU diagnostics as an error instead of returning an empty result", async () => {
    mockFetch(DIAGNOSTICS_XML);
    const error = await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", maximumRecords: 18 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CvdrQueryError);
    expect((error as CvdrQueryError).message).toMatch(/Unsupported index \(cql\.serverChoice\)/);
    expect((error as CvdrQueryError).diagnostic).toBe("info:srw/diagnostic/1/16");
  });

  it("raises an unexpected document as an error", async () => {
    mockFetch(`<?xml version="1.0"?><html><body>Onderhoud</body></html>`);
    await expect(
      new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", maximumRecords: 19 }),
    ).rejects.toThrow(/onverwacht antwoord/);
  });

  it("explains zero hits when the issuer exists but has no matching regulation", async () => {
    const fetchMock = mockFetch(sru(0, []), sru(735, []));
    const out = await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", organization: "Harderwijk", maximumRecords: 21 });

    expect(out.total).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const check = sentParams(fetchMock, 1);
    expect(check.get("query")).toBe('creator="Harderwijk"');
    expect(check.get("maximumRecords")).toBe("0");
    expect(out.access_note).toContain("CVDR heeft 735 regelingen van een uitgever met 'Harderwijk' in de naam");
  });

  it("explains zero hits when the issuer name matches nothing in CVDR", async () => {
    const fetchMock = mockFetch(sru(0, []), sru(0, []));
    const out = await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", organization: "Nergenshuizen", maximumRecords: 22 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.access_note).toContain("CVDR kent geen regelingen van een uitgever met 'Nergenshuizen' in de naam");
    expect(out.access_note).toContain("'s-Gravenhage");
  });

  it("needs no extra request when the issuer filter was the whole query", async () => {
    const fetchMock = mockFetch(sru(0, []));
    const out = await new CvdrSource(testConfig).search({ query: "", organization: "Nergenshuizen", maximumRecords: 23 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.access_note).toContain("CVDR kent geen regelingen van een uitgever met 'Nergenshuizen'");
  });

  it("keeps the result and a generic hint when the issuer check itself fails", async () => {
    const fetchMock = mockFetch(sru(0, []), DIAGNOSTICS_XML);
    const out = await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", organization: "Harderwijk", maximumRecords: 24 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Geen treffers; als de uitgever wel regelingen zou moeten hebben");
  });

  it("notes when the offset lies beyond the total", async () => {
    mockFetch(sru(245, []));
    const out = await new CvdrSource(testConfig).search({ query: "afvalstoffenheffing", maximumRecords: 25, startRecord: 301 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("offset 300 ligt voorbij het totaal van 245 treffers");
  });
});

describe("cvdr_search tool: server-side pagination", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cvdr-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "cvdr_search", arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  function page(total: number, from: number, count: number): string {
    const records = Array.from({ length: count }, (_, i) =>
      record({
        id: `CVDR${from + i}_1`,
        title: `Regeling ${from + i}`,
        creator: "Bergeijk",
        scheme: "overheid:Gemeente",
        organisatietype: "Gemeente",
        issued: "2024-06-04",
        position: from + i,
      }),
    );
    return sru(total, records);
  }

  it("maps offset beyond 200 onto startRecord and reports has_more from the real total", async () => {
    const fetchMock = mockFetch(page(245, 201, 45));
    const out = await callTool({ query: "openbare verlichting", top: 200, offset: 200 });

    const params = sentParams(fetchMock);
    expect(params.get("startRecord")).toBe("201");
    expect(params.get("maximumRecords")).toBe("200");
    expect(params.get("query")).toBe("keyword=openbare AND keyword=verlichting");

    const records = out.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(45);
    expect(records[0].title).toBe("Regeling 201");
    expect(out.pagination).toEqual({ offset: 200, limit: 200, total: 245, has_more: false });
    expect((out.provenance as Record<string, unknown>).returned_results).toBe(45);
    expect((out.provenance as Record<string, unknown>).total_results).toBe(245);
  });

  it("reports has_more when records remain after this page", async () => {
    const fetchMock = mockFetch(page(3093, 21, 10));
    const out = await callTool({ query: "parkeren", offset: 20, limit: 10 });

    expect(sentParams(fetchMock).get("startRecord")).toBe("21");
    expect(sentParams(fetchMock).get("maximumRecords")).toBe("10");
    expect(out.pagination).toEqual({ offset: 20, limit: 10, total: 3093, has_more: true });
    const records = out.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(10);
    expect(records[0].snippet).toBe("Bergeijk");
    expect((records[0].data as Record<string, unknown>).organization_type).toBe("Gemeente");
  });

  it("keeps the first page unchanged for a default call", async () => {
    const fetchMock = mockFetch(page(80, 1, 20));
    const out = await callTool({ query: "afvalstoffenheffing" });

    expect(sentParams(fetchMock).get("startRecord")).toBe("1");
    expect(sentParams(fetchMock).get("maximumRecords")).toBe("20");
    expect(out.pagination).toEqual({ offset: 0, limit: 20, total: 80, has_more: true });
  });

  it("returns an error payload, not an empty list, when CVDR reports a diagnostic", async () => {
    mockFetch(DIAGNOSTICS_XML);
    const out = await callTool({ query: "afvalstoffenheffing", organization: "Harderwijk" });

    expect(out.error).toBe("unexpected");
    expect(String(out.message)).toMatch(/Unsupported index/);
    // Retrying the same query cannot help, so the advice is to change it.
    expect(String(out.suggestion)).toMatch(/dezelfde aanroep herhalen geeft hetzelfde resultaat/);
    expect(String(out.suggestion)).not.toMatch(/^Try again/);
    expect(out.details).toMatchObject({ sru_diagnostic: "info:srw/diagnostic/1/16" });
  });

  it("no longer fails on an uppercase OR in the query", async () => {
    const fetchMock = mockFetch(page(35302, 1, 3));
    const out = await callTool({ query: "parkeren OR fietsen", top: 3 });

    expect(sentParams(fetchMock).get("query")).toBe("keyword=parkeren OR keyword=fietsen");
    expect(out.error).toBeUndefined();
    expect(out.pagination).toEqual({ offset: 0, limit: 3, total: 35302, has_more: true });
  });

  it("shows the real CQL, organisation filter and startRecord in a dry run", async () => {
    const fetchMock = mockFetch(page(1, 1, 1));
    const out = await callTool({ query: "afvalstoffenheffing", organization: "Gemeente Harderwijk", offset: 40, limit: 10, dryRun: true });

    expect(fetchMock).not.toHaveBeenCalled();
    const planned = (out.planned_requests as Array<Record<string, unknown>>)[0];
    expect(planned.params).toMatchObject({
      query: 'keyword=afvalstoffenheffing AND creator="Harderwijk" AND organisatieType=Gemeente',
      maximumRecords: "10",
      startRecord: "41",
    });
  });
});
