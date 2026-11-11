import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrpGewasperceelSource, gewasperceelUrl, interiorPointRd } from "../src/sources/brp-gewaspercelen.js";
import { rdToWgs84 } from "../src/utils/rd.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig, xmlResponse } from "./helpers/config.js";

/** 100 m x 100 m square = 10.000 m2 = 1 ha. */
function square(x: number, y: number, size = 100) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [x, y],
        [x + size, y],
        [x + size, y + size],
        [x, y + size],
        [x, y],
      ],
    ],
  };
}

function feature(id: string, props: Record<string, unknown>, x = 165000, y = 505000) {
  return { id, properties: props, geometry: square(x, y) };
}

const features = [
  feature("brp_gewas.1", { gewas: "Mais, snij-", gewascode: 259, category: "Bouwland", jaar: 2025, status: "Definitief" }),
  feature("brp_gewas.2", { gewas: "Grasland, blijvend", gewascode: 265, category: "Grasland", jaar: 2025, status: "Definitief" }, 166000),
  feature("brp_gewas.3", { gewas: "Aardappelen, consumptie-", gewascode: 2014, category: "Bouwland", jaar: 2024, status: "Definitief" }, 167000),
];

function stubPdok(options: { locatieserver?: boolean } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("locatieserver")) {
      return jsonResponse({
        response: { docs: options.locatieserver === false ? [] : [{ centroide_rd: "POINT(166000 506000)", weergavenaam: "Dronten" }] },
      });
    }
    if (url.includes("resultType=hits")) {
      return xmlResponse('<wfs:FeatureCollection numberMatched="266" numberReturned="0" />');
    }
    return jsonResponse({ type: "FeatureCollection", features });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function urls(fetchMock: ReturnType<typeof stubPdok>): string[] {
  return fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]);
}

describe("BRP parcel point and link", () => {
  it("puts interiorPoint inside a bent strip whose bbox midpoint lies outside", () => {
    // A 10 m wide strip bending round a corner (an L of 300 m arms), as ditch-side parcels are.
    const ring = [[0, 0], [300, 0], [300, 10], [10, 10], [10, 300], [0, 300], [0, 0]].map(([x, y]) => [140000 + x, 440000 + y]);
    const point = interiorPointRd({ type: "Polygon", coordinates: [ring] })!;
    const inArm = (point.rd_x - 140000 < 10 && point.rd_y - 440000 < 300) || (point.rd_y - 440000 < 10 && point.rd_x - 140000 < 300);
    expect(inArm).toBe(true);
    expect(point.rd_x).toBeGreaterThan(140000);
    expect(point.rd_y).toBeGreaterThan(440000);
    expect(interiorPointRd({ type: "Point", coordinates: [1, 2] })).toBeUndefined();
  });

  it("links one parcel by resourceId with the type-name prefix", () => {
    expect(gewasperceelUrl("brp_gewas.1843e914-a644-4c4f-ac4a-1a73f11ace80")).toBe(
      "https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0?service=WFS&version=2.0.0&request=GetFeature&typeNames=brpgewaspercelen%3ABrpGewas&resourceId=BrpGewas.1843e914-a644-4c4f-ac4a-1a73f11ace80&outputFormat=application/json",
    );
    expect(gewasperceelUrl("abc")).toContain("resourceId=BrpGewas.abc");
    expect(gewasperceelUrl("")).toBe("https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0");
  });
});

describe("BrpGewasperceelSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("resolves a gemeente to a bbox and maps parcels with computed area", async () => {
    const fetchMock = stubPdok();
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({
      gemeente: "Dronten",
      categorie: "all",
      includeGeometry: false,
      rows: 10,
    });

    const called = urls(fetchMock);
    expect(called.some((u) => u.includes("locatieserver"))).toBe(true);
    const wfsCall = called.find((u) => u.includes("outputFormat=application"))!;
    expect(wfsCall).toContain("service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0");
    expect(wfsCall).toContain("typeNames=brpgewaspercelen%3ABrpGewas");
    // 8 km half-width around POINT(166000 506000)
    expect(decodeURIComponent(wfsCall)).toContain("bbox=158000,498000,174000,514000,EPSG:28992");

    expect(out.items).toHaveLength(3);
    expect(out.items[0]).toMatchObject({
      gewas: "Mais, snij-",
      categorie: "Bouwland",
      jaar: "2025",
      oppervlakteM2: 10000,
      oppervlakteHa: 1,
    });
    expect(out.items[0].centroid).toEqual([165050, 505050]);
    // New next to centroid: a point inside the parcel, in RD and WGS84.
    expect(out.items[0].interiorPoint).toMatchObject({ rd_x: 165050, rd_y: 505050 });
    const wgs = rdToWgs84(165050, 505050);
    expect(out.items[0].interiorPoint?.lat).toBeCloseTo(wgs.lat, 7);
    expect(out.items[0].interiorPoint?.lon).toBeCloseTo(wgs.lon, 7);
    // The link names the feature as MapServer wants it (BrpGewas.<id>), not as the GeoJSON id (brp_gewas.<id>).
    expect(out.items[0].url).toContain("resourceId=BrpGewas.1");
    expect(out.items[0].url).not.toContain("brp_gewas.");
    expect(out.items[0].geometry).toBeUndefined();
    // total comes from the separate resultType=hits request
    expect(out.total).toBe(266);
    expect(out.access_note).toContain("PDOK Locatieserver");
  });

  it("filters on category and year client-side", async () => {
    stubPdok();
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({
      gemeente: "Dronten",
      categorie: "bouwland",
      jaar: 2025,
      includeGeometry: false,
      rows: 10,
    });

    expect(out.items.map((i) => i.gewas)).toEqual(["Mais, snij-"]);
  });

  it("filters on crop name substring", async () => {
    stubPdok();
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({
      gemeente: "Dronten",
      gewas: "aardappel",
      categorie: "all",
      includeGeometry: false,
      rows: 10,
    });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].gewas).toContain("Aardappelen");
  });

  it("includes geometry only when asked", async () => {
    stubPdok();
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({
      gemeente: "Dronten",
      categorie: "all",
      includeGeometry: true,
      rows: 1,
    });

    expect(out.items[0].geometry).toMatchObject({ type: "Polygon" });
  });

  it("rejects a bbox outside the Dutch RD extent without calling the WFS", async () => {
    const fetchMock = stubPdok();
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({
      bbox: "0,0,1,1",
      categorie: "all",
      includeGeometry: false,
      rows: 10,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Ongeldige bbox");
  });

  it("asks for a location when neither gemeente nor bbox is given", async () => {
    const fetchMock = stubPdok();
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({ categorie: "all", includeGeometry: false, rows: 10 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.access_note).toContain("Geef een gemeente of een bbox");
  });

  it("explains an unresolvable gemeente", async () => {
    stubPdok({ locatieserver: false });
    const source = new BrpGewasperceelSource(testConfig);
    const out = await source.search({
      gemeente: "Nergenshuizen",
      categorie: "all",
      includeGeometry: false,
      rows: 10,
    });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("niet gevonden via PDOK Locatieserver");
  });
});
