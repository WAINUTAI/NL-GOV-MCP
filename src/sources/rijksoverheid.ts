import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

export class RijksoverheidSource {
  constructor(private readonly config: AppConfig) {}

  async search(query: string, top: number) {
    const endpoint = `${this.config.endpoints.rijksoverheid}/search`;
    const params: Record<string, string> = { rows: String(top), q: query };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const items = (data.results as Array<Record<string, unknown>> | undefined) ??
      (Array.isArray((data as { value?: unknown[] }).value)
        ? ((data as { value: unknown[] }).value as Array<Record<string, unknown>>)
        : []);
    const total = (data.total as number | undefined) ?? items.length;
    return { items, total, endpoint: meta.url, params };
  }

  async dossiers(top: number) {
    const endpoint = `${this.config.endpoints.rijksoverheid}/dossiers`;
    const params = { rows: String(top) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const items = (data.results as Array<Record<string, unknown>> | undefined) ?? [];
    return { items, endpoint: meta.url, params };
  }
}
