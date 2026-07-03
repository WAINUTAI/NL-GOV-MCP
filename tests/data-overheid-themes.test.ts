import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataOverheidSource } from "../src/sources/data-overheid.js";
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

// 2 main themes (no parent) + 1 sub-theme whose parent is Economie.
const TAXONOMY = {
  "https://identifier.overheid.nl/tooi/def/thes/kern/c_economie": {
    labels: { "nl-NL": "Economie", "en-US": "Economy" },
  },
  "https://identifier.overheid.nl/tooi/def/thes/kern/c_bestuur": {
    labels: { "nl-NL": "Bestuur", "en-US": "Public administration" },
  },
  "https://identifier.overheid.nl/tooi/def/thes/kern/c_begroting": {
    labels: { "nl-NL": "Begroting", "en-US": "Budget" },
    parent: "https://identifier.overheid.nl/tooi/def/thes/kern/c_economie",
  },
};

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

describe("DataOverheidSource.themes (taxonomy waardelijst)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("returns main-first, alphabetical items with resolved parents", async () => {
    const fetchMock = mockJsonOnce(TAXONOMY);
    const src = new DataOverheidSource(config);
    const out = await src.themes();

    // It hit the canonical waardelijst, not CKAN group_list.
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain(
      "overheid_taxonomiebeleidsagenda.json",
    );
    expect(out.endpoint).toContain("overheid_taxonomiebeleidsagenda.json");

    expect(out.items).toHaveLength(3);

    // Main themes first (alphabetical), then sub-themes (alphabetical).
    expect(out.items.map((i) => i.title)).toEqual(["Bestuur", "Economie", "Begroting"]);
    expect(out.items[0].level).toBe("main");
    expect(out.items[1].level).toBe("main");
    expect(out.items[2].level).toBe("sub");

    // Titles/names populated for the tool layer.
    expect(out.items.every((i) => i.title.length > 0 && i.name.length > 0)).toBe(true);

    // Sub-theme parent resolved to the parent's nl label.
    const sub = out.items[2];
    expect(sub.title).toBe("Begroting");
    expect(sub.parent).toBe("Economie");
    expect(sub.name_en).toBe("Budget");
  });
});
