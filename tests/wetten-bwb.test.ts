import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BwbTekstError, todayAmsterdam, WettenBwbSource } from "../src/sources/wetten-bwb.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";

const config = loadConfig();

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
}

/** One SRU record: one toestand (version) of a regeling. */
function sruRecord(opts: { id: string; title: string; start: string; end?: string; zicht?: string; version?: number; modified?: string }): string {
  const version = opts.version ?? 0;
  return `<sru:record><sru:recordData>
    <gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheid="http://standaarden.overheid.nl/owms/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/">
      <originalData>
        <overheidbwb:meta>
          <owmskern>
            <dcterms:identifier>${opts.id}</dcterms:identifier>
            <dcterms:title>${opts.title}</dcterms:title>
            <dcterms:type>wet</dcterms:type>
            <overheid:authority>Veiligheid en Justitie</overheid:authority>
            <dcterms:creator>Ministerie van Binnenlandse Zaken en Koninkrijksrelaties</dcterms:creator>
            <dcterms:modified>${opts.modified ?? "2026-09-29"}</dcterms:modified>
          </owmskern>
          <owmsmantel><dcterms:created>2015-07-02</dcterms:created></owmsmantel>
          <bwbipm>
            <overheidbwb:toestand>http://wetten.overheid.nl/id/${opts.id}/${opts.start}/${version}</overheidbwb:toestand>
            <overheidbwb:rechtsgebied>Bestuursrecht</overheidbwb:rechtsgebied>
            <overheidbwb:geldigheidsperiode_startdatum>${opts.start}</overheidbwb:geldigheidsperiode_startdatum>
            <overheidbwb:geldigheidsperiode_einddatum>${opts.end ?? "9999-12-31"}</overheidbwb:geldigheidsperiode_einddatum>
            <overheidbwb:zichtperiode_startdatum>${opts.zicht ?? opts.start}</overheidbwb:zichtperiode_startdatum>
            <overheidbwb:zichtperiode_einddatum>9999-12-31</overheidbwb:zichtperiode_einddatum>
          </bwbipm>
        </overheidbwb:meta>
      </originalData>
      <enrichedData>
        <overheidbwb:locatie_toestand>https://repository.officiele-overheidspublicaties.nl/bwb/${opts.id}/${opts.start}_${version}/xml/${opts.id}_${opts.start}_${version}.xml</overheidbwb:locatie_toestand>
      </enrichedData>
    </gzd>
  </sru:recordData></sru:record>`;
}

function sru(total: number, records: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <sru:numberOfRecords>${total}</sru:numberOfRecords>
  <sru:records>${records.join("")}</sru:records>
</sru:searchRetrieveResponse>`;
}

const AWB = { id: "BWBR0005537", title: "Algemene wet bestuursrecht", start: "2026-08-15" };
const SAMPLE_XML = sru(83, [sruRecord(AWB)]);
const EMPTY_XML = sru(0, []);

function calledQuery(fetchMock: ReturnType<typeof vi.fn>, call = 0): string | null {
  const calledUrl = String((fetchMock.mock.calls[call] as unknown as Array<unknown>)[0]);
  // URLSearchParams maps "+" back to a space, which decodeURIComponent does not.
  return new URL(calledUrl).searchParams.get("query");
}

describe("WettenBwbSource.search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("returns the version geldig today with its validity period and correctly labelled dates", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "algemene wet bestuursrecht", maximumRecords: 2 });

    expect(out.total).toBe(83);
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.identifier).toBe("BWBR0005537");
    expect(item.title).toBe("Algemene wet bestuursrecht");
    expect(item.authority).toBe("Veiligheid en Justitie");
    expect(item.geldig_vanaf).toBe("2026-08-15");
    // 9999-12-31 means no end date: not reported as a date.
    expect(item.geldig_tot).toBeUndefined();
    // dcterms:modified is when the metadata record changed, not a date of the law.
    expect(item.metadata_gewijzigd).toBe("2026-09-29");
    // date: the same value under the name of the earlier version, for clients that read it.
    expect(item.date).toBe("2026-09-29");
    expect(item.bwb_id).toBe("BWBR0005537");
    expect(item.peildatum).toBe(todayAmsterdam());
    expect(item.canonical_url).toBe("https://wetten.overheid.nl/BWBR0005537");
    expect(item.versie_url).toBe("https://wetten.overheid.nl/BWBR0005537/2026-08-15");
    expect(item.xml_url).toBe("https://repository.officiele-overheidspublicaties.nl/bwb/BWBR0005537/2026-08-15_0/xml/BWBR0005537_2026-08-15_0.xml");
    expect(out.access_note).toContain("metadata_gewijzigd");
  });

  it("sends the BWB connection, the title index and today's geldigheidsdatum", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    await new WettenBwbSource(config).search({ query: "arbeid", maximumRecords: 1 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("x-connection=BWB");
    expect(calledUrl).toContain("version=1.2");
    expect(calledUrl).toContain("operation=searchRetrieve");
    expect(calledQuery(fetchMock)).toBe(`overheidbwb.titel=arbeid and overheidbwb.geldigheidsdatum=${todayAmsterdam()}`);
  });

  it("quotes multi-word queries as a CQL phrase", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    await new WettenBwbSource(config).search({ query: "arbeid vreemdelingen", maximumRecords: 3 });

    expect(calledQuery(fetchMock)).toBe(`overheidbwb.titel="arbeid vreemdelingen" and overheidbwb.geldigheidsdatum=${todayAmsterdam()}`);
  });

  it("uses peildatum for the geldigheidsdatum and links the version page", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(sru(1, [sruRecord({ ...AWB, start: "2015-01-01", end: "2015-03-31" })])));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "algemene wet bestuursrecht", maximumRecords: 4, peildatum: "2015-01-01" });

    expect(calledQuery(fetchMock)).toContain("overheidbwb.geldigheidsdatum=2015-01-01");
    expect(out.items[0].geldig_tot).toBe("2015-03-31");
    expect(out.items[0].canonical_url).toBe("https://wetten.overheid.nl/BWBR0005537/2015-01-01");
  });

  it("returns one record per regeling when two versions are geldig on the same day", async () => {
    const fetchMock = vi.fn(async () =>
      xmlResponse(sru(2, [sruRecord({ ...AWB, version: 0 }), sruRecord({ ...AWB, version: 1, zicht: "2026-09-01" })])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "algemene wet bestuursrecht", maximumRecords: 5 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].toestand).toBe("http://wetten.overheid.nl/id/BWBR0005537/2026-08-15/1");
  });

  it("returns an empty result set without throwing, and says when versions exist on other dates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(EMPTY_XML))
      .mockResolvedValueOnce(xmlResponse(sru(21, [sruRecord({ id: "BWBR0020449", title: "Wet ruimtelijke ordening", start: "2018-07-01", end: "2021-06-30" })])));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "wet ruimtelijke ordening", maximumRecords: 6 });

    expect(out.total).toBe(0);
    expect(out.items).toHaveLength(0);
    // The second request has no date filter.
    expect(calledQuery(fetchMock, 1)).toBe('overheidbwb.titel="wet ruimtelijke ordening"');
    expect(out.access_note).toContain("Wet ruimtelijke ordening (BWBR0020449, geldig 2018-07-01 t/m 2021-06-30)");
  });

  it("names the regeling with exactly the queried title when it is not geldig on the peildatum", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(sru(1, [sruRecord({ id: "BWBR0028154", title: "Wet openbaarheid van bestuur BES", start: "2010-10-10" })])))
      .mockResolvedValueOnce(xmlResponse(sru(40, [sruRecord({ id: "BWBR0005252", title: "Wet openbaarheid van bestuur", start: "2018-07-28", end: "2022-04-30" })])));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "wet openbaarheid van bestuur", maximumRecords: 8 });

    expect(out.items.map((x) => x.identifier)).toEqual(["BWBR0028154"]);
    expect(out.access_note).toContain("Wet openbaarheid van bestuur (BWBR0005252) staat er niet bij");
  });

  it("does not look at other dates when not all hits are on the page", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(sru(30, [sruRecord({ id: "BWBR0028154", title: "Wet openbaarheid van bestuur BES", start: "2010-10-10" })])));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "wet openbaarheid van bestuur", maximumRecords: 9 });

    // Only the same day is searched further, for the regeling with exactly this title.
    const queries = fetchMock.mock.calls.map((c) => new URL(String((c as unknown[])[0])).searchParams.get("query"));
    expect(queries.every((q) => q?.includes("overheidbwb.geldigheidsdatum="))).toBe(true);
    expect(out.access_note).not.toContain("staat er niet bij");
  });

  it("raises a query the SRU rejects instead of reporting no results", async () => {
    const diagnostic = `<?xml version="1.0"?><searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.2</version><diagnostics><diagnostic xmlns="http://www.loc.gov/zing/srw/diagnostic/"><uri>info:srw/diagnostic/1/10</uri><details>titel</details><message>Query syntax error</message></diagnostic></diagnostics></searchRetrieveResponse>`;
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(diagnostic)));

    await expect(new WettenBwbSource(config).search({ query: "wet (", maximumRecords: 7 })).rejects.toBeInstanceOf(BwbTekstError);
  });

  it("puts the regeling with exactly the title searched for first, also when the SRU has it further down", async () => {
    const others = ["Invoeringswet materiële belastingbepalingen Gemeentewet", "Wijzigingswet Gemeentewet (cameratoezicht)", "Circulaire artikel 172b Gemeentewet"]
      .map((title, i) => sruRecord({ id: `BWBR000000${i}`, title, start: "2020-01-01" }));
    const gemeentewet = sruRecord({ id: "BWBR0005416", title: "Gemeentewet", start: "2026-01-01" });
    const fetchMock = vi.fn(async (input: unknown) => {
      const rows = Number(new URL(String(input)).searchParams.get("maximumRecords"));
      // The first page holds only regelingen that mention the word; the whole list has the Gemeentewet.
      return xmlResponse(rows <= 3 ? sru(34, others) : sru(34, [...others, gemeentewet]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "Gemeentewet", maximumRecords: 3 });

    expect(out.items.map((i) => i.identifier)).toEqual(["BWBR0005416", "BWBR0000000", "BWBR0000001"]);
    expect(out.total).toBe(34);
    expect(out.access_note).toContain("Gemeentewet (BWBR0005416) heeft precies deze titel en staat bovenaan");
  });

  it("leaves zero-width, bidi and emoji characters out of the query", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(sru(1, [sruRecord({ id: "BWBR0037885", title: "Omgevingswet", start: "2026-07-01" })])));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "omgevings\u200bwet \u{1F333} \u200b\u202e", maximumRecords: 5 });

    expect(calledQuery(fetchMock)).toMatch(/^overheidbwb.titel=omgevingswet and /);
    expect(out.items).toHaveLength(1);
    expect(out.access_note).toContain("gezocht op 'omgevingswet'");
  });

  it("does not search, and never lists everything, for a query of only emoji or invisible characters", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new WettenBwbSource(config).search({ query: "\u{1F333}\u200b", maximumRecords: 5 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("reports an answer that is no SRU response as a failure, not as no regelingen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>Onderhoud</body></html>", { status: 200, headers: { "content-type": "text/html" } })));

    await expect(new WettenBwbSource(config).search({ query: "Awb", maximumRecords: 5 })).rejects.toMatchObject({ code: "malformed_response" });
  });
});
