import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DataPolitieSource } from "../src/sources/data-politie.js";

const config = loadConfig();

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const dataSet = {
  value: [
    {
      ID: 0,
      SoortMisdrijf: "0.0.0 ",
      RegioS: "GM0363",
      Perioden: "2023JJ00",
      GeregistreerdeMisdrijven_1: 8636,
      Aangiften_2: 7000,
      Internetaangiften_3: 1200,
    },
    {
      ID: 1,
      SoortMisdrijf: "0.0.0 ",
      RegioS: "GM0363",
      Perioden: "2022JJ00",
      GeregistreerdeMisdrijven_1: 9100,
      Aangiften_2: 7400,
      Internetaangiften_3: 1300,
    },
  ],
};

const regioDim = {
  value: [
    { Key: "GM0363  ", Title: "Amsterdam", Description: "gemeente", CategoryGroupID: null },
    { Key: "GM0599  ", Title: "Rotterdam", Description: "gemeente", CategoryGroupID: null },
  ],
};

describe("DataPolitieSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters TypedDataSet by RegioS code and normalizes measure fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(dataSet));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DataPolitieSource(config);
    const out = await src.search({ regio: "GM0363", rows: 20 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/47013NED/TypedDataSet");
    expect(decodeURIComponent(calledUrl)).toContain("trim(RegioS) eq 'GM0363'");

    expect(out.items).toHaveLength(2);
    expect(out.items[0].regio).toBe("GM0363");
    expect(out.items[0].soortMisdrijf).toBe("0.0.0");
    expect(out.items[0].GeregistreerdeMisdrijven_1).toBe(8636);
    expect(out.items[0].url).toContain("data.politie.nl");
    expect(out.total).toBe(2);
  });

  it("treats a bare year period as a startswith prefix match", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(dataSet));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DataPolitieSource(config);
    await src.search({ periode: "2023", rows: 5 });

    const calledUrl = decodeURIComponent(
      String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]),
    );
    expect(calledUrl).toContain("startswith(Perioden,'2023')");
  });

  it("resolves a RegioS name to its Key via a dimension lookup", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/RegioS")) return jsonResponse(regioDim);
      return jsonResponse(dataSet);
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = new DataPolitieSource(config);
    await src.search({ regio: "Amsterdam", rows: 5 });

    const dataCall = fetchMock.mock.calls.find((c) =>
      String((c as unknown as Array<unknown>)[0]).includes("/TypedDataSet"),
    );
    expect(dataCall).toBeDefined();
    const dataUrl = decodeURIComponent(String((dataCall as unknown as Array<unknown>)[0]));
    expect(dataUrl).toContain("trim(RegioS) eq 'GM0363'");
  });

  it("explores a dimension and filters client-side by query", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(regioDim));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DataPolitieSource(config);
    const out = await src.search({ dimension: "RegioS", query: "rotterdam", rows: 50 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/47013NED/RegioS");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].key).toBe("GM0599");
    expect(out.items[0].title).toBe("Rotterdam");
  });

  it("returns an empty item list when the dataset has no rows", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new DataPolitieSource(config);
    const out = await src.search({ regio: "GM9999", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
  });
});
