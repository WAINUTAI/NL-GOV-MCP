import { beforeEach, describe, expect, it, vi } from "vitest";
import { DnbStatisticsSource } from "../src/sources/dnb-statistics.js";
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
  observations: [
    { period: "2024-01", value: "3.75", unit: "percent", label: "ECB deposit rate", frequency: "M" },
    { period: "2024-02", value: "3.50", unit: "percent", label: "ECB deposit rate", frequency: "M" },
    { period: "2024-03", value: "3.25", unit: "percent", label: "ECB deposit rate", frequency: "M" },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DnbStatisticsSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes datapoints and forwards the Ocp-Apim-Subscription-Key header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "interest-rates", rows: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.portal.dnb.nl/interest-rates");
    const headers = init.headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");

    expect(out.items).toHaveLength(3);
    expect(out.items[0].period).toBe("2024-01");
    expect(out.items[0].value).toBe(3.75);
    expect(out.items[0].unit).toBe("percent");
    expect(out.items[0].title).toContain("ECB deposit rate");
    expect(out.endpoint).toContain("interest-rates");
    expect(out.total).toBe(3);
  });

  it("accepts a full endpoint URL for the dataset argument and passes period filters as query params", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    await src.search({
      dataset: "https://api.portal.dnb.nl/statistics/v1/exchange-rates",
      startPeriod: "2024-01",
      endPeriod: "2024-03",
      rows: 20,
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/statistics/v1/exchange-rates");
    expect(url).toContain("startPeriod=2024-01");
    expect(url).toContain("endPeriod=2024-03");
  });

  it("extracts datapoints from an alternate container key and coerces numeric values", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { data: [{ Period: "2023", Value: 1234.5, Unit: "EUR mln" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "balance-of-payments", rows: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].period).toBe("2023");
    expect(out.items[0].value).toBe(1234.5);
    expect(out.items[0].unit).toBe("EUR mln");
  });

  it("applies the client-side free-text query filter", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleResponse));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "interest-rates", query: "2024-02", rows: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].period).toBe("2024-02");
  });

  it("returns an empty result set when the response has no recognizable datapoints", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "no data" }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DnbStatisticsSource(config, "test-key");
    const out = await src.search({ dataset: "unknown-dataset", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.endpoint).toContain("unknown-dataset");
  });
});
