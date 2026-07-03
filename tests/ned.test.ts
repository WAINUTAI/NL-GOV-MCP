import { beforeEach, describe, expect, it, vi } from "vitest";
import { NedSource } from "../src/sources/ned.js";
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

const sampleHydra = {
  "@context": "/v1/contexts/Utilization",
  "@id": "/v1/utilizations",
  "@type": "hydra:Collection",
  "hydra:totalItems": 4711,
  "hydra:member": [
    {
      "@id": "/v1/utilizations/101",
      "@type": "Utilization",
      id: 101,
      point: "/v1/points/0",
      type: "/v1/energy_carriers/2",
      granularity: "/v1/granularities/5",
      activity: "/v1/activities/1",
      classification: "/v1/classifications/2",
      capacity: "1500.5",
      volume: "1200.25",
      percentage: "42.7",
      emission: "0",
      emissionfactor: "0",
      validfrom: "2024-06-01T10:00:00+00:00",
      validto: "2024-06-01T11:00:00+00:00",
      lastupdate: "2024-06-01T11:05:00+00:00",
    },
    {
      "@id": "/v1/utilizations/102",
      "@type": "Utilization",
      id: 102,
      point: "/v1/points/0",
      type: "/v1/energy_carriers/2",
      granularity: "/v1/granularities/5",
      activity: "/v1/activities/1",
      classification: "/v1/classifications/2",
      capacity: "1600",
      volume: "1300",
      percentage: "45.1",
      validfrom: "2024-06-01T11:00:00+00:00",
      validto: "2024-06-01T12:00:00+00:00",
    },
  ],
  "hydra:view": { "@id": "/v1/utilizations?page=1", "@type": "hydra:PartialCollectionView" },
};

function mockFetchOnce(payload: unknown) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/ld+json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("NedSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the X-AUTH-TOKEN header and maps energy-source aliases to NED codes", async () => {
    const fetchMock = mockFetchOnce(sampleHydra);
    const src = new NedSource(config, "secret-token");
    await src.search({ type: "zon", granularity: "hour", activity: "opwek", rows: 20 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-AUTH-TOKEN"]).toBe("secret-token");
    expect(url).toContain("/v1/utilizations");
    expect(url).toContain("type=2"); // zon → 2
    expect(url).toContain("granularity=5"); // hour → 5
    expect(url).toContain("activity=1"); // opwek → 1
    expect(url).toContain("classification=2"); // default measured
  });

  it("normalizes Hydra members into lean records with IRI tails and numeric fields", async () => {
    mockFetchOnce(sampleHydra);
    const src = new NedSource(config, "k");
    const out = await src.search({ type: "zon", rows: 20 });

    expect(out.items).toHaveLength(2);
    const first = out.items[0];
    expect(first.id).toBe("101");
    expect(first.type).toBe("2");
    expect(first.typeLabel).toBe("Solar");
    expect(first.point).toBe("0");
    expect(first.granularity).toBe("5");
    expect(first.capacity).toBe(1500.5);
    expect(first.volume).toBe(1200.25);
    expect(first.percentage).toBe(42.7);
    expect(first.url).toBe("https://api.ned.nl/v1/utilizations/101");
    expect(first.title).toContain("Solar");
    expect(out.total).toBe(4711);
    expect(out.endpoint).toContain("/v1/utilizations");
  });

  it("passes numeric codes through untouched and applies the validfrom time window", async () => {
    const fetchMock = mockFetchOnce(sampleHydra);
    const src = new NedSource(config, "k");
    await src.search({
      type: 17,
      point: 14,
      validFrom: "2024-06-01",
      validTo: "2024-06-02",
      rows: 20,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("type=17");
    expect(decoded).toContain("point=14");
    expect(decoded).toContain("validfrom[after]=2024-06-01");
    expect(decoded).toContain("validfrom[before]=2024-06-02");
  });

  it("adds a default validfrom window when the caller omits the date range (NED requires it)", async () => {
    const fetchMock = mockFetchOnce(sampleHydra);
    const src = new NedSource(config, "k");
    await src.search({ type: "zon", rows: 5 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const decoded = decodeURIComponent(url);
    // Without an explicit range, both bounds must still be present (else NED 400s).
    expect(decoded).toMatch(/validfrom\[after\]=\d{4}-\d{2}-\d{2}/);
    expect(decoded).toMatch(/validfrom\[before\]=\d{4}-\d{2}-\d{2}/);
  });

  it("respects the requested row cap when slicing members", async () => {
    mockFetchOnce(sampleHydra);
    const src = new NedSource(config, "k");
    const out = await src.search({ rows: 1 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("101");
    // total still reflects the upstream hydra:totalItems, not the sliced count
    expect(out.total).toBe(4711);
  });

  it("returns an empty result set when hydra:member is missing", async () => {
    mockFetchOnce({ "@id": "/v1/utilizations", "hydra:totalItems": 0 });
    const src = new NedSource(config, "k");
    const out = await src.search({ type: "kern", rows: 20 });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });
});
