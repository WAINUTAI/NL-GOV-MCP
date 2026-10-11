import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnmiSource } from "../src/sources/knmi.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
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

/** Stub fetch with a JSON (200, application/json) body the test controls. */
function mockJsonOnce(body: unknown) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function firstUrl(fetchMock: ReturnType<typeof mockJsonOnce>): string {
  return (fetchMock.mock.calls[0] as unknown as [string])[0];
}

describe("KnmiSource.latestFiles version resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("auto-resolves the catalog version (v2) when datasetVersion is omitted", async () => {
    const fetchMock = mockJsonOnce({ files: [{ filename: "KMDS__OPER.nc" }] });
    const src = new KnmiSource(config, "test-key");
    const out = await src.latestFiles("Actuele10mindataKNMIstations", undefined, 2);

    expect(firstUrl(fetchMock)).toContain(
      "/datasets/Actuele10mindataKNMIstations/versions/2/files",
    );
    expect(out.items).toHaveLength(1);
  });

  it("resolves case-insensitively against the catalog", async () => {
    const fetchMock = mockJsonOnce({ files: [] });
    const src = new KnmiSource(config, "test-key");
    await src.latestFiles("actuele10mindataknmistations", undefined, 2);

    expect(firstUrl(fetchMock)).toContain("/versions/2/files");
  });

  it("falls back to version 1 for an unknown dataset with no version", async () => {
    const fetchMock = mockJsonOnce({ files: [] });
    const src = new KnmiSource(config, "test-key");
    await src.latestFiles("some_unknown_dataset", undefined, 2);

    expect(firstUrl(fetchMock)).toContain(
      "/datasets/some_unknown_dataset/versions/1/files",
    );
  });

  it("honors an explicitly provided version", async () => {
    const fetchMock = mockJsonOnce({ files: [] });
    const src = new KnmiSource(config, "test-key");
    await src.latestFiles("Actuele10mindataKNMIstations", "3", 2);

    expect(firstUrl(fetchMock)).toContain("/versions/3/files");
  });
});

describe("KnmiSource: the newest files, and failures as failures", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("asks for the newest files first", async () => {
    const fetchMock = mockJsonOnce({ files: [] });
    await new KnmiSource(config, "test-key").latestFiles("Actuele10mindataKNMIstations", "2", 5);

    const url = new URL(firstUrl(fetchMock));
    expect(url.searchParams.get("orderBy")).toBe("created");
    expect(url.searchParams.get("sorting")).toBe("desc");
    expect(url.searchParams.get("maxKeys")).toBe("5");
  });

  it("reads the observations from the dataset that still gets new files", async () => {
    const fetchMock = mockJsonOnce({ files: [] });
    await new KnmiSource(config, "test-key").latestObservations(5);

    expect(new URL(firstUrl(fetchMock)).pathname).toBe("/open-data/v1/datasets/10-minute-in-situ-meteorological-observations/versions/1.0/files");
  });

  it("throws a rate limit at once instead of trying the next dataset and answering 0 files", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Rate Limit Exceeded" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KnmiSource(config, "test-key").earthquakes(5)).rejects.toMatchObject({ code: "rate_limited" });
    const paths = fetchMock.mock.calls.map((c) => new URL(String((c as unknown as [string])[0])).pathname);
    expect(paths.every((p) => p.includes("/datasets/aardbevingen_nederland/versions/2/"))).toBe(true);
  });

  it("tries the next dataset on a 404 only, and throws when none exists", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new KnmiSource(config, "test-key").earthquakes(5)).rejects.toMatchObject({ status: 404 });
    const datasets = fetchMock.mock.calls.map((c) => new URL(String((c as unknown as [string])[0])).pathname.split("/")[4]);
    expect(new Set(datasets)).toEqual(new Set(["aardbevingen_nederland", "aardbevingen_catalogus"]));
    // The catalogue's aardbevingen_nederland@2 is the first candidate already: asked once.
    expect(datasets.filter((d) => d === "aardbevingen_nederland")).toHaveLength(1);
  });
});
