import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

/**
 * NED.nl — Nationaal Energie Dashboard REST API.
 *
 * Base: https://api.ned.nl/v1 (vervangt het verouderde api.netanders.io).
 * Auth: verplichte HTTP-header `X-AUTH-TOKEN: <api-key>` (persoonlijke sleutel
 * uit je NED-account). Respons is Hydra / JSON-LD (API Platform): records in
 * `hydra:member`, totaal in `hydra:totalItems`, paginatie via `hydra:view`.
 *
 * Hoofdendpoint /v1/utilizations levert opwek/verbruik per energiebron en
 * periode (capaciteit, volume, benuttingsgraad, CO2-emissie), inclusief
 * forecasts (classification=1).
 */
const NED_BASE = "https://api.ned.nl/v1";
const NED_API_HOST = "https://api.ned.nl";
const NED_SITE = "https://ned.nl/nl/api";

const NED_CONNECTOR = "ned";

/** Energiebron (type) — alias → NED-code. */
const TYPE_CODES: Record<string, string> = {
  all: "0",
  wind: "1",
  wind_onshore: "1",
  "wind-op-land": "1",
  solar: "2",
  zon: "2",
  wind_offshore: "17",
  "wind-op-zee": "17",
  windzee: "17",
  fossil_gas: "18",
  nuclear: "20",
  kern: "20",
  natural_gas: "23",
  gas: "23",
  electricity_load: "59",
  verbruik: "59",
  load: "59",
};

/** NED-code → leesbaar label (voor titels/records). */
const TYPE_LABELS: Record<string, string> = {
  "0": "All",
  "1": "Wind",
  "2": "Solar",
  "17": "Wind offshore",
  "18": "Fossil gas",
  "20": "Nuclear",
  "23": "Natural gas",
  "59": "Electricity load",
};

/** Tijdsinterval (granularity) — alias → NED-code. */
const GRANULARITY_CODES: Record<string, string> = {
  "10min": "3",
  "15min": "4",
  quarter: "4",
  hour: "5",
  hourly: "5",
  day: "6",
  daily: "6",
  month: "7",
  monthly: "7",
  year: "8",
  yearly: "8",
};

/** Type handeling (activity) — alias → NED-code. */
const ACTIVITY_CODES: Record<string, string> = {
  providing: "1",
  opwek: "1",
  production: "1",
  consuming: "2",
  verbruik: "2",
  consumption: "2",
  import: "3",
  export: "4",
};

/** Classificatie — alias → NED-code. */
const CLASSIFICATION_CODES: Record<string, string> = {
  forecast: "1",
  prognose: "1",
  current: "2",
  measured: "2",
  actueel: "2",
};

/**
 * Los een gebruikersinvoer op naar een NED-code: numerieke invoer wordt
 * letterlijk doorgegeven; anders wordt de alias-map (case-insensitive)
 * geraadpleegd, met terugval op de meegegeven default.
 */
function resolveCode(
  value: string | number | undefined,
  map: Record<string, string>,
  fallback: string,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return raw;
  const key = raw.toLowerCase().replace(/\s+/g, "-");
  return map[key] ?? map[key.replace(/-/g, "_")] ?? fallback;
}

export interface NedSearchArgs {
  /** Energiebron: alias (zon/wind/gas/kern/...) of NED-code. Default 2 (Solar). */
  type?: string | number;
  /** Gebied (point): 0=Nederland, 1-12=provincies, 14=offshore. Default 0. */
  point?: string | number;
  /** Tijdsinterval (granularity): alias (hour/day/...) of code. Default 5 (uur). */
  granularity?: string | number;
  /** Handeling (activity): alias (providing/consuming/...) of code. Default 1. */
  activity?: string | number;
  /** Classificatie: forecast(1) of current(2). Default 2 (gemeten). */
  classification?: string | number;
  /** Tijdzone voor granularity: 0=UTC, 1=CET. Default 1. */
  timezone?: string | number;
  /** Ondergrens op validfrom (YYYY-MM-DD of ISO), filter `validfrom[after]`. */
  validFrom?: string;
  /** Bovengrens op validfrom (YYYY-MM-DD of ISO), filter `validfrom[before]`. */
  validTo?: string;
  rows: number;
}

export interface NedItem {
  id: string;
  title: string;
  url: string;
  type?: string;
  typeLabel?: string;
  point?: string;
  granularity?: string;
  activity?: string;
  classification?: string;
  capacity?: number;
  volume?: number;
  percentage?: number;
  emission?: number;
  emissionfactor?: number;
  unit: string;
  validfrom?: string;
  validto?: string;
  lastupdate?: string;
}

interface HydraResponse {
  "hydra:member"?: Array<Record<string, unknown>>;
  "hydra:totalItems"?: number;
}

/** Haal het laatste pad-segment (numerieke id) uit een NED IRI, bv. "/v1/energy_carriers/2" → "2". */
function iriTail(value: unknown): string {
  const s = String(value ?? "");
  const parts = s.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalize(member: Record<string, unknown>): NedItem {
  const idSelf = String(member["@id"] ?? "");
  const numericId = String(member.id ?? iriTail(idSelf));
  const typeCode = iriTail(member.type);
  const typeLabel = TYPE_LABELS[typeCode];
  const validfrom = member.validfrom === undefined ? undefined : String(member.validfrom);
  const validto = member.validto === undefined ? undefined : String(member.validto);

  const titleParts = [typeLabel ?? "Energy", validfrom].filter(Boolean);
  const url = idSelf && idSelf.startsWith("/") ? `${NED_API_HOST}${idSelf}` : NED_SITE;

  return {
    id: numericId,
    title: titleParts.join(" · ") || "NED utilization",
    url,
    type: typeCode || undefined,
    typeLabel,
    point: iriTail(member.point) || undefined,
    granularity: iriTail(member.granularity) || undefined,
    activity: iriTail(member.activity) || undefined,
    classification: iriTail(member.classification) || undefined,
    capacity: toNumber(member.capacity),
    volume: toNumber(member.volume),
    percentage: toNumber(member.percentage),
    emission: toNumber(member.emission),
    emissionfactor: toNumber(member.emissionfactor),
    unit: "capacity=kW, volume=kWh, emission=kg CO2",
    validfrom,
    validto,
    lastupdate: member.lastupdate === undefined ? undefined : String(member.lastupdate),
  };
}

export class NedSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey: string,
  ) {}

  async search(args: NedSearchArgs): Promise<{
    items: NedItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const perPage = String(Math.min(Math.max(args.rows, 1), this.config.limits.maxRows));

    const type = resolveCode(args.type, TYPE_CODES, "2");
    const point = resolveCode(args.point, {}, "0");
    const granularity = resolveCode(args.granularity, GRANULARITY_CODES, "5");
    const activity = resolveCode(args.activity, ACTIVITY_CODES, "1");
    const classification = resolveCode(args.classification, CLASSIFICATION_CODES, "2");
    const timezone = resolveCode(args.timezone, { utc: "0", cet: "1" }, "1");

    // NED's /utilizations REQUIRES a validfrom date range — without it the API
    // returns HTTP 400. Default to the last 7 days (up to tomorrow) when the
    // caller omits the range, so a bare call still returns recent data.
    const pad = (n: number) => String(n).padStart(2, "0");
    const toDate = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const defaultAfter = toDate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const defaultBefore = toDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));

    const query: Record<string, string> = {
      point,
      type,
      granularity,
      granularitytimezone: timezone,
      activity,
      classification,
      "validfrom[after]": args.validFrom ?? defaultAfter,
      "validfrom[before]": args.validTo ?? defaultBefore,
      itemsPerPage: perPage,
      page: "1",
    };

    const url = `${NED_BASE}/utilizations`;
    const { data, meta } = await getJson<HydraResponse>(url, {
      query,
      headers: {
        "X-AUTH-TOKEN": this.apiKey,
        Accept: "application/ld+json",
      },
      connector: NED_CONNECTOR,
    });

    const members = Array.isArray(data["hydra:member"]) ? data["hydra:member"] : [];
    const items = members.slice(0, args.rows).map(normalize);
    const total =
      typeof data["hydra:totalItems"] === "number" ? data["hydra:totalItems"] : members.length;

    return {
      items,
      total,
      endpoint: meta.url,
      params: query,
      access_note:
        `Bron: NED.nl (Nationaal Energie Dashboard). Waarden: capaciteit in kW, volume in kWh, emissie in kg CO2. Vereist een persoonlijke API-sleutel (X-AUTH-TOKEN). NED vereist een validfrom-datumbereik; zonder validFrom/validTo wordt standaard de periode ${query["validfrom[after]"]} t/m ${query["validfrom[before]"]} gebruikt.`,
    };
  }
}
