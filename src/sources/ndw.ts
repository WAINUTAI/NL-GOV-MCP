import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface NdwItem {
  id?: string;
  title?: string;
  description?: string;
  updated_at?: string;
  url?: string;
  [key: string]: unknown;
}

interface NdwResponse {
  results?: NdwItem[];
  total?: number;
}

const NDW_ENDPOINTS = [
  "https://api.ndw.nu/api/rest/static-road-data/metadata",
  "https://data.ndw.nu/api/3/action/package_search",
];

export class NdwSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const firstParams = { q: args.query, limit: String(args.rows) };
    try {
      const { data, meta } = await getJson<NdwResponse | Record<string, unknown>>(NDW_ENDPOINTS[0], { query: firstParams });
      const obj = data as Record<string, unknown>;
      const items = ((obj.results as NdwItem[] | undefined) ?? []) as NdwItem[];
      if (items.length) {
        return { items, total: Number(obj.total ?? items.length), endpoint: meta.url, params: firstParams };
      }
    } catch {
      // continue
    }

    const secondParams = { q: args.query, rows: String(args.rows) };
    try {
      const { data, meta } = await getJson<Record<string, unknown>>(NDW_ENDPOINTS[1], { query: secondParams });
      const result = (data.result as Record<string, unknown> | undefined) ?? {};
      const items = (result.results as NdwItem[] | undefined) ?? [];
      if (items.length) {
        return { items, total: Number(result.count ?? items.length), endpoint: meta.url, params: secondParams };
      }
    } catch {
      // continue
    }

    return this.fallback(args);
  }

  fallback(args: { query: string; rows: number }) {
    const fallback: NdwItem[] = [{
      id: `ndw-fallback-${args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: `NDW fallback voor '${args.query}'`,
      description: "Geen live NDW feedresponse beschikbaar in deze omgeving.",
      updated_at: "1970-01-01T00:00:00Z",
      url: "https://www.ndw.nu",
    }];

    return {
      items: fallback.slice(0, args.rows),
      total: fallback.length,
      endpoint: `${NDW_ENDPOINTS[0]} (fallback)`,
      params: { q: args.query, limit: String(args.rows) },
      access_note: "NDW publieke endpoint is instabiel/ontoegankelijk vanuit huidige runtime; fallbackrecord gebruikt.",
    };
  }
}
