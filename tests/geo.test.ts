import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bboxFromCenter,
  parseRdPoint,
  resolveGemeenteBbox,
  resolveGemeenteCentroid,
  resolveWoonplaatsCentroids,
  validateRdBbox,
} from "../src/utils/geo.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse } from "./helpers/config.js";

describe("parseRdPoint", () => {
  it("parses the Locatieserver WKT point", () => {
    expect(parseRdPoint("POINT(123164.386 486614.002)")).toEqual([123164.386, 486614.002]);
    expect(parseRdPoint("POINT (100 200)")).toEqual([100, 200]);
  });

  it("returns undefined for missing or malformed input", () => {
    expect(parseRdPoint(undefined)).toBeUndefined();
    expect(parseRdPoint("")).toBeUndefined();
    expect(parseRdPoint("LINESTRING(1 2, 3 4)")).toBeUndefined();
  });
});

describe("bboxFromCenter", () => {
  it("builds a square box around the centre", () => {
    expect(bboxFromCenter([100000, 400000], 5000)).toBe("95000,395000,105000,405000");
  });
});

describe("validateRdBbox", () => {
  it("accepts a box inside the Dutch RD extent", () => {
    expect(validateRdBbox("190000,442000,195000,445000")).toEqual({ ok: true });
  });

  it("rejects the wrong number of values", () => {
    expect(validateRdBbox("1,2,3")).toMatchObject({ ok: false });
  });

  it("rejects non-numeric values", () => {
    expect(validateRdBbox("a,b,c,d").reason).toContain("non-numeric");
  });

  it("rejects inverted axes", () => {
    expect(validateRdBbox("200000,450000,190000,460000").reason).toContain("less than max");
  });

  it("rejects coordinates outside the Netherlands", () => {
    expect(validateRdBbox("0,0,1,1").reason).toContain("EPSG:28992");
  });
});

describe("Locatieserver resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("resolves a gemeente centroid and attributes the call to the caller's connector", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ response: { docs: [{ centroide_rd: "POINT(121000 487000)", weergavenaam: "Utrecht" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await resolveGemeenteCentroid("Utrecht", { connector: "brp_gewaspercelen" });
    expect(out).toEqual({ center: [121000, 487000], weergavenaam: "Utrecht" });

    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("q")).toBe("gemeente Utrecht");
    expect(url.searchParams.get("fq")).toBe("type:gemeente");
    expect(url.searchParams.get("rows")).toBe("1");
  });

  it("returns undefined when the gemeente is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ response: { docs: [] } })));
    expect(await resolveGemeenteBbox("Nergenshuizen", { halfWidthMeters: 5000 })).toBeUndefined();
  });

  it("turns a gemeente into a bbox with the requested half width", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ response: { docs: [{ centroide_rd: "POINT(100000 400000)" }] } })),
    );
    expect(await resolveGemeenteBbox("Testdorp", { halfWidthMeters: 12000 })).toBe(
      "88000,388000,112000,412000",
    );
  });

  it("collects woonplaats centroids and skips unparseable ones", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        response: {
          docs: [
            { centroide_rd: "POINT(1000 400000)" },
            { centroide_rd: "kapot" },
            { centroide_rd: "POINT(2000 400000)" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const points = await resolveWoonplaatsCentroids("Tilburg", 12);
    expect(points).toEqual([
      [1000, 400000],
      [2000, 400000],
    ]);

    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("fq")).toBe('type:woonplaats AND gemeentenaam:"Tilburg"');
    expect(url.searchParams.get("rows")).toBe("12");
  });
});
