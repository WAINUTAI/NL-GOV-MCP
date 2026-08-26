import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenderNedSource } from "../src/sources/tenderned.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { buildSamplePdf } from "./helpers/pdf-fixture.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const summaryRow = {
  publicatieId: "437355",
  publicatieDatum: "2026-08-25",
  typePublicatie: { code: "VBE", omschrijving: "Vroegtijdige beëindiging" },
  aanbestedingNaam: "Eigenrisicodragerschap WGA",
  opdrachtgeverNaam: "Provincie Overijssel",
  sluitingsDatum: "2026-08-12T16:00:00",
  procedure: { code: "OPE", omschrijving: "Openbaar" },
  typeOpdracht: { code: "D", omschrijving: "Diensten" },
  europees: true,
  opdrachtBeschrijving: "Nieuwe WGA eigenrisicodragerverzekering.",
  kenmerk: 591982,
  link: { href: "https://www.tenderned.nl/aankondigingen/overzicht/437355", title: "self" },
};

const detailRow = {
  publicatieId: 437355,
  kenmerk: 591982,
  aanbestedingNaam: "Eigenrisicodragerschap WGA",
  opdrachtgeverNaam: "Provincie Overijssel",
  opdrachtBeschrijving: "Nieuwe WGA eigenrisicodragerverzekering.",
  publicatieDatum: "2026-08-25T21:52:00.829812",
  sluitingsDatum: "2026-08-12T16:00:00",
  aanvangOpdrachtDatum: "2027-01-01",
  voltooiingOpdrachtDatum: "2029-12-31",
  typePublicatie: "Aankondiging gegunde opdracht",
  publicatieCode: "EF29",
  juridischKaderCode: { code: "NAW", omschrijving: "Aanbestedingswet 2012" },
  nationaalOfEuropeesCode: { code: "EU", omschrijving: "Europees" },
  typeOpdrachtCode: { code: "D", omschrijving: "Diensten" },
  procedureCode: { code: "OPE", omschrijving: "Openbaar" },
  opdrachtAardCode: { code: "OOP", omschrijving: "Overheidsopdracht" },
  cpvCodes: [{ isHoofdOpdracht: true, code: "66510000-8", omschrijving: "Verzekeringsdiensten" }],
  nutsCodes: [{ code: "NL21", omschrijving: "Overijssel" }],
  aanbestedingStatus: "EIN",
  isGegund: false,
  afgerondeAanbesteding: true,
  gerelateerdePublicaties: [
    { publicatieId: 431354, publicatieDatum: "2026-07-02", typePublicatie: "Aankondiging van een opdracht" },
  ],
};

describe("TenderNedSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("maps notices and only sends verified upstream parameters", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ content: [summaryRow], totalElements: 101, totalPages: 101, number: 0, size: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const source = new TenderNedSource(testConfig);
    const out = await source.search({
      query: "verzekering",
      typeOpdracht: "diensten",
      procedure: "ope",
      datumVanaf: "2026-01-01",
      datumTot: "2026-12-31",
      rows: 10,
    });

    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe("/papi/tenderned-rs-tns/v2/publicaties");
    expect(url.searchParams.get("search")).toBe("verzekering");
    expect(url.searchParams.get("typeOpdracht")).toBe("D");
    expect(url.searchParams.get("procedure")).toBe("OPE");
    expect(url.searchParams.get("publicatieDatumVanaf")).toBe("2026-01-01");
    expect(url.searchParams.get("publicatieDatumTot")).toBe("2026-12-31");
    expect(url.searchParams.get("size")).toBe("10");
    expect(url.searchParams.get("page")).toBe("0");

    expect(out.total).toBe(101);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      id: "437355",
      title: "Eigenrisicodragerschap WGA",
      opdrachtgever: "Provincie Overijssel",
      typeOpdracht: "Diensten (D)",
      europees: true,
    });
  });

  it("falls back to the marktconsultatie closing date", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        content: [
          {
            publicatieId: "1",
            aanbestedingNaam: "Marktconsultatie",
            sluitingsDatumMarktconsultatie: "2026-09-25",
          },
        ],
        totalElements: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 5 });
    expect(out.items[0].sluitingsDatum).toBe("2026-09-25");
  });

  it("drops malformed date filters and says so", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [summaryRow], totalElements: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ datumVanaf: "gisteren", rows: 5 });
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("publicatieDatumVanaf")).toBeNull();
    expect(out.access_note).toContain("Datumfilter genegeerd");
  });

  it("caps the page size at the upstream maximum of 100", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [], totalElements: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 500 });
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("size")).toBe("100");
    expect(out.access_note).toContain("maximaal 100");
  });

  it("returns detail fields and extracts the notice PDF text", async () => {
    const pdf = buildSamplePdf("Aankondiging gegunde opdracht Provincie Overijssel");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pdf")) {
        return new Response(pdf.buffer as ArrayBuffer, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return jsonResponse(detailRow);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).get({
      publicatieId: "437355",
      include_text: true,
    });

    expect(out.item.cpvCodes[0]).toMatchObject({ code: "66510000-8", hoofdopdracht: true });
    expect(out.item.nutsCodes[0].code).toBe("NL21");
    expect(out.item.juridischKader).toBe("Aanbestedingswet 2012 (NAW)");
    expect(out.item.europees).toBe(true);
    expect(out.item.gerelateerdePublicaties[0].id).toBe("431354");
    expect(out.item.pdfUrl).toContain("/publicaties/437355/pdf");
    expect(out.item.pdf_text).toContain("Provincie Overijssel");
    expect(out.item.pdf_pages).toBe(1);
  });

  it("reports a typed reason when the notice PDF cannot be read", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/pdf")) {
        return new Response("<html>error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return jsonResponse(detailRow);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).get({
      publicatieId: "437355",
      include_text: true,
    });

    expect(out.item.pdf_text).toBeUndefined();
    expect(out.item.pdf_text_unavailable_reason).toBe("not_a_pdf");
    expect(out.access_note).toContain("niet als tekst");
  });
});
