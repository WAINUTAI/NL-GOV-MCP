import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

export class RijksbegrotingSource {
  constructor(private readonly config: AppConfig) {}

  async search(query: string, top: number) {
    const endpoint = `${this.config.endpoints.rijksbegroting}/api/3/action/package_search`;
    const params = { q: query, rows: String(top) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const result = (data.result as Record<string, unknown> | undefined) ?? {};
    const items = (result.results as Array<Record<string, unknown>> | undefined) ?? [];
    const total = (result.count as number | undefined) ?? items.length;
    return { items, total, endpoint: meta.url, params };
  }
}
