import { beforeEach, describe, expect, it, vi } from "vitest";
import { NsReisinformatieSource } from "../src/sources/ns-reisinformatie.js";
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

const disruptionsPayload = [
  {
    id: "GVB-123",
    type: "MAINTENANCE",
    title: "Werkzaamheden tussen Utrecht en Amersfoort",
    topic: "Utrecht - Amersfoort",
    isActive: true,
    start: "2026-07-05T00:00:00+02:00",
    end: "2026-07-06T04:00:00+02:00",
    phase: { id: "actual", label: "Nu bezig" },
    timespans: [{ cause: { label: "werkzaamheden" }, situation: { label: "Er rijden geen treinen" } }],
  },
  {
    id: "DIS-999",
    type: "DISRUPTION",
    title: "Verstoring bij Amsterdam",
    isActive: false,
    start: "2026-07-04T09:00:00+02:00",
  },
];

const departuresPayload = {
  payload: {
    departures: [
      {
        direction: "Amsterdam Centraal",
        name: "IC 1425",
        plannedDateTime: "2026-07-03T08:12:00+0200",
        actualDateTime: "2026-07-03T08:15:00+0200",
        plannedTrack: "5",
        actualTrack: "8",
        cancelled: false,
        trainCategory: "Intercity",
        product: { number: "1425", operatorName: "NS", categoryCode: "IC" },
        routeStations: [{ mediumName: "Utrecht C." }, { mediumName: "Amsterdam C." }],
      },
    ],
  },
};

describe("NsReisinformatieSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls v3/disruptions with the subscription-key header and normalizes disruptions", async () => {
    const fetchMock = mockFetchOnce(disruptionsPayload);
    const src = new NsReisinformatieSource(config, "test-key");
    const out = await src.search({ operation: "disruptions", rows: 20 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/reisinformatie-api/api/v3/disruptions");
    expect(url).toContain("isActive=true");
    const headers = init.headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");

    expect(out.items).toHaveLength(2);
    expect(out.items[0].title).toBe("Werkzaamheden tussen Utrecht en Amersfoort");
    expect(out.items[0].disruptionType).toBe("MAINTENANCE");
    expect(out.items[0].phase).toBe("Nu bezig");
    expect(out.items[0].cause).toBe("werkzaamheden");
    expect(out.items[0].url).toContain("ns.nl/storingen");
    expect(out.params.operation).toBe("disruptions");
    expect(out.endpoint).toContain("v3/disruptions");
  });

  it("calls v2/departures with station + maxJourneys and normalizes departures", async () => {
    const fetchMock = mockFetchOnce(departuresPayload);
    const src = new NsReisinformatieSource(config, "test-key");
    const out = await src.search({ operation: "departures", station: "UT", rows: 5 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/reisinformatie-api/api/v2/departures");
    expect(url).toContain("station=UT");
    expect(url).toContain("maxJourneys=5");

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("Intercity naar Amsterdam Centraal");
    expect(out.items[0].actualTrack).toBe("8");
    expect(out.items[0].operator).toBe("NS");
    expect(out.items[0].station).toBe("UT");
    expect(out.items[0].routeText).toBe("Utrecht C. - Amsterdam C.");
  });

  it("throws when a required station is missing for departures", async () => {
    mockFetchOnce(departuresPayload);
    const src = new NsReisinformatieSource(config, "test-key");
    await expect(src.search({ operation: "departures", rows: 5 })).rejects.toThrow(/station is required/);
  });

  it("throws when trips are missing from/to stations", async () => {
    mockFetchOnce({ trips: [] });
    const src = new NsReisinformatieSource(config, "test-key");
    await expect(src.search({ operation: "trips", fromStation: "UT", rows: 5 })).rejects.toThrow(
      /fromStation and toStation/,
    );
  });

  it("returns an empty result set when the payload has no items", async () => {
    mockFetchOnce({ payload: { departures: [] } });
    const src = new NsReisinformatieSource(config, "test-key");
    const out = await src.search({ operation: "departures", station: "ASD", rows: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
  });
});
