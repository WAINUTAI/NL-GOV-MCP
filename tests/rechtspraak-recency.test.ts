import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";

const config = loadConfig();

function getMockRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[0] as unknown as Array<unknown> | undefined;
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

function mockFetch(facetCounts: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        Results: [],
        ResultCount: 0,
        FacetCounts: facetCounts,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Rechtspraak structured parameters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sort=date_newest maps to PublicatieDatumDesc", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "waterschade",
      rows: 5,
      sort: "date_newest",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("PublicatieDatumDesc");
    expect(body.SearchTerms[0].Term).toBe("waterschade");
    expect(out.params.sortOrder).toBe("PublicatieDatumDesc");
  });

  it("sort=ruling_newest maps to UitspraakDatumDesc", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "huurrecht",
      rows: 5,
      sort: "ruling_newest",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("UitspraakDatumDesc");
  });

  it("default sort is Relevance", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    await src.searchEcli({ query: "waterschade", rows: 5 });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("Relevance");
  });

  it("date_filter=year sets DitJaar facet", async () => {
    const fetchMock = mockFetch({
      DatumPublicatie: [{ Identifier: "DitJaar", Count: 25 }],
    });
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "waterschade",
      rows: 5,
      sort: "date_newest",
      date_filter: "year",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.SortOrder).toBe("PublicatieDatumDesc");
    expect(body.DatumPublicatie[0].Identifier).toBe("DitJaar");
    expect(out.params.publicatieFilter).toBe("DitJaar");
    expect(out.params.term).toBe("waterschade");
  });

  it("date_filter=month sets BinnenEenMaand facet", async () => {
    const fetchMock = mockFetch();
    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "huurrecht",
      rows: 5,
      date_filter: "month",
    });

    const body = getMockRequestBody(fetchMock);
    expect(body.DatumPublicatie[0].Identifier).toBe("BinnenEenMaand");
    expect(out.params.publicatieFilter).toBe("BinnenEenMaand");
  });
});
