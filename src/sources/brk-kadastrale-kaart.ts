import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

// PDOK Kadaster BRK Kadastrale Kaart — OGC API Features (GeoJSON).
// LET OP: host api.pdok.nl matcht in inferConnectorName op "pdok.nl" → "pdok_bag".
// Geef daarom ALTIJD expliciet connector: CONNECTOR mee aan elke getJson-call.
const BASE = "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1";
const CONNECTOR = "brk_kadastrale_kaart";
const RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";
const MAX_FEATURES = 1000;

export type BrkCollection =
  | "perceel"
  | "kadastralegrens"
  | "openbareruimtenaam"
  | "bebouwing"
  | "nummeraanduidingreeks";

export interface BrkKadastraleKaartItem {
  id: string;
  title: string;
  collectie: BrkCollection;
  kadastraleAanduiding?: string;
  kadastraleGemeente?: string;
  sectie?: string;
  perceelnummer?: string;
  kadastraleGrootteM2?: string;
  tekst?: string;
  bronhouder?: string;
  bbox?: [number, number, number, number];
  centroid?: [number, number];
  url: string;
  geometry?: Record<string, unknown>;
}

export interface BrkKadastraleKaartSearchArgs {
  collectie: BrkCollection;
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
  links?: Array<{ rel?: string; href?: string }>;
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

function buildTitle(collectie: BrkCollection, props: Record<string, unknown>, id: string): string {
  if (collectie === "perceel") {
    const gemeente = String(props.kadastrale_gemeente_waarde ?? "").trim();
    const sectie = String(props.sectie ?? "").trim();
    const nummer = String(props.perceelnummer ?? "").trim();
    const aanduiding = [gemeente, sectie, nummer].filter(Boolean).join(" ");
    if (aanduiding) return aanduiding;
  }
  const tekst = String(props.tekst ?? "").trim();
  if (tekst) return tekst;
  const lokaalId = String(props.identificatie_lokaal_id ?? "").trim();
  if (lokaalId) return lokaalId;
  return id || "BRK object";
}

function toItem(
  collectie: BrkCollection,
  feature: OgcFeature,
  includeGeometry: boolean,
): BrkKadastraleKaartItem {
  const props = feature.properties ?? {};
  const featureId = String(feature.id ?? props.identificatie_lokaal_id ?? "");
  const bounds = computeBounds(feature.geometry);
  const item: BrkKadastraleKaartItem = {
    id: featureId,
    title: buildTitle(collectie, props, featureId),
    collectie,
    url: featureId
      ? `${BASE}/collections/${collectie}/items/${encodeURIComponent(featureId)}?f=json`
      : `${BASE}/collections/${collectie}/items?f=json`,
  };

  if (collectie === "perceel") {
    const gemeente = String(props.kadastrale_gemeente_waarde ?? "").trim();
    const sectie = String(props.sectie ?? "").trim();
    const nummer = String(props.perceelnummer ?? "").trim();
    if (gemeente) item.kadastraleGemeente = gemeente;
    if (sectie) item.sectie = sectie;
    if (nummer) item.perceelnummer = nummer;
    const aanduiding = [gemeente, sectie, nummer].filter(Boolean).join(" ");
    if (aanduiding) item.kadastraleAanduiding = aanduiding;
    if (props.kadastrale_grootte_waarde !== undefined) {
      item.kadastraleGrootteM2 = String(props.kadastrale_grootte_waarde ?? "");
    }
  }
  if (props.tekst !== undefined) item.tekst = String(props.tekst ?? "");
  if (props.bronhouder !== undefined) item.bronhouder = String(props.bronhouder ?? "");
  if (bounds) {
    item.bbox = bounds.bbox;
    item.centroid = bounds.centroid;
  }
  if (includeGeometry && feature.geometry) item.geometry = feature.geometry;
  return item;
}

export class BrkKadastraleKaartSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: BrkKadastraleKaartSearchArgs): Promise<{
    items: BrkKadastraleKaartItem[];
    total: number | null;
    hasMore: boolean;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const collectie = args.collectie;
    const endpointBase = `${BASE}/collections/${collectie}/items`;

    if (!args.bbox) {
      return {
        items: [],
        total: 0,
        hasMore: false,
        endpoint: endpointBase,
        params: { collectie },
        access_note:
          "Geef een RD-bbox (EPSG:28992) op als 'minx,miny,maxx,maxy'. De BRK Kadastrale Kaart is bbox-gedreven; hele-land-queries worden niet ondersteund.",
      };
    }

    const v = validateRdBbox(args.bbox);
    if (!v.ok) {
      return {
        items: [],
        total: 0,
        hasMore: false,
        endpoint: endpointBase,
        params: { collectie, bbox: args.bbox },
        access_note: `Ongeldige bbox: ${v.reason}.`,
      };
    }

    const query: Record<string, string> = {
      f: "json",
      limit: String(Math.min(Math.max(args.rows, 1), MAX_FEATURES)),
      bbox: args.bbox,
      "bbox-crs": RD_CRS,
    };

    const { data, meta } = await getJson<OgcFeatureCollection>(endpointBase, {
      query,
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const features = data.features ?? [];
    const items = features.map((f) => toItem(collectie, f, args.includeGeometry));

    // PDOK's BRK OGC service omits `numberMatched` entirely — only
    // `numberReturned` comes back, which is the page size. Falling back to it
    // reported "10 of 10" for a bbox holding thousands, so an absent count is
    // now reported as unknown. The `next` link still says whether more exist.
    const total = typeof data.numberMatched === "number" ? data.numberMatched : null;
    const hasMore = (data.links ?? []).some((link) => link.rel === "next");

    const access_note = items.length
      ? "Bron: PDOK BRK Kadastrale Kaart (dagelijks bijgewerkt). Geen persoonsgegevens; alleen geometrie en kadastrale aanduiding."
      : "PDOK BRK bereikbaar, maar geen objecten in deze bbox. Vergroot het gebied of controleer de RD-coördinaten (EPSG:28992).";

    return {
      items,
      total,
      hasMore,
      endpoint: meta.url,
      params: query,
      access_note,
    };
  }
}
