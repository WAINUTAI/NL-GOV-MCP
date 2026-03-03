import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface LuchtMeetnetMeasurement {
  station_number?: number;
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
  [key: string]: unknown;
}

const LUCHTMEETNET_ENDPOINT = "https://api.luchtmeetnet.nl/open_api/measurements";

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

export class LuchtmeetnetSource {
  constructor(private readonly config: AppConfig) {}

  async latest(args: { component?: string; rows: number }) {
    const params: Record<string, string> = {
      page_size: String(args.rows),
      order_by: "-timestamp_measured",
    };
    if (args.component) params.formula = args.component;

    const { data, meta } = await getJson<LuchtMeetnetResponse>(LUCHTMEETNET_ENDPOINT, { query: params });
    const items = (Array.isArray(data.data) ? data.data : []).map(enrich);

    return {
      items,
      total: items.length,
      endpoint: meta.url,
      params,
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
      endpoint: `${LUCHTMEETNET_ENDPOINT} (fallback)`,
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
