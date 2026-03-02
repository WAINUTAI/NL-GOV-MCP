import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

export class DuoSource {
  constructor(private readonly config: AppConfig) {}

  async datasetsCatalog(query: string, rows: number) {
    const endpoint = `${this.config.endpoints.duoDatasets}/api/3/action/package_search`;
    const params = { q: query, rows: String(rows) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const result = (data.result as Record<string, unknown> | undefined) ?? {};
    const items = (result.results as Array<Record<string, unknown>> | undefined) ?? [];
    const total = (result.count as number | undefined) ?? items.length;
    return { items, total, endpoint: meta.url, params };
  }

  async rioSearch(query: string, top: number) {
    const endpoint = `${this.config.endpoints.duoRio}/search`;
    const params = { q: query, limit: String(top) };

    const { data, meta } = await getText(endpoint, { query: params });

    // Some environments return an SPA HTML shell instead of direct JSON.
    // Try JSON first; otherwise return a helpful fallback list.
    const trimmed = data.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const items = (parsed.results as Array<Record<string, unknown>> | undefined) ??
          (Array.isArray((parsed as { items?: unknown[] }).items)
            ? ((parsed as { items: unknown[] }).items as Array<Record<string, unknown>>)
            : []);
        return { items: items.slice(0, top), endpoint: meta.url, params };
      } catch {
        // continue to fallback below
      }
    }

    const fallbackItems: Array<Record<string, unknown>> = [
      {
        id: "rio-api-home",
        name: "RIO API home",
        description: "RIO API returned HTML shell from this host; use linked docs/endpoints",
        url: this.config.endpoints.duoRio,
        query,
      },
      {
        id: "rio-overview",
        name: "DUO open data overview",
        url: "https://duo.nl/open_onderwijsdata/overzicht-open-data.jsp",
        query,
      },
      {
        id: "duo-datasets",
        name: "DUO datasets portal",
        url: "https://onderwijsdata.duo.nl/datasets",
        query,
      },
    ].slice(0, top);

    return { items: fallbackItems, endpoint: meta.url, params };
  }
}
