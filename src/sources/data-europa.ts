import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

// data.europa.eu migrated from CKAN to a custom Search API.
const SEARCH_ENDPOINT = "https://data.europa.eu/api/hub/search/search";

interface SearchResult {
  id?: string;
  title?: Record<string, string> | string;
  description?: Record<string, string> | string;
  catalog?: { title?: string; publisher?: { name?: string } };
  issued?: string;
  modified?: string;
  distributions?: Array<{ format?: { id?: string } }>;
  [key: string]: unknown;
}

interface SearchResponse {
  result?: {
    count?: number;
    results?: SearchResult[];
  };
}

function extractLocalized(v: Record<string, string> | string | undefined): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v.en ?? v.nl ?? v.de ?? v.fr ?? Object.values(v)[0] ?? "";
}

export class DataEuropaSource {
  constructor(private readonly config: AppConfig) {}

  async datasetsSearch(args: { query: string; rows: number }) {
    const rows = Math.min(args.rows, this.config.limits.maxRows);

    const { data, meta } = await getJson<SearchResponse>(SEARCH_ENDPOINT, {
      query: { q: args.query, limit: rows, page: 0 },
      timeoutMs: 20_000,
      retries: 1,
    });

    const results = Array.isArray(data.result?.results) ? data.result?.results ?? [] : [];
    const items = results.slice(0, rows).map((x) => {
      const id = String(x.id ?? "dataset");
      const title = extractLocalized(x.title) || id;
      const description = extractLocalized(x.description);
      const publisher = x.catalog?.publisher?.name ?? x.catalog?.title ?? "";
      return {
        id,
        title,
        notes: description,
        organization: publisher,
        metadata_modified: String(x.modified ?? x.issued ?? ""),
        source: "data-europa",
        url: `https://data.europa.eu/data/datasets/${id}`,
        raw: x,
      };
    });

    return {
      items,
      total: Number(data.result?.count ?? items.length),
      endpoint: meta.url,
      params: { q: args.query, limit: String(rows) },
      ...(items.length ? {} : { access_note: "Data Europa endpoint bereikbaar, maar geen hits voor query." }),
    };
  }

  fallback(args: { query: string; rows: number }) {
    const slug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      items: [
        {
          id: `data-europa-fallback-${slug}`,
          title: `data.europa.eu fallback voor '${args.query}'`,
          notes: "Deterministische fallbackrecord",
          source: "fallback",
          metadata_modified: "1970-01-01T00:00:00Z",
          url: "https://data.europa.eu/data",
        },
      ].slice(0, args.rows),
      total: 1,
      endpoint: `${SEARCH_ENDPOINT} (fallback)`,
      params: { q: args.query, limit: String(args.rows) },
      access_note: "data.europa.eu search endpoint was onbereikbaar; fallbackrecord gebruikt.",
    };
  }
}
