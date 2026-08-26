import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";
import { resolveGemeenteBbox, validateRdBbox } from "../utils/geo.js";

/**
 * BRP Gewaspercelen (RVO) — the agricultural parcel registry.
 *
 * Every farmer's annual "Gecombineerde opgave" produces a polygon per parcel with
 * the crop grown on it. It is the ground truth under the nitrogen, water-quality
 * and land-use debates, and it joins straight onto BRK parcels, BAG buildings and
 * bestuurlijke gebieden that this server already serves.
 *
 * Keyless PDOK WFS. Note the host: `service.pdok.nl` (the `api.pdok.nl` OGC API
 * Features path used by the other PDOK connectors does not exist for this set).
 * The service is MapServer-backed and ignores `cql_filter`, so bbox is the only
 * server-side selector and crop/category/year filtering happens client-side.
 */
const WFS_ENDPOINT = "https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0";
const TYPE_NAME = "brpgewaspercelen:BrpGewas";
const CONNECTOR = "brp_gewaspercelen";
/** Farmland stretches well past a town centre, so use the wide (gemeente-sized) box. */
const GEMEENTE_HALF_WIDTH_M = 8000;

export type GewasCategorie =
  | "bouwland"
  | "grasland"
  | "natuurterrein"
  | "landschapselement"
  | "braakland"
  | "all";

const CATEGORIE_LABEL: Record<Exclude<GewasCategorie, "all">, string> = {
  bouwland: "Bouwland",
  grasland: "Grasland",
  natuurterrein: "Natuurterrein",
  landschapselement: "Landschapselement",
  braakland: "Braakland",
};

export interface GewasperceelItem {
  id: string;
  title: string;
  gewas: string;
  gewascode: string;
  categorie: string;
  jaar: string;
  status: string;
  oppervlakteM2: number | null;
  oppervlakteHa: number | null;
  centroid: [number, number] | null;
  bbox: [number, number, number, number] | null;
  geometry?: Record<string, unknown>;
  url: string;
}

export interface BrpGewasperceelSearchArgs {
  bbox?: string;
  gemeente?: string;
  gewas?: string;
  categorie: GewasCategorie;
  jaar?: number;
  includeGeometry: boolean;
  rows: number;
}

interface GewasProperties {
  gewas?: unknown;
  gewascode?: unknown;
  category?: unknown;
  jaar?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface GewasFeature {
  id?: string;
  properties?: GewasProperties;
  geometry?: { type?: string; coordinates?: unknown };
}

interface FeatureCollection {
  features?: GewasFeature[];
}

/** Walk a (Multi)Polygon ring structure and reduce it to a bbox. */
function bboxOfCoordinates(coordinates: unknown): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      const x = node[0] as number;
      const y = node[1] as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const child of node) visit(child);
  };

  visit(coordinates);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [minX, minY, maxX, maxY];
}

/** Shoelace area over the outer rings; inner rings (holes) are subtracted. */
function polygonAreaM2(geometry: GewasFeature["geometry"]): number | null {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;

  const ringArea = (ring: unknown): number => {
    if (!Array.isArray(ring) || ring.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (!Array.isArray(a) || !Array.isArray(b)) return 0;
      sum += Number(a[0]) * Number(b[1]) - Number(b[0]) * Number(a[1]);
    }
    return Math.abs(sum) / 2;
  };

  const polygonArea = (polygon: unknown): number => {
    if (!Array.isArray(polygon) || polygon.length === 0) return 0;
    const [outer, ...holes] = polygon;
    return Math.max(0, ringArea(outer) - holes.reduce((acc, hole) => acc + ringArea(hole), 0));
  };

  if (geometry.type === "Polygon") return polygonArea(geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as unknown[]).reduce<number>(
      (acc, polygon) => acc + polygonArea(polygon),
      0,
    );
  }
  return null;
}

function centroidOfBbox(bbox: [number, number, number, number] | null): [number, number] | null {
  if (!bbox) return null;
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function matchesText(haystack: string, needle: string | undefined): boolean {
  if (!needle?.trim()) return true;
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

export class BrpGewasperceelSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * The GeoJSON output of this MapServer WFS omits numberMatched, so the total is
   * fetched separately with resultType=hits (a small XML response).
   */
  private async countMatches(bbox: string): Promise<number | undefined> {
    try {
      const { data } = await getText(WFS_ENDPOINT, {
        query: {
          service: "WFS",
          version: "2.0.0",
          request: "GetFeature",
          typeNames: TYPE_NAME,
          srsName: "EPSG:28992",
          resultType: "hits",
          bbox: `${bbox},EPSG:28992`,
        },
        connector: CONNECTOR,
        timeoutMs: 20_000,
      });
      const match = data.match(/numberMatched="(\d+)"/);
      return match ? Number(match[1]) : undefined;
    } catch {
      // A missing total must not fail the search itself.
      return undefined;
    }
  }

  async search(args: BrpGewasperceelSearchArgs): Promise<{
    items: GewasperceelItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    let bbox = args.bbox?.trim();
    let resolvedFromGemeente = false;

    if (!bbox && args.gemeente?.trim()) {
      bbox = await resolveGemeenteBbox(args.gemeente.trim(), {
        halfWidthMeters: GEMEENTE_HALF_WIDTH_M,
        connector: CONNECTOR,
      });
      resolvedFromGemeente = Boolean(bbox);
      if (!bbox) {
        return {
          items: [],
          total: 0,
          endpoint: WFS_ENDPOINT,
          params: { typeNames: TYPE_NAME, gemeente: args.gemeente },
          access_note: `Gemeente '${args.gemeente}' niet gevonden via PDOK Locatieserver. Controleer de schrijfwijze of geef een bbox op.`,
        };
      }
    }

    if (!bbox) {
      return {
        items: [],
        total: 0,
        endpoint: WFS_ENDPOINT,
        params: { typeNames: TYPE_NAME },
        access_note:
          "Geef een gemeente of een bbox in EPSG:28992 (RD New) op: minx,miny,maxx,maxy. De volledige landelijke set opvragen is niet toegestaan.",
      };
    }

    const validation = validateRdBbox(bbox);
    if (!validation.ok) {
      return {
        items: [],
        total: 0,
        endpoint: WFS_ENDPOINT,
        params: { typeNames: TYPE_NAME, bbox },
        access_note: `Ongeldige bbox: ${validation.reason}.`,
      };
    }

    // Fetch wider than rows so the client-side crop/category/year filters still
    // have material to work with (the WFS itself only filters on bbox).
    // Capped at 500: every feature carries its polygon, so a wider fetch costs
    // real latency and bytes for filters that only ever narrow the set.
    const fetchCount = Math.min(500, Math.max(args.rows * 5, 100));

    const params: Record<string, string> = {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: TYPE_NAME,
      outputFormat: "application/json",
      srsName: "EPSG:28992",
      count: String(fetchCount),
      bbox: `${bbox},EPSG:28992`,
    };

    const [{ data, meta }, matched] = await Promise.all([
      getJson<FeatureCollection>(WFS_ENDPOINT, {
        query: params,
        connector: CONNECTOR,
        timeoutMs: 30_000,
      }),
      this.countMatches(bbox),
    ]);

    const categorieLabel =
      args.categorie === "all" ? undefined : CATEGORIE_LABEL[args.categorie];

    const features = data.features ?? [];
    const filtered = features.filter((feature) => {
      const props = feature.properties ?? {};
      const categorie = String(props.category ?? "");
      const gewas = String(props.gewas ?? "");
      const jaar = Number(props.jaar);

      if (categorieLabel && categorie.toLowerCase() !== categorieLabel.toLowerCase()) return false;
      if (args.jaar && Number.isFinite(jaar) && jaar !== args.jaar) return false;
      return matchesText(`${gewas} ${categorie}`, args.gewas);
    });

    const items: GewasperceelItem[] = filtered.slice(0, args.rows).map((feature) => {
      const props = feature.properties ?? {};
      const gewas = String(props.gewas ?? "");
      const categorie = String(props.category ?? "");
      const jaar = String(props.jaar ?? "");
      const featureBbox = bboxOfCoordinates(feature.geometry?.coordinates);
      const areaM2 = polygonAreaM2(feature.geometry);
      const id = String(feature.id ?? "");

      return {
        id,
        title: [gewas || categorie || "Gewasperceel", jaar].filter(Boolean).join(" — "),
        gewas,
        gewascode: String(props.gewascode ?? ""),
        categorie,
        jaar,
        status: String(props.status ?? ""),
        oppervlakteM2: areaM2 === null ? null : Math.round(areaM2),
        oppervlakteHa: areaM2 === null ? null : Number((areaM2 / 10_000).toFixed(2)),
        centroid: centroidOfBbox(featureBbox),
        bbox: featureBbox,
        ...(args.includeGeometry && feature.geometry
          ? { geometry: feature.geometry as Record<string, unknown> }
          : {}),
        url: id
          ? `${WFS_ENDPOINT}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(
              TYPE_NAME,
            )}&featureID=${encodeURIComponent(id)}&outputFormat=application/json`
          : WFS_ENDPOINT,
      };
    });

    const notes: string[] = [];
    if (resolvedFromGemeente) {
      notes.push(
        `Gemeente '${args.gemeente}' omgezet naar bbox via PDOK Locatieserver (±${GEMEENTE_HALF_WIDTH_M / 1000} km).`,
      );
    }
    if (!items.length) {
      notes.push(
        "PDOK bereikbaar, maar geen gewaspercelen voor deze bbox/filters. Percelen liggen buiten de bebouwde kom: probeer een landelijker gebied, een ruimere bbox of categorie=all.",
      );
    } else if (filtered.length > items.length) {
      notes.push(`${filtered.length} percelen voldeden aan de filters; de eerste ${items.length} worden getoond.`);
    }
    notes.push("Filters op gewas/categorie/jaar zijn client-side: de bbox bepaalt wat er wordt opgehaald.");

    return {
      items,
      total: matched ?? filtered.length,
      endpoint: meta.url,
      params,
      access_note: notes.join(" "),
    };
  }
}
