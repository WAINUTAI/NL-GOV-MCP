import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function matchesQuery(item: Record<string, unknown>, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const haystack = [
    normalizeText(item.title),
    normalizeText(item.introduction),
    normalizeText(item.content),
    normalizeText(item.canonical),
    normalizeText(item.type),
  ].join(" \n ");
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export class RijksoverheidSource {
  constructor(private readonly config: AppConfig) {}

  async search(query: string, top: number) {
    const endpoint = `${this.config.endpoints.rijksoverheid}/documents`;
    // Rijksoverheid open data supports rows/max 200; no reliable full-text param.
    // We fetch a larger slice and filter client-side for relevance.
    const fetchRows = Math.min(200, Math.max(top * 20, 50));
    const params: Record<string, string> = {
      rows: String(fetchRows),
      output: "json",
    };

    const { data, meta } = await getJson<unknown>(endpoint, { query: params });
    const rawItems = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const filtered = rawItems.filter((item) => matchesQuery(item, query));
    const items = filtered.slice(0, top);
    const total = filtered.length;

    return { items, total, endpoint: meta.url, params };
  }

  async dossiers(top: number) {
    const endpoint = `${this.config.endpoints.rijksoverheid}/documents`;
    const params = { rows: String(Math.min(top, 200)), output: "json" };
    const { data, meta } = await getJson<unknown>(endpoint, { query: params });
    const items = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>).slice(0, top)
      : [];
    return { items, endpoint: meta.url, params };
  }
}
