import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

const WMS_ENDPOINT = "https://service.pdok.nl/kadaster/ruimtelijke-plannen/wms/v1_0";
const LOCATIESERVER_FREE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
const VIEWER_BASE = "https://www.ruimtelijkeplannen.nl/viewer/view";
const CONNECTOR = "ruimtelijke_plannen";

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

interface LocatieserverResponse {
  response?: { docs?: Array<{ centroide_rd?: string; weergavenaam?: string }> };
}

const STATUS_MAP: Record<Exclude<PlanStatus, "all">, string[]> = {
  vigerend: ["vastgesteld", "geconsolideerd", "onherroepelijk"],
  vervallen: ["vervallen", "ingetrokken"],
  ontwerp: ["ontwerp", "voorontwerp"],
  vastgesteld: ["vastgesteld"],
};

function parseRdPoint(centroideRd: string | undefined): [number, number] | undefined {
  if (!centroideRd) return undefined;
  const match = centroideRd.match(/POINT\s*\(\s*([\d.+-]+)\s+([\d.+-]+)\s*\)/i);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

function bboxFromCenter(center: [number, number], halfWidthMeters: number): string {
  const [x, y] = center;
  return `${x - halfWidthMeters},${y - halfWidthMeters},${x + halfWidthMeters},${y + halfWidthMeters}`;
}

async function resolveGemeenteBbox(gemeente: string): Promise<string | undefined> {
  const params = {
    q: `gemeente ${gemeente}`,
    rows: "1",
    fq: "type:gemeente",
    fl: "centroide_rd,weergavenaam",
  };
  const { data } = await getJson<LocatieserverResponse>(LOCATIESERVER_FREE, { query: params });
  const center = parseRdPoint(data.response?.docs?.[0]?.centroide_rd);
  if (!center) return undefined;
  return bboxFromCenter(center, 5000);
}

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
    let bboxNote: string | undefined;
    if (!bbox && args.gemeente) {
      bbox = await resolveGemeenteBbox(args.gemeente);
      if (!bbox) bboxNote = `Gemeente '${args.gemeente}' niet gevonden via PDOK Locatieserver, val terug op nationale bbox.`;
    }
    if (!bbox) bbox = "13000,306800,279000,620000";

    const featureCount = Math.min(Math.max(args.rows * 2, 20), 100);
    const params = {
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
      i: "512",
      j: "512",
      feature_count: String(featureCount),
    };

    const { data, meta } = await getJson<WmsFeatureCollection>(WMS_ENDPOINT, {
      query: params,
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const features = data.features ?? [];
    const filtered = features
      .map((f) => f.properties ?? {})
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
