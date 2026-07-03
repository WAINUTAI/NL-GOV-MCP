import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

/**
 * DNB Statistics API (De Nederlandsche Bank) — key-vereist REST.
 *
 * De API loopt via het Azure API Management developer portal op api.portal.dnb.nl.
 * De subscription key gaat mee als HTTP-header `Ocp-Apim-Subscription-Key`
 * (bevestigd via de Starters Guide, https://api.portal.dnb.nl/startersguide).
 *
 * De exacte per-dataset endpoint-paden staan achter een My DNB-login en zijn
 * gefaseerd uitgerold; daarom is deze connector defensief opgezet:
 *  - `dataset` mag een volledige URL, een pad ("statistics/v1/interest-rates")
 *    of een korte code zijn — die wordt onder DNB_STATISTICS_BASE gehangen;
 *  - de datapunt-parser accepteert meerdere container- en veldnaamvarianten
 *    (observations/data/value/results, period/value/unit in diverse casings).
 */
const DNB_STATISTICS_BASE = "https://api.portal.dnb.nl";

/** DNB-datazoekpagina — canonieke landingsplek voor een menselijke lezer. */
const DNB_DATA_SEARCH = "https://www.dnb.nl/en/statistics/data-search/";

/** HTTP-header waarmee DNB (Azure APIM) de subscription key verwacht. */
export const DNB_SUBSCRIPTION_HEADER = "Ocp-Apim-Subscription-Key";

export interface DnbSearchArgs {
  /** Dataset-code, -pad of volledige endpoint-URL (bijv. "interest-rates"). */
  dataset: string;
  /** Optionele vrije tekst; client-side filter op periode/label/eenheid. */
  query?: string;
  /** Optionele startperiode (SDMX-stijl, bijv. "2020" of "2020-01"). */
  startPeriod?: string;
  /** Optionele eindperiode. */
  endPeriod?: string;
  rows: number;
}

export interface DnbDataPoint {
  id: string;
  title: string;
  dataset: string;
  period: string;
  value: number | string | null;
  unit?: string;
  label?: string;
  frequency?: string;
  url: string;
}

function str(x: unknown): string {
  return x === undefined || x === null ? "" : String(x);
}

/** Externe waarde → number wanneer numeriek, anders trimmed string, anders null. */
function coerceValue(x: unknown): number | string | null {
  if (x === undefined || x === null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = String(x).trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && /^[-+]?[0-9.,]+$/.test(s) ? n : s;
}

/**
 * Haal de datapunt-array uit een DNB-respons. Accepteert een top-level array
 * of een object met een van de gangbare container-keys, eventueel genest.
 */
function asObservations(data: unknown, depth = 0): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (!data || typeof data !== "object" || depth > 3) return [];
  const obj = data as Record<string, unknown>;
  const keys = [
    "observations",
    "dataPoints",
    "datapoints",
    "data",
    "value",
    "values",
    "results",
    "items",
    "records",
    "series",
  ];
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  // Één niveau dieper proberen (bijv. { result: { data: [...] } }).
  for (const key of ["result", "data", "payload", "response"]) {
    const v = obj[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = asObservations(v, depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

function normalize(row: Record<string, unknown>, dataset: string, datasetUrl: string, index: number): DnbDataPoint {
  const period = str(
    pick(row, ["period", "Period", "PERIOD", "periode", "date", "Date", "time", "TIME_PERIOD", "timePeriod"]),
  );
  const value = coerceValue(pick(row, ["value", "Value", "VALUE", "waarde", "observation", "OBS_VALUE", "obsValue", "amount"]));
  const unit = str(pick(row, ["unit", "Unit", "UNIT", "unitOfMeasure", "eenheid", "measure"])) || undefined;
  const label = str(pick(row, ["label", "Label", "name", "Name", "title", "description", "omschrijving", "series"])) || undefined;
  const frequency = str(pick(row, ["frequency", "Frequency", "FREQ", "freq"])) || undefined;
  const id = str(pick(row, ["id", "Id", "key", "seriesKey"])) || `${dataset}#${period || index}`;

  return {
    id,
    title: label ? `${label}${period ? ` (${period})` : ""}` : `${dataset}${period ? ` — ${period}` : ""}`,
    dataset,
    period,
    value,
    unit,
    label,
    frequency,
    url: datasetUrl,
  };
}

function matchesQuery(dp: DnbDataPoint, query?: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  const hay = [dp.period, dp.label, dp.unit, dp.frequency, String(dp.value ?? "")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

/** Bouw de dataset-endpoint-URL uit een code, pad of volledige URL. */
function resolveEndpoint(dataset: string): string {
  const trimmed = dataset.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `${DNB_STATISTICS_BASE}/${trimmed.replace(/^\/+/, "")}`;
}

export class DnbStatisticsSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey: string,
  ) {}

  async search(args: DnbSearchArgs): Promise<{
    items: DnbDataPoint[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const rows = Math.min(Math.max(args.rows, 1), this.config.limits.maxRows);
    const url = resolveEndpoint(args.dataset);

    const query: Record<string, string> = {};
    if (args.startPeriod) query.startPeriod = args.startPeriod;
    if (args.endPeriod) query.endPeriod = args.endPeriod;

    const { data, meta } = await getJson<unknown>(url, {
      query,
      headers: {
        [DNB_SUBSCRIPTION_HEADER]: this.apiKey,
        Accept: "application/json",
      },
      connector: "dnb",
    });

    const observations = asObservations(data);
    const normalized = observations.map((row, i) => normalize(row, args.dataset, meta.url, i));
    const filtered = normalized.filter((dp) => matchesQuery(dp, args.query));

    return {
      items: filtered.slice(0, rows),
      total: filtered.length,
      endpoint: meta.url,
      params: {
        dataset: args.dataset,
        rows: String(rows),
        ...query,
        ...(args.query ? { q: args.query } : {}),
      },
      access_note:
        "Bron: DNB Statistics API (api.portal.dnb.nl, Azure APIM). Subscription key via header Ocp-Apim-Subscription-Key. Exacte dataset-paden staan achter My DNB-login en zijn gefaseerd uitgerold; geef 'dataset' als code, pad of volledige endpoint-URL. Datapunt-parsing is defensief (meerdere veldnaamvarianten).",
    };
  }
}
