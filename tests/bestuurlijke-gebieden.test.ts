import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BestuurlijkeGebiedenSource } from "../src/sources/bestuurlijke-gebieden.js";

const config = loadConfig();

function jsonResponse(p: unknown): Response {
  return new Response(JSON.stringify(p), { status: 200, headers: { "content-type": "application/json" } });
}

const gemeenteCollection = {
  type: "FeatureCollection",
  numberReturned: 1,
  numberMatched: 1,
  features: [
    {
      type: "Feature",
      id: "GM0344",
      geometry: { type: "MultiPolygon", coordinates: [[[[5.0, 52.0], [5.2, 52.0], [5.2, 52.1], [5.0, 52.1], [5.0, 52.0]]]] },
      properties: {
        code: "0344",
        identificatie: "GM0344",
        ligt_in_provincie_code: "26",
        ligt_in_provincie_naam: "Utrecht",
        naam: "Utrecht",
      },
    },
  ],
};

describe("BestuurlijkeGebiedenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes a gemeentegebied feature and derives a bbox", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(gemeenteCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BestuurlijkeGebiedenSource(config);
    const out = await src.search({ niveau: "gemeente", naam: "Utrecht", includeGeometry: false, rows: 5 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/collections/gemeentegebied/items");
    expect(calledUrl).toContain("naam=Utrecht");
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(1);

    const item = out.items[0];
    expect(item.naam).toBe("Utrecht");
    expect(item.code).toBe("0344");
    expect(item.identificatie).toBe("GM0344");
    expect(item.ligtInProvincieNaam).toBe("Utrecht");
    expect(item.bbox).toEqual([5.0, 52.0, 5.2, 52.1]);
    expect(item.geometry).toBeUndefined();
  });

  it("includes raw geometry when includeGeometry is true", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(gemeenteCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BestuurlijkeGebiedenSource(config);
    const out = await src.search({ niveau: "gemeente", includeGeometry: true, rows: 5 });
    expect(out.items[0].geometry).toBeDefined();
    expect((out.items[0].geometry as Record<string, unknown>).type).toBe("MultiPolygon");
  });

  it("rejects an out-of-extent RD bbox without calling fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(gemeenteCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BestuurlijkeGebiedenSource(config);
    const out = await src.search({ niveau: "gemeente", bbox: "0,0,1,1", includeGeometry: false, rows: 5 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Ongeldige bbox");
  });

  it("passes a valid RD bbox with bbox-crs to the request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(gemeenteCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BestuurlijkeGebiedenSource(config);
    await src.search({ niveau: "provincie", bbox: "120000,486000,121000,487000", includeGeometry: false, rows: 5 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/collections/provinciegebied/items");
    expect(calledUrl).toContain("bbox=120000");
    expect(calledUrl).toContain("bbox-crs");
  });

  it("returns an access_note when no gebieden are found", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ type: "FeatureCollection", numberReturned: 0, numberMatched: 0, features: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BestuurlijkeGebiedenSource(config);
    const out = await src.search({ niveau: "gemeente", naam: "Nergenshuizen", includeGeometry: false, rows: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Geen gemeentegebieden");
  });

  it("resolveCode returns the code for a matched name", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(gemeenteCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BestuurlijkeGebiedenSource(config);
    const code = await src.resolveCode("gemeente", "Utrecht");
    expect(code).toBe("0344");
  });
});
