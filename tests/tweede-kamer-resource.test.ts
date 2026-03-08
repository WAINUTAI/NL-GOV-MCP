import { beforeEach, describe, expect, it, vi } from "vitest";
import { TweedeKamerSource } from "../src/sources/tweede-kamer.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  server: {
    name: "nl-gov-mcp",
    version: "0.1.0",
    httpPort: 3333,
  },
  temporal: {
    defaultTimeZone: "Europe/Amsterdam",
  },
  cacheTtlMs: {
    default: 0,
    cbsCatalog: 0,
    tkEntityLists: 0,
    knmiObservations: 0,
    knmiHistorical: 0,
    dataOverheidDatasetList: 0,
    rijksoverheidLists: 0,
  },
  limits: {
    defaultRows: 25,
    maxRows: 200,
  },
  endpoints: {
    dataOverheid: "https://data.overheid.nl/data/api/3/action",
    cbsV4: "https://odata4.cbs.nl/CBS",
    cbsV3: "https://opendata.cbs.nl/ODataApi/OData",
    tweedeKamer: "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0",
    bekendmakingenSru: "https://repository.overheid.nl/sru",
    rijksoverheid: "https://opendata.rijksoverheid.nl/v1",
    knmi: "https://api.dataplatform.knmi.nl/open-data/v1",
    rijksbegroting: "https://opendata.rijksbegroting.nl",
    duoDatasets: "https://onderwijsdata.duo.nl",
    duoRio: "https://lod.onderwijsregistratie.nl/rio-api",
    apiRegister: "https://apis.developer.overheid.nl",
  },
};

describe("TweedeKamerSource.getDocument", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns lean metadata by default", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/Document(doc-1)");
      return new Response(
        JSON.stringify({
          Id: "doc-1",
          Onderwerp: "Test document",
          ContentType: "application/pdf",
          ContentLength: 12345,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const source = new TweedeKamerSource(config);
    const out = await source.getDocument({ id: "doc-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.item.resource_url).toContain("/Document(doc-1)/Resource");
    expect(out.item.typed_resource_url).toContain("/Document(doc-1)/TK.DA.GGM.OData.Resource");
    expect(out.item.resource_resolved).toBeUndefined();
    expect(out.item.text_preview).toBeUndefined();
  });

  it("resolves resource metadata without fetching text for pdf", async () => {
    const fetchMock = vi.fn(async (_url: string) => {
      return new Response(
        JSON.stringify({
          Id: "doc-2",
          Onderwerp: "PDF document",
          ContentType: "application/pdf",
          ContentLength: 54321,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const source = new TweedeKamerSource(config);
    const out = await source.getDocument({ id: "doc-2", resolve_resource: true, include_text: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.item.resource_resolved).toBe(true);
    expect(out.item.resolved_resource_url).toContain("/Document(doc-2)/Resource");
    expect(out.item.resource_content_type).toBe("application/pdf");
    expect(out.item.resource_content_length).toBe(54321);
    expect(out.item.text_preview_unavailable_reason).toBe("pdf_not_extracted_in_lean_mode");
    expect(out.item.text_preview).toBeUndefined();
  });

  it("fetches capped text preview for text-like resources", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/Document(doc-3)/Resource")) {
        return new Response("<html><body><h1>Hallo</h1><p>wereld en nog meer tekst</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }

      if (url.includes("/Document(doc-3)")) {
        return new Response(
          JSON.stringify({
            Id: "doc-3",
            Onderwerp: "HTML document",
            ContentType: "text/html",
            ContentLength: 999,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const source = new TweedeKamerSource(config);
    const out = await source.getDocument({ id: "doc-3", include_text: true, max_chars: 12 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.item.text_preview).toBe("Hallo wereld…");
    expect(out.item.text_preview_truncated).toBe(true);
    expect(out.item.text_preview_chars).toBe(13);
    expect(out.item.resolved_resource_url).toContain("/Document(doc-3)/Resource");
  });
});
