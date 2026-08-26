import { getJson } from "./http.js";

/**
 * Shared geo primitive for every connector that is bbox-driven.
 *
 * Dutch geo services are overwhelmingly RD New (EPSG:28992) and bbox-scoped,
 * while users ask questions in place names ("in Tilburg"). Before this module
 * each connector re-implemented the same name -> centroid -> bbox dance against
 * the PDOK Locatieserver with its own regex, its own extent check and its own
 * half-width. One implementation keeps the semantics (and the failure notes)
 * identical across connectors.
 */

/** Keyless PDOK Locatieserver (BZK) free-text search. */
export const LOCATIESERVER_FREE =
  "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

/** RD New (EPSG:28992) usable extent for the Netherlands, incl. a small margin. */
export const RD_EXTENT = { minX: -10000, maxX: 310000, minY: 290000, maxY: 660000 } as const;

export type RdPoint = [number, number];

export interface BboxValidation {
  ok: boolean;
  reason?: string;
}

interface LocatieserverDoc {
  centroide_rd?: string;
  weergavenaam?: string;
  gemeentenaam?: string;
  gemeentecode?: string;
  type?: string;
}

interface LocatieserverResponse {
  response?: { docs?: LocatieserverDoc[] };
}

/** Parse the Locatieserver `centroide_rd` WKT ("POINT(123456.7 456789.0)"). */
export function parseRdPoint(centroideRd: string | undefined): RdPoint | undefined {
  if (!centroideRd) return undefined;
  const match = centroideRd.match(/POINT\s*\(\s*([\d.+-]+)\s+([\d.+-]+)\s*\)/i);
  if (!match) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return [x, y];
}

/** Square bbox around an RD centroid, as the "minx,miny,maxx,maxy" string every WFS/WMS wants. */
export function bboxFromCenter(center: RdPoint, halfWidthMeters: number): string {
  const [x, y] = center;
  return `${x - halfWidthMeters},${y - halfWidthMeters},${x + halfWidthMeters},${y + halfWidthMeters}`;
}

/** Reject malformed or out-of-country bboxes before they reach an upstream service. */
export function validateRdBbox(bbox: string): BboxValidation {
  const parts = bbox.split(",").map((s) => s.trim());
  if (parts.length !== 4) {
    return {
      ok: false,
      reason: "bbox must have 4 comma-separated numbers (minx,miny,maxx,maxy in EPSG:28992)",
    };
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) {
    return { ok: false, reason: "bbox contains non-numeric values" };
  }
  const [minx, miny, maxx, maxy] = nums;
  if (minx >= maxx || miny >= maxy) {
    return { ok: false, reason: "bbox min must be less than max for both axes" };
  }
  if (
    minx < RD_EXTENT.minX ||
    maxx > RD_EXTENT.maxX ||
    miny < RD_EXTENT.minY ||
    maxy > RD_EXTENT.maxY
  ) {
    return { ok: false, reason: "bbox is outside the EPSG:28992 (RD New) extent for the Netherlands" };
  }
  return { ok: true };
}

/** Resolve a municipality name to its RD centroid via the Locatieserver. */
export async function resolveGemeenteCentroid(
  gemeente: string,
  options: { connector?: string } = {},
): Promise<{ center: RdPoint; weergavenaam?: string } | undefined> {
  const { data } = await getJson<LocatieserverResponse>(LOCATIESERVER_FREE, {
    query: {
      q: `gemeente ${gemeente}`,
      rows: "1",
      fq: "type:gemeente",
      fl: "centroide_rd,weergavenaam",
    },
    ...(options.connector ? { connector: options.connector } : {}),
  });

  const doc = data.response?.docs?.[0];
  const center = parseRdPoint(doc?.centroide_rd);
  if (!center) return undefined;
  return { center, weergavenaam: doc?.weergavenaam };
}

/**
 * Resolve a municipality name straight to a bbox.
 *
 * `halfWidthMeters` is the caller's call: a plan search wants a tight box around
 * the town centre, an accident search wants the whole municipality.
 */
export async function resolveGemeenteBbox(
  gemeente: string,
  options: { halfWidthMeters: number; connector?: string },
): Promise<string | undefined> {
  const resolved = await resolveGemeenteCentroid(gemeente, { connector: options.connector });
  if (!resolved) return undefined;
  return bboxFromCenter(resolved.center, options.halfWidthMeters);
}

/** Resolve the populated places (woonplaatsen) inside a municipality to RD centroids. */
export async function resolveWoonplaatsCentroids(
  gemeente: string,
  max: number,
  options: { connector?: string } = {},
): Promise<RdPoint[]> {
  const { data } = await getJson<LocatieserverResponse>(LOCATIESERVER_FREE, {
    query: {
      q: gemeente,
      rows: String(max),
      fq: `type:woonplaats AND gemeentenaam:${JSON.stringify(gemeente)}`,
      fl: "centroide_rd,weergavenaam,gemeentenaam",
    },
    ...(options.connector ? { connector: options.connector } : {}),
  });

  const docs = data.response?.docs ?? [];
  const points: RdPoint[] = [];
  for (const doc of docs) {
    const point = parseRdPoint(doc.centroide_rd);
    if (point) points.push(point);
  }
  return points;
}
