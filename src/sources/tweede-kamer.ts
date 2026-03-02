import { getJson } from "../utils/http.js";
import type { AppConfig } from "../types.js";

export class TweedeKamerSource {
  constructor(private readonly config: AppConfig) {}

  async searchDocuments(query: string, top: number) {
    const endpoint = `${this.config.endpoints.tweedeKamer}/Document`;
    const params: Record<string, string> = { $top: String(top), $orderby: "Datum desc" };
    if (query) {
      const q = query.replace(/'/g, "''");
      params.$filter = `contains(Titel,'${q}') or contains(Onderwerp,'${q}')`;
    }
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const items = Array.isArray((data as { value?: unknown[] }).value)
      ? ((data as { value: unknown[] }).value as Array<Record<string, unknown>>)
      : [];
    return { items, endpoint: meta.url, params };
  }

  async searchKamerstukken(query: string, top: number) {
    const endpoint = `${this.config.endpoints.tweedeKamer}/Zaak`;
    const params: Record<string, string> = { $top: String(top), $orderby: "GewijzigdOp desc" };
    if (query) {
      const q = query.replace(/'/g, "''");
      params.$filter = `contains(Titel,'${q}') or contains(Onderwerp,'${q}')`;
    }
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const items = Array.isArray((data as { value?: unknown[] }).value)
      ? ((data as { value: unknown[] }).value as Array<Record<string, unknown>>)
      : [];
    return { items, endpoint: meta.url, params };
  }
}
