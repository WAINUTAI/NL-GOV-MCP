import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";

function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return slug;
  }
}

export class RijksbegrotingSource {
  constructor(private readonly config: AppConfig) {}

  private async openDataIndex() {
    const endpoint = `${this.config.endpoints.rijksbegroting}/api`;
    const params: Record<string, string> = {};

    const { data, meta } = await getText(endpoint, { query: params });

    const matches = new Set<string>();
    const regex = /open-data\/[A-Za-z0-9%\-_.()]+/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(data)) !== null) {
      matches.add(m[0]);
    }

    const items = Array.from(matches).map((path) => {
      const slug = path.split("/").pop() ?? path;
      return {
        id: slug,
        name: decodeSlug(slug),
        url: `https://www.rijksfinancien.nl/${path}`,
        source: "rijksbegroting-open-data-index",
      } as Record<string, unknown>;
    });

    return { items, endpoint: meta.url, params };
  }

  async search(query: string, top: number) {
    const index = await this.openDataIndex();

    const filteredItems = index.items.filter((item) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      const hay = `${String(item.name ?? "")} ${String(item.id ?? "")}`.toLowerCase();
      return q
        .split(/\s+/)
        .filter(Boolean)
        .every((term) => hay.includes(term));
    });

    const items = (filteredItems.length ? filteredItems : index.items).slice(0, top);

    return {
      items,
      total: filteredItems.length,
      endpoint: index.endpoint,
      params: index.params,
    };
  }

  async getChapter(year: number, chapter: string) {
    const index = await this.openDataIndex();
    const query = `${year} ${chapter}`.trim().toLowerCase();

    const filtered = index.items.filter((item) => {
      const hay = `${String(item.name ?? "")} ${String(item.id ?? "")}`.toLowerCase();
      return query
        .split(/\s+/)
        .filter(Boolean)
        .every((term) => hay.includes(term));
    });

    const items = (filtered.length ? filtered : index.items.slice(0, 10)).map((item) => ({
      ...item,
      requested_year: year,
      requested_chapter: chapter,
    }));

    return {
      items,
      endpoint: index.endpoint,
      params: {
        ...index.params,
        year: String(year),
        chapter,
      },
    };
  }
}
