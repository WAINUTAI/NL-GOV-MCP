import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";
import {
  bboxFromCenter,
  resolveGemeenteBbox,
  resolveWoonplaatsCentroids,
  validateRdBbox,
} from "../utils/geo.js";

const WMS_ENDPOINT = "https://service.pdok.nl/kadaster/ruimtelijke-plannen/wms/v1_0";
const VIEWER_BASE = "https://www.ruimtelijkeplannen.nl/viewer/view";
const CONNECTOR = "ruimtelijke_plannen";
// Tight box around the town centre — plan searches want the built-up area, not
// the whole municipality (see bron-ongevallen.ts, which uses 12 km).
const GEMEENTE_HALF_WIDTH_M = 5000;
// A PDOK WMS GetFeatureInfo sample returns the FULL plan geometry (province-scale
// MultiPolygons), so a single response can be tens of MB — well past the global
// 12 MB body cap in http.ts. The connector only reads f.properties (geometry is
// discarded), so raise the per-call cap instead of rejecting the whole sample.
const WMS_MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

export type PlanStatus = "vigerend" | "vervallen" | "ontwerp" | "vastgesteld" | "all";

export interface RuimtelijkePlannenItem {
  id: string;
  title: string;
  planType: string;
  status: string;
  gemeente: string;
  date: string;
  viewerUrl: string;
  raw: Record<string, unknown>;
}

export interface RuimtelijkePlannenSearchArgs {
  query?: string;
  bbox?: string;
  gemeente?: string;
  status: PlanStatus;
  rows: number;
}

interface FeatureProperties {
  identificatie?: string;
  naam?: string;
  typeplan?: string;
  planstatus?: string;
  naamoverheid?: string;
  overheidscode?: string;
  datum?: string;
  dossierstatus?: string;
  historisch?: string;
  [key: string]: unknown;
}

interface WmsFeatureCollection {
  type?: string;
  features?: Array<{ id?: string; properties?: FeatureProperties }>;
}

const STATUS_MAP: Record<Exclude<PlanStatus, "all">, string[]> = {
  vigerend: ["vastgesteld", "geconsolideerd", "onherroepelijk"],
  vervallen: ["vervallen", "ingetrokken"],
  ontwerp: ["ontwerp", "voorontwerp"],
  vastgesteld: ["vastgesteld"],
};

function statusMatches(planstatus: string | undefined, status: PlanStatus): boolean {
  if (status === "all") return true;
  const allowed = STATUS_MAP[status];
  if (!allowed) return true;
  return allowed.includes((planstatus ?? "").toLowerCase());
}

function gemeenteMatches(props: FeatureProperties, gemeente: string | undefined): boolean {
  if (!gemeente) return true;
  const needle = gemeente.toLowerCase();
  return (props.naamoverheid ?? "").toLowerCase().includes(needle);
}

function queryMatches(props: FeatureProperties, query: string | undefined): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  const hay = [props.naam, props.identificatie, props.typeplan].join(" ").toLowerCase();
  return hay.includes(needle);
}

export class RuimtelijkePlannenSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: RuimtelijkePlannenSearchArgs): Promise<{
    items: RuimtelijkePlannenItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    let bbox = args.bbox;
    if (bbox) {
      const v = validateRdBbox(bbox);
      if (!v.ok) {
        return {
          items: [],
          total: 0,
          endpoint: WMS_ENDPOINT,
          params: { bbox },
          access_note: `Ongeldige bbox: ${v.reason}.`,
        };
      }
    }
    let bboxNote: string | undefined;
    let woonplaatsen: Array<[number, number]> = [];
    if (!bbox && args.gemeente) {
      woonplaatsen = await resolveWoonplaatsCentroids(args.gemeente, 12, { connector: CONNECTOR });
      bbox = await resolveGemeenteBbox(args.gemeente, {
        halfWidthMeters: GEMEENTE_HALF_WIDTH_M,
        connector: CONNECTOR,
      });
      if (!bbox && woonplaatsen.length === 0) {
        return {
          items: [],
          total: 0,
          endpoint: WMS_ENDPOINT,
          params: { gemeente: args.gemeente },
          access_note: `Gemeente '${args.gemeente}' niet gevonden via PDOK Locatieserver. Controleer de schrijfwijze of geef een bbox op.`,
        };
      }
      if (!bbox) bboxNote = `Gemeente '${args.gemeente}' niet gevonden als bbox-bron, gebruikt woonplaats-centroïden.`;
    }
    if (!bbox && woonplaatsen.length === 0) {
      return {
        items: [],
        total: 0,
        endpoint: WMS_ENDPOINT,
        params: {},
        access_note: "Geef minimaal een bbox of gemeente op.",
      };
    }
    if (!bbox) bbox = "13000,306800,279000,620000";

    const featureCount = 100;

    type Sample = { params: Record<string, string>; url?: string; features: Array<{ properties?: FeatureProperties }> };
    const callGfi = async (sampleParams: Record<string, string>): Promise<Sample> => {
      try {
        const { data, meta } = await getJson<WmsFeatureCollection>(WMS_ENDPOINT, {
          query: sampleParams,
          connector: CONNECTOR,
          timeoutMs: 20_000,
          maxResponseBytes: WMS_MAX_RESPONSE_BYTES,
        });
        return { params: sampleParams, url: meta.url, features: data.features ?? [] };
      } catch {
        // A single oversized or failing GetFeatureInfo point must not reject the
        // whole Promise.all. Treat it as an empty sample so the surviving points
        // still contribute their plans.
        return { params: sampleParams, url: WMS_ENDPOINT, features: [] };
      }
    };

    let sampleResults: Sample[];
    if (woonplaatsen.length) {
      sampleResults = await Promise.all(
        woonplaatsen.map((center) => {
          const cellBbox = bboxFromCenter(center, 1500);
          return callGfi({
            service: "WMS",
            version: "1.3.0",
            request: "GetFeatureInfo",
            query_layers: "plangebied",
            layers: "plangebied",
            info_format: "application/json",
            crs: "EPSG:28992",
            styles: "",
            bbox: cellBbox,
            width: "256",
            height: "256",
            i: "128",
            j: "128",
            feature_count: String(featureCount),
          });
        }),
      );
    } else {
      const baseParams = {
        service: "WMS",
        version: "1.3.0",
        request: "GetFeatureInfo",
        query_layers: "plangebied",
        layers: "plangebied",
        info_format: "application/json",
        crs: "EPSG:28992",
        styles: "",
        bbox,
        width: "1024",
        height: "1024",
        feature_count: String(featureCount),
      };
      const grid = [170, 512, 853];
      sampleResults = await Promise.all(
        grid.flatMap((j) =>
          grid.map((i) => callGfi({ ...baseParams, i: String(i), j: String(j) })),
        ),
      );
    }

    const seenIds = new Set<string>();
    const mergedFeatures: FeatureProperties[] = [];
    for (const { features } of sampleResults) {
      for (const f of features) {
        const props = f.properties ?? {};
        const key = String(props.identificatie ?? props.dossierid ?? JSON.stringify(props));
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        mergedFeatures.push(props);
      }
    }
    const params: Record<string, string> = woonplaatsen.length
      ? { sampling: "woonplaats", samples: String(woonplaatsen.length), bbox }
      : { sampling: "grid 3x3", samples: "9", bbox };
    const meta = { url: sampleResults[0]?.url ?? WMS_ENDPOINT };

    const filtered = mergedFeatures
      .filter((p) => statusMatches(p.planstatus, args.status))
      .filter((p) => gemeenteMatches(p, args.gemeente))
      .filter((p) => queryMatches(p, args.query));

    const items: RuimtelijkePlannenItem[] = filtered.slice(0, args.rows).map((p) => {
      const id = String(p.identificatie ?? "");
      return {
        id,
        title: String(p.naam ?? id ?? "Ruimtelijk plan"),
        planType: String(p.typeplan ?? ""),
        status: String(p.planstatus ?? ""),
        gemeente: String(p.naamoverheid ?? ""),
        date: String(p.datum ?? ""),
        viewerUrl: id ? `${VIEWER_BASE}?planidn=${encodeURIComponent(id)}` : VIEWER_BASE,
        raw: p as Record<string, unknown>,
      };
    });

    const noResultsNote = items.length
      ? undefined
      : "PDOK WMS bereikbaar, maar geen plannen gevonden voor deze bbox/filters. Probeer een ruimer gebied of een andere status.";

    return {
      items,
      total: filtered.length,
      endpoint: meta.url,
      params,
      access_note: [bboxNote, noResultsNote].filter(Boolean).join(" ") || undefined,
    };
  }
}
