import { beforeEach, describe, expect, it, vi } from "vitest";
import { DsoOmgevingsdocumentenSource } from "../src/sources/dso-omgevingsdocumenten.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  server: { name: "nl-gov-mcp", version: "0.1.0", httpPort: 3333 },
  temporal: { defaultTimeZone: "Europe/Amsterdam" },
  cacheTtlMs: {
    default: 0,
    cbsCatalog: 0,
    tkEntityLists: 0,
    knmiObservations: 0,
    knmiHistorical: 0,
    dataOverheidDatasetList: 0,
    rijksoverheidLists: 0,
  },
  limits: { defaultRows: 25, maxRows: 200 },
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

const sampleResponse = {
  _embedded: {
    regelingen: [
      {
        identificatie: "/akn/nl/act/gm0344/2024/omgevingsplan-001",
        officieleTitel: "Omgevingsplan Utrecht",
        citeerTitel: "Omgevingsplan Utrecht 2024",
        type: { code: "/join/id/stop/regelingtype_002", waarde: "Omgevingsplan" },
        aangeleverdDoorEen: { naam: "gemeente Utrecht", bestuurslaag: "gemeentebestuur", code: "gm0344" },
        geregistreerdMet: {
          versie: 3,
          beginInwerking: "2024-01-01",
          beginGeldigheid: "2024-01-01",
          tijdstipRegistratie: "2024-01-01T00:00:00Z",
        },
        _links: { self: { href: "https://service.omgevingswet.overheid.nl/.../regelingen/abc" } },
      },
      {
        identificatie: "/akn/nl/act/pv24/2024/omgevingsvisie-001",
        officieleTitel: "Omgevingsvisie provincie Utrecht",
        type: { code: "/join/id/stop/regelingtype_001", waarde: "Omgevingsvisie" },
        aangeleverdDoorEen: { naam: "provincie Utrecht", bestuurslaag: "provinciebestuur", code: "pv24" },
        geregistreerdMet: {
          versie: 1,
          beginInwerking: "2023-06-01",
          beginGeldigheid: "2023-06-01",
          tijdstipRegistratie: "2023-06-01T00:00:00Z",
        },
        _links: { self: { href: "https://service.omgevingswet.overheid.nl/.../regelingen/def" } },
      },
    ],
  },
  page: { size: 20, totalElements: 2, totalPages: 1, number: 1 },
};

function mockFetchOnce(payload: unknown) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/hal+json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DsoOmgevingsdocumentenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws when API key is missing", async () => {
    const src = new DsoOmgevingsdocumentenSource(config);
    await expect(src.search({ rows: 5 })).rejects.toThrow(/DSO_API_KEY/);
  });

  it("uses GET /regelingen and forwards x-api-key when no bevoegd-gezag filter", async () => {
    const fetchMock = mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 11 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/presenteren/v8/regelingen");
    expect(url).not.toContain("/_zoek");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");

    expect(out.items).toHaveLength(2);
    expect(out.items[0].title).toBe("Omgevingsplan Utrecht");
    expect(out.items[0].documentType).toBe("Omgevingsplan");
    expect(out.items[0].bevoegdGezag).toBe("gemeente Utrecht");
    expect(out.items[0].bevoegdGezagCode).toBe("gm0344");
    expect(out.items[0].viewerUrl).toContain("regels-op-de-kaart/viewer");
    expect(out.total).toBe(2);
  });

  it("POSTs to /regelingen/_zoek when bevoegd-gezag filter is provided", async () => {
    const fetchMock = mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    await src.search({ rows: 12, typeBevoegdGezag: "gemeente", bevoegdGezag: "gm0344" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/regelingen/_zoek");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.typeBevoegdGezag).toEqual(["gemeente"]);
    expect(body.bevoegdGezag).toEqual(["gm0344"]);
  });

  it("filters client-side by documentType (case-insensitive substring on type.waarde)", async () => {
    mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 13, documentType: "omgevingsvisie" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].documentType).toBe("Omgevingsvisie");
  });

  it("filters client-side by free-text query against title and bevoegd-gezag fields", async () => {
    mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 14, query: "provincie utrecht" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].bevoegdGezag).toBe("provincie Utrecht");
  });

  it("returns total from page.totalElements when present", async () => {
    mockFetchOnce({ ...sampleResponse, page: { ...sampleResponse.page, totalElements: 4711 } });
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 15 });

    expect(out.total).toBe(4711);
  });
});
