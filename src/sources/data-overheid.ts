import { getJson } from "../utils/http.js";
import type { AppConfig } from "../types.js";
import { appCache, makeCacheKey } from "../cache.js";

interface CkanResource {
  id: string;
  name?: string;
  format?: string;
  url?: string;
  created?: string;
  last_modified?: string;
}

interface CkanDataset {
  id: string;
  title?: string;
  notes?: string;
  metadata_modified?: string;
  organization?: { title?: string; name?: string };
  groups?: Array<{ title?: string; name?: string }>;
  license_title?: string;
  resources?: CkanResource[];
}

interface CkanSearchResponse {
  success: boolean;
  result: {
    count: number;
    results: CkanDataset[];
  };
}

interface CkanShowResponse {
  success: boolean;
  result: CkanDataset;
}

interface CkanListResponse {
  success: boolean;
  result: string[] | Array<{ name?: string; title?: string }>;
}

/** One entry of the Overheid.nl beleidsagenda taxonomy waardelijst. */
interface TaxonomyEntry {
  labels?: { "nl-NL"?: string; "en-US"?: string };
  parent?: string;
}

/** A theme surfaced by `themes()`; keeps `title`/`name` for the tool layer. */
interface ThemeItem {
  title: string;
  name: string;
  name_en: string;
  uri: string;
  parent: string;
  level: "main" | "sub";
  // Index signature so the tool layer can treat an item as Record<string, unknown>.
  [key: string]: unknown;
}

/**
 * Canonical, keyless source of data.overheid.nl themes. The CKAN `group_list`
 * and `theme` facet are both empty, so we read the Overheid.nl taxonomy
 * beleidsagenda waardelijst instead (a static vocabulary).
 */
const TAXONOMY_WAARDELIJST_URL =
  "https://waardelijsten.dcat-ap-donl.nl/overheid_taxonomiebeleidsagenda.json";

export class DataOverheidSource {
  constructor(private readonly config: AppConfig) {}

  async datasetsSearch(args: {
    query: string;
    rows: number;
    sort?: "relevance" | "date_newest";
    organization?: string;
    theme?: string;
  }): Promise<{ items: CkanDataset[]; total: number; endpoint: string; query: Record<string, string> }> {
    const queryParams: Record<string, string> = {
      q: args.query,
      rows: String(args.rows),
      ...(args.sort === "date_newest" ? { sort: "metadata_modified desc" } : {}),
    };

    const fqParts: string[] = [];
    if (args.organization) fqParts.push(`organization:${args.organization}`);
    if (args.theme) fqParts.push(`groups:${args.theme}`);
    if (fqParts.length) queryParams.fq = fqParts.join(" AND ");

    const endpoint = `${this.config.endpoints.dataOverheid}/package_search`;

    const cacheKey = makeCacheKey("dataOverheid:search", queryParams);
    const cached = appCache.get<{ items: CkanDataset[]; total: number; endpoint: string; query: Record<string, string> }>(cacheKey);
    if (cached) return cached;

    const { data, meta } = await getJson<CkanSearchResponse>(endpoint, {
      query: queryParams,
    });

    const result = {
      items: data.result?.results ?? [],
      total: data.result?.count ?? 0,
      endpoint: meta.url,
      query: queryParams,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.dataOverheidDatasetList);
    return result;
  }

  async datasetsGet(id: string): Promise<{ item: CkanDataset; endpoint: string; query: Record<string, string> }> {
    const query = { id };
    const endpoint = `${this.config.endpoints.dataOverheid}/package_show`;

    const cacheKey = makeCacheKey("dataOverheid:get", query);
    const cached = appCache.get<{ item: CkanDataset; endpoint: string; query: Record<string, string> }>(cacheKey);
    if (cached) return cached;

    const { data, meta } = await getJson<CkanShowResponse>(endpoint, { query });
    const result = {
      item: data.result,
      endpoint: meta.url,
      query,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.dataOverheidDatasetList);
    return result;
  }

  async organizations(): Promise<{ items: Array<{ name?: string; title?: string }>; endpoint: string }> {
    const endpoint = `${this.config.endpoints.dataOverheid}/organization_list`;
    const cacheKey = "dataOverheid:organizations";
    const cached = appCache.get<{ items: Array<{ name?: string; title?: string }>; endpoint: string }>(cacheKey);
    if (cached) return cached;

    const { data, meta } = await getJson<CkanListResponse>(endpoint, {
      query: { all_fields: true, limit: 5000 },
    });

    const raw = data.result ?? [];
    const items = raw.map((x) => (typeof x === "string" ? { name: x, title: x } : x));
    const result = { items, endpoint: meta.url };
    appCache.set(cacheKey, result, this.config.cacheTtlMs.dataOverheidDatasetList);
    return result;
  }

  async themes(): Promise<{ items: ThemeItem[]; endpoint: string }> {
    const { data, meta } = await getJson<Record<string, TaxonomyEntry>>(
      TAXONOMY_WAARDELIJST_URL,
      {
        connector: "data_overheid",
        // Static vocabulary — cache for a full day.
        cacheTtlMs: 24 * 60 * 60 * 1000,
      },
    );

    const entries = Object.entries(data ?? {});
    const labelOf = (uri: string): string => data?.[uri]?.labels?.["nl-NL"] ?? "";
    const uriLeaf = (uri: string): string => {
      const parts = uri.split(/[/#]/).filter(Boolean);
      return parts[parts.length - 1] ?? uri;
    };

    const items: ThemeItem[] = entries.map(([uri, entry]) => {
      const nl = entry?.labels?.["nl-NL"];
      const en = entry?.labels?.["en-US"];
      return {
        title: nl ?? uriLeaf(uri),
        name: nl ?? "",
        name_en: en ?? "",
        uri,
        parent: entry?.parent ? labelOf(entry.parent) : "",
        level: entry?.parent ? "sub" : "main",
      };
    });

    // Main themes first, then sub-themes; each group alphabetical (nl) by title.
    items.sort((a, b) => {
      if (a.level !== b.level) return a.level === "main" ? -1 : 1;
      return a.title.localeCompare(b.title, "nl");
    });

    return { items, endpoint: meta.url };
  }
}
