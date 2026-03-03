import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";

interface NdwItem {
  id?: string;
  title?: string;
  description?: string;
  updated_at?: string;
  source?: string;
  url?: string;
  [key: string]: unknown;
}

const NDW_DISCOVERY_PAGES = [
  "https://opendata.ndw.nu",
  "https://docs.ndw.nu/",
  "https://dexter.ndw.nu/opendata/",
];

function normalizeLinkToItem(link: string, query: string): NdwItem {
  const cleaned = link.replace(/["'<>]/g, "");
  const slug = cleaned.split("/").filter(Boolean).slice(-1)[0] ?? "ndw-item";
  return {
    id: `ndw-${slug.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title: slug.replace(/[-_]/g, " "),
    description: `NDW open data referentie gevonden via live discovery (${query})`,
    updated_at: new Date().toISOString(),
    source: cleaned.includes("docs.ndw.nu") ? "docs" : cleaned.includes("dexter.ndw.nu") ? "dexter" : "opendata",
    url: cleaned,
  };
}

export class NdwSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const queryLower = args.query.toLowerCase();

    for (const endpoint of NDW_DISCOVERY_PAGES) {
      try {
        const { data, meta } = await getText(endpoint, { timeoutMs: 15_000, retries: 1 });
        const links = Array.from(data.matchAll(/https:\/\/[^\s"'<>]+/g)).map((m) => m[0]);

        const filtered = links.filter((l) => {
          const x = l.toLowerCase();
          return x.includes(queryLower) || x.includes("opendata") || x.includes("data") || x.includes("api") || x.includes("verkeer") || x.includes("fiets");
        });

        const unique = Array.from(new Set(filtered)).slice(0, args.rows);
        const items = unique.map((link) => normalizeLinkToItem(link, args.query));

        if (items.length) {
          return {
            items,
            total: items.length,
            endpoint: meta.url,
            params: { q: args.query, rows: String(args.rows) },
          };
        }
      } catch {
        // next endpoint
      }
    }

    return this.fallback(args);
  }

  fallback(args: { query: string; rows: number }) {
    const fallback: NdwItem[] = [{
      id: `ndw-fallback-${args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: `NDW fallback voor '${args.query}'`,
      description: "Geen live NDW feedresponse beschikbaar in deze omgeving.",
      updated_at: "1970-01-01T00:00:00Z",
      source: "fallback",
      url: "https://www.ndw.nu",
    }];

    return {
      items: fallback.slice(0, args.rows),
      total: fallback.length,
      endpoint: `${NDW_DISCOVERY_PAGES[0]} (fallback)`,
      params: { q: args.query, rows: String(args.rows) },
      access_note: "NDW open pages leverden geen bruikbare items; fallbackrecord gebruikt.",
    };
  }
}
