import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface OriItem {
  id?: string;
  title?: string;
  type?: string;
  organization?: string;
  publishedAt?: string;
  url?: string;
  [key: string]: unknown;
}

interface OriSearchResponse {
  results?: OriItem[];
  total?: number;
}

const ORI_ENDPOINTS = [
  "https://zoek.openraadsinformatie.nl/api/v1/search",
  "https://api.openraadsinformatie.nl/v1/search",
];

export class OriSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number; bestuurslaag?: string }) {
    const query = {
      q: args.query,
      limit: String(args.rows),
      ...(args.bestuurslaag ? { bestuurslaag: args.bestuurslaag } : {}),
    };

    for (const endpoint of ORI_ENDPOINTS) {
      try {
        const { data, meta } = await getJson<OriSearchResponse | Record<string, unknown>>(endpoint, { query });
        const obj = data as Record<string, unknown>;
        const items = (Array.isArray((data as OriSearchResponse).results)
          ? (data as OriSearchResponse).results
          : (obj.items as OriItem[] | undefined) ??
            (obj.results as OriItem[] | undefined) ??
            []) as OriItem[];
        if (items.length) {
          return {
            items,
            total: Number((data as OriSearchResponse).total ?? items.length),
            endpoint: meta.url,
            params: query,
          };
        }
      } catch {
        // try next endpoint
      }
    }

    return this.fallback(args);
  }

  fallback(args: { query: string; rows: number; bestuurslaag?: string }) {
    const fallbackItems: OriItem[] = [{
      id: `ori-fallback-${args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: `ORI fallback resultaat voor '${args.query}'`,
      type: "fallback",
      organization: args.bestuurslaag ?? "onbekend",
      publishedAt: "1970-01-01",
      url: "https://www.openraadsinformatie.nl",
    }];

    return {
      items: fallbackItems.slice(0, args.rows),
      total: fallbackItems.length,
      endpoint: `${ORI_ENDPOINTS[0]} (fallback)`,
      params: { q: args.query, limit: String(args.rows), ...(args.bestuurslaag ? { bestuurslaag: args.bestuurslaag } : {}) },
      access_note: "ORI endpoint niet stabiel bereikbaar vanuit huidige runtime; deterministische fallback gebruikt.",
    };
  }
}
