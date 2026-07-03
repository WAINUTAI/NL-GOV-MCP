import { beforeEach, describe, expect, it, vi } from "vitest";
import { RijksoverheidSource } from "../src/sources/rijksoverheid.js";
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

function rss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Nieuws</title>${items}</channel></rss>`;
}

const THREE_ITEMS = rss(
  [
    `<item>
      <title>Meer geld voor klimaat</title>
      <link>https://www.rijksoverheid.nl/actueel/nieuws/2026/07/03/meer-geld</link>
      <description>Het kabinet trekt extra geld uit voor klimaat.</description>
      <pubDate>Fri, 03 Jul 2026 15:34:00 GMT</pubDate>
      <guid isPermaLink="false">doc-aaa111</guid>
    </item>`,
    `<item>
      <title>Stikstofplan gepresenteerd</title>
      <link>https://www.rijksoverheid.nl/actueel/nieuws/2026/07/01/stikstofplan</link>
      <description>Nieuw stikstofplan.</description>
      <pubDate>Wed, 01 Jul 2026 10:00:00 GMT</pubDate>
      <guid isPermaLink="false">doc-bbb222</guid>
    </item>`,
    `<item>
      <title>Oud bericht</title>
      <link>https://www.rijksoverheid.nl/actueel/nieuws/2026/06/15/oud</link>
      <description>Ouder nieuws.</description>
      <pubDate>Mon, 15 Jun 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="false">doc-ccc333</guid>
    </item>`,
  ].join(""),
);

function mockFetchOnce(xml: string) {
  const fetchMock = vi.fn(async () => {
    return new Response(xml, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Read back the JSON `query` parameter that the source encoded into the URL. */
function decodeQuery(url: string): Record<string, unknown> {
  const value = new URL(url).searchParams.get("query");
  return JSON.parse(value ?? "{}") as Record<string, unknown>;
}

describe("RijksoverheidSource.search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps RSS items to lean records and puts resultSearchTerm in the URL", async () => {
    const fetchMock = mockFetchOnce(THREE_ITEMS);
    const src = new RijksoverheidSource(config);
    const out = await src.search({ query: "stikstof", top: 20 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("www.rijksoverheid.nl/api/rss");
    const query = decodeQuery(url);
    expect(query.resultSearchTerm).toBe("stikstof");

    expect(out.items).toHaveLength(3);
    const first = out.items[0];
    expect(first.id).toBe("doc-aaa111");
    expect(first.title).toBe("Meer geld voor klimaat");
    expect(first.url).toBe("https://www.rijksoverheid.nl/actueel/nieuws/2026/07/03/meer-geld");
    expect(first.snippet).toBe("Het kabinet trekt extra geld uit voor klimaat.");
    expect(first.date).toBe("2026-07-03T15:34:00.000Z");
    expect(first.type).toBe("news");
    expect(out.total).toBe(3);
    expect(out.endpoint).toContain("www.rijksoverheid.nl/api/rss");
    expect(out.params.query).toBe("stikstof");
    expect(out.params.type).toBe("news");
  });

  it("uses the news content_type filter by default and an empty filter for type=all", async () => {
    const newsMock = mockFetchOnce(THREE_ITEMS);
    const src = new RijksoverheidSource(config);
    await src.search({ query: "klimaat", top: 5 });
    const newsQuery = decodeQuery((newsMock.mock.calls[0] as unknown as [string])[0]);
    const newsFilters = newsQuery.filters as Array<Record<string, unknown>>;
    expect(newsFilters).toHaveLength(1);
    expect(newsFilters[0].field).toBe("content_type");
    expect(newsFilters[0].values).toEqual(["pro:newsDocument"]);

    const allMock = mockFetchOnce(THREE_ITEMS);
    const out = await src.search({ query: "klimaat", top: 5, type: "all" });
    const allQuery = decodeQuery((allMock.mock.calls[0] as unknown as [string])[0]);
    expect(allQuery.filters).toEqual([]);
    expect(out.items[0].type).toBe("all");
  });

  it("filters client-side on pubDate via date_from", async () => {
    mockFetchOnce(THREE_ITEMS);
    const src = new RijksoverheidSource(config);
    const out = await src.search({ query: "nieuws", top: 20, date_from: "2026-07-02" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("doc-aaa111");
    expect(out.total).toBe(1);
    expect(out.params.date_from).toBe("2026-07-02");
  });

  it("slices to top and reports the real total", async () => {
    mockFetchOnce(THREE_ITEMS);
    const src = new RijksoverheidSource(config);
    const out = await src.search({ query: "beleid", top: 2 });

    expect(out.items).toHaveLength(2);
    expect(out.total).toBe(3);
    expect(out.access_note).toMatch(/max ~20 resultaten/i);
  });

  it("returns an empty result with an explanatory access_note", async () => {
    mockFetchOnce(rss(""));
    const src = new RijksoverheidSource(config);
    const out = await src.search({ query: "zeeronwaarschijnlijk", top: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.access_note).toMatch(/Geen resultaten/i);
  });

  it("handles a single-item feed (fast-xml-parser returns an object, not an array)", async () => {
    mockFetchOnce(
      rss(
        `<item>
          <title>Enig bericht</title>
          <link>https://www.rijksoverheid.nl/actueel/nieuws/2026/07/03/enig</link>
          <description>Eén item.</description>
          <pubDate>Fri, 03 Jul 2026 15:34:00 GMT</pubDate>
          <guid isPermaLink="false">doc-solo</guid>
        </item>`,
      ),
    );
    const src = new RijksoverheidSource(config);
    const out = await src.search({ query: "enig", top: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("doc-solo");
  });
});

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

// No-year shape: a JSON ARRAY of yearly documents (each has its own canonical).
const NO_YEAR_TWO_DOCS = [
  {
    id: "doc-2024",
    type: "schoolholidays",
    canonical: "c1",
    content: [
      {
        title: "Schoolvakanties 2024-2025",
        schoolyear: "2024-2025",
        vacations: [
          {
            type: "Zomervakantie",
            compulsorydates: "19 juli 2025 t/m 31 augustus 2025",
            regions: [
              { region: "Noord", startdate: "2025-07-05", enddate: "2025-08-17" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "doc-2025",
    type: "schoolholidays",
    canonical: "c2",
    content: [
      {
        title: "Schoolvakanties 2025-2026",
        schoolyear: "2025-2026",
        vacations: [
          {
            type: "Zomervakantie",
            compulsorydates: "18 juli 2026 t/m 30 augustus 2026",
            regions: [
              { region: "Zuid", startdate: "2026-07-11", enddate: "2026-08-23" },
            ],
          },
        ],
      },
    ],
  },
];

// Single-year shape: ONE document object (not an array).
const SINGLE_YEAR_DOC = {
  id: "doc-2026",
  type: "schoolholidays",
  canonical: "c",
  content: [
    {
      title: "Schoolvakanties 2026-2027",
      schoolyear: "2026-2027",
      vacations: [
        {
          type: "Herfstvakantie",
          compulsorydates: "",
          regions: [
            { region: "Zuid", startdate: "2026-10-17", enddate: "2026-10-25" },
          ],
        },
      ],
    },
  ],
};

describe("RijksoverheidSource.schoolholidays", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("flattens the no-year JSON array across multiple school years", async () => {
    mockJsonOnce(NO_YEAR_TWO_DOCS);
    const src = new RijksoverheidSource(config);
    const out = await src.schoolholidays({});

    expect(out.items).toHaveLength(2);
    const years = out.items.map((i) => i.schoolyear);
    expect(years).toContain("2024-2025");
    expect(years).toContain("2025-2026");
    expect(out.items.every((i) => String(i.region ?? "").length > 0)).toBe(true);

    const noord = out.items.find((i) => i.region === "Noord");
    expect(noord?.canonical).toBe("c1");
    const zuid = out.items.find((i) => i.region === "Zuid");
    expect(zuid?.canonical).toBe("c2");
  });

  it("still handles the single-year JSON object", async () => {
    const fetchMock = mockJsonOnce(SINGLE_YEAR_DOC);
    const src = new RijksoverheidSource(config);
    const out = await src.schoolholidays({ year: 2026 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/schoolyear/2026-2027");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].region).toBe("Zuid");
  });

  it("narrows the no-year list with the region filter", async () => {
    mockJsonOnce(NO_YEAR_TWO_DOCS);
    const src = new RijksoverheidSource(config);
    const out = await src.schoolholidays({ region: "noord" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].region).toBe("Noord");
  });
});
