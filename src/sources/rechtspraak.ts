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

type RechtspraakSortOrder =
  | "Relevance"
  | "PublicatieDatumDesc"
  | "UitspraakDatumDesc"
  | "UitspraakDatumAsc";

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

  async searchEcli(args: {
    query: string;
    rows: number;
    sort?: "relevance" | "date_newest" | "ruling_newest";
    date_filter?: "week" | "month" | "year" | "last_year";
  }) {
    // Map structured parameters to API values
    const sortOrder: RechtspraakSortOrder =
      args.sort === "date_newest" ? "PublicatieDatumDesc"
      : args.sort === "ruling_newest" ? "UitspraakDatumDesc"
      : "Relevance";

    const filterMap: Record<string, "BinnenEenWeek" | "BinnenEenMaand" | "DitJaar" | "VorigJaar"> = {
      week: "BinnenEenWeek",
      month: "BinnenEenMaand",
      year: "DitJaar",
      last_year: "VorigJaar",
    };
    const filterIdentifier = args.date_filter ? filterMap[args.date_filter] : undefined;

    const searchTerm = resolveSearchTerm(args.query);

    const payload = {
      StartRow: 0,
      PageSize: Math.min(Math.max(args.rows, 1), 50),
      ShouldReturnHighlights: true,
      ShouldCountFacets: true,
      SortOrder: sortOrder,
      SearchTerms: [{ Term: searchTerm, Field: "AlleVelden" }],
      Contentsoorten: [] as Array<Record<string, unknown>>,
      Rechtsgebieden: [] as Array<Record<string, unknown>>,
      Instanties: [] as Array<Record<string, unknown>>,
      DatumPublicatie: filterIdentifier
        ? [
            {
              NodeType: 4,
              Identifier: filterIdentifier,
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

    const referer = `${RECHTSPRAAK_SEARCH_PAGE}?zoekterm=${encodeURIComponent(searchTerm)}&inhoudsindicatie=zt0&sort=${encodeURIComponent(sortOrder)}&publicatiestatus=ps1`;

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
    if (filterIdentifier) {
      const publicatieCount = facetCount(
        data.FacetCounts,
        "DatumPublicatie",
        filterIdentifier,
      );
      accessNotes.push(
        publicatieCount === undefined
          ? `Filter actief: ${filterIdentifier}.`
          : `Filter actief: ${filterIdentifier} (facetcount=${publicatieCount}).`,
      );
    }
    if (sortOrder !== "Relevance") {
      accessNotes.push(`Sortering: ${sortOrder}.`);
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
          sortOrder,
          ...(filterIdentifier ? { publicatieFilter: filterIdentifier } : {}),
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
        sortOrder,
        ...(filterIdentifier ? { publicatieFilter: filterIdentifier } : {}),
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
