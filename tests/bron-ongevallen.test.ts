import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BronOngevallenSource } from "../src/sources/bron-ongevallen.js";

const config = loadConfig();

interface Feature {
  id?: string;
  geometry?: { type?: string; coordinates?: number[] };
  properties: Record<string, unknown>;
}

function fcResponse(features: Feature[], numberMatched?: number): Response {
  return new Response(
    JSON.stringify({
      type: "FeatureCollection",
      features,
      totalFeatures: numberMatched ?? features.length,
      numberMatched: numberMatched ?? features.length,
      numberReturned: features.length,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeFeature(overrides: Partial<Record<string, unknown>>): Feature {
  return {
    id: `ongevallen_2023.${overrides.verkeersongeval_nummer ?? "15"}`,
    geometry: { type: "Point", coordinates: [193338.1182, 443705.0693] },
    properties: {
      verkeersongeval_nummer: 20230000130,
      jaar_ongeval: 2023,
      verkeersongeval_afloop: "Letsel",
      aantal_partijen: 2,
      partij_1_objecttype: "Bestelauto",
      partij_2_objecttype: "Bromfiets",
      aard_ongeval: "Flank",
      maximum_snelheid: 50,
      straatnaam: "Grevelingen",
      woonplaats: "Arnhem",
      gemeente: "Arnhem",
      provincie: "Gelderland",
      ...overrides,
    },
  };
}

describe("BronOngevallenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes WFS GeoJSON features and builds a GetFeature request", async () => {
    const fetchMock = vi.fn(async () => fcResponse([makeFeature({})], 530));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BronOngevallenSource(config);
    const out = await src.search({
      bbox: "190000,442000,195000,445000",
      jaar: "2023",
      afloop: "all",
      rows: 20,
    });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("verkeersongevallen_nederland/ows");
    expect(calledUrl).toContain("typeNames=ongevallen_2023");
    expect(calledUrl).toContain("outputFormat=application%2Fjson");
    expect(calledUrl).toContain("bbox=190000%2C442000%2C195000%2C445000%2CEPSG%3A28992");
    expect(calledUrl).toContain("srsName=EPSG%3A28992");

    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.id).toBe("20230000130");
    expect(item.afloop).toBe("Letsel");
    expect(item.aardOngeval).toBe("Flank");
    expect(item.title).toBe("Flank — Grevelingen, Arnhem");
    expect(item.vervoerswijzen).toEqual(["Bestelauto", "Bromfiets"]);
    expect(item.rd).toEqual([193338.1182, 443705.0693]);
    expect(item.gemeente).toBe("Arnhem");
    expect(item.url).toContain("featureID=ongevallen_2023.15");
    // total reflects numberMatched, not the returned page size.
    expect(out.total).toBe(530);
    expect(out.endpoint).toContain("verkeersongevallen_nederland/ows");
  });

  it("maps jaar to the combined 2022_2024 feature type", async () => {
    const fetchMock = vi.fn(async () => fcResponse([makeFeature({})]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BronOngevallenSource(config);
    await src.search({ bbox: "190000,442000,195000,445000", jaar: "2022_2024", afloop: "all", rows: 5 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("typeNames=ongevallen_2022_2024");
  });

  it("filters on afloop=dodelijk and drops letsel/ums", async () => {
    const features = [
      makeFeature({ verkeersongeval_nummer: "A", verkeersongeval_afloop: "Dodelijk" }),
      makeFeature({ verkeersongeval_nummer: "B", verkeersongeval_afloop: "Letsel" }),
      makeFeature({ verkeersongeval_nummer: "C", verkeersongeval_afloop: "UMS" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse(features)));

    const src = new BronOngevallenSource(config);
    // Unique bbox per WFS test: the HTTP layer caches GET responses by URL
    // (bbox/typeNames/count) and applies afloop/gemeente filters client-side,
    // so reusing one bbox would serve a prior test's cached FeatureCollection.
    const out = await src.search({
      bbox: "200000,442000,205000,445000",
      jaar: "2023",
      afloop: "dodelijk",
      rows: 10,
    });

    expect(out.items.map((i) => i.id)).toEqual(["A"]);
  });

  it("filters on gemeente substring against the gemeente property", async () => {
    const features = [
      makeFeature({ verkeersongeval_nummer: "A", gemeente: "Arnhem" }),
      makeFeature({ verkeersongeval_nummer: "B", gemeente: "Nijmegen" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse(features)));

    const src = new BronOngevallenSource(config);
    // Unique bbox (see note above): avoids reusing another test's cached response.
    const out = await src.search({
      bbox: "210000,442000,215000,445000",
      jaar: "2023",
      afloop: "all",
      gemeente: "arnhem",
      rows: 10,
    });

    expect(out.items.map((i) => i.id)).toEqual(["A"]);
  });

  it("rejects a malformed bbox without calling the WFS", async () => {
    const fetchMock = vi.fn(async () => fcResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BronOngevallenSource(config);
    const out = await src.search({ bbox: "not-a-bbox", jaar: "2023", afloop: "all", rows: 5 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Ongeldige bbox");
  });

  it("requires a bbox and returns a clear access_note when none is given", async () => {
    const fetchMock = vi.fn(async () => fcResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BronOngevallenSource(config);
    const out = await src.search({ jaar: "2023", afloop: "all", rows: 5 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Geef een bbox op");
  });

  it("emits a no-results access_note when filters drop everything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fcResponse([makeFeature({ verkeersongeval_afloop: "Letsel" })])),
    );

    const src = new BronOngevallenSource(config);
    // Unique bbox (see note above): exercises this test's own mock, not a cache hit.
    const out = await src.search({
      bbox: "220000,442000,225000,445000",
      jaar: "2023",
      afloop: "dodelijk",
      rows: 5,
    });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("geen ongevallen gevonden");
  });
});
