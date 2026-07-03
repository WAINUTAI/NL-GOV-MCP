import { beforeEach, describe, expect, it, vi } from "vitest";
import { EpOnlineSource } from "../src/sources/ep-online.js";
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

const sampleLabels = [
  {
    Energieklasse: "A",
    Registratiedatum: "2021-05-03T00:00:00",
    Opnamedatum: "2021-04-28T00:00:00",
    Geldig_tot: "2031-05-03T00:00:00",
    Gebouwtype: "Woonfunctie",
    Gebouwklasse: "W",
    Postcode: "3511LX",
    Huisnummer: 12,
    Huisletter: null,
    Huisnummertoevoeging: null,
    BAGVerblijfsobjectID: "0344010000000001",
    BAGPandIDs: ["0344100000000001"],
    EnergieIndex: null,
    Energiebehoefte: 45.2,
    Bouwjaar: 1998,
    Certificaathouder: "Voorbeeld Adviesbureau",
  },
];

function mockFetchOnce(payload: unknown) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("EpOnlineSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("queries the Adres endpoint with postcode+huisnummer and the Authorization header", async () => {
    const fetchMock = mockFetchOnce(sampleLabels);
    const src = new EpOnlineSource(config, "secret-key");
    const out = await src.search({ postcode: "3511 lx", huisnummer: 12, rows: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/v5/PandEnergielabel/Adres");
    expect(url).toContain("postcode=3511LX");
    expect(url).toContain("huisnummer=12");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("secret-key");

    expect(out.items).toHaveLength(1);
    expect(out.items[0].energieklasse).toBe("A");
    expect(out.items[0].title).toContain("Energielabel A");
    expect(out.items[0].bagVerblijfsobjectId).toBe("0344010000000001");
    expect(out.items[0].url).toBe("https://www.ep-online.nl");
    expect(out.params.postcode).toBe("3511LX");
    expect(out.endpoint).toContain("/PandEnergielabel/Adres");
  });

  it("uses the AdresseerbaarObject endpoint when bagId is provided", async () => {
    const fetchMock = mockFetchOnce(sampleLabels);
    const src = new EpOnlineSource(config, "secret-key");
    const out = await src.search({ bagId: "0344010000000001", rows: 5 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/PandEnergielabel/AdresseerbaarObject/0344010000000001");
    expect(url).not.toContain("/Adres?");
    expect(out.params.bagId).toBe("0344010000000001");
  });

  it("throws when neither bagId nor postcode+huisnummer is given", async () => {
    const src = new EpOnlineSource(config, "secret-key");
    await expect(src.search({ postcode: "3511LX", rows: 5 })).rejects.toThrow(
      /postcode \+ huisnummer/,
    );
  });

  it("returns an empty result set when the register has no label for the address", async () => {
    mockFetchOnce([]);
    const src = new EpOnlineSource(config, "secret-key");
    const out = await src.search({ postcode: "1000AA", huisnummer: 1, rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
  });

  it("normalizes a single (non-array) object response into one item", async () => {
    mockFetchOnce(sampleLabels[0]);
    const src = new EpOnlineSource(config, "secret-key");
    const out = await src.search({ postcode: "3511LX", huisnummer: 12, rows: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].energiebehoefte).toBe(45.2);
    expect(out.items[0].bouwjaar).toBe(1998);
  });
});
