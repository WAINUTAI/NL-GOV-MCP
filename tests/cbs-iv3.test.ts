import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CbsIv3Source } from "../src/sources/cbs-iv3.js";

const config = loadConfig();

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * URLSearchParams serialises a space as '+', which plain decodeURIComponent
 * leaves intact. Normalise '+' back to a space first so the decoded query
 * reads as the OData server parses it (both '+' and %20 mean space there).
 */
function decodeUrl(raw: unknown): string {
  return decodeURIComponent(String(raw).replace(/\+/g, " "));
}

const dataSet = {
  value: [
    {
      ID: 0,
      TaakveldBalanspost: "0.1   ",
      Categorie: "L1.1    ",
      Gemeenten: "GM1680   ",
      Verslagsoort: "2025X000",
      k_1ePlaatsing_1: 1208.0,
      k_2ePlaatsing_2: 1208.0,
    },
  ],
};

const verslagsoortDim = {
  value: [
    { Key: "2025X000", Title: "Begroting 2025", Description: "", CategoryGroupID: null },
    { Key: "2024X000", Title: "Jaarrekening 2024", Description: "", CategoryGroupID: null },
  ],
};

describe("CbsIv3Source", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters TypedDataSet by Gemeenten code and normalizes amount fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(dataSet));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CbsIv3Source(config);
    const out = await src.search({ gemeente: "GM1680", rows: 20 });

    const calledUrl = decodeUrl((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/45071NED/TypedDataSet");
    expect(calledUrl).toContain("trim(Gemeenten) eq 'GM1680'");

    expect(out.items).toHaveLength(1);
    expect(out.items[0].gemeente).toBe("GM1680");
    expect(out.items[0].taakveldBalanspost).toBe("0.1");
    expect(out.items[0].k_1ePlaatsing_1).toBe(1208);
    expect(out.items[0].url).toContain("dataset/45071NED");
  });

  it("resolves a Verslagsoort name (begroting) to its Key via a dimension lookup", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/Verslagsoort")) return jsonResponse(verslagsoortDim);
      return jsonResponse(dataSet);
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = new CbsIv3Source(config);
    await src.search({ verslagsoort: "Begroting", rows: 5 });

    const dataCall = fetchMock.mock.calls.find((c) =>
      String((c as unknown as Array<unknown>)[0]).includes("/TypedDataSet"),
    );
    expect(dataCall).toBeDefined();
    const dataUrl = decodeUrl((dataCall as unknown as Array<unknown>)[0]);
    expect(dataUrl).toContain("trim(Verslagsoort) eq '2025X000'");
  });

  it("combines multiple dimension filters with 'and'", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(dataSet));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CbsIv3Source(config);
    await src.search({ gemeente: "GM1680", taakveldBalanspost: "0.1", rows: 5 });

    const calledUrl = decodeUrl((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("trim(Gemeenten) eq 'GM1680'");
    expect(calledUrl).toContain("trim(TaakveldBalanspost) eq '0.1'");
    expect(calledUrl).toContain(" and ");
  });

  it("explores the Verslagsoort dimension", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(verslagsoortDim));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CbsIv3Source(config);
    const out = await src.search({ dimension: "Verslagsoort", rows: 50 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/45071NED/Verslagsoort");
    expect(out.items).toHaveLength(2);
    expect(out.items[0].key).toBe("2025X000");
  });

  it("returns an empty item list when the dataset has no rows", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new CbsIv3Source(config);
    const out = await src.search({ gemeente: "GM9999", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
  });
});
