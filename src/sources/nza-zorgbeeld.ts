import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

// NZa Zorgbeeld — actuele wachttijden medisch-specialistische zorg (MSZ).
// Keyless GET; het endpoint levert standaard XML (root <TL_RESTs> met <TL_REST>-kinderen).
// Live geverifieerd (HTTP 200) tegen ?KVKNummer=41055629 (Radboudumc).
const NZA_ZORGBEELD_ENDPOINT = "https://zorgbeeld.nza.nl/openapi/WaitingTimeMSZ";
const PORTAL_URL = "https://zorgbeeld.nza.nl/";

// De volledige dataset is groter dan de standaard body-cap; ruimer instellen zodat
// een ongefilterde (of KVK-brede) ophaal niet vroegtijdig afgekapt wordt.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

type TreatmentType = "Behandeling" | "Polikliniekbezoek" | "Diagnostiek";

interface WaitingTimeItem {
  id: string;
  title: string;
  url: string;
  date: string;
  careProvider: string;
  location: string;
  specialism: string;
  treatment: string;
  treatmentType: string;
  waitingTimeDays: number | null;
  insufficientObservations: string;
  kvkNumber: string;
  agbCode: string;
  address: string;
  city: string;
}

/** Haal de <TL_REST>-records uit de geparste <TL_RESTs>-container (leeg = <TL_RESTs/>). */
function extractRecords(parsed: unknown): Array<Record<string, unknown>> {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const container = root.TL_RESTs;
  if (!container || typeof container !== "object") return [];
  const rec = (container as Record<string, unknown>).TL_REST;
  if (rec === undefined || rec === null) return [];
  const arr = Array.isArray(rec) ? rec : [rec];
  return arr.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
}

/** WaitingTime kan een getal, een numerieke string of afwezig zijn (bij te weinig observaties). */
function toWaitingTimeDays(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  }
  return null;
}

function toItem(rec: Record<string, unknown>): WaitingTimeItem {
  const careProvider = String(rec.CareProvider ?? "").trim();
  const location = String(rec.Location ?? "").trim();
  const specialism = String(rec.Specialism ?? "").trim();
  const treatment = String(rec.Treatment ?? "").trim();
  const treatmentType = String(rec.TreatmentType ?? "").trim();
  const city = String(rec.City ?? "").trim();
  const kvkNumber = String(rec.KVKNumber ?? "").trim();
  const street = `${String(rec.Street ?? "").trim()} ${String(
    rec.StreetNumber ?? "",
  ).trim()}`.trim();

  const id =
    [kvkNumber, String(rec.LocationKey ?? ""), String(rec.TreatmentKey ?? "")]
      .filter((part) => part && part.trim() !== "")
      .join(":") || `${careProvider}:${treatment}`;

  return {
    id,
    title: `${careProvider}${treatment ? ` — ${treatment}` : ""}`.trim() || "NZa wachttijd",
    url: PORTAL_URL,
    date: String(rec.Date ?? "").trim(),
    careProvider,
    location,
    specialism,
    treatment,
    treatmentType,
    waitingTimeDays: toWaitingTimeDays(rec.WaitingTime),
    insufficientObservations: String(rec.InsufficientObservations ?? "").trim(),
    kvkNumber,
    agbCode: String(rec.CareProvider_AGBCode ?? "").trim(),
    address: [street, String(rec.PostalCode ?? "").trim(), city]
      .filter((part) => part && part.trim() !== "")
      .join(", "),
    city,
  };
}

function matchesQuery(item: WaitingTimeItem, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const haystack = `${item.careProvider} ${item.location} ${item.specialism} ${item.treatment} ${item.treatmentType} ${item.city}`.toLowerCase();
  return haystack.includes(q);
}

export class NzaZorgbeeldSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: {
    query?: string;
    kvk?: string;
    treatmentType?: TreatmentType;
    rows: number;
  }): Promise<{
    items: WaitingTimeItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const query = (args.query ?? "").trim();
    const kvk = (args.kvk ?? "").replace(/[^0-9]/g, "");
    const treatmentType = args.treatmentType;

    // Server-side narrowing: het endpoint ondersteunt alleen KVKNummer.
    const httpQuery: Record<string, string> = {};
    if (kvk) httpQuery.KVKNummer = kvk;

    const { data, meta } = await getText(NZA_ZORGBEELD_ENDPOINT, {
      query: httpQuery,
      headers: { Accept: "application/xml" },
      connector: "nza_zorgbeeld",
      timeoutMs: 20_000,
      maxResponseBytes: MAX_BODY_BYTES,
    });

    const parsed = parseXml(data);
    const fetched = extractRecords(parsed).map(toItem);

    // Client-side filteren op de opgehaalde set (endpoint kent geen tekst/specialisme-filter).
    const matched = fetched.filter(
      (item) =>
        matchesQuery(item, query) &&
        (!treatmentType || item.treatmentType === treatmentType),
    );

    const items = matched.slice(0, args.rows);

    // Provenance-params: cast alles naar string.
    const params: Record<string, string> = { ...httpQuery };
    if (query) params.q = query;
    if (treatmentType) params.treatmentType = treatmentType;

    const notes: string[] = [];
    if (query || treatmentType) {
      notes.push(
        "Resultaten zijn client-side gefilterd op de opgehaalde WaitingTimeMSZ-snapshot; 'total' telt de treffers in die opgehaalde set (geen server-side telling).",
      );
    }
    if (!kvk) {
      notes.push(
        "Geen KVKNummer opgegeven: de volledige actuele MSZ-wachttijdenset is opgehaald. Geef 'kvk' mee om per zorgaanbieder te beperken.",
      );
    }

    return {
      items,
      total: matched.length,
      endpoint: meta.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }
}
