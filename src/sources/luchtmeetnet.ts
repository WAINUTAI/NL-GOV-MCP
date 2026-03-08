import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface LuchtMeetnetMeasurement {
  station_number?: number | string;
  station_name?: string;
  formula?: string;
  value?: number;
  unit?: string;
  timestamp_measured?: string;
  location?: { latitude?: number; longitude?: number };
  [key: string]: unknown;
}

interface LuchtMeetnetResponse {
  data?: LuchtMeetnetMeasurement[];
  pagination?: { last_page?: number };
  [key: string]: unknown;
}

interface StationEntry {
  number?: string;
  location?: string;
}

const MEASUREMENTS_ENDPOINT = "https://api.luchtmeetnet.nl/open_api/measurements";
const LKI_ENDPOINT = "https://iq.luchtmeetnet.nl/open_api/lki";
const STATIONS_ENDPOINT = "https://api.luchtmeetnet.nl/open_api/stations";

function enrich(m: LuchtMeetnetMeasurement): LuchtMeetnetMeasurement {
  return {
    ...m,
    component: String(m.formula ?? "").toLowerCase(),
    timestamp: m.timestamp_measured,
    location_name: m.station_name,
    location: {
      latitude: Number(m.location?.latitude ?? 0),
      longitude: Number(m.location?.longitude ?? 0),
    },
  };
}

/** Fetch station name lookup from /stations (paginated, cached by http layer). */
async function fetchStationNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for (let page = 1; page <= 10; page++) {
      const { data } = await getJson<{ data?: StationEntry[]; pagination?: { last_page?: number } }>(
        STATIONS_ENDPOINT,
        { query: { page: String(page), page_size: "200" }, timeoutMs: 8_000, retries: 1 },
      );
      for (const s of data.data ?? []) {
        if (s.number && s.location) map.set(s.number, s.location);
      }
      if (page >= (data.pagination?.last_page ?? 1)) break;
    }
  } catch {
    // stations lookup is best-effort
  }
  return map;
}

export class LuchtmeetnetSource {
  constructor(private readonly config: AppConfig) {}

  async latest(args: { component?: string; rows: number }) {
    const params: Record<string, string> = {
      page_size: String(args.rows),
      order_by: "-timestamp_measured",
    };
    if (args.component) params.formula = args.component;

    // Strategy 1: /measurements (the original endpoint)
    try {
      const { data, meta } = await getJson<LuchtMeetnetResponse>(MEASUREMENTS_ENDPOINT, { query: params, retries: 2 });
      const items = (Array.isArray(data.data) ? data.data : []).map(enrich);
      if (items.length) {
        return {
          items,
          total: items.length,
          endpoint: meta.url,
          params,
        };
      }
    } catch {
      // fall through to LKI
    }

    // Strategy 2: /lki on iq.luchtmeetnet.nl with narrow time window
    return this.latestViaLki(args);
  }

  private async latestViaLki(args: { component?: string; rows: number }) {
    // Use a 3-hour window so we get all stations' latest values
    const now = new Date();
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const lkiParams: Record<string, string> = {
      station_number: "", // all stations
      start: threeHoursAgo.toISOString(),
      end: now.toISOString(),
    };

    // Fetch pages until we have enough unique stations
    const allEntries: LuchtMeetnetMeasurement[] = [];
    let endpoint = LKI_ENDPOINT;
    let metaUrl = LKI_ENDPOINT;

    for (let page = 1; page <= 3; page++) {
      const pageParams = { ...lkiParams, page: String(page) };
      const { data, meta } = await getJson<LuchtMeetnetResponse>(endpoint, {
        query: pageParams,
        retries: 2,
      });
      metaUrl = meta.url;
      const entries = Array.isArray(data.data) ? data.data : [];
      allEntries.push(...entries);
      if (page >= (data.pagination?.last_page ?? 1)) break;
    }

    const stationNames = await fetchStationNames();

    // Deduplicate: keep only the most recent measurement per station
    const latestByStation = new Map<string, LuchtMeetnetMeasurement>();
    for (const m of allEntries) {
      const sn = String(m.station_number ?? "");
      if (!sn) continue;
      const existing = latestByStation.get(sn);
      if (!existing || (m.timestamp_measured ?? "") > (existing.timestamp_measured ?? "")) {
        latestByStation.set(sn, m);
      }
    }

    const items = [...latestByStation.values()]
      .sort((a, b) => (b.timestamp_measured ?? "").localeCompare(a.timestamp_measured ?? ""))
      .slice(0, args.rows)
      .map((m) => {
        const stationNum = String(m.station_number ?? "");
        const stationName = stationNames.get(stationNum) ?? stationNum;
        return enrich({
          ...m,
          station_name: stationName,
          unit: "LKI (1-11)",
        });
      });

    return {
      items,
      total: items.length,
      endpoint: metaUrl,
      params: lkiParams,
      access_note: "Luchtmeetnet /measurements endpoint onbereikbaar; LKI (Lucht Kwaliteits Index) data gebruikt. Schaal 1 (goed) t/m 11 (zeer slecht).",
    };
  }

  fallback(args: { component?: string; rows: number }) {
    const component = (args.component ?? "pm25").toLowerCase();
    const item: LuchtMeetnetMeasurement = enrich({
      station_number: 0,
      station_name: "fallback-station",
      formula: component,
      value: 0,
      unit: "ug/m3",
      timestamp_measured: "1970-01-01T00:00:00Z",
      location: { latitude: 52.0, longitude: 5.0 },
      mode: "deterministic-fallback",
    });

    return {
      items: [item].slice(0, args.rows),
      total: 1,
      endpoint: `${MEASUREMENTS_ENDPOINT} (fallback)`,
      params: {
        page_size: String(args.rows),
        order_by: "-timestamp_measured",
        ...(args.component ? { formula: args.component } : {}),
        mode: "deterministic-fallback",
      },
      access_note: "Luchtmeetnet API tijdelijk niet bereikbaar; fallback-measurement gebruikt.",
    };
  }
}
