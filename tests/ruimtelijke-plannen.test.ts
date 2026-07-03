import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { RuimtelijkePlannenSource } from "../src/sources/ruimtelijke-plannen.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";

const config = loadConfig();

interface Feature {
  id?: string;
  properties: Record<string, unknown>;
}

function fcResponse(features: Feature[]): Response {
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function locatieserverResponse(centroideRd: string | undefined): Response {
  return new Response(
    JSON.stringify({
      response: {
        docs: centroideRd ? [{ centroide_rd: centroideRd, weergavenaam: "Gemeente Test" }] : [],
        numFound: centroideRd ? 1 : 0,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeFeature(overrides: Partial<Record<string, unknown>>): Feature {
  return {
    id: `plangebied.${overrides.identificatie ?? "x"}`,
    properties: {
      identificatie: "NL.IMRO.0363.E2202BPSTD-OW01",
      naam: "Oud West 2018 3e herziening",
      typeplan: "bestemmingsplan",
      planstatus: "ontwerp",
      naamoverheid: "gemeente Amsterdam",
      overheidscode: "0363",
      datum: "2023-12-20",
      historisch: "0",
      ...overrides,
    },
  };
}

describe("RuimtelijkePlannenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("maps WMS features to items for a gemeente-only search (Groningen)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("locatieserver")) {
        return locatieserverResponse("POINT(233000 582000)");
      }
      return fcResponse([
        makeFeature({ identificatie: "GRON1", naam: "Groningen Plan", naamoverheid: "gemeente Groningen" }),
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ gemeente: "Groningen", status: "all", rows: 3 });

    const wmsCalls = fetchMock.mock.calls.filter((c) =>
      String((c as unknown as Array<unknown>)[0]).includes("ruimtelijke-plannen/wms"),
    );
    expect(wmsCalls.length).toBeGreaterThan(0);
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items[0].title).toBe("Groningen Plan");
    expect(out.items[0].gemeente).toBe("gemeente Groningen");
  });

  it("survives a getJson failure on one sample (per-sample try/catch)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // Valid HTTP 200 but a non-JSON body: getJson throws malformed_response
        // (not retried), exercising callGfi's per-sample try/catch.
        return new Response("<<not json>>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fcResponse([makeFeature({ identificatie: "OK1", naam: "Survivor" })]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "180000,485000,181000,486000", status: "all", rows: 5 });

    // One sample failed, but the remaining grid points still returned their plan.
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items[0].title).toBe("Survivor");
  });

  it("normalizes WMS GetFeatureInfo features into discovery records", async () => {
    const fetchMock = vi.fn(async () => fcResponse([makeFeature({})]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({
      bbox: "119000,486000,121000,488000",
      status: "all",
      rows: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(9);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("kadaster/ruimtelijke-plannen/wms");
    expect(calledUrl).toContain("query_layers=plangebied");
    expect(calledUrl).toContain("bbox=119000%2C486000%2C121000%2C488000");
    const samplePositions = new Set(
      fetchMock.mock.calls.map((c) => {
        const u = new URL(String((c as unknown as Array<unknown>)[0]));
        return `${u.searchParams.get("i")},${u.searchParams.get("j")}`;
      }),
    );
    expect(samplePositions.size).toBe(9);

    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.id).toBe("NL.IMRO.0363.E2202BPSTD-OW01");
    expect(item.title).toBe("Oud West 2018 3e herziening");
    expect(item.planType).toBe("bestemmingsplan");
    expect(item.status).toBe("ontwerp");
    expect(item.gemeente).toBe("gemeente Amsterdam");
    expect(item.viewerUrl).toBe(
      "https://www.ruimtelijkeplannen.nl/viewer/view?planidn=NL.IMRO.0363.E2202BPSTD-OW01",
    );
  });

  it("filters on status=vigerend matches vastgesteld and geconsolideerd, drops ontwerp", async () => {
    const features = [
      makeFeature({ identificatie: "A", planstatus: "vastgesteld", naam: "Plan A" }),
      makeFeature({ identificatie: "B", planstatus: "geconsolideerd", naam: "Plan B" }),
      makeFeature({ identificatie: "C", planstatus: "ontwerp", naam: "Plan C" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse(features)));

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "130000,485000,131000,486000", status: "vigerend", rows: 10 });

    expect(out.items.map((i) => i.title).sort()).toEqual(["Plan A", "Plan B"]);
  });

  it("filters on gemeente substring against naamoverheid", async () => {
    const features = [
      makeFeature({ identificatie: "A", naamoverheid: "gemeente Amsterdam", naam: "Plan A" }),
      makeFeature({ identificatie: "B", naamoverheid: "gemeente Utrecht", naam: "Plan B" }),
      makeFeature({ identificatie: "C", naamoverheid: "Provincie Noord-Holland", naam: "Plan C" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse(features)));

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "140000,485000,141000,486000", gemeente: "Amsterdam", status: "all", rows: 10 });

    expect(out.items.map((i) => i.title)).toEqual(["Plan A"]);
  });

  it("filters on query as substring against naam and typeplan", async () => {
    const features = [
      makeFeature({ identificatie: "A", naam: "Centrum-Oost herziening", typeplan: "bestemmingsplan" }),
      makeFeature({ identificatie: "B", naam: "Buitengebied 2020", typeplan: "structuurvisie" }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse(features)));

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "150000,485000,151000,486000", query: "centrum", status: "all", rows: 10 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("A");
  });

  it("samples each woonplaats centroid (1.5km half-width) via PDOK Locatieserver when only gemeente is given", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("locatieserver")) {
        return locatieserverResponse("POINT(123164.386 486614.002)");
      }
      return fcResponse([makeFeature({})]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    await src.search({ gemeente: "Amsterdam", status: "all", rows: 5 });

    const wmsCalls = fetchMock.mock.calls.filter((c) =>
      String((c as unknown as Array<unknown>)[0]).includes("ruimtelijke-plannen/wms"),
    );
    expect(wmsCalls.length).toBeGreaterThan(0);
    const firstWmsUrl = String((wmsCalls[0] as unknown as Array<unknown>)[0]);
    expect(firstWmsUrl).toContain("bbox=121664.386%2C485114.002%2C124664.386%2C488114.002");
  });

  it("falls back to 3x3 grid when no gemeente is provided (only bbox)", async () => {
    const fetchMock = vi.fn(async () => fcResponse([makeFeature({})]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    await src.search({ bbox: "120000,485000,130000,495000", status: "all", rows: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it("emits a no-results access_note when filters drop everything", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse([
      makeFeature({ identificatie: "A", planstatus: "ontwerp" }),
    ])));

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "160000,485000,161000,486000", status: "vervallen", rows: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("geen plannen gevonden");
  });

  it("rejects malformed bbox without calling WMS", async () => {
    const fetchMock = vi.fn(async () => fcResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "not-a-bbox", status: "all", rows: 5 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Ongeldige bbox");
  });

  it("rejects bbox with min >= max without calling WMS", async () => {
    const fetchMock = vi.fn(async () => fcResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "200000,400000,100000,500000", status: "all", rows: 5 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.access_note).toContain("Ongeldige bbox");
  });

  it("returns clear not-found when gemeente has no woonplaatsen and no bbox", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("locatieserver")) return locatieserverResponse(undefined);
      throw new Error("WMS should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ gemeente: "Xyzdoesnotexist", status: "all", rows: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("niet gevonden");
    const wmsCalls = fetchMock.mock.calls.filter((c) =>
      String((c as unknown as Array<unknown>)[0]).includes("ruimtelijke-plannen/wms"),
    );
    expect(wmsCalls).toHaveLength(0);
  });

  it("respects rows cap", async () => {
    const features = Array.from({ length: 30 }, (_, i) =>
      makeFeature({ identificatie: `P${i}`, naam: `Plan ${i}` }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => fcResponse(features)));

    const src = new RuimtelijkePlannenSource(config);
    const out = await src.search({ bbox: "170000,485000,171000,486000", status: "all", rows: 5 });

    expect(out.items).toHaveLength(5);
    expect(out.total).toBe(30);
  });
});
