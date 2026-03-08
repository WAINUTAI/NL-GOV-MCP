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

interface ElasticHit {
  _id?: string;
  _source?: Record<string, unknown>;
}

interface ElasticResponse {
  hits?: {
    total?: { value?: number } | number;
    hits?: ElasticHit[];
  };
}

const ORI_DISCOVERY_ENDPOINTS = [
  "https://api.openraadsinformatie.nl/v1/elastic/_search",
  "https://api.openraadsinformatie.nl/v1/elastic",
];

function toOriItem(hit: ElasticHit): OriItem {
  const source = (hit._source ?? {}) as Record<string, unknown>;
  const id = String(source["@id"] ?? source.id ?? hit._id ?? "");
  const title = String(source.name ?? source.title ?? source.onderwerp ?? "ORI item");
  const type = String(source["@type"] ?? source.type ?? "record");
  const organization = String(source.publisher ?? source.organisation ?? source.organization ?? "");
  const publishedAt = String(source.datePublished ?? source.last_discussed_at ?? source.modified ?? "");

  const url = String(
    source.url ??
      source.same_as ??
      source.generated ??
      (id && id.startsWith("http") ? id : "https://www.openraadsinformatie.nl"),
  );

  return {
    id,
    title,
    type,
    organization,
    publishedAt,
    url,
    raw: source,
  };
}

export class OriSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number; sort?: "relevance" | "date_newest"; bestuurslaag?: string }) {
    const wantDateSort = args.sort === "date_newest";
    const baseQ = args.bestuurslaag ? `${args.query} ${args.bestuurslaag}` : args.query;

    // Try with sort parameter first, then fall back to no-sort + client-side sort
    const queryVariants: Array<Record<string, string>> = [
      { q: baseQ, size: String(args.rows), sort: wantDateSort ? "datePublished:desc" : "_score:desc" },
      { q: baseQ, size: String(args.rows) }, // without sort (some ORI versions reject it)
    ];

    for (const query of queryVariants) {
      for (const endpoint of ORI_DISCOVERY_ENDPOINTS) {
        try {
          const { data, meta } = await getJson<ElasticResponse>(endpoint, { query, timeoutMs: 20_000, retries: 1 });
          const hits = Array.isArray(data.hits?.hits) ? data.hits?.hits : [];
          let items = hits.map(toOriItem).filter((x) => x.id || x.title);
          const totalRaw = data.hits?.total;
          const total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw?.value ?? items.length);

          if (items.length) {
            // Client-side date sort when server-side sort was unavailable
            if (wantDateSort && !query.sort) {
              items = [...items].sort((a, b) =>
                (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
              );
            }
            return {
              items,
              total,
              endpoint: meta.url,
              params: query,
            };
          }
        } catch {
          // try next endpoint
        }
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
      endpoint: `${ORI_DISCOVERY_ENDPOINTS[0]} (fallback)`,
      params: { q: args.query, limit: String(args.rows), ...(args.bestuurslaag ? { bestuurslaag: args.bestuurslaag } : {}) },
      access_note: "ORI endpoint discovery leverde geen bruikbare live resultaten; deterministische fallback gebruikt.",
    };
  }
}
