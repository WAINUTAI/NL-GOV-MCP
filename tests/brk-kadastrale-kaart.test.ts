import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BrkKadastraleKaartSource } from "../src/sources/brk-kadastrale-kaart.js";

const config = loadConfig();

function jsonResponse(p: unknown): Response {
  return new Response(JSON.stringify(p), { status: 200, headers: { "content-type": "application/json" } });
}

const perceelCollection = {
  type: "FeatureCollection",
  numberReturned: 1,
  features: [
    {
      type: "Feature",
      id: "5142388d-dd85-5292-84bc-4f215d73edaf",
      geometry: { type: "MultiPolygon", coordinates: [[[[4.88, 52.36], [4.881, 52.36], [4.881, 52.361], [4.88, 52.361], [4.88, 52.36]]]] },
      properties: {
        akr_kadastrale_gemeente_code_waarde: "ASD13",
        identificatie_lokaal_id: "11540206070000",
        kadastrale_gemeente_waarde: "Amsterdam",
        kadastrale_grootte_waarde: 100,
        perceelnummer: 2060,
        sectie: "Q",
        status_historie_waarde: "Geldig",
      },
    },
  ],
};

describe("BrkKadastraleKaartSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes a perceel feature into a kadastrale aanduiding", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(perceelCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BrkKadastraleKaartSource(config);
    const out = await src.search({ collectie: "perceel", bbox: "120000,486000,120300,486300", includeGeometry: false, rows: 10 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/collections/perceel/items");
    expect(calledUrl).toContain("bbox=120000");
    expect(calledUrl).toContain("bbox-crs");

    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.kadastraleAanduiding).toBe("Amsterdam Q 2060");
    expect(item.title).toBe("Amsterdam Q 2060");
    expect(item.kadastraleGrootteM2).toBe("100");
    expect(item.bbox).toBeDefined();
    expect(item.geometry).toBeUndefined();
  });

  it("uses the tekst property as title for openbareruimtenaam", async () => {
    const collection = {
      type: "FeatureCollection",
      numberReturned: 1,
      features: [
        {
          type: "Feature",
          id: "d580de44",
          geometry: { type: "LineString", coordinates: [[4.88, 52.36], [4.89, 52.37]] },
          properties: { tekst: "Beulingsloot", openbare_ruimte_type: "Water", bronhouder: "G0363", identificatie_lokaal_id: "G0363.abc" },
        },
      ],
    };
    const fetchMock = vi.fn(async () => jsonResponse(collection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BrkKadastraleKaartSource(config);
    const out = await src.search({ collectie: "openbareruimtenaam", bbox: "120000,486000,121000,487000", includeGeometry: false, rows: 10 });
    expect(out.items[0].title).toBe("Beulingsloot");
    expect(out.items[0].tekst).toBe("Beulingsloot");
  });

  it("requires a bbox and returns an access_note when omitted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(perceelCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BrkKadastraleKaartSource(config);
    const out = await src.search({ collectie: "perceel", includeGeometry: false, rows: 10 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("RD-bbox");
  });

  it("rejects an out-of-extent RD bbox without calling fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(perceelCollection));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BrkKadastraleKaartSource(config);
    const out = await src.search({ collectie: "perceel", bbox: "0,0,1,1", includeGeometry: false, rows: 10 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.access_note).toContain("Ongeldige bbox");
  });

  it("returns a no-results access_note for an empty collection", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ type: "FeatureCollection", numberReturned: 0, features: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BrkKadastraleKaartSource(config);
    // Use a bbox distinct from the other tests: the HTTP layer caches by URL for
    // the whole file run, so reusing an earlier bbox would serve that cached
    // (non-empty) response instead of the empty one mocked here.
    const out = await src.search({ collectie: "perceel", bbox: "130000,486000,130300,486300", includeGeometry: false, rows: 10 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("geen objecten in deze bbox");
  });
});
