import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

/**
 * OVapi — realtime openbaar vervoer (KV78Turbo doorvertaling).
 *
 * Keyless JSON. De gebruiker heeft een HALTECODE (timingpointcode) nodig, bv.
 * 32002646 (halte Ternoot, Den Haag). Per halte worden alle geplande passages
 * (Passes) met geplande + verwachte vertrektijd en realtime status geleverd.
 *
 * LET OP: v0.ovapi.nl draait op plain HTTP (geen geldig HTTPS-cert) — dit is
 * correct en bewust; de URL blijft http://.
 */
const OVAPI_TPC_ENDPOINT = "http://v0.ovapi.nl/tpc";

interface OvapiDeparture {
  id: string;
  title: string;
  url: string;
  date: string;
  line: string;
  lineName: string;
  destination: string;
  transportType: string;
  operator: string;
  targetDepartureTime: string;
  expectedDepartureTime: string;
  delayMinutes: number | null;
  tripStopStatus: string;
  journeyNumber: string;
  timingPointCode: string;
  stopName: string;
  town: string;
}

function str(obj: Record<string, unknown>, key: string): string {
  return String(obj[key] ?? "");
}

/** Vertraging in hele minuten (verwacht - gepland). null als tijden onbruikbaar zijn. */
function computeDelayMinutes(target: string, expected: string): number | null {
  if (!target || !expected) return null;
  const t = Date.parse(target);
  const e = Date.parse(expected);
  if (Number.isNaN(t) || Number.isNaN(e)) return null;
  return Math.round((e - t) / 60000);
}

/**
 * Kies de halte-entry uit de top-level respons. OVapi keyt op timingpointcode,
 * maar val defensief terug op de eerste entry met een Passes-object.
 */
function pickStopEntry(
  data: Record<string, unknown>,
  code: string,
): Record<string, unknown> | undefined {
  const direct = data[code];
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  for (const value of Object.values(data)) {
    if (value && typeof value === "object" && "Passes" in (value as Record<string, unknown>)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function toDeparture(
  passKey: string,
  pass: Record<string, unknown>,
  stop: Record<string, unknown>,
  code: string,
): OvapiDeparture {
  const target = str(pass, "TargetDepartureTime");
  const expected = str(pass, "ExpectedDepartureTime") || target;
  const line = str(pass, "LinePublicNumber") || str(pass, "LinePlanningNumber");
  const destination = str(pass, "DestinationName50");
  const transportType = str(pass, "TransportType");
  const title = `${transportType} ${line} → ${destination}`.replace(/\s+/g, " ").trim();
  return {
    id: passKey,
    title: title || `Vertrek ${code}`,
    url: `${OVAPI_TPC_ENDPOINT}/${code}`,
    date: expected,
    line,
    lineName: str(pass, "LineName"),
    destination,
    transportType,
    operator: str(pass, "OperatorCode") || str(pass, "DataOwnerCode"),
    targetDepartureTime: target,
    expectedDepartureTime: expected,
    delayMinutes: computeDelayMinutes(target, expected),
    tripStopStatus: str(pass, "TripStopStatus"),
    journeyNumber: str(pass, "JourneyNumber"),
    timingPointCode: str(pass, "TimingPointCode") || code,
    stopName: str(stop, "TimingPointName"),
    town: str(stop, "TimingPointTown"),
  };
}

export class OvapiSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { timingPointCode: string; line?: string; rows: number }): Promise<{
    items: OvapiDeparture[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const code = args.timingPointCode.trim();
    const lineFilter = (args.line ?? "").trim();
    const params: Record<string, string> = { timingPointCode: code };
    if (lineFilter) params.line = lineFilter;

    if (!code) {
      return {
        items: [],
        total: 0,
        endpoint: OVAPI_TPC_ENDPOINT,
        params,
        access_note:
          "Geef een geldige haltecode (timingpointcode) op, bv. 32002646. Zoek de code op via 9292 of de OVapi/GTFS-index (https://gtfs.ovapi.nl/nl/).",
      };
    }

    const { data, meta } = await getJson<Record<string, unknown>>(
      `${OVAPI_TPC_ENDPOINT}/${encodeURIComponent(code)}`,
      { connector: "ovapi" },
    );

    const root = data && typeof data === "object" ? data : {};
    const stopEntry = pickStopEntry(root, code);
    const stop =
      stopEntry && typeof stopEntry.Stop === "object" && stopEntry.Stop
        ? (stopEntry.Stop as Record<string, unknown>)
        : {};
    const passesObj =
      stopEntry && typeof stopEntry.Passes === "object" && stopEntry.Passes
        ? (stopEntry.Passes as Record<string, unknown>)
        : {};

    let departures = Object.entries(passesObj)
      .filter(([, pass]) => pass && typeof pass === "object")
      .map(([passKey, pass]) => toDeparture(passKey, pass as Record<string, unknown>, stop, code));

    if (lineFilter) {
      const wanted = lineFilter.toLowerCase();
      departures = departures.filter((d) => d.line.toLowerCase() === wanted);
    }

    departures.sort((a, b) => {
      const ta = Date.parse(a.expectedDepartureTime);
      const tb = Date.parse(b.expectedDepartureTime);
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb;
    });

    const total = departures.length;
    const items = departures.slice(0, args.rows);

    const stopLabel = str(stop, "TimingPointName") || code;
    const access_note = items.length
      ? `Realtime vertrekdata voor halte '${stopLabel}' (${code}). Vertraging = verwacht - gepland (minuten).`
      : `Geen actuele vertrekken voor haltecode '${code}'${
          lineFilter ? ` op lijn ${lineFilter}` : ""
        } (buiten dienstregeling of onbekende/verkeerde code).`;

    return {
      items,
      total,
      endpoint: meta.url,
      params,
      access_note,
    };
  }
}
