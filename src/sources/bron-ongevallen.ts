import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";
import { resolveGemeenteBbox, validateRdBbox } from "../utils/geo.js";

const OWS_ENDPOINT =
  "https://geo.rijkswaterstaat.nl/services/ogc/gdr/verkeersongevallen_nederland/ows";
const CONNECTOR = "bron_ongevallen";
// A municipality can be large, so use a 12 km half-width (ruimtelijke-plannen uses
// 5 km for a tighter plan search; accidents need the whole gemeente).
const GEMEENTE_HALF_WIDTH_M = 12000;

// Beschikbare feature types (WFS 2.0.0) — jaartabellen + gecombineerd + wegvakgeografie.
const FEATURE_TYPES: Record<string, string> = {
  "2022": "ongevallen_2022",
  "2023": "ongevallen_2023",
  "2024": "ongevallen_2024",
  "2022_2024": "ongevallen_2022_2024",
};

export type OngevalJaar = keyof typeof FEATURE_TYPES;
export type OngevalAfloop = "letsel" | "dodelijk" | "ums" | "all";

export interface BronOngevalItem {
  id: string;
  title: string;
  jaar: number | string;
  afloop: string;
  aardOngeval: string;
  aantalPartijen: number | string;
  vervoerswijzen: string[];
  straatnaam: string;
  woonplaats: string;
  gemeente: string;
  provincie: string;
  maximumSnelheid: number | string;
  rd: [number, number] | null;
  url: string;
}

export interface BronOngevallenSearchArgs {
  bbox?: string;
  jaar: OngevalJaar;
  afloop: OngevalAfloop;
  gemeente?: string;
  query?: string;
  rows: number;
}

interface OngevalProperties {
  verkeersongeval_nummer?: unknown;
  jaar_ongeval?: unknown;
  verkeersongeval_afloop?: unknown;
  aard_ongeval?: unknown;
  aantal_partijen?: unknown;
  straatnaam?: unknown;
  woonplaats?: unknown;
  gemeente?: unknown;
  provincie?: unknown;
  maximum_snelheid?: unknown;
  [key: string]: unknown;
}

interface OngevalFeature {
  id?: string;
  geometry?: { type?: string; coordinates?: unknown };
  properties?: OngevalProperties;
}

interface FeatureCollection {
  type?: string;
  features?: OngevalFeature[];
  totalFeatures?: unknown;
  numberMatched?: unknown;
  numberReturned?: unknown;
}

function toRdPoint(coordinates: unknown): [number, number] | null {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const x = Number(coordinates[0]);
  const y = Number(coordinates[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

// Verzamel alle "partij_N_objecttype" waarden (betrokken vervoerswijzen), niet-leeg.
function collectVervoerswijzen(props: OngevalProperties): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (!/^partij_\d+_objecttype$/.test(key)) continue;
    const v = String(value ?? "").trim();
    if (v) result.push(v);
  }
  return result;
}

function afloopMatches(afloop: string, filter: OngevalAfloop): boolean {
  if (filter === "all") return true;
  const hay = afloop.toLowerCase();
  if (filter === "letsel") return hay.includes("letsel");
  if (filter === "dodelijk") return hay.includes("dodelijk") || hay.includes("dodel");
  if (filter === "ums") return hay.includes("ums") || hay.includes("uitsluitend materi");
  return true;
}

function substringMatches(haystack: string, needle: string | undefined): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export class BronOngevallenSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: BronOngevallenSearchArgs): Promise<{
    items: BronOngevalItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const typeName = FEATURE_TYPES[args.jaar] ?? FEATURE_TYPES["2024"];

    let bbox = args.bbox;
    let resolvedFromGemeente = false;
    if (!bbox && args.gemeente) {
      // validateRdBbox runs downstream, so return the raw bbox and let existing
      // validation clamp/reject if the resolved box falls outside the extent.
      bbox = await resolveGemeenteBbox(args.gemeente, {
        halfWidthMeters: GEMEENTE_HALF_WIDTH_M,
        connector: CONNECTOR,
      });
      resolvedFromGemeente = !!bbox;
    }

    if (!bbox) {
      return {
        items: [],
        total: 0,
        endpoint: OWS_ENDPOINT,
        params: { typeNames: typeName },
        access_note:
          "Geef een bbox op in EPSG:28992 (RD New): minx,miny,maxx,maxy. Zoeken in de volledige dataset is niet toegestaan.",
      };
    }

    const v = validateRdBbox(bbox);
    if (!v.ok) {
      return {
        items: [],
        total: 0,
        endpoint: OWS_ENDPOINT,
        params: { typeNames: typeName, bbox },
        access_note: `Ongeldige bbox: ${v.reason}.`,
      };
    }

    // Vraag ruimer op dan rows zodat client-side filters (afloop/gemeente/query) genoeg overhouden.
    const fetchCount = Math.min(this.config.limits.maxRows, Math.max(args.rows, 50));
    const params: Record<string, string> = {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: typeName,
      outputFormat: "application/json",
      srsName: "EPSG:28992",
      count: String(fetchCount),
      bbox: `${bbox},EPSG:28992`,
    };

    const { data, meta } = await getJson<FeatureCollection>(OWS_ENDPOINT, {
      query: params,
      connector: CONNECTOR,
      timeoutMs: 25_000,
    });

    const features = data.features ?? [];
    const filtered = features.filter((f) => {
      const props = f.properties ?? {};
      const afloop = String(props.verkeersongeval_afloop ?? "");
      const gemeente = String(props.gemeente ?? "");
      const locatie = [props.straatnaam, props.woonplaats, props.gemeente]
        .map((x) => String(x ?? ""))
        .join(" ");
      return (
        afloopMatches(afloop, args.afloop) &&
        substringMatches(gemeente, args.gemeente) &&
        substringMatches(locatie, args.query)
      );
    });

    const items: BronOngevalItem[] = filtered.slice(0, args.rows).map((f) => {
      const props = f.properties ?? {};
      const id = String(props.verkeersongeval_nummer ?? f.id ?? "");
      const straatnaam = String(props.straatnaam ?? "");
      const woonplaats = String(props.woonplaats ?? "");
      const aardOngeval = String(props.aard_ongeval ?? "");
      const afloop = String(props.verkeersongeval_afloop ?? "");
      const locatieLabel = [straatnaam, woonplaats].filter(Boolean).join(", ");
      const title =
        [aardOngeval, locatieLabel].filter(Boolean).join(" — ") ||
        `Verkeersongeval ${id}`;
      const jaarRaw = props.jaar_ongeval;
      const aantalRaw = props.aantal_partijen;
      const snelheidRaw = props.maximum_snelheid;
      const featureId = f.id ?? `${typeName}.${id}`;
      const url = `${OWS_ENDPOINT}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(
        typeName,
      )}&featureID=${encodeURIComponent(featureId)}&outputFormat=application/json`;
      return {
        id,
        title,
        jaar: typeof jaarRaw === "number" ? jaarRaw : String(jaarRaw ?? ""),
        afloop,
        aardOngeval,
        aantalPartijen: typeof aantalRaw === "number" ? aantalRaw : String(aantalRaw ?? ""),
        vervoerswijzen: collectVervoerswijzen(props),
        straatnaam,
        woonplaats,
        gemeente: String(props.gemeente ?? ""),
        provincie: String(props.provincie ?? ""),
        maximumSnelheid: typeof snelheidRaw === "number" ? snelheidRaw : String(snelheidRaw ?? ""),
        rd: toRdPoint(f.geometry?.coordinates),
        url,
      };
    });

    // numberMatched telt de volledige bbox-match; kan groter zijn dan de opgehaalde count.
    const matched = Number(data.numberMatched ?? data.totalFeatures);
    const total = Number.isFinite(matched) ? matched : filtered.length;

    const noResultsNote = items.length
      ? undefined
      : "Rijkswaterstaat WFS bereikbaar, maar geen ongevallen gevonden voor deze bbox/filters. Probeer een ruimer gebied, een ander jaar of afloop=all.";
    const gemeenteNote = resolvedFromGemeente
      ? `Gemeente '${args.gemeente}' omgezet naar bbox via PDOK Locatieserver (±${GEMEENTE_HALF_WIDTH_M / 1000} km).`
      : undefined;
    const access_note = [gemeenteNote, noResultsNote].filter(Boolean).join(" ") || undefined;

    return {
      items,
      total,
      endpoint: meta.url,
      params,
      access_note,
    };
  }
}
