import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

interface RIVMItem {
  id: string;
  title: string;
  description?: string;
  type?: string;
  url: string;
  source: string;
  updated_at?: string;
  [key: string]: unknown;
}

interface CkanSearchResponse {
  success?: boolean;
  result?: {
    count?: number;
    results?: Array<Record<string, unknown>>;
  };
}

const RIVM_DISCOVERY_ENDPOINTS = [
  "https://www.rivm.nl/" + "api/","https://data.rivm.nl/api/3/action/package_search",
  "https://www.rivm.nl/onderwerpen/monitoring-en-databronnen",
] as const;

function scoreRivmItem(item: Record<string, unknown>, query: string): number {
  const q = query.toLowerCase();
  const title = String(item.title ?? item.name ?? "").toLowerCase();
  const notes = String(item.notes ?? item.description ?? "").toLowerCase();
  const tags = Array.isArray(item.tags) ? item.tags.map((x) => String((x as Record<string, unknown>).name ?? x).toLowerCase()).join(" ") : "";
  const hay = `${title} ${notes} ${tags}`;
  let score = 0;
  for (const token of q.split(/\s+/).filter(Boolean)) if (hay.includes(token)) score += 2;
  if (title.includes(q)) score += 4;
  return score;
}

function normalizeCkan(item: Record<string, unknown>): RIVMItem {
  const id = String(item.id ?? item.name ?? "rivm-item");
  const extras = Array.isArray(item.extras) ? item.extras : [];
  const homepage = extras.find((x) => String((x as Record<string, unknown>).key ?? "") === "landing_page") as Record<string, unknown> | undefined;
  return {
    id,
    title: String(item.title ?? item.name ?? id),
    description: String(item.notes ?? item.description ?? ""),
    type: "dataset",
    url: String(homepage?.value ?? item.url ?? `https://data.rivm.nl/dataset/${id}`),
    source: "rivm-ckan",
    updated_at: String(item.metadata_modified ?? item.metadata_created ?? ""),
    raw: item,
  };
}

function normalizeLink(url: string, query: string): RIVMItem {
  const clean = url.replace(/["'<>]/g, "");
  const slug = clean.split("/").filter(Boolean).slice(-1)[0] ?? "item";
  return {
    id: `rivm-link-${slug.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title: slug.replace(/[-_]/g, " "),
    description: `RIVM discovery-link voor '${query}'`,
    type: "page",
    url: clean,
    source: "rivm-web",
  };
}

export class RivmSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const rows = Math.min(args.rows, this.config.limits.maxRows);

    // Prefer structured CKAN if available.
    try {
      const { data, meta } = await getJson<CkanSearchResponse>(RIVM_DISCOVERY_ENDPOINTS[1], {
        query: { q: args.query, rows },
        timeoutMs: 15_000,
        retries: 1,
      });
      const results = Array.isArray(data.result?.results) ? data.result?.results ?? [] : [];
      const sorted = [...results].sort((a, b) => scoreRivmItem(b, args.query) - scoreRivmItem(a, args.query));
      const items = sorted.slice(0, rows).map((x) => normalizeCkan(x));
      if (items.length) {
        return {
          items,
          total: Number(data.result?.count ?? items.length),
          endpoint: meta.url,
          params: { q: args.query, rows: String(rows) },
        };
      }
    } catch {
      // continue to link discovery
    }

    for (const endpoint of [RIVM_DISCOVERY_ENDPOINTS[0], RIVM_DISCOVERY_ENDPOINTS[2]]) {
      try {
        const { data, meta } = await getText(endpoint, { timeoutMs: 12_000, retries: 1 });
        const links = Array.from(data.matchAll(/https:\/\/[^\s"'<>]+/g)).map((m) => m[0]);
        const filtered = links.filter((l) => {
          const x = l.toLowerCase();
          const q = args.query.toLowerCase();
          return x.includes(q) || x.includes("data") || x.includes("monitor") || x.includes("atlas") || x.includes("api");
        });
        const unique = Array.from(new Set(filtered)).slice(0, rows);
        if (unique.length) {
          return {
            items: unique.map((x) => normalizeLink(x, args.query)),
            total: unique.length,
            endpoint: meta.url,
            params: { q: args.query, rows: String(rows) },
          };
        }
      } catch {
        // try next
      }
    }

    return this.fallback({ query: args.query, rows });
  }

  fallback(args: { query: string; rows: number }) {
    const qSlug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const items: RIVMItem[] = [
      {
        id: `rivm-fallback-${qSlug}`,
        title: `RIVM fallback discovery voor '${args.query}'`,
        description: "Live RIVM discovery endpoint gaf geen bruikbare response; deterministische fallbackrecord.",
        type: "fallback",
        url: "https://www.rivm.nl",
        source: "fallback",
        updated_at: "1970-01-01T00:00:00Z",
      },
    ];

    return {
      items: items.slice(0, args.rows),
      total: items.length,
      endpoint: `${RIVM_DISCOVERY_ENDPOINTS[1]} (fallback)`,
      params: { q: args.query, rows: String(args.rows) },
      access_note: "RIVM endpoints waren onbereikbaar/instabiel; fallbackrecord gebruikt.",
    };
  }
}
