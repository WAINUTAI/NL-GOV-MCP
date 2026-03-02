import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

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
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const items = (data.results as Array<Record<string, unknown>> | undefined) ??
      (Array.isArray((data as { items?: unknown[] }).items) ? ((data as { items: unknown[] }).items as Array<Record<string, unknown>>) : []);
    return { items, endpoint: meta.url, params };
  }
}
