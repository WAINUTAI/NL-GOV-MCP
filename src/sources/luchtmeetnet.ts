import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";
import { placeKey, placeKeys } from "../utils/place-aliases.js";

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

/**
 * Three distinct connector names on purpose.
 *
 * `/measurements` is intermittently 502 — that is precisely why this source has
 * an LKI fallback. But all three endpoints used to share one connector name, so
 * three 502s from the primary opened the circuit breaker for the WHOLE source:
 * the healthy LKI fallback and the station lookup were locked out for five
 * minutes, turning a designed-for failover into a hard outage (and a false
 * "no measuring station found" for places that do have one). Separate names let
 * the primary trip its own breaker while the fallback keeps serving.
 */
const CONNECTOR_MEASUREMENTS = "luchtmeetnet";
const CONNECTOR_LKI = "luchtmeetnet_lki";
const CONNECTOR_STATIONS = "luchtmeetnet_stations";

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

/**
 * Fetch the full station list from /stations (paginated, cached by the http layer).
 *
 * `lookupFailed` matters: an empty list because the endpoint is down must not be
 * reported to the user as "this place has no measuring station".
 */
async function fetchStations(): Promise<{ stations: StationEntry[]; lookupFailed: boolean }> {
  const stations: StationEntry[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const { data } = await getJson<{ data?: StationEntry[]; pagination?: { last_page?: number } }>(
        STATIONS_ENDPOINT,
        {
          query: { page: String(page), page_size: "200" },
          timeoutMs: 8_000,
          retries: 1,
          connector: CONNECTOR_STATIONS,
        },
      );
      for (const s of data.data ?? []) {
        if (s.number && s.location) stations.push(s);
      }
      if (page >= (data.pagination?.last_page ?? 1)) break;
    }
  } catch {
    return { stations, lookupFailed: stations.length === 0 };
  }
  return { stations, lookupFailed: false };
}

/** Station number -> human-readable location name. */
async function fetchStationNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { stations } = await fetchStations();
  for (const s of stations) {
    if (s.number && s.location) map.set(s.number, s.location);
  }
  return map;
}

/**
 * Resolve a place name to its measuring stations.
 *
 * Station names are "City-Streetname" (e.g. "Utrecht-Griftpark"), so a prefix
 * match on the city part is both precise and forgiving. Falls back to a
 * contains-match so "Griftpark" or a full station name also resolves.
 *
 * Every name the place is known by is tried, caller's spelling first: these
 * stations are labelled "Den Haag-\u2026" while the rest of the government publishes
 * the same city as "'s-Gravenhage", so someone arriving from the Kiesraad or DUO
 * spelling would otherwise find nothing here.
 */
export function matchStationsByPlace(stations: StationEntry[], place: string): StationEntry[] {
  const needles = [...placeKeys(place)].filter(Boolean);
  if (!needles.length) return [];

  for (const needle of needles) {
    const byCity = stations.filter((s) => {
      const name = placeKey(s.location ?? "");
      return name === needle || name.startsWith(`${needle} `);
    });
    if (byCity.length) return byCity;
  }

  for (const needle of needles) {
    const loose = stations.filter((s) => placeKey(s.location ?? "").includes(needle));
    if (loose.length) return loose;
  }
  return [];
}

/** Cap on stations queried for one place — a city has a handful, not dozens. */
const MAX_PLACE_STATIONS = 5;

export class LuchtmeetnetSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * Resolve a place name to its stations. `lookupFailed` separates "this place
   * has no station" from "the station list was unreachable" — reporting the
   * second as the first would be a confident wrong answer.
   */
  private async resolvePlaceStations(
    place: string,
  ): Promise<{ stations: StationEntry[]; lookupFailed: boolean }> {
    const { stations, lookupFailed } = await fetchStations();
    return {
      stations: matchStationsByPlace(stations, place).slice(0, MAX_PLACE_STATIONS),
      lookupFailed,
    };
  }

  async latest(args: { component?: string; plaats?: string; rows: number }) {
    const place = args.plaats?.trim();
    let stations: StationEntry[] = [];
    let stationLookupFailed = false;

    if (place) {
      const resolved = await this.resolvePlaceStations(place);
      stations = resolved.stations;
      stationLookupFailed = resolved.lookupFailed;

      if (!stations.length && !stationLookupFailed) {
        return {
          items: [],
          total: 0,
          endpoint: STATIONS_ENDPOINT,
          params: { plaats: place },
          access_note: `Geen Luchtmeetnet-meetstation gevonden voor '${place}'. Het meetnet dekt niet elke plaats; probeer een grotere stad in de buurt of laat 'plaats' weg voor landelijke metingen.`,
        };
      }
    }

    const params: Record<string, string> = {
      page_size: String(args.rows),
      order_by: "-timestamp_measured",
    };
    if (args.component) params.formula = args.component;
    if (stations.length) params.station_number = stations.map((s) => s.number ?? "").join(",");

    // Strategy 1: /measurements (the original endpoint). One request per station
    // — the API filters on a single station_number at a time.
    try {
      const requests = stations.length
        ? stations.map((station) =>
            getJson<LuchtMeetnetResponse>(MEASUREMENTS_ENDPOINT, {
              query: { ...params, station_number: station.number ?? "" },
              retries: 2,
              connector: CONNECTOR_MEASUREMENTS,
            }),
          )
        : [
            getJson<LuchtMeetnetResponse>(MEASUREMENTS_ENDPOINT, {
              query: params,
              retries: 2,
              connector: CONNECTOR_MEASUREMENTS,
            }),
          ];

      const responses = await Promise.all(requests);
      const items = responses
        .flatMap(({ data }) => (Array.isArray(data.data) ? data.data : []))
        .map(enrich)
        .slice(0, args.rows);

      if (items.length) {
        return {
          items,
          total: items.length,
          endpoint: responses[0].meta.url,
          params,
          access_note: place
            ? `Metingen van ${stations.length} meetstation(s) in ${place}: ${stations.map((s) => s.location).join(", ")}.`
            : undefined,
        };
      }
    } catch {
      // fall through to LKI
    }

    // Strategy 2: /lki on iq.luchtmeetnet.nl with narrow time window
    return this.latestViaLki({ ...args, stations });
  }

  private async latestViaLki(args: {
    component?: string;
    plaats?: string;
    rows: number;
    stations?: StationEntry[];
  }) {
    // Use a 3-hour window so we get all stations' latest values
    const now = new Date();
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const stations = args.stations ?? [];
    const lkiParams: Record<string, string> = {
      // "" means all stations; LKI accepts one station per call, so a place
      // query fans out below and this records what was asked for.
      station_number: stations.map((s) => s.number ?? "").join(",") || "",
      start: threeHoursAgo.toISOString(),
      end: now.toISOString(),
    };

    // Fetch pages until we have enough unique stations
    const allEntries: LuchtMeetnetMeasurement[] = [];
    let endpoint = LKI_ENDPOINT;
    let metaUrl = LKI_ENDPOINT;

    if (stations.length) {
      const responses = await Promise.all(
        stations.map((station) =>
          getJson<LuchtMeetnetResponse>(endpoint, {
            query: { ...lkiParams, station_number: station.number ?? "" },
            retries: 2,
            connector: CONNECTOR_LKI,
          }),
        ),
      );
      metaUrl = responses[0]?.meta.url ?? LKI_ENDPOINT;
      for (const { data } of responses) {
        allEntries.push(...(Array.isArray(data.data) ? data.data : []));
      }
    } else {
      for (let page = 1; page <= 3; page++) {
        const pageParams = { ...lkiParams, page: String(page) };
        const { data, meta } = await getJson<LuchtMeetnetResponse>(endpoint, {
          query: pageParams,
          retries: 2,
          connector: CONNECTOR_LKI,
        });
        metaUrl = meta.url;
        const entries = Array.isArray(data.data) ? data.data : [];
        allEntries.push(...entries);
        if (page >= (data.pagination?.last_page ?? 1)) break;
      }
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

    const placeNote = stations.length
      ? ` Meetstation(s) in ${args.plaats}: ${stations.map((s) => s.location).join(", ")}.`
      : args.plaats
        ? ` Stationlijst was niet bereikbaar, dus '${args.plaats}' kon niet worden opgezocht; dit zijn landelijke metingen.`
        : "";

    return {
      items,
      total: items.length,
      endpoint: metaUrl,
      params: lkiParams,
      access_note: `Luchtmeetnet /measurements endpoint onbereikbaar; LKI (Lucht Kwaliteits Index) data gebruikt. Schaal 1 (goed) t/m 11 (zeer slecht).${placeNote}`,
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
