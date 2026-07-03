import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

// PDOK Kadaster Bestuurlijke Gebieden — OGC API Features (GeoJSON).
// LET OP: host api.pdok.nl matcht in inferConnectorName op "pdok.nl" → "pdok_bag".
// Geef daarom ALTIJD expliciet connector: CONNECTOR mee aan elke getJson-call.
const BASE = "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1";
const CONNECTOR = "bestuurlijke_gebieden";
const RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";

export type BestuurlijkNiveau = "gemeente" | "provincie" | "land";

const COLLECTION_BY_NIVEAU: Record<BestuurlijkNiveau, string> = {
  gemeente: "gemeentegebied",
  provincie: "provinciegebied",
  land: "landgebied",
};

export interface BestuurlijkeGebiedenItem {
  id: string;
  title: string;
  niveau: BestuurlijkNiveau;
  naam: string;
  code: string;
  identificatie: string;
  ligtInProvincieNaam?: string;
  ligtInProvincieCode?: string;
  ligtInLandNaam?: string;
  ligtInLandCode?: string;
  bbox?: [number, number, number, number];
  centroid?: [number, number];
  url: string;
  geometry?: Record<string, unknown>;
}

export interface BestuurlijkeGebiedenSearchArgs {
  niveau: BestuurlijkNiveau;
  naam?: string;
  code?: string;
  bbox?: string;
  includeGeometry: boolean;
  rows: number;
}

interface OgcFeature {
  id?: string;
  geometry?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

interface OgcFeatureCollection {
  features?: OgcFeature[];
  numberReturned?: number;
  numberMatched?: number;
}

// Valideer een RD New (EPSG:28992) bbox; geporteerd uit ruimtelijke-plannen.ts.
function validateRdBbox(bbox: string): { ok: true } | { ok: false; reason: string } {
  const parts = bbox.split(",").map((s) => s.trim());
  if (parts.length !== 4) {
    return { ok: false, reason: "bbox must have 4 comma-separated numbers (minx,miny,maxx,maxy in EPSG:28992)" };
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return { ok: false, reason: "bbox contains non-numeric values" };
  const [minx, miny, maxx, maxy] = nums;
  if (minx >= maxx || miny >= maxy) return { ok: false, reason: "bbox min must be less than max for both axes" };
  if (minx < -10000 || maxx > 310000 || miny < 290000 || maxy > 660000) {
    return { ok: false, reason: "bbox is outside the EPSG:28992 (RD New) extent for the Netherlands" };
  }
  return { ok: true };
}

// Bereken bounding box + centroïde uit een GeoJSON-geometrie (CRS84 lon/lat).
function computeBounds(geometry: Record<string, unknown> | undefined):
  | { bbox: [number, number, number, number]; centroid: [number, number] }
  | undefined {
  if (!geometry) return undefined;
  const coords = geometry.coordinates;
  if (coords === undefined) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      const x = node[0];
      const y = node[1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coords);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return {
    bbox: [minX, minY, maxX, maxY],
    centroid: [(minX + maxX) / 2, (minY + maxY) / 2],
  };
}

function toItem(
  niveau: BestuurlijkNiveau,
  collection: string,
  feature: OgcFeature,
  includeGeometry: boolean,
): BestuurlijkeGebiedenItem {
  const props = feature.properties ?? {};
  const naam = String(props.naam ?? "");
  const code = String(props.code ?? "");
  const identificatie = String(props.identificatie ?? "");
  const featureId = String(feature.id ?? identificatie ?? "");
  const bounds = computeBounds(feature.geometry);
  const item: BestuurlijkeGebiedenItem = {
    id: identificatie || featureId,
    title: naam || identificatie || "Bestuurlijk gebied",
    niveau,
    naam,
    code,
    identificatie,
    url: featureId
      ? `${BASE}/collections/${collection}/items/${encodeURIComponent(featureId)}?f=json`
      : `${BASE}/collections/${collection}/items?f=json`,
  };
  if (props.ligt_in_provincie_naam !== undefined) item.ligtInProvincieNaam = String(props.ligt_in_provincie_naam ?? "");
  if (props.ligt_in_provincie_code !== undefined) item.ligtInProvincieCode = String(props.ligt_in_provincie_code ?? "");
  if (props.ligt_in_land_naam !== undefined) item.ligtInLandNaam = String(props.ligt_in_land_naam ?? "");
  if (props.ligt_in_land_code !== undefined) item.ligtInLandCode = String(props.ligt_in_land_code ?? "");
  if (bounds) {
    item.bbox = bounds.bbox;
    item.centroid = bounds.centroid;
  }
  if (includeGeometry && feature.geometry) item.geometry = feature.geometry;
  return item;
}

export class BestuurlijkeGebiedenSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: BestuurlijkeGebiedenSearchArgs): Promise<{
    items: BestuurlijkeGebiedenItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const niveau = args.niveau;
    const collection = COLLECTION_BY_NIVEAU[niveau];
    const endpointBase = `${BASE}/collections/${collection}/items`;

    const query: Record<string, string> = {
      f: "json",
      limit: String(Math.min(Math.max(args.rows, 1), 1000)),
    };
    if (args.naam) query.naam = args.naam;
    if (args.code) query.code = args.code;

    if (args.bbox) {
      const v = validateRdBbox(args.bbox);
      if (!v.ok) {
        return {
          items: [],
          total: 0,
          endpoint: endpointBase,
          params: { collectie: collection, bbox: args.bbox },
          access_note: `Ongeldige bbox: ${v.reason}.`,
        };
      }
      query.bbox = args.bbox;
      query["bbox-crs"] = RD_CRS;
    }

    const { data, meta } = await getJson<OgcFeatureCollection>(endpointBase, {
      query,
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const features = data.features ?? [];
    const items = features.map((f) => toItem(niveau, collection, f, args.includeGeometry));
    const total = data.numberMatched ?? data.numberReturned ?? items.length;

    const access_note = items.length
      ? undefined
      : `Geen ${niveau}gebieden gevonden. Filter op exacte 'naam' (bv. 'Utrecht'), 'code', of geef een RD-bbox (EPSG:28992). De naam-filter is hoofdlettergevoelig en werkt op exacte match.`;

    return {
      items,
      total,
      endpoint: meta.url,
      params: query,
      access_note,
    };
  }

  // Utility: los een naam op naar de officiële code (bv. 'Utrecht' → '0344' voor een gemeente).
  async resolveCode(niveau: BestuurlijkNiveau, naam: string): Promise<string | undefined> {
    const out = await this.search({ niveau, naam, includeGeometry: false, rows: 1 });
    return out.items[0]?.code || undefined;
  }
}
