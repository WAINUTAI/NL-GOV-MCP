import { describe, expect, it } from "vitest";
import {
  type Coord,
  type Polygon,
  geometryArea,
  geometryLength,
  inLocalMetres,
  interiorPoint,
  largestPolygon,
  mergeGeometries,
  parseGeoJson,
  parseWkt,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonInteriorPoint,
  polylabel,
  representativePoint,
} from "../src/utils/geometry.js";
import { rdToWgs84, wgs84ToRd } from "../src/utils/rd.js";

/** Distance from a point to the nearest edge of the polygon. */
function edgeDistance([x, y]: Coord, polygon: Polygon): number {
  let min = Infinity;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [ax, ay] = ring[j];
      const [bx, by] = ring[i];
      const dx = bx - ax;
      const dy = by - ay;
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
      min = Math.min(min, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return min;
}

const SQUARE: Polygon = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
/** An L: two 1-wide arms of length 10; the centroid (2.6, 2.6) lies outside. */
const L_SHAPE: Polygon = [[[0, 0], [10, 0], [10, 1], [1, 1], [1, 10], [0, 10], [0, 0]]];
/** A U opening upward: the centroid lies in the gap. */
const U_SHAPE: Polygon = [[[0, 0], [30, 0], [30, 30], [20, 30], [20, 5], [10, 5], [10, 30], [0, 30], [0, 0]]];
/** A square block around a courtyard, as many city panden are. */
const COURTYARD: Polygon = [
  [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]],
  [[8, 8], [32, 8], [32, 32], [8, 32], [8, 8]],
];

describe("parseWkt", () => {
  it("reads points, lines and polygons with their holes, dropping Z", () => {
    expect(parseWkt("POINT Z (1 2 3)")).toEqual({ type: "point", points: [[1, 2]] });
    expect(parseWkt("MULTIPOINT ((1 2), (3 4))")).toEqual({ type: "point", points: [[1, 2], [3, 4]] });
    expect(parseWkt("LINESTRING (0 0, 1 1)")).toEqual({ type: "line", lines: [[[0, 0], [1, 1]]] });
    expect(parseWkt("MULTILINESTRING ((0 0, 1 0), (2 2, 3 3))")).toEqual({ type: "line", lines: [[[0, 0], [1, 0]], [[2, 2], [3, 3]]] });
    const polygon = parseWkt("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))");
    expect(polygon?.type === "polygon" && polygon.polygons[0]).toHaveLength(2);
    const multi = parseWkt("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5), (5.2 5.1, 5.8 5.1, 5.8 5.5, 5.2 5.1)))");
    expect(multi?.type === "polygon" && multi.polygons.map((p) => p.length)).toEqual([1, 2]);
  });

  it("returns undefined for what it cannot read", () => {
    expect(parseWkt(undefined)).toBeUndefined();
    expect(parseWkt("GEOMETRYCOLLECTION EMPTY")).toBeUndefined();
    expect(parseWkt("POLYGON (())")).toBeUndefined();
    expect(parseWkt("POLYGON ((0 0, 1 1")).toBeUndefined();
  });

  it("reads GeoJSON and merges pieces into one geometry", () => {
    expect(parseGeoJson({ type: "MultiPolygon", coordinates: [SQUARE] })).toEqual({ type: "polygon", polygons: [SQUARE] });
    expect(parseGeoJson({ type: "Point", coordinates: [5, 52] })).toEqual({ type: "point", points: [[5, 52]] });
    expect(parseGeoJson({ type: "GeometryCollection" })).toBeUndefined();
    expect(parseGeoJson(null)).toBeUndefined();
    const merged = mergeGeometries([parseWkt("LINESTRING (0 0, 1 0)"), undefined, parseWkt("LINESTRING (5 0, 6 0)")]);
    expect(merged).toEqual({ type: "line", lines: [[[0, 0], [1, 0]], [[5, 0], [6, 0]]] });
  });
});

describe("area and length", () => {
  it("subtracts holes and sums the parts", () => {
    expect(polygonArea(SQUARE)).toBe(100);
    expect(polygonArea(COURTYARD)).toBe(1600 - 576);
    // Orientation does not matter.
    expect(polygonArea([[...SQUARE[0]].reverse()])).toBe(100);
    expect(geometryArea({ type: "polygon", polygons: [SQUARE, COURTYARD] })).toBe(100 + 1024);
    expect(geometryArea({ type: "line", lines: [[[0, 0], [3, 4]]] })).toBe(0);
  });

  it("measures all pieces of a line", () => {
    expect(geometryLength({ type: "line", lines: [[[0, 0], [3, 4]], [[10, 0], [10, 2], [12, 2]]] })).toBe(9);
  });

  it("keeps precision on RD-sized coordinates", () => {
    const rdSquare: Polygon = [SQUARE[0].map(([x, y]) => [x + 134_000.123, y + 454_000.456] as Coord)];
    expect(polygonArea(rdSquare)).toBeCloseTo(100, 9);
    const [cx, cy] = polygonCentroid(rdSquare);
    expect(cx).toBeCloseTo(134_005.123, 6);
    expect(cy).toBeCloseTo(454_005.456, 6);
  });
});

describe("interior points", () => {
  it("uses the centroid of a convex polygon", () => {
    expect(polygonInteriorPoint(SQUARE)).toEqual([5, 5]);
  });

  it("moves an L-shape's point off its outside centroid into an arm", () => {
    const centroid = polygonCentroid(L_SHAPE);
    expect(pointInPolygon(centroid, L_SHAPE)).toBe(false);
    const point = polygonInteriorPoint(L_SHAPE);
    expect(pointInPolygon(point, L_SHAPE)).toBe(true);
    expect(edgeDistance(point, L_SHAPE)).toBeGreaterThan(0.4);
  });

  it("moves a U-shape's point out of the gap", () => {
    expect(pointInPolygon(polygonCentroid(U_SHAPE), U_SHAPE)).toBe(false);
    const point = polygonInteriorPoint(U_SHAPE);
    expect(pointInPolygon(point, U_SHAPE)).toBe(true);
    expect(edgeDistance(point, U_SHAPE)).toBeGreaterThan(4);
  });

  it("moves a point out of the courtyard (the hole) onto the block", () => {
    const centroid = polygonCentroid(COURTYARD);
    expect(centroid[0]).toBeCloseTo(20, 9);
    expect(pointInPolygon(centroid, COURTYARD)).toBe(false);
    const point = polygonInteriorPoint(COURTYARD);
    expect(pointInPolygon(point, COURTYARD)).toBe(true);
    expect(edgeDistance(point, COURTYARD)).toBeGreaterThan(3);
  });

  it("finds a point in a thin diagonal strip (a ditch)", () => {
    const strip: Polygon = [[[0, 0], [1000, 1000], [1001.5, 998.5], [1.5, -1.5], [0, 0]]];
    const point = polygonInteriorPoint(strip);
    expect(pointInPolygon(point, strip)).toBe(true);
  });

  it("finds a point in a strip far thinner than its bbox (0.5 m wide, 356 m long, bent)", () => {
    // Like gmb-2026-310329: 185 m2 in a 356 m by 56 m bbox. A V of two 0.5 m wide arms.
    const strip: Polygon = [[[0, 0], [178, 56], [356, 0], [356, 0.5], [178, 56.5], [0, 0.5], [0, 0]]];
    expect(pointInPolygon(polygonCentroid(strip), strip)).toBe(false);
    expect(pointInPolygon(polygonInteriorPoint(strip), strip)).toBe(true);
    // Also offset to RD-sized coordinates.
    const rd: Polygon = [strip[0].map(([x, y]) => [x + 132183, y + 453689] as Coord)];
    expect(pointInPolygon(polygonInteriorPoint(rd), rd)).toBe(true);
  });

  it("uses the largest part of a multipolygon", () => {
    const small: Polygon = [[[100, 100], [101, 100], [101, 101], [100, 101], [100, 100]]];
    expect(largestPolygon([small, SQUARE])).toBe(SQUARE);
    expect(interiorPoint([small, L_SHAPE, SQUARE])).toEqual([5, 5]);
    expect(interiorPoint([])).toBeUndefined();
  });

  it("polylabel finds the pole of inaccessibility of a square", () => {
    const [x, y] = polylabel(SQUARE, 0.01);
    expect(x).toBeCloseTo(5, 1);
    expect(y).toBeCloseTo(5, 1);
    expect(polylabel([[[1, 1], [1, 1], [1, 1]]])).toEqual([1, 1]);
  });
});

describe("representativePoint", () => {
  it("takes a point as is", () => {
    expect(representativePoint({ type: "point", points: [[3, 4], [5, 6]] })).toEqual([3, 4]);
  });

  it("puts one line at its middle and several pieces on the piece nearest their centre", () => {
    expect(representativePoint({ type: "line", lines: [[[0, 0], [3, 0], [3, 4]]] })).toEqual([3, 0.5]);
    // A short stub far away and a long road: the point lands on the road, not halfway the stub.
    const [x, y] = representativePoint({ type: "line", lines: [[[-500, 0], [-490, 0]], [[0, 0], [0, 1000]]] })!;
    expect(x).toBe(0);
    expect(y).toBeGreaterThan(400);
    expect(y).toBeLessThan(600);
    // Zero-length pieces are skipped.
    expect(representativePoint({ type: "line", lines: [[[7, 7], [7, 7]]] })).toEqual([7, 7]);
  });

  it("puts polygons at their joint centroid when that is inside, else inside the largest part", () => {
    const right: Polygon = [[[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]];
    // Two touching squares: the joint centroid (10, 5) lies on their shared edge, inside the union.
    const [jx] = representativePoint({ type: "polygon", polygons: [SQUARE, right] })!;
    expect(jx).toBeCloseTo(10, 9);
    // Far apart: the joint centroid lies between them; take the larger one.
    const far: Polygon = [[[1000, 0], [1004, 0], [1004, 4], [1000, 4], [1000, 0]]];
    expect(representativePoint({ type: "polygon", polygons: [far, SQUARE] })).toEqual([5, 5]);
  });
});

describe("inLocalMetres", () => {
  it("projects lon/lat to metres and back exactly", () => {
    // A pand-sized L in lon/lat (about 14 m by 22 m).
    const lonLat: Polygon = [L_SHAPE[0].map(([x, y]) => [5.09 + x * 0.00002, 52.08 + y * 0.00002] as Coord)];
    const point = inLocalMetres({ type: "polygon", polygons: [lonLat] }, (g) => (g.type === "polygon" ? interiorPoint(g.polygons) : undefined))!;
    expect(pointInPolygon(point, lonLat)).toBe(true);
    const identity = inLocalMetres({ type: "point", points: [[5.1, 52.1]] }, (g) => (g.type === "point" ? g.points[0] : undefined))!;
    expect(identity[0]).toBeCloseTo(5.1, 12);
    expect(identity[1]).toBeCloseTo(52.1, 12);
  });
});

describe("RD conversion", () => {
  it("matches known points to within a metre", () => {
    // Amersfoort, the origin of RD.
    const origin = rdToWgs84(155000, 463000);
    expect(origin.lat).toBeCloseTo(52.1551744, 7);
    expect(origin.lon).toBeCloseTo(5.38720621, 7);
    // Oude Pijlsweerdstraat 42a, Utrecht: the source's own RD and lat/lon pair.
    const utrecht = rdToWgs84(135981.725, 457114.403);
    expect(Math.abs(utrecht.lat - 52.101948376299) * 111_000).toBeLessThan(1);
    expect(Math.abs(utrecht.lon - 5.10963045531699) * 68_000).toBeLessThan(1);
  });

  it("round-trips to within a few decimetres across the country", () => {
    for (const [x, y] of [[13_000, 380_000], [134_500, 454_200], [190_000, 600_000], [260_000, 560_000], [180_000, 320_000]]) {
      const { lat, lon } = rdToWgs84(x, y);
      const back = wgs84ToRd(lon, lat);
      expect(Math.hypot(back.x - x, back.y - y)).toBeLessThan(0.5);
    }
  });
});
