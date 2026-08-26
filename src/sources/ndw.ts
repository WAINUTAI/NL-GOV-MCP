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
            // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
            // consument "x van y" niet met een verzonnen y toont.
            total: null,
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

  /**
   * Nothing usable came back from the discovery pages.
   *
   * This used to answer with a synthesised record titled "NDW fallback voor
   * '<query>'". It carried a plausible url and date, so anything rendering
   * records without reading the note showed it as a real NDW item. An empty
   * result with an explanation is the honest shape, and the one the newer
   * connectors use.
   */
  fallback(args: { query: string; rows: number }) {
    return {
      items: [] as NdwItem[],
      total: 0,
      endpoint: `${NDW_DISCOVERY_PAGES[0]} (geen bruikbare respons)`,
      params: { q: args.query, rows: String(args.rows) },
      access_note: `De open NDW-pagina's leverden geen bruikbare items op voor '${args.query}'. NDW publiceert vooral bulk-datafeeds; probeer een bredere zoekterm of raadpleeg https://www.ndw.nu rechtstreeks.`,
    };
  }
}
