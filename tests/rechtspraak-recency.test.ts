import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";

const config = loadConfig();

describe("Rechtspraak recency intent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps 'laatste' style queries to publication-date sort and cleans the search term", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          Results: [],
          ResultCount: 0,
          FacetCounts: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "wat is laatste ECLI nummer rondom waterschade?",
      rows: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as Array<unknown> | undefined)?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));

    expect(body.SortOrder).toBe("PublicatieDatumDesc");
    expect(body.SearchTerms[0].Term).toBe("waterschade");
    expect(out.params.term).toBe("waterschade");
    expect(out.params.sortOrder).toBe("PublicatieDatumDesc");
    expect(out.access_note).toContain("Recency-intent gedetecteerd");
  });

  it("keeps year filters while still applying recency sorting", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          Results: [],
          ResultCount: 0,
          FacetCounts: {
            DatumPublicatie: [{ Identifier: "DitJaar", Count: 25 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const src = new RechtspraakSource(config);
    const out = await src.searchEcli({
      query: "wat is laatste ECLI nummer rondom waterschade in 2026?",
      rows: 5,
    });

    const init = (fetchMock.mock.calls[0] as unknown as Array<unknown> | undefined)?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));

    expect(body.SortOrder).toBe("PublicatieDatumDesc");
    expect(body.SearchTerms[0].Term).toBe("waterschade");
    expect(body.DatumPublicatie[0].Identifier).toBe("DitJaar");
    expect(out.params.publicatieFilter).toBe("DitJaar");
    expect(out.params.term).toBe("waterschade");
  });
});
