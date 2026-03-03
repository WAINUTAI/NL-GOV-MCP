import { randomUUID } from "node:crypto";

import type { AppConfig } from "../types.js";
import { postJson } from "../utils/http.js";

interface RechtspraakItem {
  id?: string;
  title?: string;
  summary?: string;
  updated?: string;
  link?: string;
  ecli?: string;
  [key: string]: unknown;
}

interface RechtspraakApiResult {
  Tekstfragment?: string;
  Titel?: string;
  TitelEmphasis?: string;
  InterneUrl?: string;
  DeeplinkUrl?: string;
  Uitspraakdatum?: string;
  Publicatiedatum?: string;
  PublicatiedatumDate?: string;
  Rechtsgebieden?: string[];
  Proceduresoorten?: string[];
  [key: string]: unknown;
}

interface RechtspraakFacetItem {
  Identifier?: string;
  NodeType?: string | number;
  Count?: number;
  level?: number;
}

interface RechtspraakApiResponse {
  Results?: RechtspraakApiResult[];
  ResultCount?: number;
  FacetCounts?: {
    DatumPublicatie?: RechtspraakFacetItem[];
    DatumUitspraak?: RechtspraakFacetItem[];
    [key: string]: unknown;
  };
}

const RECHTSPRAAK_SEARCH_PAGE = "https://uitspraken.rechtspraak.nl/resultaat";
const RECHTSPRAAK_SEARCH_API = "https://uitspraken.rechtspraak.nl/api/zoek";
const RECHTSPRAAK_CONTENT = "https://data.rechtspraak.nl/uitspraken/content";

function extractEcli(value: string): string | undefined {
  const m = value.match(/ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9.:-]+/i);
  return m ? m[0].toUpperCase() : undefined;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function correlationId32(): string {
  return randomUUID().replace(/-/g, "");
}

function resolveSearchTerm(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function cleanupQueryAfterFilter(input: string): string {
  return input
    .replace(/\b(publicatie|publicaties|publicatiedatum|datum|geleden|tot|binnen|laatste|afgelopen|maand|week|jaar|dit|vorig|heel|qua|en|de|het|op)\b/gi, " ")
    .replace(/\b(pd[1-4]|ud[1-4]|2025|2026)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePublicatieFilter(query: string):
  | { identifier: "BinnenEenMaand" | "DitJaar" | "BinnenEenWeek" | "VorigJaar"; cleanedQuery: string; reason: string }
  | undefined {
  const raw = query;

  const candidates: Array<{ regex: RegExp; identifier: "BinnenEenMaand" | "DitJaar" | "BinnenEenWeek" | "VorigJaar"; reason: string }> = [
    {
      regex: /(publicatie\s*:\s*pd2|tot\s*1\s*maand\s*geleden|binnen\s*een\s*maand|laatste\s*maand|afgelopen\s*maand|tot\s*1\s*maand)/i,
      identifier: "BinnenEenMaand",
      reason: "publicatie <= 1 maand",
    },
    {
      regex: /(publicatie\s*:\s*pd3|\bdit\s*jaar\b|\b2026\b|heel\s*2026)/i,
      identifier: "DitJaar",
      reason: "publicatie dit jaar",
    },
    {
      regex: /(publicatie\s*:\s*pd1|tot\s*7\s*dagen\s*geleden|binnen\s*een\s*week|laatste\s*week)/i,
      identifier: "BinnenEenWeek",
      reason: "publicatie <= 7 dagen",
    },
    {
      regex: /(publicatie\s*:\s*pd4|vorig\s*jaar|\b2025\b)/i,
      identifier: "VorigJaar",
      reason: "publicatie vorig jaar",
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.regex.test(raw)) continue;
    const removed = raw.replace(candidate.regex, " ").replace(/\s+/g, " ").trim();
    const cleaned = cleanupQueryAfterFilter(removed);
    return {
      identifier: candidate.identifier,
      cleanedQuery: cleaned || cleanupQueryAfterFilter(raw) || raw,
      reason: candidate.reason,
    };
  }

  return undefined;
}

function mapResult(item: RechtspraakApiResult): RechtspraakItem {
  const emphasis = String(item.TitelEmphasis ?? "").trim();
  const title = String(item.Titel ?? "").trim();
  const snippet = String(item.Tekstfragment ?? "").trim();
  const url = String(item.InterneUrl ?? item.DeeplinkUrl ?? "").trim();
  const ecli =
    extractEcli(`${emphasis} ${url} ${title}`) ??
    undefined;

  return {
    id: ecli ?? (url || `${RECHTSPRAAK_SEARCH_PAGE}`),
    title: [emphasis, title].filter(Boolean).join(", ") || ecli || "Rechtspraak uitspraak",
    summary: snippet,
    updated: toIsoDate(String(item.PublicatiedatumDate ?? item.Publicatiedatum ?? "")),
    link: url || (ecli ? `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(ecli)}` : RECHTSPRAAK_SEARCH_PAGE),
    ecli,
    uitspraakdatum: item.Uitspraakdatum,
    publicatiedatum: item.Publicatiedatum,
    rechtsgebieden: toArray(item.Rechtsgebieden),
    procedures: toArray(item.Proceduresoorten),
  };
}

function noMatchItem(query: string): RechtspraakItem {
  const explicitEcli = extractEcli(query);
  const fallbackLink = explicitEcli
    ? `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(explicitEcli)}`
    : `${RECHTSPRAAK_SEARCH_PAGE}?zoekterm=${encodeURIComponent(query)}&inhoudsindicatie=zt0&sort=Relevance&publicatiestatus=ps1`;

  return {
    id:
      explicitEcli ??
      `rechtspraak-no-match-${query.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "query"}`,
    title: explicitEcli
      ? `Fallback uitspraak voor ${explicitEcli}`
      : `Geen passende Rechtspraak-uitspraak gevonden voor '${query}'`,
    summary: explicitEcli
      ? "Geen live resultaat; expliciete ECLI als deterministic fallback gebruikt."
      : "De Rechtspraak-zoekservice gaf geen inhoudelijke ECLI-match voor deze zoekterm.",
    updated: new Date(0).toISOString(),
    link: fallbackLink,
    ecli: explicitEcli,
    mode: "deterministic-no-match",
  };
}

function facetCount(
  facets: RechtspraakApiResponse["FacetCounts"] | undefined,
  facetName: "DatumPublicatie" | "DatumUitspraak",
  identifier: string,
): number | undefined {
  const group = toArray(facets?.[facetName]);
  const match = group.find((x) => String(x.Identifier ?? "") === identifier);
  const count = match?.Count;
  return typeof count === "number" ? count : undefined;
}

export class RechtspraakSource {
  constructor(private readonly config: AppConfig) {}

  async searchEcli(args: { query: string; rows: number }) {
    const filter = resolvePublicatieFilter(args.query);
    const searchTerm = resolveSearchTerm(filter?.cleanedQuery ?? args.query);

    const payload = {
      StartRow: 0,
      PageSize: Math.min(Math.max(args.rows, 1), 50),
      ShouldReturnHighlights: true,
      ShouldCountFacets: true,
      SortOrder: "Relevance",
      SearchTerms: [{ Term: searchTerm, Field: "AlleVelden" }],
      Contentsoorten: [] as Array<Record<string, unknown>>,
      Rechtsgebieden: [] as Array<Record<string, unknown>>,
      Instanties: [] as Array<Record<string, unknown>>,
      DatumPublicatie: filter
        ? [
            {
              NodeType: 4,
              Identifier: filter.identifier,
              level: 0,
            },
          ]
        : ([] as Array<Record<string, unknown>>),
      DatumUitspraak: [] as Array<Record<string, unknown>>,
      Advanced: {
        PublicatieStatus: "AlleenGepubliceerd",
      },
      CorrelationId: correlationId32(),
      Proceduresoorten: [] as Array<Record<string, unknown>>,
    };

    const referer = `${RECHTSPRAAK_SEARCH_PAGE}?zoekterm=${encodeURIComponent(searchTerm)}&inhoudsindicatie=zt0&sort=Relevance&publicatiestatus=ps1`;

    const { data, meta } = await postJson<RechtspraakApiResponse>(
      RECHTSPRAAK_SEARCH_API,
      payload,
      {
        timeoutMs: 20_000,
        retries: 2,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Referer: referer,
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          __RequestVerificationToken: "ELEMENT_NOT_FOUND",
        },
      },
    );

    const items = toArray(data.Results)
      .map(mapResult)
      .filter((x) => Boolean(x.ecli))
      .slice(0, args.rows);

    const total =
      typeof data.ResultCount === "number" ? data.ResultCount : items.length;

    const accessNotes: string[] = [];
    if (filter) {
      const publicatieCount = facetCount(
        data.FacetCounts,
        "DatumPublicatie",
        filter.identifier,
      );
      accessNotes.push(
        publicatieCount === undefined
          ? `Filter actief: ${filter.reason}.`
          : `Filter actief: ${filter.reason} (facetcount=${publicatieCount}).`,
      );
    }

    const monthCount = facetCount(data.FacetCounts, "DatumPublicatie", "BinnenEenMaand");
    const yearCount = facetCount(data.FacetCounts, "DatumPublicatie", "DitJaar");
    if (monthCount !== undefined || yearCount !== undefined) {
      accessNotes.push(
        `Facetcontrole publicatiedatum: BinnenEenMaand=${monthCount ?? "n/a"}, DitJaar=${yearCount ?? "n/a"}.`,
      );
    }

    if (!items.length) {
      return {
        items: [noMatchItem(searchTerm)].slice(0, args.rows),
        total: 1,
        endpoint: meta.url,
        params: {
          term: searchTerm,
          rows: String(args.rows),
          ...(filter ? { publicatieFilter: filter.identifier } : {}),
        },
        access_note:
          accessNotes.join(" ") ||
          "Geen passende ECLI-match gevonden voor deze zoekterm.",
      };
    }

    return {
      items,
      total,
      endpoint: meta.url,
      params: {
        term: searchTerm,
        rows: String(args.rows),
        ...(filter ? { publicatieFilter: filter.identifier } : {}),
      },
      ...(accessNotes.length ? { access_note: accessNotes.join(" ") } : {}),
    };
  }

  fallback(args: { query: string; rows: number }) {
    const item = noMatchItem(args.query);
    return {
      items: [item].slice(0, args.rows),
      total: 1,
      endpoint: `${RECHTSPRAAK_SEARCH_API} (fallback)`,
      params: {
        term: args.query,
        rows: String(args.rows),
        mode: "deterministic-fallback",
      },
      access_note:
        "Rechtspraak zoekservice tijdelijk niet bereikbaar; no-match fallbackrecord gebruikt.",
    };
  }
}
