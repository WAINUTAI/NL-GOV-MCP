import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuoSource } from "../src/sources/duo.js";
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

/**
 * Mock DUO CKAN `package_search`: returns 2 datasets per query, keyed by the
 * `q` term so ids are unique across candidates. This mirrors reality where a
 * topic term matches national datasets and a municipality-ANDed term returns 0.
 */
function mockCkan() {
  const fetchMock = vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get("q") ?? "";
    const results = [
      { id: `${q}-1`, title: `Dataset ${q} 1` },
      { id: `${q}-2`, title: `Dataset ${q} 2` },
    ];
    return new Response(
      JSON.stringify({ success: true, result: { count: 2, results } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function issuedQueries(fetchMock: ReturnType<typeof mockCkan>): string[] {
  return fetchMock.mock.calls.map((c) => {
    const url = (c as unknown as [string])[0];
    return new URL(url).searchParams.get("q") ?? "";
  });
}

describe("DuoSource topic-only candidate queries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("getSchools returns results and never ANDs the municipality into the query", async () => {
    const fetchMock = mockCkan();
    const src = new DuoSource(config);
    const out = await src.getSchools({ municipality: "amsterdam", top: 3 });

    expect(out.items.length).toBeGreaterThanOrEqual(1);

    const qs = issuedQueries(fetchMock);
    // The first issued CKAN query is a proven topic term (not municipality-ANDed).
    expect(qs[0]).toBe("schooladressen");
    // No issued query contains the municipality (which would zero out the result).
    for (const q of qs) {
      expect(q.toLowerCase()).not.toContain("amsterdam");
    }
    // The municipality is still surfaced as a soft hint in the params.
    expect(out.params.hint).toBe("amsterdam");
  });

  it("getExamResults returns results and never ANDs year/municipality into the query", async () => {
    const fetchMock = mockCkan();
    const src = new DuoSource(config);
    const out = await src.getExamResults({ year: 2024, municipality: "amsterdam", top: 3 });

    expect(out.items.length).toBeGreaterThanOrEqual(1);

    const qs = issuedQueries(fetchMock);
    expect(qs[0]).toBe("examen");
    for (const q of qs) {
      expect(q).not.toMatch(/amsterdam|2024/i);
    }
    expect(out.params.hint).toBe("2024 amsterdam");
  });
});
