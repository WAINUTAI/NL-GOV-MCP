import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

// NS Reisinformatie API (Nederlandse Spoorwegen). Key-vereist: Azure API Management
// gateway met header 'Ocp-Apim-Subscription-Key'. Endpoints hebben per-operatie een
// eigen versie: v3/trips + v3/disruptions, v2/departures + v2/arrivals.
const NS_BASE = "https://gateway.apiportal.ns.nl/reisinformatie-api/api";

const NS_ENDPOINTS = {
  disruptions: `${NS_BASE}/v3/disruptions`,
  departures: `${NS_BASE}/v2/departures`,
  arrivals: `${NS_BASE}/v2/arrivals`,
  trips: `${NS_BASE}/v3/trips`,
} as const;

// Publieke NS-reisplanner deeplinks als canonical url per operatie (de API zelf levert
// geen stabiele publieke item-URL's).
const NS_PUBLIC = {
  disruptions: "https://www.ns.nl/storingen",
  departures: "https://www.ns.nl/reisinformatie/actuele-vertrektijden",
  arrivals: "https://www.ns.nl/reisinformatie/actuele-aankomsttijden",
  trips: "https://www.ns.nl/reisplanner",
} as const;

export type NsOperation = "disruptions" | "departures" | "arrivals" | "trips";

export interface NsSearchArgs {
  operation: NsOperation;
  /** Stationcode (bijv. 'UT', 'ASD') of Uic-code — vereist voor departures/arrivals. */
  station?: string;
  /** Vertrekstation (code) — vereist voor trips. */
  fromStation?: string;
  /** Aankomststation (code) — vereist voor trips. */
  toStation?: string;
  /** ISO-8601 tijdstip (bijv. '2026-07-03T08:00:00+02:00'). Optioneel; default = nu. */
  dateTime?: string;
  /** disruptions: alleen actieve verstoringen tonen. Default true. */
  isActive?: boolean;
  rows: number;
}

export interface NsSearchItem {
  id: string;
  title: string;
  url: string;
  type: NsOperation;
  date?: string;
  // departures / arrivals
  station?: string;
  direction?: string;
  trainCategory?: string;
  plannedDateTime?: string;
  actualDateTime?: string;
  plannedTrack?: string;
  actualTrack?: string;
  cancelled?: boolean;
  operator?: string;
  routeText?: string;
  // trips
  status?: string;
  transfers?: number;
  durationMinutes?: number;
  // disruptions
  disruptionType?: string;
  topic?: string;
  isActive?: boolean;
  phase?: string;
  cause?: string;
  start?: string;
  end?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Leeg → undefined, zodat records lean blijven (geen lege string-velden). */
function clean(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/** phase/cause/situation kunnen zowel { label } als een kale string zijn. */
function label(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  return str(obj.label ?? obj.description ?? "");
}

function normalizeDisruption(d: Record<string, unknown>): NsSearchItem {
  const firstSpan = asRecord(asArray(d.timespans)[0]);
  const start = str(d.start ?? firstSpan.start);
  return {
    id: str(d.id),
    title: str(d.title) || str(d.topic) || "NS verstoring",
    url: NS_PUBLIC.disruptions,
    type: "disruptions",
    date: clean(start),
    disruptionType: clean(str(d.type)),
    topic: clean(str(d.topic)),
    isActive: typeof d.isActive === "boolean" ? d.isActive : undefined,
    phase: clean(label(d.phase)),
    cause: clean(label(firstSpan.cause) || label(firstSpan.situation)),
    start: clean(start),
    end: clean(str(d.end ?? firstSpan.end)),
  };
}

function normalizeDeparture(d: Record<string, unknown>): NsSearchItem {
  const product = asRecord(d.product);
  const category = str(d.trainCategory) || str(product.categoryCode) || str(d.name);
  const direction = str(d.direction);
  const planned = str(d.plannedDateTime);
  const actual = str(d.actualDateTime);
  return {
    id: `${str(product.number) || str(d.name)}-${planned}`,
    title: [category, direction].filter(Boolean).join(" naar ") || "Vertrek",
    url: NS_PUBLIC.departures,
    type: "departures",
    date: clean(actual || planned),
    station: undefined,
    direction: clean(direction),
    trainCategory: clean(category),
    plannedDateTime: clean(planned),
    actualDateTime: clean(actual),
    plannedTrack: clean(str(d.plannedTrack)),
    actualTrack: clean(str(d.actualTrack)),
    cancelled: typeof d.cancelled === "boolean" ? d.cancelled : undefined,
    operator: clean(str(product.operatorName)),
    routeText: clean(
      str(d.routeText ?? d.RouteTekst) ||
        asArray(d.routeStations)
          .map((s) => str(asRecord(s).mediumName))
          .filter(Boolean)
          .join(" - "),
    ),
  };
}

function normalizeArrival(d: Record<string, unknown>): NsSearchItem {
  const product = asRecord(d.product);
  const category = str(d.trainCategory) || str(product.categoryCode) || str(d.name);
  const origin = str(d.origin) || str(d.direction);
  const planned = str(d.plannedDateTime);
  const actual = str(d.actualDateTime);
  return {
    id: `${str(product.number) || str(d.name)}-${planned}`,
    title: [category, origin].filter(Boolean).join(" vanuit ") || "Aankomst",
    url: NS_PUBLIC.arrivals,
    type: "arrivals",
    date: clean(actual || planned),
    direction: clean(origin),
    trainCategory: clean(category),
    plannedDateTime: clean(planned),
    actualDateTime: clean(actual),
    plannedTrack: clean(str(d.plannedTrack)),
    actualTrack: clean(str(d.actualTrack)),
    cancelled: typeof d.cancelled === "boolean" ? d.cancelled : undefined,
    operator: clean(str(product.operatorName)),
  };
}

function normalizeTrip(t: Record<string, unknown>, index: number): NsSearchItem {
  const legs = asArray(t.legs);
  const originLeg = asRecord(legs[0]);
  const destLeg = asRecord(legs[legs.length - 1] ?? legs[0]);
  const origin = asRecord(originLeg.origin);
  const destination = asRecord(destLeg.destination);
  const from = str(origin.name);
  const to = str(destination.name);
  const duration = t.actualDurationInMinutes ?? t.plannedDurationInMinutes;
  const departure = str(origin.actualDateTime ?? origin.plannedDateTime);
  return {
    id: str(t.uid) || String(index),
    title: [from, to].filter(Boolean).join(" → ") || "Reisadvies",
    url: NS_PUBLIC.trips,
    type: "trips",
    date: clean(departure),
    status: clean(str(t.status)),
    transfers: typeof t.transfers === "number" ? t.transfers : undefined,
    durationMinutes: typeof duration === "number" ? duration : undefined,
    plannedDateTime: clean(str(origin.plannedDateTime)),
    actualDateTime: clean(str(origin.actualDateTime)),
    plannedTrack: clean(str(origin.plannedTrack)),
    actualTrack: clean(str(origin.actualTrack)),
    operator: clean(label(asRecord(originLeg.product).operatorName)),
  };
}

export class NsReisinformatieSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey: string,
  ) {}

  async search(args: NsSearchArgs): Promise<{
    items: NsSearchItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const headers: Record<string, string> = {
      "Ocp-Apim-Subscription-Key": this.apiKey,
      Accept: "application/json",
    };

    const rows = Math.min(Math.max(args.rows, 1), this.config.limits.maxRows);
    const query: Record<string, string | number | boolean | undefined> = { lang: "nl" };
    const endpointUrl: string = NS_ENDPOINTS[args.operation];

    if (args.operation === "departures" || args.operation === "arrivals") {
      if (!args.station) {
        throw new Error(`station is required for ns_reisinformatie operation '${args.operation}'`);
      }
      query.station = args.station;
      query.maxJourneys = rows;
      if (args.dateTime) query.dateTime = args.dateTime;
    } else if (args.operation === "trips") {
      if (!args.fromStation || !args.toStation) {
        throw new Error("fromStation and toStation are required for ns_reisinformatie operation 'trips'");
      }
      query.fromStation = args.fromStation;
      query.toStation = args.toStation;
      if (args.dateTime) query.dateTime = args.dateTime;
    } else {
      // disruptions
      query.isActive = args.isActive ?? true;
    }

    const { data, meta } = await getJson<unknown>(endpointUrl, {
      query,
      headers,
      connector: "ns",
    });

    let items: NsSearchItem[];
    if (args.operation === "disruptions") {
      // v3/disruptions levert een JSON-array (of soms { payload: [...] }).
      const raw = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : asArray(asRecord(data).payload);
      items = raw.slice(0, rows).map(normalizeDisruption);
    } else if (args.operation === "trips") {
      const raw = asArray(asRecord(data).trips);
      items = raw.slice(0, rows).map((t, i) => normalizeTrip(t, i));
    } else {
      const payload = asRecord(asRecord(data).payload);
      const key = args.operation === "arrivals" ? "arrivals" : "departures";
      const raw = asArray(payload[key]);
      items = raw
        .slice(0, rows)
        .map((d) => (args.operation === "arrivals" ? normalizeArrival(d) : normalizeDeparture(d)));
      if (args.station) items = items.map((it) => ({ ...it, station: args.station }));
    }

    const params: Record<string, string> = { operation: args.operation };
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params[k] = String(v);
    }

    return {
      items,
      total: items.length,
      endpoint: meta.url,
      params,
      access_note:
        "Bron: NS Reisinformatie API (Nederlandse Spoorwegen), read-only. Versies: v3/trips, v3/disruptions, v2/departures, v2/arrivals. Realtime data; tijden zijn ISO-8601 in Europe/Amsterdam.",
    };
  }
}
