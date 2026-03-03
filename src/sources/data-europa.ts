import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface CkanPackageSearch {
  success?: boolean;
  result?: {
    count?: number;
    results?: Array<Record<string, unknown>>;
  };
}

export class DataEuropaSource {
  constructor(private readonly config: AppConfig) {}

  async datasetsSearch(args: { query: string; rows: number }) {
    const rows = Math.min(args.rows, this.config.limits.maxRows);
    const endpoint = "https://data.europa.eu/data/api/3/action/package_search";

    const { data, meta } = await getJson<CkanPackageSearch>(endpoint, {
      query: { q: args.query, rows },
      timeoutMs: 20_000,
      retries: 1,
    });

    const results = Array.isArray(data.result?.results) ? data.result?.results ?? [] : [];
    const items = results.slice(0, rows).map((x) => {
      const id = String(x.id ?? x.name ?? "dataset");
      const title = String(x.title ?? x.name ?? id);
      return {
        id,
        title,
        notes: String(x.notes ?? ""),
        organization: (x.organization as Record<string, unknown> | undefined)?.title,
        metadata_modified: String(x.metadata_modified ?? ""),
        source: "data-europa-ckan",
        url: `https://data.europa.eu/data/datasets/${id}`,
        raw: x,
      };
    });

    return {
      items,
      total: Number(data.result?.count ?? items.length),
      endpoint: meta.url,
      params: { q: args.query, rows: String(rows) },
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
      endpoint: "https://data.europa.eu/data/api/3/action/package_search (fallback)",
      params: { q: args.query, rows: String(args.rows) },
      access_note: "data.europa.eu CKAN endpoint was onbereikbaar; fallbackrecord gebruikt.",
    };
  }
}
