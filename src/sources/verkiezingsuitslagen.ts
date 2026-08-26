import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

/**
 * Kiesraad — Databank Verkiezingsuitslagen.
 *
 * Elections were a blind spot: this server could tell you what parliament
 * decided, what a municipality spends and how its neighbourhoods score on
 * crime, but not how it voted. The Kiesraad databank serves per-party results
 * per election, drillable to province and municipality.
 *
 * Keyless JSON endpoints behind the databank UI:
 *   /verkiezingen/detailJson/{code}                  -> national result + region index
 *   /verkiezingen/detailJson/{code}/{stemregioId}    -> result for one region
 * The election overview page carries the list of published elections; there is
 * no JSON list endpoint, so it is parsed from the (server-rendered) HTML.
 */
const BASE = "https://www.verkiezingsuitslagen.nl";
const OVERVIEW_URL = `${BASE}/verkiezingen`;
const CONNECTOR = "verkiezingsuitslagen";

/** Election kind prefixes used in Kiesraad codes (e.g. TK20251029). */
export const VERKIEZING_SOORTEN: Record<string, string> = {
  TK: "Tweede Kamer",
  EK: "Eerste Kamer",
  EP: "Europees Parlement",
  GR: "Gemeenteraad",
  PS: "Provinciale Staten",
  WS: "Waterschap",
  ER: "Eilandsraad",
  KC: "Kiescollege",
  RF: "Referendum",
};

const CODE_PATTERN = /^[A-Z]{2}\d{8}$/;

export interface VerkiezingSummary {
  code: string;
  soort: string;
  naam: string;
  datum: string;
  opkomst: string;
  url: string;
}

export interface PartijUitslag {
  partij: string;
  aantalStemmen: number | null;
  percentage: number | null;
  aantalZetels: number | null;
  partijUri: string;
}

export interface GebiedUitslag {
  verkiezingCode: string;
  verkiezingNaam: string;
  verkiezingDatum: string;
  gebied: string;
  gebiedId: string;
  niveau: "land" | "provincie" | "gemeente";
  kiesgerechtigden: number | null;
  opkomst: number | null;
  opkomstPercentage: number | null;
  geldigeStemmen: number | null;
  blancoStemmen: number | null;
  ongeldigeStemmen: number | null;
  partijen: PartijUitslag[];
  url: string;
}

interface RegioOption {
  Id?: unknown;
  Value?: unknown;
}

interface RegioGroup {
  Id?: unknown;
  Name?: unknown;
  Options?: RegioOption[];
}

interface StemregioPayload {
  StemregioId?: unknown;
  Naam?: unknown;
  Kiesgerechtigden?: unknown;
  Opkomst?: unknown;
  OpkomstPercentage?: unknown;
  AantalGeldigeStemmen?: unknown;
  AantalBlancoStemmen?: unknown;
  AantalOngeldigeStemmen?: unknown;
  Partij?: Array<{
    Naam?: unknown;
    AantalStemmen?: unknown;
    AantalZetels?: unknown;
    Percentage?: unknown;
    PartijUri?: unknown;
  }>;
}

interface DetailPayload {
  Info?: {
    Code?: unknown;
    Name?: unknown;
    Date?: unknown;
    HeeftGemeentes?: unknown;
  };
  Stemregio?: StemregioPayload;
  Regios?: { Regios?: RegioGroup[] };
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Kiesraad renders numbers Dutch-style: "1.790.634" and "16,94%". Turn them into
 * real numbers so downstream tooling can sort and aggregate.
 */
export function parseDutchNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = str(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/%/g, "").replace(/\./g, "").replace(/,/g, ".").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Fold accents and case so "Fryslân" matches "fryslan". */
function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function soortFromCode(code: string): string {
  return VERKIEZING_SOORTEN[code.slice(0, 2).toUpperCase()] ?? code.slice(0, 2).toUpperCase();
}

/** Parse the server-rendered election overview into structured summaries. */
export function parseVerkiezingenOverview(html: string): VerkiezingSummary[] {
  const results: VerkiezingSummary[] = [];
  const blockPattern =
    /<a href="\/verkiezingen\/detail\/([A-Z]{2}\d{8})">([\s\S]*?)<\/a>/g;

  for (const match of html.matchAll(blockPattern)) {
    const code = match[1];
    const block = match[2];
    const naam = /<span class="verkiezingsnaam">([\s\S]*?)<\/span>/.exec(block)?.[1]?.trim() ?? "";
    const datum = /<span class="datum">([\s\S]*?)<\/span>/.exec(block)?.[1]?.trim() ?? "";
    const opkomst =
      /<span class="opkomst">[\s\S]*?<span class="value">([\s\S]*?)<\/span>/.exec(block)?.[1]?.trim() ??
      "";

    if (results.some((r) => r.code === code)) continue;
    results.push({
      code,
      soort: soortFromCode(code),
      naam: naam || soortFromCode(code),
      datum,
      opkomst,
      url: `${BASE}/verkiezingen/detail/${code}`,
    });
  }

  return results;
}

/** ISO date embedded in a Kiesraad code: TK20251029 -> 2025-10-29. */
function dateFromCode(code: string): string {
  const digits = code.slice(2);
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export class VerkiezingsuitslagenSource {
  constructor(private readonly config: AppConfig) {}

  async listVerkiezingen(): Promise<{ items: VerkiezingSummary[]; endpoint: string }> {
    const { data, meta } = await getText(OVERVIEW_URL, {
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });
    return { items: parseVerkiezingenOverview(data), endpoint: meta.url };
  }

  /**
   * Resolve what the caller typed into an election code: an exact code, an
   * election kind ("TK", "gemeenteraad"), or nothing at all (most recent).
   */
  private async resolveCode(
    verkiezing: string | undefined,
  ): Promise<{ code?: string; candidates: VerkiezingSummary[]; note?: string }> {
    const raw = (verkiezing ?? "").trim();
    if (CODE_PATTERN.test(raw.toUpperCase())) {
      return { code: raw.toUpperCase(), candidates: [] };
    }

    const { items } = await this.listVerkiezingen();
    if (!items.length) {
      return { candidates: [], note: "Kon de verkiezingenlijst niet lezen van verkiezingsuitslagen.nl." };
    }

    // Overview is published newest-first; keep that order as the recency order.
    if (!raw) {
      return {
        code: items[0].code,
        candidates: items,
        note: `Geen verkiezing opgegeven; meest recente gebruikt (${items[0].naam}, ${items[0].datum}).`,
      };
    }

    const needle = normalizeName(raw);
    const prefix = raw.toUpperCase().slice(0, 2);
    const match =
      items.find((item) => normalizeName(item.naam) === needle) ??
      items.find((item) => normalizeName(item.naam).includes(needle)) ??
      (VERKIEZING_SOORTEN[prefix] ? items.find((item) => item.code.startsWith(prefix)) : undefined);

    if (!match) {
      return {
        candidates: items,
        note: `Verkiezing '${raw}' niet gevonden. Beschikbaar: ${items
          .map((item) => `${item.code} (${item.naam})`)
          .join(", ")}.`,
      };
    }

    return { code: match.code, candidates: items };
  }

  private mapStemregio(
    payload: DetailPayload,
    args: { code: string; niveau: GebiedUitslag["niveau"] },
  ): GebiedUitslag {
    const stemregio = payload.Stemregio ?? {};
    const gebiedId = str(stemregio.StemregioId);
    const partijen: PartijUitslag[] = (stemregio.Partij ?? []).map((party) => ({
      partij: str(party.Naam),
      aantalStemmen: parseDutchNumber(party.AantalStemmen),
      percentage: parseDutchNumber(party.Percentage),
      aantalZetels: parseDutchNumber(party.AantalZetels),
      partijUri: str(party.PartijUri),
    }));

    return {
      verkiezingCode: args.code,
      verkiezingNaam: str(payload.Info?.Name) || soortFromCode(args.code),
      verkiezingDatum: str(payload.Info?.Date) || dateFromCode(args.code),
      gebied: str(stemregio.Naam),
      gebiedId,
      niveau: args.niveau,
      kiesgerechtigden: parseDutchNumber(stemregio.Kiesgerechtigden),
      opkomst: parseDutchNumber(stemregio.Opkomst),
      opkomstPercentage: parseDutchNumber(stemregio.OpkomstPercentage),
      geldigeStemmen: parseDutchNumber(stemregio.AantalGeldigeStemmen),
      blancoStemmen: parseDutchNumber(stemregio.AantalBlancoStemmen),
      ongeldigeStemmen: parseDutchNumber(stemregio.AantalOngeldigeStemmen),
      partijen,
      url: `${BASE}/verkiezingen/detail/${args.code}`,
    };
  }

  async uitslag(args: { verkiezing?: string; gebied?: string }): Promise<{
    uitslag?: GebiedUitslag;
    verkiezingen: VerkiezingSummary[];
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const resolved = await this.resolveCode(args.verkiezing);
    if (!resolved.code) {
      return {
        verkiezingen: resolved.candidates,
        endpoint: OVERVIEW_URL,
        params: { verkiezing: args.verkiezing ?? "" },
        access_note: resolved.note,
      };
    }

    const code = resolved.code;
    const nationalUrl = `${BASE}/verkiezingen/detailJson/${encodeURIComponent(code)}`;
    const { data: national, meta } = await getJson<DetailPayload>(nationalUrl, {
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const notes = [resolved.note].filter(Boolean) as string[];
    const gebied = (args.gebied ?? "").trim();

    if (!gebied) {
      return {
        uitslag: this.mapStemregio(national, { code, niveau: "land" }),
        verkiezingen: resolved.candidates,
        endpoint: meta.url,
        params: { verkiezing: code },
        access_note: notes.join(" ") || undefined,
      };
    }

    const groups = national.Regios?.Regios ?? [];
    const needle = normalizeName(gebied);
    let matchId: string | undefined;
    let matchName = "";
    let niveau: GebiedUitslag["niveau"] = "gemeente";

    for (const group of groups) {
      const groupName = normalizeName(str(group.Name));
      for (const option of group.Options ?? []) {
        const value = str(option.Value);
        if (value === "-" || !value) continue;
        if (normalizeName(value) === needle) {
          matchId = str(option.Id);
          matchName = value;
          niveau = groupName.startsWith("provincie") ? "provincie" : "gemeente";
          break;
        }
      }
      if (matchId) break;
    }

    if (!matchId) {
      const available = groups
        .map((group) => str(group.Name))
        .filter(Boolean)
        .join(" / ");
      return {
        uitslag: this.mapStemregio(national, { code, niveau: "land" }),
        verkiezingen: resolved.candidates,
        endpoint: meta.url,
        params: { verkiezing: code, gebied },
        access_note: [
          ...notes,
          `Gebied '${gebied}' niet gevonden voor ${code} (beschikbare niveaus: ${available || "geen"}); landelijke uitslag teruggegeven.`,
        ].join(" "),
      };
    }

    const regionUrl = `${BASE}/verkiezingen/detailJson/${encodeURIComponent(code)}/${encodeURIComponent(matchId)}`;
    const { data: regional, meta: regionMeta } = await getJson<DetailPayload>(regionUrl, {
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const uitslag = this.mapStemregio(regional, { code, niveau });
    if (!uitslag.gebied) uitslag.gebied = matchName;

    return {
      uitslag,
      verkiezingen: resolved.candidates,
      endpoint: regionMeta.url,
      params: { verkiezing: code, gebied: matchName, stemregioId: matchId },
      access_note: notes.join(" ") || undefined,
    };
  }
}
