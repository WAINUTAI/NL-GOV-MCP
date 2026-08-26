import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";
import { placeKey, placeVariants } from "../utils/place-aliases.js";

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
  _index?: string;
  _source?: Record<string, unknown>;
}

interface ElasticResponse {
  hits?: {
    total?: { value?: number; relation?: string } | number;
    hits?: ElasticHit[];
  };
}

const ORI_BASE = "https://api.openraadsinformatie.nl/v1/elastic";
const ORI_SEARCH = `${ORI_BASE}/_search`;
const CONNECTOR = "ori";

/**
 * Open Raadsinformatie publishes one Elasticsearch index per municipality,
 * named `ori_<gemeente>_<timestamp>` (310 of them: `ori_delft_20250407054803`,
 * `ori_berg_en_dal_…`, `ori_alphen-chaam_…`).
 *
 * That index name is the only place the municipality is legible. The documents
 * themselves carry `has_organization_name`, but it holds a numeric organisation
 * id (1702970), not a name — which is why `organization` used to come back empty
 * on every record.
 *
 * The index is also how a search gets scoped: Elasticsearch accepts an index
 * pattern in the path, so a search under `ori_delft<star>` returns that
 * municipality and nothing else. Without it a search for "Delft" happily
 * returns a person called "van Delft" filed under Sluis.
 */
const INDEX_PREFIX = "ori_";

/** Municipality -> index slug, as ORI spells it: lowercase, spaces to underscores. */
export function gemeenteToIndexSlug(gemeente: string): string {
  return placeKey(gemeente).replace(/\s+/g, "_");
}

/** Municipality name back out of an index name, for the `organization` field. */
export function indexToGemeente(index: string | undefined): string {
  if (!index || !index.startsWith(INDEX_PREFIX)) return "";
  // Strip the prefix and the trailing ingest timestamp (`_20250407054803`).
  const withoutPrefix = index.slice(INDEX_PREFIX.length).replace(/_\d{8,}$/, "");
  if (!withoutPrefix) return "";
  return withoutPrefix
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toOriItem(hit: ElasticHit): OriItem {
  const source = (hit._source ?? {}) as Record<string, unknown>;
  const id = String(source["@id"] ?? source.id ?? hit._id ?? "");
  const title = String(source.name ?? source.title ?? source.onderwerp ?? "ORI item");
  const type = String(source["@type"] ?? source.type ?? "record");
  const publishedAt = String(source.datePublished ?? source.last_discussed_at ?? source.modified ?? "");

  const url = String(
    source.url ??
      source.same_as ??
      source.generated ??
      (id && id.startsWith("http") ? id : "https://www.openraadsinformatie.nl"),
  );

  // Keep only essential fields — full _source can be 100KB+ per hit
  const description = String(source.description ?? source.text ?? "").slice(0, 500);

  return {
    id,
    title,
    type,
    organization: indexToGemeente(hit._index),
    publishedAt,
    url,
    ...(description ? { description } : {}),
  };
}

export class OriSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: {
    query: string;
    rows: number;
    sort?: "relevance" | "date_newest";
    bestuurslaag?: string;
    gemeente?: string;
  }): Promise<{
    items: OriItem[];
    total: number | null;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const wantDateSort = args.sort === "date_newest";
    const baseQ = args.bestuurslaag ? `${args.query} ${args.bestuurslaag}` : args.query;

    // A municipality scopes the search to its own index; without one the search
    // runs across all 310 and the caller has to live with national noise.
    const gemeente = args.gemeente?.trim();
    const endpoints = gemeente ? this.indexEndpoints(gemeente) : [ORI_SEARCH];

    // Try with sort parameter first, then fall back to no-sort + client-side sort
    const queryVariants: Array<Record<string, string>> = [
      { q: baseQ, size: String(args.rows), sort: wantDateSort ? "datePublished:desc" : "_score:desc" },
      { q: baseQ, size: String(args.rows) }, // without sort (some ORI versions reject it)
    ];

    for (const query of queryVariants) {
      for (const endpoint of endpoints) {
        try {
          const { data, meta } = await getJson<ElasticResponse>(endpoint, {
            query,
            connector: CONNECTOR,
            timeoutMs: 20_000,
            retries: 1,
          });
          const hits = Array.isArray(data.hits?.hits) ? data.hits?.hits : [];
          let items = hits.map(toOriItem).filter((x) => x.id || x.title);

          if (items.length) {
            // Client-side date sort when server-side sort was unavailable
            if (wantDateSort && !query.sort) {
              items = [...items].sort((a, b) =>
                (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
              );
            }
            return {
              items,
              ...this.describeTotal(data),
              endpoint: meta.url,
              params: { ...query, ...(gemeente ? { gemeente } : {}) },
            };
          }
        } catch {
          // try next endpoint
        }
      }
    }

    return {
      items: [],
      total: 0,
      endpoint: endpoints[0],
      params: { q: baseQ, size: String(args.rows), ...(gemeente ? { gemeente } : {}) },
      access_note: gemeente
        ? `Geen ORI-resultaten voor '${args.query}' in ${gemeente}. Controleer de gemeentenaam of laat 'gemeente' weg voor een landelijke zoekopdracht.`
        : `Geen ORI-resultaten voor '${args.query}'. Probeer bredere trefwoorden, of geef 'gemeente' op om binnen één gemeente te zoeken.`,
    };
  }

  /**
   * Index patterns to try for a municipality, its everyday name first.
   *
   * ORI names its indices after the everyday name — Den Haag is `ori_den_haag`,
   * not `ori_s_gravenhage` — so the aliases have to be tried in both directions.
   */
  private indexEndpoints(gemeente: string): string[] {
    const slugs = placeVariants(gemeente)
      .map(gemeenteToIndexSlug)
      .filter(Boolean);
    const seen = new Set<string>();
    const endpoints: string[] = [];
    for (const slug of slugs) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      endpoints.push(`${ORI_BASE}/${INDEX_PREFIX}${slug}*/_search`);
    }
    return endpoints.length ? endpoints : [ORI_SEARCH];
  }

  /**
   * Elasticsearch caps its hit counter: `{"value":10000,"relation":"gte"}` means
   * "at least 10000", not "10000". Reporting the cap as an exact figure told
   * every caller the same wrong number, so a capped count is reported as unknown
   * with the floor spelled out in the note instead.
   */
  private describeTotal(data: ElasticResponse): { total: number | null; access_note?: string } {
    const raw = data.hits?.total;
    if (typeof raw === "number") return { total: raw };
    const value = Number(raw?.value);
    if (!Number.isFinite(value)) return { total: null };
    if (raw?.relation === "gte") {
      return {
        total: null,
        access_note: `Elasticsearch telt niet verder dan ${value} treffers; het werkelijke aantal ligt hoger. Verfijn de zoekterm of geef 'gemeente' op.`,
      };
    }
    return { total: value };
  }
}
